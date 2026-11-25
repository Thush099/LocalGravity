import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  suggestActions, buildSuggestions, filterDismissed, dismissSuggestion, loadDismissed,
} from '../backend/smart-assist.mjs';

test('storage pressure drives urgency', () => {
  const urgent = suggestActions({ storageFreePercent: 6 });
  assert.equal(urgent[0].id, 'free-space');
  assert.equal(urgent[0].tone, 'urgent');
  assert.ok(urgent[0].action);

  const warn = suggestActions({ storageFreePercent: 18 });
  assert.equal(warn[0].id, 'tidy-storage');
  assert.equal(warn[0].tone, 'warn');

  // Healthy storage produces no storage suggestion.
  const healthy = suggestActions({ storageFreePercent: 60 });
  assert.ok(!healthy.some((s) => s.id === 'free-space' || s.id === 'tidy-storage'));
});

test('cluttered Downloads invites an organise action', () => {
  const s = suggestActions({ downloadsCount: 24 });
  const org = s.find((x) => x.id === 'organize-downloads');
  assert.ok(org);
  assert.match(org.action, /Organize/i);
  // A tidy folder should not nag.
  assert.ok(!suggestActions({ downloadsCount: 3 }).some((x) => x.id === 'organize-downloads'));
});

test('inbox size picks digest vs glance', () => {
  const big = suggestActions({ emailCount: 12 }).find((x) => x.id === 'summarize-inbox');
  assert.ok(big);
  assert.equal(big.kind, 'action');

  const small = suggestActions({ emailCount: 3 }).find((x) => x.id === 'inbox-glance');
  assert.ok(small);
  assert.equal(small.kind, 'insight');

  assert.ok(!suggestActions({ emailCount: 0 }).some((x) => x.id === 'inbox-glance' || x.id === 'summarize-inbox'));
});

test('time of day frames the nudge', () => {
  assert.ok(suggestActions({ hourOfDay: 8 }).some((x) => x.id === 'daily-brief'));
  assert.ok(suggestActions({ hourOfDay: 20 }).some((x) => x.id === 'wrap-up'));
  assert.ok(!suggestActions({ hourOfDay: 15 }).some((x) => x.id === 'daily-brief' || x.id === 'wrap-up'));
});

test('suggestions are prioritised and honour missing fields', () => {
  const mixed = suggestActions({ storageFreePercent: 8, emailCount: 10, hourOfDay: 8, downloadsCount: 30 });
  for (let i = 1; i < mixed.length; i += 1) {
    assert.ok(mixed[i - 1].priority >= mixed[i].priority, 'sorted by priority');
  }
  // No inputs → no invented suggestions.
  assert.equal(suggestActions({}).length, 0);
});

test('dismissed suggestions are filtered for a window then return', () => {
  const s = [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }];
  assert.equal(filterDismissed(s, { a: Date.now() }).length, 1);
  // Old dismissal expires.
  assert.equal(filterDismissed(s, { a: Date.now() - 8 * 24 * 60 * 60 * 1000 }).length, 2);
});

test('dismissals persist and buildSuggestions caps + filters', async () => {
  const paths = { root: await fs.mkdtemp(path.join(os.tmpdir(), 'lg-smart-')) };
  await dismissSuggestion(paths, 'organize-downloads');
  const loaded = await loadDismissed(paths);
  assert.ok(loaded['organize-downloads']);

  const state = { downloadsCount: 30, emailCount: 12, hourOfDay: 8, storageFreePercent: 8 };
  const built = buildSuggestions(state, loaded, { limit: 4 });
  assert.ok(built.length <= 4);
  assert.ok(!built.some((s) => s.id === 'organize-downloads'), 'dismissed stays hidden');
  await fs.rm(paths.root, { recursive: true, force: true });
});

test('a single data-hungry app is called out by name', () => {
  const GB = 1024 ** 3;
  const heavy = suggestActions({ topApp: { name: 'Arc', total: 12.4 * GB } });
  const hog = heavy.find((s) => s.id === 'data-hog');
  assert.ok(hog, 'heavy per-app usage produces a data-hog suggestion');
  assert.equal(hog.tone, 'warn');
  assert.match(hog.title, /Arc/);
  assert.match(hog.title, /12 GB/);
  assert.ok(hog.action);

  // Below the threshold the generic monthly insight can stand alone.
  assert.ok(!suggestActions({ topApp: { name: 'Arc', total: 2 * GB } }).some((s) => s.id === 'data-hog'));
  assert.ok(!suggestActions({}).some((s) => s.id === 'data-hog'));
});

