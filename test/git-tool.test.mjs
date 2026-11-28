import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitTool } from '../backend/tools/git-tool.mjs';

const execFileAsync = promisify(execFile);

let repoDir;

async function git(args, cwd) {
  return execFileAsync('git', args, { cwd });
}

before(async () => {
  repoDir = await mkdtemp(path.join(tmpdir(), 'lg-git-tool-'));
  await git(['init', '-q'], repoDir);
  await git(['config', 'user.email', 'test@example.com'], repoDir);
  await git(['config', 'user.name', 'Test'], repoDir);
  await git(['config', 'commit.gpgsign', 'false'], repoDir);
  await writeFile(path.join(repoDir, 'file.txt'), 'one\n');
  await git(['add', '-A'], repoDir);
  await git(['commit', '-q', '-m', 'init commit'], repoDir);
});

after(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe('gitTool against a real repository', () => {
  test('status reports the branch and a clean tree', async () => {
    const res = await gitTool({ action: 'status' }, { cwd: repoDir });
    assert.equal(res.ok, true);
    assert.ok(res.branch.length > 0, 'branch is reported');
    assert.equal(res.status, '', 'clean tree reports empty status');
  });

  test('status lists modified files', async () => {
    await writeFile(path.join(repoDir, 'file.txt'), 'two\n');
    const res = await gitTool({ action: 'status' }, { cwd: repoDir });
    assert.equal(res.ok, true);
    assert.match(res.status, /file\.txt/);
    await git(['checkout', '-q', '--', 'file.txt'], repoDir);
  });

  test('log shows committed history with the count argument respected', async () => {
    const res = await gitTool({ action: 'log', count: 5 }, { cwd: repoDir });
    assert.equal(res.ok, true);
    assert.match(res.log, /init commit/);
  });

  test('commit stages and commits with the given message', async () => {
    await writeFile(path.join(repoDir, 'file.txt'), 'three\n');
    const res = await gitTool({ action: 'commit', message: 'second commit' }, { cwd: repoDir });
    assert.equal(res.ok, true);
    assert.match(res.result, /1 file changed/);

    const log = await gitTool({ action: 'log' }, { cwd: repoDir });
    assert.match(log.log, /second commit/);
  });

  test('diff shows unstaged changes', async () => {
    await writeFile(path.join(repoDir, 'file.txt'), 'four\n');
    const res = await gitTool({ action: 'diff' }, { cwd: repoDir });
    assert.equal(res.ok, true);
    assert.match(res.diff, /\+four/);
    await git(['checkout', '-q', '--', 'file.txt'], repoDir);
  });

  test('branch lists branches and creates one when a name is given', async () => {
    const listed = await gitTool({ action: 'branch' }, { cwd: repoDir });
    assert.equal(listed.ok, true);
    assert.match(listed.branches, /main|master/);

    const created = await gitTool({ action: 'branch', branch: 'feature-x' }, { cwd: repoDir });
    assert.equal(created.ok, true);
    const after = await gitTool({ action: 'branch' }, { cwd: repoDir });
    assert.match(after.branches, /feature-x/);
    await git(['checkout', '-q', '-'], repoDir);
  });

  test('directory argument resolves relative to the provided cwd', async () => {
    await mkdir(path.join(repoDir, 'nested'));
    const res = await gitTool({ action: 'status', directory: 'nested' }, { cwd: repoDir });
    assert.equal(res.ok, true, 'subdirectories of the repo work');
  });
});

describe('gitTool error contracts', () => {
  test('commit without a message is rejected', async () => {
    const res = await gitTool({ action: 'commit' }, { cwd: repoDir });
    assert.equal(res.ok, false);
    assert.match(res.error, /commit message is required/);
  });

  test('unknown actions are rejected with the action name', async () => {
    const res = await gitTool({ action: 'rewrite-history' }, { cwd: repoDir });
    assert.equal(res.ok, false);
    assert.match(res.error, /Unknown git action: rewrite-history/);
  });

  test('a non-repository directory fails gracefully', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'lg-git-plain-'));
    try {
      const res = await gitTool({ action: 'status' }, { cwd: plain });
      assert.equal(res.ok, false);
      assert.ok(res.error.length > 0);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
