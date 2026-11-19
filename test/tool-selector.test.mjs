import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS } from '../backend/tools/registry.mjs';
import { compactToolDefinitions, selectToolsForTurn } from '../backend/agent/tool-selector.mjs';
import { buildSystemPrompt } from '../backend/agent/prompt.mjs';
import { compactConversation, estimateToolsTokens } from '../backend/agent/compactor.mjs';

test('compact local-agent prompts prefer the shortest complete response unless detail is requested', () => {
  const prompt = buildSystemPrompt({ compact: true });
  assert.match(prompt, /shortest complete answer/i);
  assert.match(prompt, /expand only when the user asks for detail/i);
  assert.match(prompt, /include every requested point/i);
});

test('selectToolsForTurn keeps general local conversation tool-free and adds only task-relevant tools', () => {
  const general = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Explain why sleep matters.',
  });
  assert.deepEqual(general, []);

  const listing = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'List three top-level project paths.',
  });
  assert.deepEqual(listing.map((tool) => tool.function.name), ['list_dir']);

  const directoryEntries = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Show only the first three entries in the current project directory.',
  });
  assert.ok(directoryEntries.some((tool) => tool.function.name === 'list_dir'));

  const multiStep = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Check the code, then run the tests and fix any issue.',
  });
  assert.ok(multiStep.some((tool) => tool.function.name === 'update_plan'));

  const coding = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Fix the bug in server.mjs and run the tests.',
  });
  const codingNames = new Set(coding.map((tool) => tool.function.name));
  assert.ok(codingNames.has('read_file'));
  assert.ok(codingNames.has('edit_file'));
  assert.ok(codingNames.has('run_command'));
  assert.ok(!codingNames.has('system_stats'));
});

test('selectToolsForTurn understands everyday local phrasing and keeps abstract chat tool-free', () => {
  const cases = [
    ['What is in this folder?', 'list_dir'],
    ['What files are here?', 'list_dir'],
    ['Read the README', 'read_file'],
    ['How much battery do I have?', 'system_stats'],
    ['My Mac is slow', 'system_stats'],
    ['Can you fix this for me?', 'edit_file'],
    ['Open the project and tell me what it does', 'read_file'],
    ['Summarize this document', 'read_file'],
    ['Clean up my downloads folder', 'run_command'],
  ];
  for (const [message, expected] of cases) {
    const selected = selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: message });
    const names = selected.map((tool) => tool.function.name);
    assert.ok(names.includes(expected), `${message} -> expected ${expected}, got ${names.join(',') || '(no tools)'}`);
  }

  for (const chat of ['Explain why sleep matters.', 'What is the capital of France?', 'Tell me about black holes.']) {
    const selected = selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: chat });
    assert.deepEqual(selected.map((tool) => tool.function.name), [], `abstract chat should stay tool-free: ${chat}`);
  }
});

test('selectToolsForTurn returns all tools for cloud providers and focused relevant tools for local Ollama', () => {
  const cloudTools = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'anthropic',
    userMessage: 'hello there',
  });
  assert.equal(cloudTools.length, TOOL_DEFINITIONS.length);

  const genericLocal = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Refactor server.mjs to clean up error handling and run the tests',
  });
  const genericNames = new Set(genericLocal.map((t) => t.function.name));
  assert.ok(genericLocal.length <= 6, `Expected focused tools for coding prompt, got ${genericLocal.length}`);
  assert.ok(genericNames.has('read_file'));
  assert.ok(genericNames.has('edit_file'));
  assert.ok(genericNames.has('run_command'));
  assert.ok(!genericNames.has('system_stats'));
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

test('compact local prompt + focused tools dramatically cut token overhead below 1200 tokens for 30 skills', () => {
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

  assert.ok(compactPrompt.length < fullPrompt.length * 0.5, `Expected compact prompt (${compactPrompt.length}) < 50% of full (${fullPrompt.length})`);
  assert.match(compactPrompt, /starter-skill-1/);
  assert.match(compactPrompt, /starter-skill-30/);
  // The full skill catalog is name-only locally; descriptions stay reserved for the turn's relevant skills.
  assert.ok(
    !compactPrompt.includes('Comprehensive workflow guide'),
    'Compact prompt should not carry the full catalog descriptions'
  );
  const withSuggested = buildSystemPrompt({
    skills: thirtySkills,
    suggestedSkills: [{ slug: 'starter-skill-7', description: 'Comprehensive workflow guide for handling complex local macOS and engineering tasks safely.' }],
    compact: true,
  });
  assert.match(withSuggested, /Most Relevant Skills/);
  assert.match(withSuggested, /Comprehensive workflow guide/);

  const localTools = compactToolDefinitions(
    selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: 'Fix the bug in app.js' })
  );
  const overheadTokens = Math.ceil(compactPrompt.length / 3.5) + estimateToolsTokens(localTools);
  assert.ok(overheadTokens < 1200, `Expected total local overhead < 1200 tokens, got ${overheadTokens}`);
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
