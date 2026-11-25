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
import { readActions } from '../agent/action-log.mjs';
import { loadOpenGoals } from '../agent/goal-continuity.mjs';
import { dueReminders, acknowledgeReminders } from './reminders.mjs';

export const CPU_HIGH_PERCENT = 80;
export const MEMORY_HIGH_PERCENT = 85;
export const BATTERY_LOW_PERCENT = 20;
export const DISK_HIGH_PERCENT = 90;
export const UPCOMING_WINDOW_MINUTES = 60;
/** A plan untouched this long is worth raising; a fresh one is not. */
export const STALE_WORK_HOURS = 24;
export const MAX_OPEN_WORK_ITEMS = 3;

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

/** Pure: a goal that still owes the user something — unfinished steps, or done
 * claims nothing ever backed. The record holds only steps the model itself
 * published, so this can report outstanding work but never invent it. */
function openParts(goal) {
  const steps = Array.isArray(goal?.steps) ? goal.steps.filter(Boolean) : [];
  return {
    unfinished: steps.filter((step) => step.status !== 'done'),
    unverified: steps.filter((step) => step.status === 'done' && step.unverified === true),
  };
}

/**
 * Pure: what the agent still owes the user across sessions, bounded and
 * grounded — a count of the real open plans, plus the next step of the first
 * few. No titles, no summaries: the step text is the model's own words.
 */
export function openWorkSummary(goals = [], { maxGoals = MAX_OPEN_WORK_ITEMS } = {}) {
  const open = (Array.isArray(goals) ? goals : [])
    .filter((goal) => goal && Array.isArray(goal.steps))
    .map((goal) => ({ goal, ...openParts(goal) }))
    .filter((entry) => entry.unfinished.length > 0 || entry.unverified.length > 0);
  const items = open.slice(0, Math.max(1, maxGoals)).map(({ goal, unfinished, unverified }) => ({
    updated_at: String(goal.updatedAt || ''),
    steps_remaining: unfinished.length,
    unverified: unverified.length,
    next_step: String((unfinished[0] ?? unverified[0])?.text || ''),
  }));
  return { count: open.length, items };
}

/**
 * Pure briefing composer. Accepts injected metrics + schedule entries so it is
 * deterministic and testable; the async tool wrapper fills these from the live
 * system. Returns a grounded, JSON-serializable report.
 */
export function summarizeBriefing({
  metrics = null,
  scheduleEntries = [],
  now = new Date(),
  focus = '',
  recentActions = [],
  openGoals = [],
  dueReminderEntries = [],
} = {}) {
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

  const openWork = openWorkSummary(openGoals, { now });
  const staleWork = openWork.items
    .filter((item) => {
      const at = Date.parse(item.updated_at || '');
      return Number.isFinite(at) && now.getTime() - at > STALE_WORK_HOURS * 60 * 60 * 1000;
    })
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
  if (staleWork.length > 0) {
    const oldest = staleWork[0];
    const count = staleWork.length;
    attention.push({
      area: 'work',
      level: 'info',
      detail: `${count} plan${count === 1 ? '' : 's'} from an earlier session ${count === 1 ? 'is' : 'are'} still open — next step: "${oldest.next_step.slice(0, 120)}".`,
      suggest: suggestFor('work'),
    });
  }

  // Reminders the user asked for and the machine owes them: the user's own words,
  // with the real overdue time. Said once — the tool acknowledges what it delivers.
  const dueRemindersOut = (Array.isArray(dueReminderEntries) ? dueReminderEntries : [])
    .slice(0, 3)
    .map((entry) => ({
      message: String(entry?.message ?? ''),
      fire_at: String(entry?.fireAt ?? ''),
      overdue_minutes: Number.isFinite(entry?.overdue_minutes) ? entry.overdue_minutes : 0,
    }));
  if (dueRemindersOut.length > 0) {
    const first = dueRemindersOut[0];
    const late = first.overdue_minutes;
    const lateText = late >= 60 ? `${Math.floor(late / 60)}h` : `${late} min`;
    const more = dueRemindersOut.length > 1 ? ` (${dueRemindersOut.length - 1} more)` : '';
    attention.push({
      area: 'reminder',
      level: 'info',
      detail: `You asked to be reminded: "${first.message.slice(0, 120)}" — ${lateText} ago${more}.`,
      suggest: suggestFor('reminder'),
    });
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
    // What the agent itself changed (or was stopped from changing), newest first.
    // Echoed straight from the durable trail — nothing inferred or summarized.
    recent_actions: (Array.isArray(recentActions) ? recentActions : [])
      .slice(0, 5)
      .map((action) => ({
        at: String(action?.at ?? ''),
        tool: String(action?.tool ?? ''),
        kind: String(action?.kind ?? ''),
        detail: String(action?.detail ?? ''),
      })),
    // Outstanding promises from earlier sessions: the agent's own published steps.
    open_work: openWork,
    due_reminders: { count: dueRemindersOut.length, items: dueRemindersOut },
    focus: focus ? String(focus) : null,
  };
}

/**
 * Live briefing: collects real metrics + schedule, then composes them.
 * Collection failures degrade to a neutral report rather than throwing.
 */
export async function briefingTool({ focus = '', include_system = true, include_schedule = true, paths } = {}) {
  const now = new Date();
  const [metrics, scheduleEntries, recentActions, openGoals, due] = await Promise.all([
    include_system ? collectSystemMetrics().catch(() => null) : null,
    include_schedule ? loadSchedule().catch(() => []) : [],
    readActions(paths, { limit: 5 }).catch(() => []),
    loadOpenGoals(paths).catch(() => []),
    dueReminders(paths, { now }).catch(() => []),
  ]);
  const report = summarizeBriefing({
    metrics,
    scheduleEntries: Array.isArray(scheduleEntries) ? scheduleEntries : [],
    now,
    focus: typeof focus === 'string' ? focus : '',
    recentActions,
    openGoals,
    dueReminderEntries: due,
  });
  // Delivered once, then acknowledged: the briefing is the user asking what is going
  // on, so this is the moment the reminder is actually said.
  if (Array.isArray(due) && due.length > 0) {
    await acknowledgeReminders(paths, due.map((entry) => entry.id)).catch(() => {});
  }
  return report;
}