import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { TOOL_DEFINITIONS } from '../backend/tools/registry.mjs';
import { INSTANT_ACTION_IDS } from '../backend/actions.mjs';

/**
 * Guards against UI ↔ backend drift: the welcome-screen chips must match the
 * server's instant-action whitelist, and every registered tool must have a
 * human-readable label so the chat UI never shows a raw snake_case tool name.
 */
function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `ui/app.js is missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `ui/app.js block starting at ${startMarker} never closes with ${endMarker}`);
  return source.slice(start, end);
}

async function readAppSource() {
  return fs.readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
}

test('UI instant-action chips match the backend whitelist exactly', async () => {
  const app = await readAppSource();
  const block = extractBlock(app, 'const INSTANT_ACTIONS = [', '];');
  const uiIds = [...block.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(uiIds.length > 0, 'no instant-action ids parsed from ui/app.js');
  assert.deepEqual(uiIds.sort(), [...INSTANT_ACTION_IDS].sort());
});

test('every registry tool has a human-readable UI label', async () => {
  const app = await readAppSource();
  const block = extractBlock(app, 'const HUMAN_TOOL_META = {', '\n};');
  const labeled = new Set([...block.matchAll(/^ {2}([a-z0-9_]+): \{/gm)].map((m) => m[1]));
  assert.ok(labeled.size >= TOOL_DEFINITIONS.length, 'fewer labels parsed than registered tools');
  const missing = TOOL_DEFINITIONS.map((t) => t.function.name).filter((name) => !labeled.has(name));
  assert.deepEqual(missing, [], `tools missing HUMAN_TOOL_META labels: ${missing.join(', ')}`);
});

test('friendlyError turns raw model failures into actionable messages', async () => {
  const app = await readAppSource();
  const block = extractBlock(app, 'const ERROR_HINTS = [', 'async function sendPrompt');
  const friendlyError = new Function(`${block}\nreturn friendlyError;`)();
  const cases = [
    ['connect ECONNREFUSED 127.0.0.1:11434', /Ollama|responding/i],
    ['401 Unauthorized: invalid api key', /API key|rejected/i],
    ['429 Too Many Requests', /rate-limiting/i],
    ['model_not_found: qwen99', /not available|model/i],
    ['Request timed out after 120s', /timed out/i],
    ['maximum context length exceeded', /too long|compacts/i],
    ['something odd happened', /Something went wrong/i],
  ];
  for (const [msg, hint] of cases) {
    const r = friendlyError(msg);
    assert.match(`${r.title} ${r.hint}`, hint, `friendlyError(${JSON.stringify(msg)}) should be actionable`);
    assert.equal(r.detail, msg, 'keeps the raw detail for debugging');
  }
  assert.equal(friendlyError(undefined).detail, 'Model error');
});

async function readIndexSource() {
  return fs.readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
}

async function readCssSource() {
  return fs.readFile(new URL('../ui/styles.css', import.meta.url), 'utf8');
}

test('dashboard bottom half uses the responsive card grid', async () => {
  const index = await readIndexSource();
  const css = await readCssSource();
  assert.ok(index.includes('class="dash-grid"'), 'dashboard should use the .dash-grid responsive grid');
  assert.ok(!index.includes('dash-columns'), 'the legacy .dash-columns split should be gone');
  assert.ok(css.includes('.dash-grid'), '.dash-grid must be styled');
  assert.ok(css.includes('repeat(auto-fit'), 'the grid must reflow responsively across monitors');
  assert.ok(css.includes('.dash-runtime-card'), 'the runtime summary bar keeps its full-width treatment');
});

test('dashboard resource tiles render live waves and an actionable storage alert', async () => {
  const index = await readIndexSource();
  const app = await readAppSource();
  for (const id of ['dash-cpu-spark', 'dash-mem-spark', 'dash-gpu-spark', 'dash-disk-spark']) {
    assert.ok(index.includes(`id="${id}"`), `missing live-wave container ${id}`);
  }
  assert.ok(!index.includes('dash-cpu-bar'), 'static usage bars should be replaced by live waves');
  assert.ok(index.includes('id="dash-storage-alert"'), 'the low-storage alert container must exist');
  assert.ok(app.includes('data-clean-downloads'), 'the storage alert must link to the Clean downloads capability');
  assert.ok(app.includes('getCleanDownloadsPrompt'), 'the Clean downloads capability must launch from the alert');
  assert.ok(app.includes('renderSparkline'), 'the tiles draw real-time waves from renderSparkline');
});
test('emptyState escapes copy and keeps the action hook intact', async () => {
  const app = await readAppSource();
  const block = extractBlock(app, 'function emptyState(', '\nconst ZAP_ICON');
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const emptyState = new Function('escapeHtml', `${block}\nreturn emptyState;`)(escapeHtml);

  const html = emptyState({
    icon: '<svg></svg>',
    title: '<b>No</b> skills',
    detail: 'a & b',
    action: { label: 'Go', attrs: 'data-empty-action="x"' },
  });
  assert.match(html, /role="status"/);
  assert.match(html, /&lt;b&gt;No&lt;\/b&gt; skills/);
  assert.match(html, /a &amp; b/);
  assert.match(html, /data-empty-action="x"/);
  assert.ok(!html.includes('<b>'), 'user copy must never be interpolated raw');

  const plain = emptyState({ title: 'Nothing' });
  assert.ok(!plain.includes('empty-state-action'), 'no action button without an action');
});

test('dialogs hide the page behind them from keyboard and assistive tech', async () => {
  const app = await readAppSource();
  assert.match(app, /function setShellInert\(on\)/, 'shell inert helper must exist');
  assert.match(app, /setShellInert\(true\)/, 'opening a dialog must inert the shell');
  assert.match(app, /function trapTabKey/, 'Tab must stay inside an open dialog');
  const html = await fs.readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="modal-backdrop"[^>]*aria-labelledby="modal-title"/, 'dialog needs an accessible name');
});
