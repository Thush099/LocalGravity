import { runAgentTurn } from '../agent/loop.mjs';
import { loadSession, saveSession } from '../state/storage.mjs';
import crypto from 'node:crypto';

/**
 * Tool for delegating a sub-task to a fresh agent instance.
 * This enables multi-agent collaboration by allowing the primary agent to
 * offload specific problems (e.g. "research this API", "write tests for this module")
 * to a sub-agent with its own context.
 */
export async function delegateTaskTool(args, context) {
  const { task, mode = 'auto', provider, model, cwd } = args;
  const { paths, sessionId } = context;

  if (!task) {
    return { ok: false, error: 'task description is required' };
  }

  try {
    // Create a transient sub-session ID
    const subSessionId = `sub-${crypto.randomBytes(4).toString('hex')}`;
    
    // We don't want to pollute the main session, but we might want to inherit some state
    const subSession = {
      id: subSessionId,
      title: `Sub-task: ${task.slice(0, 40)}...`,
      source: 'delegated',
      provider: provider || context.providerConfig?.provider,
      model: model || context.providerConfig?.model,
      cwd: cwd || context.cwd || '',
      mode: mode,
      messages: [],
      parentSessionId: sessionId
    };

    let resultText = '';
    const onEvent = (event) => {
      if (event.type === 'text_delta') {
        resultText += event.text;
      }
      // We could also stream this back to the user if we wanted to show progress
    };

    // Run the sub-agent turn
    await runAgentTurn({
      session: subSession,
      userMessage: task,
      attachments: [],
      paths,
      providerConfig: {
        ...context.providerConfig,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
      mode,
      cwd: subSession.cwd,
      onEvent,
      abortSignal: context.abortSignal,
      requestApproval: context.requestApproval, // Sub-agent still respects user approval
    });

    return { 
      ok: true, 
      output: `Sub-agent completed task: "${task}"\n\nResult:\n${resultText}`,
      subSessionId 
    };
  } catch (err) {
    return { ok: false, error: `Delegation failed: ${err.message}` };
  }
}
