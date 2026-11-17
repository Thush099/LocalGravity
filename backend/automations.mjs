import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getRuntimePaths } from './state/paths.mjs';
import { loadAutomations, saveAutomations } from './state/storage.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function escapeXml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function getCliRunnerPath() {
  return path.resolve(__dirname, 'cli-run.mjs');
}

/**
 * Generate a macOS launchd user agent plist for an automation.
 */
export function buildLaunchAgentPlist({
  id,
  label = `com.localgravity.${id}`,
  scriptPath = getCliRunnerPath(),
  nodePath = process.execPath,
  intervalSeconds,
  calendarInterval,
  logDir = path.join(os.homedir(), '.localgravity', 'logs'),
}) {
  const scheduleBlock = calendarInterval
    ? [
        '  <key>StartCalendarInterval</key>',
        '  <dict>',
        ...(calendarInterval.Hour !== undefined
          ? [`    <key>Hour</key>`, `    <integer>${Number(calendarInterval.Hour)}</integer>`]
          : []),
        ...(calendarInterval.Minute !== undefined
          ? [`    <key>Minute</key>`, `    <integer>${Number(calendarInterval.Minute)}</integer>`]
          : []),
        ...(calendarInterval.Weekday !== undefined
          ? [`    <key>Weekday</key>`, `    <integer>${Number(calendarInterval.Weekday)}</integer>`]
          : []),
        '  </dict>',
      ].join('\n')
    : `  <key>StartInterval</key>\n  <integer>${Math.max(300, Number(intervalSeconds) || 86400)}</integer>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>--automation</string>
    <string>${escapeXml(id)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>OLLAMA_FLASH_ATTENTION</key>
    <string>1</string>
    <key>OLLAMA_KV_CACHE_TYPE</key>
    <string>q8_0</string>
  </dict>
${scheduleBlock}
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, `${id}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, `${id}.err.log`))}</string>
</dict>
</plist>
`;
}

async function launchctlUnload(plistPath) {
  try {
    await execFileAsync('launchctl', ['unload', '-w', plistPath]);
  } catch {
    // Ignore if not currently loaded
  }
}

async function launchctlLoad(plistPath) {
  await execFileAsync('launchctl', ['load', '-w', plistPath]);
}

async function withAutomationsLock(paths, fn) {
  await fs.mkdir(paths.root, { recursive: true });
  const lockPath = `${paths.automationsFile}.lock`;
  let handle = null;

  for (let i = 0; i < 40; i++) {
    try {
      handle = await fs.open(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > 15000) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((r) => setTimeout(r, 75));
    }
  }

  try {
    return await fn();
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

export async function updateAutomationRecord(id, patchFn, paths = getRuntimePaths()) {
  return withAutomationsLock(paths, async () => {
    const list = await loadAutomations(paths);
    const idx = list.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    list[idx] = patchFn(list[idx]);
    await saveAutomations(list, paths);
    return list[idx];
  });
}

export async function setAutomationSchedule(id, scheduleConfig, paths = getRuntimePaths()) {
  const initialList = await loadAutomations(paths);
  const existing = initialList.find((a) => a.id === id);
  if (!existing) {
    throw new Error(`Automation "${id}" not found.`);
  }

  const label = `com.localgravity.${id}`;
  const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`);
  const enabled = Boolean(scheduleConfig?.enabled);

  await launchctlUnload(plistPath);

  if (!enabled) {
    await fs.rm(plistPath, { force: true }).catch(() => {});
    return updateAutomationRecord(
      id,
      (cur) => ({
        ...cur,
        schedule: { enabled: false },
        allowAutoRun: Boolean(scheduleConfig?.allowAutoRun ?? cur.allowAutoRun),
      }),
      paths
    );
  }

  const logDir = path.join(paths.root, 'logs');
  await fs.mkdir(paths.launchAgentsDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });

  const schedulePayload = {
    enabled: true,
    frequency: scheduleConfig.frequency || 'daily',
    hour: Math.min(23, Math.max(0, Number(scheduleConfig.hour ?? 9) || 0)),
    minute: Math.min(59, Math.max(0, Number(scheduleConfig.minute ?? 0) || 0)),
    intervalSeconds: scheduleConfig.intervalSeconds ? Number(scheduleConfig.intervalSeconds) : undefined,
  };

  const plist = buildLaunchAgentPlist({
    id,
    label,
    logDir,
    ...(schedulePayload.frequency === 'hourly'
      ? { intervalSeconds: 3600 }
      : schedulePayload.frequency === 'custom' && schedulePayload.intervalSeconds
        ? { intervalSeconds: schedulePayload.intervalSeconds }
        : { calendarInterval: { Hour: schedulePayload.hour, Minute: schedulePayload.minute } }),
  });

  await fs.writeFile(plistPath, plist, 'utf8');
  await launchctlLoad(plistPath);

  return updateAutomationRecord(
    id,
    (cur) => ({
      ...cur,
      schedule: schedulePayload,
      allowAutoRun: Boolean(scheduleConfig.allowAutoRun),
      plistPath,
    }),
    paths
  );
}

export async function removeAllLaunchAgents(paths = getRuntimePaths()) {
  try {
    const entries = await fs.readdir(paths.launchAgentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('com.localgravity.') && entry.name.endsWith('.plist')) {
        const full = path.join(paths.launchAgentsDir, entry.name);
        await launchctlUnload(full);
        await fs.rm(full, { force: true });
      }
    }
  } catch {
    // Ignore missing LaunchAgents dir
  }
}
