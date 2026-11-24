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
