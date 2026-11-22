import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeToolCall, evaluateToolSafety } from '../backend/tools/registry.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { recentFileMoves } from '../backend/state/file-journal.mjs';

async function exists(p) {
  return fs.stat(p).then(() => true).catch(() => false);
}

async function makeTmp(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-journal-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test('move_file is journaled and undo_file_moves restores the file', async (t) => {
  const home = await makeTmp(t);
  const paths = getRuntimePaths(home);
  const srcDir = path.join(home, 'files');
  await fs.mkdir(srcDir, { recursive: true });
  const src = path.join(srcDir, 'note.txt');
  await fs.writeFile(src, 'hello');
  const dest = path.join(home, 'sorted', 'note.txt');

  const moveRes = await executeToolCall({ name: 'move_file', args: { source: src, destination: dest } }, { paths });
  assert.equal(moveRes.ok, true);
  assert.equal(await exists(dest), true);
  assert.equal(await exists(src), false);

  // The completed move is journaled with its resolved paths.
  const journal = await recentFileMoves(paths, 10);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].from, src);
  assert.equal(journal[0].to, dest);

  // Undo restores the file to its original path and drops the entry.
  const undoRes = await executeToolCall({ name: 'undo_file_moves', args: {} }, { paths });
  assert.equal(undoRes.ok, true);
  assert.match(undoRes.output, /Undid 1 move/);
  assert.equal(await exists(src), true);
  assert.equal(await exists(dest), false);
  assert.equal((await recentFileMoves(paths, 10)).length, 0);
});

test('undo_file_moves never clobbers a re-occupied original path', async (t) => {
  const home = await makeTmp(t);
  const paths = getRuntimePaths(home);
  const src = path.join(home, 'a.txt');
  await fs.writeFile(src, 'original');
  const dest = path.join(home, 'b.txt');
  await executeToolCall({ name: 'move_file', args: { source: src, destination: dest } }, { paths });

  // Something new now lives where the file came from.
  await fs.writeFile(src, 'new occupant');

  const undoRes = await executeToolCall({ name: 'undo_file_moves', args: {} }, { paths });
  assert.equal(undoRes.ok, true);
  assert.match(undoRes.output, /skipped/);
  // The occupant is untouched and the moved file stays where it is.
  assert.equal(await fs.readFile(src, 'utf8'), 'new occupant');
  assert.equal(await exists(dest), true);
});

test('undo_file_moves skips a move whose target has already been moved away', async (t) => {
  const home = await makeTmp(t);
  const paths = getRuntimePaths(home);
  const src = path.join(home, 'a.txt');
  await fs.writeFile(src, 'x');
  const dest = path.join(home, 'b.txt');
  await executeToolCall({ name: 'move_file', args: { source: src, destination: dest } }, { paths });

  // The moved file is gone (deleted or moved elsewhere).
  await fs.rm(dest);

  const undoRes = await executeToolCall({ name: 'undo_file_moves', args: {} }, { paths });
  assert.equal(undoRes.ok, true);
  assert.match(undoRes.output, /skipped/);
  assert.equal(await exists(src), false);
});

test('undo_file_moves(count) reverses several moves and reports each restoration', async (t) => {
  const home = await makeTmp(t);
  const paths = getRuntimePaths(home);
  const dir = path.join(home, 'src');
  await fs.mkdir(dir, { recursive: true });
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  await fs.writeFile(a, 'A');
  await fs.writeFile(b, 'B');
  await executeToolCall({ name: 'move_file', args: { source: a, destination: path.join(home, 'out', 'a.txt') } }, { paths });
  await executeToolCall({ name: 'move_file', args: { source: b, destination: path.join(home, 'out', 'b.txt') } }, { paths });

  const undoRes = await executeToolCall({ name: 'undo_file_moves', args: { count: 2 } }, { paths });
  assert.equal(undoRes.ok, true);
  assert.match(undoRes.output, /Undid 2 moves/);
  assert.equal(await exists(a), true);
  assert.equal(await exists(b), true);
  assert.equal(await exists(path.join(home, 'out', 'a.txt')), false);
  assert.equal(await exists(path.join(home, 'out', 'b.txt')), false);
  assert.equal((await recentFileMoves(paths, 10)).length, 0);
});

