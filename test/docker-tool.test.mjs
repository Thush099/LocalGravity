import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dockerTool } from '../backend/tools/docker-tool.mjs';

describe('dockerTool contracts', () => {
  test('unknown actions are rejected with the action name', async () => {
    const res = await dockerTool({ action: 'compose-up' });
    assert.equal(res.ok, false);
    assert.match(res.error, /Unknown docker action: compose-up/);
  });

  test('logs without a container_id are rejected', async () => {
    const res = await dockerTool({ action: 'logs' });
    assert.equal(res.ok, false);
    assert.match(res.error, /container_id is required for logs/);
  });

  test('ps either reports parsed containers or fails with a surfaced error', async () => {
    const res = await dockerTool({ action: 'ps' });
    assert.equal(typeof res.ok, 'boolean');
    if (res.ok) {
      assert.ok(Array.isArray(res.containers), 'success implies a parsed container list');
    } else {
      assert.ok(res.error.length > 0, 'failures always surface an error message');
    }
  });

  test('stats either reports parsed entries or fails with a surfaced error', async () => {
    const res = await dockerTool({ action: 'stats' });
    assert.equal(typeof res.ok, 'boolean');
    if (res.ok) {
      assert.ok(Array.isArray(res.stats), 'success implies a parsed stats list');
    } else {
      assert.ok(res.error.length > 0, 'failures always surface an error message');
    }
  });
});
