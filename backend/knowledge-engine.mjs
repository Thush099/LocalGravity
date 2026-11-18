import fs from 'node:fs/promises';
import path from 'node:path';
import { getRuntimePaths } from './state/paths.mjs';
import { formatFrontmatter, parseFrontmatter } from './skills-engine.mjs';

const KNOWLEDGE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const knowledgeDirCache = new Map();

/**
 * Drop the memoized knowledge index so external edits are reflected on the next read.
 */
export function invalidateKnowledgeCache(knowledgeDir) {
  knowledgeDirCache.delete(knowledgeDir);
}

export function sanitizeKnowledgeName(name) {
  if (typeof name !== 'string' || !KNOWLEDGE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid knowledge doc name "${name}": use letters, digits, hyphens, and underscores.`
    );
  }
  return name;
}

const DEFAULT_MEMORY_BODY = `# Persistent Memory & User Preferences

Record stable preferences, machine conventions, preferred editing styles, and personal facts here so the agent remembers them across every session.

- OS: macOS (Apple Silicon M4, 16 GB RAM)
- Default file deletion policy: Move files to Trash instead of permanently deleting unless asked.
`;

const DEFAULT_LEARNED_FIXES_BODY = `# Autonomous Self-Learned Mistake Prevention Rules

Automatically programmed from past tool errors, command recoveries, and output struggles so LocalGravity improves on every run:

- Always verify target file paths and exact snippet lines before running edit_file, or use whitespace-tolerant matching.
- Always include /opt/homebrew/bin and /usr/local/bin in PATH when invoking ffmpeg, magick, or ollama on Apple Silicon.
`;

export async function ensureKnowledgeSeeded(paths = getRuntimePaths()) {
  await fs.mkdir(paths.knowledgeDir, { recursive: true });
  const memoryPath = path.join(paths.knowledgeDir, 'MEMORY.md');
  try {
    await fs.access(memoryPath);
  } catch {
    const seeded = formatFrontmatter(
      {
        title: 'User Memory & Preferences',
        tags: ['memory', 'preferences'],
      },
      DEFAULT_MEMORY_BODY
    );
    await fs.writeFile(memoryPath, seeded, 'utf8');
    knowledgeDirCache.delete(paths.knowledgeDir);
  }

  const fixesPath = path.join(paths.knowledgeDir, 'LEARNED_FIXES.md');
  try {
    await fs.access(fixesPath);
  } catch {
    const seededFixes = formatFrontmatter(
      {
        title: 'Self-Learned Mistake Prevention & Recovery Rules',
        tags: ['self-improvement', 'mistakes', 'auto-learned'],
      },
      DEFAULT_LEARNED_FIXES_BODY
    );
    await fs.writeFile(fixesPath, seededFixes, 'utf8');
    knowledgeDirCache.delete(paths.knowledgeDir);
  }
}

export async function listKnowledge(paths = getRuntimePaths()) {
  await fs.mkdir(paths.knowledgeDir, { recursive: true });
  try {
    const dirStat = await fs.stat(paths.knowledgeDir);
    const cached = knowledgeDirCache.get(paths.knowledgeDir);
    if (cached && cached.mtimeMs === dirStat.mtimeMs) {
      return cached.docs;
    }

    const entries = await fs.readdir(paths.knowledgeDir, { withFileTypes: true });
    const mdEntries = entries.filter((e) => e.isFile() && e.name.endsWith('.md'));

    const loaded = await Promise.all(
      mdEntries.map(async (entry) => {
        const name = entry.name.slice(0, -3);
        const fullPath = path.join(paths.knowledgeDir, entry.name);
        try {
          const [raw, stat] = await Promise.all([fs.readFile(fullPath, 'utf8'), fs.stat(fullPath)]);
          const parsed = parseFrontmatter(raw);
          return {
            name,
            title: parsed.title || name,
            tags: parsed.tags,
            sizeBytes: stat.size,
            updatedAt: stat.mtime.toISOString(),
          };
        } catch {
          return null;
        }
      })
    );

    const docs = loaded.filter(Boolean);
    const rank = (name) => (name === 'LEARNED_FIXES' ? 0 : name === 'MEMORY' ? 1 : 2);
    docs.sort((a, b) => {
      const ra = rank(a.name);
      const rb = rank(b.name);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
    knowledgeDirCache.set(paths.knowledgeDir, { mtimeMs: dirStat.mtimeMs, docs });
    return docs;
  } catch {
    return [];
  }
}

export async function readKnowledge(name, paths = getRuntimePaths()) {
  const safeName = sanitizeKnowledgeName(name);
  const fullPath = path.join(paths.knowledgeDir, `${safeName}.md`);
  try {
    const raw = await fs.readFile(fullPath, 'utf8');
    const parsed = parseFrontmatter(raw);
    return {
      name: safeName,
      title: parsed.title || safeName,
      tags: parsed.tags,
      content: parsed.body,
      raw,
      path: fullPath,
    };
  } catch {
    return null;
  }
}

export async function saveKnowledge(input, paths = getRuntimePaths()) {
  const safeName = sanitizeKnowledgeName(input?.name);
  await fs.mkdir(paths.knowledgeDir, { recursive: true });
  const fullPath = path.join(paths.knowledgeDir, `${safeName}.md`);
  const md = formatFrontmatter(
    {
      title: input.title || safeName,
      tags: Array.isArray(input.tags) ? input.tags : [],
    },
    input.content || ''
  );
  await fs.writeFile(fullPath, md, 'utf8');
  knowledgeDirCache.delete(paths.knowledgeDir);
  return { name: safeName, path: fullPath };
}

export async function deleteKnowledge(name, paths = getRuntimePaths()) {
  const safeName = sanitizeKnowledgeName(name);
  const fullPath = path.join(paths.knowledgeDir, `${safeName}.md`);
  try {
    await fs.unlink(fullPath);
    knowledgeDirCache.delete(paths.knowledgeDir);
    return true;
  } catch {
    return false;
  }
}

export async function resetLearnedFixes(paths = getRuntimePaths()) {
  await fs.mkdir(paths.knowledgeDir, { recursive: true });
  const fixesPath = path.join(paths.knowledgeDir, 'LEARNED_FIXES.md');
  const seededFixes = formatFrontmatter(
    {
      title: 'Self-Learned Mistake Prevention & Recovery Rules',
      tags: ['self-improvement', 'mistakes', 'auto-learned'],
    },
    DEFAULT_LEARNED_FIXES_BODY
  );
  await fs.writeFile(fixesPath, seededFixes, 'utf8');
  knowledgeDirCache.delete(paths.knowledgeDir);
  return readKnowledge('LEARNED_FIXES', paths);
}

export async function searchKnowledge(query, paths = getRuntimePaths()) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return [];

  const docs = await listKnowledge(paths);
  const fullDocs = await Promise.all(docs.map((doc) => readKnowledge(doc.name, paths)));
  const results = [];

  for (const full of fullDocs) {
    if (!full) continue;
    const haystack = `${full.title}\n${full.tags.join(' ')}\n${full.content}`.toLowerCase();
    let score = 0;
    let firstMatchIdx = -1;
    for (const term of terms) {
      const idx = haystack.indexOf(term);
      if (idx !== -1) {
        score += full.title.toLowerCase().includes(term) ? 3 : 1;
        const bodyIdx = full.content.toLowerCase().indexOf(term);
        if (firstMatchIdx === -1 && bodyIdx !== -1) firstMatchIdx = bodyIdx;
      }
    }
    if (score > 0) {
      const start = Math.max(0, firstMatchIdx - 60);
      const snippet = full.content.slice(start, start + 260).replace(/\s+/g, ' ').trim();
      results.push({ name: full.name, title: full.title, tags: full.tags, score, snippet });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 8);
}