test('undo_file_moves with no count reverses a whole batch move at once', async (t) => {
  const home = await makeTmp(t);
  const paths = getRuntimePaths(home);
  const dir = path.join(home, 'src');
  await fs.mkdir(dir, { recursive: true });
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  const c = path.join(dir, 'c.txt');
  await fs.writeFile(a, 'A');
  await fs.writeFile(b, 'B');
  await fs.writeFile(c, 'C');

  // One batch move of three files (a single move_file call).
  await executeToolCall({ name: 'move_file', args: { moves: [
    { source: a, destination: path.join(home, 'out', 'a.txt') },
    { source: b, destination: path.join(home, 'out', 'b.txt') },
    { source: c, destination: path.join(home, 'out', 'c.txt') },
  ] } }, { paths });
  assert.equal((await recentFileMoves(paths, 10)).length, 3);

  // A single undo (no count) reverses the whole batch.
  const undoRes = await executeToolCall({ name: 'undo_file_moves', args: {} }, { paths });
  assert.equal(undoRes.ok, true);
  assert.match(undoRes.output, /Undid 3 moves/);
  assert.equal(await exists(a), true);
  assert.equal(await exists(b), true);
  assert.equal(await exists(c), true);
  assert.equal((await recentFileMoves(paths, 10)).length, 0);
});

test('undo_file_moves with an empty journal reports there is nothing to undo', async (t) => {
  const home = await makeTmp(t);
  const paths = getRuntimePaths(home);
  const undoRes = await executeToolCall({ name: 'undo_file_moves', args: {} }, { paths });
  assert.equal(undoRes.ok, true);
  assert.match(undoRes.output, /No file moves to undo/);
});

test('undo removes folders a move created but preserves pre-existing folders', async (t) => {
  const home = await makeTmp(t);
  const paths = getRuntimePaths(home);
  const dir = path.join(home, 'files');
  await fs.mkdir(path.join(dir, 'Existing'), { recursive: true });
  await fs.writeFile(path.join(dir, 'a.txt'), 'a');
  await fs.writeFile(path.join(dir, 'b.txt'), 'b');

  // a.txt -> New/a.txt creates "New"; b.txt -> Existing/b.txt uses a folder that already exists.
  assert.equal((await executeToolCall({ name: 'move_file', args: { source: path.join(dir, 'a.txt'), destination: path.join(dir, 'New', 'a.txt') } }, { paths })).ok, true);
  assert.equal((await executeToolCall({ name: 'move_file', args: { source: path.join(dir, 'b.txt'), destination: path.join(dir, 'Existing', 'b.txt') } }, { paths })).ok, true);

  await executeToolCall({ name: 'undo_file_moves', args: { count: 2 } }, { paths });

  const exists = (p) => fs.stat(p).then(() => true).catch(() => false);
  const top = await fs.readdir(dir);
  assert.ok(top.includes('a.txt') && top.includes('b.txt'), 'files should be restored');
  assert.equal(await exists(path.join(dir, 'New')), false, 'folder created by the move should be removed once empty');
  assert.equal(await exists(path.join(dir, 'Existing')), true, 'pre-existing folder should be preserved');
});

test('undo_file_moves is treated as a mutating action for approval purposes', () => {
  assert.equal(evaluateToolSafety({ name: 'undo_file_moves', args: {} }, { safetyMode: 'auto', isHeadless: false }).decision, 'allow');
  assert.equal(evaluateToolSafety({ name: 'undo_file_moves', args: {} }, { safetyMode: 'ask', isHeadless: false }).decision, 'ask');
  assert.equal(evaluateToolSafety({ name: 'undo_file_moves', args: {} }, { safetyMode: 'ask', isHeadless: true, allowAutoRun: false }).decision, 'block');
  assert.equal(evaluateToolSafety({ name: 'undo_file_moves', args: {} }, { safetyMode: 'ask', isHeadless: true, allowAutoRun: true }).decision, 'allow');
});