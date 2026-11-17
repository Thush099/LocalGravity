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

export async function listDir({ path: dirPath, recursive = false, max_entries = 120 }) {
  const resolved = expandUserPath(dirPath || '.');
  const results = [];

  async function walk(curDir, relPrefix = '') {
    if (results.length >= max_entries) return;
    const entries = await fs.readdir(curDir, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= max_entries) break;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(curDir, entry.name);
      const display = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(`[DIR]  ${display}/`);
        if (recursive) await walk(full, display);
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

export async function readFileTool({ path: filePath, start_line = 1, end_line }) {
  const resolved = expandUserPath(filePath);
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

export async function writeFileTool({ path: filePath, content, overwrite = true }) {
  const resolved = expandUserPath(filePath);
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

export async function editFileTool({ path: filePath, target, replacement }) {
  const resolved = expandUserPath(filePath);
  const original = await fs.readFile(resolved, 'utf8');
  if (!target || !original.includes(target)) {
    return { ok: false, output: `Target snippet not found in ${resolved}` };
  }
  const updated = original.replaceAll(target, () => String(replacement ?? ''));
  await fs.writeFile(resolved, updated, 'utf8');
  return {
    ok: true,
    output: `Edited ${resolved}`,
    diff: buildCompactDiff(original, updated, resolved),
  };
}

export async function searchFilesTool({ root, query, glob }) {
  const resolvedRoot = expandUserPath(root || '.');
  const needle = String(query || '').toLowerCase();
  if (!needle) return { ok: false, output: 'Query cannot be empty.' };

  const matches = [];
  const extFilter = glob && glob.startsWith('*.') ? glob.slice(1).toLowerCase() : null;

  async function walk(dir) {
    if (matches.length >= 60) return;
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
        await walk(full);
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
