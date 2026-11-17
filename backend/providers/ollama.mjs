import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { extractFallbackToolCalls, readResponseLines, safeParseArguments } from './tool-parser.mjs';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

export async function checkOllamaHealth(baseUrl = DEFAULT_OLLAMA_URL) {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { running: false, models: [] };
    const data = await res.json();
    const models = (data.models || []).map((m) => ({
      name: m.name,
      size: m.size || 0,
      modifiedAt: m.modified_at || '',
      family: m.details?.family || '',
      parameterSize: m.details?.parameter_size || '',
    }));
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

export async function ensureOllamaRunning(baseUrl = DEFAULT_OLLAMA_URL) {
  const initial = await checkOllamaHealth(baseUrl);
  if (initial.running) {
    return { startedByUs: false, stop: async () => {} };
  }

  const child = spawn('ollama', ['serve'], {
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      OLLAMA_FLASH_ATTENTION: process.env.OLLAMA_FLASH_ATTENTION || '1',
      OLLAMA_KV_CACHE_TYPE: process.env.OLLAMA_KV_CACHE_TYPE || 'q8_0',
    },
  });

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const status = await checkOllamaHealth(baseUrl);
    if (status.running) {
      return {
        startedByUs: true,
        stop: async () => {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            try {
              child.kill('SIGTERM');
            } catch {
              // ignore
            }
          }
        },
      };
    }
  }

  throw new Error('Ollama is installed but did not start responding on 127.0.0.1:11434.');
}

export async function pullOllamaModel(name, onProgress, baseUrl = DEFAULT_OLLAMA_URL) {
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, stream: true }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama pull failed (${res.status}): ${errText}`);
  }
  await readResponseLines(res, (line) => {
    try {
      const evt = JSON.parse(line);
      if (evt.error) throw new Error(evt.error);
      onProgress?.(evt);
    } catch (err) {
      if (err instanceof SyntaxError) return;
      throw err;
    }
  });
}

export async function deleteOllamaModel(name, baseUrl = DEFAULT_OLLAMA_URL) {
  const res = await fetch(`${baseUrl}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama delete failed (${res.status}): ${errText}`);
  }
}

function toOllamaMessages(messages) {
  return messages.map((msg) => {
    const out = { role: msg.role, content: msg.content || '' };
    if (Array.isArray(msg.images) && msg.images.length > 0) {
      out.images = msg.images;
    }
    if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
      out.tool_calls = msg.toolCalls.map((tc) => ({
        function: {
          name: tc.name,
          arguments: tc.arguments || {},
        },
      }));
    }
    if (msg.role === 'tool' && msg.toolName) {
      out.tool_name = msg.toolName;
    }
    return out;
  });
}

export async function streamOllamaChat({
  baseUrl = DEFAULT_OLLAMA_URL,
  model = 'qwen3.5:9b',
  messages,
  tools,
  thinking = true,
  numCtx = 16384,
  signal,
  onEvent,
}) {
  const body = {
    model,
    messages: toOllamaMessages(messages),
    stream: true,
    think: Boolean(thinking),
    options: { num_ctx: Number(numCtx) || 16384 },
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama chat error (${res.status}): ${errText}`);
  }

  let content = '';
  let thinkingText = '';
  const nativeCalls = [];
  let usage = {};

  await readResponseLines(res, (line) => {
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      return;
    }
    if (chunk.error) throw new Error(chunk.error);

    const msg = chunk.message || {};
    if (msg.thinking) {
      thinkingText += msg.thinking;
      onEvent?.({ type: 'thinking_delta', text: msg.thinking });
    }
    if (msg.content) {
      content += msg.content;
      onEvent?.({ type: 'text_delta', text: msg.content });
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const parsed = safeParseArguments(tc.function?.arguments);
        nativeCalls.push({
          id: tc.id || `ollama_${crypto.randomUUID().slice(0, 8)}`,
          name: tc.function?.name || 'unknown',
          arguments: parsed.arguments,
          ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
        });
      }
    }
    if (chunk.done) {
      usage = {
        promptTokens: chunk.prompt_eval_count || 0,
        completionTokens: chunk.eval_count || 0,
      };
    }
  });

  if (nativeCalls.length > 0) {
    return { content, thinking: thinkingText, toolCalls: nativeCalls, usage };
  }

  const fallback = extractFallbackToolCalls(content);
  return {
    content: fallback.toolCalls.length > 0 ? fallback.cleanedText : content,
    thinking: thinkingText,
    toolCalls: fallback.toolCalls,
    usage,
  };
}
