import fs from 'node:fs/promises';
import path from 'node:path';
import { getRuntimePaths, getStarterSkillsDir } from './state/paths.mjs';

const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Validate a skill directory slug against traversal and invalid characters.
 */
export function sanitizeSkillSlug(name) {
  if (typeof name !== 'string' || !SKILL_SLUG_RE.test(name)) {
    throw new Error(`Invalid skill name "${name}": use lowercase letters, digits, and hyphens.`);
  }
  return name;
}

function stripQuotes(val) {
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTriggersValue(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return trimmed
        .slice(1, -1)
        .split(',')
        .map((item) => stripQuotes(item))
        .filter(Boolean);
    }
  }
  return trimmed
    .split(',')
    .map((item) => stripQuotes(item))
    .filter(Boolean);
}

/**
 * Parse YAML-style frontmatter from a Markdown document.
 */
export function parseFrontmatter(markdown) {
  const text = String(markdown || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { name: '', title: '', description: '', triggers: [], tags: [], source: '', body: text.trim() };
  }

  const [, rawHeader, body] = match;
  const meta = { name: '', title: '', description: '', triggers: [], tags: [], source: '' };

  for (const line of rawHeader.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    if (key === 'name') meta.name = stripQuotes(val);
    else if (key === 'title') meta.title = stripQuotes(val);
    else if (key === 'description') meta.description = stripQuotes(val);
    else if (key === 'triggers') meta.triggers = parseTriggersValue(val);
    else if (key === 'tags') meta.tags = parseTriggersValue(val);
    else if (key === 'source') meta.source = stripQuotes(val);
  }

  return { ...meta, body: body.trim() };
}

export function formatFrontmatter(meta, body) {
  const lines = ['---'];
  if (meta.name) lines.push(`name: ${meta.name}`);
  if (meta.title) lines.push(`title: ${JSON.stringify(meta.title)}`);
  if (meta.description !== undefined) lines.push(`description: ${JSON.stringify(meta.description || '')}`);
  if (Array.isArray(meta.triggers) && meta.triggers.length > 0) {
    lines.push(`triggers: ${JSON.stringify(meta.triggers)}`);
  }
  if (Array.isArray(meta.tags) && meta.tags.length > 0) {
    lines.push(`tags: ${JSON.stringify(meta.tags)}`);
  }
  if (meta.source) lines.push(`source: ${JSON.stringify(meta.source)}`);
  lines.push('---', '');
  return lines.join('\n') + String(body || '').trim() + '\n';
}

