import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeToolCall } from './tools/registry.mjs';
import { getRuntimePaths } from './state/paths.mjs';
import { recentFileMoves } from './state/file-journal.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

// --- Smarter, content-aware file categorization -----------------------------
// Clear-cut types route by extension alone (no I/O). Ambiguous files -- no known
// extension -- get a bounded content peek so raw notes, source, and logs land in
// real folders instead of a junk-drawer "Other". Signals are checked strongest
// first so a screenshot named "...invoice..." still counts as a screenshot.

const CATEGORY_BY_EXT = new Map([
  ['.jpg', 'Images'], ['.jpeg', 'Images'], ['.png', 'Images'], ['.gif', 'Images'],
  ['.webp', 'Images'], ['.heic', 'Images'], ['.heif', 'Images'], ['.tif', 'Images'],
  ['.tiff', 'Images'], ['.bmp', 'Images'], ['.svg', 'Images'], ['.raw', 'Images'], ['.dng', 'Images'],
  ['.pdf', 'Documents'], ['.doc', 'Documents'], ['.docx', 'Documents'], ['.pages', 'Documents'],
  ['.txt', 'Documents'], ['.md', 'Documents'], ['.rtf', 'Documents'], ['.xls', 'Documents'],
  ['.xlsx', 'Documents'], ['.numbers', 'Documents'], ['.csv', 'Documents'], ['.ppt', 'Documents'],
  ['.pptx', 'Documents'], ['.key', 'Documents'], ['.epub', 'Documents'],
  ['.mp3', 'Audio'], ['.m4a', 'Audio'], ['.wav', 'Audio'], ['.flac', 'Audio'],
  ['.aac', 'Audio'], ['.aiff', 'Audio'], ['.ogg', 'Audio'],
  ['.mp4', 'Video'], ['.mov', 'Video'], ['.m4v', 'Video'], ['.avi', 'Video'], ['.mkv', 'Video'],
  ['.webm', 'Video'], ['.wmv', 'Video'], ['.flv', 'Video'],
  ['.zip', 'Archives'], ['.tar', 'Archives'], ['.gz', 'Archives'], ['.tgz', 'Archives'],
  ['.bz2', 'Archives'], ['.7z', 'Archives'], ['.rar', 'Archives'], ['.iso', 'Archives'], ['.xip', 'Archives'],
  ['.js', 'Code'], ['.mjs', 'Code'], ['.ts', 'Code'], ['.tsx', 'Code'], ['.jsx', 'Code'],
  ['.py', 'Code'], ['.rb', 'Code'], ['.go', 'Code'], ['.rs', 'Code'], ['.java', 'Code'],
  ['.c', 'Code'], ['.cpp', 'Code'], ['.h', 'Code'], ['.swift', 'Code'], ['.sh', 'Code'],
  ['.html', 'Code'], ['.css', 'Code'], ['.json', 'Code'], ['.yaml', 'Code'], ['.yml', 'Code'],
  ['.toml', 'Code'], ['.sql', 'Code'], ['.ipynb', 'Code'],
]);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp', '.svg', '.raw', '.dng']);
const ARCHIVE_EXTS = new Set(['.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar', '.iso', '.xip']);
const INSTALLER_EXTS = new Set(['.dmg', '.pkg', '.mpkg', '.msi', '.exe', '.appimage']);
const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2', '.eot']);
const BACKUP_EXTS = new Set(['.bak', '.backup', '.old', '.swp']);
const SCREENSHOT_RE = /screen[\s._-]?(shot|capture)|cleanshot|screenshot/i;
const INSTALLER_RE = /\b(setup|install(er)?)\b/i;
const BACKUP_RE = /\bback[\s._-]?ups?\b/i;

// Content cues for files whose extension tells us nothing useful. Each is strict
// enough that ordinary prose ("please return the book") is never mistaken for code.
const CODE_CUE = /\bfunction\s+\w+|\bdef\s+\w+\s*\(|#include\b|^#!|\bimport\s+\w+|\b(const|let|var)\s+[\w$]+\s*=|=>|[{}]\s*$/m;
const LOG_CUE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}\b|\b(ERROR|WARNING|WARN|INFO|DEBUG|TRACE|FATAL|CRITICAL)\s*:|syslog/i;

function looksTabular(sample) {
  const lines = sample.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 6);
  if (lines.length < 2) return false;
  const delim = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : null;
  if (!delim) return false;
  const cols = lines[0].split(delim).length;
  return cols >= 2 && lines.every((l) => Math.abs(l.split(delim).length - cols) <= 1);
}

