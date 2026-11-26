import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openWorkSummary, summarizeBriefing, briefingTool } from '../backend/tools/briefing-tool.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

process.env.LOCALGRAVITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-openwork-'));

const NOW = new Date('2026-01-02T09:00:00Z');
function goal(sessionId, steps, updatedAt) {
  return { sessionId, updatedAt, steps };
}

test('only plans that still owe something are open work', () => {
  const summary = openWorkSummary(
    [
      goal('a', [{ text: 'Draft the migration', status: 'pending' }, { text: 'Run the tests', status: 'active' }], '2026-01-02T08:00:00.000Z'),
      goal('b', [{ text: 'Ship the docs', status: 'done' }], '2026-01-02T08:30:00.000Z'),
    ],
    { now: NOW },
  );
  assert.equal(summary.count, 1, 'a finished plan is not outstanding work');
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].steps_remaining, 2);
  assert.equal(summary.items[0].next_step, 'Draft the migration');
  assert.equal(summary.items[0].updated_at.slice(0, 10), '2026-01-02');
});

test('a done claim with no evidence behind it still counts as open', () => {
  const summary = openWorkSummary(
    [goal('a', [{ text: 'Delete the stale branches', status: 'done', unverified: true }], '2026-01-02T08:00:00.000Z')],
    { now: NOW },
  );
  assert.equal(summary.count, 1);
  assert.equal(summary.items[0].steps_remaining, 0);
  assert.equal(summary.items[0].unverified, 1);
  assert.equal(summary.items[0].next_step, 'Delete the stale branches');
});

test('the list is bounded but the total is honest', () => {
  const goals = Array.from({ length: 6 }, (_, index) =>
    goal(`s${index}`, [{ text: `step ${index}`, status: 'pending' }], '2026-01-02T08:00:00.000Z'),
  );
  const summary = openWorkSummary(goals, { now: NOW, maxGoals: 3 });
  assert.equal(summary.count, 6);
  assert.equal(summary.items.length, 3);
});

test('the briefing carries open work, and says nothing when there is none', () => {
  const goals = [goal('a', [{ text: 'Draft the migration', status: 'pending' }], '2026-01-02T08:00:00.000Z')];
  const withWork = summarizeBriefing({ metrics: null, scheduleEntries: [], now: NOW, openGoals: goals });
  assert.equal(withWork.open_work.count, 1);
  assert.equal(withWork.open_work.items[0].next_step, 'Draft the migration');
  const clean = summarizeBriefing({ metrics: null, scheduleEntries: [], now: NOW });
  assert.deepEqual(clean.open_work, { count: 0, items: [] });
  assert.deepEqual(clean.attention.filter((flag) => flag.area === 'work'), []);
});

test('a plan untouched for a day is worth mentioning; a fresh one is not', () => {
  const stale = goal('a', [{ text: 'Fix the failing build', status: 'pending' }], '2025-12-30T08:00:00.000Z');
  const fresh = goal('b', [{ text: 'Write the changelog', status: 'pending' }], '2026-01-02T08:30:00.000Z');

  const staleBriefing = summarizeBriefing({ metrics: null, scheduleEntries: [], now: NOW, openGoals: [stale] });
  const workFlags = staleBriefing.attention.filter((flag) => flag.area === 'work');
  assert.equal(workFlags.length, 1);
  assert.ok(workFlags[0].detail.includes('Fix the failing build'), 'the flag cites the real step');
  assert.match(workFlags[0].detail, /1 plan/);

  const freshBriefing = summarizeBriefing({ metrics: null, scheduleEntries: [], now: NOW, openGoals: [fresh] });
  assert.deepEqual(freshBriefing.attention.filter((flag) => flag.area === 'work'), []);
  assert.equal(freshBriefing.open_work.count, 1, 'fresh work is reported, just not nagged about');
});

test('the live briefing reads the real goal store', async (t) => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-openwork-live-'));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const paths = getRuntimePaths(root);
  await fsPromises.writeFile(
    paths.goalsFile,
    `${JSON.stringify({
      goals: [
        goal('a', [{ text: 'Audit the launchd jobs', status: 'pending' }], new Date(Date.now() - 3600 * 1000).toISOString()),
      ],
    })}\n`,
  );
  const briefing = await briefingTool({ include_system: false, include_schedule: false, paths });
  assert.equal(briefing.open_work.count, 1);
  assert.equal(briefing.open_work.items[0].next_step, 'Audit the launchd jobs');
});