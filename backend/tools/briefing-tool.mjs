/**
 * Grounded situational briefing for the `briefing` tool — LocalGravity's
 * "briefing, sir" moment. Composes real system metrics and today's schedule into a
 * concise awareness report the agent can surface proactively (on a greeting or a
 * "what's up / how's my day" request).
 *
 * The design rule is grounding: every `attention` flag is derived from an observed
 * value crossing a threshold and cites that value. Nothing is invented, so the
 * agent can hand this to the user without violating the "never invent additional
 * work" contract — it only reports what the machine and schedule actually show.
 */

import { collectSystemMetrics, summarizeSystemMetrics } from '../system-monitor.mjs';
import { entriesForDate, loadSchedule } from '../schedule.mjs';

export const CPU_HIGH_PERCENT = 80;
export const MEMORY_HIGH_PERCENT = 85;
export const BATTERY_LOW_PERCENT = 20;
export const DISK_HIGH_PERCENT = 90;
export const UPCOMING_WINDOW_MINUTES = 60;

/**
 * Derive grounded attention flags from observed metric values only.
 * Returns [] when nothing crosses a threshold — never fabricates a task.
 */
export function deriveAttention(metrics, now = new Date()) {
  const flags = [];
  const cpu = metrics?.cpu?.percent;
  if (typeof cpu === 'number' && cpu >= CPU_HIGH_PERCENT) {
    flags.push({ area: 'cpu', level: 'warn', detail: `CPU is at ${cpu}%.` });
  }
  const mem = metrics?.memory?.usedPercent;
  if (typeof mem === 'number' && mem >= MEMORY_HIGH_PERCENT) {
    flags.push({ area: 'memory', level: 'warn', detail: `Memory is ${mem}% full.` });
  }
  const batt = metrics?.battery;
  if (batt && typeof batt.percent === 'number' && batt.percent <= BATTERY_LOW_PERCENT && batt.state === 'discharging') {
    flags.push({ area: 'battery', level: 'warn', detail: `Battery is at ${batt.percent}% and discharging.` });
  }
  for (const d of metrics?.disks ?? []) {
    if (typeof d.usedPercent === 'number' && d.usedPercent >= DISK_HIGH_PERCENT) {
      flags.push({ area: 'storage', level: 'warn', detail: `Storage ${d.mount} is ${d.usedPercent}% full.` });
    }
  }
  return flags;
}

function hhmm(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Pure briefing composer. Accepts injected metrics + schedule entries so it is
 * deterministic and testable; the async tool wrapper fills these from the live
 * system. Returns a grounded, JSON-serializable report.
 */
export function summarizeBriefing({ metrics = null, scheduleEntries = [], now = new Date(), focus = '' } = {}) {
  const attention = deriveAttention(metrics, now);

  const todays = entriesForDate(Array.isArray(scheduleEntries) ? scheduleEntries : [], now)
    .slice()
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const nowStr = hhmm(now);
  const upcoming = todays.filter((e) => String(e.time) >= nowStr);

  let next = null;
  if (upcoming.length > 0) {
    next = { title: upcoming[0].title, time: upcoming[0].time };
    const [h, m] = String(upcoming[0].time).split(':').map(Number);
    const [nh, nm] = nowStr.split(':').map(Number);
    const inMinutes = (h * 60 + m) - (nh * 60 + nm);
    if (inMinutes >= 0 && inMinutes <= UPCOMING_WINDOW_MINUTES) {
      attention.push({
        area: 'schedule',
        level: 'info',
        detail: `"${upcoming[0].title}" starts in ${inMinutes} minute${inMinutes === 1 ? '' : 's'}.`,
      });
    }
  }

  return {
    generated_at: now.toISOString(),
    system_summary: metrics ? summarizeSystemMetrics(metrics) : 'System metrics unavailable.',
    schedule: {
      total_today: todays.length,
      items: todays.map((e) => ({ title: e.title, time: e.time })),
      next,
    },
    attention,
    focus: focus ? String(focus) : null,
  };
}

/**
 * Live briefing: collects real metrics + schedule, then composes them.
 * Collection failures degrade to a neutral report rather than throwing.
 */
export async function briefingTool({ focus = '', include_system = true, include_schedule = true } = {}) {
  const [metrics, scheduleEntries] = await Promise.all([
    include_system ? collectSystemMetrics().catch(() => null) : null,
    include_schedule ? loadSchedule().catch(() => []) : [],
  ]);
  return summarizeBriefing({
    metrics,
    scheduleEntries: Array.isArray(scheduleEntries) ? scheduleEntries : [],
    now: new Date(),
    focus: typeof focus === 'string' ? focus : '',
  });
}