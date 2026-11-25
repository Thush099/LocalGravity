import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  failureNudge,
  mentionsFailure,
  recordActionFailure,
  unreportedFailureNote,
} from '../backend/agent/turn-receipts.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

process.env.LOCALGRAVITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-receipts-'));

test('recordActionFailure keeps only failures that blocked a change', () => {
  const failures = [];
  // A write that failed means the change did not happen.
  recordActionFailure(failures, { name: 'write_file', reason: 'permission denied', kind: 'error' });
  // A non-zero exit is an observation the model must reason about, not a blocked action.
  recordActionFailure(failures, { name: 'run_command', reason: 'exit code 1', kind: 'error' });
  // …but a command the safety gate refused never ran at all.
  recordActionFailure(failures, { name: 'run_command', reason: 'Blocked by safety policy: rm -rf', kind: 'blocked' });
  // Read-only tools change nothing, so their failures are not receipts.
  recordActionFailure(failures, { name: 'read_file', reason: 'no such file', kind: 'error' });
  assert.deepEqual(
    failures.map((failure) => failure.name),
    ['write_file', 'run_command'],
  );
});

test('recordActionFailure keeps a short reason and ignores blanks', () => {
  const failures = [];
  recordActionFailure(failures, { name: 'edit_file', reason: 'x'.repeat(400), kind: 'error' });
  assert.ok(failures[0].reason.length <= 200);
  recordActionFailure(failures, { name: 'edit_file', reason: '   ', kind: 'error' });
  assert.equal(failures.length, 1);
});

test('mentionsFailure spots an honest report and not a bare claim', () => {
  assert.equal(mentionsFailure('Done — updated nope.txt.'), false);
  assert.equal(mentionsFailure('All changes are in place and the tests pass.'), false);
  assert.equal(mentionsFailure('edit_file failed: no such file'), true);
  assert.equal(mentionsFailure("I couldn't write that file."), true);
  assert.equal(mentionsFailure('The write was blocked by the safety policy.'), true);
  assert.equal(mentionsFailure('Nothing was changed because the file does not exist.'), true);
});

test('the nudge names the actions that did not happen', () => {
  const failures = [
    { name: 'write_file', reason: 'permission denied' },
    { name: 'run_command', reason: 'Blocked by safety policy' },
  ];
  const nudge = failureNudge(failures);
  assert.ok(nudge.startsWith('[Self-Correction]'));
  assert.ok(nudge.includes('write_file'));
  assert.ok(nudge.includes('run_command'));
  assert.ok(/do not claim|never claim/i.test(nudge), 'it forbids a false success claim');
  assert.equal(failureNudge([]), '');
});

test('the fallback note is factual, bounded and clearly marked', () => {
  const note = unreportedFailureNote([
    { name: 'write_file', reason: 'permission denied' },
    { name: 'edit_file', reason: 'no such file' },
  ]);
  assert.ok(note.includes('[Unreported failures]'));
  assert.ok(note.includes('write_file'));
  assert.equal(unreportedFailureNote([]), '');
  const many = Array.from({ length: 6 }, (_, index) => ({ name: `t${index}`, reason: 'failed' }));
  const capped = unreportedFailureNote(many);
  assert.ok(capped.includes('and 3 more'), 'the note stays short');
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

async function runTurn(userMessage, script, seen, tmpRoot, paths) {
  const session = { id: `receipt-${Math.random().toString(36).slice(2)}`, title: 'Receipts', messages: [] };
  const result = await runAgentTurn({
    session,
    userMessage,
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    cwd: tmpRoot,
    chatFn: scriptedChat(script, seen),
  });
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant');
  return { result, session, content: String(lastAssistant?.content ?? '') };
}

test('a failed change is nudged once, then reported if the model still overclaims', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-receipts-claim-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const claim = 'Done — updated nope.txt.';
  const { result, content } = await runTurn('update nope.txt', [
    { content: '', toolCalls: [{ id: 'e1', name: 'edit_file', arguments: { path: 'nope.txt', content: 'x' } }] },
    { content: claim, toolCalls: [] },
    { content: claim, toolCalls: [] },
  ], seen, tmpRoot, paths);

  assert.equal(result.status, 'completed');
  const nudges = seen.filter((round) => round.join('\n').includes('[Self-Correction]') && round.join('\n').includes('edit_file'));
  assert.equal(nudges.length, 1, 'exactly one failure nudge');
  assert.ok(content.includes('[Unreported failures]'), 'the user still learns what did not happen');
  assert.ok(content.includes('edit_file'));
});

test('an honest report of the failure needs no fallback note', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-receipts-honest-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const { content } = await runTurn('update nope.txt', [
    { content: '', toolCalls: [{ id: 'e1', name: 'edit_file', arguments: { path: 'nope.txt', content: 'x' } }] },
    { content: 'Done — updated nope.txt.', toolCalls: [] },
    { content: 'edit_file failed: nope.txt does not exist, so nothing changed.', toolCalls: [] },
  ], seen, tmpRoot, paths);

  assert.ok(!content.includes('[Unreported failures]'), 'an honest answer is left alone');
  assert.ok(content.includes('nothing changed'));
});

test('a turn whose changes succeeded carries no receipts at all', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-receipts-clean-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const { content } = await runTurn('write ok.txt', [
    { content: '', toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'ok.txt', content: 'hi' } }] },
    { content: 'Wrote ok.txt.', toolCalls: [] },
  ], seen, tmpRoot, paths);

  assert.equal(fs.existsSync(path.join(tmpRoot, 'ok.txt')), true);
  assert.ok(!seen.some((round) => round.join('\n').includes('[Self-Correction]')), 'no nudge on a clean turn');
  assert.ok(!content.includes('[Unreported failures]'));
  assert.equal(content, 'Wrote ok.txt.');
});