import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { buildLaunchAgentPlist } from '../backend/automations.mjs';
import { createAgentServer } from '../backend/server.mjs';

test('model warm-up endpoint schedules only the configured Ollama model and coalesces concurrent requests', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-model-warmup-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'warmup-test-token';
  let resolveWarm;
  let resolveWarmStarted;
  let resolveAborted;
  let warmStarted = new Promise((resolve) => {
    resolveWarmStarted = resolve;
  });
  const aborted = new Promise((resolve) => {
    resolveAborted = resolve;
  });
  let warmCall;
  let warmSignal;
  let ensureCalls = 0;
  const runCalls = [];
  const warmModelFn = (model, options) => {
    warmSignal = options.signal;
    warmCall = { model, options: { numCtx: options.numCtx } };
    resolveWarmStarted();
    return new Promise((resolve) => {
      resolveWarm = resolve;
      options.signal.addEventListener(
        'abort',
        () => {
          resolveAborted();
          resolve({ status: 'aborted' });
        },
        { once: true }
      );
    });
  };
  const srv = createAgentServer({
    authToken,
    paths,
    agendaNotifications: false,
    warmModelFn,
    ensureOllamaFn: async () => {
      ensureCalls++;
    },
    runAgentTurnFn: async ({ userMessage }) => {
      runCalls.push(userMessage);
    },
    unloadModelsFn: async () => ({ unloaded: ['qwen3.5:9b'] }),
  });
  try {
    const { port } = await srv.start();
    const base = `http://127.0.0.1:${port}`;
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(
      paths.configFile,
      JSON.stringify({ provider: 'ollama', model: 'qwen3.5:9b', numCtx: 4096 }),
      'utf8'
    );
    const request = () =>
      fetch(`${base}/api/models/ollama/warm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
        body: '{}',
      });

    const first = await request();
    const concurrent = await request();
    assert.equal(first.status, 202);
    assert.equal(concurrent.status, 202);
    await warmStarted;
    assert.deepEqual(warmCall, { model: 'qwen3.5:9b', options: { numCtx: 4096 } });
    assert.equal(ensureCalls, 1);

    const chat = fetch(`${base}/api/sessions/warmup-chat/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ message: 'quick message' }),
    });
    const chatResponse = await chat;
    assert.equal(chatResponse.status, 200);
    assert.deepEqual(runCalls, []);

    resolveWarm({ status: 'loaded' });
    await chatResponse.text();
    assert.deepEqual(runCalls, ['quick message']);

    await fs.writeFile(
      paths.configFile,
      JSON.stringify({ provider: 'openai', model: 'gpt-4.1' }),
      'utf8'
    );
    const cloud = await request();
    assert.equal(cloud.status, 200);
    assert.equal((await cloud.json()).status, 'skipped');
    assert.equal(ensureCalls, 1);

    await fs.writeFile(
      paths.configFile,
      JSON.stringify({ provider: 'ollama', model: 'qwen3.5:9b', numCtx: 4096 }),
      'utf8'
    );
    warmStarted = new Promise((resolve) => {
      resolveWarmStarted = resolve;
    });
    const pendingWarm = await request();
    assert.equal(pendingWarm.status, 202);
    await warmStarted;
    assert.equal(warmSignal.aborted, false);

    const unload = fetch(`${base}/api/models/ollama/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: '{}',
    });
    await aborted;
    assert.equal(warmSignal.aborted, true);
    assert.deepEqual(runCalls, ['quick message']);
    resolveWarm({ status: 'loaded' });
    assert.equal((await unload).status, 200);
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('server API enforces X-Auth-Token, masks API keys, and manages sessions, skills, knowledge, and automations', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-api-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'secret-test-token-123';
  await fs.mkdir(path.join(tmpHome, '.agents', 'skills', 'local-helper'), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, '.agents', 'skills', 'local-helper', 'SKILL.md'),
    '---\nname: local-helper\ndescription: Helper from the local skill library\ntriggers: ["local"]\n---\n\n# Local helper\n\n1. Do the local thing.',
    'utf8'
  );
  const remoteSkillMarkdown =
    '---\nname: api-reviewer\ndescription: Review API contracts\ntriggers: ["api", "contract"]\n---\n\n# API review\n\n1. Check the contract.';
  const srv = createAgentServer({
    authToken,
    paths,
    fetchFn: async () => new Response(remoteSkillMarkdown),
    skillHomeDir: tmpHome,
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

    // The UI is served with a strict script policy and no-sniff headers
    const uiRes = await fetch(`${base}/`);
    assert.equal(uiRes.status, 200);
    assert.match(uiRes.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.equal(uiRes.headers.get('x-content-type-options'), 'nosniff');

    // Malformed JSON is a client error, not a 500
    const badJsonRes = await fetch(`${base}/api/models/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: '{not valid json',
    });
    assert.equal(badJsonRes.status, 400);

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

    // Local skill libraries are browsable and importable
    const externalRes = await fetch(`${base}/api/skills/external`, {
      headers: { 'X-Auth-Token': authToken },
    });
    assert.equal(externalRes.status, 200);
    const external = await externalRes.json();
    const agentsSource = external.sources.find((source) => source.id === 'agents');
    assert.ok(agentsSource);
    assert.ok(
      agentsSource.skills.some((skill) => skill.slug === 'local-helper' && skill.installed === false)
    );

    const importExternalRes = await fetch(`${base}/api/skills/import-external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ sourceId: 'agents', names: ['local-helper'] }),
    });
    assert.equal(importExternalRes.status, 200);
    const importExternalData = await importExternalRes.json();
    assert.deepEqual(importExternalData.imported, ['local-helper']);
    const skillsAfterLocalImport = await (
      await fetch(`${base}/api/skills`, { headers: { 'X-Auth-Token': authToken } })
    ).json();
    assert.ok(skillsAfterLocalImport.skills.some((s) => s.slug === 'local-helper'));

    const badExternalRes = await fetch(`${base}/api/skills/import-external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ sourceId: 'agents', names: [] }),
    });
    assert.equal(badExternalRes.status, 400);

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

    // Private/metadata URLs are blocked by the SSRF guard during skill import
    const blockedSkillRes = await fetch(`${base}/api/skills/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ urls: ['http://169.254.169.254/latest/meta-data/'] }),
    });
    assert.equal(blockedSkillRes.status, 200);
    const blockedSkillData = await blockedSkillRes.json();
    assert.equal(blockedSkillData.imported.length, 0);
    assert.equal(blockedSkillData.errors.length, 1);
    assert.match(blockedSkillData.errors[0].error, /blocked|private|local/i);

    // System metrics endpoint exposes swap, memory-sorted processes, and bounded telemetry history
    const metricsRes = await fetch(`${base}/api/system/metrics`, {
      headers: { 'X-Auth-Token': authToken },
    });
    assert.equal(metricsRes.status, 200);
    const metricsData = await metricsRes.json();
    assert.equal(metricsData.ok, true);
    assert.ok(metricsData.metrics && typeof metricsData.metrics.memory === 'object');
    assert.ok(Array.isArray(metricsData.metrics.processesByMemory));
    assert.ok(Array.isArray(metricsData.history) && metricsData.history.length >= 1);
    assert.ok(typeof metricsData.history[0].t === 'string');

    // Clipboard capture endpoint requires auth and responds with clean JSON
    const unauthClip = await fetch(`${base}/api/chat/clipboard`);
    assert.equal(unauthClip.status, 401);
    const clipRes = await fetch(`${base}/api/chat/clipboard`, {
      headers: { 'X-Auth-Token': authToken },
    });
    assert.equal(clipRes.status, 200);
    const clipData = await clipRes.json();
    assert.equal(typeof clipData.ok, 'boolean');
    assert.equal(typeof clipData.text, 'string');

    // Unload endpoint requires auth and handles empty/idle Ollama cleanly
    const unauthUnload = await fetch(`${base}/api/models/ollama/unload`, { method: 'POST' });
    assert.equal(unauthUnload.status, 401);
    const unloadRes = await fetch(`${base}/api/models/ollama/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({}),
    });
    assert.equal(unloadRes.status, 200);
    const unloadData = await unloadRes.json();
    assert.equal(unloadData.ok, true);
    assert.ok(Array.isArray(unloadData.unloaded));
  } finally {
    globalThis.fetch = origFetch;
    if (startedReal) await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
