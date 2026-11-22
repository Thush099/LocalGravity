import fs from 'node:fs/promises';
import path from 'node:path';
import { expandUserPath } from './safety.mjs';

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function buildCompactDiff(oldText, newText, filePath) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const lines = [`--- ${filePath}`, `+++ ${filePath}`];
  const max = Math.max(oldLines.length, newLines.length);
  let shown = 0;

  for (let i = 0; i < max && shown < 80; i++) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a !== b) {
      if (a !== undefined) {
        lines.push(`-${a}`);
        shown++;
      }
      if (b !== undefined) {
        lines.push(`+${b}`);
        shown++;
      }
    }
  }
  if (shown >= 80) lines.push('... (diff truncated)');
  return lines.join('\n');
}

export async function listDir({ path: dirPath, recursive = false, max_entries = 120 }, opts = {}) {
  const resolved = expandUserPath(dirPath || '.', opts.cwd);
  const results = [];
  const MAX_DEPTH = 12;

  async function walk(curDir, relPrefix = '', depth = 0) {
    if (results.length >= max_entries) return;
    if (depth > MAX_DEPTH) return;
    const entries = await fs.readdir(curDir, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= max_entries) break;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(curDir, entry.name);
      const display = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(`[DIR]  ${display}/`);
        if (recursive) await walk(full, display, depth + 1);
      } else {
        try {
          const st = await fs.stat(full);
          results.push(`[FILE] ${display} (${formatBytes(st.size)})`);
        } catch {
          results.push(`[FILE] ${display}`);
        }
      }
    }
  }

  await walk(resolved);
  const header = `Directory: ${resolved} (${results.length} shown)`;
  return {
    ok: true,
    output: results.length > 0 ? `${header}\n${results.join('\n')}` : `${header}\n(empty)`,
  };
}

export async function readFileTool({ path: filePath, start_line = 1, end_line }, opts = {}) {
  const resolved = expandUserPath(filePath, opts.cwd);
  const raw = await fs.readFile(resolved, 'utf8');
  const lines = raw.split(/\r?\n/);
  const start = Math.max(1, Number(start_line) || 1);
  const maxLines = 250;
  const end = Math.min(lines.length, end_line ? Number(end_line) : start + maxLines - 1);
  const slice = lines.slice(start - 1, end).map((l, idx) => `${start + idx}: ${l}`);
  const truncatedNote = end < lines.length ? `\n... (${lines.length - end} more lines)` : '';
  return {
    ok: true,
    output: `File: ${resolved} (lines ${start}-${end} of ${lines.length})\n${slice.join('\n')}${truncatedNote}`,
  };
}

export async function writeFileTool({ path: filePath, content, overwrite = true }, opts = {}) {
  const resolved = expandUserPath(filePath, opts.cwd);
  let oldContent = '';
  let existed = false;
  try {
    oldContent = await fs.readFile(resolved, 'utf8');
    existed = true;
  } catch {
    existed = false;
  }
  if (existed && !overwrite) {
    return { ok: false, output: `File already exists and overwrite=false: ${resolved}` };
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const nextContent = String(content ?? '');
  await fs.writeFile(resolved, nextContent, 'utf8');
  const diff = buildCompactDiff(oldContent, nextContent, resolved);
  return {
    ok: true,
    output: `${existed ? 'Updated' : 'Created'} ${resolved} (${Buffer.byteLength(nextContent, 'utf8')} bytes)`,
    diff,
  };
}

/**
 * Move or rename a file or folder without shell quoting. Creates missing destination folders,
 * refuses to clobber existing paths unless overwrite=true, and falls back to copy+delete across volumes.
 */
/**
 * Ancestors of `dir` that do not exist yet (deepest first), so a move can report which folders
 * it created and undo can remove them again only if they end up empty.
 */
async function collectMissingDirs(dir) {
  const missing = [];
  let cur = dir;
  while (cur && cur !== path.dirname(cur)) {
    const exists = await fs.stat(cur).then(() => true).catch(() => false);
    if (exists) break;
    missing.push(cur);
    cur = path.dirname(cur);
  }
  return missing;
}

async function moveOneFile(source, destination, overwrite = false, baseCwd) {
  if (!source || !destination) {
    return { ok: false, output: 'move_file requires both "source" and "destination" paths.' };
  }
  const resolvedSource = expandUserPath(String(source), baseCwd);
  const resolvedDest = expandUserPath(String(destination), baseCwd);
  if (resolvedSource === resolvedDest) {
    return { ok: false, output: 'Source and destination are the same path.' };
  }
  if (resolvedDest.startsWith(resolvedSource + path.sep)) {
    return { ok: false, output: `Cannot move "${resolvedSource}" into its own subfolder "${resolvedDest}".` };
  }

  let srcStat;
  try {
    srcStat = await fs.stat(resolvedSource);
  } catch {
    return { ok: false, output: `Source not found: ${resolvedSource}` };
  }

  const destStat = await fs.stat(resolvedDest).catch(() => null);
  if (destStat && !overwrite) {
    return { ok: false, output: `Destination already exists and overwrite=false: ${resolvedDest}` };
  }
  if (destStat && (srcStat.isDirectory() || destStat.isDirectory())) {
    return { ok: false, output: 'move_file cannot overwrite a directory; move the folder to a new destination instead.' };
  }
  if (destStat) {
    await fs.rm(resolvedDest, { force: true });
  }

  const destDir = path.dirname(resolvedDest);
  const createdDirs = await collectMissingDirs(destDir);
  await fs.mkdir(destDir, { recursive: true });
  try {
    await fs.rename(resolvedSource, resolvedDest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // Cross-volume move: copy then delete the original.
      await fs.cp(resolvedSource, resolvedDest, { recursive: true, force: true });
      await fs.rm(resolvedSource, { recursive: true, force: true });
    } else {
      return { ok: false, output: `move_file failed: ${err.message}` };
    }
  }

  const kind = srcStat.isDirectory() ? 'folder' : 'file';
  return { ok: true, output: `Moved ${kind} ${resolvedSource} -> ${resolvedDest}`, from: resolvedSource, to: resolvedDest, createdDirs };
}

function normalizeMoveItem(item = {}, fallbackOverwrite = false) {
  return {
    source: item.source ?? item.from ?? item.src ?? item.file ?? item.path,
    destination: item.destination ?? item.to ?? item.dest ?? item.target,
    overwrite: item.overwrite ?? fallbackOverwrite ?? false,
  };
}

export async function moveFileTool({ source, destination, moves, overwrite = false }, opts = {}) {
  const items =
    Array.isArray(moves) && moves.length > 0
      ? moves.map((m) => normalizeMoveItem(m, overwrite))
      : [normalizeMoveItem({ source, destination, overwrite })];

  const results = [];
  for (const item of items) {
    results.push(await moveOneFile(item.source, item.destination, item.overwrite, opts.cwd));
  }

  // A single move keeps the exact shape existing callers depend on.
  if (items.length === 1) return results[0];

  const moved = results.filter((r) => r.ok).map((r) => ({ from: r.from, to: r.to, createdDirs: r.createdDirs }));
  const failures = results.filter((r) => !r.ok).map((r) => r.output);
  const output = [
    `Moved ${moved.length} of ${items.length} items.`,
    ...moved.map((m) => `  ${m.from} -> ${m.to}`),
    ...(failures.length ? ['', 'Failed:', ...failures.map((f) => `  - ${f}`)] : []),
  ].join('\n');
  return { ok: moved.length > 0, output, moved, failures };
}

function tryWhitespaceNormalizedReplace(original, target, replacement) {
  const origLines = original.split(/\r?\n/);
  const targetLines = String(target || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l, idx, arr) => !(idx === 0 && !l) && !(idx === arr.length - 1 && !l));

  if (targetLines.length === 0) return null;

  for (let i = 0; i <= origLines.length - targetLines.length; i++) {
    let matches = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (origLines[i + j].trim() !== targetLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      const before = origLines.slice(0, i);
      const after = origLines.slice(i + targetLines.length);
      return [...before, String(replacement ?? ''), ...after].join('\n');
    }
  }
  return null;
}

