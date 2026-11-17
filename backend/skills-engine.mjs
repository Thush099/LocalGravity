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
    return { name: '', title: '', description: '', triggers: [], tags: [], body: text.trim() };
  }

  const [, rawHeader, body] = match;
  const meta = { name: '', title: '', description: '', triggers: [], tags: [] };

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
  const md = formatFrontmatter(
    {
      name: slug,
      description: input.description || '',
      triggers: Array.isArray(input.triggers) ? input.triggers : [],
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
