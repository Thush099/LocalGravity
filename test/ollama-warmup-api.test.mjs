import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { createAgentServer } from '../backend/server.mjs';

test('changing the selected model cancels its pending Ollama warm-up', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-model-warmup-cancel-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'warmup-cancel-test-token';
  let warmStartedResolve;
  let warmSignal;
  const warmStarted = new Promise((resolve) => {
    warmStartedResolve = resolve;
  });
  const srv = createAgentServer({
    authToken,
    paths,
    agendaNotifications: false,
    ensureOllamaFn: async () => {},
    warmModelFn: (_model, { signal }) => {
      warmSignal = signal;
      warmStartedResolve();
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true });
      });
    },
  });

  try {
    const { port } = await srv.start();
    const base = `http://127.0.0.1:${port}`;
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(paths.configFile, JSON.stringify({ provider: 'ollama', model: 'qwen3.5:9b' }));
    const headers = { 'Content-Type': 'application/json', 'X-Auth-Token': authToken };
    const warm = await fetch(`${base}/api/models/ollama/warm`, { method: 'POST', headers, body: '{}' });
    assert.equal(warm.status, 202);
    await warmStarted;

    const changed = await fetch(`${base}/api/models/config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'ollama', model: 'qwen3.5:4b' }),
    });

    assert.equal(changed.status, 200);
    assert.equal(warmSignal.aborted, true);
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

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
    unloadModelsFn: async () => ({ unloaded: ['qwen3.5:9b'] }),
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

    // An explicit unload evicts the model, so its warm-up status must fall back to idle.
    assert.equal((await warm()).status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await status()).status, 'loaded');

    const unload = await fetch(`${base}/api/models/ollama/unload`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(unload.status, 200);
    assert.equal((await status()).status, 'idle');
    assert.equal(warmCalls, 4);
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
