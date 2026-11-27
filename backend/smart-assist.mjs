/**
 * Smart Assist: a proactive suggestion engine.
 *
 * The dashboard shows more than raw numbers — it infers what the user is likely
 * to want next (organise Downloads, free up space, summarise the inbox, read the
 * morning brief) and offers each as a one-tap action. Suggestions are derived
 * deterministically from the live system state so they are instant, testable and
 * never require a model round-trip. A lightweight dismissal memory stops the
 * engine from re-nagging about something the user has already waved off.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Suggestion tone → the UI's visual weight. */
export const TONES = ['urgent', 'warn', 'info', 'calm'];

function suggestion(entry) {
  return {
    kind: 'action',
    tone: 'info',
    priority: 50,
    ...entry,
  };
}

/** Use the same preferred volume as the dashboard's storage tile. */
export function storageFreePercentFromMetrics(metrics) {
  const disks = metrics?.disks || [];
  const disk = disks.find((d) => d.mount === '/System/Volumes/Data') || disks.find((d) => d.mount === '/') || disks[0];
  const usedPercent = Number(disk?.usedPercent);
  return Number.isFinite(usedPercent) ? Math.max(0, 100 - usedPercent) : null;
}

/**
 * Derive prioritised suggestions from a system-state snapshot. Every field is
 * optional; a rule only fires when its inputs are present, so callers can pass
 * whatever they have without inventing numbers.
 *
 * @param {object} state hourOfDay, storageFreePercent, storageTotalGB,
 *   downloadsCount, emailCount, scheduledToday, monthNetworkGB, topApp etc.
 * @returns {Array<{id,kind,title,detail,action?,actionLabel?,priority,tone}>}
 */