async function copyDirMissingOnly(srcDir, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirMissingOnly(srcPath, destPath);
    } else if (entry.isFile()) {
      try {
        await fs.access(destPath);
      } catch {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
}

async function listRelativeFiles(dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

/**
 * Copy missing starter skills into the user's skills directory once per starter slug so user deletions stay deleted.
 */
export async function syncStarterSkills(paths = getRuntimePaths()) {
  const starterDir = getStarterSkillsDir();
  await fs.mkdir(paths.skillsDir, { recursive: true });
  const synced = [];
  let entries = [];
  try {
    entries = await fs.readdir(starterDir, { withFileTypes: true });
  } catch {
    return synced;
  }

  const seededMarkerPath = path.join(paths.root, '.seeded-starters.json');
  let seededSet = new Set();
  try {
    const raw = await fs.readFile(seededMarkerPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) seededSet = new Set(parsed);
  } catch {
    seededSet = new Set();
  }

  let markerDirty = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = sanitizeSkillSlug(entry.name);
    if (seededSet.has(slug)) continue;
    const destSkillDir = path.join(paths.skillsDir, slug);
    const destMd = path.join(destSkillDir, 'SKILL.md');
    let exists = false;
    try {
      await fs.access(destMd);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      await copyDirMissingOnly(path.join(starterDir, slug), destSkillDir);
      synced.push(slug);
    }
    seededSet.add(slug);
    markerDirty = true;
  }

  if (markerDirty) {
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(seededMarkerPath, JSON.stringify([...seededSet], null, 2) + '\n', 'utf8');
  }
  return synced;
}

export async function listSkills(paths = getRuntimePaths()) {
  await fs.mkdir(paths.skillsDir, { recursive: true });
  const starterDir = getStarterSkillsDir();
  let starterNames = new Set();
  try {
    const starters = await fs.readdir(starterDir, { withFileTypes: true });
    starterNames = new Set(starters.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    starterNames = new Set();
  }

  const entries = await fs.readdir(paths.skillsDir, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(paths.skillsDir, entry.name, 'SKILL.md');
    try {
      const raw = await fs.readFile(skillMdPath, 'utf8');
      const parsed = parseFrontmatter(raw);
      skills.push({
        name: parsed.name || entry.name,
        slug: entry.name,
        description: parsed.description || 'No description provided.',
        triggers: parsed.triggers,
        source: parsed.source || '',
        sourcePath: skillMdPath,
        isStarter: starterNames.has(entry.name),
      });
    } catch {
      // Skip folders missing SKILL.md
    }
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug));
  return skills;
}

export async function readSkill(name, paths = getRuntimePaths()) {
  const slug = sanitizeSkillSlug(name);
  const skillDir = path.join(paths.skillsDir, slug);
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  try {
    const raw = await fs.readFile(skillMdPath, 'utf8');
    const parsed = parseFrontmatter(raw);
    const files = await listRelativeFiles(skillDir);
    return {
      meta: {
        name: parsed.name || slug,
        slug,
        description: parsed.description,
        triggers: parsed.triggers,
        source: parsed.source || '',
      },
      content: parsed.body,
      raw,
      files,
      sourcePath: skillMdPath,
    };
  } catch {
    return null;
  }
}

export async function saveSkill(input, paths = getRuntimePaths()) {
  const slug = sanitizeSkillSlug(input?.name);
  const skillDir = path.join(paths.skillsDir, slug);
  const resolvedSkillDir = path.resolve(skillDir);

  if (input?.extraFiles && typeof input.extraFiles === 'object') {
    for (const relPath of Object.keys(input.extraFiles)) {
      const candidate = path.resolve(resolvedSkillDir, relPath);
      if (!candidate.startsWith(resolvedSkillDir + path.sep)) {
        throw new Error(`Invalid extra file path "${relPath}": escapes skill directory.`);
      }
    }
  }

  await fs.mkdir(resolvedSkillDir, { recursive: true });
  let existingSource = '';
  try {
    const existingRaw = await fs.readFile(path.join(resolvedSkillDir, 'SKILL.md'), 'utf8');
    existingSource = parseFrontmatter(existingRaw).source || '';
  } catch {
    existingSource = '';
  }
  const md = formatFrontmatter(
    {
      name: slug,
      description: input.description || '',
      triggers: Array.isArray(input.triggers) ? input.triggers : [],
      source: input.source || existingSource,
    },
    input.content || ''
  );
  const skillMdPath = path.join(resolvedSkillDir, 'SKILL.md');
  await fs.writeFile(skillMdPath, md, 'utf8');

  if (input?.extraFiles && typeof input.extraFiles === 'object') {
    for (const [relPath, fileBody] of Object.entries(input.extraFiles)) {
      const target = path.resolve(resolvedSkillDir, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(fileBody), 'utf8');
    }
  }

  return { slug, path: skillMdPath };
}

export async function deleteSkill(name, paths = getRuntimePaths()) {
  const slug = sanitizeSkillSlug(name);
  const skillDir = path.join(paths.skillsDir, slug);
  try {
    await fs.access(skillDir);
    await fs.rm(skillDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function listExternalSkills(sourceDir) {
  try {
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const mdPath = path.join(sourceDir, entry.name, 'SKILL.md');
      try {
        const raw = await fs.readFile(mdPath, 'utf8');
        const parsed = parseFrontmatter(raw);
        found.push({
          slug: entry.name,
          name: parsed.name || entry.name,
          description: parsed.description || '',
        });
      } catch {
        // Ignore directories without SKILL.md
      }
    }
    found.sort((a, b) => a.slug.localeCompare(b.slug));
    return found;
  } catch {
    return [];
  }
}

export async function importExternalSkills(sourceDir, names, paths = getRuntimePaths()) {
  await fs.mkdir(paths.skillsDir, { recursive: true });
  const available = await listExternalSkills(sourceDir);
  const targetNames = Array.isArray(names) && names.length > 0 ? names : available.map((s) => s.slug);
  const imported = [];

  for (const rawName of targetNames) {
    const slug = sanitizeSkillSlug(rawName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, ''));
    const match = available.find((s) => s.slug === rawName || s.name === rawName);
    if (!match) continue;
    const srcSkillDir = path.join(sourceDir, match.slug);
    const destSkillDir = path.join(paths.skillsDir, slug);
    await fs.rm(destSkillDir, { recursive: true, force: true });
    await copyDirMissingOnly(srcSkillDir, destSkillDir);
    imported.push(slug);
  }
  return imported;
}

const PRIVATE_HOST_RE = /^(?:localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;

/**
 * Accept a raw SKILL.md URL or a github.com blob link and return a raw fetchable URL.
 */
export function normalizeSkillUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) throw new Error('A skill URL is required.');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Invalid URL: ${text}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// skill URLs are supported.');
  }
  if (PRIVATE_HOST_RE.test(parsed.hostname) || parsed.hostname.endsWith('.local')) {
    throw new Error('Refusing to fetch skills from local or private network hosts.');
  }

  const githubMatch = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/);
  if (parsed.hostname === 'github.com' && githubMatch) {
    const [, owner, repo, ref, filePath] = githubMatch;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
  }
  if (parsed.hostname === 'github.com') {
    throw new Error('Use a direct file link (github.com/<owner>/<repo>/blob/<ref>/.../SKILL.md) or a raw URL.');
  }
  return parsed.toString();
}

