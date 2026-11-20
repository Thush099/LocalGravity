import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { createAgentServer } from '../backend/server.mjs';

test('chat proceeds to inference when an in-flight Ollama warm-up fails', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-warmup-chat-fallback-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'warmup-chat-fallback-token';
  let rejectWarm;
  let resolveWarmStarted;
  const warmStarted = new Promise((resolve) => {
    resolveWarmStarted = resolve;
  });
  const runCalls = [];
  const srv = createAgentServer({
    authToken,
    paths,
    agendaNotifications: false,
    ensureOllamaFn: async () => {},
    warmModelFn: () => {
      resolveWarmStarted();
      return new Promise((_resolve, reject) => {
        rejectWarm = reject;
      });
    },
    runAgentTurnFn: async ({ userMessage, onEvent }) => {
      runCalls.push(userMessage);
      onEvent({ type: 'text_delta', text: 'inference proceeded' });
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

    const chatResponse = await fetch(`${base}/api/sessions/warmup-fallback/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'continue normally' }),
    });
    assert.equal(chatResponse.status, 200);
    rejectWarm(new Error('warm-up unavailable'));
    assert.match(await chatResponse.text(), /inference proceeded/);
    assert.deepEqual(runCalls, ['continue normally']);
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
