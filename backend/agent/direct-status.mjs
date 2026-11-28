/**
 * Deterministic on-device answers for direct system-status questions: "how much
 * RAM is free", "disk space left", "battery level", "how long has this been up".
 * Each is a single lookup with no interpretation needed, so answering it here
 * skips a slow model round-trip (the model is memory-bound on this Mac).
 *
 * Detection is deliberately conservative. Anything that reads as a diagnosis or a
 * request to change something ("why is my RAM full", "how do I free memory",
 * "close apps to speed up") returns null and falls through to the model, which
 * is what should reason about it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectSystemMetrics } from '../system-monitor.mjs';
import { weatherSummary } from '../daily-briefing.mjs';

const run = promisify(execFile);

const DIAGNOSTIC_RE =
  /\b(why|how come|slow|sluggish|fix|speed|clean|free up|close|quit|kill|increase|reduce|optimize|draining|drain|improve|better|should|best|make|cause|reason)\b/i;

// "how do I find my IP" asks for instructions, not the value — leave those to the model.
const HOW_TO_RE = /\bhow\s+(?:do|can|to|would|should|could)\b/i;

/**
 * @param {string} message
 * @returns {'memory'|'disk'|'battery'|'uptime'|'processes'|'top_cpu'|'top_memory'|null} which metric a direct question asks for
 */
