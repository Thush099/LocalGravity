import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeToolCall } from './tools/registry.mjs';
import { getRuntimePaths } from './state/paths.mjs';
import { recentFileMoves } from './state/file-journal.mjs';

/**
 * Instant actions run entirely on-device with no model round-trip. They are a fixed,
 * read-only whitelist so the common Mac lookups (health, storage, clipboard, today's
 * schedule) answer in milliseconds instead of waiting for a local model to pick tools.
 * Every action returns { ok, title, output } and never mutates state.
 */

const MAX_SCANNED_ENTRIES = 50000;
const MAX_OUTPUT_CHARS = 12000;
const READDIR_CONCURRENCY = 32;
const STAT_CONCURRENCY = 64;
// Documents at or under this many files gets an exact, instant total; a larger folder
// would take seconds to sum, so it falls back to a biggest-folders breakdown instead.
// The threshold doubles as the cheap small-vs-huge probe, so it stays low on purpose.
const DOCUMENTS_EXACT_MAX = 2000;

/** Run fn over items with at most `limit` in flight at once, preserving order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

function bounded(text, limit = MAX_OUTPUT_CHARS) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n… (truncated)` : value;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/**
 * Recursively measure a folder's size. Directory reads and file stats run concurrently
 * (bounded) so a large tree does not cost one syscall per file in sequence.
 * `budget.count` tracks files (what drives size and stat cost); directories are bounded
 * separately so a folder with many subfolders is not spuriously truncated.
 */
async function measureDir(root, budget) {
  const maxDirs = budget.maxDirs ?? budget.max;
  const filePaths = [];
  let queue = [root];
  let dirs = 0;
  while (queue.length > 0 && budget.count < budget.max && dirs < maxDirs) {
    const batch = queue.splice(0, READDIR_CONCURRENCY);
    const reads = await mapWithConcurrency(batch, READDIR_CONCURRENCY, async (dir) => {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        // Unreadable folder contributes nothing.
      }
      return { dir, entries };
    });
    for (const { dir, entries } of reads) {
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (dirs >= maxDirs) continue;
          dirs += 1;
          queue.push(full);
        } else if (entry.isFile()) {
          if (budget.count >= budget.max) continue;
          budget.count += 1;
          filePaths.push(full);
        }
      }
    }
  }
  const truncated = budget.count >= budget.max || dirs >= maxDirs;
  const sizes = await mapWithConcurrency(filePaths, STAT_CONCURRENCY, async (file) => {
    try {
      return (await fs.stat(file)).size;
    } catch {
      return 0;
    }
  });
  let total = 0;
  for (const size of sizes) total += size;
  return { total, files: filePaths.length, truncated };
}

/**
 * Largest top-level items in a folder — the fastest clutter signal. Items are sized
 * with a bounded per-item scan so a giant folder surfaces its biggest children in
 * milliseconds instead of walking every file. Sizes of huge items are approximate.
 */
async function largestTopLevel(dir, { perItem, limit = 8, maxItems = 40 } = {}) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries.slice(0, maxItems)) {
    const full = path.join(dir, entry.name);
    let size = 0;
    if (entry.isDirectory()) {
      size = (await measureDir(full, { count: 0, max: perItem, maxDirs: perItem })).total;
    } else {
      size = await fs.stat(full).then((s) => s.size).catch(() => 0);
    }
    items.push({ name: entry.name, size, isDir: entry.isDirectory() });
  }
  return items
    .filter((x) => x.size > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, limit);
}

export async function storageAudit({ maxEntries = MAX_SCANNED_ENTRIES } = {}) {
  const home = os.homedir();
  const lines = ['Storage & clutter (on-device):'];

  // Downloads and Desktop are small clutter folders: exact totals, scanned fully.
  for (const name of ['Downloads', 'Desktop']) {
    const dir = path.join(home, name);
    try {
      await fs.access(dir);
    } catch {
      lines.push(`${name}: not present`);
      continue;
    }
    const { total, files, truncated } = await measureDir(dir, { count: 0, max: maxEntries, maxDirs: maxEntries });
    lines.push(`${name}: ${formatBytes(total)} across ${files} file${files === 1 ? '' : 's'}${truncated ? ' (partial)' : ''}`);
  }

  // Documents is often huge (100k+ files). Summing every byte would take seconds and
  // defeat the on-device "instant" promise, so give an exact total when it is small and
  // otherwise surface its biggest folders — the useful clutter signal — instead.
  const docsDir = path.join(home, 'Documents');
  try {
    await fs.access(docsDir);
    const probe = await measureDir(docsDir, { count: 0, max: DOCUMENTS_EXACT_MAX, maxDirs: DOCUMENTS_EXACT_MAX });
    if (!probe.truncated) {
      lines.push(`Documents: ${formatBytes(probe.total)} across ${probe.files} file${probe.files === 1 ? '' : 's'}`);
    } else {
      const docsTop = await largestTopLevel(docsDir, { perItem: 3000 });
      if (docsTop.length > 0) {
        lines.push('', 'Biggest folders in Documents (approximate — this folder is large):');
        for (const item of docsTop) {
          lines.push(`  ${item.isDir ? '[DIR] ' : ''}${item.name} — ~${formatBytes(item.size)}`);
        }
      }
    }
  } catch {
    // Documents may be absent or unreadable; the other folders still report.
  }

  // Largest top-level items in Downloads: the fastest clutter signal, no model needed.
  const dlTop = await largestTopLevel(path.join(home, 'Downloads'), { perItem: maxEntries });
  if (dlTop.length > 0) {
    lines.push('', 'Largest items in Downloads:');
    for (const item of dlTop) {
      lines.push(`  ${item.isDir ? '[DIR] ' : ''}${item.name} — ${formatBytes(item.size)}`);
    }
  }

  return bounded(lines.join('\n'));
}

