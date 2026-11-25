/**
 * Deterministic explicit-memory capture — the guarantee behind "remember that…".
 *
 * When a message *is* a memory instruction ("remember that I prefer tabs"), the
 * fact must be persisted even if the model never calls the knowledge tool
 * itself. This sidecar runs at turn start with an anchored, whole-message
 * matcher so it has zero false positives: questions ("do you remember…"),
 * reminders ("remember to…"), and multi-intent messages all fall through to the
 * model's normal tool path.
 *
 * Grounding rule: only the user's own words are stored, verbatim, one
 * single-line bullet — nothing is summarised or invented. Single-line, bounded
 * facts are also a safety property: MEMORY.md is injected into future system
 * prompts, so a captured fact must never be able to smuggle multi-line content
 * into them.
 */

import { readKnowledge, saveKnowledge } from '../knowledge-engine.mjs';
import { getRuntimePaths } from '../state/paths.mjs';

const MIN_FACT_LENGTH = 8;
const MAX_FACT_LENGTH = 300;

// The whole message must be the memory request (anchored), optionally prefixed
// with a polite clause. "that" or ":" introduces the fact so "remember to …"
// (a reminder) and "do you remember …" (a question) can never match. Facts are
// single-line: multi-line messages fall through to the model's tool path.
const EXPLICIT_MEMORY_RE =
  /^(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:remember|note)(?:\s+that\s+|\s*:\s*)(\S[^\n]*)$/i;

/** Pure: returns the fact to remember, or null when the message is not one. */
export const MEMORY_TRIMMED_NOTICE =
  '\u2026(memory trimmed: older entries omitted \u2014 call the read_knowledge tool with the MEMORY doc when recall matters)';

/**
 * Bound the memory excerpt injected into the system prompt.
 *
 * MEMORY.md grows as explicit captures accumulate and the whole doc is loaded
 * into a context budget as small as 8K. A plain head slice starves captured
 * facts \u2014 they append at the tail and silently drop out of every prompt \u2014 and
 * cuts bullets mid-line. Keep the curated head and the most recent entries,
 * mark the gap explicitly so the model knows to use read_knowledge, and never
 * exceed `maxChars`.
 */
export function boundedMemoryContent(content, { maxChars = 1200, tailChars } = {}) {
  const text = String(content || '').trim();
  if (!text || !(maxChars > 0) || text.length <= maxChars) return text;
  const lines = text.split('\n');
  const tailBudget = Math.max(
    0,
    Math.min(tailChars ?? Math.floor(maxChars * 0.25), maxChars - MEMORY_TRIMMED_NOTICE.length),
  );
  const headBudget = Math.max(0, maxChars - MEMORY_TRIMMED_NOTICE.length - tailBudget);
  let headEnd = 0;
  let used = 0;
  while (headEnd < lines.length && used + lines[headEnd].length + 1 <= headBudget) {
    used += lines[headEnd].length + 1;
    headEnd += 1;
  }
  let tailStart = lines.length;
  used = 0;
  while (tailStart > headEnd && used + lines[tailStart - 1].length + 1 <= tailBudget) {
    tailStart -= 1;
    used += lines[tailStart].length + 1;
  }
  if (headEnd === 0 && tailStart === lines.length) {
    // Not even one line fits the budget: fall back to a plain hard cut.
    return text.slice(0, maxChars);
  }
  return [...lines.slice(0, headEnd), MEMORY_TRIMMED_NOTICE, ...lines.slice(tailStart)]
    .join('\n')
    .slice(0, maxChars);
}

export function matchExplicitMemory(text) {
  const trimmed = String(text ?? '').trim();
  const match = EXPLICIT_MEMORY_RE.exec(trimmed);
  if (!match) return null;
  const fact = match[1].trim().replace(/[.\s]+$/, '');
  if (fact.length < MIN_FACT_LENGTH || fact.length > MAX_FACT_LENGTH) return null;
  return fact;
}

/**
 * Append the fact to MEMORY.md as one bullet, preserving the doc's frontmatter.
 * Idempotent: a fact already present is not stored twice.
 */
export async function rememberFact(fact, paths = getRuntimePaths()) {
  const doc = await readKnowledge('MEMORY', paths);
  const body = doc?.content ?? '';
  if (body.includes(fact)) return { name: 'MEMORY', appended: false };
  const content = `${body.replace(/\s+$/, '')}\n- ${fact}\n`.replace(/^\n/, '');
  await saveKnowledge(
    {
      name: 'MEMORY',
      title: doc?.title || 'Memory',
      tags: Array.isArray(doc?.tags) && doc.tags.length > 0 ? doc.tags : ['memory', 'preferences'],
      content,
    },
    paths
  );
  return { name: 'MEMORY', appended: true };
}

/**
 * Turn-start sidecar: capture an explicit memory request, if that is what the
 * message is. Never throws — a memory write must not break the turn — and
 * returns the captured fact or null.
 */
export async function captureExplicitMemory(text, paths = getRuntimePaths()) {
  const fact = matchExplicitMemory(text);
  if (!fact) return null;
  try {
    await rememberFact(fact, paths);
    return fact;
  } catch {
    return null;
  }
}
