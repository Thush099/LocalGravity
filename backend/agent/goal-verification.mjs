/**
 * Goal verification — "Sir, may I remind you that sir never verified that."
 *
 * Two grounded behaviors that complete the plan machinery:
 *
 * 1. Decomposition nudge: a compound request acted on without a plan gets a
 *    one-shot self-correction asking the model to decompose it into concrete,
 *    verifiable `update_plan` steps — the system prompt's own rule, enforced.
 * 2. Completion verification: a step newly marked 'done' is checked against
 *    the turn's real tool log. A completion with no observable action behind
 *    it gets a one-shot nudge to verify it (run the check) or restate its
 *    status honestly, and the step keeps an `unverified` marker in the goal
 *    record so later turns can see it (cross-turn verification).
 *
 * Both signals trace to real observations — the structure of the request and
 * the executed tool calls — and neither invents work.
 */

const ENUMERATED_ITEM = /^[ \t]*([0-9]+[.)]|[-*•])\s+\S/gm;
const SEQUENCING_PHRASE =
  /\b(and then|after (that|this)|once (that'?s |it'?s )?done|finally|next,|then,|to (start|begin) with)\b/i;

/** Pure: is this request compound enough to deserve a published plan? */
export function isCompoundRequest(userMessage) {
  const text = String(userMessage || '');
  if (!text.trim()) return false;
  return (text.match(ENUMERATED_ITEM) || []).length >= 2 || SEQUENCING_PHRASE.test(text);
}

/**
 * Pure: the one-shot decomposition nudge, or '' when one is not warranted.
 * Fires only while the model is already changing things (mutatingAction) on a
 * compound request without having published a plan — recon-only turns and
 * already-decomposed turns are left alone.
 */
export function decompositionNudge(userMessage, { planPublished = false, mutatingAction = false } = {}) {
  if (planPublished || !mutatingAction) return '';
  if (!isCompoundRequest(userMessage)) return '';
  return (
    '[Self-Correction] This looks like a multi-step request. Decompose it into concrete, ' +
    'verifiable steps with update_plan before continuing, then track each step to done.'
  );
}

const EVIDENCE_STOPWORDS = new Set([
  'this', 'that', 'these', 'those', 'with', 'from', 'into', 'then', 'when', 'where',
  'what', 'which', 'your', 'their', 'have', 'has', 'been', 'will', 'would', 'should',
  'could', 'make', 'sure', 'check', 'step', 'steps', 'done', 'finish', 'complete',
  'ensure', 'verify', 'using', 'after', 'before', 'over',
]);
const EVIDENCE_MIN_WORD = 4;

/** Pure: does `word` appear in `text` as a real token (split on non-alphanumerics,
 * so snake_case and dotted names count)? A substring inside an unrelated word
 * never counts; light plural/tense suffixes still do. */
export function wordMatchesText(word, text) {
  const w = String(word || '').toLowerCase();
  if (!w) return false;
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.some((t) => t === w || t === `${w}s` || t === `${w}es` || t === `${w}ing` || t === `${w}ed`);
}

function stepEvidenceWords(text) {
  return [
    ...new Set(
      (String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) || []).filter(
        (word) => word.length >= EVIDENCE_MIN_WORD && !EVIDENCE_STOPWORDS.has(word),
      ),
    ),
  ];
}

/**
 * Pure: the steps newly marked 'done' (versus `previousPlan`) with no
 * observable action in `toolCalls` to back them. A step whose evidence words
 * appear in any completed call's name/args/output counts as verified; a step
 * with no meaningful words at all is treated as unverified (honest default).
 */
export function unverifiedCompletions(previousPlan, nextPlan, toolCalls) {
  const previouslyDone = new Set(
    (Array.isArray(previousPlan) ? previousPlan : [])
      .filter((s) => s && s.status === 'done' && typeof s.text === 'string')
      .map((s) => s.text),
  );
  const newlyDone = (Array.isArray(nextPlan) ? nextPlan : []).filter(
    (s) => s && s.status === 'done' && typeof s.text === 'string' && !previouslyDone.has(s.text),
  );
  if (newlyDone.length === 0) return [];
  // A plan is a claim, not an action: update_plan entries never count as
  // evidence, or a step would verify itself by being promised twice.
  const corpus = (Array.isArray(toolCalls) ? toolCalls : [])
    .filter((t) => t && t.name !== 'update_plan')
    .map(
      (t) =>
        `${t?.name || ''} ${JSON.stringify(t?.args || {})} ${String(t?.output || '').slice(0, 800)}`.toLowerCase(),
    )
    .join('\n');
  return newlyDone.filter((step) => {
    const words = stepEvidenceWords(step.text);
    if (words.length === 0) return true;
    return !words.some((word) => wordMatchesText(word, corpus));
  });
}

/** The one-shot self-correction asking the model to verify unbacked completions. */
export function verificationNudgeMessage(steps) {
  return (
    '[Self-Correction] These steps were marked done without an observable tool action this turn:\n' +
    `${steps.map((s) => `- ${s.text}`).join('\n')}\n` +
    'Verify them now (run the check that proves it) or restate their status honestly.'
  );
}

/** The honest closing note when unverified completions remain at turn end. */
export function unverifiedCompletionNote(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  return (
    '\n\n[Plan] Marked done without an observable action this turn (unverified):\n' +
    steps.map((s) => `- ${s.text}`).join('\n')
  );
}
