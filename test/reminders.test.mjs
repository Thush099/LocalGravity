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
  upcomingReminders,
  cancelReminder,
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

test('pending reminders are visible before they are late', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await addReminder(paths, { message: 'stretch', fireAt: at(60) }, { now: NOW });
  await addReminder(paths, { message: 'stand up', fireAt: at(180) }, { now: NOW });
  await addReminder(paths, { message: 'already due', fireAt: at(-5) }, { now: NOW });
  const soon = await upcomingReminders(paths, { now: NOW });
  assert.deepEqual(soon.map((r) => r.message), ['stretch', 'stand up']);
  assert.equal(soon[0].minutes_until, 60);
  const bounded = await upcomingReminders(paths, { now: NOW, limit: 1 });
  assert.equal(bounded.length, 1, 'bounded, not dumped');
});

test('cancelling a reminder stops the pending notification and retires the record', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await addReminder(paths, { message: 'stretch', fireAt: at(60), pid: 4242 }, { now: NOW });
  const killed = [];
  const cancelled = await cancelReminder(
    paths,
    { message: 'STRETCH' },
    { now: NOW, killFn: (pid) => killed.push(pid) },
  );
  assert.equal(cancelled.pid, 4242);
  assert.deepEqual(killed, [4242], 'the scheduled notification is actually stopped');
  assert.deepEqual(await upcomingReminders(paths, { now: NOW }), []);
  assert.equal((await readReminders(paths))[0].cancelledAt, NOW.toISOString());
  assert.equal(await cancelReminder(paths, { message: 'nothing like it' }, { now: NOW }), null);
  assert.equal(await cancelReminder(paths, {}, { now: NOW }), null, 'it must be told which one');
});

test('a dead scheduled process does not stop the reminder being retired', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await addReminder(paths, { message: 'stretch', fireAt: at(60), pid: 999 }, { now: NOW });
  const cancelled = await cancelReminder(
    paths,
    { message: 'stretch' },
    {
      now: NOW,
      killFn: () => {
        throw new Error('ESRCH');
      },
    },
  );
  assert.ok(cancelled.cancelledAt);
  assert.deepEqual(await upcomingReminders(paths, { now: NOW }), []);
});

test('the briefing shows what is coming, not only what is late', async (t) => {
  const { root, paths } = await tmpPaths();
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await addReminder(paths, { message: 'stand up', fireAt: new Date(Date.now() + 45 * 60000).toISOString() });
  const report = await briefingTool({ include_system: false, include_schedule: false, paths });
  assert.equal(report.upcoming_reminders.count, 1);
  assert.equal(report.upcoming_reminders.items[0].message, 'stand up');
  assert.equal(report.upcoming_reminders.items[0].minutes_until, 45);
  assert.equal(report.attention.filter((flag) => flag.area === 'reminder').length, 0, 'a future reminder is not an alarm');
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