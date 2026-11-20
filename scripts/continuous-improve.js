#!/usr/bin/env node
/**
 * Continuous improvement runner.
 * Repeatedly runs the test suite and project checks. Create a `.continuous_stop`
 * file in the project root to stop the loop.
 *
 * Safe by default: this script only runs checks and reports. Git mutations are
 * explicit opt-ins, and untracked files are never staged.
 *
 *   node scripts/continuous-improve.js           # run checks every minute, change nothing
 *   node scripts/continuous-improve.js --commit  # also commit tracked changes when checks pass
 *   node scripts/continuous-improve.js --commit --push   # also push
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOP_FILE = path.join(PROJECT_ROOT, '.continuous_stop');
const COMMIT = process.argv.includes('--commit');
const PUSH = process.argv.includes('--push');

function shouldStop() {
  return fs.existsSync(STOP_FILE);
}

function runCommand(cmd) {
  console.log(`\n=== ${cmd} ===`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: PROJECT_ROOT });
    return true;
  } catch {
    console.error(`Command failed: ${cmd}`);
    return false;
  }
}

async function main() {
  console.log('Starting continuous improvement loop. Create a `.continuous_stop` file to stop.');
  while (!shouldStop()) {
    const testsPass = runCommand('npm test');
    const checksPass = runCommand('npm run check');

    if (!testsPass || !checksPass) {
      console.error('Skipping commit: checks did not all pass.');
    } else if (COMMIT) {
      // Stage only already-tracked modifications so untracked work is never swept in.
      try {
        execSync('git add -u', { cwd: PROJECT_ROOT, stdio: 'inherit' });
        execSync('git commit -m "Continuous improvement auto-commit"', { cwd: PROJECT_ROOT, stdio: 'inherit' });
      } catch {
        // Nothing to commit
      }
      if (PUSH) runCommand('git push');
    }

    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  console.log('Stop file detected. Exiting loop.');
}

main();