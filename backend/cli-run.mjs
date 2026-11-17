import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runAgentTurn } from './agent/loop.mjs';
import { updateAutomationRecord } from './automations.mjs';
import { ensureOllamaRunning } from './providers/ollama.mjs';
import { getRuntimePaths } from './state/paths.mjs';
import { loadAutomations, loadConfig, saveSession } from './state/storage.mjs';

const execFileAsync = promisify(execFile);

async function notifyMac(title, message) {
  const safeTitle = String(title).replaceAll('"', '\\"').slice(0, 80);
  const safeMsg = String(message).replaceAll('"', '\\"').replace(/\s+/g, ' ').slice(0, 180);
  try {
    await execFileAsync('osascript', ['-e', `display notification "${safeMsg}" with title "${safeTitle}"`]);
  } catch {
    // Notifications are best-effort
  }
}

async function main() {
  const idx = process.argv.indexOf('--automation');
  const automationId = idx !== -1 ? process.argv[idx + 1] : null;
  if (!automationId) {
    console.error('Usage: node cli-run.mjs --automation <id>');
    process.exit(1);
  }

  const paths = getRuntimePaths();
  const automations = await loadAutomations(paths);
  const automation = automations.find((a) => a.id === automationId);
  if (!automation) {
    console.error(`Automation "${automationId}" not found.`);
    process.exit(1);
  }

  const config = await loadConfig(paths);
  let ollamaHandle = { startedByUs: false, stop: async () => {} };

  try {
    if ((config.provider || 'ollama') === 'ollama') {
      ollamaHandle = await ensureOllamaRunning();
    }

    const session = {
      id: `sched-${automation.id}-${Date.now()}`,
      title: `Scheduled: ${automation.name}`,
      source: 'scheduled',
      provider: config.provider || 'ollama',
      model: config.model || 'qwen3.5:9b',
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    const result = await runAgentTurn({
      session,
      userMessage: automation.prompt,
      attachments: Array.isArray(automation.attachments) ? automation.attachments : [],
      paths,
      providerConfig: config,
      isHeadless: true,
      allowAutoRun: Boolean(automation.allowAutoRun),
      persistSession: true,
    });

    await saveSession(session, paths);
    await updateAutomationRecord(
      automation.id,
      (cur) => ({
        ...cur,
        lastRunAt: new Date().toISOString(),
        lastRunStatus: result.status,
        lastSessionId: session.id,
      }),
      paths
    );

    const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant');
    await notifyMac(
      `LocalGravity: ${automation.name}`,
      result.status === 'completed'
        ? lastAssistant?.content || 'Scheduled task completed.'
        : `Status: ${result.status}`
    );
  } catch (err) {
    await notifyMac(`LocalGravity Error: ${automation.name}`, err.message);
    process.exitCode = 1;
  } finally {
    if (ollamaHandle.startedByUs) {
      await ollamaHandle.stop();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
