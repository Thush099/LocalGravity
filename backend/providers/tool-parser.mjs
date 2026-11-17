import crypto from 'node:crypto';

/**
 * Parse fallback tool calls emitted inside <tool_call>...</tool_call> tags.
 */
export function extractFallbackToolCalls(text) {
  const input = String(text || '');
  const toolCalls = [];
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

  const cleanedText = input
    .replace(tagRe, (_full, inner) => {
      const id = `fallback_${crypto.randomUUID().slice(0, 8)}`;
      try {
        const parsed = JSON.parse(inner.trim());
        const name = parsed?.name || parsed?.function?.name;
        const rawArgs = parsed?.arguments ?? parsed?.function?.arguments ?? {};
        const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
        if (!name || typeof name !== 'string') {
          toolCalls.push({
            id,
            name: 'unknown',
            arguments: {},
            parseError: 'Missing tool "name" inside <tool_call> block.',
          });
        } else {
          toolCalls.push({ id, name, arguments: args && typeof args === 'object' ? args : {} });
        }
      } catch (err) {
        toolCalls.push({
          id,
          name: 'invalid_tool_call',
          arguments: {},
          parseError: `Malformed tool call JSON: ${err.message}`,
        });
      }
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();

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
    } catch (err) {
      return { arguments: {}, parseError: `Malformed tool arguments JSON: ${err.message}` };
    }
  }
  return { arguments: {} };
}

/**
 * Read a fetch Response body line-by-line cleanly without duplicating buffer logic across providers.
 */
export async function readResponseLines(response, onLine) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
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
