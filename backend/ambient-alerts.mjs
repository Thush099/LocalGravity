/**
 * Proactive environmental alerts — the "Sir, your battery is at 12%" voice.
 * Where the `briefing` tool answers "how is my Mac?" on demand, this module
 * speaks up *unprompted* when the machine crosses a real threshold, using the
 * same agenda-notifier tick + notify pattern.
 *
 * Two contracts keep unsolicited speech trustworthy:
 *
 * 1. Grounding: every message cites the observed value that triggered it, and an
 *    alert exists only because a threshold was crossed. Nothing is invented.
 * 2. Attention budget: unsolicited speech must be rare to stay welcome —
 *    quiet hours (warn-level muted), a per-alert cooldown, and a daily cap.
 *    CPU is deliberately excluded: single-sample CPU spikes are noise, and the
 *    `briefing` tool covers on-demand system inspection. Calendar items are
 *    agenda-notifier's job; this module stays environmental (battery, storage,
 *    memory).
 */

import path from 'node:path';
import { atomicWriteJson, loadConfig, readJsonSafe } from './state/storage.mjs';
import { collectSystemMetrics } from './system-monitor.mjs';

export const AMBIENT_THRESHOLDS = {
  battery: { high: 15, critical: 8 }, // percent, discharging only
  storage: { warn: 90, high: 95 }, // percent used, per volume
  memory: { warn: 95, high: 98 }, // percent used; macOS idles high, so the bar is high
};

const SEVERITY_RANK = { critical: 0, high: 1, warn: 2 };
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULTS = {
  quietHoursStart: 23,
  quietHoursEnd: 7,
  cooldownMinutes: 180,
  dailyCap: 6,
};

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export function resolveAmbientConfig(config = {}) {
  const qh = config.ambientQuietHours;
  const quietHoursStart = Array.isArray(qh) ? clampInt(qh[0], 0, 23, DEFAULTS.quietHoursStart) : DEFAULTS.quietHoursStart;
  const quietHoursEnd = Array.isArray(qh) ? clampInt(qh[1], 0, 23, DEFAULTS.quietHoursEnd) : DEFAULTS.quietHoursEnd;
  return {
    quietHoursStart,
    quietHoursEnd,
    cooldownMinutes: clampInt(config.ambientCooldownMinutes, 5, 1440, DEFAULTS.cooldownMinutes),
    dailyCap: clampInt(config.ambientDailyCap, 1, 24, DEFAULTS.dailyCap),
  };
}

/** True when `now`'s hour falls inside [start, end), wrap-aware (23 -> 7). */
export function isQuietHour(now, { quietHoursStart, quietHoursEnd }) {
  const h = now.getHours();
  return quietHoursStart === quietHoursEnd
    ? false
    : quietHoursStart < quietHoursEnd
      ? h >= quietHoursStart && h < quietHoursEnd
      : h >= quietHoursStart || h < quietHoursEnd;
}

/**
 * Detect grounded environmental alerts from observed metric values only.
 * Returns at most one alert per area (worst disk wins), sorted by severity.
 */
