import crypto from 'node:crypto';

function repairLooseJson(str) {
  return String(str || '')
    .trim()
    // Remove trailing commas before } or ]
    .replace(/,\s*([}\]])/g, '$1');
}

function parseToolBlock(inner) {
  const id = `fallback_${crypto.randomUUID().slice(0, 8)}`;
  const stripped = String(inner || '')
    .trim()
    .replace(/^```(?:json|tool_call|tool)?\s*\r?\n?/i, '')
    .replace(/\r?\n?```\s*$/, '')
    .trim();
  try {
    let parsed;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      parsed = JSON.parse(repairLooseJson(stripped));
    }
    const name = parsed?.name || parsed?.tool || parsed?.function?.name;
    const rawArgs =
      parsed?.arguments ??
      parsed?.args ??
      parsed?.parameters ??
      parsed?.input ??
      parsed?.function?.arguments ??
      {};
    const args = typeof rawArgs === 'string' ? JSON.parse(repairLooseJson(rawArgs)) : rawArgs;
    if (!name || typeof name !== 'string') {
      return {
        id,
        name: 'unknown',
        arguments: {},
        parseError: 'Missing tool "name" inside tool_call block.',
      };
    }
    return {
      id,
      name,
      arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    };
  } catch (err) {
    return {
      id,
      name: 'invalid_tool_call',
      arguments: {},
      parseError: `Malformed tool call JSON: ${err.message}`,
    };
  }
}

/**
 * Separate inline <think>...</think> blocks from assistant text if a model emits thinking inline.
 */
export function extractInlineThinking(text) {
  const input = String(text || '');
  const thoughts = [];
  const thinkRe = /<think>\s*([\s\S]*?)\s*<\/think>/gi;
  let cleaned = input.replace(thinkRe, (_m, inner) => {
    if (inner && inner.trim()) thoughts.push(inner.trim());
    return '';
  });
  return {
    cleanedText: cleaned.trim(),
    thinkingText: thoughts.join('\n\n'),
  };
}

/**
 * Parse fallback tool calls emitted inside <tool_call>...</tool_call>, ```tool_call fences,
 * <function=name>{...}</function>, or standalone ```json tool call blocks.
 */
export function extractFallbackToolCalls(text) {
  const input = String(text || '');
  const toolCalls = [];
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  const fenceRe = /```tool_call\s*\r?\n([\s\S]*?)\r?\n```/gi;
  const fnTagRe = /<function=([a-zA-Z0-9_]+)>\s*([\s\S]*?)\s*<\/function>/gi;
  const jsonFenceRe = /```json\s*\r?\n([\s\S]*?)\r?\n```/gi;

  let cleanedText = input.replace(tagRe, (_full, inner) => {
    toolCalls.push(parseToolBlock(inner));
    return '';
  });

  cleanedText = cleanedText.replace(fenceRe, (_full, inner) => {
    toolCalls.push(parseToolBlock(inner));
    return '';
  });

  cleanedText = cleanedText.replace(fnTagRe, (_full, fnName, innerArgs) => {
    const parsedArgs = safeParseArguments(innerArgs);
    toolCalls.push({
      id: `fallback_${crypto.randomUUID().slice(0, 8)}`,
      name: fnName.trim(),
      arguments: parsedArgs.arguments,
      ...(parsedArgs.parseError ? { parseError: parsedArgs.parseError } : {}),
    });
    return '';
  });

  if (toolCalls.length === 0) {
    cleanedText = cleanedText.replace(jsonFenceRe, (full, inner) => {
      const trimmed = inner.trim();
      if (!trimmed.startsWith('{')) return full;
      try {
        const candidate = JSON.parse(repairLooseJson(trimmed));
        const hasToolKey = typeof (candidate?.name || candidate?.tool || candidate?.function?.name) === 'string';
        const hasArgsKey =
          candidate?.arguments !== undefined ||
          candidate?.args !== undefined ||
          candidate?.parameters !== undefined ||
          candidate?.function?.arguments !== undefined;
        if (hasToolKey && hasArgsKey) {
          toolCalls.push(parseToolBlock(trimmed));
          return '';
        }
      } catch {
        // Keep regular JSON code block intact
      }
      return full;
    });
  }

  cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanedText, toolCalls };
}

export function safeParseArguments(rawArgs) {
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return { arguments: rawArgs };
  }
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (!trimmed) return { arguments: {} };
    try {
      const parsed = JSON.parse(trimmed);
      return { arguments: parsed && typeof parsed === 'object' ? parsed : {} };
    } catch {
      try {
        const repaired = JSON.parse(repairLooseJson(trimmed));
        return { arguments: repaired && typeof repaired === 'object' ? repaired : {} };
      } catch (err) {
        return { arguments: {}, parseError: `Malformed tool arguments JSON: ${err.message}` };
      }
    }
  }
  return { arguments: {} };
}

/**
 * Read a fetch Response body line-by-line cleanly without duplicating buffer logic across providers.
 *
 * `idleTimeoutMs` guards against a wedged stream: a local model runner that stops sending bytes
 * without closing the socket would otherwise hang the turn forever. This is an IDLE timeout, not
 * a total-duration cap, so long generations that keep streaming are never interrupted.
 */
export async function readResponseLines(response, onLine, { idleTimeoutMs = 0 } = {}) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    let chunk;
    try {
      chunk = await readWithIdleGuard(reader, idleTimeoutMs);
    } catch (err) {
      if (err?.code === 'STREAM_STALLED') {
        await reader.cancel().catch(() => {});
      }
      throw err;
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line) await onLine(line);
    }
  }
  const tail = buffer.replace(/\r$/, '');
  if (tail) await onLine(tail);
}

/**
 * Await the next stream chunk, rejecting if no bytes arrive for `idleTimeoutMs`.
 * Disabled entirely when `idleTimeoutMs` is 0 or not a positive number.
 */
async function readWithIdleGuard(reader, idleTimeoutMs) {
  const ms = Number(idleTimeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return reader.read();

  let timer;
  const stall = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const waited = ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`;
      const err = new Error(
        `The local model stalled: no output for ${waited}. ` +
          'Ollama may be out of memory or its runner wedged — the turn was stopped instead of hanging. ' +
          'Try again, or free up memory first.'
      );
      err.code = 'STREAM_STALLED';
      reject(err);
    }, ms);
    timer.unref?.();
  });

  try {
    return await Promise.race([reader.read(), stall]);
  } finally {
    clearTimeout(timer);
  }
}
