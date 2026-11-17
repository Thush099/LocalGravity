import crypto from 'node:crypto';
import { readResponseLines, safeParseArguments } from './tool-parser.mjs';

function toAnthropicPayload(messages, tools) {
  const systemParts = [];
  const outMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === 'tool') {
      const toolResultBlock = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId || 'tool_0',
        content: Array.isArray(msg.images) && msg.images.length > 0
          ? [
              { type: 'text', text: msg.content || '' },
              ...msg.images.map((b64) => ({
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: b64.replace(/^data:[^;]+;base64,/, '') },
              })),
            ]
          : msg.content || '',
      };
      const prev = outMessages[outMessages.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content[0]?.type === 'tool_result') {
        prev.content.push(toolResultBlock);
      } else {
        outMessages.push({ role: 'user', content: [toolResultBlock] });
      }
      continue;
    }

    if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
      const blocks = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of msg.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments || {},
        });
      }
      outMessages.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (Array.isArray(msg.images) && msg.images.length > 0) {
      outMessages.push({
        role: msg.role,
        content: [
          ...msg.images.map((b64) => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: b64.replace(/^data:[^;]+;base64,/, '') },
          })),
          { type: 'text', text: msg.content || '' },
        ],
      });
      continue;
    }

    outMessages.push({ role: msg.role, content: msg.content || '' });
  }

  const anthropicTools = Array.isArray(tools)
    ? tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))
    : undefined;

  return { system: systemParts.join('\n\n'), messages: outMessages, tools: anthropicTools };
}

export async function streamAnthropicChat({
  baseUrl = 'https://api.anthropic.com',
  apiKey,
  model = 'claude-sonnet-4-20250514',
  messages,
  tools,
  signal,
  onEvent,
}) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/v1/messages`;
  const payload = toAnthropicPayload(messages, tools);

  const body = {
    model,
    max_tokens: 4096,
    stream: true,
    messages: payload.messages,
  };
  if (payload.system) body.system = payload.system;
  if (payload.tools && payload.tools.length > 0) body.tools = payload.tools;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic error (${res.status}): ${errText}`);
  }

  let content = '';
  let thinkingText = '';
  const blocks = new Map();
  let usage = {};
  let currentEvent = '';

  await readResponseLines(res, (line) => {
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
      return;
    }
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;

    let evt;
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }

    const evtType = evt.type || currentEvent;
    currentEvent = '';

    if (evtType === 'content_block_start' && evt.content_block) {
      blocks.set(evt.index, {
        type: evt.content_block.type,
        id: evt.content_block.id || `toolu_${crypto.randomUUID().slice(0, 8)}`,
        name: evt.content_block.name || '',
        rawJson: '',
      });
    } else if (evtType === 'content_block_delta' && evt.delta) {
      if (evt.delta.type === 'thinking_delta' && evt.delta.thinking) {
        thinkingText += evt.delta.thinking;
        onEvent?.({ type: 'thinking_delta', text: evt.delta.thinking });
      } else if (evt.delta.type === 'text_delta' && evt.delta.text) {
        content += evt.delta.text;
        onEvent?.({ type: 'text_delta', text: evt.delta.text });
      } else if (evt.delta.type === 'input_json_delta' && evt.delta.partial_json) {
        const blk = blocks.get(evt.index);
        if (blk) blk.rawJson += evt.delta.partial_json;
      }
    } else if (evtType === 'message_delta' && evt.usage) {
      usage = {
        completionTokens: evt.usage.output_tokens || 0,
      };
    }
  });

  const toolCalls = [];
  for (const [, blk] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    if (blk.type === 'tool_use') {
      const parsed = blk.rawJson ? safeParseArguments(blk.rawJson) : { arguments: {} };
      toolCalls.push({
        id: blk.id,
        name: blk.name,
        arguments: parsed.arguments,
        ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
      });
    }
  }

  return { content, thinking: thinkingText, toolCalls, usage };
}
