/**
 * Plan accountability — "Sir, steps 3 and 5 are still outstanding."
 *
 * A published plan is a promise. When the model calls `update_plan` and then
 * tries to end the turn with unfinished steps, this module powers two honest
 * behaviors in the agent loop:
 *
 * 1. A single self-correction nudge: finish the remaining steps, or say what
 *    remains and why. (One nudge only — the loop must never ping-pong.)
 * 2. If the turn still ends short, an appended note lists the unfinished steps,
 *    so a partial result is never presented as a clean "all done".
 *
 * The nudge improves task completion ("longer horizons"); the note guarantees
 * honesty. Neither invents work: the steps are the model's own published plan.
 */

/** Pure: the steps whose status is not 'done'. */
export function unfinishedPlanSteps(plan) {
  if (!Array.isArray(plan)) return [];
  return plan.filter((s) => s && typeof s.text === 'string' && s.text.length > 0 && s.status !== 'done');
}

function stepLine(step) {
  return `- ${step.text}${step.status === 'active' ? ' (in progress)' : ''}`;
}

/** The one-shot self-correction message that asks the model to finish its plan. */
export function planNudgeMessage(steps) {
  return (
    '[Self-Correction] Your published plan still has unfinished steps:\n' +
    `${steps.map(stepLine).join('\n')}\n` +
    'Finish them now, or clearly tell the user what remains and why.'
  );
}

/** The honest closing note appended when the turn ends with unfinished steps. */
export function planCompletionNote(steps) {
  if (steps.length === 0) return '';
  return `\n\n[Plan] Still unfinished:\n${steps.map(stepLine).join('\n')}`;
}