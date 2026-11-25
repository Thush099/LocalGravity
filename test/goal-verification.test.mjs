import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decompositionNudge,
  unverifiedCompletions,
  verificationNudgeMessage,
  unverifiedCompletionNote,
} from '../backend/agent/goal-verification.mjs';
import { goalContinuityNote, persistGoalState, loadOpenGoals } from '../backend/agent/goal-continuity.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';

process.env.LOCALGRAVITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-goal-verify-'));

test('decompositionNudge fires on enumerated multi-step requests while acting without a plan', () => {
  const message = 'Please:\n1. fix the failing CI\n2. write the release notes\n3. tag the release';
  const nudge = decompositionNudge(message, { planPublished: false, mutatingAction: true });
  assert.ok(nudge.includes('update_plan'), 'the nudge points at the plan tool');
  assert.ok(nudge.includes('verifiable'), 'the nudge asks for verifiable steps');
});

test('decompositionNudge fires on sequencing phrases', () => {
  const nudge = decompositionNudge(
    'Clean the cache and then rebuild the app, and after that run the smoke tests.',
    { planPublished: false, mutatingAction: true },
  );
  assert.ok(nudge.length > 0);
});

test('decompositionNudge stays silent when inappropriate', () => {
  // Single, simple request
  assert.equal(decompositionNudge('what is 2+2?', { planPublished: false, mutatingAction: true }), '');
  // Plan already published
  assert.equal(
    decompositionNudge('1. do a\n2. do b', { planPublished: true, mutatingAction: true }),
    '',
  );
  // Only recon so far — give the model room to publish its own plan first
  assert.equal(decompositionNudge('1. do a\n2. do b', { planPublished: false, mutatingAction: false }), '');
  // Empty input
  assert.equal(decompositionNudge('', { planPublished: false, mutatingAction: true }), '');
});

test('unverifiedCompletions flags newly-done steps with no observable action', () => {
  const previous = [{ text: 'Fix the failing test', status: 'active' }];
  const next = [{ text: 'Fix the failing test', status: 'done' }];
  const flagged = unverifiedCompletions(previous, next, []);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].text, 'Fix the failing test');
});

test('unverifiedCompletions accepts steps backed by the turn tool log', () => {
  const previous = [{ text: 'Fix the failing test', status: 'active' }];
  const next = [{ text: 'Fix the failing test', status: 'done' }];
  const tools = [{ name: 'run_command', args: { command: 'npm test' }, ok: true, output: 'all pass' }];
  assert.deepEqual(unverifiedCompletions(previous, next, tools), []);
});

test('unverifiedCompletions ignores steps already done before this update', () => {
  const previous = [{ text: 'Research the options', status: 'done' }, { text: 'Write the summary', status: 'active' }];
  const next = [{ text: 'Research the options', status: 'done' }, { text: 'Write the summary', status: 'done' }];
  const tools = [{ name: 'write_file', args: { path: 'summary.md', content: 'the summary' }, ok: true, output: 'ok' }];
  assert.deepEqual(unverifiedCompletions(previous, next, tools), []);
});

test('unverifiedCompletions accepts e-drop inflections as evidence', () => {
  const previous = [{ text: 'Update the changelog', status: 'active' }];
  const next = [{ text: 'Update the changelog', status: 'done' }];
  // 'updated'/'updating' are 'update' with the silent e dropped; no other
  // step word ('changelog') appears, so only e-drop can satisfy this.
  const tools = [
    { name: 'write_file', args: { path: 'notes.md' }, ok: true, output: 'updated it and updating it again' },
  ];
  assert.deepEqual(unverifiedCompletions(previous, next, tools), []);
});

test('unverifiedCompletions on a first plan flags done steps with no tool backing', () => {
  const next = [
    { text: 'Deploy the staging box', status: 'done' },
    { text: 'Write the release notes', status: 'pending' },
  ];
  const tools = [{ name: 'run_command', args: { command: 'docker build -t app .' }, ok: true, output: 'built' }];
  const flagged = unverifiedCompletions(null, next, tools);
  assert.deepEqual(flagged.map((s) => s.text), ['Deploy the staging box']);
});

test('unverifiedCompletions does not accept a prior plan as evidence — a claim cannot verify itself', () => {
  const previous = [{ text: 'Deploy the staging box', status: 'active' }];
  const next = [{ text: 'Deploy the staging box', status: 'done' }];
  const tools = [
    {
      name: 'update_plan',
      args: { steps: [{ text: 'Deploy the staging box', status: 'active' }] },
      ok: true,
      output: 'Plan updated',
    },
  ];
  const flagged = unverifiedCompletions(previous, next, tools);
  assert.deepEqual(flagged.map((s) => s.text), ['Deploy the staging box']);
});

