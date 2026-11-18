/**
 * Agent task planner. The model maintains an explicit, ordered checklist of what it is
 * doing so the user can watch progress live. Each call replaces the plan state for the
 * turn and emits a `plan_update` SSE event the UI renders as a checklist panel.
 */

const STATUSES = new Set(['pending', 'active', 'done']);
const MAX_STEPS = 24;

export function normalizePlanSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) return [];
  return rawSteps
    .slice(0, MAX_STEPS)
    .map((step, idx) => {
      const text = String(step?.text ?? step?.title ?? step ?? '').trim();
      const rawStatus = String(step?.status ?? 'pending').toLowerCase().trim();
      return {
        text,
        status: STATUSES.has(rawStatus) ? rawStatus : 'pending',
        index: idx,
      };
    })
    .filter((step) => step.text.length > 0);
}

export function updatePlanTool({ steps }, context = {}) {
  const plan = normalizePlanSteps(steps);
  if (plan.length === 0) {
    return { ok: false, output: 'update_plan requires at least one non-empty step.' };
  }

  const completed = plan.filter((s) => s.status === 'done').length;
  context.onEvent?.({ type: 'plan_update', plan, completed, total: plan.length });

  const lines = plan.map((s) => {
    const box = s.status === 'done' ? '[x]' : s.status === 'active' ? '[>]' : '[ ]';
    return `${box} ${s.text}`;
  });

  return {
    ok: true,
    output: `Plan updated (${completed}/${plan.length} done):\n${lines.join('\n')}`,
    plan,
  };
}
