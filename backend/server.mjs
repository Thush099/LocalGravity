import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { INSTANT_ACTION_IDS, runInstantAction } from './actions.mjs';
import { setAppForeground } from './tools/macos-tool.mjs';
import { compactConversation } from './agent/compactor.mjs';
import { tryFastAnswer } from './tools/fast-answer.mjs';
import { runAgentTurn } from './agent/loop.mjs';
import { removeAllLaunchAgents, setAutomationSchedule } from './automations.mjs';
import { emailSummary, fetchWorldNews, weatherSummary } from './daily-briefing.mjs';
import { networkUsageSummary, perAppUsage, recordNetworkSample, totalInterfaceBytes } from './network-monitor.mjs';
import { buildSuggestions, dismissSuggestion, loadDismissed, storageFreePercentFromMetrics } from './smart-assist.mjs';
import {
  deleteKnowledge,
  ensureKnowledgeSeeded,
  listKnowledge,
  readKnowledge,
  resetLearnedFixes,
  saveKnowledge,
  searchKnowledge,
} from './knowledge-engine.mjs';
import {
  deleteScheduleEntry,
  entriesForDate,
  loadSchedule,
  upsertScheduleEntry,
} from './schedule.mjs';
import {
  checkOllamaHealth,
  deleteOllamaModel,
  ensureOllamaRunning,
  pullOllamaModel,
  selectBestInstalledOllamaModel,
  unloadOllamaModels,
  warmOllamaModel,
} from './providers/ollama.mjs';
import { createDaemonSupervisor, shouldReclaimModelMemory } from './daemon-supervisor.mjs';
import { CLOUD_PRESETS } from './providers/openai-compat.mjs';
import { importSkillsFromSource, listSkillSources } from './skill-sources.mjs';
import {
  deleteSkill,
  importSkillFromUrl,
  refreshSkillFromUrl,
  listSkills,
  readSkill,
  saveSkill,
  syncStarterSkills,
} from './skills-engine.mjs';
import { getRuntimePaths } from './state/paths.mjs';
import {
  SAFE_ID_RE,
  atomicWriteJson,
  deleteSession,
  listSessions,
  searchSessions,
  loadAutomations,
  loadConfig,
  loadSession,
  readJsonSafe,
  saveAutomations,
  saveConfig,
  saveSession,
} from './state/storage.mjs';
import { inspectMediaTool } from './tools/media-tool.mjs';
import {
  pasteFromClipboardTool,
  setReminderTool,
  showNotificationTool,
  takeScreenshotTool,
} from './tools/macos-tool.mjs';
import { startAgendaNotifier } from './agenda-notifier.mjs';
import { startAmbientAlerter } from './ambient-alerts.mjs';
import { assertPublicHttpUrl, safePublicFetch } from './net-guard.mjs';
import { expandUserPath } from './tools/safety.mjs';
import { collectSystemMetrics } from './system-monitor.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '../ui');

