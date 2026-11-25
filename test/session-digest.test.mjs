import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digestFromSession, priorSessionNote } from '../backend/agent/session-digest.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';
import { saveSession } from '../backend/state/storage.mjs';
import { persistGoalState } from '../backend/agent/goal-continuity.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

process.env.LOCALGRAVITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-digest-'));

const NOW = new Date('2026-01-02T09:00:00Z');
function prior(overrides = {}) {
  return {
    id: 'prior-1',
    title: 'Fix the build',
    updatedAt: '2026-01-01T18:30:00.000Z',
    messages: [
      { role: 'user', content: 'why is the build red?', createdAt: '2026-01-01T18:00:00.000Z' },
      { role: 'assistant', content: 'The icon asset is missing from the bundle.', createdAt: '2026-01-01T18:01:00.000Z' },
      { role: 'user', content: 'ok, add it and rerun', createdAt: '2026-01-01T18:20:00.000Z' },
      { role: 'assistant', content: 'Added AppIcon.icns and the CI job now installs ImageMagick.', createdAt: '2026-01-01T18:30:00.000Z' },
    ],
    ...overrides,
  };
}

test('a fresh session carries the last exchange, verbatim', () => {
  const note = digestFromSession(prior(), { now: NOW });
  assert.match(note, /Where We Left Off/);
  assert.match(note, /Fix the build/);
  assert.match(note, /Added AppIcon\.icns and the CI job now installs ImageMagick\./);
  assert.match(note, /ok, add it and rerun/, 'the user message that prompted it comes along');
  assert.match(note, /yesterday|earlier today/, 'the age is stated in plain words');
  assert.match(note, /otherwise ignore this note/, 'the note never hijacks an unrelated message');
});

test('the recent past is quoted, not summarized, and is bounded', () => {
  const long = prior({
    messages: [
      { role: 'user', content: 'u'.repeat(400) },
      { role: 'assistant', content: `start ${'a'.repeat(900)} TAILMARK` },
    ],
  });
  const note = digestFromSession(long, { now: NOW });
  assert.ok(note.length <= 700, `bounded, got ${note.length}`);
  assert.ok(note.includes('…'), 'clipping is visible');
  assert.ok(!note.includes('TAILMARK'), 'the tail is cut rather than compressed into a summary');
});

test('nothing is carried when there is nothing honest to carry', () => {
  assert.equal(digestFromSession(null, { now: NOW }), '');
  assert.equal(digestFromSession(prior(), { now: NOW, excludeSessionId: 'prior-1' }), '', 'never its own session');
  assert.equal(
    digestFromSession(prior({ updatedAt: '2025-12-01T10:00:00.000Z' }), { now: NOW }),
    '',
    'a week-old conversation is not continuity',
  );
  assert.equal(
    digestFromSession(prior({ messages: [{ role: 'assistant', content: '> Error: provider unreachable' }] }), { now: NOW }),
    '',
    'an error banner is not a conversation',
  );
  assert.equal(
    digestFromSession(prior({ messages: [{ role: 'assistant', content: '' }] }), { now: NOW }),
    '',
    'an empty answer is not a conversation',
  );
});

async function tmpPaths() {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-digest-case-'));
  return { root, paths: getRuntimePaths(root) };
}

test('the still-open plan travels with the quote, so both tell one story', () => {
  const goals = [
    {
      sessionId: 'prior-1',
      updatedAt: '2026-01-01T18:29:00.000Z',
      steps: [
        { text: 'Stop the build from failing', status: 'done' },
        { text: 'Teach CI to install ImageMagick', status: 'pending' },
        { text: 'Add AppIcon.icns to the bundle', status: 'done', unverified: true },
      ],
    },
  ];
  const note = digestFromSession(prior(), { now: NOW, goals });
  assert.match(note, /Your published plan still owes 1 step/);
  assert.match(note, /1 unverified/);
  assert.match(note, /next: "Teach CI to install ImageMagick"/);
  assert.match(note, /Added AppIcon\.icns/, 'the quote is still there');
});

test('a finished plan adds no line, and another session plan never leaks in', () => {
  const finished = [{ sessionId: 'prior-1', steps: [{ text: 'Ship it', status: 'done' }] }];
  assert.ok(!digestFromSession(prior(), { now: NOW, goals: finished }).includes('published plan'));
  const someoneElse = [{ sessionId: 'other', steps: [{ text: 'Ship it', status: 'pending' }] }];
  assert.ok(!digestFromSession(prior(), { now: NOW, goals: someoneElse }).includes('published plan'));
});

test('the newest usable session wins', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await saveSession(prior({ id: 'older', updatedAt: new Date(Date.now() - 3 * 864e5).toISOString() }), paths);
  await saveSession(
    prior({
      id: 'newer',
      title: 'Deploy notes',
      updatedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      messages: [
        { role: 'user', content: 'where are the deploy notes?' },
        { role: 'assistant', content: 'In docs/deploy.md, section two.' },
      ],
    }),
    paths,
  );
  const note = await priorSessionNote({ paths });
  assert.match(note, /Deploy notes/);
  assert.match(note, /docs\/deploy\.md/);
});

function scriptedChat(seen) {
  let call = 0;
  return async ({ messages }) => {
    seen.push(messages);
    call += 1;
    return call === 1
      ? { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'docs/deploy.md' } }] }
      : { content: 'Here it is.', toolCalls: [] };
  };
}

test('a brand-new session is told where the last one stopped, once', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await saveSession(
    prior({
      id: 'prior-live',
      updatedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      messages: [
        { role: 'user', content: 'rename the CLI flag' },
        { role: 'assistant', content: 'Renamed it to --headless and updated the docs.' },
      ],
    }),
    paths,
  );

  // The plan the previous session published, still owing a step.
  await persistGoalState(
    [
      { text: 'Rename the CLI flag to --headless', status: 'done' },
      { text: 'Update the docs for the new flag', status: 'pending' },
    ],
    { paths, sessionId: 'prior-live', now: new Date(Date.now() - 3600 * 1000).toISOString() },
  );
  const session = { id: 'fresh-live', title: 'New', messages: [] };
  const seen = [];
  await runAgentTurn({
    session,
    userMessage: 'carry on',
    paths,
    cwd: root,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    chatFn: scriptedChat(seen),
  });
  const firstPrompt = JSON.stringify(seen[0]);
  assert.match(firstPrompt, /Where We Left Off/);
  assert.match(firstPrompt, /Renamed it to --headless and updated the docs\./);
  assert.match(firstPrompt, /published plan still owes 1 step/);
  assert.match(firstPrompt, /Update the docs for the new flag/);

  const secondSeen = [];
  await runAgentTurn({
    session,
    userMessage: 'and now?',
    paths,
    cwd: root,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    chatFn: scriptedChat(secondSeen),
  });
  assert.ok(
    !secondSeen.some((messages) => JSON.stringify(messages).includes('Where We Left Off')),
    'continuity is a first-turn note, not a standing preamble',
  );
});