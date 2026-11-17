import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureKnowledgeSeeded, listKnowledge, readKnowledge } from '../knowledge-engine.mjs';
import { streamAnthropicChat } from '../providers/anthropic.mjs';
import { DEFAULT_OLLAMA_URL, streamOllamaChat } from '../providers/ollama.mjs';
import { CLOUD_PRESETS, streamOpenAIChat } from '../providers/openai-compat.mjs';
import { listSkills, syncStarterSkills } from '../skills-engine.mjs';
import { getRepoPath, getRuntimePaths } from '../state/paths.mjs';
import { saveSession } from '../state/storage.mjs';
import { executeToolCall, evaluateToolSafety, generateToolPreview, TOOL_DEFINITIONS } from '../tools/registry.mjs';
import { compactConversation, estimateMessagesTokens } from './compactor.mjs';
import { buildSystemPrompt } from './prompt.mjs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic', '.gif', '.tiff', '.bmp']);

function resolveProviderChatFn(providerConfig = {}) {
  const provider = providerConfig.provider || 'ollama';
  if (provider === 'ollama') {
    return (req) =>
      streamOllamaChat({
        baseUrl: providerConfig.ollamaUrl || DEFAULT_OLLAMA_URL,
        model: providerConfig.model || 'qwen3.5:9b',
        messages: req.messages,
        tools: req.tools,
        thinking: providerConfig.thinking ?? true,
        numCtx: providerConfig.numCtx || 16384,
        signal: req.signal,
        onEvent: req.onEvent,
      });
  }

  if (provider === 'anthropic') {
    const apiKey = providerConfig.apiKeys?.anthropic || providerConfig.apiKey || '';
    return (req) =>
      streamAnthropicChat({
        baseUrl: providerConfig.customBaseUrl || CLOUD_PRESETS.anthropic.baseUrl,
        apiKey,
        model: providerConfig.model || CLOUD_PRESETS.anthropic.defaultModel,
        messages: req.messages,
        tools: req.tools,
        signal: req.signal,
        onEvent: req.onEvent,
      });
  }

  const preset = CLOUD_PRESETS[provider] || CLOUD_PRESETS.custom;
  const baseUrl =
    provider === 'custom'
      ? providerConfig.customBaseUrl || preset.baseUrl
      : preset.baseUrl;
  const apiKey = providerConfig.apiKeys?.[provider] || providerConfig.apiKey || '';
  return (req) =>
    streamOpenAIChat({
      baseUrl,
      apiKey,
      model: providerConfig.model || preset.defaultModel,
      messages: req.messages,
      tools: req.tools,
      signal: req.signal,
      onEvent: req.onEvent,
      extraHeaders:
        provider === 'openrouter'
          ? { 'HTTP-Referer': 'https://github.com/Thush099/LocalGravity', 'X-Title': 'LocalGravity' }
          : {},
    });
}

async function prepareAttachmentContext(attachments = [], paths) {
  const images = [];
  const notes = [];

  for (const rawPath of attachments) {
    if (!rawPath) continue;
    const ext = path.extname(String(rawPath)).toLowerCase();
    notes.push(`- Attached path: ${rawPath}`);
    if (IMAGE_EXTENSIONS.has(ext)) {
      const inspected = await executeToolCall({ name: 'inspect_media', args: { path: rawPath } }, { paths });
      if (inspected.ok && Array.isArray(inspected.images)) {
        images.push(...inspected.images);
      }
    }
  }
  return { images, notes };
}

function buildModelMessages(systemPrompt, sessionMessages, provider = 'ollama') {
  const out = [{ role: 'system', content: systemPrompt }];
  let pendingToolImages = [];

  const flushImages = () => {
    if (provider !== 'anthropic' && pendingToolImages.length > 0) {
      out.push({
        role: 'user',
        content: '[Visual media inspection frames attached from inspect_media]',
        images: pendingToolImages,
      });
    }
    pendingToolImages = [];
  };

  for (const msg of sessionMessages) {
    if (msg.role === 'system') continue;
    if (msg.role !== 'tool') {
      flushImages();
      out.push(msg);
    } else {
      out.push(msg);
      if (Array.isArray(msg.images) && msg.images.length > 0) {
        pendingToolImages.push(...msg.images);
      }
    }
  }
  flushImages();
  return out;
}

