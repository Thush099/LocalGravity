import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notificationsDue, runAgendaTick } from '../backend/agenda-notifier.mjs';
import { saveSchedule } from '../backend/schedule.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

// Monday 2026-01-05, 08:56 local time.
const mondayMorning = new Date(2026, 0, 5, 8, 56);
const recurringEntry = {
  id: 'ev-1',
  title: 'Deep work',
  time: '09:00',
  days: [1],
  date: null,
  durationMin: 60,
  enabled: true,
};

test('notificationsDue fires for entries starting inside the lead window', () => {
  const due = notificationsDue([recurringEntry], mondayMorning, { leadMinutes: 5 });
  assert.equal(due.length, 1);
  assert.equal(due[0].minutesUntil, 4);
  assert.equal(due[0].key, '2026-01-05-ev-1-09:00');

  // Already started entries never notify.
  assert.equal(notificationsDue([recurringEntry], new Date(2026, 0, 5, 9, 30), { leadMinutes: 5 }).length, 0);
  // Entries outside the lead window wait.
  assert.equal(notificationsDue([recurringEntry], new Date(2026, 0, 5, 8, 30), { leadMinutes: 5 }).length, 0);
  // Disabled entries are skipped.
  assert.equal(
    notificationsDue([{ ...recurringEntry, enabled: false }], mondayMorning, { leadMinutes: 5 }).length,
    0
  );
});

test('notificationsDue skips entries already announced and honors one-off dates', () => {
  const notified = { '2026-01-05-ev-1-09:00': mondayMorning.toISOString() };
  assert.equal(notificationsDue([recurringEntry], mondayMorning, { leadMinutes: 5, notified }).length, 0);

  const oneOff = {
    id: 'ev-2',
    title: 'Dentist',
    time: '09:00',
    days: [],
    date: '2026-01-05',
    durationMin: 30,
    enabled: true,
  };
  assert.equal(notificationsDue([oneOff], mondayMorning, { leadMinutes: 5 }).length, 1);
  // The one-off does not fire on other days.
  assert.equal(notificationsDue([oneOff], new Date(2026, 0, 6, 8, 56), { leadMinutes: 5 }).length, 0);
});

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-agenda-'));
  // Use the production paths shape (state root is `root`) so the notifier
  // and the runtime layout can never drift apart unnoticed.
  process.env.LOCALGRAVITY_HOME = dir;
  return getRuntimePaths();
}

test('runAgendaTick announces once and dedupes across ticks', async () => {
  const paths = tempPaths();
  await saveSchedule([recurringEntry], paths);
  const messages = [];
  const notify = async (n) => messages.push(n.message);

  const first = await runAgendaTick({ paths, now: mondayMorning, notify });
  assert.equal(first.length, 1);
  assert.deepEqual(messages, ['Deep work starts in 4 min']);

  const second = await runAgendaTick({ paths, now: mondayMorning, notify });
  assert.equal(second.length, 0);
  assert.equal(messages.length, 1);

  // A failed notification is retried on the next tick.
  await saveSchedule([{ ...recurringEntry, id: 'ev-3', time: '09:01' }], paths);
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('notification service down');
  };
  const retryNow = new Date(2026, 0, 5, 8, 57);
  assert.equal((await runAgendaTick({ paths, now: retryNow, notify: flaky })).length, 0);
  assert.equal((await runAgendaTick({ paths, now: retryNow, notify: flaky })).length, 1);
  assert.equal(calls, 2);
});

test('runAgendaTick honors agenda settings from the app config', async () => {
  // Disabled: a due entry stays silent.
  const off = tempPaths();
  await saveSchedule([recurringEntry], off);
  fs.writeFileSync(
    off.configFile,
    JSON.stringify({ agendaNotifications: false, agendaLeadMinutes: 5 })
  );
  const messages = [];
  assert.equal(
    (await runAgendaTick({ paths: off, now: mondayMorning, notify: async (n) => messages.push(n) })).length,
    0
  );
  assert.equal(messages.length, 0);

  // Longer lead: an entry 20 minutes out fires when the lead is 30.
  const wide = tempPaths();
  await saveSchedule([recurringEntry], wide);
  fs.writeFileSync(
    wide.configFile,
    JSON.stringify({ agendaNotifications: true, agendaLeadMinutes: 30 })
  );
  const fired = await runAgendaTick({
    paths: wide,
    now: new Date(2026, 0, 5, 8, 40),
    notify: async () => {},
  });
  assert.equal(fired.length, 1);
});
