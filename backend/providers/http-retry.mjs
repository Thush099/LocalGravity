const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 4000;

function retryDelayMs(response, attempt, baseDelayMs) {
  const retryAfter = response.headers?.get?.('retry-after');
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(String(retryAfter).trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  return Math.min(baseDelayMs * (attempt + 1), MAX_DELAY_MS);
}

/**
 * Fetch a provider endpoint, retrying once on 429/5xx so transient rate limits and
 * gateway hiccups do not surface as a failed agent turn. The request body is a string,
 * so the exact same payload can be replayed safely.
 */
export async function fetchWithRetry(
  fetchImpl,
  url,
  options = {},
  { maxRetries = DEFAULT_MAX_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS } = {}
) {
  const doFetch = fetchImpl || globalThis.fetch;
  let response = await doFetch(url, options);

  for (let attempt = 0; attempt < maxRetries && RETRYABLE_STATUSES.has(response.status); attempt++) {
    if (options.signal?.aborted) break;
    const delay = retryDelayMs(response, attempt, baseDelayMs);
    try {
      await response.body?.cancel();
    } catch {
      // Body may already be consumed or locked
    }
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (options.signal?.aborted) break;
    response = await doFetch(url, options);
  }

  return response;
}
