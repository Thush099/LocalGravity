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
  const remoteSkillMarkdown =
    '---\nname: api-reviewer\ndescription: Review API contracts\ntriggers: ["api", "contract"]\n---\n\n# API review\n\n1. Check the contract.';
  const srv = createAgentServer({
    authToken,
    paths,
    fetchFn: async () => new Response(remoteSkillMarkdown),
  });
  const { EventEmitter } = await import('node:events');
  const origFetch = globalThis.fetch;
  let base = 'http://localgravity.test';
  let startedReal = false;
  try {
    const { port } = await srv.start();
    base = `http://127.0.0.1:${port}`;
    startedReal = true;
  } catch {
    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'localgravity.test') {
        throw new Error('Connection refused');
      }
      const req = new EventEmitter();
      req.method = options.method || 'GET';
      req.url = parsed.pathname + parsed.search;
      req.headers = { host: parsed.host };
      for (const [k, v] of Object.entries(options.headers || {})) {
        req.headers[k.toLowerCase()] = v;
      }
      const bodyBuf = options.body ? Buffer.from(options.body) : null;
      req[Symbol.asyncIterator] = async function* () {
        if (bodyBuf) yield bodyBuf;
      };
      return new Promise((resolve) => {
        const chunks = [];
        const resHeaders = {};
        const res = {
          statusCode: 200,
          headersSent: false,
          writableEnded: false,
          setHeader(k, v) {
            resHeaders[k.toLowerCase()] = v;
          },
          writeHead(status, hdrs = {}) {
            this.statusCode = status;
            this.headersSent = true;
            for (const [k, v] of Object.entries(hdrs)) {
              resHeaders[k.toLowerCase()] = v;
            }
            return this;
          },
          write(chunk) {
            this.headersSent = true;
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            return true;
          },
          end(chunk) {
            if (chunk) this.write(chunk);
            this.writableEnded = true;
            resolve(new Response(Buffer.concat(chunks), { status: this.statusCode, headers: resHeaders }));
          },
        };
        srv.server.emit('request', req, res);
      });
    };
  }

  try {
    const unauth = await fetch(`${base}/api/health`);
    assert.equal(unauth.status, 401);

    const wrongAuth = await fetch(`${base}/api/models/config`, {
      headers: { 'X-Auth-Token': 'wrong-token' },
    });
    assert.equal(wrongAuth.status, 401);

    // A foreign Origin cannot ride the auth cookie for mutations
    const crossOriginRes = await fetch(`${base}/api/models/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken, Origin: 'https://evil.example' },
      body: JSON.stringify({}),
    });
    assert.equal(crossOriginRes.status, 403);

    const sameOriginRes = await fetch(`${base}/api/models/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken, Origin: base },
      body: JSON.stringify({}),
    });
    assert.equal(sameOriginRes.status, 200);

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

    // Import a skill from a GitHub URL through the injected fetch implementation
    const importUrlRes = await fetch(`${base}/api/skills/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({
        urls: ['https://github.com/owner/repo/blob/main/skills/api-reviewer/SKILL.md'],
      }),
    });
    assert.equal(importUrlRes.status, 200);
    const importUrlData = await importUrlRes.json();
    assert.equal(importUrlData.ok, true);
    assert.equal(importUrlData.imported[0].slug, 'api-reviewer');
    assert.deepEqual(importUrlData.errors, []);
    const skillsAfterImport = await (
      await fetch(`${base}/api/skills`, { headers: { 'X-Auth-Token': authToken } })
    ).json();
    assert.ok(skillsAfterImport.skills.some((s) => s.slug === 'api-reviewer'));

    // Refresh re-downloads the skill from its stored source URL
    const refreshRes = await fetch(`${base}/api/skills/api-reviewer/refresh`, {
      method: 'POST',
      headers: { 'X-Auth-Token': authToken },
    });
    assert.equal(refreshRes.status, 200);
    const refreshData = await refreshRes.json();
    assert.equal(refreshData.refreshed.slug, 'api-reviewer');

    // Bad import input is rejected without touching the network
    const badImportRes = await fetch(`${base}/api/skills/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ urls: [] }),
    });
    assert.equal(badImportRes.status, 400);

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

    // Import a knowledge doc from a public URL through the injected fetch implementation
    const importKnowRes = await fetch(`${base}/api/knowledge/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ url: 'https://example.com/reading-notes' }),
    });
    assert.equal(importKnowRes.status, 200);
    const importKnowData = await importKnowRes.json();
    assert.equal(importKnowData.saved.name, 'reading-notes');
    assert.ok(importKnowData.chars > 0);
    const knowAfterImport = await (
      await fetch(`${base}/api/knowledge`, { headers: { 'X-Auth-Token': authToken } })
    ).json();
    assert.ok(knowAfterImport.docs.some((d) => d.name === 'reading-notes'));

    // Local/private hosts are refused before fetching
    const blockedKnowRes = await fetch(`${base}/api/knowledge/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ url: 'http://127.0.0.1:9/private' }),
    });
    assert.equal(blockedKnowRes.status, 400);

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
    assert.match(plist, /<key>EnvironmentVariables<\/key>/);
    assert.match(plist, /\/opt\/homebrew\/bin/);

    // Spaced path CLI entry point must execute main() instead of silently exiting 0
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await assert.rejects(
      () => execFileAsync(process.execPath, [path.resolve('backend/cli-run.mjs')]),
      (err) => err.code === 1 && /Usage:/.test(err.stderr)
    );

    // Concurrent/back-to-back POST /run on same session must cleanly cancel/replace without leaving hanging sockets
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ id: 'multi-msg-1', title: 'Multi turn' }),
    });
    const r1 = await fetch(`${base}/api/sessions/multi-msg-1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ message: 'first msg', provider: 'custom', customBaseUrl: 'http://127.0.0.1:1/v1' }),
    });
    const t1 = await r1.text();
    assert.match(t1, /error/i);
    const r2 = await fetch(`${base}/api/sessions/multi-msg-1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ message: 'second msg', provider: 'custom', customBaseUrl: 'http://127.0.0.1:1/v1' }),
    });
    const t2 = await r2.text();
    assert.match(t2, /error/i);
    const sessCheck = await (
      await fetch(`${base}/api/sessions/multi-msg-1`, { headers: { 'X-Auth-Token': authToken } })
    ).json();
    const userMsgs = sessCheck.session.messages.filter((m) => m.role === 'user');
    assert.equal(userMsgs.length, 2);
    assert.equal(userMsgs[0].content, 'first msg');
    assert.equal(userMsgs[1].content, 'second msg');

    // Full-text session search finds stored user messages
    const searchRes = await fetch(`${base}/api/sessions/search?q=second`, {
      headers: { 'X-Auth-Token': authToken },
    });
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.ok(searchData.results.some((r) => r.id === 'multi-msg-1'));
    assert.ok(searchData.results[0].snippet.length > 0);
  } finally {
    globalThis.fetch = origFetch;
    if (startedReal) await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
