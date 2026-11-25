import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  addReminder,
  readReminders,
  dueReminders,
  acknowledgeReminders,
  REMINDERS_FILE,
} from '../backend/tools/reminders.mjs';
import { setReminderTool } from '../backend/tools/macos-tool.mjs';
import { briefingTool } from '../backend/tools/briefing-tool.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

process.env.LOCALGRAVITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-reminders-'));

async function tmpPaths() {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lg-reminders-case-'));
  return { root, paths: getRuntimePaths(root) };
}

const NOW = new Date('2026-01-02T09:00:00Z');
function at(offsetMinutes) {
  return new Date(NOW.getTime() + offsetMinutes * 60000).toISOString();
}

test('a reminder is written down, privately', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const record = await addReminder(paths, { message: 'call the bank', fireAt: at(30) }, { now: NOW });
  assert.equal(record.message, 'call the bank');
  assert.equal(record.fireAt, at(30));
  assert.ok(record.id);
  const stored = await readReminders(paths);
  assert.equal(stored.length, 1);
  const mode = (await fsPromises.stat(path.join(root, REMINDERS_FILE))).mode & 0o777;
  assert.equal(mode, 0o600, 'a reminder is personal: owner-only');
});

test('only the due, unacknowledged reminders are served, oldest first', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await addReminder(paths, { message: 'overdue one', fireAt: at(-120) }, { now: NOW });
  await addReminder(paths, { message: 'overdue two', fireAt: at(-30) }, { now: NOW });
  await addReminder(paths, { message: 'not yet', fireAt: at(45) }, { now: NOW });
  const due = await dueReminders(paths, { now: NOW });
  assert.deepEqual(due.map((r) => r.message), ['overdue one', 'overdue two']);
  assert.equal(due[0].overdue_minutes, 120);
  await acknowledgeReminders(paths, due.map((r) => r.id));
  assert.deepEqual(await dueReminders(paths, { now: NOW }), [], 'a delivered reminder is not repeated');
  const kept = await readReminders(paths);
  assert.equal(kept.length, 3, 'delivery does not erase the record');
});

test('an invalid reminder is refused, and a stale one is pruned', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  assert.equal(await addReminder(paths, { message: '', fireAt: at(10) }, { now: NOW }), null);
  assert.equal(await addReminder(paths, { message: 'x', fireAt: 'nonsense' }, { now: NOW }), null);
  await addReminder(paths, { message: 'ancient', fireAt: new Date(NOW.getTime() - 45 * 864e5).toISOString() }, { now: NOW });
  await addReminder(paths, { message: 'today', fireAt: at(5) }, { now: NOW });
  const kept = await readReminders(paths);
  assert.deepEqual(kept.map((r) => r.message), ['today'], 'a month-old reminder stops being served');
});

test('the briefing delivers a due reminder once, in the user own words', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await addReminder(paths, { message: 'call the bank', fireAt: new Date(Date.now() - 90 * 60000).toISOString() });
  const first = await briefingTool({ include_system: false, include_schedule: false, paths });
  assert.equal(first.due_reminders.count, 1);
  assert.equal(first.due_reminders.items[0].message, 'call the bank');
  assert.match(first.attention.find((flag) => flag.area === 'reminder').detail, /call the bank/);
  const second = await briefingTool({ include_system: false, include_schedule: false, paths });
  assert.equal(second.due_reminders.count, 0, 'a delivered reminder is not repeated');
});

test('setting a reminder writes it down as well as scheduling the notification', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const spawned = [];
  const result = await setReminderTool({
    seconds: 300,
    message: 'stretch',
    paths,
    spawnFn: () => {
      spawned.push(1);
      return { unref() {} };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(spawned.length, 1, 'the live notification still fires');
  const stored = await readReminders(paths);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].message, 'stretch');
  assert.equal(stored[0].fireAt, result.fireAt);
});