export function detectSystemStatusMetric(message) {
  const t = String(message || '').toLowerCase().trim().replace(/[.!?]+$/, '');
  if (!t || t.length > 80) return null;
  if (DIAGNOSTIC_RE.test(t) || HOW_TO_RE.test(t)) return null;

  const howMuch = /\bhow much\b/.test(t);
  const stateWord = /\b(free|left|remaining|available|usage|used|level|percentage|percent|status|charge|do i have)\b/.test(t);

  if (/\b(ram|memory)\b/.test(t) && (howMuch || stateWord)) return 'memory';
  const diskLike =
    /\b(disk|storage)\b/.test(t) ||
    /\b(free|how much)\s+space\b/.test(t) ||
    /\bspace\s+(?:left|available|remaining|is free|do i have)\b/.test(t);
  if (diskLike && (howMuch || stateWord)) return 'disk';
  if (/\bbattery\b/.test(t) && (howMuch || stateWord)) return 'battery';
  if (/\buptime\b/.test(t) || /\bhow long has (?:my |this |the )?(?:mac|computer|machine|laptop)\b/.test(t)) return 'uptime';

  // Running processes and resource hogs are read-only listings, not diagnoses.
  if (
    /\b(?:memory|ram)\s+hogs?\b/.test(t) ||
    /\bwhat(?:'s|\s+is|\s+are)?\s+(?:using|eating|hogging|taking)\s+(?:up\s+)?(?:my\s+|the\s+)?(?:memory|ram)\b/.test(t) ||
    /\b(?:biggest|top|largest)\s+(?:memory|ram)\b/.test(t)
  ) return 'top_memory';
  if (
    /\b(?:cpu|processor)\s+hogs?\b/.test(t) ||
    /\bwhat(?:'s|\s+is|\s+are)?\s+(?:using|eating|hogging|taking)\s+(?:up\s+)?(?:my\s+|the\s+)?(?:cpu|processor)\b/.test(t) ||
    /\b(?:biggest|top|largest)\s+(?:cpu|processor)\b/.test(t)
  ) return 'top_cpu';
  if (
    /\bwhat(?:'s|\s+is|\s+are)?\s+(?:currently\s+)?(?:running|open)\b/.test(t) ||
    /\bwhat\s+(?:apps?|programs?|processes?)\s+(?:are\s+)?(?:running|open)\b/.test(t) ||
    /\b(?:running|open)\s+(?:apps?|programs?|processes?)\b/.test(t) ||
    /\btop\s+processes?\b/.test(t)
  ) return 'processes';
  return null;
}

// Deterministic disk-usage lookup: "largest files" / "what's using my disk" runs the
// bounded large-files scan directly instead of a slow model round-trip. Wrapped so a
// scan/import failure never breaks the fast-path chain — it just falls to the model.
export async function answerDirectLargeFiles(message) {
  try {
    const t = String(message || '').toLowerCase().trim().replace(/[.!?]+$/, '');
    if (!t || t.length > 80) return null;
    if (HOW_TO_RE.test(t)) return null;
    const hit =
      /\b(?:largest|biggest|top)\s+files?\b/.test(t) ||
      /\bwhat(?:'s| is|s)?\s+(?:using|taking|eating|hogging)\s+(?:up\s+)?(?:my\s+)?(?:disk|storage|space)\b/.test(t) ||
      /\b(?:disk|storage|space)\s+(?:usage|use|hog)\b/.test(t);
    if (!hit) return null;
    const [os, path, fs, actions] = await Promise.all([
      import('node:os'), import('node:path'), import('node:fs/promises'), import('../actions.mjs'),
    ]);
    const home = os.default.homedir();
    const dirs = [];
    for (const name of ['Downloads', 'Desktop', 'Documents']) {
      const dir = path.default.join(home, name);
      try { await fs.default.access(dir); dirs.push(dir); } catch { /* not present */ }
    }
    if (!dirs.length) return null;
    const output = await actions.largestFilesReport(dirs, { limit: 8, maxEntries: 1200, maxDirs: 150 });
    return output ? { answer: output } : null;
  } catch {
    return null;
  }
}

// Single-value system lookups answered on demand (each one command, no model).
export function detectOnDemandLookup(t) {
  if (/\b(?:my|local|this)\s+(?:ip|ip\s+address)\b/.test(t)) return 'ip';
  if (/\b(?:macos|mac\s+os|os)\s+version\b/.test(t)) return 'os_version';
  if (/\b(?:computer|machine|device|host)\s*name\b/.test(t) || /\bhostname\b/.test(t)) return 'computer_name';
  // CPU/cores only for a clear lookup; "my cpu is slow" is diagnosis and handled by the DIAGNOSTIC guard.
  if (/\b(?:how many|number of)\s+(?:cpu\s+)?(?:cores?|processors?|threads?)\b/.test(t) ||
      /\b(?:what|which)\s+(?:cpu|processor|chip)\b/.test(t) ||
      /\b(?:cpu|processor|chip)\s+(?:info|specs?|count|cores?)\b/.test(t)) return 'cpu';
  // Wi-Fi name only for a clear lookup; a status report ("my wifi is down") goes to the model.
  if (/\b(?:down|not\s+working|broken|slow|disconnect|no\s+internet|dropping)\b/.test(t)) return null;
  if (/\b(?:my|this|current)\s+(?:wifi|wi-fi|wireless|network)\b/.test(t) ||
      /\bnetwork\s+(?:am i|are we|do i)\s+(?:connected|on)\b/.test(t)) return 'wifi';
  return null;
}

// Each lookup is one read-only command; return null on failure so the model can answer.
async function lookupSystemValue(metric) {
  const exec = async (cmd, args) => (await run(cmd, args).catch(() => ({ stdout: '' }))).stdout.trim();
  if (metric === 'ip') {
    const ip = await exec('/usr/sbin/ipconfig', ['getifaddr', 'en0']);
    return ip ? `Local IP: **${ip}**.` : null;
  }
  if (metric === 'os_version') {
    const version = await exec('/usr/bin/sw_vers', ['-productVersion']);
    return version ? `macOS **${version}**.` : null;
  }
  if (metric === 'computer_name') {
    const name = await exec('/usr/sbin/scutil', ['--get', 'ComputerName']);
    return name ? `This Mac is named **${name}**.` : null;
  }
  if (metric === 'cpu') {
    const brand = await exec('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']);
    const physical = await exec('/usr/sbin/sysctl', ['-n', 'hw.physicalcpu']);
    const logical = await exec('/usr/sbin/sysctl', ['-n', 'hw.ncpu']);
    if (!brand && !physical) return null;
    return `**${brand || 'CPU'}** — ${physical || '?'} cores / ${logical || '?'} threads.`;
  }
  if (metric === 'wifi') {
    const out = await exec('/usr/sbin/networksetup', ['-getairportnetwork', 'en0']);
    if (/not associated|off/i.test(out)) return "This Mac isn't connected to Wi-Fi right now.";
    const ssid = out.includes(':') ? out.split(':').slice(1).join(':').trim() : '';
    return ssid ? `Connected to Wi-Fi **${ssid}**.` : null;
  }
  return null;
}

function gb(bytes) {
  return bytes == null ? 'an unknown amount' : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * @param {'memory'|'disk'|'battery'|'uptime'|'processes'|'top_cpu'|'top_memory'} metric
 * @param {object} snapshot a collectSystemSnapshot() result
 * @returns {string|null}
 */
export function formatSystemStatus(metric, snapshot) {
  if (metric === 'memory') {
    const m = snapshot.memory || {};
    const swap = m.swap ? `, ${gb(m.swap.freeBytes)} swap free` : '';
    return `Memory: **${gb(m.freeBytes)} free** of ${gb(m.totalBytes)}${m.usedPercent != null ? ` (${m.usedPercent}% used)` : ''}${swap}.`;
  }
  if (metric === 'disk') {
    const disks = snapshot.disks || [];
    const main = disks.find((d) => d.mount === '/System/Volumes/Data') || disks.find((d) => d.mount === '/') || disks[0];
    if (!main) return 'No storage information available.';
    return `Storage (${main.filesystem || main.mount}): **${gb(main.availableBytes)} free** of ${gb(main.totalBytes)}${main.usedPercent != null ? ` (${main.usedPercent}% used)` : ''}.`;
  }
  if (metric === 'battery') {
    const b = snapshot.battery;
    if (!b || b.percent == null) return 'No battery reported (desktop Mac).';
    const state = b.state ? ` (${b.state})` : '';
    const left = b.minutesRemaining ? `, about ${Math.floor(b.minutesRemaining / 60)}h ${b.minutesRemaining % 60}m remaining` : '';
    return `Battery: **${b.percent}%**${state}${left}.`;
  }
  if (metric === 'uptime') {
    const up = snapshot.uptimeSeconds;
    if (up == null) return 'Uptime unavailable.';
    const days = Math.floor(up / 86400);
    const hours = Math.floor((up % 86400) / 3600);
    const mins = Math.floor((up % 3600) / 60);
    const since = new Date(Date.now() - up * 1000).toLocaleString();
    return `Up **${days}d ${hours}h ${mins}m** (since ${since}).`;
  }
  if (metric === 'processes' || metric === 'top_cpu' || metric === 'top_memory') {
    const list = (metric === 'top_memory' ? snapshot.processesByMemory : snapshot.processes) || [];
    if (!list.length) return 'No process information available.';
    const label =
      metric === 'top_memory' ? 'Top memory users' : metric === 'top_cpu' ? 'Top CPU users' : 'Top processes by CPU';
    const rows = list
      .slice(0, 5)
      .map((p) => `- ${p.command}: ${p.cpuPercent ?? '?'}% CPU, ${p.memPercent ?? '?'}% RAM`);
    return `${label}:\n${rows.join('\n')}`;
  }
  return null;
}

/**
 * Answer a direct system-status question on device, or return null to let the
 * model handle it.
 * @param {string} message
 * @returns {Promise<{ answer: string } | null>}
 */
export async function answerDirectSystemStatus(message) {
  const t = String(message || '').toLowerCase().trim().replace(/[.!?]+$/, '');
  if (!HOW_TO_RE.test(t) && !DIAGNOSTIC_RE.test(t)) {
    const onDemand = detectOnDemandLookup(t);
    if (onDemand) {
      const answer = await lookupSystemValue(onDemand);
      if (answer) return { answer };
    }
  }
  const metric = detectSystemStatusMetric(message);
  if (!metric) return null;
  const snapshot = await collectSystemMetrics({ sampleMs: 0 }).catch(() => null);
  if (!snapshot) return null;
  const answer = formatSystemStatus(metric, snapshot);
  return answer ? { answer } : null;
}

// Weather is another common single lookup that shouldn't wait on the slow local
// model. Detection stays conservative: local weather only — a named place
// ("in London") needs geocoding, so that falls to the model.
const WEATHER_RE = /\b(weather|forecast|temperature outside|how (?:hot|cold|warm)|rain|raining|sunny|umbrella|jacket)\b/i;
const SYSTEM_WORD_RE = /\b(cpu|gpu|ram|memory|disk|storage|battery|server|hardware|component)\b/i;
const PLACE_RE =
  /\b(?:in|for|at|near|around|over)\s+(?!my\b|the\b|this\b|our\b|today\b|tomorrow\b|tonight\b|morning\b|afternoon\b|evening\b|night\b|weekend\b)[a-z][a-z-]{1,}/i;

/**
 * @param {string} message
 * @returns {'weather'|null}
 */
export function detectWeatherQuery(message) {
  const t = String(message || '').toLowerCase().trim().replace(/[.!?]+$/, '');
  if (!t || t.length > 80) return null;
  if (DIAGNOSTIC_RE.test(t)) return null;
  if (SYSTEM_WORD_RE.test(t)) return null;
  if (!WEATHER_RE.test(t)) return null;
  if (PLACE_RE.test(t)) return null;
  return 'weather';
}

/**
 * @param {object} w a weatherSummary() result
 * @returns {string|null}
 */
export function formatWeather(w) {
  if (!w || !w.ok || w.temp == null) return null;
  const where = w.city ? ` in ${w.city}` : '';
  const feels = w.feelsLike != null ? `, feels like ${w.feelsLike}°` : '';
  const hiLo = w.high != null ? `, high ${w.high}°${w.low != null ? ` / low ${w.low}°` : ''}` : '';
  const wind = w.wind != null ? `, wind ${w.wind} km/h` : '';
  return `${w.icon || ''} **${w.temp}°C**${where} — ${w.description}${feels}${hiLo}${wind}.`;
}

/**
 * Answer a direct local-weather question on device, or return null to let the
 * model handle it (including named-place lookups, which need geocoding).
 * @param {string} message
 * @returns {Promise<{ answer: string } | null>}
 */
export async function answerDirectWeather(message) {
  if (detectWeatherQuery(message) !== 'weather') return null;
  const w = await weatherSummary().catch(() => null);
  const answer = w && w.ok ? formatWeather(w) : null;
  return answer ? { answer } : null;
}
