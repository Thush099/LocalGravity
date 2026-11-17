let runtimeToken = new URLSearchParams(window.location.search).get('token') || '';

export function setAuthToken(token) {
  if (token) runtimeToken = token;
}

export function getAuthHeaders(extra = {}) {
  const headers = { ...extra };
  if (runtimeToken) headers['X-Auth-Token'] = runtimeToken;
  return headers;
}

export async function apiRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: getAuthHeaders({
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

/**
 * Consume an HTTP POST SSE endpoint cleanly via fetch ReadableStream.
 */
export async function streamSse(url, body, onEvent, abortSignal) {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Stream request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        try {
          onEvent(JSON.parse(jsonStr));
        } catch {
          // Ignore malformed chunk
        }
      }
    }
  }
}

export function hasSwiftBridge() {
  return Boolean(window.webkit?.messageHandlers?.localgravity);
}

export function postSwiftAction(type, payload = {}) {
  if (!hasSwiftBridge()) return false;
  window.webkit.messageHandlers.localgravity.postMessage({ type, ...payload });
  return true;
}
