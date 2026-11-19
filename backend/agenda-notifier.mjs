import path from 'node:path';
import { entriesForDate, loadSchedule } from './schedule.mjs';
import { atomicWriteJson, loadConfig, readJsonSafe } from './state/storage.mjs';

export const DEFAULT_LEAD_MINUTES = 5;
const NOTIFIED_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

function notifiedFile(paths) {
  // getRuntimePaths() calls the state root `root`; tolerate `stateDir` too.
  return path.join(paths.root || paths.stateDir, 'agenda-notified.json');
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

async function loadNotified(paths) {
  const raw = await readJsonSafe(notifiedFile(paths), {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

async function saveNotified(paths, notified, now) {
  const cutoff = now.getTime() - NOTIFIED_RETENTION_MS;
  const pruned = {};
  for (const [key, at] of Object.entries(notified)) {
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= cutoff) pruned[key] = at;
  }
  await atomicWriteJson(notifiedFile(paths), pruned, 0o600);
}

function announcementFor(entry, minutesUntil) {
  if (minutesUntil <= 0) return `${entry.title} starts now`;
  return `${entry.title} starts in ${minutesUntil} min`;
}

function clampLead(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(30, n) : DEFAULT_LEAD_MINUTES;
}

/**
 * One notification pass: announce due entries, record them, persist the map.
 * `notify` receives ({ title, message }) and may be async.
 * Settings resolve from the app config (agendaNotifications, agendaLeadMinutes)
 * unless the caller passes leadMinutes explicitly.
 */
export async function runAgendaTick({ paths, now = new Date(), leadMinutes, notify }) {
  const config = await loadConfig(paths).catch(() => ({}));
  if (config.agendaNotifications === false) return [];
  const lead = clampLead(leadMinutes ?? config.agendaLeadMinutes);
  const entries = await loadSchedule(paths);
  const notified = await loadNotified(paths);
  const due = notificationsDue(entries, now, { leadMinutes: lead, notified });
  const fired = [];
  for (const item of due) {
    try {
      const result = await notify({ title: 'LocalGravity agenda', message: announcementFor(item.entry, item.minutesUntil) });
      if (result?.ok === false) continue;
      notified[item.key] = now.toISOString();
      fired.push(item.key);
    } catch {
      // A failed notification should retry on the next tick, so leave the key unset.
    }
  }
  if (due.length > 0) await saveNotified(paths, notified, now);
  return fired;
}

/**
 * Start the periodic notifier. Returns a stop function.
 * Main-app only: tests drive runAgendaTick directly.
 */
export function startAgendaNotifier({ paths, notify, leadMinutes, intervalMs = 60 * 1000 }) {
  const tick = () => runAgendaTick({ paths, leadMinutes, notify }).catch(() => {});
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
