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

const MODEL_SPEED_KEY = 'lg-model-speed';

/**
 * Measured throughput per model, kept so the model picker can show real numbers
 * instead of asking the user to guess whether 4B or 9B is worth the wait. Values
 * are exponentially smoothed so one slow turn (a big context, a cold model)
 * cannot brand the model forever.
 */
export function getModelSpeeds() {
  try {
    const raw = JSON.parse(localStorage.getItem(MODEL_SPEED_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** @returns {{tps: number, samples: number} | null} */
export function getModelSpeed(model) {
  if (!model) return null;
  const entry = getModelSpeeds()[model];
  if (!entry || !(entry.tps > 0)) return null;
  return { tps: entry.tps, samples: Number(entry.samples) || 0 };
}

export function recordModelSpeed(model, { durationMs, completionTokens } = {}) {
  if (!model || !(durationMs > 400) || !(completionTokens > 0)) return null;
  const tps = completionTokens / (durationMs / 1000);
  if (!(tps > 0) || !Number.isFinite(tps)) return null;
  const speeds = getModelSpeeds();
  const prev = speeds[model];
  const samples = (Number(prev?.samples) || 0) + 1;
  const smoothed = prev?.tps > 0 ? prev.tps * 0.6 + tps * 0.4 : tps;
  speeds[model] = { tps: Number(smoothed.toFixed(2)), samples, at: Date.now() };
  localStorage.setItem(MODEL_SPEED_KEY, JSON.stringify(speeds));
  return speeds[model];
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
