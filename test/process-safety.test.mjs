import test from 'node:test';
import assert from 'node:assert/strict';
import { installProcessSafetyNets } from '../backend/server.mjs';

/**
 * The backend runs many fire-and-forget background tasks (agenda ticks, network
 * sampling, briefing refresh). A stray rejection from any of them must be logged
 * for diagnosis and must never take the whole app down silently.
 */
test('safety nets log stray async errors and keep the backend alive', () => {
  const lines = [];
  const log = (...args) => lines.push(args.map((a) => String(a?.stack ?? a)).join(' '));
  const nets = installProcessSafetyNets(log);
  try {
    assert.doesNotThrow(() => nets.onRejection(new Error('boom-rejection')), 'a rejection must not throw');
    assert.doesNotThrow(() => nets.onException(new Error('boom-exception')), 'an exception must not throw');
    assert.ok(lines.some((l) => l.includes('boom-rejection')), 'logs the rejection reason');
    assert.ok(lines.some((l) => l.includes('boom-exception')), 'logs the exception');
    assert.ok(lines.some((l) => /kept alive/.test(l)), 'makes survival explicit in the log');
  } finally {
    nets.uninstall();
  }
});

test('installing and removing the safety nets is clean', () => {
  const beforeRejection = process.listenerCount('unhandledRejection');
  const beforeException = process.listenerCount('uncaughtException');
  const nets = installProcessSafetyNets(() => {});
  assert.equal(process.listenerCount('unhandledRejection'), beforeRejection + 1, 'registers a rejection handler');
  assert.equal(process.listenerCount('uncaughtException'), beforeException + 1, 'registers an exception handler');
  nets.uninstall();
  assert.equal(process.listenerCount('unhandledRejection'), beforeRejection, 'removes the rejection handler');
  assert.equal(process.listenerCount('uncaughtException'), beforeException, 'removes the exception handler');
});
