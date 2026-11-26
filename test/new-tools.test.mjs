import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression, calculateTool, extractPureCalculation } from '../backend/tools/calc-tool.mjs';
import { normalizePlanSteps, updatePlanTool } from '../backend/tools/plan-tool.mjs';
import { runAppleScriptTool } from '../backend/tools/applescript-tool.mjs';
import { buildModelMessages } from '../backend/agent/loop.mjs';
import { evaluateToolSafety } from '../backend/tools/registry.mjs';

test('extractPureCalculation routes only provable arithmetic to the deterministic fast-path', () => {
  // Pure arithmetic (with a command word or bare) is extracted.
  assert.equal(extractPureCalculation('calculate 25*4+7'), '25*4+7');
  assert.equal(extractPureCalculation('what is 12*12'), '12*12');
  assert.equal(extractPureCalculation('25*4+7'), '25*4+7');
  assert.equal(extractPureCalculation('how much is (2+3)*4?'), '(2+3)*4');
  // Ambiguous or non-arithmetic text falls through to the model.
  assert.equal(extractPureCalculation('2024-01-05'), null, 'a date is not subtraction');
  assert.equal(extractPureCalculation('organize my downloads'), null);
  assert.equal(extractPureCalculation('calculate the total budget'), null);
  assert.equal(extractPureCalculation(''), null);
});

test('calculate evaluates arithmetic, functions, and constants without eval', () => {
  assert.equal(evaluateExpression('2 + 3 * 4').value, 14);
  assert.equal(evaluateExpression('(2 + 3) * 4').value, 20);
  assert.equal(evaluateExpression('2 ** 10').value, 1024);
  assert.equal(evaluateExpression('-5 + 3').value, -2);
  assert.equal(evaluateExpression('10 % 4').value, 2);
  assert.equal(evaluateExpression('sqrt(144)').value, 12);
  assert.equal(evaluateExpression('round(3.6)').value, 4);
  assert.ok(Math.abs(evaluateExpression('pi').value - Math.PI) < 1e-9);
  assert.equal(evaluateExpression('2.5 * 4').value, 10);
});

test('calculate rejects injection, division by zero, and unknown names', () => {
  assert.equal(evaluateExpression('1 / 0').ok, false);
  assert.equal(evaluateExpression('2 + (3').ok, false);
  assert.equal(evaluateExpression('foo(1)').ok, false);
  assert.equal(evaluateExpression('').ok, false);
  assert.equal(evaluateExpression('process.exit(1)').ok, false);
  assert.equal(evaluateExpression('require("fs")').ok, false);
  // No code execution: attempt at JS call syntax must not run
  assert.equal(evaluateExpression('globalThis.x = 5').ok, false);
});

test('calculateTool formats integer and float results', () => {
  const r1 = calculateTool({ expression: '6 * 7' });
  assert.equal(r1.ok, true);
  assert.equal(r1.output, '42');
  const r2 = calculateTool({ expression: '1 / 3' });
  assert.equal(r2.ok, true);
  assert.ok(r2.output.startsWith('0.333'));
});

test('plan tool normalizes steps and emits plan_update events', () => {
  const steps = normalizePlanSteps([
    { text: 'Read files', status: 'done' },
    { text: 'Edit code', status: 'active' },
    { text: 'Run tests', status: 'bogus' },
    { text: '' },
    'Plain string step',
  ]);
  assert.equal(steps.length, 4);
  assert.equal(steps[0].status, 'done');
  assert.equal(steps[1].status, 'active');
  assert.equal(steps[2].status, 'pending'); // invalid status falls back to pending
  assert.equal(steps[3].text, 'Plain string step');

  const events = [];
  const result = updatePlanTool(
    { steps: [{ text: 'A', status: 'done' }, { text: 'B' }] },
    { onEvent: (e) => events.push(e) }
  );
  assert.equal(result.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'plan_update');
  assert.equal(events[0].completed, 1);
  assert.equal(events[0].total, 2);
  assert.match(result.output, /\[x\] A/);
  assert.match(result.output, /\[ \] B/);

  assert.equal(updatePlanTool({ steps: [] }).ok, false);
});

test('run_applescript validates empty and oversized scripts without invoking osascript', async () => {
  const empty = await runAppleScriptTool({ script: '   ' });
  assert.equal(empty.ok, false);

  const huge = await runAppleScriptTool({ script: 'x'.repeat(20001) });
  assert.equal(huge.ok, false);
});

test('run_applescript is gated as mutating under headless audit mode', () => {
  const headlessAuditCtx = { safetyMode: 'ask', isHeadless: true, allowAutoRun: false };
  assert.equal(evaluateToolSafety({ name: 'run_applescript', args: { script: 'tell app "Finder"' } }, headlessAuditCtx).decision, 'block');

  const autoCtx = { safetyMode: 'auto', isHeadless: false, allowAutoRun: true };
  assert.equal(evaluateToolSafety({ name: 'run_applescript', args: { script: 'tell app "Finder"' } }, autoCtx).decision, 'allow');

  const askCtx = { safetyMode: 'ask', isHeadless: false, allowAutoRun: false };
  assert.equal(evaluateToolSafety({ name: 'run_applescript', args: { script: 'tell app "Finder"' } }, askCtx).decision, 'ask');
});

test('calculate and update_plan are always read-only and never require approval', () => {
  const askCtx = { safetyMode: 'ask', isHeadless: false, allowAutoRun: false };
  assert.equal(evaluateToolSafety({ name: 'calculate', args: { expression: '1+1' } }, askCtx).decision, 'allow');
  assert.equal(evaluateToolSafety({ name: 'update_plan', args: { steps: [{ text: 'x' }] } }, askCtx).decision, 'allow');
});

test('buildModelMessages never double-sends tool vision frames to Ollama/OpenAI', () => {
  const session = [
    { role: 'user', content: 'look' },
    { role: 'tool', toolCallId: 'a', toolName: 'inspect_media', content: 'img', images: ['AAA', 'BBB'] },
    { role: 'assistant', content: 'done' },
  ];

  const ollama = buildModelMessages('sys', session, 'ollama');
  const toolMsg = ollama.find((m) => m.role === 'tool');
  // Frames stripped from the tool message (they go via the synthetic user message)
  assert.equal(toolMsg.images, undefined);
  const synthetic = ollama.find((m) => m.role === 'user' && Array.isArray(m.images));
  assert.ok(synthetic, 'synthetic image user message exists');
  assert.deepEqual(synthetic.images, ['AAA', 'BBB']);
  // Total image payloads across all messages == exactly the original two frames
  const totalImages = ollama.reduce((n, m) => n + (Array.isArray(m.images) ? m.images.length : 0), 0);
  assert.equal(totalImages, 2);
});

test('buildModelMessages keeps tool vision frames inline for Anthropic tool_result blocks', () => {
  const session = [
    { role: 'tool', toolCallId: 'a', toolName: 'inspect_media', content: 'img', images: ['AAA'] },
    { role: 'assistant', content: 'done' },
  ];
  const anth = buildModelMessages('sys', session, 'anthropic');
  const toolMsg = anth.find((m) => m.role === 'tool');
  assert.deepEqual(toolMsg.images, ['AAA']);
  // No synthetic image user message for Anthropic
  assert.equal(anth.find((m) => m.role === 'user' && Array.isArray(m.images)), undefined);
});