/**
 * Convert an arbitrary skill name into a safe directory slug.
 */
export function slugifySkillName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/**
 * Download a SKILL.md from GitHub or any public raw URL and install it as a LocalGravity skill.
 */
export async function importSkillFromUrl(rawUrl, { fetchFn = globalThis.fetch, paths = getRuntimePaths() } = {}) {
  const url = normalizeSkillUrl(rawUrl);
  const response = await fetchFn(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  const raw = (await response.text()).replace(/^\uFEFF/, '');
  if (raw.length > 512 * 1024) {
    throw new Error('Skill file is larger than the 512 KB import limit.');
  }

  const parsed = parseFrontmatter(raw);
  const fallbackName = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '').replace(
    /\.md$/i,
    ''
  );
  const slug = slugifySkillName(parsed.name || fallbackName);
  if (!SKILL_SLUG_RE.test(slug)) {
    throw new Error(`Could not derive a valid skill slug from ${url}`);
  }
  if (!parsed.body.trim()) {
    throw new Error(`No skill instructions found at ${url}`);
  }

  const firstProseLine = parsed.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
  const description = parsed.description || firstProseLine || 'Imported skill';

  const saved = await saveSkill(
    {
      name: slug,
      description,
      triggers: parsed.triggers,
      content: parsed.body,
      source: url,
    },
    paths
  );

  return { slug: saved.slug, description, triggers: parsed.triggers, sourceUrl: url };
}

/**
 * Re-download an imported skill from the source URL stored in its frontmatter.
 */
export async function refreshSkillFromUrl(name, { fetchFn = globalThis.fetch, paths = getRuntimePaths() } = {}) {
  const slug = sanitizeSkillSlug(name);
  const existing = await readSkill(slug, paths);
  if (!existing) throw new Error(`Skill "${slug}" not found.`);
  if (!existing.meta.source) {
    throw new Error(`Skill "${slug}" has no stored source URL to refresh from.`);
  }
  return importSkillFromUrl(existing.meta.source, { fetchFn, paths });
}
