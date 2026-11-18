import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { createAgentServer } from '../backend/server.mjs';

test('system metrics and schedule APIs work over authenticated HTTP', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-system-api-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'secret-test-token-456';
  const srv = createAgentServer({ authToken, paths, skillHomeDir: tmpHome });
  try {
    const { port } = await srv.start(0);
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'X-Auth-Token': authToken, 'Content-Type': 'application/json' };

    // System metrics: require auth, always report a metrics object.
    let res = await fetch(`${base}/api/system/metrics`);
    assert.equal(res.status, 401);
    res = await fetch(`${base}/api/system/metrics`, { headers });
    assert.equal(res.status, 200);
    let data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(typeof data.metrics, 'object');
    assert.ok(Array.isArray(data.metrics.disks));
    assert.ok(Array.isArray(data.metrics.processes));

    // Schedule CRUD.
    res = await fetch(`${base}/api/schedule`, { headers });
    data = await res.json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.entries, []);

    res = await fetch(`${base}/api/schedule`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Deep work', time: '09:00', days: [1, 2, 3, 4, 5], durationMin: 90 }),
    });
    assert.equal(res.status, 200);
    data = await res.json();
    assert.equal(data.entry.title, 'Deep work');
    const entryId = data.entry.id;

    res = await fetch(`${base}/api/schedule`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Bad', time: '99:99' }),
    });
    assert.equal(res.status, 400);

    res = await fetch(`${base}/api/schedule`, { headers });
    data = await res.json();
    assert.equal(data.entries.length, 1);
    assert.ok(Array.isArray(data.today));

    res = await fetch(`${base}/api/schedule/${entryId}`, { method: 'DELETE', headers });
    data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.entries.length, 0);

    res = await fetch(`${base}/api/schedule/${entryId}`, { method: 'DELETE', headers });
    assert.equal(res.status, 404);

    // Cross-origin mutation stays blocked.
    res = await fetch(`${base}/api/schedule`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'X', time: '10:00' }),
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
