import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  captureStandingPreference,
  matchStandingPreference,
  rememberPreference,
  standingPreferences,
} from '../backend/agent/standing-preferences.mjs';
import { readKnowledge, saveKnowledge } from '../backend/knowledge-engine.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

process.env.LOCALGRAVITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-prefs-'));

test('matchStandingPreference reads durable cues in the user own words', () => {
  assert.equal(
    matchStandingPreference('From now on, use pnpm instead of npm.'),
    'use pnpm instead of npm',
  );
  assert.equal(
    matchStandingPreference('Going forward: run the tests before committing'),
    'run the tests before committing',
  );
  assert.equal(
    matchStandingPreference('please always use tabs for indentation'),
    'use tabs for indentation',
  );
  assert.equal(
    matchStandingPreference('Never force-push to main'),
    'force-push to main',
  );
});

test('matchStandingPreference rejects casual uses of always and never', () => {
  for (const message of [
    'I always forget the password',
    'always the build fails on CI',
    'always I end up rewriting it',
    'do you always use tabs?',
    'never it works the first time',
    'always use tabs?',
  ]) {
    assert.equal(matchStandingPreference(message), null, message);
  }
});

test('matchStandingPreference leaves explicit memory requests and tasks alone', () => {
  // 'remember that …' belongs to the explicit-memory sidecar, not to this one.
  assert.equal(matchStandingPreference('remember that I prefer tabs'), null);
  assert.equal(matchStandingPreference('what is on my schedule today?'), null);
  assert.equal(matchStandingPreference(''), null);
  assert.equal(matchStandingPreference(null), null);
  // A rule must be single-line so it can never smuggle markdown structure in.
  assert.equal(matchStandingPreference('from now on, use pnpm\nand also npm'), null);
  // Bounds keep the injected prompt honest.
  assert.equal(matchStandingPreference('never run'), null);
  assert.equal(matchStandingPreference(`always ${'x'.repeat(220)}`), null);
});

test('rememberPreference stores one bullet under a Standing Preferences heading', async (t) => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-prefs-store-'));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const paths = getRuntimePaths(root);
  await saveKnowledge(
    {
      name: 'MEMORY',
      title: 'User Memory & Preferences',
      tags: ['memory'],
      content: '# Memory\n\nStable preferences live here.\n\n- OS: macOS\n- Shell: zsh\n',
    },
    paths,
  );

  const first = await rememberPreference('use pnpm instead of npm', paths);
  assert.equal(first.appended, true);
  const body = (await readKnowledge('MEMORY', paths)).content;
  assert.ok(body.includes('## Standing Preferences'));
  assert.ok(body.includes('- Preference: use pnpm instead of npm'));
  assert.equal(standingPreferences(body).length, 1);

  // Preferences sit in the curated head, before the ordinary memory bullets.
  const lines = body.split('\n');
  const heading = lines.findIndex((line) => line.trim() === '## Standing Preferences');
  const bullet = lines.findIndex((line) => line.includes('- Preference: use pnpm'));
  const firstPlainBullet = lines.findIndex((line) => line.startsWith('- OS: '));
  assert.ok(heading < bullet && bullet < firstPlainBullet, 'preference precedes older bullets');
});

test('rememberPreference is idempotent and case-insensitive', async (t) => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-prefs-idem-'));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const paths = getRuntimePaths(root);
  await rememberPreference('use pnpm instead of npm', paths);
  await rememberPreference('use pnpm instead of npm', paths);
  const second = await rememberPreference('Use pnpm instead of npm', paths);
  assert.equal(second.appended, false);
  const body = (await readKnowledge('MEMORY', paths)).content;
  assert.equal(body.toLowerCase().split('- preference: use pnpm instead of npm').length - 1, 1);
  // A second, different rule joins the same section.
  await rememberPreference('never force-push to main', paths);
  const grown = (await readKnowledge('MEMORY', paths)).content;
  assert.equal(standingPreferences(grown).length, 2);
  assert.equal(grown.split('## Standing Preferences').length - 1, 1, 'one section, not one per rule');
});

test('captureStandingPreference persists a durable instruction and ignores the rest', async (t) => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-prefs-capture-'));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const paths = getRuntimePaths(root);
  assert.equal(await captureStandingPreference('From now on, use pnpm instead of npm.', paths), 'use pnpm instead of npm');
  assert.equal(await captureStandingPreference('summarise this file', paths), null);
  const body = (await readKnowledge('MEMORY', paths)).content;
  assert.equal(standingPreferences(body).length, 1);
});

test('standingPreferences lists only preference bullets', async (t) => {
  const body = ['# Memory', '', '## Standing Preferences', '- Preference: use pnpm', '- Preference: never force-push', '', '- OS: macOS'].join('\n');
  assert.deepEqual(standingPreferences(body), ['use pnpm', 'never force-push']);
});

test('the loop persists a standing preference and injects it in the same turn', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-prefs-loop-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const session = { id: 'prefs-loop', title: 'Prefs', messages: [] };

  const result = await runAgentTurn({
    session,
    userMessage: 'From now on, use pnpm instead of npm.',
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    cwd: tmpRoot,
    chatFn: async ({ messages }) => {
      seen.push(messages.map((m) => String(m.content ?? '')));
      return { content: 'Noted.', toolCalls: [] };
    },
  });

  assert.equal(result.status, 'completed');
  const body = (await readKnowledge('MEMORY', paths)).content;
  assert.ok(body.includes('- Preference: use pnpm instead of npm'), 'the preference is durable');
  const system = seen.flat().join('\n');
  assert.ok(system.includes('use pnpm instead of npm'), 'the fresh preference reaches this turn');
});