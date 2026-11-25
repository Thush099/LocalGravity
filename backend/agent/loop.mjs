import os from 'node:os';
import path from 'node:path';
import { runInstantAction } from '../actions.mjs';
import { ensureKnowledgeSeeded, listKnowledge, readKnowledge } from '../knowledge-engine.mjs';
import { streamAnthropicChat } from '../providers/anthropic.mjs';
import { DEFAULT_OLLAMA_URL, streamOllamaChat } from '../providers/ollama.mjs';
import { CLOUD_PRESETS, streamOpenAIChat } from '../providers/openai-compat.mjs';
import { listSkills, syncStarterSkills } from '../skills-engine.mjs';
import { getRepoPath, getRuntimePaths } from '../state/paths.mjs';
import { saveConfig, saveSession } from '../state/storage.mjs';
import { executeToolCall, evaluateToolSafety, generateToolPreview, TOOL_DEFINITIONS } from '../tools/registry.mjs';
import { compactConversation, estimateMessagesTokens, estimateToolsTokens } from './compactor.mjs';
import { captureExplicitMemory } from './memory-capture.mjs';
import { buildSystemPrompt } from './prompt.mjs';
import { selectRelevantSkills } from './skill-match.mjs';
import { planCompletionNote, planNudgeMessage, unfinishedPlanSteps } from './plan-accountability.mjs';
import { goalContinuityNote, loadOpenGoals, persistGoalState } from './goal-continuity.mjs';
import { compactToolDefinitions, selectToolsForTurn } from './tool-selector.mjs';
import {
  loadLearnedFixesExcerpt,
  normalizeToolCall,
  persistTurnLearnings,
  synthesizeFallbackOutput,
  TurnStruggleTracker,
} from './self-improver.mjs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic', '.gif', '.tiff', '.bmp']);
const DIRECT_DIRECTORY_LIST_RE =
  /\bwhat(?:'s| is) in (?:this|the current|my) (?:folder|directory)(?=\s*(?:[?.!]|$)|\s+(?:just|only|please|show|list|tell)\b)|\bwhat files (?:are )?here\b|\b(?:list|show)(?: me)? (?:the )?(?:top[- ]level )?(?:entries|files|folders|contents) (?:in|of|inside) (?:this|the current|my) (?:folder|directory)(?=\s*(?:[?.!]|$))|\b(?:list|show)(?: me)? (?:the )?(?:top[- ]level )?(?:entries|files|folders|contents) here\b/i;
const seededRoots = new Set();

function resolveProviderChatFn(providerConfig = {}) {
  const provider = providerConfig.provider || 'ollama';
  const fallbackProviders = Array.isArray(providerConfig.fallbackProviders) ? providerConfig.fallbackProviders : [];

  const primaryFn = (req) => {
    if (provider === 'ollama') {
      return streamOllamaChat({
        baseUrl: providerConfig.ollamaUrl || DEFAULT_OLLAMA_URL,
        model: providerConfig.model || 'qwen3.5:4b',
        messages: req.messages,
        tools: req.tools,
        thinking: providerConfig.thinking ?? false,
        numCtx: providerConfig.numCtx || 8192,
        signal: req.signal,
        onEvent: req.onEvent,
      });
    }

    if (provider === 'anthropic') {
      const apiKey = providerConfig.apiKeys?.anthropic || providerConfig.apiKey || '';
      return streamAnthropicChat({
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
    const extraH = providerConfig.customHeaders || {};
    if (provider === 'openrouter' && !extraH['HTTP-Referer']) {
      extraH['HTTP-Referer'] = 'https://github.com/Thush099/LocalGravity';
      extraH['X-Title'] = 'LocalGravity';
    }
    return streamOpenAIChat({
      baseUrl,
      apiKey,
      model: providerConfig.model || preset.defaultModel,
      messages: req.messages,
      tools: req.tools,
      signal: req.signal,
      onEvent: req.onEvent,
      extraHeaders: extraH,
    });
  };

  if (fallbackProviders.length === 0) return primaryFn;

  return async (req) => {
    let lastErr;
    try {
      return await primaryFn(req);
    } catch (err) {
      lastErr = err;
      onEvent?.({ type: 'text_delta', text: `\n[Primary provider failed: ${err.message}. Trying fallback...]\n` });
    }

    for (const fb of fallbackProviders) {
      try {
        const fbConfig = { ...providerConfig, provider: fb.provider, model: fb.model || providerConfig.model };
        const fbFn = resolveProviderChatFn({ ...fbConfig, fallbackProviders: [] });
        return await fbFn(req);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };
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

export function buildModelMessages(systemPrompt, sessionMessages, provider = 'ollama') {
  const out = [{ role: 'system', content: systemPrompt }];
  const isAnthropic = provider === 'anthropic';
  let pendingToolImages = [];

  const flushImages = () => {
    if (!isAnthropic && pendingToolImages.length > 0) {
      out.push({
        role: 'user',
        content: '[Visual media inspection frames attached from inspect_media]',
        images: pendingToolImages,
      });
    }
    pendingToolImages = [];
  };

  const totalCount = sessionMessages.length;
  for (let idx = 0; idx < totalCount; idx++) {
    const msg = sessionMessages[idx];
    if (msg.role === 'system') continue;
    if (msg.role !== 'tool') {
      flushImages();
      out.push(msg);
    } else {
      // Trim older giant tool outputs so local models don't bog down on multi-step turns
      const isOlderTool = idx < totalCount - 4;
      const rawContent = String(msg.content || '');
      const trimmedContent =
        isOlderTool && rawContent.length > 2400
          ? `${rawContent.slice(0, 2200)}\n... [earlier tool output truncated for speed]`
          : rawContent;
      const toolMsg = { ...msg, content: trimmedContent };
      if (Array.isArray(msg.images) && msg.images.length > 0) {
        pendingToolImages.push(...msg.images);
        if (!isAnthropic) {
          // Ollama / OpenAI-compatible providers receive these frames via the synthetic
          // user message from flushImages(). Strip them from the tool message so the same
          // vision frames are never uploaded twice (which double-bills context tokens).
          delete toolMsg.images;
        }
      }
      out.push(toolMsg);
    }
  }
  flushImages();
  return out;
}

/**
 * Execute an iterative ReAct agent turn with streaming events, interactive approval, vision feedback,
 * and autonomous self-healing / mistake learning.
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
  mode = 'auto',
  cwd,
  instantAction,
}) {
  const turnStartedAt = Date.now();
  if (!seededRoots.has(paths.root)) {
    await syncStarterSkills(paths);
    await ensureKnowledgeSeeded(paths);
    seededRoots.add(paths.root);
  }

  const attached = await prepareAttachmentContext(attachments, paths);
  const fullUserText =
    attached.notes.length > 0
      ? `${String(userMessage || '').trim()}\n\n[Attached files]\n${attached.notes.join('\n')}`
      : String(userMessage || '').trim();

  // Deterministic memory capture: an explicit "remember that …" is persisted
  // even if the model never calls the knowledge tool itself. Matches the raw
  // user message so attached-file notes can never mask the request.
  await captureExplicitMemory(userMessage, paths);

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

  const provider = providerConfig.provider || 'ollama';

  // Instant actions run deterministically on-device with no model round-trip, so the
  // common Mac lookups answer immediately instead of waiting on local inference.
  if (instantAction) {
    const result = await runInstantAction(instantAction, { paths, cwd });
    const content = `**${result.title}** — ran on your Mac\n\n${result.output}`;
    const usage = { durationMs: Math.max(1, Date.now() - turnStartedAt), model: '' };
    session.messages.push({ role: 'assistant', content, usage, createdAt: new Date().toISOString() });
    session.updatedAt = new Date().toISOString();
    if (persistSession) await saveSession(session, paths);
    onEvent?.({ type: 'text_delta', text: content });
    onEvent?.({ type: 'done', status: result.ok ? 'completed' : 'error', usage });
    return { session, status: result.ok ? 'completed' : 'error' };
  }

  if (
    provider === 'ollama' &&
    attachments.length === 0 &&
    DIRECT_DIRECTORY_LIST_RE.test(fullUserText)
  ) {
    const toolCallId = `direct_list_${Date.now().toString(36)}`;
    const args = { path: cwd || os.homedir(), recursive: false, max_entries: 50 };
    onEvent?.({ type: 'tool_call', toolCallId, name: 'list_dir', arguments: args });
    const result = await executeToolCall({ name: 'list_dir', args }, { paths, cwd });
    onEvent?.({ type: 'tool_result', toolCallId, name: 'list_dir', ok: result.ok, output: result.output });

    const directoryName = path.basename(args.path) || args.path;
    const entries = result.ok
      ? String(result.output || '')
          .split(/\r?\n/)
          .slice(1)
          .map((line) =>
            line
              .replace(/^\[(?:DIR|FILE)\]\s*/, '')
              .replace(/\s+\(\d+(?:\.\d+)?\s(?:B|KB|MB|GB)\)$/, '')
          )
          .filter(Boolean)
      : [];
    const content = !result.ok
      ? `Could not list ${directoryName}: ${result.output || 'directory access failed.'}`
      : entries.length
        ? `Top-level entries in ${directoryName}:\n${entries.map((entry) => `- ${entry}`).join('\n')}`
        : `The ${directoryName} folder is empty.`;
    const usage = {
      durationMs: Math.max(1, Date.now() - turnStartedAt),
      model: providerConfig.model || '',
    };
    session.messages.push({ role: 'assistant', content, usage, createdAt: new Date().toISOString() });
    session.updatedAt = new Date().toISOString();
    if (persistSession) await saveSession(session, paths);
    onEvent?.({ type: 'text_delta', text: content });
    onEvent?.({ type: 'done', status: 'completed', usage });
    return { session, status: 'completed' };
  }

  const activeChatFn = chatFn || resolveProviderChatFn(providerConfig);
  const safetyMode = providerConfig.safetyMode || 'ask';
  const numCtx = Number(providerConfig.numCtx) || 8192;
  const tracker = new TurnStruggleTracker();
  const executedToolResults = [];
  let emptyOutputRetried = false;
  let latestPlan = null;
  let planNudged = false;

  const [skills, knowledgeDocs, memoryDoc, learnedFixesExcerpt] = await Promise.all([
    listSkills(paths),
    listKnowledge(paths),
    readKnowledge('MEMORY', paths),
    loadLearnedFixesExcerpt(paths),
  ]);

  const suggestedSkills = selectRelevantSkills(skills, fullUserText);

  const isLocalOllama = provider === 'ollama';
  const selectedTools = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider,
    userMessage: fullUserText,
    sessionMessages: session.messages,
    attachments,
    mode,
  });
  const activeTools = isLocalOllama ? compactToolDefinitions(selectedTools) : selectedTools;

  const goalContext = goalContinuityNote(await loadOpenGoals(paths).catch(() => []), fullUserText);
  const systemPrompt = buildSystemPrompt({
    skills,
    suggestedSkills,
    knowledgeDocs,
    memoryContent: memoryDoc?.content || '',
    goalContext,
    memoryQuery: fullUserText,
    learnedFixesContent: learnedFixesExcerpt,
    repoPath: getRepoPath(),
    safetyMode,
    isHeadless,
    allowAutoRun,
    compact: isLocalOllama,
    hasTools: activeTools.length > 0,
    mode,
    cwd,
  });

  const systemTokens = Math.ceil(systemPrompt.length / 3.5) + 8;
  const toolsTokens = estimateToolsTokens(activeTools);

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (abortSignal?.aborted) {
        onEvent?.({ type: 'done', status: 'cancelled' });
        return { session, status: 'cancelled' };
      }

      const compacted = await compactConversation(session.messages, {
        numCtx,
        overheadTokens: systemTokens + toolsTokens,
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
        tokens: estimateMessagesTokens(modelMessages) + toolsTokens,
        numCtx,
      });

      const response = await activeChatFn({
        messages: modelMessages,
        tools: activeTools,
        signal: abortSignal,
        onEvent: (evt) => {
          if (evt?.type === 'self_improved' && evt.resolvedModel && persistSession) {
            session.model = evt.resolvedModel;
            saveConfig({ model: evt.resolvedModel }, paths).catch(() => {});
          }
          onEvent?.(evt);
        },
      });

      const rawToolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
      const normalizedCalls = rawToolCalls.map((tc) => {
        const norm = normalizeToolCall(tc);
        if (norm.repaired) {
          tracker.recordAliasRepair(norm.name, norm.repairNote);
        }
        return norm;
      });

      // Self-healing when model struggles to produce visible output and emits no tool calls
      let finalContent = String(response.content || '').trim();
      if (!finalContent && normalizedCalls.length === 0) {
        if (!emptyOutputRetried && step < maxSteps - 1 && !chatFn) {
          emptyOutputRetried = true;
          tracker.recordEmptyOutputRecovery('Model returned empty content; triggered self-correction step');
          session.messages.push({
            role: 'assistant',
            content: '',
            thinking: response.thinking || '',
            createdAt: new Date().toISOString(),
          });
          session.messages.push({
            role: 'user',
            content:
              '[Self-Correction] Your previous step produced no visible output. Provide the direct final answer to the user now, or call the required tool.',
            isSelfCorrection: true,
            createdAt: new Date().toISOString(),
          });
          continue;
        }

        // Synthesize fallback output from thinking or executed tool results so the user never sees a blank reply
        finalContent = synthesizeFallbackOutput({
          thinking: response.thinking || '',
          toolResults: executedToolResults,
        });
        tracker.recordEmptyOutputRecovery('Synthesized direct output from thinking/tool results');
        if (finalContent) {
          onEvent?.({ type: 'text_delta', text: finalContent });
        }
      }

      // Clean up temporary self-correction prompt from persisted history once resolved
      session.messages = session.messages.filter((m) => !m.isSelfCorrection);

      // Plan accountability: never end a turn that silently abandons its own
      // published plan. Nudge once to finish the remaining steps; if the model
      // still ends there, append an honest note so the user sees what remains.
      const isFinalAnswer = normalizedCalls.length === 0;
      const unfinishedSteps = unfinishedPlanSteps(latestPlan);
      if (isFinalAnswer && unfinishedSteps.length > 0 && !planNudged && step < maxSteps - 1) {
        planNudged = true;
        session.messages.push({
          role: 'assistant',
          content: finalContent || response.content || '',
          thinking: response.thinking || '',
          createdAt: new Date().toISOString(),
        });
        session.messages.push({
          role: 'user',
          content: planNudgeMessage(unfinishedSteps),
          isSelfCorrection: true,
          createdAt: new Date().toISOString(),
        });
        continue;
      }
      if (isFinalAnswer && unfinishedSteps.length > 0) {
        const note = planCompletionNote(unfinishedSteps);
        finalContent = `${finalContent || response.content || ''}${note}`;
        onEvent?.({ type: 'text_delta', text: note });
      }

      const assistantEntry = {
        role: 'assistant',
        content: normalizedCalls.length > 0 ? '' : finalContent || response.content || '',
        thinking: response.thinking || '',
        toolCalls: normalizedCalls.length > 0 ? normalizedCalls : undefined,
        createdAt: new Date().toISOString(),
      };
      if (!assistantEntry.toolCalls || assistantEntry.toolCalls.length === 0) {
        assistantEntry.usage = {
          ...(response.usage || {}),
          durationMs: Math.max(1, Date.now() - turnStartedAt),
          model: providerConfig.model || '',
        };
      }
      session.messages.push(assistantEntry);

      if (!assistantEntry.toolCalls || assistantEntry.toolCalls.length === 0) {
        if (tracker.hasStruggles()) {
          const learned = await persistTurnLearnings({ tracker, userMessage, paths }).catch(() => ({
            learnedCount: 0,
            lessons: [],
          }));
          if (learned.lessons.length > 0) {
            onEvent?.({ type: 'self_improved', lessons: learned.lessons });
          }
        }
        session.updatedAt = new Date().toISOString();
        if (persistSession) await saveSession(session, paths);
        onEvent?.({ type: 'done', status: 'completed', usage: assistantEntry.usage });
        return { session, status: 'completed' };
      }

      const PARALLEL_SAFE_READ_TOOLS = new Set([
        'read_file',
        'list_dir',
        'search_files',
        'spotlight_search',
        'inspect_media',
        'search_web',
        'fetch_url',
        'calculate',
        'system_stats',
        'list_skills',
        'read_skill',
        'list_knowledge',
        'read_knowledge',
        'search_knowledge',
      ]);

      const canRunConcurrently = (call) => {
        if (!call || call.parseError || !PARALLEL_SAFE_READ_TOOLS.has(call.name)) return false;
        const gate = evaluateToolSafety(
          { name: call.name, args: call.arguments || {} },
          {
            safetyMode,
            isHeadless,
            allowAutoRun,
            skillsDir: paths.skillsDir,
            knowledgeDir: paths.knowledgeDir,
            allowedReadCommands: providerConfig.allowedReadCommands || [],
          }
        );
        return gate.decision === 'allow';
      };

      const recordCompletedToolCall = (tc, effectiveArgs, result) => {
        if (tc.name === 'update_plan' && Array.isArray(result.plan)) {
          latestPlan = result.plan;
          persistGoalState(result.plan, { paths, sessionId: session?.id }).catch(() => {});
        }
        const outcome = tracker.recordToolOutcome({
          name: tc.name,
          args: effectiveArgs,
          ok: result.ok,
          output: result.output,
        });

        const enrichedOutput =
          outcome.failed && outcome.hint
            ? `${result.output}\n\n[Self-Healing Hint] ${outcome.hint}`
            : result.output;

        executedToolResults.push({
          name: tc.name,
          ok: result.ok,
          output: result.output,
        });

        session.messages.push({
          role: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          ok: result.ok,
          content: enrichedOutput,
          images: result.images,
          diff: result.diff,
        });

        onEvent?.({
          type: 'tool_result',
          toolCallId: tc.id,
          name: tc.name,
          ok: result.ok,
          output: enrichedOutput,
          diff: result.diff,
          images: result.images,
        });
      };

      if (normalizedCalls.length > 0 && response.content) {
        onEvent?.({ type: 'response_reset' });
      }

      const calls = assistantEntry.toolCalls;
      for (let callIdx = 0; callIdx < calls.length; callIdx++) {
        if (abortSignal?.aborted) {
          onEvent?.({ type: 'done', status: 'cancelled' });
          return { session, status: 'cancelled' };
        }

        // Batch consecutive read-only, non-duplicate, allowed tool calls concurrently via Promise.all
        if (canRunConcurrently(calls[callIdx]) && callIdx + 1 < calls.length && canRunConcurrently(calls[callIdx + 1])) {
          const batch = [];
          while (callIdx < calls.length && canRunConcurrently(calls[callIdx])) {
            const candidate = calls[callIdx];
            const candidateArgs = { ...(candidate.arguments || {}) };
            onEvent?.({ type: 'tool_call', toolCallId: candidate.id, name: candidate.name, arguments: candidateArgs });
            const dupCheck = tracker.checkDuplicateCall(candidate.name, candidateArgs);
            batch.push({ tc: candidate, effectiveArgs: candidateArgs, dupCheck });
            callIdx++;
          }
          callIdx--; // Adjust for outer loop increment

          const batchOutputs = await Promise.all(
            batch.map(async (entry) => {
              if (entry.dupCheck.isDuplicate) {
                return { isDuplicate: true, message: entry.dupCheck.message };
              }
              const result = await executeToolCall(
                { name: entry.tc.name, args: entry.effectiveArgs },
                {
                  paths,
                  cwd,
                  abortSignal,
                  onEvent,
                  onStdout: (chunk) => onEvent?.({ type: 'tool_output', toolCallId: entry.tc.id, stream: 'stdout', text: chunk }),
                  onStderr: (chunk) => onEvent?.({ type: 'tool_output', toolCallId: entry.tc.id, stream: 'stderr', text: chunk }),
                }
              );
              return { isDuplicate: false, result };
            })
          );

          for (let bIdx = 0; bIdx < batch.length; bIdx++) {
            const { tc: batchTc, effectiveArgs: batchArgs } = batch[bIdx];
            const out = batchOutputs[bIdx];
            if (out.isDuplicate) {
              session.messages.push({
                role: 'tool',
                toolCallId: batchTc.id,
                toolName: batchTc.name,
                ok: false,
                content: out.message,
              });
              onEvent?.({
                type: 'tool_result',
                toolCallId: batchTc.id,
                name: batchTc.name,
                ok: false,
                output: out.message,
              });
            } else {
              recordCompletedToolCall(batchTc, batchArgs, out.result);
            }
          }
          continue;
        }

        const tc = calls[callIdx];
        if (tc.parseError) {
          tracker.recordParseError(tc.name, tc.parseError);
          const errOut = `Tool call "${tc.name}" failed JSON parsing: ${tc.parseError}. Re-emit valid double-quoted JSON arguments.`;
          session.messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, ok: false, content: errOut });
          onEvent?.({ type: 'tool_result', toolCallId: tc.id, name: tc.name, ok: false, output: errOut });
          continue;
        }

        let effectiveArgs = { ...(tc.arguments || {}) };
        onEvent?.({ type: 'tool_call', toolCallId: tc.id, name: tc.name, arguments: effectiveArgs });

        // Break infinite duplicate tool call loops within the same turn
        const dupCheck = tracker.checkDuplicateCall(tc.name, effectiveArgs);
        if (dupCheck.isDuplicate) {
          session.messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            ok: false,
            content: dupCheck.message,
          });
          onEvent?.({
            type: 'tool_result',
            toolCallId: tc.id,
            name: tc.name,
            ok: false,
            output: dupCheck.message,
          });
          continue;
        }

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
          session.messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, ok: false, content: blockedMsg });
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
            session.messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, ok: false, content: deniedMsg });
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
              session.messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, ok: false, content: blockedMsg });
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
            onEvent,
            onStdout: (chunk) => onEvent?.({ type: 'tool_output', toolCallId: tc.id, stream: 'stdout', text: chunk }),
            onStderr: (chunk) => onEvent?.({ type: 'tool_output', toolCallId: tc.id, stream: 'stderr', text: chunk }),
          }
        );

        recordCompletedToolCall(tc, effectiveArgs, result);
      }

      session.updatedAt = new Date().toISOString();
      if (persistSession) await saveSession(session, paths);
    }

    if (tracker.hasStruggles()) {
      const learned = await persistTurnLearnings({ tracker, userMessage, paths }).catch(() => ({
        learnedCount: 0,
        lessons: [],
      }));
      if (learned.lessons.length > 0) {
        onEvent?.({ type: 'self_improved', lessons: learned.lessons });
      }
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
    tracker.struggles.push({
      type: 'turn_error',
      toolName: 'agent_turn',
      lesson: `Runtime error "${err.message}": verify model availability and tool arguments before execution.`,
    });
    await persistTurnLearnings({ tracker, userMessage, paths }).catch(() => {});
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