test('unverifiedCompletions matches words on boundaries — a substring inside an unrelated word is not evidence', () => {
  const previous = [{ text: 'Open the port for the scanner', status: 'active' }];
  const next = [{ text: 'Open the port for the scanner', status: 'done' }];
  // 'port' appears inside 'export'/'important' — a substring collision is
  // not evidence of opening a port.
  const tools = [
    { name: 'run_command', args: { command: 'python export_report.py' }, ok: true, output: 'exported the important totals' },
  ];
  const flagged = unverifiedCompletions(previous, next, tools);
  assert.deepEqual(flagged.map((s) => s.text), ['Open the port for the scanner']);
});

test('unverifiedCompletions still accepts natural suffix variants as evidence', () => {
  const previous = [{ text: 'Refactor the parser module', status: 'active' }];
  const next = [{ text: 'Refactor the parser module', status: 'done' }];
  // 'parsers'/'modules' should still back 'parser'/'module'.
  const tools = [
    { name: 'edit_file', args: { path: 'src/x.js' }, ok: true, output: 'refactored the parsers and modules' },
  ];
  assert.deepEqual(unverifiedCompletions(previous, next, tools), []);
});

test('verificationNudgeMessage names the exact steps and the honest alternative', () => {
  const msg = verificationNudgeMessage([{ text: 'Deploy the staging box', status: 'done' }]);
  assert.ok(msg.includes('Deploy the staging box'));
  assert.ok(msg.includes('without an observable'));
  assert.ok(msg.includes('honestly'));
});

test('unverifiedCompletionNote is empty when nothing is unverified', () => {
  assert.equal(unverifiedCompletionNote([]), '');
});

test('goal records persist unverified markers so later turns see them', async () => {
  const paths = getRuntimePaths();
  await persistGoalState(
    [
      { text: 'Deploy the staging box', status: 'done' },
      { text: 'Write the release notes', status: 'pending' },
    ],
    { paths, sessionId: 'verify-1', unverifiedTexts: ['Deploy the staging box'] },
  );
  const goals = await loadOpenGoals(paths);
  const record = goals.find((g) => g.sessionId === 'verify-1');
  assert.equal(record.steps.find((s) => s.text === 'Deploy the staging box').unverified, true);
  const note = goalContinuityNote(goals, 'continue the plan');
  assert.ok(note.includes('(unverified)'), 'the re-surfaced goal shows the marker');
  assert.ok(note.includes('[x] Deploy the staging box'));
});

test('a fully-done but unverified plan keeps its record until the claims are backed', async () => {
  const paths = getRuntimePaths();
  // Every step is marked done, but nothing was verified — the record must
  // survive so later turns can still see the unverified markers.
  await persistGoalState(
    [
      { text: 'Rotate the API token', status: 'done' },
      { text: 'Update the deployment secrets', status: 'done' },
    ],
    { paths, sessionId: 'verify-all-done', unverifiedTexts: ['Rotate the API token', 'Update the deployment secrets'] },
  );
  const goals = await loadOpenGoals(paths);
  const record = goals.find((g) => g.sessionId === 'verify-all-done');
  assert.ok(record, 'an all-done but unverified plan is still an open concern');
  assert.ok(record.steps.every((s) => s.unverified === true));

  // Once the same claims are backed (no unverified texts), the record clears.
  await persistGoalState(
    [
      { text: 'Rotate the API token', status: 'done' },
      { text: 'Update the deployment secrets', status: 'done' },
    ],
    { paths, sessionId: 'verify-all-done', unverifiedTexts: [] },
  );
  const after = await loadOpenGoals(paths);
  assert.equal(after.find((g) => g.sessionId === 'verify-all-done'), undefined);
});

test('stale goal records from abandoned sessions are pruned, fresh ones survive', async () => {
  const paths = getRuntimePaths();
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  // Seed one abandoned long-ago goal and one recent one via a write.
  await persistGoalState([{ text: 'Ancient abandoned task', status: 'pending' }], {
    paths,
    sessionId: 'stale-1',
    now: stale,
  });
  await persistGoalState([{ text: 'Recent task', status: 'pending' }], {
    paths,
    sessionId: 'fresh-1',
    now,
  });
  const goals = await loadOpenGoals(paths);
  assert.equal(goals.find((g) => g.sessionId === 'stale-1'), undefined, '45-day-old record is gone');
  assert.ok(goals.find((g) => g.sessionId === 'fresh-1'), 'recent record survives');
});

