/**
 * Turn receipts — what actually happened, as opposed to what the reply claims.
 *
 * A turn can fail in ways the transcript makes easy to gloss over: a write the
 * safety gate blocked, an edit the user denied, a parse error that never ran.
 * The model still holds the conversation, so a confident "done" is one sentence
 * away even when nothing changed. This module keeps a small, factual ledger of
 * the actions that did *not* happen and turns it into one nudge, plus a fallback
 * note when the answer still does not mention them.
 *
 * Scope is deliberate: a non-zero `run_command` exit is an observation the model
 * must reason about (tests fail, greps miss), not a blocked action, so only a
 * refused/denied command is receipted. Read-only tools change nothing and are
 * never receipted. Everything here restates the tool's own error text.
 */

// Actions whose failure means a durable change did not happen.
const DURABLE_ACTION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'move_file',
  'undo_file_moves',
  'manage_notes',
  'save_knowledge',
  'save_skill',
  'set_reminder',
  'add_schedule_item',
  'remove_schedule_item',
]);

// Actions that touch the machine or the outside world at all. A refusal here
// (safety gate, user denial, unparseable call) means the action never ran.
const MUTATING_TOOLS = new Set([
  ...DURABLE_ACTION_TOOLS,
  'run_command',
  'git_op',
  'docker_op',
  'run_applescript',
  'open_app',
  'open_url',
  'paste_from_clipboard',
  'show_notification',
  'sqlite_query',
]);

const MAX_REASON_CHARS = 160;
const MAX_NAMED_FAILURES = 3;

/** True when the reply already admits that something did not work. */
const FAILURE_REPORT_RE =
  /\b(?:fail(?:ed|s|ure)?|error(?:ed|s)?|couldn'?t|could not|can'?t|cannot|unable|denied|blocked|not able|didn'?t|did not|does not exist|no such file|nothing (?:was )?changed|not (?:found|created|written|saved|run|executed|updated|moved))\b/i;

function cleanReason(reason) {
  const text = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text;
}

/**
 * Append one receipt, if the failure actually blocked a change. `kind` is
 * 'error' for a tool that ran and failed, 'blocked' for one that never ran.
 */
export function recordActionFailure(failures, { name, reason, kind = 'error' } = {}) {
  const list = Array.isArray(failures) ? failures : [];
  if (!MUTATING_TOOLS.has(name)) return list;
  // An exit code is data; only a refusal counts for command-style tools.
  if (kind === 'error' && !DURABLE_ACTION_TOOLS.has(name)) return list;
  const text = cleanReason(reason);
  if (!text) return list;
  list.push({ name, reason: text });
  return list;
}

export function mentionsFailure(text) {
  return FAILURE_REPORT_RE.test(String(text ?? ''));
}

function describe(failures) {
  const named = failures.slice(0, MAX_NAMED_FAILURES).map((failure) => `${failure.name} (${failure.reason})`);
  const extra = failures.length - named.length;
  return extra > 0 ? `${named.join(' · ')} · and ${extra} more` : named.join(' · ');
}

/** One self-correction turn: name the failures and forbid a false success claim. */
export function failureNudge(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return '';
  return [
    `[Self-Correction] These actions did not complete in this turn: ${describe(failures)}.`,
    'Do not claim they succeeded. Say plainly what did not happen and why, and what is left to do — or retry with a different approach if one exists.',
  ].join(' ');
}

/** Appended when the answer still does not mention the failures at all. */
export function unreportedFailureNote(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return '';
  return `\n\n[Unreported failures] ${describe(failures)}. The summary above does not mention them.`;
}