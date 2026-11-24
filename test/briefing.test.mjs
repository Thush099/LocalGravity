import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAttention,
  summarizeBriefing,
  briefingTool,
  CPU_HIGH_PERCENT,
  BATTERY_LOW_PERCENT,
} from '../backend/tools/briefing-tool.mjs';
import { selectToolsForTurn } from '../backend/agent/tool-selector.mjs';
import { TOOL_DEFINITIONS } from '../backend/tools/registry.mjs';

const GB = 1024 ** 3;

function healthyMetrics() {
  return {
    cpu: { percent: 12 },
    loadAvg: [1.2, 1.0, 0.9],
    memory: {
      totalBytes: 16 * GB,
      usedBytes: 4 * GB,
      usedPercent: 25,
      wiredBytes: 1 * GB,
      compressedBytes: 0,
      swap: { usedBytes: 0, totalBytes: 2 * GB },
    },
    gpu: { name: 'Apple M3', utilizationPercent: 5, inUseMemoryBytes: 512 * 1024 ** 2 },
    battery: { percent: 88, state: 'charged', powerSource: 'AC Power', minutesRemaining: null },
    disks: [{ mount: '/', usedBytes: 100 * GB, totalBytes: 500 * GB, usedPercent: 20 }],
    processes: [{ command: 'node', pid: 1, cpuPercent: 2, memPercent: 3 }],
    uptimeSeconds: 36000,
  };
}

function hotMetrics() {
  return {
    cpu: { percent: CPU_HIGH_PERCENT + 5 },
    memory: { usedPercent: 90 },
    battery: { percent: BATTERY_LOW_PERCENT - 5, state: 'discharging' },
    disks: [{ mount: '/data', usedBytes: 480 * GB, totalBytes: 500 * GB, usedPercent: 96 }],
  };
}

// A fixed "now" and entries recurring on its weekday, so the test is robust to
// whichever calendar date the suite runs on.
const NOW = new Date(2026, 10, 24, 10, 15); // 10:15 local
const DOW = NOW.getDay();
const SCHEDULE = [
  { title: 'Morning focus', time: '09:00', days: [DOW] },
  { title: 'Design review', time: '11:00', days: [DOW] },
  { title: 'Wrap up', time: '17:00', days: [DOW] },
];

test('deriveAttention invents nothing for healthy metrics', () => {
  assert.deepEqual(deriveAttention(healthyMetrics(), NOW), []);
  assert.deepEqual(deriveAttention(null, NOW), []);
});

test('deriveAttention flags only observed thresholds, quoting the value', () => {
  const flags = deriveAttention(hotMetrics(), NOW);
  const byArea = Object.fromEntries(flags.map((f) => [f.area, f]));
  assert.ok(byArea.cpu.detail.includes('85%') || byArea.cpu.detail.match(/\d+%/));
  assert.ok(byArea.memory, 'flags high memory');
  assert.ok(byArea.battery, 'flags low discharging battery');
  assert.ok(byArea.storage, 'flags tight storage');
  // Every flag is grounded: it cites a numeric observed value.
  for (const f of flags) assert.match(f.detail, /\d+%/);
});

test('summarizeBriefing composes system summary and today\'s schedule', () => {
  const b = summarizeBriefing({ metrics: healthyMetrics(), scheduleEntries: SCHEDULE, now: NOW });
  assert.match(b.system_summary, /CPU:/);
  assert.match(b.system_summary, /Memory:/);
  assert.equal(b.schedule.total_today, 3);
  assert.deepEqual(b.schedule.items.map((i) => i.title), ['Morning focus', 'Design review', 'Wrap up']);
  // At 10:15 the next upcoming item is the 11:00 design review.
  assert.deepEqual(b.schedule.next, { title: 'Design review', time: '11:00' });
});

test('summarizeBriefing flags an imminent next event with minutes-to-go', () => {
  const b = summarizeBriefing({ metrics: healthyMetrics(), scheduleEntries: SCHEDULE, now: NOW });
  const sched = b.attention.find((a) => a.area === 'schedule');
  assert.ok(sched, 'an imminent schedule item is surfaced');
  assert.match(sched.detail, /Design review/);
  assert.match(sched.detail, /in \d+ minutes?/);
});

test('summarizeBriefing degrades cleanly with no metrics and no schedule', () => {
  const b = summarizeBriefing({ metrics: null, scheduleEntries: [], now: NOW });
  assert.equal(b.system_summary, 'System metrics unavailable.');
  assert.equal(b.schedule.total_today, 0);
  assert.equal(b.schedule.next, null);
  assert.deepEqual(b.attention, []);
});

test('briefingTool returns a JSON-serializable, grounded report', async () => {
  const b = await briefingTool({ include_system: false, include_schedule: false, focus: 'deep work' });
  assert.equal(b.focus, 'deep work');
  assert.equal(b.system_summary, 'System metrics unavailable.');
  // Must round-trip through JSON (the agent ships this to the model/UI).
  assert.ok(JSON.parse(JSON.stringify(b)));
});

test('briefing routes for status requests but not lean coding prompts (Ollama)', () => {
  const statusTools = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: "Good morning — what's up and how's my day looking?",
  }).map((t) => t.function.name);
  assert.ok(statusTools.includes('briefing'), 'briefing is routed for a status request');

  const codingTools = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Refactor this Python function to use a list comprehension and add unit tests.',
  }).map((t) => t.function.name);
  assert.ok(!codingTools.includes('briefing'), 'briefing does not inflate a lean coding prompt');
});