export function suggestActions(state = {}) {
  const {
    hourOfDay = null,
    storageFreePercent = null,
    downloadsCount = null,
    emailCount = null,
    scheduledToday = null,
    monthNetworkGB = null,
    topApp = null,
    memoryUsedPercent = null,
    swapUsedGB = null,
  } = state;
  const out = [];

  // Storage pressure is the most actionable signal — act on it first.
  if (storageFreePercent != null) {
    if (storageFreePercent < 10) {
      out.push(suggestion({
        id: 'free-space', tone: 'urgent', priority: 100,
        title: `Storage is almost full (${storageFreePercent.toFixed(0)}% free)`,
        detail: 'Large files and old downloads are the fastest wins.',
        action: 'Find the largest files on my disk and tell me what is safe to remove.',
        actionLabel: 'Free up space',
      }));
    } else if (storageFreePercent < 25) {
      out.push(suggestion({
        id: 'tidy-storage', tone: 'warn', priority: 62,
        title: `Storage is getting tight (${storageFreePercent.toFixed(0)}% free)`,
        detail: 'A quick clean-up keeps things running smoothly.',
        action: 'Show me the biggest files and folders I could archive or delete.',
        actionLabel: 'Review storage',
      }));
    }
  }

  // Memory pressure slows everything down — especially the local AI model, which
  // needs gigabytes of free RAM to run instead of swapping to disk. Surfacing it
  // is the single biggest lever on why answers feel slow.
  if (memoryUsedPercent != null) {
    const swapGB = Number(swapUsedGB) || 0;
    const swapping = swapGB > 1;
    const critical = memoryUsedPercent >= 90;
    const usedTight = memoryUsedPercent >= 80 && swapping;
    // Swap this deep means the machine has been thrashing — worth surfacing even after
    // used% recovers below 80. Frame the message around whichever signal actually fired.
    if (critical || usedTight || swapGB >= 3) {
      const current = critical || usedTight;
      out.push(suggestion({
        id: 'free-ram',
        tone: critical ? 'urgent' : 'warn',
        priority: 92,
        title: current ? `Memory is tight (${memoryUsedPercent.toFixed(0)}% used)` : `Recent memory crunch (${swapGB.toFixed(1)} GB in swap)`,
        detail: current
          ? swapping
            ? `About ${swapGB.toFixed(1)} GB is spilling to disk, so apps — including the local AI model — run slowly.`
            : 'Closing a big app will make everything snappier, including the local AI.'
          : `The Mac recently ran short on memory and pushed ${swapGB.toFixed(1)} GB to disk, so apps crawled. Closing a big app keeps the local AI at full speed.`,
        action: 'Show me what is using my memory right now.',
        actionLabel: 'See memory hogs',
      }));
    }
  }

  // A cluttered Downloads folder is a classic, cheap win.
  if (downloadsCount != null && downloadsCount > 10) {
    out.push(suggestion({
      id: 'organize-downloads', tone: 'info', priority: 72,
      title: `${downloadsCount} files in Downloads`,
      detail: 'Sort them into tidy folders automatically.',
      action: 'Organize my Downloads folder into categories.',
      actionLabel: 'Organize',
    }));
  }

  // Inbox: a big backlog invites a digest; a small one is just informational.
  if (emailCount != null && emailCount >= 8) {
    out.push(suggestion({
      id: 'summarize-inbox', tone: 'info', priority: 68,
      title: `${emailCount} new emails`,
      detail: 'Get a one-line digest of what actually needs you.',
      action: 'Summarize my unread emails and flag anything urgent.',
      actionLabel: 'Summarize',
    }));
  } else if (emailCount != null && emailCount > 0) {
    out.push(suggestion({
      id: 'inbox-glance', kind: 'insight', tone: 'calm', priority: 38,
      title: `${emailCount} new email${emailCount === 1 ? '' : 's'} since your last look`,
      detail: 'Nothing overwhelming — a glance should do.',
    }));
  }

  // Today's automations — surface what LocalGravity will run for them.
  if (scheduledToday != null && scheduledToday > 0) {
    out.push(suggestion({
      id: 'review-schedule', kind: 'insight', tone: 'calm', priority: 34,
      title: `${scheduledToday} scheduled task${scheduledToday === 1 ? '' : 's'} today`,
      detail: 'Your automations will run on their own — review them any time.',
    }));
  }

  // Time-of-day framing turns the same state into the right nudge.
  if (hourOfDay != null && hourOfDay >= 5 && hourOfDay < 11) {
    out.push(suggestion({
      id: 'daily-brief', tone: 'info', priority: 58,
      title: 'Start the day informed',
      detail: 'Your briefing pulls together the news, inbox and weather.',
      action: 'Give me my daily briefing.',
      actionLabel: 'Read brief',
    }));
  } else if (hourOfDay != null && hourOfDay >= 18 && hourOfDay < 23) {
    out.push(suggestion({
      id: 'wrap-up', tone: 'calm', priority: 36,
      title: 'Wrap up the day',
      detail: 'A quick recap and a nudge at tomorrow.',
      action: 'Summarise what I did today and suggest what to tackle tomorrow.',
      actionLabel: 'Wrap up',
    }));
  }

  // One app running away with the data allowance beats a generic monthly total.
  const topAppBytes = Number(topApp?.total) || 0;
  if (topApp?.name && topAppBytes >= 5 * 1024 ** 3) {
    const gb = topAppBytes / 1024 ** 3;
    out.push(suggestion({
      id: 'data-hog', tone: 'warn', priority: 64,
      title: `${topApp.name} used ${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB this month`,
      detail: 'The busiest app on your network — worth a look if data matters to you.',
      action: 'Show me which apps are using the most network data this month and how I could limit them.',
      actionLabel: 'Review data',
    }));
  }

  // Heavy network use this month is worth flagging (a real insight, not an action).
  if (monthNetworkGB != null && monthNetworkGB >= 20) {
    out.push(suggestion({
      id: 'network-insight', kind: 'insight', tone: 'calm', priority: 30,
      title: `${monthNetworkGB.toFixed(0)} GB used this month`,
      detail: 'Run a speed test any time from the network card.',
    }));
  }

  return out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

// --- dismissal memory ------------------------------------------------------

function dismissedFile(paths) {
  return path.join(paths.root ?? process.env.LOCALGRAVITY_HOME ?? path.join(process.env.HOME ?? '.', '.localgravity'), 'smart-assist-dismissed.json');
}

export async function loadDismissed(paths) {
  try {
    const raw = await fs.readFile(dismissedFile(paths), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const dismissalWrites = new Map();

export async function dismissSuggestion(paths, id) {
  const file = dismissedFile(paths);
  const previous = dismissalWrites.get(file) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const dismissed = await loadDismissed(paths);
    dismissed[id] = Date.now();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(dismissed), 'utf8');
    return dismissed;
  });
  dismissalWrites.set(file, write);
  try {
    return await write;
  } finally {
    if (dismissalWrites.get(file) === write) dismissalWrites.delete(file);
  }
}

/** Drop suggestions the user has dismissed within the last {@link windowMs}. */
export function filterDismissed(suggestions, dismissed = {}, { windowMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const now = Date.now();
  return suggestions.filter((s) => {
    const at = dismissed[s.id];
    const timestamp = typeof at === 'number' ? at : Number.NaN;
    return !Number.isFinite(timestamp) || timestamp > now || now - timestamp > windowMs;
  });
}

/**
 * Build the final suggestion list: derive from state, remove recently
 * dismissed items, cap to the most useful few for the dashboard.
 */
export function buildSuggestions(state, dismissed = {}, { limit = 4, windowMs } = {}) {
  return filterDismissed(suggestActions(state), dismissed, { windowMs }).slice(0, limit);
}
