import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRuntimePaths } from './paths.mjs';

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
const writeQueues = new Map();
const sessionSummariesCache = new Map();
const configCache = new Map();

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

function buildSearchableMessages(messages = []) {
  const out = [];
  for (const m of messages) {
    if (!m || m.role === 'system' || typeof m.content !== 'string' || !m.content) continue;
    out.push({
      role: m.role,
      content: m.content,
      lower: m.content.toLowerCase(),
    });
  }
  return out;
}

function toSessionCacheEntry(data) {
  return {
    summary: {
      id: data.id,
      title: data.title || 'Untitled Task',
      source: data.source || 'interactive',
      provider: data.provider || 'ollama',
      model: data.model || 'qwen3.5:9b',
      updatedAt: data.updatedAt || '',
      messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
    },
    titleLower: String(data.title || '').toLowerCase(),
    searchableMessages: buildSearchableMessages(data.messages),
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
  try {
    const st = await fs.stat(paths.configFile);
    const cached = configCache.get(paths.configFile);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      return structuredClone(cached.data);
    }
    const saved = await readJsonSafe(paths.configFile, {});
    const merged = {
      ...DEFAULT_CONFIG,
      ...(saved && typeof saved === 'object' ? saved : {}),
      apiKeys: {
        ...DEFAULT_CONFIG.apiKeys,
        ...(saved?.apiKeys && typeof saved.apiKeys === 'object' ? saved.apiKeys : {}),
      },
    };
    configCache.set(paths.configFile, { mtimeMs: st.mtimeMs, data: merged });
    return structuredClone(merged);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
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
  try {
    const st = await fs.stat(paths.configFile);
    configCache.set(paths.configFile, { mtimeMs: st.mtimeMs, data: next });
  } catch {
    configCache.delete(paths.configFile);
  }
  return structuredClone(next);
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
  if (!dirCache) {
    dirCache = new Map();
    sessionSummariesCache.set(paths.sessionsDir, dirCache);
  }
  dirCache.set(id, toSessionCacheEntry(normalized));
  return normalized;
}

export async function loadSession(id, paths = getRuntimePaths()) {
  const safeId = sanitizeId(id, 'session id');
  return readJsonSafe(path.join(paths.sessionsDir, `${safeId}.json`), null);
}

async function ensureSessionCachePopulated(paths = getRuntimePaths()) {
  const entries = await fs.readdir(paths.sessionsDir, { withFileTypes: true });
  const jsonFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));
  let dirCache = sessionSummariesCache.get(paths.sessionsDir);
  if (!dirCache) {
    dirCache = new Map();
    sessionSummariesCache.set(paths.sessionsDir, dirCache);
  }

  const activeIds = new Set();
  const missingEntries = [];

  for (const entry of jsonFiles) {
    const idFromFile = entry.name.slice(0, -5);
    activeIds.add(idFromFile);
    if (!dirCache.has(idFromFile)) {
      missingEntries.push(entry.name);
    }
  }

  if (missingEntries.length > 0) {
    const loaded = await Promise.all(
      missingEntries.map((fileName) => readJsonSafe(path.join(paths.sessionsDir, fileName), null))
    );
    for (const data of loaded) {
      if (!data?.id) continue;
      dirCache.set(data.id, toSessionCacheEntry(data));
    }
  }

  for (const cachedId of dirCache.keys()) {
    if (!activeIds.has(cachedId)) dirCache.delete(cachedId);
  }

  return dirCache;
}

export async function listSessions(paths = getRuntimePaths()) {
  try {
    const dirCache = await ensureSessionCachePopulated(paths);
    const summaries = [...dirCache.values()].map((entry) => entry.summary);
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
 * Full-text search across stored conversations using the in-memory index, returning a matching snippet per session.
 */
export async function searchSessions(query, paths = getRuntimePaths(), { limit = 30 } = {}) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2);
  if (terms.length === 0) return [];

  let dirCache;
  try {
    dirCache = await ensureSessionCachePopulated(paths);
  } catch {
    return [];
  }

  const results = [];

  for (const entry of dirCache.values()) {
    const titleScore = terms.reduce((n, term) => n + (entry.titleLower.includes(term) ? 1 : 0), 0);

    let bestMessage = null;
    let bestScore = 0;
    let bestIndex = 0;
    for (const message of entry.searchableMessages) {
      let score = 0;
      let firstIndex = -1;
      for (const term of terms) {
        const found = message.lower.indexOf(term);
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
      ...entry.summary,
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
