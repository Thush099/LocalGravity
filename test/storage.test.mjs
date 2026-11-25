import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRepoPath, getRuntimePaths } from '../backend/state/paths.mjs';
import {
  atomicWriteJson,
  readJsonSafe,
  loadConfig,
  saveConfig,
  saveSession,
  loadSession,
  listSessions,
  MAX_LISTED_SESSIONS,
  deleteSession,
  saveAutomations,
  loadAutomations,
} from '../backend/state/storage.mjs';

test('storage persists config with 0600 mode, isolates sessions, and handles concurrent atomic writes', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-store-'));
  const paths = getRuntimePaths(tmpHome);

  assert.equal(paths.knowledgeDir, path.join(tmpHome, 'knowledge'));
  assert.ok(getRepoPath());

  const cfg = await loadConfig(paths);
  assert.equal(cfg.provider, 'ollama');
  assert.equal(cfg.model, 'qwen3.5:4b');
  assert.equal(cfg.numCtx, 8192);
  assert.equal(cfg.thinking, false);
  assert.equal(cfg.safetyMode, 'ask');

  const updated = await saveConfig(
    {
      apiKeys: { openrouter: 'sk-test-123', gemini: 'gem-key' },
      thinking: false,
    },
    paths
  );
  assert.equal(updated.apiKeys.openrouter, 'sk-test-123');
  assert.equal(updated.apiKeys.gemini, 'gem-key');
  const stat = await fs.stat(paths.configFile);
  assert.equal(stat.mode & 0o777, 0o600);

  await saveSession(
    {
      id: 'sess-1',
      title: 'Test session',
      updatedAt: '2026-11-17T10:00:00Z',
      messages: [{ role: 'user', content: 'hello' }],
    },
    paths
  );
  const loaded = await loadSession('sess-1', paths);
  assert.equal(loaded.title, 'Test session');
  assert.equal((await listSessions(paths)).length, 1);

  await assert.rejects(() => saveSession({ id: '../bad', title: 'Bad', messages: [] }, paths));

  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      saveAutomations(
        [{ id: `auto-${i}`, name: `Job ${i}`, prompt: 'audit', allowAutoRun: false }],
        paths
      )
    )
  );
  const autos = await loadAutomations(paths);
  assert.equal(autos.length, 1);
  assert.match(autos[0].id, /^auto-\d+$/);

  await fs.writeFile(paths.automationsFile, '{broken json');
  assert.deepEqual(await readJsonSafe(paths.automationsFile, []), []);
  assert.equal(await deleteSession('sess-1', paths), true);
  assert.equal(await loadSession('sess-1', paths), null);

  await fs.rm(tmpHome, { recursive: true, force: true });
});

test('listSessions caps its response at MAX_LISTED_SESSIONS', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-session-cap-'));
  const paths = getRuntimePaths(tmpHome);
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  for (let i = 0; i < 305; i += 1) {
    await fs.writeFile(
      path.join(paths.sessionsDir, `cap-${i}.json`),
      JSON.stringify({
        id: `cap-${i}`,
        title: `Session ${i}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
        messages: [],
      }),
      'utf8'
    );
  }
  const list = await listSessions(paths);
  assert.equal(list.length, MAX_LISTED_SESSIONS);
  // Most recent sessions sort first.
  assert.equal(list[0].id, 'cap-304');
  await fs.rm(tmpHome, { recursive: true, force: true });
});

test('schedule notifications stay off unless the user opts in', async () => {
  const paths = getRuntimePaths();
  const cfg = await loadConfig(paths);
  assert.equal(typeof cfg.agendaNotifications, 'boolean');
  const { DEFAULT_CONFIG } = await import('../backend/state/storage.mjs');
  assert.equal(DEFAULT_CONFIG.agendaNotifications, false, 'default config must not notify unasked');
});