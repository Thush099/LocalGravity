import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldStartDaemon, shouldReclaimModelMemory, createDaemonSupervisor } from '../backend/daemon-supervisor.mjs';

const GB = 1024 ** 3;

test('shouldStartDaemon only manages the local daemon when it is down and memory allows', () => {
  // Local, installed, down, plenty of RAM → start
  assert.equal(shouldStartDaemon({ provider: 'ollama', installed: true, running: false, freeMemBytes: 8 * GB }), true);

  // Cloud provider → never manage the local daemon
  assert.equal(shouldStartDaemon({ provider: 'openrouter', installed: true, running: false, freeMemBytes: 8 * GB }), false);

  // Not installed → nothing to manage
  assert.equal(shouldStartDaemon({ provider: 'ollama', installed: false, running: false, freeMemBytes: 8 * GB }), false);

  // Already running → no-op
  assert.equal(shouldStartDaemon({ provider: 'ollama', installed: true, running: true, freeMemBytes: 8 * GB }), false);

  // Memory pressure → fall back to lazy cold-start instead of fighting the system
  assert.equal(shouldStartDaemon({ provider: 'ollama', installed: true, running: false, freeMemBytes: 0.5 * GB }), false);

  // Unknown free memory → allowed (we can't judge pressure)
  assert.equal(shouldStartDaemon({ provider: 'ollama', installed: true, running: false, freeMemBytes: null }), true);
});

test('shouldReclaimModelMemory only fires under real pressure and never mid-run', () => {
  // Heavy swap + idle → reclaim
  assert.equal(shouldReclaimModelMemory({ hasActiveRun: false, swapUsedBytes: 2.9 * GB, ramUsedPercent: 70 }), true);

  // High RAM + idle → reclaim
  assert.equal(shouldReclaimModelMemory({ hasActiveRun: false, swapUsedBytes: 0, ramUsedPercent: 92 }), true);

  // Active task → never interrupt, even under pressure
  assert.equal(shouldReclaimModelMemory({ hasActiveRun: true, swapUsedBytes: 2.9 * GB, ramUsedPercent: 95 }), false);

  // Healthy system + idle → leave the model loaded
  assert.equal(shouldReclaimModelMemory({ hasActiveRun: false, swapUsedBytes: 0.2 * GB, ramUsedPercent: 60 }), false);
});

test('daemon supervisor starts once, then rate-limits restart attempts', async () => {
  let ensureCalls = 0;
  let t = 0;
  const supervisor = createDaemonSupervisor({
    getProvider: async () => 'ollama',
    checkHealth: async () => ({ installed: true, running: false }),
    ensureRunning: async () => {
      ensureCalls += 1;
    },
    getFreeMemBytes: () => 8 * GB,
    intervalMs: 1000,
    now: () => t,
    log: () => {},
  });

  await supervisor.tick();
  assert.equal(ensureCalls, 1, 'first tick starts the daemon');

  t = 500;
  await supervisor.tick();
  assert.equal(ensureCalls, 1, 'second tick inside the window is rate-limited');

  t = 1500;
  await supervisor.tick();
  assert.equal(ensureCalls, 2, 'after the window a restart is allowed');

  supervisor.stop();
});

test('daemon supervisor stays idle under memory pressure and never throws', async () => {
  let ensureCalls = 0;
  const supervisor = createDaemonSupervisor({
    getProvider: async () => 'ollama',
    checkHealth: async () => ({ installed: true, running: false }),
    ensureRunning: async () => {
      ensureCalls += 1;
    },
    getFreeMemBytes: () => 0.5 * GB,
    intervalMs: 1000,
    now: () => 0,
    log: () => {},
  });
  await supervisor.tick();
  assert.equal(ensureCalls, 0, 'does not fight the system for RAM');

  // A throwing checkHealth is swallowed by the supervisor.
  const flaky = createDaemonSupervisor({
    getProvider: async () => 'ollama',
    checkHealth: async () => {
      throw new Error('boom');
    },
    ensureRunning: async () => {
      ensureCalls += 1;
    },
    getFreeMemBytes: () => 8 * GB,
    now: () => 0,
    log: () => {},
  });
  await flaky.tick();
  assert.equal(ensureCalls, 0, 'supervision failures never propagate');

  supervisor.stop();
  flaky.stop();
});