/**
 * Execute an iterative ReAct agent turn with streaming events, interactive approval, and vision feedback.
 */
export async function runAgentTurn({
  session,
  userMessage,
  attachments = [],
  paths = getRuntimePaths(),
  providerConfig = {},
  isHeadless = false,
  allowAutoRun = false,
  maxSteps = 25,
  chatFn,
  onEvent,
  requestApproval,
  abortSignal,
  persistSession = true,
  cwd,
}) {
  await syncStarterSkills(paths);
  await ensureKnowledgeSeeded(paths);

  const attached = await prepareAttachmentContext(attachments, paths);
  const fullUserText =
    attached.notes.length > 0
      ? `${String(userMessage || '').trim()}\n\n[Attached files]\n${attached.notes.join('\n')}`
      : String(userMessage || '').trim();

  if (!Array.isArray(session.messages)) session.messages = [];
  if (fullUserText || attached.images.length > 0) {
    session.messages.push({
      role: 'user',
      content: fullUserText,
      attachments: attachments.length > 0 ? attachments : undefined,
      images: attached.images.length > 0 ? attached.images : undefined,
      createdAt: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    if (persistSession) await saveSession(session, paths);
  }

  const activeChatFn = chatFn || resolveProviderChatFn(providerConfig);
  const safetyMode = providerConfig.safetyMode || 'ask';
  const numCtx = Number(providerConfig.numCtx) || 8192;
  const provider = providerConfig.provider || 'ollama';

  const [skills, knowledgeDocs, memoryDoc] = await Promise.all([
    listSkills(paths),
    listKnowledge(paths),
    readKnowledge('MEMORY', paths),
  ]);

  const systemPrompt = buildSystemPrompt({
    skills,
    knowledgeDocs,
    memoryContent: memoryDoc?.content || '',
    repoPath: getRepoPath(),
    safetyMode,
    isHeadless,
    allowAutoRun,
    cwd,
  });

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (abortSignal?.aborted) {
        onEvent?.({ type: 'done', status: 'cancelled' });
        return { session, status: 'cancelled' };
      }

      const compacted = await compactConversation(session.messages, {
        numCtx,
        summarizeFn: async (transcript) => {
          const sumRes = await activeChatFn({
            messages: [
              { role: 'system', content: 'Summarize this conversation concisely, preserving file paths, decisions, and edited outputs.' },
              { role: 'user', content: transcript },
            ],
            tools: [],
            signal: abortSignal,
          });
          return sumRes.content;
        },
      });

      if (compacted.compacted) {
        session.messages = compacted.messages.filter((m) => m.role !== 'system');
        onEvent?.({
          type: 'compacted',
          tokensBefore: compacted.tokensBefore,
          tokensAfter: compacted.tokensAfter,
        });
      }

      const modelMessages = buildModelMessages(systemPrompt, session.messages, provider);

      onEvent?.({
        type: 'context_stats',
        tokens: estimateMessagesTokens(modelMessages),
        numCtx,
      });

      const response = await activeChatFn({
        messages: modelMessages,
        tools: TOOL_DEFINITIONS,
        signal: abortSignal,
        onEvent,
      });

      const assistantEntry = {
        role: 'assistant',
        content: response.content || '',
        thinking: response.thinking || '',
        toolCalls: Array.isArray(response.toolCalls) && response.toolCalls.length > 0 ? response.toolCalls : undefined,
        createdAt: new Date().toISOString(),
      };
      session.messages.push(assistantEntry);

      if (!assistantEntry.toolCalls || assistantEntry.toolCalls.length === 0) {
        session.updatedAt = new Date().toISOString();
        if (persistSession) await saveSession(session, paths);
        onEvent?.({ type: 'done', status: 'completed', usage: response.usage || {} });
        return { session, status: 'completed' };
      }

      for (const tc of assistantEntry.toolCalls) {
        if (abortSignal?.aborted) {
          onEvent?.({ type: 'done', status: 'cancelled' });
          return { session, status: 'cancelled' };
        }

        if (tc.parseError) {
          const errOut = `Tool call "${tc.name}" failed JSON parsing: ${tc.parseError}. Re-emit valid JSON arguments.`;
          session.messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: errOut });
          onEvent?.({ type: 'tool_result', toolCallId: tc.id, name: tc.name, ok: false, output: errOut });
          continue;
        }

        let effectiveArgs = { ...(tc.arguments || {}) };
        onEvent?.({ type: 'tool_call', toolCallId: tc.id, name: tc.name, arguments: effectiveArgs });

        const gate = evaluateToolSafety(
          { name: tc.name, args: effectiveArgs },
          {
            safetyMode,
            isHeadless,
            allowAutoRun,
            skillsDir: paths.skillsDir,
            knowledgeDir: paths.knowledgeDir,
            allowedReadCommands: providerConfig.allowedReadCommands || [],
          }
        );

        if (gate.decision === 'block') {
          const blockedMsg = `Blocked by safety policy: ${gate.reason}`;
          session.messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: blockedMsg });
          onEvent?.({ type: 'tool_result', toolCallId: tc.id, name: tc.name, ok: false, output: blockedMsg });
          continue;
        }

        if (gate.decision === 'ask') {
          const preview = gate.preview || (await generateToolPreview({ name: tc.name, args: effectiveArgs }));
          onEvent?.({
            type: 'approval_required',
            toolCallId: tc.id,
            name: tc.name,
            arguments: effectiveArgs,
            reason: gate.reason,
            preview,
          });

          const decision = requestApproval
            ? await requestApproval({ toolCallId: tc.id, name: tc.name, arguments: effectiveArgs, reason: gate.reason, preview })
            : { approved: false, reason: 'No interactive approval handler available.' };

          if (!decision?.approved) {
            const deniedMsg = `User denied ${tc.name}: ${decision?.reason || 'Cancelled by user.'}`;
            session.messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: deniedMsg });
            onEvent?.({ type: 'tool_result', toolCallId: tc.id, name: tc.name, ok: false, output: deniedMsg });
            continue;
          }

          if (tc.name === 'run_command' && typeof decision.editedCommand === 'string' && decision.editedCommand.trim()) {
            effectiveArgs.command = decision.editedCommand.trim();
            const recheck = evaluateToolSafety(
              { name: tc.name, args: effectiveArgs },
              { safetyMode: 'auto', isHeadless, allowAutoRun, skillsDir: paths.skillsDir, knowledgeDir: paths.knowledgeDir }
            );
            if (recheck.decision === 'block') {
              const blockedMsg = `Blocked edited command: ${recheck.reason}`;
              session.messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: blockedMsg });
              onEvent?.({ type: 'tool_result', toolCallId: tc.id, name: tc.name, ok: false, output: blockedMsg });
              continue;
            }
          }
        }

        const result = await executeToolCall(
          { name: tc.name, args: effectiveArgs },
          {
            paths,
            cwd,
            abortSignal,
            onStdout: (chunk) => onEvent?.({ type: 'tool_output', toolCallId: tc.id, stream: 'stdout', text: chunk }),
            onStderr: (chunk) => onEvent?.({ type: 'tool_output', toolCallId: tc.id, stream: 'stderr', text: chunk }),
          }
        );

        session.messages.push({
          role: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          content: result.output,
          images: result.images,
          diff: result.diff,
        });

        onEvent?.({
          type: 'tool_result',
          toolCallId: tc.id,
          name: tc.name,
          ok: result.ok,
          output: result.output,
          diff: result.diff,
          images: result.images,
        });
      }

      session.updatedAt = new Date().toISOString();
      if (persistSession) await saveSession(session, paths);
    }

    const maxStepsMsg = `Reached maximum step limit (${maxSteps}) for this turn.`;
    session.messages.push({ role: 'assistant', content: maxStepsMsg, createdAt: new Date().toISOString() });
    if (persistSession) await saveSession(session, paths);
    onEvent?.({ type: 'text_delta', text: `\n\n${maxStepsMsg}` });
    onEvent?.({ type: 'done', status: 'completed' });
    return { session, status: 'completed' };
  } catch (err) {
    if (abortSignal?.aborted || err.name === 'AbortError') {
      session.updatedAt = new Date().toISOString();
      if (persistSession) await saveSession(session, paths).catch(() => {});
      onEvent?.({ type: 'done', status: 'cancelled' });
      return { session, status: 'cancelled' };
    }
    session.messages.push({
      role: 'assistant',
      content: `> Error: ${err.message}`,
      isError: true,
      createdAt: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    if (persistSession) await saveSession(session, paths).catch(() => {});
    onEvent?.({ type: 'error', message: err.message });
    return { session, status: 'error', error: err.message };
  }
}
