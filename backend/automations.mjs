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

export async function setAutomationSchedule(id, scheduleConfig, paths = getRuntimePaths()) {
  const list = await loadAutomations(paths);
  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) {
    throw new Error(`Automation "${id}" not found.`);
  }

  const label = `com.localgravity.${id}`;
  const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`);
  const enabled = Boolean(scheduleConfig?.enabled);

  await launchctlUnload(plistPath);

  if (!enabled) {
    await fs.rm(plistPath, { force: true }).catch(() => {});
    list[idx] = {
      ...list[idx],
      schedule: { enabled: false },
      allowAutoRun: Boolean(scheduleConfig?.allowAutoRun ?? list[idx].allowAutoRun),
    };
    await saveAutomations(list, paths);
    return list[idx];
  }

  const logDir = path.join(paths.root, 'logs');
  await fs.mkdir(paths.launchAgentsDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });

  const schedulePayload = {
    enabled: true,
    frequency: scheduleConfig.frequency || 'daily',
    hour: Number(scheduleConfig.hour ?? 9),
    minute: Number(scheduleConfig.minute ?? 0),
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

  list[idx] = {
    ...list[idx],
    schedule: schedulePayload,
    allowAutoRun: Boolean(scheduleConfig.allowAutoRun),
    plistPath,
  };
  await saveAutomations(list, paths);
  return list[idx];
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
