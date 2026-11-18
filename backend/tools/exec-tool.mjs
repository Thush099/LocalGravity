import { spawn } from 'node:child_process';
import { expandUserPath } from './safety.mjs';

function buildShellEnv(baseEnv = process.env) {
  const curPath = baseEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
  const fullPath = curPath.includes('/opt/homebrew/bin')
    ? curPath
    : `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${curPath}`;
  return {
    ...baseEnv,
    PATH: fullPath,
    TERM: 'dumb',
  };
}

/**
 * Execute a zsh command with streaming callbacks, timeout protection, and clean process-group teardown.
 */
export function runCommandTool({ command, cwd, timeout_ms = 60000, onStdout, onStderr, abortSignal }) {
  return new Promise((resolve) => {
    const resolvedCwd = cwd ? expandUserPath(cwd) : process.env.HOME || process.cwd();
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd: resolvedCwd,
      detached: true,
      env: buildShellEnv(process.env),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let forceKillTimer = null;
    const maxCapture = 32000;

    const killGroup = (signal = 'SIGTERM') => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already exited
        }
      }
    };

    const timer = setTimeout(() => {
      killGroup('SIGTERM');
      forceKillTimer = setTimeout(() => killGroup('SIGKILL'), 1500);
      if (!settled) {
        settled = true;
        resolve({
          ok: false,
          output: `Command timed out after ${timeout_ms}ms.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`.trim(),
        });
      }
    }, Math.min(Math.max(1000, Number(timeout_ms) || 60000), 300000));

    const onAbort = () => {
      killGroup('SIGTERM');
      forceKillTimer = setTimeout(() => killGroup('SIGKILL'), 1000);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      if (stdout.length < maxCapture) stdout += str.slice(0, maxCapture - stdout.length);
      onStdout?.(str);
    });

    child.stderr.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      if (stderr.length < maxCapture) stderr += str.slice(0, maxCapture - stderr.length);
      onStderr?.(str);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        resolve({ ok: false, output: `Failed to execute command: ${err.message}` });
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      const combined = [
        `Exit code: ${code}`,
        stdout.trim() ? `STDOUT:\n${stdout.trim()}` : '',
        stderr.trim() ? `STDERR:\n${stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      resolve({ ok: code === 0, output: combined });
    });
  });
}
