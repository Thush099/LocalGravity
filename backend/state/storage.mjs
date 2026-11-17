import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRuntimePaths } from './paths.mjs';

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
const writeQueues = new Map();

export const DEFAULT_CONFIG = {
  provider: 'ollama',
  model: 'qwen3.5:4b',
  numCtx: 8192,
  thinking: false,
  safetyMode: 'ask',
  customBaseUrl: '',
  customModel: '',
  apiKeys: {},
  allowedReadCommands: [],
};

function sanitizeId(id, label = 'id') {
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid ${label}: must match ${SAFE_ID_RE}`);
  }
  return id;
}

/**
 * Atomically write JSON via a serialized per-file queue and temp-file rename.
 */
export function atomicWriteJson(filePath, data, mode = 0o644) {
  const prev = writeQueues.get(filePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(
      dir,
      `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`
    );
    const payload = JSON.stringify(data, null, 2) + '\n';
    await fs.writeFile(tmpPath, payload, { encoding: 'utf8', mode });
    await fs.chmod(tmpPath, mode);
    await fs.rename(tmpPath, filePath);
  });
  writeQueues.set(filePath, next);
  return next;
}

/**
 * Read and parse JSON from disk, returning fallback when missing or corrupted.
 */
export async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function loadConfig(paths = getRuntimePaths()) {
  const saved = await readJsonSafe(paths.configFile, {});
  const merged = {
    ...DEFAULT_CONFIG,
    ...(saved && typeof saved === 'object' ? saved : {}),
    apiKeys: {
      ...DEFAULT_CONFIG.apiKeys,
      ...(saved?.apiKeys && typeof saved.apiKeys === 'object' ? saved.apiKeys : {}),
    },
  };
  return merged;
}

export async function saveConfig(patch, paths = getRuntimePaths()) {
  const current = await loadConfig(paths);
  const next = {
    ...current,
    ...patch,
    apiKeys: {
      ...current.apiKeys,
      ...(patch?.apiKeys && typeof patch.apiKeys === 'object' ? patch.apiKeys : {}),
    },
  };
  await atomicWriteJson(paths.configFile, next, 0o600);
  return next;
}

export async function saveSession(session, paths = getRuntimePaths()) {
  const id = sanitizeId(session?.id, 'session id');
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  const normalized = {
    ...session,
    id,
    updatedAt: session.updatedAt || new Date().toISOString(),
    messages: Array.isArray(session.messages) ? session.messages : [],
  };
  await atomicWriteJson(path.join(paths.sessionsDir, `${id}.json`), normalized, 0o600);
  return normalized;
}

export async function loadSession(id, paths = getRuntimePaths()) {
  const safeId = sanitizeId(id, 'session id');
  return readJsonSafe(path.join(paths.sessionsDir, `${safeId}.json`), null);
}

export async function listSessions(paths = getRuntimePaths()) {
  try {
    const entries = await fs.readdir(paths.sessionsDir, { withFileTypes: true });
    const summaries = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const data = await readJsonSafe(path.join(paths.sessionsDir, entry.name), null);
      if (!data?.id) continue;
      summaries.push({
        id: data.id,
        title: data.title || 'Untitled Task',
        source: data.source || 'interactive',
        provider: data.provider || 'ollama',
        model: data.model || 'qwen3.5:9b',
        updatedAt: data.updatedAt || '',
        messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
      });
    }
    summaries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return summaries;
  } catch {
    return [];
  }
}

export async function deleteSession(id, paths = getRuntimePaths()) {
  const safeId = sanitizeId(id, 'session id');
  try {
    await fs.unlink(path.join(paths.sessionsDir, `${safeId}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function loadAutomations(paths = getRuntimePaths()) {
  const data = await readJsonSafe(paths.automationsFile, []);
  return Array.isArray(data) ? data : [];
}

export async function saveAutomations(list, paths = getRuntimePaths()) {
  if (!Array.isArray(list)) {
    throw new Error('Automations must be an array');
  }
  await atomicWriteJson(paths.automationsFile, list, 0o600);
  return list;
}
