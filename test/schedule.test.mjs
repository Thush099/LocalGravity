import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import {
  normalizeScheduleEntry,
  entriesForDate,
  activeEntryAt,
  loadSchedule,
  upsertScheduleEntry,
  deleteScheduleEntry,
} from '../backend/schedule.mjs';

test('normalizeScheduleEntry validates time, days, and duration', () => {
  const good = normalizeScheduleEntry({ title: 'Standup', time: '09:30', days: [1, 2], durationMin: 15 });
  assert.equal(good.ok, true);
  assert.equal(good.entry.title, 'Standup');
  assert.equal(good.entry.time, '09:30');
  assert.deepEqual(good.entry.days, [1, 2]);
  assert.equal(good.entry.enabled, true);

  assert.equal(normalizeScheduleEntry({ title: '', time: '09:30' }).ok, false);
  assert.equal(normalizeScheduleEntry({ title: 'X', time: '25:00' }).ok, false);
  assert.equal(normalizeScheduleEntry({ title: 'X', time: '9:30' }).ok, false);
  assert.equal(normalizeScheduleEntry({ title: 'X', time: '09:30', days: [] }).ok, false);
  assert.equal(normalizeScheduleEntry({ title: 'X', time: '09:30', days: [9] }).ok, false);
  assert.equal(normalizeScheduleEntry({ title: 'X', time: '09:30', durationMin: 1 }).ok, false);

  const dedupe = normalizeScheduleEntry({ title: 'X', time: '09:30', days: [5, 5, 1] });
  assert.deepEqual(dedupe.entry.days, [1, 5]);
});

test('one-off entries carry a single date and skip weekday rules', () => {
  const oneOff = normalizeScheduleEntry({ title: 'Dentist', time: '15:00', date: '2024-01-03', durationMin: 45 });
  assert.equal(oneOff.ok, true);
  assert.equal(oneOff.entry.date, '2024-01-03');
  assert.deepEqual(oneOff.entry.days, []);

  assert.equal(normalizeScheduleEntry({ title: 'X', time: '15:00', date: '2024-13-99' }).ok, false);
  assert.equal(normalizeScheduleEntry({ title: 'X', time: '15:00', date: '03-01-2024' }).ok, false);
});

test('entriesForDate filters by weekday, sorts by time, and skips disabled entries', () => {
  // 2024-01-03 is a Wednesday (weekday 3).
  const wednesday = new Date(2024, 0, 3, 8, 0);
  const entries = [
    { id: 'late', title: 'Late', time: '18:00', days: [3], durationMin: 30, enabled: true },
    { id: 'early', title: 'Early', time: '08:15', days: [3], durationMin: 60, enabled: true },
    { id: 'other', title: 'Thursday', time: '09:00', days: [4], durationMin: 30, enabled: true },
    { id: 'off', title: 'Disabled', time: '07:00', days: [3], durationMin: 30, enabled: false },
  ];
  const today = entriesForDate(entries, wednesday);
  assert.deepEqual(today.map((e) => e.id), ['early', 'late']);
  assert.equal(today[0].startMinutes, 8 * 60 + 15);
});

test('entriesForDate includes one-off entries on their date only', () => {
  const wednesday = new Date(2024, 0, 3, 8, 0);
  const entries = [
    { id: 'once', title: 'Dentist', time: '15:00', days: [], date: '2024-01-03', durationMin: 45, enabled: true },
    { id: 'other-day', title: 'Later once', time: '10:00', days: [], date: '2024-01-04', durationMin: 30, enabled: true },
    { id: 'weekly', title: 'Gym', time: '07:00', days: [3], durationMin: 30, enabled: true },
  ];
  const today = entriesForDate(entries, wednesday);
  assert.deepEqual(today.map((e) => e.id), ['weekly', 'once']);
});

test('activeEntryAt finds the entry covering the current moment', () => {
  const wednesday = new Date(2024, 0, 3, 9, 0);
  const entries = [
    { id: 'standup', title: 'Standup', time: '08:45', days: [3], durationMin: 30, enabled: true },
    { id: 'later', title: 'Later', time: '14:00', days: [3], durationMin: 30, enabled: true },
  ];
  assert.equal(activeEntryAt(entries, wednesday)?.id, 'standup');
  assert.equal(activeEntryAt(entries, new Date(2024, 0, 3, 10, 0)), null);
});

test('schedule CRUD persists through the app runtime directory', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-schedule-'));
  const paths = getRuntimePaths(home);
  try {
    assert.deepEqual(await loadSchedule(paths), []);

    const created = await upsertScheduleEntry(
      { title: 'Gym', time: '18:00', days: [1, 3, 5], durationMin: 45 },
      paths
    );
    assert.equal(created.ok, true);
    assert.equal(created.entries.length, 1);

    const updated = await upsertScheduleEntry(
      { id: created.entry.id, title: 'Gym + sauna', time: '18:00', days: [1, 3, 5], durationMin: 60 },
      paths
    );
    assert.equal(updated.ok, true);
    assert.equal(updated.entries.length, 1);
    assert.equal(updated.entry.title, 'Gym + sauna');
    assert.equal(updated.entry.durationMin, 60);

    const bad = await upsertScheduleEntry({ title: '', time: '99:99' }, paths);
    assert.equal(bad.ok, false);

    const removed = await deleteScheduleEntry(created.entry.id, paths);
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.entries, []);
    assert.equal((await deleteScheduleEntry(created.entry.id, paths)).ok, false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
