import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandUserPath } from './safety.mjs';
import { addReminder } from './reminders.mjs';

const MAX_CLIPBOARD_CHARS = 200000;
const MAX_PROCESS_OUTPUT_CHARS = 64 * 1024;
const MAX_REMINDER_SECONDS = 86400;

/**
 * Run a binary directly (never through a shell) so arguments cannot trigger shell injection.
 * Optional `input` is piped to stdin. Returns { ok, code, stdout, stderr }.
 */
export function appendBoundedOutput(current, chunk, limit = MAX_PROCESS_OUTPUT_CHARS) {
  const remaining = Math.max(0, limit - current.length);
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  return remaining > 0 ? current + text.slice(0, remaining) : current;
}

function runBinary(bin, args, { input, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
    }, timeout);

    child.stdout.on('data', (chunk) => {
      const next = appendBoundedOutput(stdout, chunk);
      stdoutTruncated ||= next.length < stdout.length + chunk.toString('utf8').length;
      stdout = next;
    });
    child.stderr.on('data', (chunk) => {
      const next = appendBoundedOutput(stderr, chunk);
      stderrTruncated ||= next.length < stderr.length + chunk.toString('utf8').length;
      stderr = next;
    });

    const finish = (ok, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutNote = stdoutTruncated ? '\n[stdout truncated at 64 KB]' : '';
      const stderrNote = stderrTruncated ? '\n[stderr truncated at 64 KB]' : '';
      resolve({
        ok,
        code,
        stdout: `${stdout}${stdoutNote}`,
        stderr: `${stderr}${stderrNote}`.trim(),
      });
    };

    child.on('error', (err) => finish(false, null));
    child.on('close', (code) => finish(code === 0, code));

    try {
      if (input != null) child.stdin.write(String(input));
      child.stdin.end();
    } catch {
      // stdin may already be closed
    }
  });
}

function escapeAppleScriptString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

export async function copyToClipboardTool({ text }) {
  const value = String(text ?? '');
  if (!value) return { ok: false, output: 'Nothing to copy (text is empty).' };
  const clipped = value.slice(0, MAX_CLIPBOARD_CHARS);
  const res = await runBinary('pbcopy', [], { input: clipped });
  if (!res.ok) return { ok: false, output: `pbcopy failed: ${res.stderr || 'unknown error'}` };
  return {
    ok: true,
    output: `Copied ${clipped.length} characters to the clipboard.${value.length > MAX_CLIPBOARD_CHARS ? ' (truncated to 200k chars)' : ''}`,
  };
}

export async function pasteFromClipboardTool() {
  const res = await runBinary('pbpaste', []);
  if (!res.ok) return { ok: false, output: `pbpaste failed: ${res.stderr || 'unknown error'}` };
  const text = res.stdout;
  if (!text.trim()) return { ok: true, output: '(clipboard is empty)' };
  return {
    ok: true,
    output: `Clipboard content (${text.length} characters):\n${text.slice(0, MAX_CLIPBOARD_CHARS)}`,
    clipboard: text,
  };
}

export async function showNotificationTool({ title = 'LocalGravity', message }) {
  const msg = String(message ?? '').trim();
  if (!msg) return { ok: false, output: 'Notification message is empty.' };
  const script = `display notification "${escapeAppleScriptString(msg)}" with title "${escapeAppleScriptString(title)}"`;
  const res = await runBinary('osascript', ['-e', script], { timeout: 10000 });
  if (!res.ok) return { ok: false, output: `Notification failed: ${res.stderr || 'unknown error'}` };
  return { ok: true, output: `Notification shown: "${title}" — ${msg.slice(0, 120)}` };
}

export async function openAppTool({ name }) {
  const appName = String(name ?? '').trim();
  if (!appName) return { ok: false, output: 'App name is empty.' };
  const res = await runBinary('open', ['-a', appName], { timeout: 15000 });
  if (!res.ok) {
    return { ok: false, output: `Could not open "${appName}": ${res.stderr || 'app not found'}` };
  }
  return { ok: true, output: `Opened ${appName}.` };
}

/**
 * Invoke an existing macOS Shortcut (from the Shortcuts app) by name. This turns every
 * Shortcut the user has built into a ready-made agent capability.
 */
export async function runShortcutTool({ name, input }) {
  const shortcutName = String(name ?? '').trim();
  if (!shortcutName) return { ok: false, output: 'Shortcut name is empty.' };
  const args = ['run', shortcutName];
  const res = await runBinary('shortcuts', args, {
    input: input != null ? String(input) : undefined,
    timeout: 60000,
  });
  if (!res.ok) {
    return {
      ok: false,
      output: `Shortcut "${shortcutName}" failed: ${res.stderr || 'unknown error (is the Shortcuts app installed?)'}`,
    };
  }
  return {
    ok: true,
    output: `Shortcut "${shortcutName}" ran.${res.stdout.trim() ? `\nOutput:\n${res.stdout.trim().slice(0, 4000)}` : ''}`,
  };
}

/**
 * Schedule a one-shot macOS notification reminder after N seconds. Runs as a detached
 * background process so it fires even after this tool call returns.
 */
