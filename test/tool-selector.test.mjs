import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS } from '../backend/tools/registry.mjs';
import { compactToolDefinitions, selectToolsForTurn } from '../backend/agent/tool-selector.mjs';
import { buildSystemPrompt } from '../backend/agent/prompt.mjs';
import { compactConversation, estimateToolsTokens } from '../backend/agent/compactor.mjs';

test('selectToolsForTurn returns all tools for cloud providers and focused core+domain subset for local Ollama', () => {
  const cloudTools = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'anthropic',
    userMessage: 'hello there',
  });
  assert.equal(cloudTools.length, TOOL_DEFINITIONS.length);

  const genericLocal = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Refactor server.mjs to clean up error handling',
  });
  const genericNames = new Set(genericLocal.map((t) => t.function.name));
  assert.ok(genericLocal.length <= 12, `Expected lean core subset for generic coding prompt, got ${genericLocal.length}`);
  assert.ok(genericNames.has('read_file'));
  assert.ok(genericNames.has('edit_file'));
  assert.ok(genericNames.has('run_command'));
  assert.ok(!genericNames.has('add_schedule_item'));
  assert.ok(!genericNames.has('inspect_media'));

  const mediaLocal = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Crop this photo to 9:16',
    attachments: ['/Users/test/photo.png'],
  });
  assert.ok(mediaLocal.some((t) => t.function.name === 'inspect_media'));

  const scheduleLocal = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Add a workout to my timetable at 07:30 on weekdays',
  });
  assert.ok(scheduleLocal.some((t) => t.function.name === 'add_schedule_item'));
  assert.ok(scheduleLocal.some((t) => t.function.name === 'list_schedule_items'));

  const mathAndWeb = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Fetch https://example.com/pricing and calculate 1280 * 0.15',
  });
  assert.ok(mathAndWeb.some((t) => t.function.name === 'fetch_url'));
  assert.ok(mathAndWeb.some((t) => t.function.name === 'calculate'));

  // Tools used earlier in the same session remain active for KV-cache stability
  const stickyLocal = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Great, now do the next one',
    sessionMessages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'copy_to_clipboard', arguments: { text: 'hi' } }] },
    ],
  });
  assert.ok(stickyLocal.some((t) => t.function.name === 'copy_to_clipboard'));
});

test('compact local prompt + focused tools dramatically cut token overhead below 2200 tokens for 30 skills', () => {
  const thirtySkills = Array.from({ length: 30 }, (_, i) => ({
    slug: `starter-skill-${i + 1}`,
    description: 'Comprehensive workflow guide for handling complex local macOS and engineering tasks safely.',
    triggers: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
  }));

  const fullPrompt = buildSystemPrompt({ skills: thirtySkills, knowledgeDocs: [{ name: 'MEMORY', title: 'Memory' }] });
  const compactPrompt = buildSystemPrompt({
    skills: thirtySkills,
    knowledgeDocs: [{ name: 'MEMORY', title: 'Memory' }],
    compact: true,
  });

  assert.ok(compactPrompt.length < fullPrompt.length * 0.65, `Expected compact prompt (${compactPrompt.length}) < 65% of full (${fullPrompt.length})`);
  assert.match(compactPrompt, /starter-skill-1/);
  assert.match(compactPrompt, /starter-skill-30/);

  const localTools = compactToolDefinitions(
    selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: 'Fix the bug in app.js' })
  );
  const overheadTokens = Math.ceil(compactPrompt.length / 3.5) + estimateToolsTokens(localTools);
  assert.ok(overheadTokens < 2200, `Expected total local overhead < 2200 tokens, got ${overheadTokens}`);
});

test('compactConversation respects overheadTokens when checking numCtx threshold', async () => {
  const messages = [
    { role: 'user', content: 'a'.repeat(1200) },
    { role: 'assistant', content: 'b'.repeat(1200) },
    { role: 'user', content: 'c'.repeat(1200) },
    { role: 'assistant', content: 'd'.repeat(1200) },
    { role: 'user', content: 'latest question' },
    { role: 'assistant', content: 'latest answer' },
  ];
  // Without overheadTokens (~1400 tokens <= 70% of 4096 = 2867), no compaction
  const withoutOverhead = await compactConversation(messages, { numCtx: 4096, overheadTokens: 0 });
  assert.equal(withoutOverhead.compacted, false);

  // With 2000 overheadTokens (~3400 total > 2867), compaction triggers cleanly!
  const withOverhead = await compactConversation(messages, {
    numCtx: 4096,
    overheadTokens: 2000,
    summarizeFn: async () => 'Compacted older turns.',
  });
  assert.equal(withOverhead.compacted, true);
});
