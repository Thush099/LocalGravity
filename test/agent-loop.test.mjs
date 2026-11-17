import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { syncStarterSkills, readSkill } from '../backend/skills-engine.mjs';
import { ensureKnowledgeSeeded, readKnowledge } from '../backend/knowledge-engine.mjs';
import { buildSystemPrompt } from '../backend/agent/prompt.mjs';
import { compactConversation, estimateMessagesTokens } from '../backend/agent/compactor.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';
import { AUTO_LEARNED_SKILL, LEARNED_FIXES_DOC, normalizeToolCall } from '../backend/agent/self-improver.mjs';

const execFileAsync = promisify(execFile);

test('buildSystemPrompt includes skills, knowledge index, learned fixes, and MEMORY excerpt cleanly', () => {
  const prompt = buildSystemPrompt({
    skills: [{ slug: 'video-editor', description: 'Edit video with ffmpeg.' }],
    knowledgeDocs: [{ name: 'brand', title: 'Brand Guide' }],
    memoryContent: 'Always export 9:16 60fps.',
    learnedFixesContent: '- Avoid broken flag -foo; use -bar.',
    repoPath: '/tmp/my-localgravity-repo',
    safetyMode: 'ask',
    isHeadless: false,
    allowAutoRun: false,
  });
  assert.match(prompt, /video-editor/);
  assert.match(prompt, /Brand Guide/);
  assert.match(prompt, /Always export 9:16 60fps/);
  assert.match(prompt, /Avoid broken flag -foo/);
  assert.match(prompt, /read_skill/);
  assert.match(prompt, /search_knowledge/);
  assert.match(prompt, /save_skill/i);
  assert.match(prompt, /Do NOT call `list_skills`/i);
  assert.match(prompt, /\/tmp\/my-localgravity-repo/);
  assert.match(prompt, /npm test/i);
});

test('normalizeToolCall repairs tool name and parameter aliases automatically', () => {
  const norm1 = normalizeToolCall({
    id: 'c1',
    name: 'bash',
    arguments: { cmd: 'ls -la', dir: '/tmp' },
  });
  assert.equal(norm1.name, 'run_command');
  assert.equal(norm1.arguments.command, 'ls -la');
  assert.equal(norm1.arguments.cwd, '/tmp');
  assert.equal(norm1.repaired, true);

  const norm2 = normalizeToolCall({
    id: 'c2',
    name: 'replace_in_file',
    arguments: { file_path: 'a.js', old_text: 'foo', new_text: 'bar' },
  });
  assert.equal(norm2.name, 'edit_file');
  assert.equal(norm2.arguments.path, 'a.js');
  assert.equal(norm2.arguments.target, 'foo');
  assert.equal(norm2.arguments.replacement, 'bar');
  assert.equal(norm2.repaired, true);
});

test('compactConversation summarizes older turns when exceeding 70% of numCtx', async () => {
  const longText = 'word '.repeat(600);
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: longText },
    { role: 'assistant', content: longText },
    { role: 'user', content: longText },
    { role: 'assistant', content: longText },
    { role: 'user', content: 'recent question' },
    { role: 'assistant', content: 'recent answer' },
  ];
  assert.ok(estimateMessagesTokens(messages) > 2000);
  const compacted = await compactConversation(messages, {
    numCtx: 2500,
    summarizeFn: async () => 'Summary of earlier Mac & media discussion.',
  });
  assert.equal(compacted.compacted, true);
  assert.ok(compacted.messages.some((m) => m.content.includes('Summary of earlier Mac & media discussion')));
  assert.equal(compacted.messages.at(-1).content, 'recent answer');

  // Must not orphan a role:'tool' message after summary
  const toolHeavy = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: longText },
    { role: 'assistant', content: longText },
    { role: 'user', content: 'turn 2' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }] },
    { role: 'tool', toolCallId: 't1', toolName: 'read_file', content: longText },
    { role: 'assistant', content: 'done 2' },
    { role: 'user', content: 'latest ask' },
    { role: 'assistant', content: 'latest reply' },
  ];
  const toolCompacted = await compactConversation(toolHeavy, {
    numCtx: 2500,
    summarizeFn: async () => 'Short summary.',
  });
  assert.equal(toolCompacted.compacted, true);
  const afterSummary = toolCompacted.messages.findIndex((m) => m.isCompactionSummary);
  assert.equal(toolCompacted.messages[afterSummary + 1].role, 'user');
  assert.ok(!toolCompacted.messages.some((m, i) => m.role === 'tool' && toolCompacted.messages[i - 1]?.isCompactionSummary));
});