/**
 * Classify an extensionless/unknown file from a bounded content sample. Returns a
 * folder name, or null when the content gives no confident signal so the caller
 * keeps the current "Other" behavior for genuinely ambiguous files.
 */
export function categorizeByContent(sample = '') {
  const s = String(sample).trim();
  if (s.length < 8) return null;
  if (CODE_CUE.test(s)) return 'Code';
  if (LOG_CUE.test(s)) return 'Logs';
  if (looksTabular(s)) return 'Documents';
  const textual = (s.match(/[A-Za-z .,;:'"()\-]/g) || []).length;
  if (s.length >= 120 && textual / s.length > 0.75 && /[a-z][.!?]\s+[A-Z]/.test(s)) return 'Documents';
  return null;
}

/**
 * Name/extension-only classification: fast, no I/O. Returns null when a content peek
 * could improve the guess (i.e. the extension is unknown or absent entirely).
 */
export function categorizeByName(name) {
  const base = path.basename(String(name)).toLowerCase();
  const ext = path.extname(base);
  if (INSTALLER_EXTS.has(ext)) return 'Installers';
  if (IMAGE_EXTS.has(ext) && SCREENSHOT_RE.test(base)) return 'Screenshots';
  if (ARCHIVE_EXTS.has(ext) && INSTALLER_RE.test(base)) return 'Installers';
  if (BACKUP_EXTS.has(ext) || BACKUP_RE.test(base)) return 'Backups';
  if (FONT_EXTS.has(ext)) return 'Fonts';
  if (ext === '.log') return 'Logs';
  return CATEGORY_BY_EXT.get(ext) || null;
}

/** Full classification: name first, then a bounded content peek for unknown files. */
export function categorizeFile(name, sample = '') {
  return categorizeByName(name) ?? categorizeByContent(sample) ?? 'Other';
}

/**
 * Read at most maxBytes from the head of a file -- never the whole thing -- so a
 * multi-gigabyte extensionless file costs the same 512-byte read as a small note.
 */
async function readSample(filePath, maxBytes = 512) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * Read-only preview of how a folder's loose top-level files would sort into type
 * folders. Extensionless files get a bounded content peek so raw notes, code, and
 * logs land in meaningful folders; hidden files (macOS metadata) are ignored.
 */
export async function organizePreview(baseDir, { maxEntries = 20000, maxNames = 3, maxContentPeeks = 2000 } = {}) {
  const dirName = path.basename(baseDir);
  let entries = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return `${dirName}: not readable.`;
  }
  const byFolder = new Map();
  const push = (folder, name) => {
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(name);
  };
  const needsPeek = [];
  let files = 0;
  let truncated = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Skip hidden files (.DS_Store, .localized, .Rhistory, ...) -- macOS metadata, not
    // clutter to sort into folders.
    if (entry.name.startsWith('.')) continue;
    if (files >= maxEntries) {
      truncated = true;
      break;
    }
    files += 1;
    const byName = categorizeByName(entry.name);
    if (byName) push(byName, entry.name);
    else needsPeek.push(entry.name);
  }
  // Bounded content peek for the extensionless/unknown stragglers. Past the budget we
  // keep the fast behavior (dump into "Other") so a huge folder never stalls the preview.
  const peekNow = needsPeek.slice(0, maxContentPeeks);
  const sampled = await mapWithConcurrency(peekNow, STAT_CONCURRENCY, async (name) => ({
    name,
    sample: await readSample(path.join(baseDir, name)),
  }));
  for (const { name, sample } of sampled) {
    push(categorizeByContent(sample) || 'Other', name);
  }
  for (const name of needsPeek.slice(maxContentPeeks)) push('Other', name);
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

/**
 * Find the largest files under the given folders via a bounded walk and concurrent
 * stats, so "what's eating my disk" answers from real file sizes without a slow
 * sequential scan. Hidden files are skipped as noise. Returns a top-N plus the count
 * of files scanned.
 */
export async function largestFiles(dirs, { limit = 15, maxEntries = 20000, maxDirs = 2000 } = {}) {
  const paths = [];
  const queue = [...dirs];
  let visitedDirs = 0;
  while (queue.length && paths.length < maxEntries && visitedDirs < maxDirs) {
    const dir = queue.shift();
    visitedDirs += 1;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (paths.length >= maxEntries) break;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) paths.push(full);
    }
  }
  const stats = await mapWithConcurrency(paths, STAT_CONCURRENCY, async (file) => {
    try {
      const st = await fs.stat(file);
      return { file, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  });
  const files = stats.filter(Boolean).sort((a, b) => b.size - a.size).slice(0, limit);
  return { files, scanned: paths.length };
}

/**
 * Format a largest-files report for a set of directories. Shared by the
 * `large_files` instant action and the `large_files` agent tool so both render
 * identically.
 */
export async function largestFilesReport(dirs, { limit = 15, maxEntries = 20000, maxDirs = 2000 } = {}) {
  const { files, scanned } = await largestFiles(dirs, { limit, maxEntries, maxDirs });
  if (files.length === 0) return `No files found in ${dirs.map((d) => path.basename(d)).join(' or ')}.`;
  const age = (mtimeMs) => {
    const days = Math.floor((Date.now() - mtimeMs) / 86400000);
    if (days < 1) return 'today';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  };
  const lines = files.map((f, i) => `${i + 1}. ${formatBytes(f.size).padStart(9)}  ${age(f.mtimeMs).padStart(8)}  ${path.basename(f.file)}`);
  return bounded([
    `Largest files in ${dirs.map((d) => path.basename(d)).join(' and ')} (largest first, ${scanned} scanned):`,
    ...lines,
    '',
    'Review and delete or archive what you no longer need — nothing is removed automatically.',
  ].join('\n'));
}

/**
 * `large_files` agent tool: report the largest files across the requested folders
 * (defaulting to the common user folders) so the agent answers "what's eating my
 * disk" in one call. Read-only — nothing is deleted.
 */
export async function largeFilesTool({ folders, limit } = {}) {
  const home = os.homedir();
  const requested = [].concat(folders ?? []).filter((f) => typeof f === 'string' && f.trim());
  const resolveDir = (f) => (path.isAbsolute(f) ? f : path.join(home, f.replace(/^~\/?/, '')));
  const dirs = [];
  for (const f of requested) {
    const abs = resolveDir(f.trim());
    try {
      await fs.access(abs);
    } catch {
      continue;
    }
    if (!dirs.includes(abs)) dirs.push(abs);
  }
  if (dirs.length === 0) {
    for (const name of ['Downloads', 'Desktop', 'Documents']) {
      const dir = path.join(home, name);
      try {
        await fs.access(dir);
      } catch {
        continue;
      }
      dirs.push(dir);
    }
  }
  if (dirs.length === 0) return { ok: false, output: 'No matching folders found to scan.' };
  const capped = Math.max(1, Math.min(50, Number(limit) || 15));
  return { ok: true, output: await largestFilesReport(dirs, { limit: capped }) };
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
  large_files: {
    title: 'Largest files to clean',
    async run() {
      const home = os.homedir();
      const dirs = [];
      for (const name of ['Downloads', 'Desktop']) {
        const dir = path.join(home, name);
        try {
          await fs.access(dir);
        } catch {
          continue;
        }
        dirs.push(dir);
      }
      if (dirs.length === 0) return 'No Downloads or Desktop folder found.';
      return largestFilesReport(dirs, { limit: 15 });
    },
  },
  top_processes: {
    title: 'Memory & CPU hogs',
    async run() {
      let rows = [];
      try {
        const { stdout } = await execFileAsync('ps', ['-A', '-o', 'rss=,pcpu=,pid=,comm='], { maxBuffer: 8 * 1024 * 1024 });
        rows = stdout
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .filter((parts) => parts.length >= 4 && Number.isFinite(Number(parts[0])));
      } catch {
        return 'Could not read the process table.';
      }
      const shortName = (p) => p.slice(3).join(' ').split('/').pop();
      const fmt = (p) => `  ${String(Math.round(Number(p[0]) / 1024)).padStart(5)} MB  ${String(Number(p[1]).toFixed(1)).padStart(5)}% CPU  ${shortName(p)}`;
      const byMem = [...rows].sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 8);
      const byCpu = rows.filter((p) => Number(p[1]) > 0.5).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 5);
      return [
        'Top memory consumers (RAM is the local-model speed bottleneck — closing a big one speeds up every task):',
        ...byMem.map(fmt),
        '',
        'Top CPU consumers:',
        ...(byCpu.length ? byCpu.map(fmt) : ['  (nothing above 0.5% CPU right now)']),
      ].join('\n');
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