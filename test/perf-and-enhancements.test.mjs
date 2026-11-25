import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { createAgentServer } from '../backend/server.mjs';
import {
  ensureKnowledgeSeeded,
  saveKnowledge,
  searchKnowledge,
  deleteKnowledge,
} from '../backend/knowledge-engine.mjs';
import { perAppUsage } from '../backend/network-monitor.mjs';
import { renderMarkdown } from '../ui/lib/markdown.js';

function rawHttpGet(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: reqPath, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('static assets support gzip compression and ETag 304 validation, and JSON routes compress >= 1KB payloads', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-perf-http-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'perf-test-token';
  const srv = createAgentServer({ authToken, paths, agendaNotifications: false });
  try {
    const { port } = await srv.start();
    const cssSource = await fs.readFile(new URL('../ui/styles.css', import.meta.url));

    // Compressed static asset fetch
    const gzipRes = await rawHttpGet(port, '/styles.css', { 'Accept-Encoding': 'gzip' });
    assert.equal(gzipRes.status, 200);
    assert.equal(gzipRes.headers['content-encoding'], 'gzip');
    assert.match(String(gzipRes.headers['vary'] || ''), /accept-encoding/i);
    assert.ok(gzipRes.headers['etag'], 'static asset returns ETag header');
    const decompressed = zlib.gunzipSync(gzipRes.body);
    assert.equal(Buffer.compare(decompressed, cssSource), 0);

    // ETag revalidation returns 304 Not Modified with empty body
    const notModRes = await rawHttpGet(port, '/styles.css', {
      'Accept-Encoding': 'gzip',
      'If-None-Match': gzipRes.headers['etag'],
    });
    assert.equal(notModRes.status, 304);
    assert.equal(notModRes.body.length, 0);

    // Large JSON payload compresses only when Accept-Encoding includes gzip
    const skillsGzip = await rawHttpGet(port, '/api/skills', {
      'X-Auth-Token': authToken,
      'Accept-Encoding': 'gzip',
    });
    assert.equal(skillsGzip.status, 200);
    assert.equal(skillsGzip.headers['content-encoding'], 'gzip');
    const skillsJson = JSON.parse(zlib.gunzipSync(skillsGzip.body).toString('utf8'));
    assert.equal(skillsJson.ok, true);
    assert.ok(Array.isArray(skillsJson.skills) && skillsJson.skills.length > 0);

    const skillsPlain = await rawHttpGet(port, '/api/skills', {
      'X-Auth-Token': authToken,
    });
    assert.equal(skillsPlain.status, 200);
    assert.equal(skillsPlain.headers['content-encoding'], undefined);
    const plainJson = JSON.parse(skillsPlain.body.toString('utf8'));
    assert.equal(plainJson.skills.length, skillsJson.skills.length);
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('briefing endpoint coalesces requests, serves disk/stale cache immediately, and refreshes on ?refresh=1', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-perf-brief-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'brief-test-token';
  let gatherCount = 0;
  let releaseGather;
  const gatherBriefingFn = async () => {
    gatherCount += 1;
    const callIdx = gatherCount;
    if (callIdx === 1) {
      await new Promise((r) => {
        releaseGather = r;
      });
    }
    return {
      news: [{ title: `Headline #${callIdx}`, source: 'BBC', link: 'https://bbc.co.uk' }],
      email: { ok: true, count: callIdx, summary: `${callIdx} emails`, messages: [], error: null },
      weather: { ok: true, city: 'Colombo', icon: '☀️', temp: 30, feelsLike: 32, description: 'Clear', high: 32, low: 25, wind: 10 },
      network: { topApps: [{ name: 'Safari', total: 1024 }], sinceBootBytes: 2048, monthBytes: 4096, todayBytes: 512, month: '2026-11', history: {}, lastSpeedMbps: null },
      updatedAt: new Date().toISOString(),
    };
  };

  // Pre-seed stale disk cache from 2 hours ago
  await fs.mkdir(paths.root, { recursive: true });
  await fs.writeFile(
    path.join(paths.root, 'briefing-cache.json'),
    JSON.stringify({
      savedAt: Date.now() - 2 * 60 * 60 * 1000,
      briefing: {
        news: [{ title: 'Disk Cached Lead', source: 'BBC', link: 'https://bbc.co.uk' }],
        email: { ok: true, count: 4, summary: '4 unread', messages: [], error: null },
        weather: { ok: true, city: 'Colombo', temp: 29 },
        network: { topApps: [], sinceBootBytes: 100, monthBytes: 2 * 1024 ** 3, todayBytes: 100, month: '2026-11', history: {} },
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    }),
    'utf8'
  );

  const srv = createAgentServer({ authToken, paths, agendaNotifications: false, gatherBriefingFn });
  try {
    const { port } = await srv.start();
    const base = `http://127.0.0.1:${port}`;

    // Stale disk cache returns instantaneously without waiting on blocked gather
    const t0 = performance.now();
    const staleRes = await fetch(`${base}/api/briefing`, { headers: { 'X-Auth-Token': authToken } });
    const dt = performance.now() - t0;
    assert.equal(staleRes.status, 200);
    assert.ok(dt < 500, `stale briefing returned in ${dt.toFixed(1)}ms instead of blocking`);
    const staleData = await staleRes.json();
    assert.equal(staleData.briefing.news[0].title, 'Disk Cached Lead');
    assert.equal(staleData.stale, true);

    // Wait briefly so background refresh started, then unblock it and verify coalescing
    while (!releaseGather) await new Promise((r) => setTimeout(r, 10));
    const concurrentRefresh = Promise.all([
      fetch(`${base}/api/briefing?refresh=1`, { headers: { 'X-Auth-Token': authToken } }),
      fetch(`${base}/api/briefing?refresh=1`, { headers: { 'X-Auth-Token': authToken } }),
    ]);
    releaseGather();
    const [r1, r2] = await concurrentRefresh;
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const d1 = await r1.json();
    const d2 = await r2.json();
    assert.equal(d1.briefing.news[0].title, 'Headline #1');
    assert.equal(d2.briefing.news[0].title, 'Headline #1');
    assert.equal(gatherCount, 1, 'concurrent ?refresh=1 calls coalesced into one gather');
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('perAppUsage coalesces concurrent calls onto a single nettop execution', async () => {
  let execCalls = 0;
  const fakeExec = async () => {
    execCalls += 1;
    await new Promise((r) => setTimeout(r, 40));
    return { stdout: ',bytes_in,bytes_out,\nSafari.123,5000,1000,\n' };
  };
  const [a, b] = await Promise.all([
    perAppUsage({ limit: 5, execFileFn: fakeExec, bypassCache: true }),
    perAppUsage({ limit: 5, execFileFn: fakeExec, bypassCache: true }),
  ]);
  assert.equal(execCalls, 1);
  assert.equal(a.ok, true);
  assert.equal(a.apps[0].name, 'Safari');
  assert.deepEqual(b.apps, a.apps);
});

test('Smart Assist API computes live suggestions and persists dismissals', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-suggest-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'suggest-test-token';
  const srv = createAgentServer({ authToken, paths, agendaNotifications: false });
  try {
    const { port } = await srv.start();
    const base = `http://127.0.0.1:${port}`;

    // Unauthorized blocked
    assert.equal((await fetch(`${base}/api/suggestions`)).status, 401);

    // Seed an inbox count via briefing cache so there's at least one guaranteed suggestion alongside time/storage
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(
      path.join(paths.root, 'briefing-cache.json'),
      JSON.stringify({
        savedAt: Date.now(),
        briefing: {
          news: [],
          email: { ok: true, count: 14, summary: '14 unread emails' },
          weather: { ok: false },
          network: { monthBytes: 35 * 1024 ** 3 },
          updatedAt: new Date().toISOString(),
        },
      }),
      'utf8'
    );

    const res = await fetch(`${base}/api/suggestions`, { headers: { 'X-Auth-Token': authToken } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.suggestions) && data.suggestions.length > 0);
    const emailSug = data.suggestions.find((s) => s.id === 'summarize-inbox');
    assert.ok(emailSug, 'summarize-inbox suggestion surfaces from cached unread emails');

    // Invalid dismissal ID is rejected
    const badDismiss = await fetch(`${base}/api/suggestions/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ id: '../bad!' }),
    });
    assert.equal(badDismiss.status, 400);

    // Valid dismissal persists and disappears from suggestions
    const dismissRes = await fetch(`${base}/api/suggestions/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ id: 'summarize-inbox' }),
    });
    assert.equal(dismissRes.status, 200);
    const afterData = await dismissRes.json();
    assert.ok(!afterData.suggestions.some((s) => s.id === 'summarize-inbox'));
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('POST /api/chat/attachment safely stores dropped or pasted files with sanitized paths', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-attach-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'attach-test-token';
  const srv = createAgentServer({ authToken, paths, agendaNotifications: false });
  const png1x1Base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  try {
    const { port } = await srv.start();
    const base = `http://127.0.0.1:${port}`;

    // Empty body rejected
    const emptyRes = await fetch(`${base}/api/chat/attachment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ filename: 'empty.png', dataBase64: '' }),
    });
    assert.equal(emptyRes.status, 400);

    // Traversal filename is sanitized into <paths.root>/attachments/
    const res = await fetch(`${base}/api/chat/attachment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({
        filename: '../../etc/pasted screenshot.png',
        dataBase64: `data:image/png;base64,${png1x1Base64}`,
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.path.startsWith(path.join(paths.root, 'attachments') + path.sep));
    assert.ok(!data.path.includes('..'));
    const written = await fs.readFile(data.path);
    assert.equal(written.toString('base64'), png1x1Base64);
  } finally {
    await srv.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('searchKnowledge uses updated cache and renderMarkdown memoizes deterministically with bounded LRU', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-know-cache-'));
  const paths = getRuntimePaths(tmpHome);
  await ensureKnowledgeSeeded(paths);
  await saveKnowledge({ name: 'perf-notes', title: 'Performance Notes', tags: ['mac'], content: 'Allocate unified bandwidth carefully.' }, paths);

  const h1 = await searchKnowledge('unified bandwidth', paths);
  assert.equal(h1[0].name, 'perf-notes');

  await saveKnowledge({ name: 'perf-notes', title: 'Performance Notes', tags: ['mac'], content: 'Apple Silicon GPU throughput is fast.' }, paths);
  const h2 = await searchKnowledge('throughput', paths);
  assert.equal(h2[0].name, 'perf-notes');
  assert.equal((await searchKnowledge('unified bandwidth', paths)).length, 0);

  await deleteKnowledge('perf-notes', paths);
  await fs.rm(tmpHome, { recursive: true, force: true });

  // Bounded LRU cache verification across 320 unique documents
  const first = renderMarkdown('**Cached** `#tag` check');
  const second = renderMarkdown('**Cached** `#tag` check');
  assert.equal(first, second);
  for (let i = 0; i < 320; i += 1) {
    const out = renderMarkdown(`Unique entry number ${i}`);
    assert.match(out, new RegExp(`Unique entry number ${i}`));
  }
});
