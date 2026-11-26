/**
 * Reminders that survive the session — and the reboot.
 *
 * `set_reminder` used to schedule a detached `sleep`/`osascript` and forget it. That
 * works while the machine stays awake; a reboot, a logout, or a sleeping laptop
 * silently ate the promise. The notification still fires the way it always did, and
 * now the reminder is also written down, so the briefing can hand it back afterwards:
 * "you asked me to remind you about this, 90 minutes ago".
 *
 * Grounding rule: the text is the user's own, echoed verbatim. The briefing marks a
 * delivered reminder acknowledged, so it is said once and never nags; records older
 * than 30 days are pruned rather than resurrected.
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { getRuntimePaths } from '../state/paths.mjs';

export const REMINDERS_FILE = 'reminders.json';
export const MAX_REMINDERS = 200;
export const REMINDER_RETENTION_DAYS = 30;
export const DUE_LIMIT = 3;
export const UPCOMING_LIMIT = 3;
export const MAX_MESSAGE_CHARS = 400;

export function remindersFile(paths = getRuntimePaths()) {
  return path.join(paths.root, REMINDERS_FILE);
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** All stored reminders, tolerant of a missing or corrupt file (newest last). */
export async function readReminders(paths = getRuntimePaths()) {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(remindersFile(paths), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(raw?.reminders) ? raw.reminders : [];
  return list.filter(
    (entry) =>
      entry &&
      typeof entry.id === 'string' &&
      typeof entry.message === 'string' &&
      Number.isFinite(Date.parse(entry.fireAt || '')),
  );
}

async function writeReminders(paths, reminders) {
  await fs.mkdir(paths.root, { recursive: true });
  const payload = JSON.stringify({ reminders }, null, 2) + '\n';
  await fs.writeFile(remindersFile(paths), payload, { mode: 0o600 });
  await fs.chmod(remindersFile(paths), 0o600).catch(() => {});
}

function prune(reminders, now) {
  const cutoff = now.getTime() - REMINDER_RETENTION_DAYS * 86400000;
  return reminders
    .filter((entry) => Date.parse(entry.fireAt) >= cutoff)
    .slice(-MAX_REMINDERS);
}

/**
 * Persist one reminder. Returns the stored record, or null when the message or the
 * time is not something we can stand behind — a reminder we cannot honour is worse
 * than a refusal.
 */
export async function addReminder(paths, { message, fireAt, pid = null }, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const text = cleanText(message, MAX_MESSAGE_CHARS);
  if (!text) return null;
  if (!Number.isFinite(Date.parse(fireAt || ''))) return null;
  const record = {
    id: crypto.randomUUID(),
    message: text,
    fireAt: new Date(fireAt).toISOString(),
    createdAt: now.toISOString(),
    acknowledgedAt: null,
    cancelledAt: null,
    pid: Number.isFinite(pid) ? pid : null,
  };
  const existing = prune(await readReminders(paths), now);
  await writeReminders(paths, [...existing, record]);
  return record;
}

/**
 * Reminders that are due and not yet delivered, oldest first, bounded. Includes the
 * real overdue time so the report can say how late it is instead of pretending.
 */
export async function dueReminders(paths, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : DUE_LIMIT;
  const all = prune(await readReminders(paths), now);
  return all
    .filter(
      (entry) => !entry.cancelledAt && !entry.acknowledgedAt && Date.parse(entry.fireAt) <= now.getTime(),
    )
    .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt))
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      overdue_minutes: Math.max(0, Math.round((now.getTime() - Date.parse(entry.fireAt)) / 60000)),
    }));
}

/**
 * Reminders still ahead of us, soonest first. This is the answer to "did it stick?" —
 * without it a reminder is invisible until the moment it is already late.
 */
export async function upcomingReminders(paths, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : UPCOMING_LIMIT;
  const all = prune(await readReminders(paths), now);
  return all
    .filter(
      (entry) =>
        !entry.cancelledAt && !entry.acknowledgedAt && Date.parse(entry.fireAt) > now.getTime(),
    )
    .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt))
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      minutes_until: Math.max(1, Math.round((Date.parse(entry.fireAt) - now.getTime()) / 60000)),
    }));
}

/**
 * Cancel a reminder the user has changed their mind about: stop the detached notification
 * if it is still alive, and retire the record so the briefing stops reporting it. Matching
 * by id is exact; matching by text takes the soonest match so the choice is predictable.
 */
export async function cancelReminder(paths, { id = '', message = '' } = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const killFn = options.killFn ?? ((pid) => process.kill(pid, 'SIGTERM'));
  const all = prune(await readReminders(paths), now);
  const wantedId = String(id ?? '').trim();
  const wantedText = cleanText(message, MAX_MESSAGE_CHARS).toLowerCase();
  if (!wantedId && !wantedText) return null;
  const open = all
    .filter((entry) => !entry.cancelledAt && !entry.acknowledgedAt)
    .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt));
  const match = wantedId
    ? open.find((entry) => entry.id === wantedId)
    : open.find((entry) => entry.message.toLowerCase().includes(wantedText));
  if (!match) return null;
  if (Number.isFinite(match.pid)) {
    try {
      killFn(match.pid);
    } catch {
      // The scheduled process may already have fired or the machine may have restarted;
      // retiring the record is what actually stops it from being reported.
    }
  }
  const cancelled = { ...match, cancelledAt: now.toISOString() };
  await writeReminders(
    paths,
    all.map((entry) => (entry.id === match.id ? cancelled : entry)),
  );
  return cancelled;
}

/** Mark delivered reminders as acknowledged, so the briefing says each one once. */
export async function acknowledgeReminders(paths, ids = []) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (wanted.size === 0) return [];
  const now = new Date().toISOString();
  const all = await readReminders(paths);
  let changed = 0;
  const next = all.map((entry) => {
    if (!wanted.has(entry.id) || entry.acknowledgedAt) return entry;
    changed += 1;
    return { ...entry, acknowledgedAt: now };
  });
  if (changed > 0) await writeReminders(paths, next);
  return next.filter((entry) => wanted.has(entry.id));
}