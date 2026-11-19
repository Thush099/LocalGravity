import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { saveSession } from '../backend/state/storage.mjs';
import { createAgentServer } from '../backend/server.mjs';
import { buildSystemPrompt } from '../backend/agent/prompt.mjs';
import { selectToolsForTurn } from '../backend/agent/tool-selector.mjs';
import { TOOL_DEFINITIONS } from '../backend/tools/registry.mjs';

test('session management APIs (pin, rename, cwd, mode, truncate, fork), artifact sandbox, and TTS auth work end to end', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-ws-'));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-cwd-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'ws-secret-token-456';
  const srv = createAgentServer({ authToken, paths });
  const { port } = await srv.start();
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Auth-Token': authToken };

  try {
    // Seed 2 sessions and test pinning + PATCH validation
    await saveSession(
      {
        id: 's-older',
        title: 'Older chat',
        updatedAt: '2026-11-18T10:00:00.000Z',
        messages: [
          { role: 'user', content: 'Step 1' },
          { role: 'assistant', content: 'Reply 1' },
          { role: 'user', content: 'Step 2' },
          { role: 'assistant', content: 'Reply 2' },
        ],
      },
      paths
    );
    await saveSession(
      {
        id: 's-newer',
        title: 'Newer chat',
        updatedAt: '2026-11-19T10:00:00.000Z',
        messages: [{ role: 'user', content: 'Hi' }],
      },
      paths
    );

    // Invalid folder rejects cleanly with 400
    const badCwdRes = await fetch(`${base}/api/sessions/s-older`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ cwd: '/path/that/does/not/exist/lg_test_dir' }),
    });
    assert.equal(badCwdRes.status, 400);

    // Pin, rename, set cwd & mode
    const patchRes = await fetch(`${base}/api/sessions/s-older`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        pinned: true,
        title: 'Pinned Architecture Thread',
        cwd: workDir,
        mode: 'engineer',
      }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.session.pinned, true);
    assert.equal(patched.session.title, 'Pinned Architecture Thread');
    assert.equal(patched.session.cwd, workDir);
    assert.equal(patched.session.mode, 'engineer');

    // Pinned older session must now sort ahead of newer unpinned session
    const listRes = await fetch(`${base}/api/sessions`, { headers: { 'X-Auth-Token': authToken } });
    const listData = await listRes.json();
    assert.equal(listData.sessions[0].id, 's-older');
    assert.equal(listData.sessions[0].pinned, true);

    // Fork at index 2 creates an independent branched conversation
    const forkRes = await fetch(`${base}/api/sessions/s-older/fork`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ upToIndex: 2 }),
    });
    assert.equal(forkRes.status, 200);
    const forkData = await forkRes.json();
    assert.match(forkData.session.title, /\(Branch\)$/);
    assert.equal(forkData.session.messages.length, 2);
    assert.equal(forkData.session.cwd, workDir);
    assert.equal(forkData.session.pinned, false);

    // Truncate in-place leaves exact keepCount messages
    const truncRes = await fetch(`${base}/api/sessions/s-older/truncate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ keepCount: 2 }),
    });
    assert.equal(truncRes.status, 200);
    const truncData = await truncRes.json();
    assert.equal(truncData.session.messages.length, 2);

    // Artifact staging & strictly isolated sandbox preview
    const unauthStage = await fetch(`${base}/api/artifacts/stage`, { method: 'POST', body: '{}' });
    assert.equal(unauthStage.status, 401);

    const stageRes = await fetch(`${base}/api/artifacts/stage`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lang: 'svg', title: 'Ring', code: '<svg viewBox="0 0 10 10"></svg>' }),
    });
    assert.equal(stageRes.status, 200);
    const stageData = await stageRes.json();
    assert.match(stageData.previewUrl, /^\/preview-sandbox\/[a-f0-9]+$/);

    const sandboxRes = await fetch(`${base}${stageData.previewUrl}`);
    assert.equal(sandboxRes.status, 200);
    const sandboxCsp = sandboxRes.headers.get('content-security-policy') || '';
    assert.match(sandboxCsp, /sandbox allow-scripts/);
    assert.match(sandboxCsp, /frame-ancestors 'self'/);
    assert.equal(sandboxRes.headers.get('x-frame-options'), null);
    const sandboxBody = await sandboxRes.text();
    assert.match(sandboxBody, /<svg viewBox="0 0 10 10"><\/svg>/);

    const missingSandbox = await fetch(`${base}/preview-sandbox/doesnotexist`);
    assert.equal(missingSandbox.status, 404);

    // TTS endpoints enforce auth cleanly
    const unauthSpeak = await fetch(`${base}/api/chat/speak/stop`, { method: 'POST' });
    assert.equal(unauthSpeak.status, 401);
    const stopSpeak = await fetch(`${base}/api/chat/speak/stop`, { method: 'POST', headers });
    assert.equal(stopSpeak.status, 200);
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test('mode directives inject cleanly into system prompt and select mode-relevant local tools', () => {
  const defaultPrompt = buildSystemPrompt({ skills: [], knowledgeDocs: [], mode: 'auto' });
  const engPrompt = buildSystemPrompt({ skills: [], knowledgeDocs: [], mode: 'engineer' });
  assert.doesNotMatch(defaultPrompt, /Active Mode/);
  assert.match(engPrompt, /Active Mode \(Engineer\)/);

  const researchTools = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Tell me about this',
    mode: 'researcher',
  }).map((t) => t.function.name);
  assert.ok(researchTools.includes('search_web'));
  assert.ok(researchTools.includes('fetch_url'));
});
