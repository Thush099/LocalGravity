import test from 'node:test';
import assert from 'node:assert/strict';

// The module reads localStorage lazily, so a tiny in-memory stub is enough.
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

globalThis.localStorage = new MemoryStorage();
const { getModelSpeed, getModelSpeeds, recordModelSpeed } = await import('../ui/lib/performance.js');

test('model speed is measured, smoothed, and never invented', () => {
  assert.equal(getModelSpeed('qwen3.5:4b'), null, 'no speed before any turn is recorded');

  // Too short or no tokens: not a real throughput measurement.
  assert.equal(recordModelSpeed('qwen3.5:4b', { durationMs: 100, completionTokens: 50 }), null);
  assert.equal(recordModelSpeed('qwen3.5:4b', { durationMs: 5000, completionTokens: 0 }), null);
  assert.equal(getModelSpeed('qwen3.5:4b'), null);

  // 100 tokens in 10s = 10 tok/s on the first sample.
  recordModelSpeed('qwen3.5:4b', { durationMs: 10000, completionTokens: 100 });
  assert.equal(getModelSpeed('qwen3.5:4b').tps, 10);
  assert.equal(getModelSpeed('qwen3.5:4b').samples, 1);

  // A slower follow-up pulls the smoothed value toward it instead of resetting.
  recordModelSpeed('qwen3.5:4b', { durationMs: 10000, completionTokens: 50 });
  const smoothed = getModelSpeed('qwen3.5:4b');
  assert.equal(smoothed.tps, 8);
  assert.equal(smoothed.samples, 2);

  // Separate models keep separate records.
  recordModelSpeed('qwen3.5:9b', { durationMs: 10000, completionTokens: 20 });
  assert.deepEqual(Object.keys(getModelSpeeds()).sort(), ['qwen3.5:4b', 'qwen3.5:9b']);
  assert.equal(getModelSpeed('qwen3.5:9b').tps, 2);

  // Corrupt storage degrades to "no data" rather than crashing the picker.
  localStorage.setItem('lg-model-speed', '{not json');
  assert.deepEqual(getModelSpeeds(), {});
  assert.equal(getModelSpeed('qwen3.5:4b'), null);
});