import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { createAgentServer } from '../backend/server.mjs';

test('Ollama warm-up status reports pending, failed, and successful model loads', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-model-warmup-status-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'warmup-status-test-token';
  let rejectWarm;
  let warmCalls = 0;
  const srv = createAgentServer({
    authToken,
    paths,
    agendaNotifications: false,
    ensureOllamaFn: async () => {},
    warmModelFn: () => {
      warmCalls++;
      if (warmCalls === 1) {
        return new Promise((resolve, reject) => {
          rejectWarm = reject;
        });
      }
      if (warmCalls === 3) return Promise.resolve({ status: 'unavailable' });
      return Promise.resolve({ status: 'loaded' });
    },
  });

  try {
    const { port } = await srv.start();
    const base = `http://127.0.0.1:${port}`;
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(paths.configFile, JSON.stringify({ provider: 'ollama', model: 'qwen3.5:9b' }));
    const headers = { 'Content-Type': 'application/json', 'X-Auth-Token': authToken };
    const warm = () => fetch(`${base}/api/models/ollama/warm`, { method: 'POST', headers, body: '{}' });
    const statusResponse = () => fetch(`${base}/api/models/ollama/warm/status?model=qwen3.5%3A9b`, { headers });
    const status = () => statusResponse().then((res) => res.json());

    assert.equal((await fetch(`${base}/api/models/ollama/warm/status?model=qwen3.5%3A9b`)).status, 401);
    assert.equal((await warm()).status, 202);
    assert.equal((await status()).status, 'warming');

    rejectWarm(new Error('mock Ollama failure'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await status()).status, 'failed');

    assert.equal((await warm()).status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await status()).status, 'loaded');

    assert.equal((await warm()).status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await status()).status, 'failed');
    assert.equal(warmCalls, 3);
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
