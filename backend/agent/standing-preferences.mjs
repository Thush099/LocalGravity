/**
 * Standing preferences — durable instructions in the user's own words.
 *
 * "From now on use pnpm" and "never force-push to main" are not facts about the
 * world: they are rules for how every future turn should behave. Left to the
 * model they only survive as long as the conversation does. This sidecar is
 * deterministic: an anchored, whole-message matcher recognises a durable
 * instruction, stores it verbatim as one bullet in MEMORY.md under a
 * `## Standing Preferences` heading, and the ordinary memory injection carries
 * it into every later system prompt.
 *
 * Grounding rule: only the user's own words are stored — nothing is summarised,
 * re-worded or invented. Rules are single-line and bounded, so a captured
 * preference can never smuggle markdown structure into a system prompt.
 */

import { readKnowledge, saveKnowledge } from '../knowledge-engine.mjs';
import { getRuntimePaths } from '../state/paths.mjs';

export const PREFERENCE_HEADING = '## Standing Preferences';

const MIN_RULE_LENGTH = 8;
const MAX_RULE_LENGTH = 200;
const PREFERENCE_LINE_RE = /^\s*[-*]\s*preference:\s*(.+)$/i;

// A durability cue must open the message: it is what makes the instruction a
// rule rather than a one-off request.
const DURABLE_CUE_RE =
  /^(?:please\s+|and\s+|also\s+|ok(?:ay)?,?\s+)?(?:from\s+now\s+on|going\s+forward|from\s+here\s+on|for\s+future\s+reference)\s*[,:]\s*(\S[^\n]*)$/i;

// "always …" / "never …" only count as an instruction when what follows is an
// action. A determiner, pronoun or auxiliary after the cue is ordinary speech
// ("always the build fails", "never it works"), not a rule for the agent.
const IMPERATIVE_CUE_RE = /^(?:please\s+|and\s+|also\s+|ok(?:ay)?,?\s+)?(?:always|never)\s+(\S[^\n]*)$/i;
const NOT_AN_ACTION_RE =
  /^(?:i|we|you|he|she|it|they|the|this|that|there|then|my|your|our|their|a|an|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|should|could|can|just|really|so|too|much|more|less|every|all|any|some|again|same)\b/i;

/** Strip the punctuation a spoken rule trails off with, keeping the words intact. */
function normalizeRule(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/[.!;,\s]+$/, '')
    .trim();
}

/**
 * Pure: returns the rule the user just set, or null when the message is not a
 * durable instruction. Anchored and single-line, so questions, hedged remarks
 * and multi-intent messages fall through to the model.
 */
export function matchStandingPreference(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed || trimmed.includes('\n')) return null;
  if (trimmed.endsWith('?')) return null;
  const durable = DURABLE_CUE_RE.exec(trimmed);
  const imperative = durable ? null : IMPERATIVE_CUE_RE.exec(trimmed);
  const match = durable || imperative;
  if (!match) return null;
  const rule = normalizeRule(match[1]);
  if (rule.length < MIN_RULE_LENGTH || rule.length > MAX_RULE_LENGTH) return null;
  if (NOT_AN_ACTION_RE.test(rule)) return null;
  return rule;
}

/** The rules already stored in a MEMORY.md body, in order. */
export function standingPreferences(body) {
  const rules = [];
  for (const line of String(body ?? '').split('\n')) {
    const match = PREFERENCE_LINE_RE.exec(line);
    if (match) rules.push(match[1].trim());
  }
  return rules;
}

/**
 * Place the new bullet in the standing-preferences section, creating the
 * section immediately before the first ordinary bullet so it sits in the
 * curated head of MEMORY.md (the part the bounded prompt always keeps).
 */
function insertPreference(body, rule) {
  const line = `- Preference: ${rule}`;
  const lines = String(body ?? '').replace(/\s+$/, '').split('\n');
  const sectionIndex = lines.findIndex(
    (candidate) => candidate.trim().toLowerCase() === PREFERENCE_HEADING.toLowerCase(),
  );

  if (sectionIndex === -1) {
    let insertAt = lines.findIndex((candidate) => /^\s*[-*]\s+/.test(candidate));
    if (insertAt === -1) insertAt = lines.length;
    // Keep one blank line between the intro prose and the new section.
    const block = [PREFERENCE_HEADING, line, ''];
    if (insertAt > 0 && lines[insertAt - 1].trim() !== '') block.unshift('');
    lines.splice(insertAt, 0, ...block);
    return lines.join('\n');
  }

  // Append to the end of the existing section, never past the next heading.
  let sectionEnd = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  let lastContent = sectionIndex;
  for (let index = sectionIndex + 1; index < sectionEnd; index += 1) {
    if (lines[index].trim() !== '') lastContent = index;
  }
  lines.splice(lastContent + 1, 0, line);
  return lines.join('\n');
}

/**
 * Store one standing preference in MEMORY.md. Idempotent: a rule already stored
 * (case-insensitively) is not stored twice.
 */
export async function rememberPreference(rule, paths = getRuntimePaths()) {
  const normalized = normalizeRule(rule);
  if (normalized.length < MIN_RULE_LENGTH || normalized.length > MAX_RULE_LENGTH) {
    return { appended: false };
  }
  const doc = await readKnowledge('MEMORY', paths);
  const body = doc?.content ?? '';
  const bullet = `- Preference: ${normalized}`;
  if (body.toLowerCase().includes(bullet.toLowerCase())) return { appended: false };
  await saveKnowledge(
    {
      name: 'MEMORY',
      title: doc?.title || 'User Memory & Preferences',
      tags: Array.isArray(doc?.tags) && doc.tags.length > 0 ? doc.tags : ['memory', 'preferences'],
      content: insertPreference(body, normalized),
    },
    paths,
  );
  return { appended: true };
}

/**
 * Turn-start sidecar: persist a durable instruction, if that is what the message
 * is. Never throws — a memory write must not break the turn — and returns the
 * rule it stored (or null).
 */
export async function captureStandingPreference(text, paths = getRuntimePaths()) {
  const rule = matchStandingPreference(text);
  if (!rule) return null;
  try {
    await rememberPreference(rule, paths);
    return rule;
  } catch {
    return null;
  }
}