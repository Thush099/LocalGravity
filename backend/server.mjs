import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compactConversation } from './agent/compactor.mjs';
import { runAgentTurn } from './agent/loop.mjs';
import { removeAllLaunchAgents, setAutomationSchedule } from './automations.mjs';
import {
  deleteKnowledge,
  ensureKnowledgeSeeded,
  listKnowledge,
  readKnowledge,
  saveKnowledge,
  searchKnowledge,
} from './knowledge-engine.mjs';
import {
  checkOllamaHealth,
  deleteOllamaModel,
  ensureOllamaRunning,
  pullOllamaModel,
} from './providers/ollama.mjs';
import { CLOUD_PRESETS } from './providers/openai-compat.mjs';
import {
  deleteSkill,
  importExternalSkills,
  listExternalSkills,
  listSkills,
  readSkill,
  saveSkill,
  syncStarterSkills,
} from './skills-engine.mjs';
import { getRuntimePaths } from './state/paths.mjs';
import {
  deleteSession,
  listSessions,
  loadAutomations,
  loadConfig,
  loadSession,
  saveAutomations,
  saveConfig,
  saveSession,
} from './state/storage.mjs';
import { inspectMediaTool } from './tools/media-tool.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '../ui');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req, limitBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request payload too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
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
  const [ffmpegPath, magickPath, ollamaPath] = await Promise.all([
    whichCmd('ffmpeg'),
    whichCmd('magick'),
    whichCmd('ollama'),
  ]);
  return {
    arch: os.arch(),
    totalRamGb,
    freeDiskGb,
    totalDiskGb,
    tools: {
      ffmpeg: Boolean(ffmpegPath),
      magick: Boolean(magickPath),
      ollama: Boolean(ollamaPath),
    },
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

export function createAgentServer({ authToken, paths = getRuntimePaths() } = {}) {
  const token = authToken || process.env.AUTH_TOKEN || crypto.randomBytes(32).toString('hex');
  const activeRuns = new Map();
  const resolveRunApprovals = (runState, reason) => {
    if (!runState?.approvals) return;
    for (const resolver of runState.approvals.values()) {
      resolver({ approved: false, reason });
    }
    runState.approvals.clear();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    try {
      // Static UI assets + bootstrap cookie
      if (!pathname.startsWith('/api/')) {
        const queryToken = url.searchParams.get('token');
        if (pathname === '/' && queryToken && safeTokenMatch(queryToken, token)) {
          res.setHeader('Set-Cookie', `lg_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`);
        }
        const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const resolved = path.resolve(UI_DIR, relPath);
        if (!resolved.startsWith(UI_DIR + path.sep) && resolved !== path.join(UI_DIR, 'index.html')) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        try {
          const data = await fs.readFile(resolved);
          const ext = path.extname(resolved).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
          res.end(data);
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

      // Health & System
      if (req.method === 'GET' && pathname === '/api/health') {
        const [system, ollama, cfg] = await Promise.all([
          getSystemStats(),
          checkOllamaHealth(),
          loadConfig(paths),
        ]);
        sendJson(res, 200, {
          ok: true,
          system,
          ollama,
          presets: CLOUD_PRESETS,
          ...maskConfigForClient(cfg),
        });
        return;
      }

      // Sessions
      if (req.method === 'GET' && pathname === '/api/sessions') {
        const sessions = await listSessions(paths);
        sendJson(res, 200, { ok: true, sessions });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/sessions') {
        const body = await readJsonBody(req);
        const cfg = await loadConfig(paths);
        const session = await saveSession(
          {
            id: body.id || `task-${Date.now()}`,
            title: body.title || 'New Task',
            source: 'interactive',
            provider: body.provider || cfg.provider,
            model: body.model || cfg.model,
            messages: [],
          },
          paths
        );
        sendJson(res, 200, { ok: true, session });
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(run|approve|cancel|compact))?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const action = sessionMatch[2];

        if (!action && req.method === 'GET') {
          const session = await loadSession(sessionId, paths);
          if (!session) return sendJson(res, 404, { ok: false, error: 'Session not found' });
          return sendJson(res, 200, { ok: true, session });
        }

        if (!action && req.method === 'DELETE') {
          const deleted = await deleteSession(sessionId, paths);
          return sendJson(res, 200, { ok: true, deleted });
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
          const cfg = await loadConfig(paths);
          let session = await loadSession(sessionId, paths);
          if (!session) {
            session = {
              id: sessionId,
              title: String(body.message || 'New Task').slice(0, 48) || 'New Task',
              source: 'interactive',
              provider: body.provider || cfg.provider,
              model: body.model || cfg.model,
              messages: [],
            };
          } else if (session.title === 'New Task' && body.message) {
            session.title = String(body.message).replace(/\s+/g, ' ').slice(0, 48);
          }

          if (body.provider) session.provider = body.provider;
          if (body.model) session.model = body.model;

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const emitSse = (event) => {
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          };

          const abortController = new AbortController();
          const approvals = new Map();
          activeRuns.set(sessionId, { abortController, approvals });

          req.on('close', () => {
            if (!res.writableEnded) {
              abortController.abort();
              resolveRunApprovals(activeRuns.get(sessionId), 'Client disconnected.');
            }
          });

          try {
            const effectiveConfig = {
              ...cfg,
              provider: body.provider || session.provider || cfg.provider,
              model: body.model || session.model || cfg.model,
              thinking: body.thinking !== undefined ? Boolean(body.thinking) : cfg.thinking,
              safetyMode: body.safetyMode || cfg.safetyMode,
            };

            await runAgentTurn({
              session,
              userMessage: body.message || '',
              attachments: Array.isArray(body.attachments) ? body.attachments : [],
              paths,
              providerConfig: effectiveConfig,
              onEvent: emitSse,
              abortSignal: abortController.signal,
              requestApproval: (approvalReq) =>
                new Promise((resolve) => {
                  approvals.set(approvalReq.toolCallId, resolve);
                }),
            });
          } finally {
            activeRuns.delete(sessionId);
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
        const antigravitySkillsDir = path.join(os.homedir(), '.gemini', 'config', 'skills');
        const skills = await listExternalSkills(antigravitySkillsDir);
        return sendJson(res, 200, { ok: true, sourceDir: antigravitySkillsDir, skills });
      }

      if (req.method === 'POST' && pathname === '/api/skills/import-antigravity') {
        const body = await readJsonBody(req);
        const antigravitySkillsDir = path.join(os.homedir(), '.gemini', 'config', 'skills');
        const imported = await importExternalSkills(antigravitySkillsDir, body.names, paths);
        return sendJson(res, 200, { ok: true, imported });
      }

      if (req.method === 'POST' && pathname === '/api/skills') {
        const body = await readJsonBody(req);
        const saved = await saveSkill(body, paths);
        return sendJson(res, 200, { ok: true, saved });
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
          apiKeys: nextKeys,
        };
        const updated = await saveConfig(patch, paths);
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
        const result = await inspectMediaTool({ path: targetPath, max_edge: 480 });
        if (!result.ok || !result.images?.length) {
          return sendJson(res, 404, { ok: false, error: result.output });
        }
        return sendJson(res, 200, { ok: true, dataUrl: `data:image/png;base64,${result.images[0]}`, meta: result.meta });
      }

      sendJson(res, 404, { ok: false, error: 'Endpoint not found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: err.message });
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        res.end();
      }
    }
  });

  return {
    server,
    authToken: token,
    async start(port = 0) {
      await syncStarterSkills(paths);
      await ensureKnowledgeSeeded(paths);
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      const addr = server.address();
      return { port: addr.port, authToken: token };
    },
    async stop() {
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const instance = createAgentServer();
  instance.start(Number(process.env.PORT) || 0).then(({ port }) => {
    process.stdout.write(`READY:${port}\n`);
  });
  const shutdown = async () => {
    await instance.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
