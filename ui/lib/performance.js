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
