import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_SCRIPT_BYTES = 20000;
const MAX_OUTPUT = 32000;

/**
 * Run an AppleScript snippet via osascript for deep macOS automation (Finder, Notes,
 * Safari, System Events, etc.). The script is written to a temp file and passed as an
 * argv to osascript (never through a shell), so the script body cannot be used for
 * shell injection. This tool is always treated as state-mutating by the safety gate.
 */
export async function runAppleScriptTool({ script, timeout_ms = 30000 }, context = {}) {
  const body = String(script || '');
  if (!body.trim()) {
    return { ok: false, output: 'AppleScript body is empty.' };
  }
  if (body.length > MAX_SCRIPT_BYTES) {
    return { ok: false, output: `AppleScript too large (max ${MAX_SCRIPT_BYTES} characters).` };
  }

  const tmpPath = path.join(os.tmpdir(), `localgravity-as-${crypto.randomUUID()}.scpt`);
  await fs.writeFile(tmpPath, body, 'utf8');

  const clampedTimeout = Math.min(Math.max(1000, Number(timeout_ms) || 30000), 120000);

  try {
    const run = execFileAsync('osascript', [tmpPath], {
      timeout: clampedTimeout,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });
    const cancel = () => {
      try {
        run.child?.kill('SIGKILL');
      } catch {
        // already exited
      }
    };
    context.abortSignal?.addEventListener('abort', cancel, { once: true });
    try {
      const { stdout, stderr } = await run;
      const out = String(stdout || '').trim();
      return {
        ok: true,
        output: out ? out.slice(0, MAX_OUTPUT) : '(no output)',
      };
    } finally {
      context.abortSignal?.removeEventListener('abort', cancel);
    }
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    const stdout = err.stdout ? String(err.stdout).trim() : '';
    const detail = [stdout, stderr, err.message].filter(Boolean).join('\n').slice(0, MAX_OUTPUT);
    return { ok: false, output: `osascript failed: ${detail}` };
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}
