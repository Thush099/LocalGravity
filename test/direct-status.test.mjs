import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSystemStatusMetric, formatSystemStatus } from '../backend/agent/direct-status.mjs';

test('detects direct system-status questions', () => {
  assert.equal(detectSystemStatusMetric('how much RAM is free'), 'memory');
  assert.equal(detectSystemStatusMetric('how much memory do I have'), 'memory');
  assert.equal(detectSystemStatusMetric('memory usage'), 'memory');
  assert.equal(detectSystemStatusMetric('free RAM'), 'memory');
  assert.equal(detectSystemStatusMetric('how much disk space is free'), 'disk');
  assert.equal(detectSystemStatusMetric('free disk space'), 'disk');
  assert.equal(detectSystemStatusMetric('storage usage'), 'disk');
  assert.equal(detectSystemStatusMetric('how much space do I have'), 'disk');
  assert.equal(detectSystemStatusMetric('battery level'), 'battery');
  assert.equal(detectSystemStatusMetric('how much battery'), 'battery');
  assert.equal(detectSystemStatusMetric('uptime'), 'uptime');
  assert.equal(detectSystemStatusMetric('how long has my mac been up'), 'uptime');
});

test('falls through to the model for diagnostic or ambiguous asks', () => {
  for (const msg of [
    'why is my RAM full',
    'how do I free up memory',
    'close apps to speed up my Mac',
    'should I upgrade my storage',
    'how much RAM is free and should I close Chrome',
    'what is the weather',
    'summarize my emails',
    'organize my desktop',
  ]) {
    assert.equal(detectSystemStatusMetric(msg), null, `should fall through: ${msg}`);
  }
});

test('ignores empty and over-long input', () => {
  assert.equal(detectSystemStatusMetric(''), null);
  assert.equal(detectSystemStatusMetric('how much RAM is free '.padEnd(120, 'x')), null);
});

test('formats each metric from a snapshot', () => {
  const snap = {
    memory: {
      totalBytes: 16 * 1024 ** 3,
      freeBytes: 2 * 1024 ** 3,
      usedPercent: 87,
      swap: { freeBytes: 0.5 * 1024 ** 3 },
    },
    disks: [
      {
        filesystem: 'Macintosh HD',
        mount: '/System/Volumes/Data',
        totalBytes: 500 * 1024 ** 3,
        availableBytes: 100 * 1024 ** 3,
        usedPercent: 80,
      },
    ],
    battery: { percent: 64, state: 'discharging', minutesRemaining: 95 },
    uptimeSeconds: 90061,
  };
  assert.match(formatSystemStatus('memory', snap), /2\.0 GB free.*87% used.*0\.5 GB swap free/);
  assert.match(formatSystemStatus('disk', snap), /100\.0 GB free.*80% used/);
  assert.match(formatSystemStatus('battery', snap), /64%.*discharging.*1h 35m remaining/);
  assert.match(formatSystemStatus('uptime', snap), /1d 1h 1m/);
});

test('handles a desktop Mac with no battery', () => {
  assert.match(formatSystemStatus('battery', { battery: null }), /No battery/);
  assert.match(formatSystemStatus('disk', { disks: [] }), /No storage/);
});
