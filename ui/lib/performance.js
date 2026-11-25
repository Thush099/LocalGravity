// Performance utilities for LocalGravity UI

/**
 * Collect simple performance metrics stored in localStorage.
 * Expected keys: `lg-model-latency` (ms), `lg-token-usage` (number).
 * Returns an object with default values if not present.
 */
export function getPerformanceMetrics() {
  const latency = Number(localStorage.getItem('lg-model-latency')) || 0;
  const tokens = Number(localStorage.getItem('lg-token-usage')) || 0;
  return { latency, tokens };
}

/**
 * Record a latency measurement (in ms) for the currently selected model.
 * Stores the latest value in localStorage.
 */
export function recordLatency(ms) {
  if (typeof ms === 'number' && ms >= 0) {
    localStorage.setItem('lg-model-latency', String(ms));
  }
}

/**
 * Record token usage for the last request.
 */
export function recordTokenUsage(count) {
  if (typeof count === 'number' && count >= 0) {
    localStorage.setItem('lg-token-usage', String(count));
  }
}

/**
 * Build the settings-page telemetry chips from one session's numbers.
 *
 * A paint measurement is only trustworthy when the window was actually visible
 * at launch: an occluded or backgrounded start can report minutes. Anything
 * beyond `maxPaintMs` is discarded rather than displayed as a scary stat, while
 * the measured UI-ready time is always shown.
 */
export function perfSummary({ readyMs = null, fcpMs = null, latencyMs = 0, tokens = 0, maxPaintMs = 20000 } = {}) {
  const items = [];
  if (Number.isFinite(readyMs) && readyMs >= 0) items.push(`UI ready in ${Math.round(readyMs)} ms`);
  if (Number.isFinite(fcpMs) && fcpMs >= 0 && fcpMs <= maxPaintMs) items.push(`First paint ${Math.round(fcpMs)} ms`);
  if (latencyMs > 0) items.push(`Last turn latency: ${(latencyMs / 1000).toFixed(2)} s`);
  if (tokens > 0) items.push(`Last turn tokens: ${tokens.toLocaleString()}`);
  return items;
}
