/**
 * Explicit memory removal — the other end of capture.
 *
 * "Forget that the staging box is 10.0.0.5" is a durable instruction too, and
 * leaving it to the model meant a user could not reliably delete what a previous
 * turn stored. This sidecar is deterministic and deliberately timid: it removes
 * exactly one bullet, and only when the user's own words match one unambiguously.
 * Two matches, or none, change nothing and hand the choice back to the model.
 */

import { readKnowledge, saveKnowledge } from '../knowledge-engine.mjs';
import { getRuntimePaths } from '../state/paths.mjs';

const MIN_TARGET_LENGTH = 6;
const MAX_TARGET_LENGTH = 200;
const BULLET_RE = /^\s*[-*]\s+(.+)$/;
const FORGET_RE = /^(?:please\s+|and\s+|also\s+|ok(?:ay)?,?\s+)?forget\s+(?:that\s+|about\s+)?(\S[^\n]*)$/i;
// Figures of speech, not deletions: "forget it", "forget everything", …
const NOT_A_TARGET_RE = /^(?:it|this|that|these|those|everything|anything|nothing|all|them|him|her|us|me)\b/i;

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!;,\s]+$/, '')
    .trim();
}

/** Pure: the fact the user asked to forget, or null when this is not a request. */
export function matchForgetRequest(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed || trimmed.includes('\n')) return null;
  if (trimmed.endsWith('?')) return null;
  const match = FORGET_RE.exec(trimmed);
  if (!match) return null;
  const target = match[1].replace(/[.!;,\s]+$/, '').trim();
  if (target.length < MIN_TARGET_LENGTH || target.length > MAX_TARGET_LENGTH) return null;
  if (NOT_A_TARGET_RE.test(target)) return null;
  return target;
}

/**
 * Remove the one bullet whose text contains the target. Returns
 * { status: 'removed' | 'ambiguous' | 'none' } — 'ambiguous' deletes nothing.
 */
// "forget my old phone number" names the fact with a possessive the stored
// bullet may not carry. Try the words as written first, then without a leading
// determiner — still a substring test, still unique-match-only.
const DETERMINER_RE = /^(?:my|our|the|a|an)\s+/;

function matchBullets(lines, wanted) {
  const hits = [];
  lines.forEach((line, index) => {
    const bullet = BULLET_RE.exec(line);
    if (!bullet) return;
    if (normalize(bullet[1]).includes(wanted)) hits.push({ index, line: line.trim() });
  });
  return hits;
}

export async function forgetFact(target, paths = getRuntimePaths()) {
  const wanted = normalize(target);
  if (!wanted) return { status: 'none', target };
  const doc = await readKnowledge('MEMORY', paths);
  const body = doc?.content ?? '';
  const lines = body.split('\n');
  const variants = [...new Set([wanted, wanted.replace(DETERMINER_RE, '')])];
  let hits = [];
  for (const variant of variants) {
    if (!variant) continue;
    hits = matchBullets(lines, variant);
    if (hits.length > 0) break;
  }
  if (hits.length === 0) return { status: 'none', target };
  if (hits.length > 1) {
    return { status: 'ambiguous', target, candidates: hits.map((hit) => hit.line) };
  }

  const [hit] = hits;
  lines.splice(hit.index, 1);
  const content = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
  await saveKnowledge(
    {
      name: 'MEMORY',
      title: doc?.title || 'User Memory & Preferences',
      tags: Array.isArray(doc?.tags) && doc.tags.length > 0 ? doc.tags : ['memory', 'preferences'],
      content,
    },
    paths,
  );
  return { status: 'removed', target, removed: hit.line };
}

/** Turn-local notices: what was removed, or why nothing was. */
export function forgetNotices(result) {
  if (!result) return [];
  if (result.status === 'removed') {
    return [
      `[Memory] Removed from MEMORY.md: "${result.removed}". Confirm the removal in one short line.`,
    ];
  }
  if (result.status === 'ambiguous') {
    return [
      `[Memory] "forget ${result.target}" matched ${result.candidates.length} entries in MEMORY.md, so nothing was removed. Ask which one the user means, or quote the exact entry back to them.`,
    ];
  }
  return [];
}

/** Turn-start sidecar. Never throws; returns the removal result or null. */
export async function captureForget(text, paths = getRuntimePaths()) {
  const target = matchForgetRequest(text);
  if (!target) return null;
  try {
    return await forgetFact(target, paths);
  } catch {
    return null;
  }
}