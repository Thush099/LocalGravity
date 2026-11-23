import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatClockTime,
  formatClockDate,
  greetingFor,
  usageTone,
  formatUptime,
  nextEntryFrom,
  formatMinutesUntil,
  isStorageLow,
  metricsPollDelay,
} from '../ui/lib/dashboard.js';

test('formatClockTime renders zero-padded 24-hour time', () => {
  // Hours and minutes only; the dashboard clock drops the ticking seconds.
  assert.equal(formatClockTime(new Date(2024, 0, 1, 9, 5, 3)), '09:05');
  assert.equal(formatClockTime(new Date(2024, 0, 1, 23, 59, 59)), '23:59');
});

test('formatClockDate names the weekday and month', () => {
  const label = formatClockDate(new Date(2024, 0, 3, 12, 0), 'en-US');
  assert.match(label, /Wednesday/);
  assert.match(label, /January/);
});

test('greetingFor tracks the time of day', () => {
  assert.equal(greetingFor(new Date(2024, 0, 1, 3)), 'Good night');
  assert.equal(greetingFor(new Date(2024, 0, 1, 8)), 'Good morning');
  assert.equal(greetingFor(new Date(2024, 0, 1, 14)), 'Good afternoon');
  assert.equal(greetingFor(new Date(2024, 0, 1, 20)), 'Good evening');
});

test('usageTone bands percentages and tolerates garbage', () => {
  assert.equal(usageTone(10), 'ok');
  assert.equal(usageTone(60), 'warn');
  assert.equal(usageTone(85), 'high');
  assert.equal(usageTone(100), 'high');
  assert.equal(usageTone('nope'), 'ok');
  assert.equal(usageTone(undefined), 'ok');
});

test('formatUptime renders days, hours, and minutes', () => {
  assert.equal(formatUptime(90), '1m');
  assert.equal(formatUptime(3600 + 120), '1h 2m');
  assert.equal(formatUptime(86400 * 2 + 3600 * 3), '2d 3h');
  assert.equal(formatUptime(-5), '0m');
});

test('nextEntryFrom finds the in-progress or upcoming entry', () => {
  const entries = [
    { id: 'a', startMinutes: 8 * 60, durationMin: 60 },
    { id: 'b', startMinutes: 14 * 60, durationMin: 30 },
    { id: 'c', startMinutes: 19 * 60, durationMin: 60 },
  ];
  const morning = new Date(2024, 0, 3, 8, 30);
  const active = nextEntryFrom(entries, morning);
  assert.equal(active.entry.id, 'a');
  assert.equal(active.inProgress, true);

  const midday = new Date(2024, 0, 3, 12, 0);
  const upcoming = nextEntryFrom(entries, midday);
  assert.equal(upcoming.entry.id, 'b');
  assert.equal(upcoming.minutesUntil, 120);
  assert.equal(upcoming.inProgress, false);

  assert.equal(nextEntryFrom(entries, new Date(2024, 0, 3, 23, 0)), null);
  assert.equal(nextEntryFrom([], morning), null);
});

test('formatMinutesUntil reads naturally', () => {
  assert.equal(formatMinutesUntil(0, true), 'now');
  assert.equal(formatMinutesUntil(5), 'in 5 min');
  assert.equal(formatMinutesUntil(60), 'in 1h');
  assert.equal(formatMinutesUntil(125), 'in 2h 5m');
});

test('isStorageLow fires on low free space or a near-full volume', () => {
  const GB = 1024 ** 3;
  // Low free space (the 22.6 GB-free case) → warn
  assert.equal(isStorageLow({ availableBytes: 22.6 * GB, usedPercent: 75 }), true);
  // Near-full volume → warn
  assert.equal(isStorageLow({ availableBytes: 200 * GB, usedPercent: 92 }), true);
  // Healthy → no warning
  assert.equal(isStorageLow({ availableBytes: 400 * GB, usedPercent: 60 }), false);
  // Missing disk → no warning
  assert.equal(isStorageLow(null), false);
  assert.equal(isStorageLow(undefined), false);
});

test('metricsPollDelay eases off when backgrounded or hidden', () => {
  // Focused + visible → live
  assert.equal(metricsPollDelay({ focused: true, visible: true }), 4000);
  // Backgrounded but visible → ease off
  assert.equal(metricsPollDelay({ focused: false, visible: true }), 12000);
  // Hidden → stay fresh but very slow
  assert.equal(metricsPollDelay({ focused: true, visible: false }), 30000);
  assert.equal(metricsPollDelay({ focused: false, visible: false }), 30000);
  // Default is the live case
  assert.equal(metricsPollDelay(), 4000);
});
