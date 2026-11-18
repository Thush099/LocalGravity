import os from 'node:os';
import path from 'node:path';
import { importExternalSkills, listExternalSkills } from './skills-engine.mjs';

const sourceListCache = new Map();
const SOURCE_LIST_TTL_MS = 8000;

export const SKILL_SOURCE_DEFS = [
  {
    id: 'agents',
    label: 'Agent Skills Store',
    description: 'Shared skills installed by the skills CLI and coding agents.',
    relativeDir: ['.agents', 'skills'],
  },
  {
    id: 'claude',
    label: 'Claude Skills',
    description: 'Skills available to Claude Code on this Mac.',
    relativeDir: ['.claude', 'skills'],
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    description: 'Skills installed under the Antigravity config directory.',
    relativeDir: ['.gemini', 'config', 'skills'],
  },
];

/**
 * Resolve the local skill library directories for a home directory.
 */
export function getSkillSources({ homeDir = os.homedir() } = {}) {
  return SKILL_SOURCE_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    description: def.description,
    dir: path.join(homeDir, ...def.relativeDir),
  }));
}

/**
 * Cache a library scan briefly so reopening the browser is instant on large libraries.
 */
async function listCachedExternalSkills(dir) {
  const cached = sourceListCache.get(dir);
  if (cached && Date.now() - cached.at < SOURCE_LIST_TTL_MS) return cached.skills;
  const skills = await listExternalSkills(dir);
  sourceListCache.set(dir, { at: Date.now(), skills });
  return skills;
}

/**
 * List every local skill library with its skills and whether each is already installed.
 */
export async function listSkillSources({ homeDir = os.homedir(), installedSlugs = [] } = {}) {
  const installed = new Set(installedSlugs);
  return Promise.all(
    getSkillSources({ homeDir }).map(async (source) => {
      const skills = await listCachedExternalSkills(source.dir);
      return {
        ...source,
        exists: skills.length > 0,
        skills: skills.map((skill) => ({ ...skill, installed: installed.has(skill.slug) })),
      };
    })
  );
}

/**
 * Import named skills from one local library into the app's skills directory.
 */
export async function importSkillsFromSource(sourceId, names, { homeDir = os.homedir(), paths } = {}) {
  const source = getSkillSources({ homeDir }).find((entry) => entry.id === sourceId);
  if (!source) {
    const err = new Error(`Unknown skill library "${sourceId}".`);
    err.statusCode = 400;
    throw err;
  }
  return importExternalSkills(source.dir, names, paths);
}
