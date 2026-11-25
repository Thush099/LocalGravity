import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  goalMatchesQuery,
  goalContinuityNote,
  persistGoalState,
  loadOpenGoals,
} from '../backend/agent/goal-continuity.mjs';
import { buildSystemPrompt } from '../backend/agent/prompt.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

process.env.LOCALGRAVITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-goals-'));

const openGoal = {
  sessionId: 's-1',
  updatedAt: '2026-11-24T10:00:00.000Z',
  steps: [
    { text: 'Audit the CI configuration', status: 'done' },
    { text: 'Deploy the staging box with the new image', status: 'pending' },
  ],
};

test('goalContinuityNote surfaces open goals for continuation phrasing', () => {
  const note = goalContinuityNote([openGoal], 'where were we?');
  assert.ok(note.includes('## Open Goals'), 'the note must be clearly labeled');
  assert.ok(note.includes('[x] Audit the CI configuration'), 'done steps show as done');
  assert.ok(note.includes('[ ] Deploy the staging box with the new image'), 'open steps show as open');
});

test('goalContinuityNote surfaces open goals for questions about the work', () => {
  const note = goalContinuityNote([openGoal], 'what is happening with the staging deploy?');
  assert.ok(note.includes('Deploy the staging box'), 'word overlap with the goal steps is enough');
});

test('goalContinuityNote keeps its guidance line under truncation', () => {
  const steps = Array.from({ length: 8 }, (_, i) => ({
    text: `Refactor module number ${i + 1} with a fairly long description of the work involved`,
    status: 'pending',
  }));
  const note = goalContinuityNote([{ sessionId: 's', steps }], 'continue the plan', { maxChars: 300 });
  assert.ok(note.length <= 300);
  assert.ok(
    note.includes('answer what was actually asked'),
    'the truncation must never drop the guidance that keeps the note from hijacking ordinary turns',
  );
  assert.ok(!note.includes('involv'), 'truncation drops whole steps, never cuts mid-word');
});

test('goalContinuityNote stays silent on unrelated turns', () => {
  assert.equal(goalContinuityNote([openGoal], 'what is the weather in Colombo?'), '');
  assert.equal(goalContinuityNote([openGoal], 'summarize this paragraph: ...'), '');
});

test('goalContinuityNote ignores fully completed and empty goals', () => {
  const done = { sessionId: 's-2', steps: [{ text: 'Ship it', status: 'done' }] };
  assert.equal(goalContinuityNote([done], 'continue the plan'), '');
  assert.equal(goalContinuityNote([], 'continue the plan'), '');
  assert.equal(goalContinuityNote(null, 'continue the plan'), '');
});

test('goalMatchesQuery only fires on plausible links', () => {
  const steps = [{ text: 'Refactor the ingestion pipeline', status: 'pending' }];
  assert.equal(goalMatchesQuery(steps, "let's continue"), true);
  assert.equal(goalMatchesQuery(steps, 'what is left?'), true);
  assert.equal(goalMatchesQuery(steps, 'how is the ingestion pipeline doing?'), true);
  assert.equal(goalMatchesQuery(steps, 'book a table for two'), false);
  // Word-boundary matching: 'board' inside 'dashboard' is not a real link.
  assert.equal(goalMatchesQuery([{ text: 'Redesign the dashboard layout', status: 'pending' }], 'board the ship tonight'), false);
  assert.equal(goalMatchesQuery([], 'continue'), false);
});

test('persistGoalState and loadOpenGoals round-trip open goals per session', async () => {
  const paths = getRuntimePaths();
  const plan = [
    { text: 'Audit the CI configuration', status: 'done' },
    { text: 'Deploy the staging box', status: 'pending' },
  ];
  await persistGoalState(plan, { paths, sessionId: 's-1', now: '2026-11-24T10:00:00.000Z' });
  let goals = await loadOpenGoals(paths);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].sessionId, 's-1');
  assert.equal(goals[0].steps.length, 2);

  // A second session keeps its own goal alongside the first.
  await persistGoalState([{ text: 'Write the release notes', status: 'active' }], {
    paths,
    sessionId: 's-2',
    now: '2026-11-24T11:00:00.000Z',
  });
  goals = await loadOpenGoals(paths);
  assert.deepEqual(goals.map((g) => g.sessionId).sort(), ['s-1', 's-2']);

  // Re-publishing in the same session replaces, never duplicates.
  await persistGoalState([{ text: 'Deploy the staging box', status: 'active' }], {
    paths,
    sessionId: 's-1',
  });
  goals = await loadOpenGoals(paths);
  assert.equal(goals.filter((g) => g.sessionId === 's-1').length, 1);

  // Finishing every step clears the record.
  await persistGoalState([{ text: 'Deploy the staging box', status: 'done' }], {
    paths,
    sessionId: 's-1',
  });
  goals = await loadOpenGoals(paths);
  assert.deepEqual(goals.map((g) => g.sessionId), ['s-2']);
});

test('a missing or corrupt goals file simply means no goals', async () => {
  const paths = getRuntimePaths();
  await fs.promises.rm(paths.goalsFile, { force: true });
  assert.deepEqual(await loadOpenGoals(paths), []);
  await fs.promises.mkdir(paths.root, { recursive: true });
  await fs.promises.writeFile(paths.goalsFile, '{not json');
  assert.deepEqual(await loadOpenGoals(paths), []);
});

test('buildSystemPrompt carries the goal-continuity note', () => {
  const note = goalContinuityNote([openGoal], 'continue the plan');
  const prompt = buildSystemPrompt({ goalContext: note, hasTools: false });
  assert.ok(prompt.includes('## Open Goals'));
  assert.ok(prompt.includes('Deploy the staging box'));
  const without = buildSystemPrompt({ hasTools: false });
  assert.ok(!without.includes('## Open Goals'), 'no open goals means no section at all');
});
