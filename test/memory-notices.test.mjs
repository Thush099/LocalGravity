import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { memoryCaptureNotices } from '../backend/agent/memory-notices.mjs';
import { readKnowledge } from '../backend/knowledge-engine.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

process.env.LOCALGRAVITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-notices-'));

test('memoryCaptureNotices stays silent when nothing was stored', () => {
  assert.deepEqual(memoryCaptureNotices(), []);
  assert.deepEqual(memoryCaptureNotices({ fact: null, rule: null }), []);
});

test('memoryCaptureNotices hands the stored text back verbatim', () => {
  const [fact] = memoryCaptureNotices({ fact: 'the staging box is 10.0.0.5' });
  assert.ok(fact.includes('the staging box is 10.0.0.5'));
  assert.ok(fact.startsWith('[Memory]'), 'the note is marked as a memory write');
  const [rule] = memoryCaptureNotices({ rule: 'use pnpm instead of npm' });
  assert.ok(rule.includes('use pnpm instead of npm'));
  assert.ok(rule.includes('every later turn'), 'a rule is described as standing, not one-off');
  assert.equal(memoryCaptureNotices({ fact: 'a fact', rule: 'a rule' }).length, 2);
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

test('the loop tells the model what an explicit memory capture stored', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-notice-fact-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const session = { id: 'notice-fact', title: 'Fact', messages: [] };

  const result = await runAgentTurn({
    session,
    userMessage: 'remember that the staging box is 10.0.0.5',
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    cwd: tmpRoot,
    chatFn: scriptedChat([{ content: 'Noted.', toolCalls: [] }], seen),
  });

  assert.equal(result.status, 'completed');
  const body = (await readKnowledge('MEMORY', paths)).content;
  assert.ok(body.includes('the staging box is 10.0.0.5'), 'the fact is durable');
  const firstRound = seen[0].join('\n');
  assert.ok(firstRound.includes('[Memory] Saved to MEMORY.md'), 'the model learns the save happened');
  assert.ok(firstRound.includes('the staging box is 10.0.0.5'));
  assert.ok(
    session.messages.every((m) => !m.isSelfCorrection),
    'the notice is turn-local and never persisted into the transcript',
  );
});

test('the loop tells the model when a standing preference was stored', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-notice-rule-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const session = { id: 'notice-rule', title: 'Rule', messages: [] };

  await runAgentTurn({
    session,
    userMessage: 'From now on, use pnpm instead of npm.',
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    cwd: tmpRoot,
    chatFn: scriptedChat([{ content: 'Noted.', toolCalls: [] }], seen),
  });

  const firstRound = seen[0].join('\n');
  assert.ok(firstRound.includes('Standing preference saved'), 'the rule save is announced');
  assert.ok(firstRound.includes('use pnpm instead of npm'));
  assert.ok(!firstRound.includes('Saved to MEMORY.md'), 'a rule is not reported as a plain fact');
});

test('the loop leaves ordinary turns free of memory notices', async (t) => {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-notice-none-'));
  t.after(() => fsPromises.rm(tmpRoot, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpRoot);
  const seen = [];
  const session = { id: 'notice-none', title: 'None', messages: [] };

  await runAgentTurn({
    session,
    userMessage: 'what is 2 + 2?',
    paths,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    cwd: tmpRoot,
    chatFn: scriptedChat([{ content: '4', toolCalls: [] }], seen),
  });

  assert.ok(!seen[0].join('\n').includes('[Memory]'), 'no notice when nothing was captured');
});