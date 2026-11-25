/**
 * Goal continuity — "Sir, you left these steps unfinished."
 *
 * A published plan should outlive its session. `update_plan` promises are
 * persisted as open goals, and when a later message is actually about that
 * work, the unfinished steps are re-surfaced in the system prompt so the
 * agent can honestly pick up where it left off. The grounding rule is
 * structural: a goal record only ever contains steps the model itself
 * published — nothing here can invent work.
 *
 * Surfacing is gated on relevance (continuation phrasing or word overlap
 * with the goal's own steps) so ordinary turns are never ambushed by a
 * stale plan, and completed goals are removed from the state file.
 */
import fs from 'node:fs/promises';
import { getRuntimePaths } from '../state/paths.mjs';
import { unfinishedPlanSteps } from './plan-accountability.mjs';

const CONTINUATION_PATTERNS = new RegExp(
  String.raw`\b(continue|pick (it |this )?up|carry on|where (we|you) left off|where were we|what('s| is) (left|next|remaining|outstanding)|what remains|unfinished|next steps?|(our|the|that) (plan|goal|list))\b`,
  'i',
);

const GOAL_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was', 'one', 'our', 'out',
  'has', 'have', 'had', 'what', 'when', 'where', 'which', 'who', 'why', 'how', 'did', 'does',
  'tell', 'about', 'that', 'this', 'with', 'from', 'your', 'please', 'could', 'would',
  'should', 'now', 'just', 'like', 'get', 'got', 'need', 'want', 'make', 'made', 'also',
]);

/** Pure: does this message plausibly concern these plan steps? */
export function goalMatchesQuery(steps, query) {
  const text = String(query || '');
  if (!text.trim() || !Array.isArray(steps) || steps.length === 0) return false;
  if (CONTINUATION_PATTERNS.test(text)) return true;
  const words = [
    ...new Set(
      (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) || []).filter(
        (word) => word.length >= 3 && !GOAL_STOPWORDS.has(word),
      ),
    ),
  ];
  if (words.length === 0) return false;
  const haystack = steps.map((s) => String(s?.text || '')).join(' ').toLowerCase();
  return words.some((word) => haystack.includes(word));
}

function goalBlock(goal) {
  const when = String(goal.updatedAt || '').slice(0, 10) || 'earlier';
  const lines = goal.steps
    .map(
      (s) =>
        `  [${s.status === 'done' ? 'x' : ' '}] ${String(s.text)}${s.unverified ? ' (unverified)' : ''}`,
    )
    .join('\n');
  return `Open plan (updated ${when}):\n${lines}`;
}

/**
 * Pure: the system-prompt note that re-surfaces open goals relevant to
 * `query`, or '' when nothing open is relevant — silence is the default.
 */
export function goalContinuityNote(goals, query, { maxChars = 900, maxGoals = 2 } = {}) {
  const open = (Array.isArray(goals) ? goals : []).filter(
    (goal) => goal && Array.isArray(goal.steps) && unfinishedPlanSteps(goal.steps).length > 0,
  );
  const relevant = open.filter((goal) => goalMatchesQuery(goal.steps, query)).slice(-maxGoals);
  if (relevant.length === 0) return '';
  const note =
    '## Open Goals (your own published plans, unfinished)\n' +
    `${relevant.map(goalBlock).join('\n\n')}\n` +
    'These are promises from earlier turns. Continue them when the user is asking about this work; otherwise answer what was actually asked.';
  return note.slice(0, maxChars);
}

/**
 * Persist the latest published plan as an open goal for this session,
 * or clear the record once every step is done. A missing or corrupt
 * state file behaves as "no goals".
 */
export async function persistGoalState(
  plan,
  { paths = getRuntimePaths(), sessionId = 'unknown', now = new Date().toISOString(), unverifiedTexts = [] } = {},
) {
  const key = String(sessionId || 'unknown');
  const unverified = new Set((Array.isArray(unverifiedTexts) ? unverifiedTexts : []).map(String));
  const steps = (Array.isArray(plan) ? plan : [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim().length > 0)
    .map((s) => ({
      text: s.text.trim(),
      status: s.status === 'done' ? 'done' : s.status === 'active' ? 'active' : 'pending',
      ...(s.status === 'done' && unverified.has(s.text.trim()) ? { unverified: true } : {}),
    }));
  const rest = (await loadOpenGoals(paths)).filter((goal) => goal.sessionId !== key);
  const goals =
    unfinishedPlanSteps(steps).length > 0 ? [...rest, { sessionId: key, updatedAt: now, steps }] : rest;
  await fs.mkdir(paths.root, { recursive: true });
  await fs.writeFile(paths.goalsFile, `${JSON.stringify({ goals }, null, 2)}\n`, { mode: 0o600 });
  return goals;
}

export async function loadOpenGoals(paths = getRuntimePaths()) {
  try {
    const raw = JSON.parse(await fs.readFile(paths.goalsFile, 'utf8'));
    const goals = Array.isArray(raw?.goals) ? raw.goals : [];
    return goals.filter(
      (goal) => goal && typeof goal.sessionId === 'string' && Array.isArray(goal.steps),
    );
  } catch {
    return [];
  }
}
