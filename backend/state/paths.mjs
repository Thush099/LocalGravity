import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve runtime state paths for LocalGravity, supporting test isolation via override or LOCALGRAVITY_HOME.
 */
export function getRuntimePaths(homeOverride) {
  const root = homeOverride || process.env.LOCALGRAVITY_HOME || path.join(os.homedir(), '.localgravity');
  const launchAgentsDir = homeOverride
    ? path.join(root, 'LaunchAgents')
    : path.join(os.homedir(), 'Library', 'LaunchAgents');

  return {
    root,
    configFile: path.join(root, 'config.json'),
    sessionsDir: path.join(root, 'sessions'),
    automationsFile: path.join(root, 'automations.json'),
    skillsDir: path.join(root, 'skills'),
    knowledgeDir: path.join(root, 'knowledge'),
    launchAgentsDir,
  };
}

/**
 * Resolve the built-in starter skills directory shipped with the backend.
 */
export function getStarterSkillsDir() {
  return path.resolve(__dirname, '..', 'skills');
}

/**
 * Resolve LocalGravity's source repository directory for self-reprogramming upgrades.
 */
export function getRepoPath() {
  if (process.env.LOCALGRAVITY_REPO) {
    return process.env.LOCALGRAVITY_REPO;
  }
  const directRepo = path.resolve(__dirname, '../..');
  if (fs.existsSync(path.join(directRepo, 'native', 'LocalGravityHost.swift'))) {
    return directRepo;
  }
  const repoTxt = path.resolve(__dirname, '../../repo-path.txt');
  try {
    const saved = fs.readFileSync(repoTxt, 'utf8').trim();
    if (saved && fs.existsSync(saved)) return saved;
  } catch {
    // ignore
  }
  return '';
}
