import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';

const execAsync = promisify(exec);

export async function gitTool(args = {}) {
  const { action = 'status', directory = process.cwd(), message, branch, remote, count = 20 } = args;
  try {
    const cwd = path.resolve(directory);
    switch (action) {
      case 'status': {
        const { stdout } = await execAsync('git status -s', { cwd });
        const { stdout: branchOut } = await execAsync('git branch --show-current', { cwd });
        return { ok: true, branch: branchOut.trim(), status: stdout.trim() };
      }
      case 'diff': {
        const { stdout } = await execAsync('git diff', { cwd });
        return { ok: true, diff: stdout };
      }
      case 'log': {
        const { stdout } = await execAsync(`git log -n ${Number(count) || 20} --oneline`, { cwd });
        return { ok: true, log: stdout };
      }
      case 'commit': {
        if (!message) throw new Error('commit message is required');
        await execAsync('git add -A', { cwd });
        const { stdout } = await execAsync(`git commit -m ${JSON.stringify(message)}`, { cwd });
        return { ok: true, result: stdout.trim() };
      }
      case 'branch': {
        if (branch) {
          const { stdout } = await execAsync(`git checkout -b ${JSON.stringify(branch)}`, { cwd });
          return { ok: true, result: stdout.trim() };
        }
        const { stdout } = await execAsync('git branch -a', { cwd });
        return { ok: true, branches: stdout.trim() };
      }
      default:
        throw new Error(`Unknown git action: ${action}`);
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
