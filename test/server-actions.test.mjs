import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { createAgentServer } from '../backend/server.mjs';

test('instant action endpoints list ids and run read-only actions without a model', async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-actions-api-'));
  t.after(() => fs.rm(tmpHome, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpHome);
  await fs.mkdir(paths.root, { recursive: true });
  const authToken = 'actions-test-token';

  let runAgentCalls = 0;
  const srv = createAgentServer({
    authToken,
    paths,
    agendaNotifications: false,
    runAgentTurnFn: async () => {
      runAgentCalls += 1;
    },
  });

  try {
    const { port } = await srv.start();
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'Content-Type': 'application/json', 'X-Auth-Token': authToken };

    // Unauthorized requests are rejected.
    const unauthorized = await fetch(`${base}/api/actions`, { headers: { 'X-Auth-Token': 'wrong' } });
    assert.equal(unauthorized.status, 401);

    // List available action ids.
    const listRes = await fetch(`${base}/api/actions`, { headers });
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.ok, true);
    assert.ok(Array.isArray(list.actions) && list.actions.includes('system_health'));

    // Run the schedule action — pure read, no model inference involved.
    const runRes = await fetch(`${base}/api/actions/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'schedule_today' }),
    });
    assert.equal(runRes.status, 200);
    const run = await runRes.json();
    assert.equal(run.ok, true);
    assert.match(run.output, /schedule|Scheduled|Nothing/i);

    // Unknown action is a clean 400, not a crash.
    const badRes = await fetch(`${base}/api/actions/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'delete_everything' }),
    });
    assert.equal(badRes.status, 400);
    const bad = await badRes.json();
    assert.equal(bad.ok, false);

    // The whole flow ran without ever invoking the model.
    assert.equal(runAgentCalls, 0);
  } finally {
    await srv.stop();
  }
});