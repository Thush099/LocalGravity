/**
 * Pure helpers for the Dashboard, Monitor, and Timetable views.
 * No DOM access here so every helper stays unit-testable.
 */

export function formatClockTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  // Hours and minutes only — a ticking second hand is visual noise on a dashboard.
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatClockDate(date = new Date(), locale = undefined) {
  return date.toLocaleDateString(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export function greetingFor(date = new Date()) {
  const h = date.getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Usage tone for a 0..100 percentage: green, amber, or red band.
 */
export function usageTone(percent) {
  const p = Number(percent);
  if (!Number.isFinite(p)) return 'ok';
  if (p >= 85) return 'high';
  if (p >= 60) return 'warn';
  return 'ok';
}

/**
 * Should the low-storage warning fire? A modest free-space floor OR a
 * near-full volume both count as "low" — enough to prompt cleanup early.
 */
export function isStorageLow(disk = null, { minFreeBytes = 25 * 1024 ** 3, maxUsedPercent = 90 } = {}) {
  if (!disk) return false;
  const freeBytes = Number(disk.availableBytes ?? 0);
  const usedPercent = Number(disk.usedPercent ?? 0);
  return freeBytes < minFreeBytes || usedPercent >= maxUsedPercent;
}

export function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * From today's sorted entries (with startMinutes), return the one in progress
 * or the next one coming up: { entry, minutesUntil, inProgress } | null.
 */
export function nextEntryFrom(todayEntries, now = new Date()) {
  const entries = Array.isArray(todayEntries) ? todayEntries : [];
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  for (const entry of entries) {
    const start = Number(entry.startMinutes) || 0;
    const end = start + (Number(entry.durationMin) || 0);
    if (currentMinutes < start) {
      return { entry, minutesUntil: start - currentMinutes, inProgress: false };
    }
    if (currentMinutes < end) {
      return { entry, minutesUntil: 0, inProgress: true };
    }
  }
  return null;
}

export function formatMinutesUntil(minutesUntil, inProgress = false) {
  if (inProgress) return 'now';
  const m = Math.max(0, Math.floor(Number(minutesUntil) || 0));
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `in ${h}h ${rest}m` : `in ${h}h`;
}