// Ensure Homebrew binaries are always reachable even if launched directly without Swift wrapper
if (!String(process.env.PATH || '').includes('/opt/homebrew/bin')) {
  process.env.PATH = `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

// Model output is rendered as sanitized Markdown, but a strict script policy keeps any
// injected HTML from becoming executable inside the token-authenticated app origin.
const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const ARTIFACT_SANDBOX_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "frame-ancestors 'self'",
].join('; ');

const ALLOWED_SESSION_MODES = new Set(['auto', 'engineer', 'researcher', 'writer', 'macops']);

function formatSmartTitle(raw) {
  const cleaned = String(raw || '')
    .replace(/^\/[a-z0-9_-]+\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'New Task';
  const capped = cleaned.length > 52 ? `${cleaned.slice(0, 49).trimEnd()}...` : cleaned;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

function stripMarkdownForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' (code snippet omitted) ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_>#~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

function buildSandboxArtifactHtml({ code = '', lang = 'html', title = 'Artifact Preview' } = {}) {
  const raw = String(code || '');
  const lowerLang = String(lang || 'html').toLowerCase().trim();
  const safeTitle = String(title || 'Artifact Preview').replace(/[<>&"]/g, '');

  if (lowerLang === 'svg') {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeTitle}</title>
<style>
  html, body { margin: 0; padding: 16px; min-height: 100%; box-sizing: border-box; display: grid; place-items: center; background: #0b0d11; color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  svg { max-width: 100%; height: auto; display: block; }
  @media (prefers-color-scheme: light) { html, body { background: #ffffff; color: #0f172a; } }
</style>
</head>
<body>${raw}</body>
</html>`;
  }

  if (/<html[\s>]|<!doctype/i.test(raw)) {
    return raw;
  }
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeTitle}</title>
<style>
  body { margin: 20px; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; line-height: 1.5; background: #0b0d11; color: #f1f5f9; }
  @media (prefers-color-scheme: light) { body { background: #ffffff; color: #0f172a; } }
</style>
</head>
<body>${raw}</body>
</html>`;
}

let cachedToolStatus = null;
let cachedToolStatusAt = 0;
const uiAssetCache = new Map();

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] || ''));
}

function writeJsonResponse(res, status, data, req = null) {
  const payload = Buffer.from(JSON.stringify(data), 'utf8');
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (payload.length >= 1024 && acceptsGzip(req)) {
    const gz = zlib.gzipSync(payload, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    headers['Content-Length'] = gz.length;
    res.writeHead(status, headers);
    res.end(gz);
    return;
  }
  res.writeHead(status, headers);
  res.end(payload);
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = req.headers.host;
  if (!host) return true;
  return parsed.host === host;
}

function htmlToText(raw) {
  return String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readJsonBody(req, limitBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new Error(`Request payload exceeds ${Math.round(limitBytes / 1024)} KB limit`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Request body is not valid JSON');
    err.statusCode = 400;
    throw err;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // Ignore malformed percent-encoding
    }
  }
  return out;
}

function safeTokenMatch(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function whichCmd(cmd) {
  try {
    const { stdout } = await execFileAsync('which', [cmd]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getSystemStats() {
  const totalRamGb = Number((os.totalmem() / 1024 ** 3).toFixed(1));
  let freeDiskGb = null;
  let totalDiskGb = null;
  try {
    const st = await fs.statfs(os.homedir());
    freeDiskGb = Number(((st.bavail * st.bsize) / 1024 ** 3).toFixed(1));
    totalDiskGb = Number(((st.blocks * st.bsize) / 1024 ** 3).toFixed(1));
  } catch {
    // ignore
  }
  const now = Date.now();
  if (!cachedToolStatus || now - cachedToolStatusAt > 60000) {
    const [ffmpegPath, magickPath, ollamaPath] = await Promise.all([
      whichCmd('ffmpeg'),
      whichCmd('magick'),
      whichCmd('ollama'),
    ]);
    cachedToolStatus = {
      ffmpeg: Boolean(ffmpegPath),
      magick: Boolean(magickPath),
      ollama: Boolean(ollamaPath),
    };
    cachedToolStatusAt = now;
  }
  return {
    arch: os.arch(),
    totalRamGb,
    freeDiskGb,
    totalDiskGb,
    tools: cachedToolStatus,
  };
}

function maskConfigForClient(cfg) {
  const { apiKeys = {}, ...rest } = cfg;
  const configuredKeys = {};
  for (const key of Object.keys(CLOUD_PRESETS)) {
    configuredKeys[key] = Boolean(apiKeys[key] && String(apiKeys[key]).trim());
  }
  return { config: rest, configuredKeys };
}

/** Speak text aloud with macOS `say`. Injectable so tests never make noise. */
function defaultSpeakFn(text) {
  return spawn('/usr/bin/say', [text], { stdio: 'ignore' });
}

export function createAgentServer({
  authToken,
  paths = getRuntimePaths(),
  fetchFn = globalThis.fetch,
  skillHomeDir = os.homedir(),
  agendaNotifications = false,
  ensureOllamaFn = ensureOllamaRunning,
  warmModelFn = warmOllamaModel,
  unloadModelsFn = unloadOllamaModels,
  runAgentTurnFn = runAgentTurn,
  speakFn = defaultSpeakFn,
  gatherBriefingFn = null,
} = {}) {
  const token = authToken || process.env.AUTH_TOKEN || crypto.randomBytes(32).toString('hex');
  const activeRuns = new Map();
  const modelWarmups = new Map();
  const modelWarmupControllers = new Map();
  const modelWarmupStatuses = new Map();
  let cachedMetrics = null;
  let cachedMetricsAt = 0;
  let inFlightMetrics = null;
  const briefingCacheFile = path.join(paths.root, 'briefing-cache.json');
  let inFlightBriefing = null;
  let cachedBriefing = null;
  let cachedBriefingAt = 0;
  let lastSpeedMbps = null;
  const metricsHistory = [];
  let lastMemoryReclaimAt = 0;
  const previewArtifacts = new Map();
  let activeSpeakProc = null;
  const stopSpeaking = () => {
    if (!activeSpeakProc) return;
    try {
      activeSpeakProc.kill('SIGTERM');
    } catch {
      // already dead
    }
    activeSpeakProc = null;
  };
  let agendaStop = null;
  let ambientStop = null;
  let networkWarmTimer = null;
  let networkSampleTimer = null;
  const resolveRunApprovals = (runState, reason) => {
    if (!runState?.approvals) return;
    for (const resolver of runState.approvals.values()) {
      resolver({ approved: false, reason });
    }
    runState.approvals.clear();
  };

  const ensureBriefingDiskCacheLoaded = async () => {
    if (cachedBriefing) return;
    const saved = await readJsonSafe(briefingCacheFile, null);
    if (saved && saved.briefing && typeof saved.briefing === 'object') {
      cachedBriefing = saved.briefing;
      cachedBriefingAt = Number(saved.savedAt) || 0;
    }
  };

  const defaultGatherBriefing = async () => {
    const appsPromise = perAppUsage({ limit: 12 });
    const fastAppsPromise = Promise.race([
      appsPromise,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, apps: [], timedOut: true }), 1800)),
    ]);
    const [news, email, weather, appsResult, sinceBoot, usage] = await Promise.all([
      fetchWorldNews({ count: 5 }),
      emailSummary({ limit: 15 }),
      weatherSummary().catch(() => ({ ok: false, error: 'Weather unavailable.' })),
      fastAppsPromise,
      totalInterfaceBytes().catch(() => 0),
      networkUsageSummary().catch(() => ({})),
    ]);
    const initialApps =
      appsResult.ok && appsResult.apps?.length
        ? appsResult.apps
        : (usage.apps || []).slice(0, 12);
    const result = {
      news: (news.items || []).map((i) => ({ title: i.title, source: i.source, link: i.link })),
      email: {
        ok: email.ok,
        count: email.count,
        summary: email.summary || '',
        messages: (email.messages || []).slice(0, 8),
        error: email.error || null,
      },
      weather: weather.ok
        ? { ok: true, city: weather.city, icon: weather.icon, temp: weather.temp, feelsLike: weather.feelsLike, description: weather.description, high: weather.high, low: weather.low, wind: weather.wind }
        : { ok: false, error: weather.error || 'Weather unavailable.' },
      network: {
        topApps: initialApps.map((a) => ({ name: a.name, total: a.total })),
        // Month-to-date per-app totals, accumulated from counter deltas while the app
        // runs. Unlike topApps (cumulative since each process started) these are safe
        // to label "this month".
        monthApps: (usage.apps || []).slice(0, 12).map((a) => ({ name: a.name, total: a.total })),
        sinceBootBytes: sinceBoot,
        monthBytes: usage.monthTotal || 0,
        todayBytes: usage.dayTotal || 0,
        month: usage.month,
        history: usage.history || {},
        lastSpeedMbps,
      },
      updatedAt: new Date().toISOString(),
    };
    if (appsResult.timedOut) {
      appsPromise
        .then((lateRes) => {
          if (lateRes?.ok && Array.isArray(lateRes.apps) && lateRes.apps.length && cachedBriefing === result) {
            result.network.topApps = lateRes.apps.map((a) => ({ name: a.name, total: a.total }));
          }
        })
        .catch(() => {});
    }
    return result;
  };

  const refreshBriefingNow = () => {
    if (inFlightBriefing) return inFlightBriefing;
    inFlightBriefing = Promise.resolve()
      .then(() => (gatherBriefingFn ? gatherBriefingFn() : defaultGatherBriefing()))
      .then(async (briefing) => {
        cachedBriefing = briefing;
        cachedBriefingAt = Date.now();
        await atomicWriteJson(briefingCacheFile, { savedAt: cachedBriefingAt, briefing }).catch(() => {});
        return briefing;
      })
      .finally(() => {
        inFlightBriefing = null;
      });
    return inFlightBriefing;
  };

  const computeSuggestions = async () => {
    await ensureBriefingDiskCacheLoaded();
    // The memory-pressure rule needs memory/swap figures, which otherwise only arrive via
    // /api/system/metrics. Collect once if that cache is still empty so a fresh launch
    // surfaces RAM pressure instead of silently skipping the suggestion.
    if (!cachedMetrics) {
      await collectSystemMetrics()
        .then((m) => {
          if (m) {
            cachedMetrics = m;
            cachedMetricsAt = Date.now();
          }
        })
        .catch(() => {});
    }
    // Do not read ~/Downloads just to count files for a suggestion: on macOS that
    // raises the folder-permission dialog at launch, before the user asked for
    // anything. The agent reads the folder only when a turn actually needs it.
    const storageFreePercent = storageFreePercentFromMetrics(cachedMetrics);
    const [diskStat, scheduleEntries, dismissed] = await Promise.all([
      storageFreePercent !== null
        ? Promise.resolve(null)
        : fs.statfs(os.homedir()).catch(() => null),
      loadSchedule(paths).catch(() => []),
      loadDismissed(paths).catch(() => ({})),
    ]);

    const resolvedStorageFreePercent =
      storageFreePercent ??
      (diskStat && diskStat.blocks > 0 ? (diskStat.bavail / diskStat.blocks) * 100 : null);

    const snap = {
      hourOfDay: new Date().getHours(),
      storageFreePercent: resolvedStorageFreePercent,
      // Left null on purpose: see the note above the statfs call.
      downloadsCount: null,
      emailCount: cachedBriefing?.email?.ok ? Number(cachedBriefing.email.count ?? 0) : null,
      scheduledToday: entriesForDate(scheduleEntries).length,
      monthNetworkGB:
        cachedBriefing?.network?.monthBytes != null
          ? Number(cachedBriefing.network.monthBytes) / 1024 ** 3
          : null,
      topApp: (cachedBriefing?.network?.monthApps || []).find((a) => Number(a?.total) > 0) || null,
      memoryUsedPercent: cachedMetrics?.memory?.usedPercent ?? null,
      swapUsedGB:
        cachedMetrics?.memory?.swap?.usedBytes != null
          ? Number(cachedMetrics.memory.swap.usedBytes) / 1024 ** 3
          : null,
    };
    return buildSuggestions(snap, dismissed, { limit: 4 });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const sendJson = (targetRes, status, data) => writeJsonResponse(targetRes, status, data, req);

    try {
      // Static UI assets + bootstrap cookie + sandboxed artifact iframe
      if (!pathname.startsWith('/api/')) {
        if (pathname.startsWith('/preview-sandbox/')) {
          const artifactId = decodeURIComponent(pathname.slice('/preview-sandbox/'.length));
          const html = previewArtifacts.get(artifactId);
          if (!html) {
            res.writeHead(404).end('Artifact preview expired or not found');
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': ARTIFACT_SANDBOX_CSP,
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'no-store',
          });
          res.end(html);
          return;
        }

        const queryToken = url.searchParams.get('token');
        const hasValidBootstrapToken = Boolean(pathname === '/' && queryToken && safeTokenMatch(queryToken, token));
        if (hasValidBootstrapToken) {
          res.setHeader('Set-Cookie', `lg_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`);
        }
        const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const resolved = path.resolve(UI_DIR, relPath);
        if (!resolved.startsWith(UI_DIR + path.sep) && resolved !== path.join(UI_DIR, 'index.html')) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        try {
          const st = await fs.stat(resolved);
          let entry = uiAssetCache.get(resolved);
          if (!entry || entry.mtimeMs !== st.mtimeMs) {
            const data = await fs.readFile(resolved);
            const etag = `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
            const gzipData = data.length >= 1024 ? zlib.gzipSync(data, { level: 6 }) : null;
            entry = { mtimeMs: st.mtimeMs, etag, data, gzipData };
            uiAssetCache.set(resolved, entry);
          }

          if (!hasValidBootstrapToken && req.headers['if-none-match'] === entry.etag) {
            res.writeHead(304, {
              ...SECURITY_HEADERS,
              ETag: entry.etag,
              'Cache-Control': 'no-cache',
            });
            res.end();
            return;
          }

          const ext = path.extname(resolved).toLowerCase();
          const headers = {
            ...SECURITY_HEADERS,
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            ETag: entry.etag,
            'Cache-Control': 'no-cache',
          };
          if (ext === '.html') headers['Content-Security-Policy'] = UI_CONTENT_SECURITY_POLICY;
          const useGzip = Boolean(entry.gzipData && acceptsGzip(req));
          const bodyBuf = useGzip ? entry.gzipData : entry.data;
          if (useGzip) {
            headers['Content-Encoding'] = 'gzip';
            headers['Vary'] = 'Accept-Encoding';
          }
          headers['Content-Length'] = bodyBuf.length;
          res.writeHead(200, headers);
          res.end(bodyBuf);
        } catch {
          res.writeHead(404).end('Not found');
        }
        return;
      }

      // Authenticate all /api/* routes
      const headerToken = req.headers['x-auth-token'];
      const cookieToken = parseCookies(req).lg_auth;
      const queryToken = url.searchParams.get('token');
      const provided = headerToken || cookieToken || queryToken;
      if (!safeTokenMatch(provided, token)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }

      // Mutations must come from the app's own origin, never a foreign page riding the cookie
      if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOriginRequest(req)) {
        sendJson(res, 403, { ok: false, error: 'Cross-origin request blocked' });
        return;
      }

      // Health & System
      if (req.method === 'GET' && pathname === '/api/health') {
        const [system, ollama, loadedCfg] = await Promise.all([
          getSystemStats(),
          checkOllamaHealth(),
          loadConfig(paths),
        ]);
        let cfg = loadedCfg;
        // Auto-sync configured local model if default tag isn't installed but another local model is
        if (
          (cfg.provider || 'ollama') === 'ollama' &&
          ollama.running &&
          Array.isArray(ollama.models) &&
          ollama.models.length > 0 &&
          !ollama.models.some((m) => m.name === cfg.model)
        ) {
          const best = selectBestInstalledOllamaModel(ollama.models, cfg.model);
          if (best && best !== cfg.model) {
            cfg = await saveConfig({ model: best }, paths);
          }
        }
        sendJson(res, 200, {
          ok: true,
          system,
          ollama,
          presets: CLOUD_PRESETS,
          ...maskConfigForClient(cfg),
        });
        return;
      }

      // System metrics (read-only snapshot + bounded 60-point telemetry ring buffer)
      if (req.method === 'GET' && pathname === '/api/system/metrics') {
        const now = Date.now();
        if (!cachedMetrics || now - cachedMetricsAt > 2000) {
          if (!inFlightMetrics) {
            inFlightMetrics = collectSystemMetrics()
              .then((m) => {
                cachedMetrics = m;
                cachedMetricsAt = Date.now();
                metricsHistory.push({
                  t: m.timestamp,
                  cpu: m.cpu?.percent ?? null,
                  mem: m.memory?.usedPercent ?? null,
                  gpu: m.gpu?.utilizationPercent ?? null,
                  disk: m.disks?.[0]?.usedPercent ?? null,
                  swapPct: m.memory?.swap?.usedPercent ?? 0,
                });
                if (metricsHistory.length > 60) metricsHistory.shift();
                return m;
              })
              .finally(() => {
                inFlightMetrics = null;
              });
          }
          await inFlightMetrics;
        }
        // Conservative idle memory-reclaim (rate-limited): under real pressure,
        // unload models that are only sitting in RAM so the system stops swapping.
        // They reload lazily on the next local task; never fires mid-run.
        if (
          cachedMetrics &&
          shouldReclaimModelMemory({
            hasActiveRun: activeRuns.size > 0,
            swapUsedBytes: cachedMetrics.memory?.swap?.usedBytes ?? 0,
            ramUsedPercent: cachedMetrics.memory?.usedPercent ?? 0,
          }) &&
          Date.now() - lastMemoryReclaimAt > 120000
        ) {
          lastMemoryReclaimAt = Date.now();
          unloadModelsFn().catch(() => {});
        }
        sendJson(res, 200, { ok: true, metrics: cachedMetrics, history: metricsHistory });
        return;
      }

      // Jarvis-style daily briefing: stale-while-revalidate + disk cache + coalesced refresh.
      if (req.method === 'GET' && pathname === '/api/briefing') {
        const forceRefresh = url.searchParams.get('refresh') === '1';
        await ensureBriefingDiskCacheLoaded();
        const isFresh = Boolean(cachedBriefing) && Date.now() - cachedBriefingAt <= 300000;
        if (!forceRefresh && cachedBriefing) {
          if (!isFresh) {
            refreshBriefingNow().catch(() => {});
          }
          sendJson(res, 200, { ok: true, briefing: cachedBriefing, stale: !isFresh });
          return;
        }
        const briefing = await refreshBriefingNow();
        sendJson(res, 200, { ok: true, briefing, stale: false });
        return;
      }

      // Smart Assist proactive dashboard suggestions + dismissal persistence
      if (req.method === 'GET' && pathname === '/api/suggestions') {
        const suggestions = await computeSuggestions();
        sendJson(res, 200, { ok: true, suggestions });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/suggestions/dismiss') {
        const body = await readJsonBody(req);
        if (typeof body.id !== 'string' || !SAFE_ID_RE.test(body.id)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid suggestion id' });
        }
        await dismissSuggestion(paths, body.id);
        const suggestions = await computeSuggestions();
        return sendJson(res, 200, { ok: true, suggestions });
      }

      // Live internet speed on demand — a short timed throughput test. POST because it
      // triggers real work (a few seconds of downloads), not a cached read.
      if (req.method === 'POST' && pathname === '/api/network/speed') {
        const { speedTest } = await import('./network-monitor.mjs');
        const result = await speedTest({ seconds: 4 });
        if (result.ok) lastSpeedMbps = result.mbps;
        sendJson(
          res,
          result.ok ? 200 : 502,
          result.ok ? { ok: true, mbps: result.mbps } : { ok: false, error: result.error || 'Speed test failed' }
        );
        return;
      }

      // Report whether the app window is focused, so notifications can be suppressed
      // while the user is actively looking at LocalGravity (a banner then is redundant).
      if (req.method === 'POST' && pathname === '/api/app-focus') {
        const body = await readJsonBody(req).catch(() => ({}));
        setAppForeground(!!body?.focused);
        sendJson(res, 200, { ok: true });
        return;
      }

      // Composer quick-capture utilities (clipboard text & native screenshot)
      if (req.method === 'GET' && pathname === '/api/chat/clipboard') {
        const result = await pasteFromClipboardTool();
        return sendJson(res, 200, {
          ok: result.ok,
          text: result.clipboard || '',
          output: result.output,
        });
      }

      if (req.method === 'POST' && pathname === '/api/chat/screenshot') {
        const result = await takeScreenshotTool({ max_edge: 1280 });
        return sendJson(res, result.ok ? 200 : 400, {
          ok: result.ok,
          path: result.path || null,
          name: result.path ? path.basename(result.path) : null,
          previewUrl: result.images?.[0] ? `data:image/png;base64,${result.images[0]}` : null,
          output: result.output,
        });
      }

      if (req.method === 'POST' && pathname === '/api/chat/attachment') {
        const body = await readJsonBody(req, 22 * 1024 * 1024);
        const rawB64 = String(body.dataBase64 || '').replace(/^data:[^;]+;base64,/i, '').trim();
        if (!rawB64) {
          return sendJson(res, 400, { ok: false, error: 'Attachment payload is empty.' });
        }
        const buf = Buffer.from(rawB64, 'base64');
        if (buf.length === 0) {
          return sendJson(res, 400, { ok: false, error: 'Attachment could not be decoded.' });
        }
        if (buf.length > 15 * 1024 * 1024) {
          return sendJson(res, 413, { ok: false, error: 'Attachment exceeds 15 MB limit.' });
        }
        const rawBase = path.basename(String(body.filename || 'attachment.png')).trim() || 'attachment.png';
        const rawExt = path.extname(rawBase);
        const safeExt = /^\.[a-zA-Z0-9]{1,8}$/.test(rawExt) ? rawExt.toLowerCase() : '.bin';
        const rawStem = rawBase.slice(0, rawExt ? -rawExt.length : undefined);
        const safeStem =
          rawStem.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'attachment';
        const displayName = `${safeStem}${safeExt}`;
        const attachmentsDir = path.join(paths.root, 'attachments');
        await fs.mkdir(attachmentsDir, { recursive: true });
        const uniqueName = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${displayName}`;
        const destPath = path.join(attachmentsDir, uniqueName);
        await fs.writeFile(destPath, buf, { mode: 0o600 });
        return sendJson(res, 200, { ok: true, path: destPath, name: displayName, sizeBytes: buf.length });
      }

      if (req.method === 'POST' && pathname === '/api/chat/speak') {
        const body = await readJsonBody(req);
        const speech = stripMarkdownForSpeech(body.text);
        if (!speech) return sendJson(res, 400, { ok: false, error: 'Nothing to read aloud.' });
        stopSpeaking();
        const child = speakFn(speech);
        activeSpeakProc = child;
        child.on('exit', () => {
          if (activeSpeakProc === child) activeSpeakProc = null;
        });
        child.on('error', () => {
          if (activeSpeakProc === child) activeSpeakProc = null;
        });
        return sendJson(res, 200, { ok: true, speaking: true });
      }

      if (req.method === 'POST' && pathname === '/api/chat/speak/stop') {
        stopSpeaking();
        return sendJson(res, 200, { ok: true, speaking: false });
      }

      if (req.method === 'POST' && pathname === '/api/artifacts/stage') {
        const body = await readJsonBody(req);
        const code = String(body.code ?? '');
        if (!code.trim()) return sendJson(res, 400, { ok: false, error: 'Artifact code is empty.' });
        if (code.length > 512 * 1024) {
          return sendJson(res, 413, { ok: false, error: 'Artifact exceeds 512 KB preview limit.' });
        }
        const id = crypto.randomBytes(16).toString('hex');
        const html = buildSandboxArtifactHtml({
          code,
          lang: body.lang,
          title: body.title,
        });
        previewArtifacts.set(id, html);
        if (previewArtifacts.size > 40) {
          const oldest = previewArtifacts.keys().next().value;
          if (oldest) previewArtifacts.delete(oldest);
        }
        return sendJson(res, 200, { ok: true, id, previewUrl: `/preview-sandbox/${id}` });
      }

      // Deep link into the right Privacy & Security pane. macOS folder access can
      // only be granted by a human, so the UI offers this instead of repeating a
      // dialog the app cannot dismiss.
      if (req.method === 'POST' && pathname === '/api/system/privacy-pane') {
        const body = await readJsonBody(req);
        const panes = {
          allfiles: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
          filesandfolders: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
          automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
          accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        };
        const target = panes[String(body.pane || '')];
        if (!target) {
          return sendJson(res, 400, { ok: false, error: 'Unknown privacy pane.' });
        }
        spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
        return sendJson(res, 200, { ok: true, opened: String(body.pane) });
      }

      // Quick reminders from the Dashboard (delegates to the macOS notification reminder tool)
      if (req.method === 'POST' && pathname === '/api/reminders') {
        const body = await readJsonBody(req);
        const minutes = Number(body.minutes);
        const seconds = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : Number(body.seconds);
        const message = String(body.message ?? '').trim();
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return sendJson(res, 400, { ok: false, error: 'Reminder delay must be a positive number of minutes.' });
        }
        if (!message || message.length > 200) {
          return sendJson(res, 400, { ok: false, error: 'Reminder message must be 1-200 characters.' });
        }
        const result = await setReminderTool({ seconds, message });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      // Schedule / timetable
      if (req.method === 'GET' && pathname === '/api/schedule') {
        const entries = await loadSchedule(paths);
        sendJson(res, 200, { ok: true, entries, today: entriesForDate(entries) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/schedule') {
        const body = await readJsonBody(req);
        const result = await upsertScheduleEntry(body, paths);
        if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
        sendJson(res, 200, {
          ok: true,
          entry: result.entry,
          entries: result.entries,
          today: entriesForDate(result.entries),
        });
        return;
      }

      const scheduleDelMatch = pathname.match(/^\/api\/schedule\/([^/]+)$/);
      if (scheduleDelMatch && req.method === 'DELETE') {
        const result = await deleteScheduleEntry(decodeURIComponent(scheduleDelMatch[1]), paths);
        if (!result.ok) return sendJson(res, 404, { ok: false, error: result.error });
        sendJson(res, 200, { ok: true, deleted: result.deleted, entries: result.entries });
        return;
      }

      // Instant actions: deterministic, read-only Mac lookups with no model round-trip.
      if (req.method === 'GET' && pathname === '/api/actions') {
        sendJson(res, 200, { ok: true, actions: INSTANT_ACTION_IDS });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/actions/run') {
        const body = await readJsonBody(req);
        const result = await runInstantAction(body.action, { paths, cwd: body.cwd });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      // Sessions
      if (req.method === 'GET' && pathname === '/api/sessions') {
        const sessions = await listSessions(paths);
        sendJson(res, 200, { ok: true, sessions });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/sessions') {
        const body = await readJsonBody(req);
        for (const field of ['id', 'title', 'provider', 'model']) {
          if (body[field] !== undefined && typeof body[field] !== 'string') {
            return sendJson(res, 400, { ok: false, error: `${field} must be a string` });
          }
        }
        if (body.id !== undefined && !SAFE_ID_RE.test(body.id)) {
          return sendJson(res, 400, { ok: false, error: 'id may only contain letters, digits, - and _ (max 81 chars)' });
        }
        const cfg = await loadConfig(paths);
        const session = await saveSession(
          {
            id: body.id || `task-${Date.now()}`,
            title: body.title?.trim() ? body.title.trim().slice(0, 80) : 'New Task',
            source: 'interactive',
            provider: (body.provider || cfg.provider).trim().slice(0, 120),
            model: (body.model || cfg.model).trim().slice(0, 120),
            messages: [],
          },
          paths
        );
        sendJson(res, 200, { ok: true, session });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/sessions/search') {
        const q = url.searchParams.get('q') || '';
        const results = await searchSessions(q, paths);
        return sendJson(res, 200, { ok: true, results });
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(run|approve|cancel|compact|truncate|fork))?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const action = sessionMatch[2];

        if (!action && req.method === 'GET') {
          const session = await loadSession(sessionId, paths);
          if (!session) return sendJson(res, 404, { ok: false, error: 'Session not found' });
          return sendJson(res, 200, { ok: true, session });
        }

        if (!action && req.method === 'PATCH') {
          const body = await readJsonBody(req);
          const session = await loadSession(sessionId, paths);
          if (!session) return sendJson(res, 404, { ok: false, error: 'Session not found' });

          if (typeof body.title === 'string' && body.title.trim()) {
            session.title = body.title.trim().slice(0, 80);
          }
          if (typeof body.pinned === 'boolean') {
            session.pinned = body.pinned;
          }
          if (typeof body.mode === 'string' && ALLOWED_SESSION_MODES.has(body.mode)) {
            session.mode = body.mode;
          }
          if (typeof body.provider === 'string' && body.provider.trim()) {
            session.provider = body.provider.trim();
          }
          if (typeof body.model === 'string' && body.model.trim()) {
            session.model = body.model.trim();
          }
          if (typeof body.cwd === 'string') {
            const rawCwd = body.cwd.trim();
            if (!rawCwd) {
              session.cwd = '';
            } else {
              const expanded = expandUserPath(rawCwd);
              const st = await fs.stat(expanded).catch(() => null);
              if (!st || !st.isDirectory()) {
                return sendJson(res, 400, { ok: false, error: `Folder not found: ${expanded}` });
              }
              session.cwd = expanded;
            }
          }
          const saved = await saveSession(session, paths);
          return sendJson(res, 200, { ok: true, session: saved });
        }

        if (!action && req.method === 'DELETE') {
          const deleted = await deleteSession(sessionId, paths);
          return sendJson(res, 200, { ok: true, deleted });
        }

        if (action === 'truncate' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const session = await loadSession(sessionId, paths);
          if (!session) return sendJson(res, 404, { ok: false, error: 'Session not found' });
          const msgs = Array.isArray(session.messages) ? session.messages : [];
          const keepCount = Math.max(0, Math.min(msgs.length, Math.floor(Number(body.keepCount) || 0)));
          session.messages = msgs.slice(0, keepCount);
          const saved = await saveSession(session, paths);
          return sendJson(res, 200, { ok: true, session: saved });
        }

        if (action === 'fork' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const source = await loadSession(sessionId, paths);
          if (!source) return sendJson(res, 404, { ok: false, error: 'Session not found' });
          const msgs = Array.isArray(source.messages) ? source.messages : [];
          const upTo =
            body.upToIndex !== undefined
              ? Math.max(0, Math.min(msgs.length, Math.floor(Number(body.upToIndex) || 0)))
              : msgs.length;
          const branchId = `task-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
          const baseTitle = String(source.title || 'Untitled').replace(/ \(Branch\)$/, '');
          const forked = await saveSession(
            {
              id: branchId,
              title: `${baseTitle.slice(0, 44)} (Branch)`,
              source: 'interactive',
              provider: source.provider,
              model: source.model,
              cwd: source.cwd || '',
              mode: source.mode || 'auto',
              pinned: false,
              messages: structuredClone(msgs.slice(0, upTo)),
            },
            paths
          );
          return sendJson(res, 200, { ok: true, session: forked });
        }

        if (action === 'approve' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const runState = activeRuns.get(sessionId);
          const resolver = runState?.approvals?.get(body.toolCallId);
          if (!resolver) return sendJson(res, 404, { ok: false, error: 'Approval request not found' });
          runState.approvals.delete(body.toolCallId);
          resolver({
            approved: Boolean(body.approved),
            editedCommand: body.editedCommand,
            reason: body.reason,
          });
          return sendJson(res, 200, { ok: true });
        }

        if (action === 'cancel' && req.method === 'POST') {
          const runState = activeRuns.get(sessionId);
          if (runState) {
            runState.abortController.abort();
            resolveRunApprovals(runState, 'Run cancelled by user.');
          }
          return sendJson(res, 200, { ok: true });
        }

        if (action === 'compact' && req.method === 'POST') {
          const session = await loadSession(sessionId, paths);
          if (!session) return sendJson(res, 404, { ok: false, error: 'Session not found' });
          const cfg = await loadConfig(paths);
          const result = await compactConversation(session.messages || [], {
            numCtx: cfg.numCtx,
            force: true,
          });
          if (result.compacted) {
            session.messages = result.messages;
            await saveSession(session, paths);
          }
          return sendJson(res, 200, { ok: true, compacted: result.compacted, session });
        }

        if (action === 'run' && req.method === 'POST') {
          const body = await readJsonBody(req);
          // Barge-in: the user sends a new message while LocalGravity is reading
          // aloud, so in-flight speech stops immediately — the user speaks first.
          stopSpeaking();
          const existingRun = activeRuns.get(sessionId);
          if (existingRun) {
            existingRun.abortController.abort();
            resolveRunApprovals(existingRun, 'Superseded by new user message.');
            await Promise.race([
              existingRun.donePromise?.catch(() => {}),
              new Promise((r) => setTimeout(r, 2000)),
            ]);
          }

          const cfg = await loadConfig(paths);
          let session = await loadSession(sessionId, paths);
          if (!session) {
            session = {
              id: sessionId,
              title: formatSmartTitle(body.message),
              source: 'interactive',
              provider: body.provider || cfg.provider,
              model: body.model || cfg.model,
              cwd: typeof body.cwd === 'string' ? expandUserPath(body.cwd.trim()) : '',
              mode: typeof body.mode === 'string' && ALLOWED_SESSION_MODES.has(body.mode) ? body.mode : 'auto',
              messages: [],
            };
          } else if (session.title === 'New Task' && body.message) {
            session.title = formatSmartTitle(body.message);
          }

          if (body.provider) session.provider = body.provider;
          if (body.model) session.model = body.model;
          if (typeof body.mode === 'string' && ALLOWED_SESSION_MODES.has(body.mode)) session.mode = body.mode;
          if (typeof body.cwd === 'string') session.cwd = body.cwd.trim() ? expandUserPath(body.cwd.trim()) : '';

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.flushHeaders();

          const emitSse = (event) => {
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          };

          // Deterministic fast-path: arithmetic, unit conversions, percentages,
          // and the current time/date are answered instantly on device with no
          // model round-trip, so quick lookups never stall on slow local
          // inference. Anything ambiguous falls through to the model.
          const fast = (!Array.isArray(body.attachments) || !body.attachments.length) && !body.instantAction
            ? tryFastAnswer(body.message || '')
            : null;
          if (fast) {
            const startedAt = Date.now();
            const content = fast.answer;
            const usage = { durationMs: Date.now() - startedAt, model: '' };
            if (!Array.isArray(session.messages)) session.messages = [];
            session.messages.push({ role: 'user', content: String(body.message || '').trim(), createdAt: new Date().toISOString() });
            session.messages.push({ role: 'assistant', content, usage, createdAt: new Date().toISOString() });
            session.updatedAt = new Date().toISOString();
            await saveSession(session, paths).catch(() => {});
            emitSse({ type: 'text_delta', text: content });
            emitSse({ type: 'done', status: fast.ok ? 'completed' : 'error', usage });
            res.end();
            return;
          }

          const keepaliveTimer = setInterval(() => {
            if (!res.writableEnded) {
              res.write(': keepalive\n\n');
            }
          }, 15000);
          keepaliveTimer.unref?.();

          const abortController = new AbortController();
          const approvals = new Map();
          let resolveDone;
          const donePromise = new Promise((resolve) => {
            resolveDone = resolve;
          });
          const runEntry = { abortController, approvals, donePromise };
          activeRuns.set(sessionId, runEntry);

          req.on('close', () => {
            if (!res.writableEnded) {
              abortController.abort();
              resolveRunApprovals(runEntry, 'Client disconnected.');
            }
          });

          try {
            const effectiveConfig = {
              ...cfg,
              provider: body.provider || session.provider || cfg.provider,
              model: body.model || session.model || cfg.model,
              thinking: body.thinking !== undefined ? Boolean(body.thinking) : cfg.thinking,
              safetyMode: body.safetyMode || cfg.safetyMode,
              ...(body.customBaseUrl ? { customBaseUrl: body.customBaseUrl } : {}),
            };

            if (effectiveConfig.provider === 'ollama' && !body.instantAction) {
              await modelWarmups.get(effectiveConfig.model);
            }
            await runAgentTurnFn({
              session,
              userMessage: body.message || '',
              attachments: Array.isArray(body.attachments) ? body.attachments : [],
              paths,
              providerConfig: effectiveConfig,
              mode: body.mode || session.mode || 'auto',
              cwd: session.cwd || undefined,
              instantAction: body.instantAction || undefined,
              onEvent: emitSse,
              abortSignal: abortController.signal,
              requestApproval: (approvalReq) =>
                new Promise((resolve) => {
                  approvals.set(approvalReq.toolCallId, resolve);
                }),
            });
          } finally {
            clearInterval(keepaliveTimer);
            if (activeRuns.get(sessionId) === runEntry) {
              activeRuns.delete(sessionId);
            }
            resolveDone();
            if (!res.writableEnded) res.end();
          }
          return;
        }
      }

      // Skills
      if (req.method === 'GET' && pathname === '/api/skills') {
        await syncStarterSkills(paths);
        const skills = await listSkills(paths);
        return sendJson(res, 200, { ok: true, skills });
      }

      if (req.method === 'GET' && pathname === '/api/skills/external') {
        const installed = await listSkills(paths);
        const sources = await listSkillSources({
          homeDir: skillHomeDir,
          installedSlugs: installed.map((skill) => skill.slug),
        });
        const antigravity = sources.find((source) => source.id === 'antigravity') || { dir: '', skills: [] };
        return sendJson(res, 200, {
          ok: true,
          sources,
          sourceDir: antigravity.dir,
          skills: antigravity.skills,
        });
      }

      if (
        req.method === 'POST' &&
        (pathname === '/api/skills/import-external' || pathname === '/api/skills/import-antigravity')
      ) {
        const body = await readJsonBody(req);
        const sourceId = pathname.endsWith('import-antigravity')
          ? 'antigravity'
          : String(body.sourceId || '').trim();
        const names = (Array.isArray(body.names) ? body.names : [])
          .map((name) => String(name || '').trim())
          .filter(Boolean)
          .slice(0, 200);
        if (!sourceId) {
          return sendJson(res, 400, { ok: false, error: 'Choose a skill library to import from.' });
        }
        if (names.length === 0) {
          return sendJson(res, 400, { ok: false, error: 'Select at least one skill to import.' });
        }
        const imported = await importSkillsFromSource(sourceId, names, { homeDir: skillHomeDir, paths });
        return sendJson(res, 200, { ok: true, imported });
      }

      // Import a SKILL.md from GitHub or any public raw URL
      if (req.method === 'POST' && pathname === '/api/skills/import-url') {
        const body = await readJsonBody(req);
        const urls = (Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [])
          .map((u) => String(u || '').trim())
          .filter(Boolean)
          .slice(0, 10);
        if (urls.length === 0) {
          return sendJson(res, 400, { ok: false, error: 'Provide a skill URL to import.' });
        }
        const imported = [];
        const errors = [];
        for (const rawUrl of urls) {
          try {
            imported.push(await importSkillFromUrl(rawUrl, { fetchFn, paths }));
          } catch (err) {
            errors.push({ url: rawUrl, error: err.message });
          }
        }
        return sendJson(res, 200, { ok: imported.length > 0, imported, errors });
      }

      if (req.method === 'POST' && pathname === '/api/skills') {
        const body = await readJsonBody(req);
        const saved = await saveSkill(body, paths);
        return sendJson(res, 200, { ok: true, saved });
      }

      const skillRefreshMatch = pathname.match(/^\/api\/skills\/([^/]+)\/refresh$/);
      if (skillRefreshMatch && req.method === 'POST') {
        const name = decodeURIComponent(skillRefreshMatch[1]);
        try {
          const refreshed = await refreshSkillFromUrl(name, { fetchFn, paths });
          return sendJson(res, 200, { ok: true, refreshed });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillMatch) {
        const name = decodeURIComponent(skillMatch[1]);
        if (req.method === 'GET') {
          const skill = await readSkill(name, paths);
          if (!skill) return sendJson(res, 404, { ok: false, error: 'Skill not found' });
          return sendJson(res, 200, { ok: true, skill });
        }
        if (req.method === 'DELETE') {
          const deleted = await deleteSkill(name, paths);
          return sendJson(res, 200, { ok: true, deleted });
        }
      }

      // Knowledge Base & Persistent Memory
      if (req.method === 'GET' && pathname === '/api/knowledge') {
        await ensureKnowledgeSeeded(paths);
        const q = url.searchParams.get('q');
        if (q) {
          const hits = await searchKnowledge(q, paths);
          return sendJson(res, 200, { ok: true, hits });
        }
        const docs = await listKnowledge(paths);
        return sendJson(res, 200, { ok: true, docs });
      }

      if (req.method === 'POST' && pathname === '/api/knowledge') {
        const body = await readJsonBody(req);
        const saved = await saveKnowledge(body, paths);
        return sendJson(res, 200, { ok: true, saved });
      }

      if (req.method === 'POST' && pathname === '/api/knowledge/upload') {
        const body = await readJsonBody(req, 8 * 1024 * 1024);
        const rawFilename = String(body.filename || 'uploaded-doc').replace(/\.[^.]+$/, '');
        const slug = rawFilename.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || `doc-${Date.now()}`;
        const saved = await saveKnowledge(
          {
            name: slug,
            title: body.title || rawFilename,
            tags: Array.isArray(body.tags) ? body.tags : ['uploaded'],
            content: String(body.content || ''),
          },
          paths
        );
        return sendJson(res, 200, { ok: true, saved });
      }

      // Pull a public page or raw text into the Knowledge Base
      if (req.method === 'POST' && pathname === '/api/knowledge/import-url') {
        const body = await readJsonBody(req);
        const rawUrl = String(body.url || '').trim();
        if (!rawUrl) return sendJson(res, 400, { ok: false, error: 'Provide a URL to import.' });
        let parsed;
        try {
          parsed = assertPublicHttpUrl(rawUrl, 'URL');
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
        const fetched = await safePublicFetch(parsed.toString(), { fetchFn, timeoutMs: 15000 });
        if (!fetched.ok) {
          return sendJson(res, 502, { ok: false, error: `HTTP ${fetched.status} fetching ${parsed}` });
        }
        const text = htmlToText(await fetched.text()).slice(0, 200000);
        if (!text) {
          return sendJson(res, 422, { ok: false, error: 'The page contained no readable text.' });
        }
        const nameSource = String(body.name || parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname);
        const name =
          nameSource
            .replace(/\.[a-z0-9]+$/i, '')
            .replace(/[^a-zA-Z0-9_-]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 62) || `url-${Date.now()}`;
        const saved = await saveKnowledge(
          {
            name,
            title: String(body.title || parsed.hostname),
            tags: ['imported', 'url'],
            content: text,
          },
          paths
        );
        return sendJson(res, 200, { ok: true, saved, chars: text.length });
      }

      if (req.method === 'POST' && pathname === '/api/knowledge/LEARNED_FIXES/reset') {
        const doc = await resetLearnedFixes(paths);
        return sendJson(res, 200, { ok: true, doc });
      }

      const knowMatch = pathname.match(/^\/api\/knowledge\/([^/]+)$/);
      if (knowMatch) {
        const name = decodeURIComponent(knowMatch[1]);
        if (req.method === 'GET') {
          const doc = await readKnowledge(name, paths);
          if (!doc) return sendJson(res, 404, { ok: false, error: 'Knowledge doc not found' });
          return sendJson(res, 200, { ok: true, doc });
        }
        if (req.method === 'DELETE') {
          const deleted = await deleteKnowledge(name, paths);
          return sendJson(res, 200, { ok: true, deleted });
        }
      }

      // Automations
      if (req.method === 'GET' && pathname === '/api/automations') {
        const automations = await loadAutomations(paths);
        return sendJson(res, 200, { ok: true, automations });
      }

      if (req.method === 'POST' && pathname === '/api/automations') {
        const body = await readJsonBody(req);
        const list = await loadAutomations(paths);
        const id = body.id || `auto-${Date.now()}`;
        const item = {
          id,
          name: String(body.name || 'Saved Workflow').trim(),
          prompt: String(body.prompt || '').trim(),
          attachments: Array.isArray(body.attachments) ? body.attachments : [],
          allowAutoRun: Boolean(body.allowAutoRun),
          schedule: body.schedule || { enabled: false },
          createdAt: new Date().toISOString(),
        };
        const existingIdx = list.findIndex((a) => a.id === id);
        if (existingIdx !== -1) list[existingIdx] = { ...list[existingIdx], ...item };
        else list.push(item);
        await saveAutomations(list, paths);
        return sendJson(res, 200, { ok: true, automation: item });
      }

      const autoMatch = pathname.match(/^\/api\/automations\/([^/]+)(?:\/(schedule))?$/);
      if (autoMatch) {
        const id = decodeURIComponent(autoMatch[1]);
        const sub = autoMatch[2];
        if (sub === 'schedule' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const updated = await setAutomationSchedule(id, body, paths);
          return sendJson(res, 200, { ok: true, automation: updated });
        }
        if (!sub && req.method === 'DELETE') {
          await setAutomationSchedule(id, { enabled: false }, paths).catch(() => {});
          const list = await loadAutomations(paths);
          const filtered = list.filter((a) => a.id !== id);
          await saveAutomations(filtered, paths);
          return sendJson(res, 200, { ok: true, deleted: filtered.length < list.length });
        }
      }

      // Models & Config
      if (req.method === 'GET' && pathname === '/api/models/config') {
        const cfg = await loadConfig(paths);
        return sendJson(res, 200, { ok: true, presets: CLOUD_PRESETS, ...maskConfigForClient(cfg) });
      }

      if (req.method === 'POST' && pathname === '/api/models/config') {
        const body = await readJsonBody(req);
        const current = await loadConfig(paths);
        const nextKeys = { ...current.apiKeys };
        if (body.apiKeys && typeof body.apiKeys === 'object') {
          for (const [k, v] of Object.entries(body.apiKeys)) {
            if (v === null) delete nextKeys[k];
            else if (typeof v === 'string' && v.trim()) nextKeys[k] = v.trim();
          }
        }
        const patch = {
          ...(body.provider !== undefined ? { provider: body.provider } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.numCtx !== undefined ? { numCtx: Number(body.numCtx) } : {}),
          ...(body.thinking !== undefined ? { thinking: Boolean(body.thinking) } : {}),
          ...(body.safetyMode !== undefined ? { safetyMode: body.safetyMode } : {}),
          ...(body.customBaseUrl !== undefined ? { customBaseUrl: body.customBaseUrl } : {}),
          ...(body.customModel !== undefined ? { customModel: body.customModel } : {}),
          ...(body.agendaNotifications !== undefined
            ? { agendaNotifications: Boolean(body.agendaNotifications) }
            : {}),
          ...(body.agendaLeadMinutes !== undefined
            ? { agendaLeadMinutes: Math.min(30, Math.max(1, Math.floor(Number(body.agendaLeadMinutes) || 5))) }
            : {}),
          apiKeys: nextKeys,
        };
        const updated = await saveConfig(patch, paths);
        // Apply the toggle immediately; previously it only took effect after a
        // restart, and the restart re-enabled the notifier regardless.
        if (body.agendaNotifications !== undefined) {
          if (updated.agendaNotifications && !agendaStop) {
            agendaStop = startAgendaNotifier({ paths, notify: showNotificationTool });
          } else if (!updated.agendaNotifications && agendaStop) {
            agendaStop();
            agendaStop = null;
          }
        }
        for (const model of modelWarmups.keys()) {
          if (updated.provider !== 'ollama' || updated.model !== model) {
            modelWarmupControllers.get(model)?.abort();
          }
        }
        return sendJson(res, 200, { ok: true, ...maskConfigForClient(updated) });
      }

      if (req.method === 'GET' && pathname === '/api/models/ollama') {
        const ollama = await checkOllamaHealth();
        return sendJson(res, 200, { ok: true, ollama });
      }

      if (req.method === 'POST' && pathname === '/api/models/ollama/start') {
        await ensureOllamaRunning();
        const ollama = await checkOllamaHealth();
        return sendJson(res, 200, { ok: true, ollama });
      }

      if (req.method === 'GET' && pathname === '/api/models/ollama/warm/status') {
        const cfg = await loadConfig(paths);
        const model = url.searchParams.get('model') || '';
        if (cfg.provider !== 'ollama' || !cfg.model || model !== cfg.model) {
          return sendJson(res, 200, { ok: true, status: 'idle' });
        }
        return sendJson(res, 200, {
          ok: true,
          status: modelWarmups.has(model) ? 'warming' : modelWarmupStatuses.get(model) || 'idle',
          model,
        });
      }

      if (req.method === 'POST' && pathname === '/api/models/ollama/warm') {
        const cfg = await loadConfig(paths);
        if (cfg.provider !== 'ollama' || !cfg.model) {
          return sendJson(res, 200, { ok: true, status: 'skipped' });
        }
        if (!modelWarmups.has(cfg.model)) {
          const controller = new AbortController();
          modelWarmupStatuses.set(cfg.model, 'warming');
          let warmup;
          warmup = Promise.resolve()
            .then(() => ensureOllamaFn())
            .then(() => warmModelFn(cfg.model, { numCtx: cfg.numCtx, signal: controller.signal }))
            .then((result) =>
              modelWarmupStatuses.set(
                cfg.model,
                ['loaded', 'already_loaded'].includes(result?.status) ? 'loaded' : 'failed'
              )
            )
            .catch(() => modelWarmupStatuses.set(cfg.model, 'failed'))
            .finally(() => {
              if (modelWarmups.get(cfg.model) === warmup) {
                modelWarmups.delete(cfg.model);
                modelWarmupControllers.delete(cfg.model);
              }
            });
          modelWarmups.set(cfg.model, warmup);
          modelWarmupControllers.set(cfg.model, controller);
        }
        return sendJson(res, 202, { ok: true, status: 'warming', model: cfg.model });
      }

      if (req.method === 'POST' && pathname === '/api/models/ollama/unload') {
        const body = await readJsonBody(req);
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        const pendingModels = model ? [model] : [...modelWarmups.keys()];
        await Promise.all(
          pendingModels.map(async (name) => {
            modelWarmupControllers.get(name)?.abort();
            await modelWarmups.get(name);
          })
        );
        const result = await unloadModelsFn(undefined, model);
        if (model) {
          modelWarmupStatuses.delete(model);
        } else {
          modelWarmupStatuses.clear();
        }
        const ollama = await checkOllamaHealth();
        return sendJson(res, 200, { ok: true, ...result, ollama });
      }

      if (req.method === 'POST' && pathname === '/api/models/ollama/pull') {
        const body = await readJsonBody(req);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        try {
          await pullOllamaModel(body.name, (evt) => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`);
          });
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ status: 'success', done: true })}\n\n`);
        } catch (err) {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        } finally {
          if (!res.writableEnded) res.end();
        }
        return;
      }

      const ollamaDelMatch = pathname.match(/^\/api\/models\/ollama\/(.+)$/);
      if (ollamaDelMatch && req.method === 'DELETE') {
        const modelName = decodeURIComponent(ollamaDelMatch[1]);
        await deleteOllamaModel(modelName);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && pathname === '/api/media/preview') {
        const targetPath = url.searchParams.get('path');
        if (!targetPath) return sendJson(res, 400, { ok: false, error: 'Missing path' });
        // Trust boundary: this path arrives from the UI. Restrict previews to real media
        // files inside user-content roots (home, external volumes, temp) so a forged
        // request cannot probe system paths like /etc or /System.
        const requestedPath = path.resolve(expandUserPath(targetPath));
        const resolved = await fs.realpath(requestedPath).catch(() => null);
        if (!resolved) {
          return sendJson(res, 404, { ok: false, error: 'Not a readable file' });
        }
        const previewRoots = [os.homedir(), '/Volumes', os.tmpdir()];
        const canonicalRoots = (await Promise.all(
          previewRoots.map((root) => fs.realpath(root).catch(() => null))
        )).filter(Boolean);
        const inPreviewRoot = canonicalRoots.some(
          (root) => resolved === root || resolved.startsWith(root + path.sep)
        );
        if (!inPreviewRoot) {
          return sendJson(res, 400, { ok: false, error: 'Media preview is restricted to user files (home, external volumes, or temp).' });
        }
        const st = await fs.stat(resolved).catch(() => null);
        if (!st || !st.isFile()) {
          return sendJson(res, 404, { ok: false, error: 'Not a readable file' });
        }
        const result = await inspectMediaTool({ path: resolved, max_edge: 480 });
        if (!result.ok || !result.images?.length) {
          return sendJson(res, 404, { ok: false, error: result.output });
        }
        return sendJson(res, 200, { ok: true, dataUrl: `data:image/png;base64,${result.images[0]}`, meta: result.meta });
      }

      sendJson(res, 404, { ok: false, error: 'Endpoint not found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, Number(err?.statusCode) || 500, { ok: false, error: err.message });
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        res.end();
      }
    }
  });

  // Allow long-running SSE agent turns and Ollama model downloads without 5-minute request timeout drops
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65000;

  return {
    server,
    authToken: token,
    async start(port = 0) {
      await Promise.all([
        syncStarterSkills(paths),
        ensureKnowledgeSeeded(paths),
        ensureBriefingDiskCacheLoaded().catch(() => {}),
      ]);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      if (agendaNotifications && process.env.LOCALGRAVITY_DISABLE_AGENDA_NOTIFIER !== '1') {
        agendaStop = startAgendaNotifier({ paths, notify: showNotificationTool });
      }
      if (process.env.LOCALGRAVITY_DISABLE_AMBIENT_ALERTS !== '1') {
        ambientStop = startAmbientAlerter({ paths, notify: showNotificationTool });
      }
      // Delay initial nettop sampling slightly so app boot & UI stay instantaneous,
      // then accumulate interface deltas every 5 minutes in the background. Kernel
      // counters reset on reboot, so each delta is folded into a persistent state file.
      const { recordNetworkSample } = await import('./network-monitor.mjs');
      networkWarmTimer = setTimeout(() => {
        recordNetworkSample().catch(() => {});
      }, 8000);
      networkWarmTimer.unref?.();
      networkSampleTimer = setInterval(() => {
        recordNetworkSample().catch(() => {});
      }, 5 * 60 * 1000);
      networkSampleTimer.unref?.();
      return { port: addr.port, authToken: token };
    },
    async stop() {
      stopSpeaking();
      agendaStop?.();
      agendaStop = null;
      ambientStop?.();
      ambientStop = null;
      clearTimeout(networkWarmTimer);
      networkWarmTimer = null;
      clearInterval(networkSampleTimer);
      networkSampleTimer = null;
      for (const runState of activeRuns.values()) {
        runState.abortController.abort();
        resolveRunApprovals(runState, 'Server shutting down.');
      }
      activeRuns.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Keep the agent backend alive through stray async errors. A fire-and-forget
 * promise or a bug in one background task must not take down the whole app the
 * user is relying on. Log the failure to stderr (captured by the host for
 * diagnosis) and keep serving. Returns the handlers plus an uninstall hook so
 * the behaviour is testable without tripping the test runner's own listeners.
 */
export function installProcessSafetyNets(log = console.error) {
  const onRejection = (reason) => {
    log('LocalGravity: unhandled promise rejection (kept alive):', reason?.stack || reason);
  };
  const onException = (err) => {
    log('LocalGravity: uncaught exception (kept alive):', err?.stack || err);
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return {
    onRejection,
    onException,
    uninstall() {
      process.removeListener('unhandledRejection', onRejection);
      process.removeListener('uncaughtException', onException);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runtimePaths = getRuntimePaths();
  // Respect the saved setting instead of forcing the notifier on at every launch.
  const startupConfig = await loadConfig(runtimePaths).catch(() => ({}));
  const instance = createAgentServer({ agendaNotifications: startupConfig.agendaNotifications === true });

  // Keep the local model daemon warm-but-lean in the background: it auto-starts
  // Ollama (and restarts it after a crash) when a local model is active and
  // memory allows, without ever blocking a request or the UI thread.
  const daemonSupervisor = createDaemonSupervisor({
    getProvider: async () => (await loadConfig(runtimePaths)).provider,
    checkHealth: async () => ({
      installed: Boolean(cachedToolStatus?.ollama ?? true),
      running: (await checkOllamaHealth()).running,
    }),
    ensureRunning: () => ensureOllamaRunning(),
    getFreeMemBytes: () => os.freemem(),
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    daemonSupervisor.stop();
    await instance.stop().catch(() => {});
    process.exit(0);
  };

  instance.start(Number(process.env.PORT) || 0).then(({ port }) => {
    process.stdout.write(`READY:${port}\n`);
    daemonSupervisor.start();
  });

  // Self-terminate cleanly if the parent macOS host crashes or exits unexpectedly
  const parentPid = Number(process.env.LOCALGRAVITY_PARENT_PID || 0);
  if (Number.isInteger(parentPid) && parentPid > 1) {
    process.stdin.resume();
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    const parentWatch = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        shutdown();
      }
    }, 3000);
    parentWatch.unref?.();
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // Last line of defence: never let a stray async error silently kill the app.
  installProcessSafetyNets();
}
