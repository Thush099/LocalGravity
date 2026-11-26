import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS } from '../backend/tools/registry.mjs';
import { selectToolsForTurn, MAX_SELECTED_TOOLS } from '../backend/agent/tool-selector.mjs';

const names = (tools) => tools.map((t) => t.function.name);

test('pattern-heavy messages are capped at MAX_SELECTED_TOOLS', () => {
  // A pathological message matching nearly every domain group must not ship the
  // whole catalog: the schema wire size is per-turn model prefill cost.
  const kitchenSink = 'list files read write edit move search git commit run command apple script '
    + 'calculate clipboard notify open app shortcut schedule reminder screenshot web news email '
    + 'system stats network speed docker sqlite delegate knowledge skills browse url document '
    + 'media files paste undo restore large files monitor performance pipeline tests';
  const picked = selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: kitchenSink });
  assert.ok(picked.length <= MAX_SELECTED_TOOLS,
    `expected <= ${MAX_SELECTED_TOOLS} tools, got ${picked.length}`);
});

test('normal messages are unaffected by the cap', () => {
  const picked = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Fix the failing tests and then commit the changes to git please',
  });
  // Realistic turns stay complete: the cap only bounds pathological matches.
  assert.ok(picked.length > 0 && picked.length <= 8);
});

test('mode groups survive the cap', () => {
  const kitchenSink = 'list files read write edit move search git commit run command apple script '
    + 'calculate clipboard notify open app shortcut schedule reminder screenshot web news email '
    + 'system stats network speed docker sqlite delegate knowledge skills browse url document media';
  const picked = names(selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: kitchenSink,
    mode: 'researcher',
  }));
  for (const name of ['search_web', 'fetch_url', 'open_url']) {
    assert.ok(picked.includes(name), `mode tool ${name} must never be dropped`);
  }
});

test('session-continuity tools survive the cap', () => {
  const sessionMessages = [
    { role: 'assistant', toolCalls: [{ name: 'manage_notes' }] },
    { role: 'assistant', toolCalls: [{ name: 'git_op' }] },
  ];
  const kitchenSink = 'list files read write edit move search run command apple script calculate '
    + 'clipboard notify open app shortcut schedule reminder screenshot web news email system stats '
    + 'network speed docker sqlite delegate knowledge skills browse url document media pipeline';
  const picked = names(selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: kitchenSink,
    sessionMessages,
  }));
  assert.ok(picked.includes('manage_notes'), 'continuity tool must not be dropped');
  assert.ok(picked.includes('git_op'), 'continuity tool must not be dropped');
});

test('cap output is deterministic', () => {
  const msg = 'files search git command app screenshot news email system docker sqlite knowledge';
  const a = names(selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: msg }));
  const b = names(selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: msg }));
  assert.deepEqual(a, b);
});
