import fs from 'node:fs/promises';
import path from 'node:path';
import { moveFileTool } from '../tools/fs-tools.mjs';

/**
 * A bounded journal of recent file moves so organization is reversible. Every successful
 * move_file records its from -> to here; undo_file_moves walks the tail of the journal back,
 * restoring files to their original paths without ever clobbering what now lives there.
 */
const MAX_ENTRIES = 500;

async function readJournal(paths) {
  try {
    const raw = await fs.readFile(paths.fileJournalFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeJournal(paths, entries) {
  await fs.mkdir(path.dirname(paths.fileJournalFile), { recursive: true });
  await fs.writeFile(paths.fileJournalFile, JSON.stringify(entries.slice(-MAX_ENTRIES)));
}

/** Record a completed move so it can be undone. Best-effort: never fails the move itself. */
export async function recordFileMove(paths, { from, to, createdDirs }) {
  if (!paths?.fileJournalFile) return;
  try {
    const entries = await readJournal(paths);
    entries.push({ ts: Date.now(), op: 'move', from, to, createdDirs: Array.isArray(createdDirs) ? createdDirs : [] });
    await writeJournal(paths, entries);
  } catch {
    // A journal write failure must not turn a successful move into an error.
  }
}

export async function recentFileMoves(paths, count = 10) {
  return (await readJournal(paths)).slice(-Math.max(0, count));
}

/**
 * Reverse the last `count` recorded moves, most recent first. A move is skipped (never
 * clobbered) when its target has already been moved away or its original path is occupied
 * again. Reversed entries are dropped from the journal so a later undo advances to earlier
 * moves instead of repeating the same reversals.
 */
export async function undoFileMoves(paths, count = 1) {
  const entries = await readJournal(paths);
  const n = Math.min(Math.max(1, Math.floor(count) || 1), entries.length);
  const toUndo = entries.slice(-n);
  const undone = [];
  const skipped = [];
  const undoneRefs = new Set();

  for (const entry of [...toUndo].reverse()) {
    const targetExists = await fs.stat(entry.to).then(() => true).catch(() => false);
    const originFree = await fs.stat(entry.from).then(() => false).catch(() => true);
    if (!targetExists) {
      skipped.push({ from: entry.from, to: entry.to, reason: 'already undone or moved away' });
      continue;
    }
    if (!originFree) {
      skipped.push({ from: entry.from, to: entry.to, reason: 'original path is occupied again' });
      continue;
    }
    const result = await moveFileTool({ source: entry.to, destination: entry.from, overwrite: false });
    if (result.ok) {
      undone.push({ from: entry.from, to: entry.to });
      undoneRefs.add(entry);
      // Remove folders this move created (deepest first), but only when empty — rmdir refuses
      // non-empty dirs, so a folder the user already had, or that still holds files, stays.
      for (const dir of entry.createdDirs || []) {
        await fs.rmdir(dir).catch(() => {});
      }
    } else {
      skipped.push({ from: entry.from, to: entry.to, reason: result.output });
    }
  }

  if (undoneRefs.size > 0) {
    await writeJournal(paths, entries.filter((e) => !undoneRefs.has(e)));
  }

  return { undone, skipped };
}