// Deterministic file-extension → target-folder map for the read-only organize preview.
const ORGANIZE_CATEGORIES = [
  { folder: 'Images', exts: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp', '.svg', '.raw', '.dng'] },
  { folder: 'Documents', exts: ['.pdf', '.doc', '.docx', '.pages', '.txt', '.md', '.rtf', '.xls', '.xlsx', '.numbers', '.csv', '.ppt', '.pptx', '.key', '.epub'] },
  { folder: 'Audio', exts: ['.mp3', '.m4a', '.wav', '.flac', '.aac', '.aiff', '.ogg'] },
  { folder: 'Video', exts: ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.wmv', '.flv'] },
  { folder: 'Archives', exts: ['.zip', '.dmg', '.pkg', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar', '.iso', '.xip'] },
  { folder: 'Code', exts: ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.swift', '.sh', '.html', '.css', '.json', '.yaml', '.yml', '.toml', '.sql', '.ipynb'] },
];
const ORGANIZE_CATEGORY_BY_EXT = new Map();
for (const cat of ORGANIZE_CATEGORIES) {
  for (const ext of cat.exts) ORGANIZE_CATEGORY_BY_EXT.set(ext, cat.folder);
}

/**
 * Read-only preview of how a folder's loose top-level files would sort into type folders.
 * Categorizes by extension only (no per-file stat), so it stays fast on cluttered folders.
 */
export async function organizePreview(baseDir, { maxEntries = 20000, maxNames = 3 } = {}) {
  const dirName = path.basename(baseDir);
  let entries = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return `${dirName}: not readable.`;
  }
  const byFolder = new Map();
  let files = 0;
  let truncated = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Skip hidden files (.DS_Store, .localized, .Rhistory, …) — macOS metadata, not
    // clutter to sort into folders.
    if (entry.name.startsWith('.')) continue;
    if (files >= maxEntries) {
      truncated = true;
      break;
    }
    files += 1;
    const target = ORGANIZE_CATEGORY_BY_EXT.get(path.extname(entry.name).toLowerCase()) || 'Other';
    if (!byFolder.has(target)) byFolder.set(target, []);
    byFolder.get(target).push(entry.name);
  }
  if (files === 0) return `${dirName}: no loose files to sort.`;
  const parts = [...byFolder.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([folder, names]) => {
      const shown = names.slice(0, maxNames).join(', ');
      const more = names.length > maxNames ? `, +${names.length - maxNames} more` : '';
      return `${names.length} → ${folder}/ (${shown}${more})`;
    });
  return bounded(`${dirName}: ${files} loose file${files === 1 ? '' : 's'}${truncated ? ' (capped)' : ''} — ${parts.join(' · ')}`);
}

const ACTIONS = {
  system_health: {
    title: 'System health',
    async run(ctx) {
      const result = await executeToolCall({ name: 'system_stats', args: { include_processes: true } }, ctx);
      return bounded(result.output);
    },
  },
  storage_audit: {
    title: 'Storage & clutter audit',
    async run() {
      return storageAudit();
    },
  },
  clipboard_read: {
    title: 'Clipboard contents',
    async run(ctx) {
      const result = await executeToolCall({ name: 'paste_from_clipboard', args: {} }, ctx);
      return bounded(result.output);
    },
  },
  schedule_today: {
    title: "Today's schedule",
    async run(ctx) {
      const result = await executeToolCall({ name: 'list_schedule_items', args: { today_only: true } }, ctx);
      return bounded(result.output);
    },
  },
  organize_plan: {
    title: 'Organize plan (read-only preview)',
    async run() {
      const home = os.homedir();
      const parts = [];
      for (const name of ['Downloads', 'Desktop', 'Documents']) {
        const dir = path.join(home, name);
        try {
          await fs.access(dir);
        } catch {
          continue;
        }
        parts.push(await organizePreview(dir));
      }
      if (parts.length === 0) return 'No Downloads, Desktop, or Documents folder found.';
      // Surface moves still pending undo so the preview is transparent about reversibility.
      let pendingNote = '';
      try {
        const recent = await recentFileMoves(getRuntimePaths(), 500);
        if (recent.length > 0) {
          pendingNote = `${recent.length} recent file move(s) are still reversible — say "undo the file moves" to put them back.`;
        }
      } catch {
        // Journal read is best-effort; the preview works without it.
      }
      return bounded(
        [
          'Read-only organize preview (nothing moved yet):',
          ...parts,
          '',
          'To sort a folder, say "organize my Downloads". Any move can be reversed with "undo the file moves".',
          pendingNote,
        ].filter(Boolean).join('\n'),
      );
    },
  },
  docker_ps: {
    title: 'Docker Status',
    async run(ctx) {
      const result = await executeToolCall({ name: 'docker_op', args: { action: 'ps' } }, ctx);
      return bounded(JSON.stringify(result, null, 2));
    },
  },
};

export const INSTANT_ACTION_IDS = Object.keys(ACTIONS);

export function getInstantAction(id) {
  return ACTIONS[String(id || '')] || null;
}

/**
 * Run a whitelisted instant action. Rejects unknown ids and never executes arbitrary input.
 */
export async function runInstantAction(id, context = {}) {
  const action = getInstantAction(id);
  if (!action) {
    return { ok: false, title: 'Unknown action', output: `No instant action "${id}". Available: ${INSTANT_ACTION_IDS.join(', ')}` };
  }
  const ctx = { paths: context.paths || getRuntimePaths(), cwd: context.cwd };
  try {
    const output = await action.run(ctx);
    return { ok: true, title: action.title, output: output || '(no output)' };
  } catch (err) {
    return { ok: false, title: action.title, output: `Action failed: ${err.message}` };
  }
}