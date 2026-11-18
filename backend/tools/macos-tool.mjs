import { spawn } from 'node:child_process';

const MAX_CLIPBOARD_CHARS = 200000;
const MAX_REMINDER_SECONDS = 86400;

/**
 * Run a binary directly (never through a shell) so arguments cannot trigger shell injection.
 * Optional `input` is piped to stdin. Returns { ok, code, stdout, stderr }.
 */
function runBinary(bin, args, { input, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
    }, timeout);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    const finish = (ok, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, code, stdout, stderr: stderr.trim() });
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
export async function setReminderTool({ seconds, message }) {
  const raw = Number(seconds);
  if (!Number.isFinite(raw) || raw <= 0) {
    return { ok: false, output: 'Reminder delay must be a positive number of seconds.' };
  }
  const delay = Math.min(Math.floor(raw), MAX_REMINDER_SECONDS);
  const msg = String(message ?? `Reminder from LocalGravity (${delay}s)`).trim();
  const script = `display notification "${escapeAppleScriptString(msg)}" with title "LocalGravity Reminder" sound name "Glass"`;
  const child = spawn('nohup', ['zsh', '-c', `sleep ${delay}; osascript -e ${JSON.stringify(script)}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return {
    ok: true,
    output: `Reminder set for ${delay} seconds from now: "${msg.slice(0, 120)}"`,
    fireAt: new Date(Date.now() + delay * 1000).toISOString(),
  };
}
