import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  actionLogFile,
  appendAction,
  isTrailTool,
  readActions,
} from '../backend/agent/action-log.mjs';
import { summarizeBriefing } from '../backend/tools/briefing-tool.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

process.env.LOCALGRAVITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-trail-'));

async function tmpPaths() {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-trail-case-'));
  return { root, paths: getRuntimePaths(root) };
}

test('the trail keeps what actually happened, newest first', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await appendAction(paths, { tool: 'write_file', kind: 'ok', detail: 'wrote notes.md' });
  await appendAction(paths, { tool: 'run_command', kind: 'blocked', detail: 'Blocked by safety policy: rm -rf /' });
  await appendAction(paths, { tool: 'edit_file', kind: 'failed', detail: 'no such file' });

  const recent = await readActions(paths, { limit: 2 });
  assert.deepEqual(recent.map((entry) => entry.tool), ['edit_file', 'run_command']);
  assert.equal(recent[1].kind, 'blocked');
  assert.ok(recent[1].detail.includes('Blocked by safety policy'));
  assert.ok(typeof recent[0].at === 'string' && recent[0].at.includes('T'));
  const all = await readActions(paths);
  assert.equal(all.length, 3);
});

test('a missing log reads as an empty trail, and a corrupt line is skipped', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readActions(paths), []);
  await appendAction(paths, { tool: 'write_file', kind: 'ok', detail: 'first' });
  await fsPromises.appendFile(actionLogFile(paths), 'not json at all\n');
  await appendAction(paths, { tool: 'write_file', kind: 'ok', detail: 'second' });
  const recent = await readActions(paths);
  assert.deepEqual(recent.map((entry) => entry.detail), ['second', 'first']);
});

test('the log is private to the user', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await appendAction(paths, { tool: 'write_file', kind: 'ok', detail: 'secret path' });
  const mode = (await fsPromises.stat(actionLogFile(paths))).mode & 0o777;
  assert.equal(mode.toString(8), '600');
});

test('appendAction drops entries that would be noise or invention', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  assert.equal(await appendAction(paths, { kind: 'ok', detail: 'no tool' }), null);
  assert.equal(await appendAction(paths, { tool: 'write_file', kind: 'maybe' }), null);
  assert.equal(await appendAction(paths, { tool: '', kind: 'ok' }), null);
  assert.deepEqual(await readActions(paths), []);
  const entry = await appendAction(paths, { tool: 'write_file', kind: 'ok', detail: 'x'.repeat(600) });
  assert.ok(entry.detail.length <= 240, 'details stay readable');
});

test('isTrailTool covers durable changes only', () => {
  assert.equal(isTrailTool('write_file'), true);
  assert.equal(isTrailTool('edit_file'), true);
  assert.equal(isTrailTool('manage_notes'), true);
  assert.equal(isTrailTool('read_file'), false);
  assert.equal(isTrailTool('run_command'), false, 'an exit code is data, not a durable change');
  assert.equal(isTrailTool('search_web'), false);
});

function scriptedChat(script, seen) {
  let call = 0;
  return async ({ messages }) => {
    seen.push(messages.map((m) => String(m.content ?? '')));
    const next = script[Math.min(call, script.length - 1)];
    call += 1;
    return next;
  };
}

async function runTurn(userMessage, script, tmpRoot, paths) {
  const session = { id: `trail-${Math.random().toString(36).slice(2)}`, title: 'Trail', messages: [] };
  await runAgentTurn({
    session,
    userMessage,
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    cwd: tmpRoot,
    chatFn: scriptedChat(script, []),
  });
  return session;
}

test('a blocked command leaves a receipt naming the policy', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await runTurn('clean up the disk', [
    { content: '', toolCalls: [{ id: 'c1', name: 'run_command', arguments: { command: 'rm -rf /' } }] },
    { content: 'The command was blocked by the safety policy.', toolCalls: [] },
  ], root, paths);

  const trail = await readActions(paths);
  const blocked = trail.find((entry) => entry.kind === 'blocked');
  assert.ok(blocked, 'the refusal is on the record');
  assert.equal(blocked.tool, 'run_command');
  assert.ok(blocked.detail.includes('safety policy'));
});

test('a write is recorded and a read is not', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await runTurn('write and read', [
    { content: '', toolCalls: [
      { id: 'w1', name: 'write_file', arguments: { path: 'notes.md', content: 'hi' } },
      { id: 'r1', name: 'read_file', arguments: { path: 'notes.md' } },
    ] },
    { content: 'Wrote notes.md and read it back.', toolCalls: [] },
  ], root, paths);

  const trail = await readActions(paths);
  assert.deepEqual(trail.map((entry) => entry.tool), ['write_file']);
  assert.equal(trail[0].kind, 'ok');
});

test('the briefing carries the recent trail, bounded', () => {
  const actions = Array.from({ length: 7 }, (_, index) => ({
    at: `2026-01-0${(index % 9) + 1}T10:00:00.000Z`,
    tool: 'write_file',
    kind: 'ok',
    detail: `file ${index}`,
  }));
  const briefing = summarizeBriefing({ metrics: null, scheduleEntries: [], now: new Date('2026-01-01T10:00:00Z'), recentActions: actions });
  assert.equal(briefing.recent_actions.length, 5);
  assert.deepEqual(briefing.recent_actions[0], { at: actions[0].at, tool: 'write_file', kind: 'ok', detail: 'file 0' });
  const empty = summarizeBriefing({ metrics: null, scheduleEntries: [], now: new Date('2026-01-01T10:00:00Z') });
  assert.deepEqual(empty.recent_actions, []);
});