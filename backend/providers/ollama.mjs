import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { Readable } from 'node:stream';
import {
  extractFallbackToolCalls,
  extractInlineThinking,
  readResponseLines,
  safeParseArguments,
} from './tool-parser.mjs';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const PREFERRED_LOCAL_MODELS_16GB = ['qwen3.5:4b', 'qwen3.5:9b', 'gemma4:12b'];
const PREFERRED_LOCAL_MODELS_LARGE = ['qwen3.5:9b', 'qwen3.5:4b', 'gemma4:12b'];
const NATIVE_FETCH = globalThis.fetch;

function withHomebrewPath(env = process.env) {
  const cur = env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
  if (cur.includes('/opt/homebrew/bin')) return cur;
  return `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${cur}`;
}

function isLocalHttpUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

/**
 * Stream a local HTTP POST via node:http with zero idle/header timeouts so heavy local model
 * prefill and deep thinking never trigger undici's 300-second `TypeError: terminated` abort.
 */
function postLocalHttpStream(urlStr, bodyStr, signal) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const payloadBuf = Buffer.from(bodyStr, 'utf8');
    let settled = false;

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payloadBuf.length,
        },
      },
      (res) => {
        if (settled) return;
        settled = true;
        cleanupAbort();
        const status = res.statusCode || 500;
        const ok = status >= 200 && status < 300;
        const webBody = Readable.toWeb(res);

        // Propagate abort to incoming stream so cancelling stops Ollama generation immediately
        if (signal) {
          const onStreamAbort = () => {
            try {
              res.destroy();
              req.destroy();
            } catch {
              // ignore
            }
          };
          if (signal.aborted) {
            onStreamAbort();
          } else {
            signal.addEventListener('abort', onStreamAbort, { once: true });
            res.once('end', () => signal.removeEventListener('abort', onStreamAbort));
            res.once('close', () => signal.removeEventListener('abort', onStreamAbort));
          }
        }

        resolve({
          ok,
          status,
          body: webBody,
          async text() {
            return new Response(webBody).text();
          },
        });
      }
    );

    req.setTimeout(0);
    req.on('socket', (socket) => {
      socket.setNoDelay(true);
      socket.setTimeout(0);
    });

    const onAbort = () => {
      const abortErr = new Error('The operation was aborted.');
      abortErr.name = 'AbortError';
      req.destroy(abortErr);
    };
    const cleanupAbort = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', (err) => {
      cleanupAbort();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    req.write(payloadBuf);
    req.end();
  });
}

function isTransientDisconnectError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const code = String(err?.code || err?.cause?.code || '').toUpperCase();
  return (
    msg.includes('terminated') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    msg.includes('premature close') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_SOCKET'
  );
}

export async function checkOllamaHealth(baseUrl = DEFAULT_OLLAMA_URL) {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { running: false, models: [], runningModels: [] };
    const data = await res.json();
    const models = (data.models || []).map((m) => ({
      name: m.name,
      size: m.size || 0,
      modifiedAt: m.modified_at || '',
      family: m.details?.family || '',
      parameterSize: m.details?.parameter_size || '',
    }));
    const runningModels = await listRunningOllamaModels(baseUrl);
    return { running: true, models, runningModels };
  } catch {
    return { running: false, models: [], runningModels: [] };
  }
}

/**
 * List Ollama models currently loaded in memory via `/api/ps`.
 */
export async function listRunningOllamaModels(baseUrl = DEFAULT_OLLAMA_URL) {
  try {
    const res = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => ({
      name: m.name || m.model || '',
      size: Number(m.size) || 0,
      sizeVram: Number(m.size_vram) || 0,
      contextLength: Number(m.context_length) || 0,
      expiresAt: m.expires_at || '',
    }));
  } catch {
    return [];
  }
}

/**
 * Unload one or all resident Ollama models (`keep_alive: 0`) to immediately reclaim Apple Silicon RAM.
 */