export async function editFileTool({ path: filePath, target, replacement }, opts = {}) {
  const resolved = expandUserPath(filePath, opts.cwd);
  const original = await fs.readFile(resolved, 'utf8');
  const needle = String(target || '');

  if (!needle) {
    return { ok: false, output: `Target snippet cannot be empty when editing ${resolved}` };
  }

  let updated = null;
  if (original.includes(needle)) {
    updated = original.replaceAll(needle, () => String(replacement ?? ''));
  } else {
    updated = tryWhitespaceNormalizedReplace(original, needle, replacement);
  }

  if (updated === null) {
    // Provide nearby line preview so the model can immediately self-correct without an extra read_file round-trip
    const firstNonEmpty = needle
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length >= 3);
    const origLines = original.split(/\r?\n/);
    let contextHint = '';
    if (firstNonEmpty) {
      const hitIdx = origLines.findIndex((l) => l.toLowerCase().includes(firstNonEmpty.slice(0, 24).toLowerCase()));
      if (hitIdx !== -1) {
        const start = Math.max(0, hitIdx - 2);
        const end = Math.min(origLines.length, hitIdx + 6);
        const preview = origLines
          .slice(start, end)
          .map((l, idx) => `${start + idx + 1}: ${l}`)
          .join('\n');
        contextHint = `\nClosest lines in ${resolved}:\n${preview}`;
      }
    }
    return {
      ok: false,
      output: `Target snippet not found in ${resolved}.${contextHint}`,
    };
  }

  await fs.writeFile(resolved, updated, 'utf8');
  return {
    ok: true,
    output: `Edited ${resolved}`,
    diff: buildCompactDiff(original, updated, resolved),
  };
}

export async function searchFilesTool({ root, query, glob }, opts = {}) {
  const resolvedRoot = expandUserPath(root || '.', opts.cwd);
  const needle = String(query || '').toLowerCase();
  if (!needle) return { ok: false, output: 'Query cannot be empty.' };

  const matches = [];
  const extFilter = glob && glob.startsWith('*.') ? glob.slice(1).toLowerCase() : null;
  const MAX_DEPTH = 12;

  async function walk(dir, depth = 0) {
    if (matches.length >= 60) return;
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= 60) break;
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (extFilter && !entry.name.toLowerCase().endsWith(extFilter)) continue;
        if (entry.name.toLowerCase().includes(needle)) {
          matches.push(`${full} (filename match)`);
        }
        try {
          const st = await fs.stat(full);
          if (st.size > 512 * 1024) continue;
          const text = await fs.readFile(full, 'utf8');
          if (text.includes('\0')) continue;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < 60; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              matches.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
            }
          }
        } catch {
          // Skip binary/unreadable
        }
      }
    }
  }

  await walk(resolvedRoot);
  return {
    ok: true,
    output: matches.length > 0 ? matches.join('\n') : `No matches for "${query}" under ${resolvedRoot}`,
  };
}
