import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reminderNotices, dueReminderNotices } from '../backend/agent/reminder-notices.mjs';
import { addReminder, dueReminders } from '../backend/tools/reminders.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';

process.env.LOCALGRAVITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-reminder-notes-'));

async function tmpPaths() {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-reminder-notes-case-'));
  return { root, paths: getRuntimePaths(root) };
}

const NOW = new Date('2026-01-02T09:00:00Z');
function at(offsetMinutes) {
  return new Date(NOW.getTime() + offsetMinutes * 60000).toISOString();
}

test('a due reminder is quoted in the user own words, with the real delay', () => {
  const notes = reminderNotices([{ message: 'call the bank', overdue_minutes: 90 }]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /You asked to be reminded: "call the bank"/);
  assert.match(notes[0], /2h ago/);
  assert.match(notes[0], /never invent a reminder/);
});

test('the notices are bounded, but the backlog is admitted', () => {
  const notes = reminderNotices([
    { message: 'one', overdue_minutes: 5 },
    { message: 'two', overdue_minutes: 10 },
    { message: 'three', overdue_minutes: 15 },
  ]);
  assert.equal(notes.length, 3, 'two quoted plus one honest count');
  assert.ok(!notes.slice(0, 2).some((note) => note.includes('three')));
  assert.match(notes[2], /1 more reminder/);
});

test('only what is quoted is acknowledged, so a backlog drains over turns', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await addReminder(paths, { message: 'first', fireAt: at(-120) }, { now: NOW });
  await addReminder(paths, { message: 'second', fireAt: at(-60) }, { now: NOW });
  await addReminder(paths, { message: 'third', fireAt: at(-30) }, { now: NOW });
  const notes = await dueReminderNotices(paths, { now: NOW });
  assert.equal(notes.length, 3);
  const left = await dueReminders(paths, { now: NOW });
  assert.deepEqual(left.map((entry) => entry.message), ['third'], 'only the quoted ones were delivered');
  const next = await dueReminderNotices(paths, { now: NOW });
  assert.match(next[0], /"third"/, 'the next turn picks up the backlog');
  assert.deepEqual(await dueReminderNotices(paths, { now: NOW }), [], 'then nothing is left to say');
});

test('a due reminder reaches the conversation without being asked for', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await addReminder(paths, { message: 'call the bank', fireAt: new Date(Date.now() - 90 * 60000).toISOString() });
  const session = { id: 'reminder-live', title: 'Chat', messages: [] };
  const seen = [];
  const chatFn = async ({ messages }) => {
    seen.push(messages);
    return { content: 'Your reminder: call the bank.', toolCalls: [] };
  };
  await runAgentTurn({
    session,
    userMessage: 'what is next?',
    paths,
    cwd: root,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    chatFn,
  });
  assert.match(JSON.stringify(seen[0]), /call the bank/);
  const secondSeen = [];
  await runAgentTurn({
    session,
    userMessage: 'thanks',
    paths,
    cwd: root,
    providerConfig: { provider: 'ollama', model: 'test-model', safetyMode: 'auto' },
    persistSession: false,
    chatFn: async ({ messages }) => {
      secondSeen.push(messages);
      return { content: 'Anytime.', toolCalls: [] };
    },
  });
  assert.ok(
    !secondSeen.some((messages) => JSON.stringify(messages).includes('[Reminder]')),
    'a delivered reminder is not repeated',
  );
});