import crypto from 'node:crypto';
import { atomicWriteJson, readJsonSafe } from './state/storage.mjs';
import { getRuntimePaths } from './state/paths.mjs';

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate and normalize a schedule entry from untrusted input.
 * Returns { ok, entry } or { ok: false, error }.
 */
export function normalizeScheduleEntry(raw, existing = null) {
  const title = String(raw?.title ?? '').trim();
  if (!title) return { ok: false, error: 'Entry needs a title.' };
  if (title.length > 120) return { ok: false, error: 'Title must be 120 characters or fewer.' };

  const time = String(raw?.time ?? '').trim();
  if (!TIME_RE.test(time)) return { ok: false, error: 'Time must be in HH:MM 24-hour format.' };

  let days = raw?.days;
  let date = raw?.date;
  date = date === undefined || date === null || date === '' ? null : String(date).trim();
  if (date !== null && !DATE_RE.test(date)) {
    return { ok: false, error: 'Date must be in YYYY-MM-DD format.' };
  }
  if (date !== null && Number.isNaN(new Date(`${date}T00:00:00`).getTime())) {
    return { ok: false, error: 'Date must be a real calendar date.' };
  }
  if (date !== null) {
    // One-off entries land on a single date instead of repeating weekdays.
    days = [];
  } else {
    if (days === undefined || days === null) days = [0, 1, 2, 3, 4, 5, 6];
  }
  if (!Array.isArray(days)) {
    return { ok: false, error: 'Days must list at least one weekday (0=Sun..6=Sat).' };
  }
  const cleanDays = [...new Set(days.map((d) => Number(d)))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
  if (date === null && cleanDays.length === 0) {
    return { ok: false, error: 'Days must list at least one weekday (0=Sun..6=Sat).' };
  }

  const durationMin = Math.floor(Number(raw?.durationMin ?? 30));
  if (!Number.isFinite(durationMin) || durationMin < 5 || durationMin > 24 * 60) {
    return { ok: false, error: 'Duration must be between 5 minutes and 24 hours.' };
  }

  const now = new Date().toISOString();
  return {
    ok: true,
    entry: {
      id: existing?.id || String(raw?.id || '').trim() || `ev-${crypto.randomUUID().slice(0, 8)}`,
      title,
      notes: String(raw?.notes ?? '').trim().slice(0, 500),
      time,
      days: cleanDays,
      date,
      durationMin,
      enabled: raw?.enabled === undefined ? (existing?.enabled ?? true) : Boolean(raw.enabled),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    },
  };
}

function minutesSinceMidnight(time) {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
}

/**
 * Entries that repeat on the given date's weekday or land on that exact date,
 * sorted by start time.
 */
export function entriesForDate(entries, date = new Date()) {
  const weekday = date.getDay();
  const isoDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return (Array.isArray(entries) ? entries : [])
    .filter(
      (e) =>
        e &&
        e.enabled !== false &&
        (e.date === isoDate || (!e.date && Array.isArray(e.days) && e.days.includes(weekday)))
    )
    .slice()
    .sort((a, b) => minutesSinceMidnight(a.time) - minutesSinceMidnight(b.time))
    .map((e) => ({ ...e, startMinutes: minutesSinceMidnight(e.time) }));
}

/**
 * The entry currently in progress at the given moment, or null.
 */
export function activeEntryAt(entries, now = new Date()) {
  const today = entriesForDate(entries, now);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return (
    today.find(
      (e) =>
        currentMinutes >= e.startMinutes &&
        currentMinutes < e.startMinutes + (e.durationMin || 0)
    ) || null
  );
}

export async function loadSchedule(paths = getRuntimePaths()) {
  const data = await readJsonSafe(paths.scheduleFile, []);
  return Array.isArray(data) ? data : [];
}

export async function saveSchedule(entries, paths = getRuntimePaths()) {
  if (!Array.isArray(entries)) throw new Error('Schedule must be an array');
  await atomicWriteJson(paths.scheduleFile, entries, 0o600);
  return entries;
}

export async function upsertScheduleEntry(raw, paths = getRuntimePaths()) {
  const list = await loadSchedule(paths);
  const existingId = String(raw?.id ?? '').trim();
  const existing = existingId ? list.find((e) => e.id === existingId) : null;
  const normalized = normalizeScheduleEntry(raw, existing);
  if (!normalized.ok) return normalized;
  const idx = list.findIndex((e) => e.id === normalized.entry.id);
  if (idx !== -1) list[idx] = normalized.entry;
  else list.push(normalized.entry);
  await saveSchedule(list, paths);
  return { ok: true, entry: normalized.entry, entries: list };
}

export async function deleteScheduleEntry(id, paths = getRuntimePaths()) {
  const safeId = String(id ?? '').trim();
  if (!SAFE_ID_RE.test(safeId)) return { ok: false, error: 'Invalid entry id.' };
  const list = await loadSchedule(paths);
  const filtered = list.filter((e) => e.id !== safeId);
  if (filtered.length === list.length) return { ok: false, error: 'Entry not found.' };
  await saveSchedule(filtered, paths);
  return { ok: true, deleted: safeId, entries: filtered };
}
