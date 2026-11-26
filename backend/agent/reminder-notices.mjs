/**
 * Turn-local notices for reminders that actually came due.
 *
 * The briefing answers "what is going on?" — but a reminder that fires while the
 * user is mid-conversation should not have to wait for that question. These notes
 * hand the observation back to the model at the start of a turn, in the same
 * turn-local channel as the memory notices, so the reply can say "your reminder
 * came due" instead of nothing at all.
 *
 * Grounding: the text is exactly what the user asked to be reminded about, and the
 * lateness is computed from the stored time. Only the quoted reminders are
 * acknowledged, so a backlog drains a couple per turn instead of being swallowed.
 */

import { dueReminders, acknowledgeReminders } from '../tools/reminders.mjs';

export const MAX_REMINDER_NOTICES = 2;
export const MAX_REMINDER_MESSAGE_CHARS = 200;

function lateLabel(minutes) {
  const value = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  if (value < 1) return 'just now';
  if (value < 60) return `${value} min ago`;
  const hours = Math.round(value / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Pure: the notice lines for a bounded list of due reminders. */
export function reminderNotices(items = [], { max = MAX_REMINDER_NOTICES } = {}) {
  const all = (Array.isArray(items) ? items : []).filter((item) => item && item.message);
  const quoted = all.slice(0, Math.max(1, max));
  const notes = quoted.map(
    (item) =>
      `[Reminder] You asked to be reminded: "${String(item.message).slice(0, MAX_REMINDER_MESSAGE_CHARS)}" (${lateLabel(item.overdue_minutes)}). Tell the user this reminder is due; never invent a reminder that is not listed here.`,
  );
  const extra = all.length - quoted.length;
  if (extra > 0) {
    notes.push(
      `[Reminder] ${extra} more reminder${extra === 1 ? '' : 's'} also came due; mention ${extra === 1 ? 'it' : 'them'} after the first.`,
    );
  }
  return notes;
}

/**
 * Notices for the reminders that are due right now, acknowledging only the ones
 * quoted so the rest stay pending for the next turn.
 */
export async function dueReminderNotices(paths, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const due = await dueReminders(paths, { now, limit: MAX_REMINDER_NOTICES + 5 }).catch(() => []);
  if (!Array.isArray(due) || due.length === 0) return [];
  const quoted = due.slice(0, MAX_REMINDER_NOTICES);
  const notes = reminderNotices(due);
  if (options.acknowledge !== false) {
    await acknowledgeReminders(paths, quoted.map((entry) => entry.id)).catch(() => {});
  }
  return notes;
}