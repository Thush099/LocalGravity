import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  captureForget,
  forgetFact,
  forgetNotices,
  matchForgetRequest,
} from '../backend/agent/memory-forget.mjs';
import { readKnowledge, saveKnowledge } from '../backend/knowledge-engine.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

process.env.LOCALGRAVITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-forget-'));

const SEED = [
  '# Memory',
  '',
  'Stable preferences live here.',
  '',
  '- OS: macOS',
  '- Shell: zsh',
  '- The staging box is 10.0.0.5',
  '- Old phone number: 555-0100',
  '- Old phone number: 555-0199',
].join('\n');

async function seededRoot(t, body = SEED) {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-forget-case-'));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const paths = getRuntimePaths(root);
  await saveKnowledge(
    { name: 'MEMORY', title: 'User Memory & Preferences', tags: ['memory'], content: body },
    paths,
  );
  return paths;
}

test('matchForgetRequest reads a forget instruction in the user words', () => {
  assert.equal(matchForgetRequest('forget that the staging box is 10.0.0.5'), 'the staging box is 10.0.0.5');
  assert.equal(matchForgetRequest('Forget about my old phone number.'), 'my old phone number');
  assert.equal(matchForgetRequest('please forget the /tmp scratch rule'), 'the /tmp scratch rule');
});

test('matchForgetRequest never treats a figure of speech as a deletion', () => {
  for (const message of [
    'forget it',
    'forget that',
    'forget this',
    'forget everything',
    'forget what I said?',
    'I forgot the password',
    'forget the staging box\nand the rest',
    'forget it all and move on',
  ]) {
    assert.equal(matchForgetRequest(message), null, message);
  }
});

test('forgetFact removes exactly one matching bullet and keeps the rest', async (t) => {
  const paths = await seededRoot(t);
  const result = await forgetFact('the staging box', paths);
  assert.equal(result.status, 'removed');
  assert.ok(result.removed.includes('10.0.0.5'));
  const body = (await readKnowledge('MEMORY', paths)).content;
  assert.ok(!body.includes('10.0.0.5'), 'the fact is gone');
  assert.ok(body.includes('- OS: macOS'), 'siblings are untouched');
  assert.ok(body.includes('- Shell: zsh'));
});

test('forgetFact refuses to guess when several bullets match', async (t) => {
  const paths = await seededRoot(t);
  const before = (await readKnowledge('MEMORY', paths)).content;
  const result = await forgetFact('old phone number', paths);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  const after = (await readKnowledge('MEMORY', paths)).content;
  assert.equal(after, before, 'nothing is deleted without a unique match');
});

test('forgetFact is a no-op when nothing matches', async (t) => {
  const paths = await seededRoot(t);
  const result = await forgetFact('a fact that was never stored', paths);
  assert.equal(result.status, 'none');
  const body = (await readKnowledge('MEMORY', paths)).content;
  assert.equal(body, SEED);
});

test('forgetFact can drop a standing preference line', async (t) => {
  const seed = ['# Memory', '', '## Standing Preferences', '- Preference: use pnpm instead of npm', '', '- OS: macOS'].join('\n');
  const paths = await seededRoot(t, seed);
  const result = await forgetFact('use pnpm instead of npm', paths);
  assert.equal(result.status, 'removed');
  const body = (await readKnowledge('MEMORY', paths)).content;
  assert.ok(!body.includes('use pnpm instead of npm'));
  assert.ok(body.includes('## Standing Preferences'), 'the section heading stays');
  assert.ok(body.includes('- OS: macOS'));
});

test('forgetNotices report what was removed and what needs a choice', () => {
  const removed = forgetNotices({ status: 'removed', removed: '- The staging box is 10.0.0.5' });
  assert.ok(removed[0].includes('[Memory] Removed from MEMORY.md'));
  assert.ok(removed[0].includes('10.0.0.5'));
  const ambiguous = forgetNotices({ status: 'ambiguous', target: 'old phone number', candidates: ['a', 'b'] });
  assert.ok(ambiguous[0].includes('nothing was removed'));
  assert.ok(ambiguous[0].includes('2'));
  assert.deepEqual(forgetNotices(null), []);
  assert.deepEqual(forgetNotices({ status: 'none' }), []);
});

test('captureForget does nothing for ordinary messages', async (t) => {
  const paths = await seededRoot(t);
  assert.equal(await captureForget('what is on my schedule today?', paths), null);
  assert.equal(await captureForget('forget it', paths), null);
});

test('the loop removes the fact and tells the model it did', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-forget-loop-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  await saveKnowledge(
    { name: 'MEMORY', title: 'User Memory & Preferences', tags: ['memory'], content: SEED },
    paths,
  );
  const seen = [];
  const session = { id: 'forget-loop', title: 'Forget', messages: [] };
  await runAgentTurn({
    session,
    userMessage: 'forget that the staging box is 10.0.0.5',
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    cwd: tmpRoot,
    chatFn: async ({ messages }) => {
      seen.push(messages.map((m) => String(m.content ?? '')));
      return { content: 'Forgotten.', toolCalls: [] };
    },
  });

  const body = (await readKnowledge('MEMORY', paths)).content;
  assert.ok(!body.includes('10.0.0.5'), 'the fact is gone from memory');
  const firstRound = seen[0].join('\n');
  assert.ok(firstRound.includes('[Memory] Removed from MEMORY.md'), 'the model learns what was removed');
  assert.ok(firstRound.includes('10.0.0.5'));
});

test('the loop asks instead of guessing when the request is ambiguous', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-forget-ambig-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  await saveKnowledge(
    { name: 'MEMORY', title: 'User Memory & Preferences', tags: ['memory'], content: SEED },
    paths,
  );
  const seen = [];
  await runAgentTurn({
    session: { id: 'forget-ambig', title: 'Ambiguous', messages: [] },
    userMessage: 'forget my old phone number',
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    cwd: tmpRoot,
    chatFn: async ({ messages }) => {
      seen.push(messages.map((m) => String(m.content ?? '')));
      return { content: 'Which one?', toolCalls: [] };
    },
  });

  const body = (await readKnowledge('MEMORY', paths)).content;
  assert.ok(body.includes('555-0100') && body.includes('555-0199'), 'both entries survive');
  const firstRound = seen[0].join('\n');
  assert.ok(firstRound.includes('nothing was removed'));
});