import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AMBIENT_THRESHOLDS,
  detectAmbientAlerts,
  filterByBudget,
  isQuietHour,
  resolveAmbientConfig,
  runAmbientTick,
  startAmbientAlerter,
} from '../backend/ambient-alerts.mjs';
import { atomicWriteJson } from '../backend/state/storage.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

function metricsWith({ battery, disks = [], memory } = {}) {
  return {
    battery,
    disks,
    memory,
    cpu: { percent: 20 },
    processes: [],
    uptimeSeconds: 3600,
    gpu: null,
    loadAvg: [1, 1, 1],
  };
}

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-ambient-'));
  process.env.LOCALGRAVITY_HOME = dir;
  return getRuntimePaths();
}

const NOW = new Date(2026, 10, 24, 10, 15); // daytime
const NIGHT = new Date(2026, 10, 24, 23, 30);

test('detect: low discharging battery alerts with the observed percent; charging does not', () => {
  const low = detectAmbientAlerts(
    metricsWith({ battery: { percent: 12, state: 'discharging', minutesRemaining: 25 } })
  );
  assert.equal(low.length, 1);
  assert.equal(low[0].id, 'battery');
  assert.equal(low[0].severity, 'high');
  assert.match(low[0].message, /12%/);
  assert.match(low[0].message, /25 min left/);

  const critical = detectAmbientAlerts(metricsWith({ battery: { percent: 5, state: 'discharging', minutesRemaining: 9 } }));
  assert.equal(critical[0].severity, 'critical');
  assert.match(critical[0].message, /5%/);

  // Grounding precision: the same 12% while charging is not an emergency.
  assert.deepEqual(detectAmbientAlerts(metricsWith({ battery: { percent: 12, state: 'charging', minutesRemaining: null } })), []);
  assert.deepEqual(detectAmbientAlerts(metricsWith({ battery: { percent: 90, state: 'discharging' } })), []);
});

test('detect: storage alerts cite the volume and take the worst one; healthy metrics stay silent', () => {
  const two = detectAmbientAlerts(
    metricsWith({
      disks: [
        { mount: '/System/Volumes/Data', usedPercent: 92, usedBytes: 1, totalBytes: 2 },
        { mount: '/backup', usedPercent: 96, usedBytes: 1, totalBytes: 2 },
      ],
    })
  );
  assert.equal(two.length, 1);
  assert.equal(two[0].id, 'storage:/backup');
  assert.equal(two[0].severity, 'high');
  assert.match(two[0].message, /96%/);

  const warn = detectAmbientAlerts(metricsWith({ disks: [{ mount: '/', usedPercent: 91, usedBytes: 1, totalBytes: 2 }] }));
  assert.equal(warn[0].severity, 'warn');
  assert.match(warn[0].message, /91%/);

  assert.deepEqual(detectAmbientAlerts(metricsWith({ disks: [{ mount: '/', usedPercent: 40, usedBytes: 1, totalBytes: 2 }] })), []);
});

test('detect: memory bar is deliberately high and every message cites a value', () => {
  assert.deepEqual(detectAmbientAlerts(metricsWith({ memory: { usedPercent: 80 } })), []);
  const alerts = detectAmbientAlerts(
    metricsWith({
      memory: { usedPercent: AMBIENT_THRESHOLDS.memory.high + 1 },
      battery: { percent: 3, state: 'discharging' },
    })
  );
  assert.ok(alerts.length >= 2, 'severe memory + critical battery both alert');
  assert.equal(alerts[0].severity, 'critical', 'most severe first');
  for (const a of alerts) assert.match(a.message, /\d+%/, 'every alert quotes its observed value');
});

test('budget: quiet hours mute warn but never high/critical', () => {
  const cfg = resolveAmbientConfig({});
  assert.equal(isQuietHour(NIGHT, cfg), true);
  assert.equal(isQuietHour(NOW, cfg), false);
  const alerts = [
    { id: 'memory', area: 'memory', severity: 'warn', message: 'Memory is 95% full.' },
    { id: 'battery', area: 'battery', severity: 'critical', message: 'Battery is critically low at 5% and discharging.' },
  ];
  const night = filterByBudget(alerts, { now: NIGHT, state: {}, config: cfg });
  assert.deepEqual(night.due.map((a) => a.id), ['battery'], 'warn is held back overnight');
  const day = filterByBudget(alerts, { now: NOW, state: {}, config: cfg });
  assert.equal(day.due.length, 2, 'daytime lets both through');
});

test('budget: per-alert cooldown and the daily cap are respected', () => {
  const cfg = resolveAmbientConfig({});
  const alert = { id: 'battery', area: 'battery', severity: 'high', message: 'Battery is at 12% and discharging.' };

  const fresh = filterByBudget([alert], { now: NOW, state: { lastFired: { battery: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString() } }, config: cfg });
  assert.deepEqual(fresh.due, [], 'same alert inside the cooldown stays silent');
  const cooled = filterByBudget([alert], { now: NOW, state: { lastFired: { battery: new Date(NOW.getTime() - 8 * 60 * 60 * 1000).toISOString() } }, config: cfg });
  assert.equal(cooled.due.length, 1, 'after the cooldown it may speak again');

  const capped = filterByBudget([alert, { ...alert, id: 'memory' }, { ...alert, id: 'storage:/' }], {
    now: NOW,
    state: { day: '2026-11-24', count: cfg.dailyCap },
    config: cfg,
  });
  assert.deepEqual(capped.due, [], 'daily cap reached — silence until tomorrow');
});

test('runAmbientTick notifies once, persists state, and retries failed notifications', async () => {
  const paths = tempPaths();
  const lowBattery = metricsWith({ battery: { percent: 10, state: 'discharging', minutesRemaining: 20 } });
  const messages = [];
  const notify = async (n) => messages.push(n.message);

  const first = await runAmbientTick({ paths, now: NOW, notify, metrics: lowBattery });
  assert.equal(first.length, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /10%/);

  // Second tick: cooldown + persisted state keep it quiet.
  const second = await runAmbientTick({ paths, now: NOW, notify, metrics: lowBattery });
  assert.deepEqual(second, []);
  assert.equal(messages.length, 1);

  // A failed notification is not recorded and retries on the next tick.
  const retryPaths = tempPaths();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('notification service down');
  };
  assert.deepEqual(await runAmbientTick({ paths: retryPaths, now: NOW, notify: flaky, metrics: lowBattery }), []);
  assert.equal((await runAmbientTick({ paths: retryPaths, now: NOW, notify: flaky, metrics: lowBattery })).length, 1);
});

test('runAmbientTick honors config.ambientAlerts === false and injectable metrics stay JSON-safe', async () => {
  const paths = tempPaths();
  await atomicWriteJson(paths.configFile, { ambientAlerts: false }, 0o600);
  const messages = [];
  const fired = await runAmbientTick({
    paths,
    now: NOW,
    notify: async (n) => messages.push(n.message),
    metrics: metricsWith({ battery: { percent: 5, state: 'discharging' } }),
  });
  assert.deepEqual(fired, []);
  assert.deepEqual(messages, []);

  const alerts = detectAmbientAlerts(metricsWith({ disks: [{ mount: '/', usedPercent: 91, usedBytes: 1, totalBytes: 2 }] }));
  assert.ok(JSON.parse(JSON.stringify(alerts)));
});

test('startAmbientAlerter defers its first check (short-lived runs stay notification-free)', async () => {
  const paths = tempPaths();
  const messages = [];
  const stop = startAmbientAlerter({ paths, notify: async (n) => messages.push(n.message), intervalMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop();
  assert.deepEqual(messages, [], 'no notification within the first interval');
});
