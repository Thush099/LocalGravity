/**
 * Action trail — an append-only record of what LocalGravity actually changed on
 * this machine, and what it was stopped from changing.
 *
 * The transcript answers "what did we talk about". It does not answer "did that
 * write land", "what has the agent touched today", or "why do my permissions
 * look like this" once the session is gone. This log is the durable answer: one
 * JSON line per durable action and per refused one, private to the user (0600),
 * never rewritten, and read back by the briefing.
 *
 * Scope is the same discipline as the rest of the honesty work: a read leaves no
 * artifact, and a `run_command` exit code is an observation rather than a change,
 * so only durable tools are logged as actions. A blocked or denied call is
 * logged whatever the tool, because "it did not happen" is the fact worth
 * keeping.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { getRuntimePaths } from '../state/paths.mjs';

export const ACTION_LOG_FILE = 'action-log.jsonl';
const MAX_DETAIL_CHARS = 240;
const MAX_LIMIT = 200;

const ACTION_KINDS = new Set(['ok', 'failed', 'blocked', 'denied']);

/** Tools whose success leaves a durable artifact behind. */
const TRAIL_TOOLS = new Set([
  'write_file',
  'edit_file',
  'move_file',
  'undo_file_moves',
  'manage_notes',
  'save_knowledge',
  'save_skill',
  'set_reminder',
  'cancel_reminder',
  'add_schedule_item',
  'remove_schedule_item',
  'git_op',
]);

export function isTrailTool(name) {
  return TRAIL_TOOLS.has(name);
}

export function actionLogFile(paths = getRuntimePaths()) {
  return path.join(paths.root, ACTION_LOG_FILE);
}

function clipDetail(detail) {
  const text = String(detail ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS - 1)}…` : text;
}

/**
 * Append one receipt. Never throws and never records an unnamed or untyped
 * action; returns the entry it wrote, or null when it declined.
 */
export async function appendAction(paths, { sessionId, tool, kind, detail } = {}) {
  const name = typeof tool === 'string' ? tool.trim() : '';
  if (!name || !ACTION_KINDS.has(kind)) return null;
  const entry = {
    at: new Date().toISOString(),
    tool: name,
    kind,
    ...(sessionId ? { sessionId: String(sessionId) } : {}),
    detail: clipDetail(detail),
  };
  try {
    const file = actionLogFile(paths);
    const existed = fs.existsSync(file);
    await fsPromises.mkdir(path.dirname(file), { recursive: true });
    await fsPromises.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (!existed) await fsPromises.chmod(file, 0o600).catch(() => {});
    return entry;
  } catch {
    return null;
  }
}

/** Newest-first slice of the trail; a missing or torn log reads as empty. */
export async function readActions(paths = getRuntimePaths(), { limit = 20 } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 20, MAX_LIMIT));
  let raw = '';
  try {
    raw = await fsPromises.readFile(actionLogFile(paths), 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') continue;
      if (typeof parsed.tool !== 'string' || typeof parsed.kind !== 'string') continue;
      entries.push({
        at: String(parsed.at || ''),
        tool: parsed.tool,
        kind: parsed.kind,
        detail: String(parsed.detail ?? ''),
        ...(parsed.sessionId ? { sessionId: String(parsed.sessionId) } : {}),
      });
    } catch {
      // A torn final line (crash mid-write) must not hide the rest of the trail.
    }
  }
  return entries.slice(-capped).reverse();
}