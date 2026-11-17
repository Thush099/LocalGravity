import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { syncStarterSkills } from '../backend/skills-engine.mjs';
import { ensureKnowledgeSeeded } from '../backend/knowledge-engine.mjs';
import { buildSystemPrompt } from '../backend/agent/prompt.mjs';
import { compactConversation, estimateMessagesTokens } from '../backend/agent/compactor.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';

const execFileAsync = promisify(execFile);

test('buildSystemPrompt includes skills, knowledge index, and MEMORY excerpt cleanly', () => {
  const prompt = buildSystemPrompt({
    skills: [{ slug: 'video-editor', description: 'Edit video with ffmpeg.' }],
    knowledgeDocs: [{ name: 'brand', title: 'Brand Guide' }],
    memoryContent: 'Always export 9:16 60fps.',
    safetyMode: 'ask',
    isHeadless: false,
    allowAutoRun: false,
  });
  assert.match(prompt, /video-editor/);
  assert.match(prompt, /Brand Guide/);
  assert.match(prompt, /Always export 9:16 60fps/);
  assert.match(prompt, /read_skill/);
  assert.match(prompt, /search_knowledge/);
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

  await fs.rm(tmpRoot, { recursive: true, force: true });
});
