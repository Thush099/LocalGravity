import fs from 'node:fs';
import path from 'node:path';
import { entriesForDate, loadSchedule } from './schedule.mjs';

export const DEFAULT_LEAD_MINUTES = 5;
const NOTIFIED_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

function notifiedFile(paths) {
  return path.join(paths.stateDir, 'agenda-notified.json');
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Entries starting within the lead window that have not been announced yet.
 * Pure: callers supply the current time and the already-announced key map.
 */
export function notificationsDue(entries, now, { leadMinutes = DEFAULT_LEAD_MINUTES, notified = {} } = {}) {
  const dateKey = localDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const due = [];
  for (const entry of entriesForDate(entries, now)) {
    const startsIn = entry.startMinutes - nowMinutes;
    if (startsIn < 0 || startsIn > leadMinutes) continue;
    const key = `${dateKey}-${entry.id}-${entry.time}`;
    if (notified[key]) continue;
    due.push({ key, entry, minutesUntil: startsIn });
  }
  return due;
}

function loadNotified(paths) {
  try {
    const raw = JSON.parse(fs.readFileSync(notifiedFile(paths), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveNotified(paths, notified, now) {
  const cutoff = now.getTime() - NOTIFIED_RETENTION_MS;
  const pruned = {};
  for (const [key, at] of Object.entries(notified)) {
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= cutoff) pruned[key] = at;
  }
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(notifiedFile(paths), JSON.stringify(pruned, null, 2));
}

function announcementFor(entry, minutesUntil) {
  if (minutesUntil <= 0) return `${entry.title} starts now`;
  return `${entry.title} starts in ${minutesUntil} min`;
}

/**
 * One notification pass: announce due entries, record them, persist the map.
 * `notify` receives ({ title, message }) and may be async.
 */
export async function runAgendaTick({ paths, now = new Date(), leadMinutes = DEFAULT_LEAD_MINUTES, notify }) {
  const entries = await loadSchedule(paths);
  const notified = loadNotified(paths);
  const due = notificationsDue(entries, now, { leadMinutes, notified });
  const fired = [];
  for (const item of due) {
    try {
      await notify({ title: 'LocalGravity agenda', message: announcementFor(item.entry, item.minutesUntil) });
      notified[item.key] = now.toISOString();
      fired.push(item.key);
    } catch {
      // A failed notification should retry on the next tick, so leave the key unset.
    }
  }
  if (due.length > 0) saveNotified(paths, notified, now);
  return fired;
}

/**
 * Start the periodic notifier. Returns a stop function.
 * Main-app only: tests drive runAgendaTick directly.
 */
export function startAgendaNotifier({ paths, notify, leadMinutes = DEFAULT_LEAD_MINUTES, intervalMs = 60 * 1000 }) {
  const tick = () => runAgendaTick({ paths, leadMinutes, notify }).catch(() => {});
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