test('goalContinuityNote surfaces unverified-only goals for continuation questions', async () => {
  const paths = getRuntimePaths();
  await persistGoalState([{ text: 'Enable full-disk backups', status: 'done' }], {
    paths,
    sessionId: 'verify-note',
    unverifiedTexts: ['Enable full-disk backups'],
  });
  const goals = await loadOpenGoals(paths);
  const note = goalContinuityNote(goals, 'where were we?');
  assert.ok(note.includes('Enable full-disk backups'));
  assert.ok(note.includes('(unverified)'), 'the marker is visible in the note');
});

function scriptedChat(script, seenMessages) {
  let call = 0;
  return async ({ messages }) => {
    seenMessages.push(messages.map((m) => String(m.content ?? '')));
    const next = script[Math.min(call, script.length - 1)];
    call += 1;
    return next;
  };
}

test('the loop nudges decomposition once when acting on a compound request without a plan', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-decomp-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const session = { id: 'decomp-loop', title: 'Decomp', messages: [] };

  const result = await runAgentTurn({
    session,
    userMessage: 'Please:\n1. clean the cache\n2. rebuild the app',
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    cwd: tmpRoot,
    chatFn: scriptedChat(
      [
        {
          content: '',
          toolCalls: [
            { id: 'w1', name: 'write_file', arguments: { path: 'cache.txt', content: 'cleaned' } },
          ],
        },
        {
          content: '',
          toolCalls: [
            {
              id: 'p1',
              name: 'update_plan',
              arguments: {
                steps: [
                  { text: 'Clean the cache', status: 'done' },
                  { text: 'Rebuild the app', status: 'active' },
                ],
              },
            },
          ],
        },
        { content: 'Done for now.', toolCalls: [] },
      ],
      seen
    ),
  });

  assert.equal(result.status, 'completed');
  const nudgeHits = seen.filter((msgs) =>
    msgs.some((c) => c.includes('Decompose it into concrete')),
  );
  assert.equal(nudgeHits.length, 1, 'the decomposition nudge fires exactly once');
  assert.ok(
    nudgeHits[0].some((c) => c.includes('1. clean the cache')),
    'the nudge reaches the model in the next round, naming the request context',
  );
});

test('the loop nudges verification for unbacked completions and keeps the marker in the note', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-verify-loop-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const session = { id: 'verify-loop', title: 'Verify', messages: [] };

  const result = await runAgentTurn({
    session,
    userMessage: 'Rotate the API token and update the deployment secrets.',
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    cwd: tmpRoot,
    chatFn: scriptedChat(
      [
        {
          content: '',
          toolCalls: [
            {
              id: 'p1',
              name: 'update_plan',
              arguments: {
                steps: [
                  { text: 'Rotate the API token', status: 'done' },
                  { text: 'Update the deployment secrets', status: 'done' },
                ],
              },
            },
          ],
        },
        { content: 'All done.', toolCalls: [] },
      ],
      seen
    ),
  });

  assert.equal(result.status, 'completed');
  const nudgeHits = seen.filter((msgs) =>
    msgs.some((c) => c.includes('without an observable tool action')),
  );
  assert.equal(nudgeHits.length, 1, 'the verification nudge fires exactly once');
  const final = result.session.messages.at(-1);
  assert.match(final.content, /unverified/);
  assert.match(final.content, /Rotate the API token/);
});

test('a claim backed later in the same turn is not reported unverified at turn end', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-verify-late-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const session = { id: 'verify-late', title: 'Verify late', messages: [] };

  const result = await runAgentTurn({
    session,
    userMessage: 'Rotate the API token.',
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    cwd: tmpRoot,
    chatFn: scriptedChat(
      [
        {
          content: '',
          toolCalls: [
            {
              id: 'p1',
              name: 'update_plan',
              arguments: { steps: [{ text: 'Rotate the API token', status: 'done' }] },
            },
          ],
        },
        {
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'run_command',
              arguments: { command: 'echo token rotated' },
            },
          ],
        },
        { content: 'Token rotated.', toolCalls: [] },
      ],
      seen
    ),
  });

  assert.equal(result.status, 'completed');
  // The nudge at claim time was honest (no evidence yet), but the work landed
  // later in the same turn — the closing note must not call it unverified.
  const final = result.session.messages.at(-1);
  assert.equal(final.content, 'Token rotated.');
  const goals = await loadOpenGoals(paths);
  const record = goals.find((g) => g.sessionId === 'verify-late');
  assert.ok(
    !record || record.steps.every((s) => !s.unverified),
    'the persisted goal record must not carry a stale unverified marker',
  );
});
