import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getRuntimePaths } from './state/paths.mjs';

const execFileAsync = promisify(execFile);
const PER_APP_CACHE_TTL_MS = 25000;
let perAppCache = null;
let perAppInFlight = null;

/**
 * Network & data-usage monitoring, entirely on-device and read-only. Per-app byte
 * counts come from `nettop`, whole-interface byte counters from `netstat -ib`, and
 * live throughput from a short timed download against Cloudflare's public speed
 * endpoint. Monthly totals are accumulated from counter deltas across samples, so they
 * survive reboots (the raw kernel counters reset whenever the Mac restarts).
 */

const SPEED_URL = 'https://speed.cloudflare.com/__down?bytes=52428800';
const HISTORY_MAX_DAYS = 62;
const EXEC_TIMEOUT_MS = 8000;

/**
 * Parse `nettop -P -L 1 -x -J bytes_in,bytes_out` output into per-process rows.
 * Lines look like `mDNSResponder.668,47408350,21873529,`; the header is
 * `,bytes_in,bytes_out,`. Counters are cumulative since the process started.
 */
export function parseNettop(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',');
    if (!parts[0]) continue; // header row has an empty first field
    const name = parts[0].replace(/\.\d+$/, ''); // drop the trailing .pid
    const bytesIn = Number(parts[1]) || 0;
    const bytesOut = Number(parts[2]) || 0;
    rows.push({ name, bytesIn, bytesOut });
  }
  return rows;
}

/**
 * Parse `netstat -ib` link-level rows into per-interface byte counters. Only `<Link#N>`
 * rows carry real byte totals (the IP rows repeat them). The 7 counters
 * (Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll) are always the last 7 whitespace tokens,
 * so an optional link/MAC address before them does not shift the parse.
 */
export function parseNetstat(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.includes('<Link')) continue;
    const t = trimmed.split(/\s+/);
    if (t.length < 7) continue;
    const rawName = t[0];
    const bytesIn = Number(t[t.length - 5]) || 0;
    const bytesOut = Number(t[t.length - 2]) || 0;
    const up = !rawName.endsWith('*');
    rows.push({ interface: rawName.replace(/\*$/, ''), bytesIn, bytesOut, up });
  }
  return rows;
}

// Physical NICs only: loopback (lo0) is local traffic and VPN tunnels (utun) reuse the
// physical link, so counting either would misreport actual internet usage.
function isPhysicalInterface(name) {
  return /^(en|eth|wl|wlan)\d/i.test(name);
}

/** Per-process network usage (cumulative since each process started), largest first. */
export async function perAppUsage({ limit = 12, execFileFn = execFileAsync, bypassCache = false } = {}) {
  const isDefaultExec = execFileFn === execFileAsync;
  if (!bypassCache && isDefaultExec && perAppCache && Date.now() - perAppCache.at < PER_APP_CACHE_TTL_MS) {
    return { ok: true, apps: perAppCache.apps.slice(0, limit) };
  }

  if (perAppInFlight) {
    const shared = await perAppInFlight;
    return { ok: shared.ok, apps: shared.apps.slice(0, limit), ...(shared.error ? { error: shared.error } : {}) };
  }

  perAppInFlight = (async () => {
    try {
      const { stdout } = await execFileFn('nettop', ['-P', '-L', '1', '-x', '-J', 'bytes_in,bytes_out'], {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      const byName = new Map();
      for (const row of parseNettop(stdout)) {
        const cur = byName.get(row.name) || { name: row.name, bytesIn: 0, bytesOut: 0 };
        cur.bytesIn += row.bytesIn;
        cur.bytesOut += row.bytesOut;
        byName.set(row.name, cur);
      }
      const apps = [...byName.values()]
        .map((a) => ({ ...a, total: a.bytesIn + a.bytesOut }))
        .filter((a) => a.total > 0)
        .sort((a, b) => b.total - a.total);
      if (isDefaultExec) {
        perAppCache = { at: Date.now(), apps };
      }
      return { ok: true, apps };
    } catch (err) {
      return { ok: false, apps: [], error: String(err?.message || err) };
    } finally {
      perAppInFlight = null;
    }
  })();

  const result = await perAppInFlight;
  return { ok: result.ok, apps: result.apps.slice(0, limit), ...(result.error ? { error: result.error } : {}) };
}

/** Raw per-interface byte counters (all link rows, including loopback). */
export async function interfaceCounters() {
  const { stdout } = await execFileAsync('netstat', ['-ib'], { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  return parseNetstat(stdout);
}

/** Total internet bytes (in + out) over the physical interfaces, cumulative since boot. */
export async function totalInterfaceBytes() {
  const rows = await interfaceCounters();
  return rows
    .filter((r) => r.up && isPhysicalInterface(r.interface))
    .reduce((sum, r) => sum + r.bytesIn + r.bytesOut, 0);
}

/**
 * Live throughput: stream from Cloudflare's speed endpoint across a few parallel
 * connections for a fixed window and report megabits per second actually moved.
 */
export async function speedTest({ seconds = 4, streams = 3 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  const start = Date.now();
  let bytes = 0;
  const one = async () => {
    try {
      const res = await fetch(SPEED_URL, { signal: controller.signal });
      const reader = res.body?.getReader?.();
      if (!reader) return;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength || 0;
      }
    } catch {
      // Aborted at the window edge (expected) or a transient network error; whatever
      // bytes arrived still count toward the throughput measurement.
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, streams) }, one));
  clearTimeout(timer);
  const secs = Math.max((Date.now() - start) / 1000, 0.001);
  return {
    ok: true,
    megabytes: +(bytes / 1e6).toFixed(2),
    seconds: +secs.toFixed(2),
    mbps: +((bytes * 8) / secs / 1e6).toFixed(2),
    streams,
  };
}

function usageStateFile(stateFile) {
  return stateFile || path.join(getRuntimePaths().root, 'network-usage.json');
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function dayKey(d) {
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
}

export function emptyState() {
  return {
    month: monthKey(new Date()),
    day: dayKey(new Date()),
    lastTotal: null,
    lastApps: {},
    monthTotal: 0,
    dayTotal: 0,
    apps: {},
    history: {},
  };
}

/**
 * Record one usage sample: fold the interface-counter delta and per-app deltas into the
 * running day/month totals. Counters reset on reboot, so a smaller-than-last reading is
 * treated as a reset and its value becomes the new delta. Persists to disk.
 */
/**
 * Fold one usage sample's counters into the running state. Pure and testable: takes the
 * current interface total plus per-app cumulative counters and a timestamp, and returns
 * the updated state. First sight of the total or an app seeds a zero baseline so existing
 * bytes are never miscounted as new usage; a counter that runs backwards (a reboot or app
 * restart) is treated as a reset and its current value becomes the new delta.
 */
export function foldUsageSample(state, { total = 0, apps = [] } = {}, now = new Date()) {
  const month = monthKey(now);
  const day = dayKey(now);
  const delta = state.lastTotal == null ? 0 : total >= state.lastTotal ? total - state.lastTotal : total;

  if (state.month !== month) {
    state.month = month;
    state.monthTotal = 0;
    state.apps = {}; // per-app month-to-date resets with the month
  }
  if (state.day !== day) {
    state.day = day;
    state.dayTotal = 0;
  }
  state.monthTotal += delta;
  state.dayTotal += delta;
  state.history[day] = (state.history[day] || 0) + delta;

  const currentApps = new Map();
  for (const app of apps) currentApps.set(app.name, app.total);
  for (const [name, cur] of currentApps) {
    const prev = state.lastApps[name];
    // First sight of an app seeds a baseline (delta 0), matching the interface counter,
    // so a long-running app's pre-existing bytes are never miscounted as this month's.
    const appDelta = prev == null ? 0 : cur >= prev ? cur - prev : cur;
    state.apps[name] = (state.apps[name] || 0) + appDelta;
  }
  state.lastApps = Object.fromEntries(currentApps);
  state.lastTotal = total;
  state.lastSample = now.getTime();

  // Keep the daily history bounded to roughly two months.
  const keys = Object.keys(state.history).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - HISTORY_MAX_DAYS))) delete state.history[key];
  return state;
}