test('runAgentTurn executes tools, injects inspect_media images, enforces approvals, and respects headless audit', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-loop-'));
  const paths = getRuntimePaths(tmpRoot);
  await syncStarterSkills(paths);
  await ensureKnowledgeSeeded(paths);

  const imgPath = path.join(tmpRoot, 'photo.png');
  await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=160x120', '-frames:v', '1', imgPath]);

  let turnIdx = 0;
  const seenCalls = [];
  const fakeChat = async ({ messages }) => {
    seenCalls.push(messages);
    turnIdx++;
    if (turnIdx === 1) {
      return {
        thinking: 'Checking photo',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'inspect_media', arguments: { path: imgPath } }],
      };
    }
    if (turnIdx === 2) {
      return {
        thinking: '',
        content: '',
        toolCalls: [{ id: 'tc2', name: 'run_command', arguments: { command: 'touch "' + path.join(tmpRoot, 'created.txt') + '"' } }],
      };
    }
    if (turnIdx === 3) {
      return {
        thinking: '',
        content: '',
        toolCalls: [{ id: 'tc3', name: 'run_command', arguments: { command: 'rm -rf ~' } }],
      };
    }
    return { thinking: '', content: 'All done safely.', toolCalls: [] };
  };

  const events = [];
  const approvals = [];
  const session = { id: 'loop-1', title: 'Test', messages: [] };

  const res = await runAgentTurn({
    session,
    userMessage: 'Inspect photo and test command',
    paths,
    providerConfig: { provider: 'ollama', model: 'qwen3.5:9b', safetyMode: 'ask', numCtx: 16384 },
    chatFn: fakeChat,
    onEvent: (e) => events.push(e),
    requestApproval: async (req) => {
      approvals.push(req);
      return { approved: true };
    },
  });

  assert.equal(res.status, 'completed');
  assert.equal(approvals.length, 1);
  assert.ok(seenCalls[1].some((m) => Array.isArray(m.images) && m.images.length === 1));
  const blockedEvt = events.find((e) => e.type === 'tool_result' && e.toolCallId === 'tc3');
  assert.match(blockedEvt.output, /Blocked/i);

  const createdStat = await fs.stat(path.join(tmpRoot, 'created.txt'));
  assert.ok(createdStat.isFile());

  // Headless audit mode must block mutating command without asking
  let headlessStep = 0;
  const headlessEvents = [];
  await runAgentTurn({
    session: { id: 'loop-2', title: 'Headless', messages: [] },
    userMessage: 'Run cleanup',
    paths,
    isHeadless: true,
    allowAutoRun: false,
    providerConfig: { provider: 'ollama', model: 'qwen3.5:9b', safetyMode: 'ask', numCtx: 16384 },
    chatFn: async () => {
      headlessStep++;
      if (headlessStep === 1) {
        return {
          thinking: '',
          content: '',
          toolCalls: [{ id: 'hc1', name: 'run_command', arguments: { command: 'touch /tmp/nope' } }],
        };
      }
      return { thinking: '', content: 'Audit complete.', toolCalls: [] };
    },
    onEvent: (e) => headlessEvents.push(e),
  });

  const hcRes = headlessEvents.find((e) => e.type === 'tool_result' && e.toolCallId === 'hc1');
  assert.match(hcRes.output, /Blocked/i);

  // Multi-tool step with inspect_media must place visual user message AFTER all tool responses and never persist synthetic msg
  let multiStep = 0;
  let multiMessagesSent = null;
  const multiSession = { id: 'loop-multi', title: 'Multi', messages: [] };
  await runAgentTurn({
    session: multiSession,
    userMessage: 'Check photo and skills',
    paths,
    providerConfig: { provider: 'ollama', model: 'qwen3.5:9b', safetyMode: 'ask', numCtx: 16384 },
    chatFn: async ({ messages }) => {
      multiStep++;
      if (multiStep === 1) {
        return {
          thinking: '',
          content: '',
          toolCalls: [
            { id: 'm1', name: 'inspect_media', arguments: { path: imgPath } },
            { id: 'm2', name: 'list_skills', arguments: {} },
          ],
        };
      }
      multiMessagesSent = messages;
      return { thinking: '', content: 'Inspected both.', toolCalls: [] };
    },
  });
  const m1Idx = multiMessagesSent.findIndex((m) => m.toolCallId === 'm1');
  const m2Idx = multiMessagesSent.findIndex((m) => m.toolCallId === 'm2');
  const visIdx = multiMessagesSent.findIndex((m) => Array.isArray(m.images) && m.images.length > 0 && m.role === 'user');
  assert.equal(m2Idx, m1Idx + 1);
  assert.equal(visIdx, m2Idx + 1);
  assert.equal(multiSession.messages.some((m) => String(m.content).includes('[Visual media attachment')), false);

  // Step-0 failure must still persist user turn and error on disk
  const errSession = { id: 'loop-err', title: 'Err', messages: [] };
  const { loadSession } = await import('../backend/state/storage.mjs');
  await runAgentTurn({
    session: errSession,
    userMessage: 'Persist on fail',
    paths,
    providerConfig: { provider: 'ollama', model: 'qwen3.5:9b' },
    chatFn: async () => {
      throw new Error('Ollama unreachable');
    },
  });
  const savedErrSession = await loadSession('loop-err', paths);
  assert.ok(savedErrSession.messages.some((m) => m.role === 'user' && m.content === 'Persist on fail'));
  assert.ok(savedErrSession.messages.some((m) => m.role === 'assistant' && m.content.includes('Ollama unreachable')));

  // KV-cache stability: systemPrompt must stay identical across steps in a turn even after save_skill runs
  let kvStep = 0;
  const sysPrompts = [];
  await runAgentTurn({
    session: { id: 'loop-kv', title: 'KV', messages: [] },
    userMessage: 'Save a skill and reply',
    paths,
    providerConfig: { provider: 'ollama', model: 'qwen3.5:4b', safetyMode: 'ask', numCtx: 8192 },
    chatFn: async ({ messages }) => {
      sysPrompts.push(messages[0].content);
      kvStep++;
      if (kvStep === 1) {
        return {
          thinking: '',
          content: '',
          toolCalls: [{ id: 'kv1', name: 'save_skill', arguments: { name: 'kv-test', description: 'KV test', content: '# Hi' } }],
        };
      }
      return { thinking: '', content: 'Done.', toolCalls: [] };
    },
  });
  assert.equal(sysPrompts.length, 2);
  assert.equal(sysPrompts[0], sysPrompts[1]);

  // Self-improvement engine: recovers from failed tool + empty output, breaks duplicate loops, and persists learned fixes & skill
  let healStep = 0;
  const healEvents = [];
  const healSession = { id: 'loop-heal', title: 'Heal', messages: [] };
  await runAgentTurn({
    session: healSession,
    userMessage: 'Read file and recover from mistakes',
    paths,
    providerConfig: { provider: 'ollama', model: 'qwen3.5:9b', safetyMode: 'auto', numCtx: 8192 },
    chatFn: async () => {
      healStep++;
      if (healStep === 1) {
        // Fails with missing file
        return {
          thinking: 'Try reading nonexistent file',
          content: '',
          toolCalls: [{ id: 'h1', name: 'read_file', arguments: { file_path: path.join(tmpRoot, 'does-not-exist.txt') } }],
        };
      }
      if (healStep === 2) {
        // Succeeds on existing file, triggering Broken -> Working recovery learning
        return {
          thinking: 'Now read real file',
          content: '',
          toolCalls: [{ id: 'h2', name: 'read_file', arguments: { path: path.join(tmpRoot, 'created.txt') } }],
        };
      }
      if (healStep === 3) {
        // Duplicate call loop attempt
        return {
          thinking: 'Repeat exact same read_file',
          content: '',
          toolCalls: [{ id: 'h3', name: 'read_file', arguments: { path: path.join(tmpRoot, 'created.txt') } }],
        };
      }
      // Returns empty content with thinking only -> must synthesize output instead of leaving blank!
      return {
        thinking: 'The file created.txt exists and was verified cleanly.',
        content: '',
        toolCalls: [],
      };
    },
    onEvent: (e) => healEvents.push(e),
  });

  const lastMsg = healSession.messages.at(-1);
  assert.equal(lastMsg.role, 'assistant');
  assert.ok(lastMsg.content.length > 0, 'Must never leave empty assistant output');
  assert.ok(healEvents.some((e) => e.type === 'self_improved' && e.lessons.length > 0));

  const learnedDoc = await readKnowledge(LEARNED_FIXES_DOC, paths);
  assert.ok(learnedDoc && learnedDoc.content.includes('read_file'));
  const learnedSkill = await readSkill(AUTO_LEARNED_SKILL, paths);
  assert.ok(learnedSkill && learnedSkill.content.includes('read_file'));

  await fs.rm(tmpRoot, { recursive: true, force: true });
});
