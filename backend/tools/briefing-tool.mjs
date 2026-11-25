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
 * Grounded follow-up suggestions: each flagged area maps to one concrete, safe
 * next action the agent can *offer* the user (never auto-run). A suggestion only
 * exists alongside its flag, so every suggestion traces back to an observed
 * threshold crossing — the grounding rule is preserved.
 */
export const SUGGESTED_ACTIONS = {
  cpu: { tool: 'system_stats', action: 'inspect the top CPU processes' },
  memory: { tool: 'system_stats', action: 'inspect memory-heavy processes' },
  battery: { tool: null, action: 'plug in the Mac' },
  storage: { tool: 'large_files', action: 'find large files to free up space' },
  schedule: { tool: 'list_schedule_items', action: "review today's timetable" },
};

export function suggestFor(area) {
  return SUGGESTED_ACTIONS[area] ?? null;
}

/**
 * Derive grounded attention flags from observed metric values only.
 * Returns [] when nothing crosses a threshold — never fabricates a task.
 */
export function deriveAttention(metrics, now = new Date()) {
  const flags = [];
  const push = (area, detail) => flags.push({ area, level: 'warn', detail, suggest: suggestFor(area) });
  const cpu = metrics?.cpu?.percent;
  if (typeof cpu === 'number' && cpu >= CPU_HIGH_PERCENT) {
    push('cpu', `CPU is at ${cpu}%.`);
  }
  const mem = metrics?.memory?.usedPercent;
  if (typeof mem === 'number' && mem >= MEMORY_HIGH_PERCENT) {
    push('memory', `Memory is ${mem}% full.`);
  }
  const batt = metrics?.battery;
  if (batt && typeof batt.percent === 'number' && batt.percent <= BATTERY_LOW_PERCENT && batt.state === 'discharging') {
    push('battery', `Battery is at ${batt.percent}% and discharging.`);
  }
  for (const d of metrics?.disks ?? []) {
    if (typeof d.usedPercent === 'number' && d.usedPercent >= DISK_HIGH_PERCENT) {
      push('storage', `Storage ${d.mount} is ${d.usedPercent}% full.`);
    }
  }
  return flags;
}

/**
 * Pure briefing composer. Accepts injected metrics + schedule entries so it is
 * deterministic and testable; the async tool wrapper fills these from the live
 * system. Returns a grounded, JSON-serializable report.
 */
export function summarizeBriefing({ metrics = null, scheduleEntries = [], now = new Date(), focus = '' } = {}) {
  const attention = deriveAttention(metrics, now);

  const todays = entriesForDate(Array.isArray(scheduleEntries) ? scheduleEntries : [], now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  // entriesForDate already sorts by real start time and carries startMinutes;
  // string comparisons would misread unpadded times like '9:00'.
  const upcoming = todays.filter((e) => e.startMinutes >= nowMinutes);

  let next = null;
  if (upcoming.length > 0) {
    next = { title: upcoming[0].title, time: upcoming[0].time };
    const inMinutes = upcoming[0].startMinutes - nowMinutes;
    if (inMinutes >= 0 && inMinutes <= UPCOMING_WINDOW_MINUTES) {
      attention.push({
        area: 'schedule',
        level: 'info',
        detail: `"${upcoming[0].title}" starts in ${inMinutes} minute${inMinutes === 1 ? '' : 's'}.`,
        suggest: suggestFor('schedule'),
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