export function buildReminderInvocation(seconds, message) {
  return {
    bin: '/bin/zsh',
    args: ['-c', 'sleep "$1"; exec /usr/bin/osascript -e "$2"', 'localgravity-reminder', String(seconds), String(message)],
  };
}

export async function setReminderTool({ seconds, message, paths, spawnFn = spawn }) {
  const raw = Number(seconds);
  if (!Number.isFinite(raw) || raw <= 0) {
    return { ok: false, output: 'Reminder delay must be a positive number of seconds.' };
  }
  const delay = Math.min(Math.floor(raw), MAX_REMINDER_SECONDS);
  const msg = String(message ?? `Reminder from LocalGravity (${delay}s)`).trim();
  const script = `display notification "${escapeAppleScriptString(msg)}" with title "LocalGravity Reminder" sound name "Glass"`;
  const invocation = buildReminderInvocation(delay, script);
  const fireAt = new Date(Date.now() + delay * 1000).toISOString();
  const child = spawnFn('nohup', [invocation.bin, ...invocation.args], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  // Written down before this call returns: the notification only fires while the machine
  // stays awake, the record survives a reboot and the briefing can hand it back. The pid
  // is kept so a changed mind can actually stop the pending notification.
  const record = await addReminder(
    paths,
    { message: msg, fireAt, pid: child.pid },
  ).catch(() => null);
  return {
    ok: true,
    output: `Reminder set for ${delay} seconds from now: "${msg.slice(0, 120)}"`,
    fireAt,
    reminderId: record?.id ?? null,
  };
}

/**
 * Search indexed files across macOS via Spotlight (`mdfind`) without shelling out.
 */
export async function spotlightSearchTool({ query, folder = '', limit = 20 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, paths: [], output: 'Spotlight query is required.' };
  const cap = Math.min(50, Math.max(1, Number(limit) || 20));
  const args = [];
  if (folder) {
    args.push('-onlyin', expandUserPath(String(folder).trim()));
  }
  args.push(q);

  const res = await runBinary('/usr/bin/mdfind', args, { timeout: 10000 });
  if (!res.ok) {
    return { ok: false, paths: [], output: `Spotlight search failed: ${res.stderr || 'mdfind error'}` };
  }
  const allPaths = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const shown = allPaths.slice(0, cap);
  if (shown.length === 0) {
    return { ok: true, paths: [], output: `No Spotlight matches for "${q}".` };
  }
  const extra = allPaths.length > shown.length ? `\n... (${allPaths.length - shown.length} more)` : '';
  return {
    ok: true,
    paths: shown,
    output: `Spotlight matches (${shown.length}${allPaths.length > shown.length ? ` of ${allPaths.length}` : ''}):\n${shown.join('\n')}${extra}`,
  };
}

/**
 * Capture the macOS screen silently into a temp PNG and return it scaled for multimodal inspection.
 */
export async function takeScreenshotTool({ mode = 'screen', max_edge = 1280 } = {}) {
  const edge = Math.min(1920, Math.max(480, Number(max_edge) || 1280));
  const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const rawPath = path.join(os.tmpdir(), `lg-shot-${stamp}.png`);
  const scaledPath = path.join(os.tmpdir(), `lg-shot-${stamp}-scaled.png`);
  const captureArgs = mode === 'main' ? ['-x', '-m', '-t', 'png', rawPath] : ['-x', '-t', 'png', rawPath];

  const capRes = await runBinary('/usr/sbin/screencapture', captureArgs, { timeout: 10000 });
  if (!capRes.ok) {
    return {
      ok: false,
      output: `Screenshot failed (${capRes.stderr || 'grant Screen Recording access to LocalGravity in System Settings > Privacy & Security'}).`,
    };
  }

  let readTarget = rawPath;
  const sipsRes = await runBinary('/usr/bin/sips', ['-Z', String(edge), rawPath, '--out', scaledPath], {
    timeout: 10000,
  });
  if (sipsRes.ok) readTarget = scaledPath;

  try {
    const buf = await fs.readFile(readTarget);
    const b64 = buf.toString('base64');
    if (readTarget !== rawPath) {
      await fs.unlink(scaledPath).catch(() => {});
    }
    return {
      ok: true,
      path: rawPath,
      output: `Captured macOS screenshot (${Math.round(buf.length / 1024)} KB) at ${rawPath}`,
      images: [b64],
    };
  } catch (err) {
    return { ok: false, output: `Could not read screenshot image: ${err.message}` };
  }
}

function escapeHtmlBody(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatNoteHtml(title, body) {
  const safeTitle = escapeHtmlBody(title);
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const bodyHtml = lines.map((line) => (line ? `<div>${escapeHtmlBody(line)}</div>` : '<div><br></div>')).join('');
  return `<div><b>${safeTitle}</b></div>${bodyHtml}`;
}

/**
 * Safely list, search, read, or create Apple Notes via osascript argv (never string interpolation).
 */
export async function manageNotesTool({ action = 'list', title = '', body = '', query = '', limit = 10 } = {}) {
  const act = String(action || 'list').toLowerCase().trim();
  const cap = Math.min(30, Math.max(1, Number(limit) || 10));

  if (act === 'create') {
    const noteTitle = String(title || '').trim();
    if (!noteTitle) return { ok: false, output: 'Note title is required when action is "create".' };
    const htmlBody = formatNoteHtml(noteTitle, body);
    const script = [
      'on run argv',
      '  set noteHtml to item 1 of argv',
      '  tell application "Notes"',
      '    tell default account',
      '      set newNote to make new note at folder "Notes" with properties {body:noteHtml}',
      '      return name of newNote',
      '    end tell',
      '  end tell',
      'end run',
    ].join('\n');
    const res = await runBinary('/usr/bin/osascript', ['-', htmlBody], { input: script, timeout: 15000 });
    if (!res.ok) return { ok: false, output: `Apple Notes create failed: ${res.stderr || 'permission denied or Notes unavailable'}` };
    return { ok: true, output: `Created Apple Note "${res.stdout.trim() || noteTitle}".` };
  }

  if (act === 'read') {
    const noteTitle = String(title || '').trim();
    if (!noteTitle) return { ok: false, output: 'Note title is required when action is "read".' };
    const script = [
      'on run argv',
      '  set targetName to item 1 of argv',
      '  tell application "Notes"',
      '    set foundNotes to (every note whose name is targetName)',
      '    if (count of foundNotes) is 0 then',
      '      set foundNotes to (every note whose name contains targetName)',
      '    end if',
      '    if (count of foundNotes) is 0 then return "__LG_NOT_FOUND__"',
      '    set n to item 1 of foundNotes',
      '    return (name of n) & linefeed & "---" & linefeed & (plaintext of n)',
      '  end tell',
      'end run',
    ].join('\n');
    const res = await runBinary('/usr/bin/osascript', ['-', noteTitle], { input: script, timeout: 15000 });
    if (!res.ok) return { ok: false, output: `Apple Notes read failed: ${res.stderr || 'osascript error'}` };
    const text = res.stdout.trim();
    if (text === '__LG_NOT_FOUND__') return { ok: false, output: `No Apple Note matching "${noteTitle}".` };
    return { ok: true, output: text.slice(0, 8000) };
  }

  if (act === 'search') {
    const needle = String(query || title || '').trim();
    if (!needle) return { ok: false, output: 'Search query is required when action is "search".' };
    const script = [
      'on run argv',
      '  set q to item 1 of argv',
      '  set maxItems to (item 2 of argv) as integer',
      '  tell application "Notes"',
      '    set hits to {}',
      '    ignoring case',
      '      repeat with n in every note',
      '        if (name of n contains q) or (plaintext of n contains q) then',
      '          set end of hits to (name of n)',
      '          if (count of hits) >= maxItems then exit repeat',
      '        end if',
      '      end repeat',
      '    end ignoring',
      '    set AppleScript\'s text item delimiters to linefeed',
      '    return hits as text',
      '  end tell',
      'end run',
    ].join('\n');
    const res = await runBinary('/usr/bin/osascript', ['-', needle, String(cap)], { input: script, timeout: 15000 });
    if (!res.ok) return { ok: false, output: `Apple Notes search failed: ${res.stderr || 'osascript error'}` };
    const text = res.stdout.trim();
    return { ok: true, output: text ? `Matching Apple Notes:\n${text}` : `No Apple Notes matched "${needle}".` };
  }

  if (act === 'list') {
    const script = [
      'on run argv',
      '  set maxItems to (item 1 of argv) as integer',
      '  tell application "Notes"',
      '    set allNotes to every note',
      '    set totalCount to count of allNotes',
      '    if totalCount < maxItems then set maxItems to totalCount',
      '    set outLines to {}',
      '    repeat with idx from 1 to maxItems',
      '      set n to item idx of allNotes',
      '      set end of outLines to ("- " & (name of n))',
      '    end repeat',
      '    set AppleScript\'s text item delimiters to linefeed',
      '    return outLines as text',
      '  end tell',
      'end run',
    ].join('\n');
    const res = await runBinary('/usr/bin/osascript', ['-', String(cap)], { input: script, timeout: 15000 });
    if (!res.ok) return { ok: false, output: `Apple Notes list failed: ${res.stderr || 'osascript error'}` };
    const text = res.stdout.trim();
    return { ok: true, output: text ? `Apple Notes:\n${text}` : 'No notes found in Apple Notes.' };
  }

  return { ok: false, output: `Unsupported action "${action}". Use "list", "search", "read", or "create".` };
}

/**
 * Open a validated http(s) URL in the user's default browser.
 */
export async function openUrlTool({ url } = {}) {
  const raw = String(url ?? '').trim();
  if (!raw) return { ok: false, output: 'URL is required.' };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, output: `Invalid URL: "${raw}"` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, output: `Blocked URL scheme "${parsed.protocol}": only http and https URLs are allowed.` };
  }
  const res = await runBinary('/usr/bin/open', [parsed.href], { timeout: 10000 });
  if (!res.ok) return { ok: false, output: `Could not open URL: ${res.stderr || 'open error'}` };
  return { ok: true, output: `Opened ${parsed.href} in default browser.` };
}
