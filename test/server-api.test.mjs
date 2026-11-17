import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { buildLaunchAgentPlist } from '../backend/automations.mjs';
import { createAgentServer } from '../backend/server.mjs';

test('server API enforces X-Auth-Token, masks API keys, and manages sessions, skills, knowledge, and automations', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-api-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'secret-test-token-123';
  const srv = createAgentServer({ authToken, paths });
  const { port } = await srv.start();
  const base = `http://127.0.0.1:${port}`;

  try {
    const unauth = await fetch(`${base}/api/health`);
    assert.equal(unauth.status, 401);

    const wrongAuth = await fetch(`${base}/api/models/config`, {
      headers: { 'X-Auth-Token': 'wrong-token' },
    });
    assert.equal(wrongAuth.status, 401);

    const healthRes = await fetch(`${base}/api/health`, {
      headers: { 'X-Auth-Token': authToken },
    });
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.ok(health.system.totalRamGb >= 1);

    // Model config saves keys and masks them on GET
    const saveCfgRes = await fetch(`${base}/api/models/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({
        provider: 'openrouter',
        model: 'qwen/qwen3-235b-a22b:free',
        apiKeys: { openrouter: 'sk-or-v1-secret9876', anthropic: 'sk-ant-secret1234' },
      }),
    });
    assert.equal(saveCfgRes.status, 200);

    const getCfgRes = await fetch(`${base}/api/models/config`, {
      headers: { 'X-Auth-Token': authToken },
    });
    const cfgData = await getCfgRes.json();
    assert.equal(cfgData.config.provider, 'openrouter');
    assert.equal(cfgData.configuredKeys.openrouter, true);
    assert.equal(cfgData.configuredKeys.anthropic, true);
    assert.equal(cfgData.config.apiKeys, undefined);

    // Skills CRUD
    const saveSkillRes = await fetch(`${base}/api/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({
        name: 'custom-reel',
        description: 'Export reels',
        triggers: ['reel'],
        content: '# Reel workflow',
      }),
    });
    assert.equal(saveSkillRes.status, 200);
    const skillsList = await (
      await fetch(`${base}/api/skills`, { headers: { 'X-Auth-Token': authToken } })
    ).json();
    assert.ok(skillsList.skills.some((s) => s.slug === 'custom-reel'));

    // Knowledge CRUD
    const saveKnowRes = await fetch(`${base}/api/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({
        name: 'my-guide',
        title: 'Editing Guide',
        tags: ['video'],
        content: 'Use 24fps cinematic shutter.',
      }),
    });
    assert.equal(saveKnowRes.status, 200);
    const knowList = await (
      await fetch(`${base}/api/knowledge`, { headers: { 'X-Auth-Token': authToken } })
    ).json();
    assert.ok(knowList.docs.some((d) => d.name === 'my-guide'));

    // Automations CRUD & plist builder
    const createAutoRes = await fetch(`${base}/api/automations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({
        name: 'Daily Storage Audit',
        prompt: 'Audit storage usage safely',
        allowAutoRun: false,
      }),
    });
    assert.equal(createAutoRes.status, 200);
    const autoList = await (
      await fetch(`${base}/api/automations`, { headers: { 'X-Auth-Token': authToken } })
    ).json();
    assert.equal(autoList.automations.length, 1);

    const plist = buildLaunchAgentPlist({
      id: 'audit-1',
      label: 'com.localgravity.audit-1',
      scriptPath: '/Applications/LocalGravity.app/Contents/Resources/backend/cli-run.mjs',
      nodePath: '/opt/homebrew/bin/node',
      calendarInterval: { Hour: 9, Minute: 0 },
    });
    assert.match(plist, /<key>Label<\/key>\s*<string>com\.localgravity\.audit-1<\/string>/);
    assert.match(plist, /--automation/);
    assert.match(plist, /<key>Hour<\/key>\s*<integer>9<\/integer>/);
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