/**
 * Record one live usage sample: gather current interface + per-app counters and fold
 * them into the persisted running totals.
 */
export async function recordNetworkSample({ stateFile } = {}) {
  const file = usageStateFile(stateFile);
  const total = await totalInterfaceBytes();
  const { apps } = await perAppUsage({ limit: 400 });

  let state = emptyState();
  try {
    state = { ...emptyState(), ...JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch {
    // No prior state yet — first sample seeds the baseline with a zero delta.
  }

  state = foldUsageSample(state, { total, apps }, new Date());

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state));
  return { ok: true, monthTotal: state.monthTotal, dayTotal: state.dayTotal };
}

export async function networkUsageSummary({ stateFile } = {}) {
  const file = usageStateFile(stateFile);
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    const apps = Object.entries(state.apps || {})
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total);
    return {
      ok: true,
      month: state.month,
      monthTotal: state.monthTotal || 0,
      dayTotal: state.dayTotal || 0,
      apps,
      history: state.history || {},
      lastSample: state.lastSample || null,
    };
  } catch {
    return { ok: true, month: monthKey(new Date()), monthTotal: 0, dayTotal: 0, apps: [], history: {}, lastSample: null };
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/**
 * Gather a fresh usage sample and render a readable report: month/day totals, per-app
 * top talkers, and the raw per-interface counter totals since boot.
 */
export async function networkUsageReport({ include_apps = true, limit = 8 } = {}) {
  await recordNetworkSample();
  const summary = await networkUsageSummary();
  const appsRes = include_apps ? await perAppUsage({ limit: Math.min(Number(limit) || 8, 25) }) : { apps: [] };
  const interfaces = (await interfaceCounters()).filter((r) => r.up && isPhysicalInterface(r.interface));
  const activeInterfaces = interfaces.filter((r) => r.bytesIn + r.bytesOut > 0);

  const lines = [];
  lines.push(`Network usage — this month: ${formatBytes(summary.monthTotal)} · today: ${formatBytes(summary.dayTotal)}`);
  lines.push('(month/day totals accumulate while LocalGravity is running)');
  if (appsRes.apps.length > 0) {
    lines.push('', 'Top talkers (bytes since each app started):');
    for (const a of appsRes.apps) lines.push(`  ${formatBytes(a.total).padStart(9)}  ${a.name}`);
  }
  if (summary.apps.length > 0) {
    lines.push('', `Most data this month (tracked while LocalGravity runs):`);
    for (const a of summary.apps.slice(0, Math.min(Number(limit) || 8, 25))) {
      lines.push(`  ${formatBytes(a.total).padStart(9)}  ${a.name}`);
    }
  }
  lines.push('', 'Kernel interface counters since boot (reset on restart):');
  for (const r of activeInterfaces) lines.push(`  ${r.interface}: ${formatBytes(r.bytesIn + r.bytesOut)}`);
  return lines.join('\n');
}

/** Render a one-line speed-test result. */
export async function speedTestReport({ seconds } = {}) {
  const r = await speedTest({ seconds });
  return `Internet speed: ${r.mbps} Mbps down — moved ${r.megabytes} MB in ${r.seconds}s across ${r.streams} streams.`;
}