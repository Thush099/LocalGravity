import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRuntimePaths } from './paths.mjs';

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
const writeQueues = new Map();
const sessionSummariesCache = new Map();

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

function toSessionSummary(data) {
  return {
    id: data.id,
    title: data.title || 'Untitled Task',
    source: data.source || 'interactive',
    provider: data.provider || 'ollama',
    model: data.model || 'qwen3.5:9b',
    updatedAt: data.updatedAt || '',
    messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
  };
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
  let dirCache = sessionSummariesCache.get(paths.sessionsDir);
  if (dirCache) {
    dirCache.set(id, toSessionSummary(normalized));
  }
  return normalized;
}

export async function loadSession(id, paths = getRuntimePaths()) {
  const safeId = sanitizeId(id, 'session id');
  return readJsonSafe(path.join(paths.sessionsDir, `${safeId}.json`), null);
}

export async function listSessions(paths = getRuntimePaths()) {
  try {
    const entries = await fs.readdir(paths.sessionsDir, { withFileTypes: true });
    const jsonFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));
    let dirCache = sessionSummariesCache.get(paths.sessionsDir);
    if (!dirCache) {
      dirCache = new Map();
      sessionSummariesCache.set(paths.sessionsDir, dirCache);
    }

    const activeIds = new Set();
    const summaries = [];
    for (const entry of jsonFiles) {
      const idFromFile = entry.name.slice(0, -5);
      activeIds.add(idFromFile);
      if (dirCache.has(idFromFile)) {
        summaries.push(dirCache.get(idFromFile));
        continue;
      }
      const data = await readJsonSafe(path.join(paths.sessionsDir, entry.name), null);
      if (!data?.id) continue;
      const sum = toSessionSummary(data);
      dirCache.set(data.id, sum);
      summaries.push(sum);
    }

    for (const cachedId of dirCache.keys()) {
      if (!activeIds.has(cachedId)) dirCache.delete(cachedId);
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
    sessionSummariesCache.get(paths.sessionsDir)?.delete(safeId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Full-text search across stored conversations, returning a matching snippet per session.
 */
export async function searchSessions(query, paths = getRuntimePaths(), { limit = 30 } = {}) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2);
  if (terms.length === 0) return [];

  const summaries = await listSessions(paths);
  const results = [];

  for (const summary of summaries) {
    const data = await readJsonSafe(path.join(paths.sessionsDir, `${summary.id}.json`), null);
    if (!data) continue;

    const title = String(data.title || '').toLowerCase();
    const titleScore = terms.reduce((n, term) => n + (title.includes(term) ? 1 : 0), 0);
    const messages = Array.isArray(data.messages) ? data.messages : [];

    let bestMessage = null;
    let bestScore = 0;
    let bestIndex = 0;
    for (const message of messages) {
      if (message.role === 'system' || typeof message.content !== 'string') continue;
      const text = message.content.toLowerCase();
      let score = 0;
      let firstIndex = -1;
      for (const term of terms) {
        const found = text.indexOf(term);
        if (found !== -1) {
          score += 1;
          if (firstIndex === -1) firstIndex = found;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMessage = message;
        bestIndex = Math.max(0, firstIndex);
      }
    }

    if (!bestMessage && titleScore === 0) continue;

    const snippetSource = bestMessage
      ? String(bestMessage.content).slice(Math.max(0, bestIndex - 60), Math.max(0, bestIndex - 60) + 220)
      : '';
    results.push({
      ...summary,
      score: titleScore * 2 + bestScore,
      matchRole: bestMessage?.role || 'title',
      snippet: snippetSource.replace(/\s+/g, ' ').trim(),
    });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  return results.slice(0, Math.max(1, limit)).map(({ score, ...rest }) => rest);
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