export async function unloadOllamaModels(baseUrl = DEFAULT_OLLAMA_URL, modelName = '') {
  const targets = modelName
    ? [modelName]
    : (await listRunningOllamaModels(baseUrl)).map((m) => m.name).filter(Boolean);

  const unloaded = [];
  await Promise.all(
    targets.map(async (name) => {
      try {
        const res = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: name, prompt: '', keep_alive: 0, stream: false }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) unloaded.push(name);
      } catch {
        // Best effort unload
      }
    })
  );
  return { unloaded };
}

export function selectBestInstalledOllamaModel(models = [], requestedModel = '', options = {}) {
  const totalRamGb = Number(options.totalRamGb ?? os.totalmem() / 1024 ** 3);
  const preferred = totalRamGb <= 18 ? PREFERRED_LOCAL_MODELS_16GB : PREFERRED_LOCAL_MODELS_LARGE;
  if (!Array.isArray(models) || models.length === 0) return requestedModel || preferred[0];
  const names = models.map((m) => (typeof m === 'string' ? m : m.name)).filter(Boolean);
  if (requestedModel && names.includes(requestedModel)) return requestedModel;
  for (const pref of preferred) {
    if (names.includes(pref)) return pref;
  }
  return names[0] || requestedModel || preferred[0];
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
      OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || '15m',
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
  const endpoint = `${baseUrl}/api/pull`;
  const bodyStr = JSON.stringify({ name, stream: true });
  const res =
    globalThis.fetch === NATIVE_FETCH && isLocalHttpUrl(endpoint)
      ? await postLocalHttpStream(endpoint, bodyStr)
      : await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyStr,
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
  const endpoint = `${baseUrl}/api/chat`;
  const useNativeLocalHttp = globalThis.fetch === NATIVE_FETCH && isLocalHttpUrl(endpoint);

  const buildBody = (includeThink, targetModel = activeModel) => {
    const payload = {
      model: targetModel,
      messages: toOllamaMessages(messages),
      stream: true,
      keep_alive: '15m',
      options: {
        num_ctx: Number(numCtx) || 8192,
        num_batch: 512,
        temperature: 0.2,
      },
    };
    if (includeThink) payload.think = Boolean(thinking);
    if (Array.isArray(tools) && tools.length > 0) {
      payload.tools = tools;
    }
    return payload;
  };

  const postChat = async (includeThink, targetModel = activeModel) => {
    const bodyStr = JSON.stringify(buildBody(includeThink, targetModel));
    if (useNativeLocalHttp) {
      return postLocalHttpStream(endpoint, bodyStr, signal);
    }
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
      signal,
    });
  };

  const openChatResponse = async () => {
    let res;
    try {
      res = await postChat(true);
    } catch (err) {
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
    return res;
  };

  let content = '';
  let thinkingText = '';
  const nativeCalls = [];
  let usage = {};
  let emittedAny = false;

  const consumeStream = async (res) => {
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
        emittedAny = true;
        thinkingText += msg.thinking;
        onEvent?.({ type: 'thinking_delta', text: msg.thinking });
      }
      if (msg.content) {
        emittedAny = true;
        content += msg.content;
        onEvent?.({ type: 'text_delta', text: msg.content });
      }
      if (Array.isArray(msg.tool_calls)) {
        emittedAny = true;
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
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await openChatResponse();
      await consumeStream(res);
      break;
    } catch (err) {
      if (signal?.aborted || err.name === 'AbortError') throw err;
      if (attempt === 0 && !emittedAny && isTransientDisconnectError(err)) {
        if (baseUrl === DEFAULT_OLLAMA_URL) {
          await ensureOllamaRunning(baseUrl).catch(() => {});
        }
        continue;
      }
      if (isTransientDisconnectError(err)) {
        throw new Error(
          `Ollama connection dropped while generating (${err.message}). If your Mac is low on free memory, turn Deep Think off, unload idle models in Settings, or switch to a smaller model.`
        );
      }
      throw err;
    }
  }

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
