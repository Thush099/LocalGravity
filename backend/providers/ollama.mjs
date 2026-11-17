import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import {
  extractFallbackToolCalls,
  extractInlineThinking,
  readResponseLines,
  safeParseArguments,
} from './tool-parser.mjs';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const PREFERRED_LOCAL_MODELS = ['qwen3.5:9b', 'qwen3.5:4b', 'gemma4:12b'];

function withHomebrewPath(env = process.env) {
  const cur = env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
  if (cur.includes('/opt/homebrew/bin')) return cur;
  return `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${cur}`;
}

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

export function selectBestInstalledOllamaModel(models = [], requestedModel = '') {
  if (!Array.isArray(models) || models.length === 0) return requestedModel || 'qwen3.5:9b';
  const names = models.map((m) => (typeof m === 'string' ? m : m.name)).filter(Boolean);
  if (requestedModel && names.includes(requestedModel)) return requestedModel;
  // Match prefix without tag if user wrote e.g. qwen3.5:4b but has qwen3.5:9b
  for (const pref of PREFERRED_LOCAL_MODELS) {
    if (names.includes(pref)) return pref;
  }
  return names[0] || requestedModel || 'qwen3.5:9b';
}

export async function ensureOllamaRunning(baseUrl = DEFAULT_OLLAMA_URL, options = {}) {
  const initial = await checkOllamaHealth(baseUrl);
  if (initial.running) {
    return { startedByUs: false, models: initial.models, stop: async () => {} };
  }

  const binary = options.binary || 'ollama';
  const child = spawn(binary, ['serve'], {
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      PATH: withHomebrewPath(process.env),
      OLLAMA_FLASH_ATTENTION: process.env.OLLAMA_FLASH_ATTENTION || '1',
      OLLAMA_KV_CACHE_TYPE: process.env.OLLAMA_KV_CACHE_TYPE || 'q8_0',
      OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || '30m',
    },
  });

  let spawnError = null;
  child.on('error', (err) => {
    spawnError = err;
  });

  for (let i = 0; i < 30; i++) {
    if (spawnError) {
      throw new Error(`Failed to start Ollama (${binary}): ${spawnError.message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
    if (spawnError) {
      throw new Error(`Failed to start Ollama (${binary}): ${spawnError.message}`);
    }
    const status = await checkOllamaHealth(baseUrl);
    if (status.running) {
      return {
        startedByUs: true,
        models: status.models,
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
  model = 'qwen3.5:4b',
  messages,
  tools,
  thinking = false,
  numCtx = 8192,
  signal,
  onEvent,
}) {
  let activeModel = model;

  const buildBody = (includeThink, targetModel = activeModel) => {
    const payload = {
      model: targetModel,
      messages: toOllamaMessages(messages),
      stream: true,
      keep_alive: '30m',
      options: {
        num_ctx: Number(numCtx) || 8192,
        temperature: 0.2,
      },
    };
    if (includeThink) payload.think = Boolean(thinking);
    if (Array.isArray(tools) && tools.length > 0) {
      payload.tools = tools;
    }
    return payload;
  };

  const postChat = async (includeThink, targetModel = activeModel) =>
    fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(includeThink, targetModel)),
      signal,
    });

  let res;
  try {
    res = await postChat(true);
  } catch (err) {
    // Auto-start Ollama if local daemon is stopped
    if (baseUrl === DEFAULT_OLLAMA_URL && !signal?.aborted) {
      await ensureOllamaRunning(baseUrl);
      res = await postChat(true);
    } else {
      throw err;
    }
  }

  if (!res.ok) {
    let errText = await res.text();

    // Auto-recover if requested model tag is not pulled locally (e.g. default qwen3.5:4b vs installed qwen3.5:9b)
    if (res.status === 404 && /model .* not found/i.test(errText)) {
      const health = await checkOllamaHealth(baseUrl);
      const fallbackModel = selectBestInstalledOllamaModel(health.models, activeModel);
      if (fallbackModel && fallbackModel !== activeModel) {
        onEvent?.({
          type: 'self_improved',
          lessons: [`Auto-switched missing local model "${activeModel}" to installed model "${fallbackModel}".`],
          resolvedModel: fallbackModel,
        });
        activeModel = fallbackModel;
        res = await postChat(true, activeModel);
        if (!res.ok) {
          errText = await res.text();
        }
      }
    }

    if (!res.ok) {
      if (res.status === 400 && /does not support thinking/i.test(errText)) {
        res = await postChat(false, activeModel);
        if (!res.ok) {
          const retryErr = await res.text();
          throw new Error(`Ollama chat error (${res.status}): ${retryErr}`);
        }
      } else {
        throw new Error(`Ollama chat error (${res.status}): ${errText}`);
      }
    }
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

  // Extract inline <think>...</think> if model emitted thinking tags inside content
  if (/<think>/i.test(content)) {
    const inline = extractInlineThinking(content);
    content = inline.cleanedText;
    if (inline.thinkingText) {
      thinkingText = thinkingText ? `${thinkingText}\n${inline.thinkingText}` : inline.thinkingText;
    }
  }

  if (nativeCalls.length > 0) {
    return { content, thinking: thinkingText, toolCalls: nativeCalls, usage, resolvedModel: activeModel };
  }

  const fallback = extractFallbackToolCalls(content);
  return {
    content: fallback.toolCalls.length > 0 ? fallback.cleanedText : content,
    thinking: thinkingText,
    toolCalls: fallback.toolCalls,
    usage,
    resolvedModel: activeModel,
  };
}
