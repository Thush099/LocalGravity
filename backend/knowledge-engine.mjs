import fs from 'node:fs/promises';
import path from 'node:path';
import { getRuntimePaths } from './state/paths.mjs';
import { formatFrontmatter, parseFrontmatter } from './skills-engine.mjs';

const KNOWLEDGE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

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
  }
}

export async function listKnowledge(paths = getRuntimePaths()) {
  await fs.mkdir(paths.knowledgeDir, { recursive: true });
  const entries = await fs.readdir(paths.knowledgeDir, { withFileTypes: true });
  const docs = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    const fullPath = path.join(paths.knowledgeDir, entry.name);
    try {
      const [raw, stat] = await Promise.all([fs.readFile(fullPath, 'utf8'), fs.stat(fullPath)]);
      const parsed = parseFrontmatter(raw);
      docs.push({
        name,
        title: parsed.title || name,
        tags: parsed.tags,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Ignore unreadable docs
    }
  }
  docs.sort((a, b) => {
    if (a.name === 'MEMORY') return -1;
    if (b.name === 'MEMORY') return 1;
    return a.name.localeCompare(b.name);
  });
  return docs;
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
  return { name: safeName, path: fullPath };
}

export async function deleteKnowledge(name, paths = getRuntimePaths()) {
  const safeName = sanitizeKnowledgeName(name);
  const fullPath = path.join(paths.knowledgeDir, `${safeName}.md`);
  try {
    await fs.unlink(fullPath);
    return true;
  } catch {
    return false;
  }
}

export async function searchKnowledge(query, paths = getRuntimePaths()) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return [];

  const docs = await listKnowledge(paths);
  const results = [];

  for (const doc of docs) {
    const full = await readKnowledge(doc.name, paths);
    if (!full) continue;
    const haystack = `${full.title}\n${full.tags.join(' ')}\n${full.content}`.toLowerCase();
    let score = 0;
    let firstMatchIdx = -1;
    for (const term of terms) {
      let idx = haystack.indexOf(term);
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
