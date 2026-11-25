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

test('pure provided-text turns stay tool-free while referenced-file turns keep tools', () => {
  const transforms = [
    'Humanize this paragraph so it reads naturally: The utilization of the system facilitates many workflows.',
    'Summarize this text in one line: The quick brown fox jumps over the lazy dog and keeps running.',
    'Rewrite this to be concise: The utilization of the system facilitates many things.',
    'Paraphrase this sentence: The quick brown fox jumps over the lazy dog and keeps going.',
  ];
  for (const message of transforms) {
    const selected = selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: message });
    assert.deepEqual(selected.map((t) => t.function.name), [], `provided-text transform should stay tool-free: ${message}`);
  }
  // Requests that point at real files or actions still get tools (regression guards).
  const referenced = [
    ['Summarize this document', 'read_file'],
    ['Clean up my downloads folder', 'run_command'],
    ['Can you fix this for me?', 'edit_file'],
    ['Clean up and organize files in my Downloads folder by moving them into subfolders.', 'move_file'],
  ];
  for (const [message, expected] of referenced) {
    const selected = selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: message });
    const names = selected.map((t) => t.function.name);
    assert.ok(names.includes(expected), `${message} -> expected ${expected}, got ${names.join(',') || '(no tools)'}`);
  }
});

test('tool-free turns get a lean prompt without tool or skill catalog overhead', () => {
  const shared = {
    compact: true,
    skills: [{ slug: 'a-skill', description: 'does a thing' }],
    knowledgeDocs: [{ name: 'doc', title: 'A doc' }],
  };
  const lean = buildSystemPrompt({ ...shared, hasTools: false });
  const full = buildSystemPrompt({ ...shared, hasTools: true });
  assert.match(lean, /concisely/i);
  assert.doesNotMatch(lean, /read_skill|## Skills|## Knowledge/);
  assert.ok(lean.length < full.length, `lean (${lean.length}) should be shorter than full (${full.length})`);
});

test('pasted prose after a colon stays tool-free even when it mentions system words', () => {
  // The text after the colon is content to rewrite, not a request to inspect the system.
  for (const message of [
    'Humanize this: The system is fast',
    'Rewrite this: the quick brown fox jumps over the lazy dog while the disk spins',
  ]) {
    const names = selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: message }).map((t) => t.function.name);
    assert.equal(names.length, 0, `${message} should be tool-free, got ${names.join(',')}`);
  }
  // A code request ("this component") or a file reference keeps its tools.
  for (const fileWork of ['Rewrite this component to be faster', 'Rewrite README.md', 'Rewrite this: README.md', 'Translate report.pdf to English']) {
    const names = selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: fileWork }).map((t) => t.function.name);
    assert.ok(names.includes('edit_file'), `${fileWork} should keep file tools, got ${names.join(',') || 'none'}`);
  }
});

test('undo phrasings surface undo_file_moves while ordinary edits do not', () => {
  const undoPhrasings = ['Undo the file moves', 'Revert the organize I just did', 'Put the files back where they were'];
  for (const message of undoPhrasings) {
    const names = selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: message }).map((t) => t.function.name);
    assert.ok(names.includes('undo_file_moves'), `${message} -> expected undo_file_moves, got ${names.join(',') || '(no tools)'}`);
  }
  const editNames = selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: 'Can you fix this for me?' }).map((t) => t.function.name);
  assert.ok(!editNames.includes('undo_file_moves'), 'ordinary edits should not surface undo_file_moves');
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

test('file-organization requests receive plan and move tools instead of shell-only fallback', () => {
  const namesFor = (message) =>
    new Set(
      selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: message }).map((tool) => tool.function.name)
    );

  const organize = namesFor('Organize my Downloads folder into subfolders');
  assert.ok(organize.has('update_plan'), 'multi-step organization should publish progress');
  assert.ok(organize.has('move_file'), 'file moves must not require shell quoting');

  const rename = namesFor('Rename these report files to include the date');
  assert.ok(rename.has('move_file'));
  assert.ok(rename.has('update_plan'));
});

test('inbox requests reach the mail tool however the qualifiers are ordered', () => {
  const inbox = [
    'Summarize my unread emails and flag anything urgent.',
    'check my inbox',
    'anything urgent in my mail?',
    'read my new email',
  ];
  for (const message of inbox) {
    const names = selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: message }).map(
      (t) => t.function.name
    );
    assert.ok(names.includes('read_email'), `${message} -> ${names.join(',') || '(none)'}`);
  }
  // A pasted email to rewrite is still a text transform, not an inbox read.
  assert.deepEqual(
    selectToolsForTurn(TOOL_DEFINITIONS, {
      provider: 'ollama',
      userMessage: 'Rewrite this email: hi team, attached is the report for your review.',
    }),
    []
  );
});

test('a bare mention of today does not drag the timetable into unrelated turns', () => {
  const names = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'what did I work on today?',
  }).map((t) => t.function.name);
  assert.ok(!names.includes('add_schedule_item'), names.join(',') || '(none)');
  const scheduled = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'what is on my schedule today?',
  }).map((t) => t.function.name);
  assert.ok(scheduled.includes('list_schedule_items'), scheduled.join(',') || '(none)');
});

test('everyday system asks reach a real tool instead of none', () => {
  const cases = [
    ["what's the weather like today", 'daily_briefing'],
    ['any rain this afternoon?', 'daily_briefing'],
    ["what's my IP address", 'run_command'],
    ['turn off wifi', 'run_applescript'],
    ['turn on do not disturb', 'run_applescript'],
    ['empty my trash', 'run_command'],
    ['what time is it in Tokyo', 'run_command'],
  ];
  for (const [message, expected] of cases) {
    const names = selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: message }).map(
      (t) => t.function.name
    );
    assert.ok(names.includes(expected), `${message} should reach ${expected}, got ${names.join(',') || '(none)'}`);
  }
});

test('a link in the message is fetched instead of being treated as pasted text', () => {
  const names = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Summarize this article: https://example.com/post',
  }).map((t) => t.function.name);
  assert.ok(names.includes('fetch_url'), `expected fetch_url, got ${names.join(',') || '(none)'}`);
});

test('a volume change does not load the calculator', () => {
  const names = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'set the volume to 30 percent',
  }).map((t) => t.function.name);
  assert.ok(!names.includes('calculate'), 'percent as a level is not a calculation');
  assert.ok(names.includes('run_applescript'));
  const math = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'calculate 18 percent of 240',
  }).map((t) => t.function.name);
  assert.ok(math.includes('calculate'), 'a real percentage calculation still gets the calculator');
});

test('drafting a reply reads the mail first', () => {
  const names = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'draft a reply to the Hult Prize email',
  }).map((t) => t.function.name);
  assert.ok(names.includes('read_email'), `expected read_email, got ${names.join(',') || '(none)'}`);
});

test('a file move does not drag screenshot capture along', () => {
  const names = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'move the screenshots on my desktop into a folder called Shots',
  }).map((t) => t.function.name);
  assert.ok(names.includes('move_file'));
  assert.ok(!names.includes('take_screenshot'), 'moving saved screenshots does not capture the screen');
});