export function detectAmbientAlerts(metrics) {
  const alerts = [];
  const batt = metrics?.battery;
  if (batt && batt.state === 'discharging' && typeof batt.percent === 'number') {
    const t = AMBIENT_THRESHOLDS.battery;
    const mins = typeof batt.minutesRemaining === 'number' && batt.minutesRemaining > 0 ? ` (${batt.minutesRemaining} min left)` : '';
    if (batt.percent <= t.critical) {
      alerts.push({ id: 'battery', area: 'battery', severity: 'critical', message: `Battery is critically low at ${batt.percent}% and discharging${mins} — plug in now.` });
    } else if (batt.percent <= t.high) {
      alerts.push({ id: 'battery', area: 'battery', severity: 'high', message: `Battery is at ${batt.percent}% and discharging${mins} — plug in soon.` });
    }
  }

  const t = AMBIENT_THRESHOLDS.storage;
  let worst = null;
  for (const d of metrics?.disks ?? []) {
    if (typeof d.usedPercent !== 'number' || d.usedPercent < t.warn) continue;
    if (!worst || d.usedPercent > worst.usedPercent) worst = d;
  }
  if (worst) {
    const severity = worst.usedPercent >= t.high ? 'high' : 'warn';
    const tail = severity === 'high' ? 'free up space soon.' : 'consider freeing up space.';
    alerts.push({ id: `storage:${worst.mount}`, area: 'storage', severity, message: `Storage ${worst.mount} is ${worst.usedPercent}% full — ${tail}` });
  }

  const mem = metrics?.memory?.usedPercent;
  const m = AMBIENT_THRESHOLDS.memory;
  if (typeof mem === 'number' && mem >= m.warn) {
    const severity = mem >= m.high ? 'high' : 'warn';
    const tail = severity === 'high' ? ' — close unused apps.' : '.';
    alerts.push({ id: 'memory', area: 'memory', severity, message: `Memory is ${mem}% full${tail}` });
  }

  return alerts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Apply the attention budget to detected alerts. Pure given `state`.
 * Quiet hours mute 'warn' (but never 'high'/'critical'); each alert id has a
 * cooldown; and the whole day has a cap, allocated most-severe first.
 */
export function filterByBudget(alerts, { now = new Date(), state = {}, config = DEFAULTS } = {}) {
  const quiet = isQuietHour(now, config);
  const lastFired = state.lastFired ?? {};
  const todayKey = localDateKey(now);
  const firedToday = state.day === todayKey ? state.count ?? 0 : 0;
  let budget = Math.max(0, config.dailyCap - firedToday);
  const due = [];
  for (const alert of alerts) {
    if (budget <= 0) continue;
    if (quiet && alert.severity === 'warn') continue;
    const last = Date.parse(lastFired[alert.id] ?? '');
    if (Number.isFinite(last) && now.getTime() - last < config.cooldownMinutes * 60 * 1000) continue;
    due.push(alert);
    budget -= 1;
  }
  return { due };
}

function recordFired(state, alertId, now) {
  const todayKey = localDateKey(now);
  state.count = state.day === todayKey ? (state.count ?? 0) + 1 : 1;
  state.day = todayKey;
  state.lastFired = state.lastFired ?? {};
  state.lastFired[alertId] = now.toISOString();
}

function stateFile(paths) {
  return path.join(paths.root || paths.stateDir, 'ambient-alerts-state.json');
}

async function loadState(paths) {
  const raw = await readJsonSafe(stateFile(paths), {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

async function saveState(paths, state, now) {
  const cutoff = now.getTime() - RETENTION_MS;
  const pruned = {};
  for (const [id, at] of Object.entries(state.lastFired ?? {})) {
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= cutoff) pruned[id] = at;
  }
  state.lastFired = pruned;
  await atomicWriteJson(stateFile(paths), state, 0o600);
}

/**
 * One ambient pass: detect, budget, notify, persist. Mirrors runAgendaTick —
 * `notify` receives ({ title, message }) and may be async; a failed
 * notification is retried on the next tick. Callers may inject `metrics` to
 * skip live sampling.
 */
export async function runAmbientTick({ paths, now = new Date(), notify, metrics } = {}) {
  const config = await loadConfig(paths).catch(() => ({}));
  if (config.ambientAlerts === false) return [];
  const resolved = resolveAmbientConfig(config);
  const state = await loadState(paths);
  const live = metrics ?? (await collectSystemMetrics().catch(() => null));
  if (!live) return [];
  const { due } = filterByBudget(detectAmbientAlerts(live), { now, state, config: resolved });
  const fired = [];
  for (const alert of due) {
    try {
      const result = await notify({ title: 'LocalGravity', message: alert.message });
      if (result?.ok === false) continue;
      recordFired(state, alert.id, now);
      fired.push(alert.id);
    } catch {
      // Notification service down: leave the id unrecorded so it retries next tick.
    }
  }
  if (fired.length > 0) await saveState(paths, state, now);
  return fired;
}

/**
 * Start the periodic alerter. Returns a stop function.
 * The first check waits one full interval so short-lived runs (tests, one-off
 * CLI invocations) never emit notifications. Main-app only: tests drive
 * runAmbientTick directly.
 */
export function startAmbientAlerter({ paths, notify, intervalMs = 5 * 60 * 1000 } = {}) {
  const tick = () => runAmbientTick({ paths, notify }).catch(() => {});
  let interval = null;
  let timeout = setTimeout(() => {
    tick();
    interval = setInterval(tick, intervalMs);
    interval.unref?.();
  }, intervalMs);
  timeout.unref?.();
  return () => {
    clearTimeout(timeout);
    clearInterval(interval);
  };
}
