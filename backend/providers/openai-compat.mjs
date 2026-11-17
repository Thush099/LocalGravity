import crypto from 'node:crypto';
import {
  extractFallbackToolCalls,
  extractInlineThinking,
  readResponseLines,
  safeParseArguments,
} from './tool-parser.mjs';

export const CLOUD_PRESETS = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (Free & Pro Models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'qwen/qwen3-235b-a22b:free',
    suggestedModels: [
      'qwen/qwen3-235b-a22b:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'deepseek/deepseek-chat-v3-0324:free',
      'qwen/qwen3.8-27b',
    ],
  },
  groq: {
    id: 'groq',
    label: 'Groq (Ultra-Fast Free Tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    suggestedModels: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'qwen/qwen3-32b',
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini (API Key)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-4-argon',
    suggestedModels: [
      'gemini-4-argon',
      'gemini-4-hydrogen',
      'gemini-4-carbon',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI / ChatGPT (API Key)',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    suggestedModels: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude (API Key)',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
    suggestedModels: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-latest'],
  },
  custom: {
    id: 'custom',
    label: 'Custom OpenAI-Compatible Endpoint',
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    suggestedModels: [],
  },
};

function toOpenAIMessages(messages) {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId || 'call_0',
        content: msg.content || '',
      };
    }

    if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments || {}),
          },
        })),
      };
    }

    if (Array.isArray(msg.images) && msg.images.length > 0) {
      return {
        role: msg.role,
        content: [
          { type: 'text', text: msg.content || '' },
          ...msg.images.map((b64) => ({
            type: 'image_url',
            image_url: { url: b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}` },
          })),
        ],
      };
    }

    return { role: msg.role, content: msg.content || '' };
  });
}

export async function streamOpenAIChat({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  signal,
  onEvent,
  extraHeaders = {},
}) {
  const endpoint = `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: toOpenAIMessages(messages),
    stream: true,
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Provider error (${res.status}): ${errText}`);
  }

  let content = '';
  let thinkingText = '';
  const toolAcc = new Map();
  let usage = {};

  await readResponseLines(res, (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;

    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }

    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens || 0,
        completionTokens: chunk.usage.completion_tokens || 0,
      };
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;

    const reasoningPiece = delta.reasoning_content || delta.reasoning || '';
    if (reasoningPiece) {
      thinkingText += reasoningPiece;
      onEvent?.({ type: 'thinking_delta', text: reasoningPiece });
    }

    if (delta.content) {
      content += delta.content;
      onEvent?.({ type: 'text_delta', text: delta.content });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolAcc.has(idx)) {
          toolAcc.set(idx, {
            id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
            name: tc.function?.name || '',
            rawArgs: tc.function?.arguments || '',
          });
        } else {
          const entry = toolAcc.get(idx);
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.rawArgs += tc.function.arguments;
        }
      }
    }
  });

  if (/<think>/i.test(content)) {
    const inline = extractInlineThinking(content);
    content = inline.cleanedText;
    if (inline.thinkingText) {
      thinkingText = thinkingText ? `${thinkingText}\n${inline.thinkingText}` : inline.thinkingText;
    }
  }

  if (toolAcc.size > 0) {
    const toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, entry]) => {
        const parsed = safeParseArguments(entry.rawArgs);
        return {
          id: entry.id,
          name: entry.name || 'unknown',
          arguments: parsed.arguments,
          ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
        };
      });
    return { content, thinking: thinkingText, toolCalls, usage };
  }

  const fallback = extractFallbackToolCalls(content);
  return {
    content: fallback.toolCalls.length > 0 ? fallback.cleanedText : content,
    thinking: thinkingText,
    toolCalls: fallback.toolCalls,
    usage,
  };
}
