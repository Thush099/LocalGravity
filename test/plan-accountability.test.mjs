import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  unfinishedPlanSteps,
  planNudgeMessage,
  planCompletionNote,
} from '../backend/agent/plan-accountability.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

test('unfinishedPlanSteps returns only non-done steps; notes are empty without them', () => {
  const plan = [
    { text: 'Design the schema', status: 'done', index: 0 },
    { text: 'Write the migration', status: 'active', index: 1 },
    { text: 'Ship it', status: 'pending', index: 2 },
    { text: '', status: 'pending', index: 3 },
  ];
  const unfinished = unfinishedPlanSteps(plan);
  assert.deepEqual(unfinished.map((s) => s.text), ['Write the migration', 'Ship it']);
  assert.deepEqual(unfinishedPlanSteps(null), []);
  assert.deepEqual(unfinishedPlanSteps([]), []);
  assert.equal(planCompletionNote([]), '');
});

test('nudge and note name the exact unfinished steps', () => {
  const steps = [{ text: 'Write the migration', status: 'active' }, { text: 'Ship it', status: 'pending' }];
  const nudge = planNudgeMessage(steps);
  assert.match(nudge, /\[Self-Correction\]/);
  assert.match(nudge, /Write the migration \(in progress\)/);
  assert.match(nudge, /- Ship it/);
  const note = planCompletionNote(steps);
  assert.match(note, /\[Plan\] Still unfinished/);
  assert.match(note, /Ship it/);
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

test('a turn with a published plan gets one nudge, then an honest note — never a silent "all done"', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-plan-nudge-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const session = { id: 'plan-nudge', title: 'Plan nudge', messages: [] };

  const result = await runAgentTurn({
    session,
    userMessage: 'Refactor the module and update its docs.',
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
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
                  { text: 'Refactor the module', status: 'done' },
                  { text: 'Update its docs', status: 'pending' },
                ],
              },
            },
          ],
        },
        { content: 'All done!', toolCalls: [] },
        { content: 'Wrapping up.', toolCalls: [] },
      ],
      seen
    ),
  });

  assert.equal(result.status, 'completed');
  assert.equal(seen.length, 3, 'exactly one nudge round-trip (never ping-pongs)');

  // The third model call saw the self-correction nudge naming the exact step.
  assert.ok(seen[2].some((c) => c.includes('[Self-Correction] Your published plan still has unfinished steps')));
  assert.ok(seen[2].some((c) => c.includes('Update its docs')));

  // The final answer carries the honest note; completed steps stay out of it.
  const final = result.session.messages.at(-1);
  assert.match(final.content, /Wrapping up\./);
  assert.match(final.content, /\[Plan\] Still unfinished/);
  assert.match(final.content, /Update its docs/);
  assert.doesNotMatch(final.content, /Refactor the module/);
});

test('a plan finished before the final answer ends clean — no nudge, no note', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-plan-done-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const session = { id: 'plan-done', title: 'Plan done', messages: [] };

  const result = await runAgentTurn({
    session,
    userMessage: 'Refactor the module and update its docs.',
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
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
                  { text: 'Refactor the module', status: 'active' },
                  { text: 'Update its docs', status: 'pending' },
                ],
              },
            },
          ],
        },
        {
          content: '',
          toolCalls: [
            {
              id: 'p2',
              name: 'update_plan',
              arguments: {
                steps: [
                  { text: 'Refactor the module', status: 'done' },
                  { text: 'Update its docs', status: 'done' },
                ],
              },
            },
          ],
        },
        { content: 'Everything is complete.', toolCalls: [] },
      ],
      seen
    ),
  });

  assert.equal(result.status, 'completed');
  assert.equal(seen.length, 3, 'no nudge round-trip was needed');
  assert.ok(seen.every((msgs) => !msgs.some((c) => c.includes('[Self-Correction] Your published plan'))));
  const final = result.session.messages.at(-1);
  assert.equal(final.content, 'Everything is complete.');
});