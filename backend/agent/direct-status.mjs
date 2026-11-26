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
import { collectSystemMetrics } from '../system-monitor.mjs';

const DIAGNOSTIC_RE =
  /\b(why|how come|slow|sluggish|fix|speed|clean|free up|close|quit|kill|increase|reduce|optimize|draining|drain|improve|better|should|best|make|cause|reason)\b/i;

/**
 * @param {string} message
 * @returns {'memory'|'disk'|'battery'|'uptime'|null} which metric a direct question asks for
 */
export function detectSystemStatusMetric(message) {
  const t = String(message || '').toLowerCase().trim().replace(/[.!?]+$/, '');
  if (!t || t.length > 80) return null;
  if (DIAGNOSTIC_RE.test(t)) return null;

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
  return null;
}

function gb(bytes) {
  return bytes == null ? 'an unknown amount' : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * @param {'memory'|'disk'|'battery'|'uptime'} metric
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
  return null;
}

/**
 * Answer a direct system-status question on device, or return null to let the
 * model handle it.
 * @param {string} message
 * @returns {Promise<{ answer: string } | null>}
 */
export async function answerDirectSystemStatus(message) {
  const metric = detectSystemStatusMetric(message);
  if (!metric) return null;
  const snapshot = await collectSystemMetrics({ sampleMs: 0 }).catch(() => null);
  if (!snapshot) return null;
  const answer = formatSystemStatus(metric, snapshot);
  return answer ? { answer } : null;
}
