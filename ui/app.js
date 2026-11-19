import { apiRequest, hasSwiftBridge, postSwiftAction, setAuthToken, streamSse } from './lib/api.js';
import { escapeHtml, renderMarkdown } from './lib/markdown.js';
import { shouldRenderStreamingMarkdown } from './lib/streaming.js';
import { buildPaletteItems } from './lib/palette.js';
import {
  formatClockDate,
  formatClockTime,
  formatMinutesUntil,
  formatUptime,
  greetingFor,
  nextEntryFrom,
  usageTone,
} from './lib/dashboard.js';

const SIDEBAR_STORAGE_KEY = 'lg-sidebar-collapsed';

const state = {
  view: 'dashboard',
  sidebarCollapsed: false,
  subtab: 'skills',
  health: null,
  config: null,
  configuredKeys: {},
  presets: {},
  sessions: [],
  sessionSearchQuery: '',
  activeSession: null,
  skills: [],
  knowledge: [],
  automations: [],
  attachments: [],
  isRunning: false,
  runningSessionId: null,
  runAbort: null,
  runStartedAt: 0,
  timerHandle: null,
  rafPending: false,
  queuedMessages: [],
  liveAssistantMsg: null,
  displayedItems: [],
  pendingApprovals: new Map(),
  contextTokens: 0,
  paletteOpen: false,
  paletteItems: [],
  paletteIndex: 0,
  metrics: null,
  monitorProcessSort: 'cpu',
  scheduleFormMode: 'weekly',
  schedule: [],
  scheduleToday: [],
  monitorTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showToast(msg) {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function formatRelativeTime(value) {
  if (!value) return '';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function setSidebarCollapsed(collapsed, persist = true) {
  state.sidebarCollapsed = Boolean(collapsed);
  const shell = $('#app-shell');
  const sidebar = $('.sidebar');
  const btn = $('#sidebar-toggle');
  if (shell) shell.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  if (sidebar) sidebar.inert = state.sidebarCollapsed;
  if (btn) {
    btn.setAttribute('aria-expanded', String(!state.sidebarCollapsed));
    btn.title = `${state.sidebarCollapsed ? 'Show' : 'Hide'} sidebar (⌘\\)`;
  }
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, state.sidebarCollapsed ? '1' : '0');
    } catch {
      // Storage can be unavailable; the in-memory state still works.
    }
  }
}

function toggleSidebar() {
  setSidebarCollapsed(!state.sidebarCollapsed);
}

function estimateTokens(messages = []) {
  let total = 0;
  for (const msg of messages) {
    total += 8;
    if (typeof msg.content === 'string') total += Math.ceil(msg.content.length / 3.5);
    if (typeof msg.thinking === 'string') total += Math.ceil(msg.thinking.length / 3.5);
    if (Array.isArray(msg.toolCalls)) total += Math.ceil(JSON.stringify(msg.toolCalls).length / 3.5);
    if (Array.isArray(msg.images)) total += msg.images.length * 768;
  }
  return total;
}

function updateContextMeter(tokens, numCtx) {
  const limit = Number(numCtx) || Number(state.config?.numCtx) || 8192;
  const safeTokens = Math.max(0, Number(tokens) || 0);
  const pct = Math.min(100, Math.round((safeTokens / limit) * 100));
  const label = $('#context-label');
  const percent = $('#context-percent');
  const fill = $('#context-fill');
  const meter = $('#context-meter');
  if (label) label.textContent = `${(safeTokens / 1000).toFixed(1)}k / ${Math.round(limit / 1000)}k`;
  if (percent) percent.textContent = `${pct}%`;
  if (fill) {
    fill.style.width = `${pct}%`;
    fill.className = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  }
  if (meter) {
    meter.setAttribute('aria-valuenow', String(pct));
    meter.title = `${pct}% of ${limit.toLocaleString()} token context used (estimated)`;
  }
}

// Swift native bridges
window.__lgSetToken = (token) => setAuthToken(token);
window.__lgFileSaved = (savedPath) => {
  const base = String(savedPath || '').split('/').pop() || 'file';
  showToast(`Saved ${base}`);
};
window.__lgReceiveFiles = async (filePaths) => {
  if (!Array.isArray(filePaths)) return;
  for (const fp of filePaths) {
    if (!fp || state.attachments.some((a) => a.path === fp)) continue;
    const ext = fp.split('.').pop()?.toLowerCase() || '';
    const isImage = ['png', 'jpg', 'jpeg', 'webp', 'heic', 'gif', 'mp4', 'mov'].includes(ext);
    const item = { path: fp, name: fp.split('/').pop() || fp, previewUrl: null };
    state.attachments.push(item);
    renderAttachments();
    if (isImage) {
      try {
        const res = await apiRequest(`/api/media/preview?path=${encodeURIComponent(fp)}`);
        item.previewUrl = res.dataUrl;
        renderAttachments();
      } catch {
        // Non-visual or unreadable preview is okay
      }
    }
  }
};

function switchView(viewName) {
  state.view = viewName;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === viewName));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${viewName}`));
  $('#sidebar-expand-fab')?.classList.toggle('visible-outside-agent', viewName !== 'agent');
  if (viewName === 'dashboard') {
    renderDashboard();
    refreshSystemMetrics();
    loadSchedule();
  } else if (viewName === 'monitor') {
    renderMonitor();
    refreshSystemMetrics();
  } else if (viewName === 'schedule') {
    loadSchedule();
  } else if (viewName === 'skills') {
    loadSkills();
    loadKnowledge();
  } else if (viewName === 'automations') {
    loadAutomations();
  } else if (viewName === 'settings') {
    refreshHealth();
  }
  updateMonitorAutoRefresh();
}

// ---- Dashboard, System Monitor, and Timetable ----

function tickClock() {
  const clockEl = $('#dash-clock');
  if (!clockEl) return;
  const now = new Date();
  clockEl.textContent = formatClockTime(now);
  $('#dash-date').textContent = formatClockDate(now);
  $('#dash-greeting').textContent = greetingFor(now);
}

function setUsageBar(barId, valueId, percent, valueLabel) {
  const bar = $(barId);
  const label = $(valueId);
  const p = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : null;
  if (bar) {
    bar.style.width = p === null ? '0%' : `${p}%`;
    bar.dataset.tone = p === null ? 'ok' : usageTone(p);
  }
  if (label) label.textContent = valueLabel ?? (p === null ? '—' : `${Math.round(p)}%`);
}

function topDisk(metrics) {
  const disks = metrics?.disks || [];
  return disks.find((d) => d.mount === '/System/Volumes/Data') || disks.find((d) => d.mount === '/') || disks[0] || null;
}

function renderDashboard() {
  const metrics = state.metrics;
  const mem = metrics?.memory || {};
  const gpu = metrics?.gpu;
  const disk = topDisk(metrics);
  setUsageBar('#dash-cpu-bar', '#dash-cpu', metrics?.cpu?.percent);
  setUsageBar(
    '#dash-mem-bar',
    '#dash-mem',
    mem.usedPercent,
    mem.totalBytes ? `${formatBytes(mem.usedBytes || 0)} / ${formatBytes(mem.totalBytes)}` : '—'
  );
  setUsageBar('#dash-gpu-bar', '#dash-gpu', gpu?.utilizationPercent, gpu ? (gpu.utilizationPercent === null ? 'n/a' : `${gpu.utilizationPercent}%`) : '—');
  setUsageBar(
    '#dash-disk-bar',
    '#dash-disk',
    disk?.usedPercent,
    disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}` : '—'
  );

  const now = new Date();
  const next = nextEntryFrom(state.scheduleToday, now);
  const remaining = state.scheduleToday.filter((e) => e.startMinutes + (e.durationMin || 0) > now.getHours() * 60 + now.getMinutes()).length;
  const summary = $('#dash-summary');
  if (summary) {
    summary.textContent = next
      ? `${remaining} item${remaining === 1 ? '' : 's'} left today · ${next.inProgress ? `now: ${next.entry.title}` : `next: ${next.entry.title} ${formatMinutesUntil(next.minutesUntil)}`}`
      : `${remaining} item${remaining === 1 ? '' : 's'} left today · nothing else scheduled`;
  }

  const snapshot = $('#dash-snapshot');
  if (snapshot) {
    const parts = [];
    if (metrics?.uptimeSeconds != null) parts.push(`Uptime ${formatUptime(metrics.uptimeSeconds)}`);
    if (metrics?.loadAvg) parts.push(`Load ${metrics.loadAvg.join(' / ')}`);
    if (metrics?.cpu?.cores) parts.push(`${metrics.cpu.cores} cores`);
    if (metrics?.battery?.percent != null) {
      parts.push(
        `Battery ${metrics.battery.percent}%${metrics.battery.state ? ` ${metrics.battery.state}` : ''}`
      );
    }
    const top = metrics?.processes?.[0];
    if (top) parts.push(`Busiest: ${top.command} (${top.cpuPercent}%)`);
    if (metrics?.memory?.swap?.usedBytes > 0) {
      parts.push(`Swap ${formatBytes(metrics.memory.swap.usedBytes)} / ${formatBytes(metrics.memory.swap.totalBytes)}`);
    }
    snapshot.textContent = parts.join(' · ') || 'Snapshot unavailable.';
  }

  const runtimeEl = $('#dash-runtime-summary');
  const unloadBtn = $('#dash-unload-ram-btn');
  if (runtimeEl) {
    const running = state.health?.ollama?.runningModels || [];
    const activeLabel = `${state.config?.model || 'qwen3.5:4b'} (${(state.config?.provider || 'ollama') === 'ollama' ? 'Local' : state.config?.provider})`;
    const thinkLabel = state.config?.thinking ? 'Deep Think On' : 'Fast mode';
    if (running.length > 0) {
      const totalVram = running.reduce((acc, m) => acc + (m.sizeVram || m.size || 0), 0);
      runtimeEl.textContent = `Active: ${activeLabel} · ${thinkLabel} · Loaded in GPU: ${running.map((m) => m.name).join(', ')} (${formatBytes(totalVram)})`;
      unloadBtn?.classList.remove('hidden');
    } else if (state.health?.ollama?.running) {
      runtimeEl.textContent = `Active: ${activeLabel} · ${thinkLabel} · Ollama idle (0 B GPU RAM used)`;
      unloadBtn?.classList.add('hidden');
    } else {
      runtimeEl.textContent = `Active: ${activeLabel} · Ollama stopped (auto-starts on your first local task)`;
      unloadBtn?.classList.add('hidden');
    }
  }
  renderAgenda();
}

function renderAgenda() {
  const list = $('#dash-agenda');
  if (!list) return;
  const items = state.scheduleToday || [];
  if (items.length === 0) {
    list.innerHTML = '<li class="agenda-empty">Nothing scheduled today. Add blocks in the Timetable.</li>';
    return;
  }
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  list.innerHTML = items
    .map((e) => {
      const end = e.startMinutes + (e.durationMin || 0);
      const done = currentMinutes >= end;
      const active = currentMinutes >= e.startMinutes && currentMinutes < end;
      return `<li class="agenda-item${active ? ' active' : ''}${done ? ' done' : ''}">
        <span class="agenda-time">${escapeHtml(e.time)}</span>
        <span class="agenda-title">${escapeHtml(e.title)}</span>
        <span class="agenda-meta">${escapeHtml(String(e.durationMin || 30))} min</span>
      </li>`;
    })
    .join('');
}

function renderMonitor() {
  const metrics = state.metrics;
  if (!metrics) return;
  const mem = metrics.memory || {};
  const gpu = metrics.gpu;
  const disk = topDisk(metrics);
  setUsageBar('#mon-cpu-bar', '#mon-cpu', metrics.cpu?.percent, metrics.cpu?.percent == null ? '—' : `${metrics.cpu.percent}%`);
  setUsageBar(
    '#mon-mem-bar',
    '#mon-mem',
    mem.usedPercent,
    mem.totalBytes ? `${formatBytes(mem.usedBytes || 0)} / ${formatBytes(mem.totalBytes)}` : '—'
  );
  setUsageBar('#mon-gpu-bar', '#mon-gpu', gpu?.utilizationPercent, gpu ? (gpu.utilizationPercent === null ? 'n/a' : `${gpu.utilizationPercent}%`) : '—');
  setUsageBar(
    '#mon-disk-bar',
    '#mon-disk',
    disk?.usedPercent,
    disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}` : '—'
  );

  const details = $('#monitor-details');
  const runningModels = state.health?.ollama?.runningModels || [];
  const totalVram = runningModels.reduce((acc, m) => acc + (m.sizeVram || m.size || 0), 0);
  if (details) {
    const rows = [
      ['CPU cores', metrics.cpu?.cores ? String(metrics.cpu.cores) : '—'],
      ['Load average', metrics.loadAvg ? metrics.loadAvg.join(' / ') : '—'],
      ['Uptime', metrics.uptimeSeconds != null ? formatUptime(metrics.uptimeSeconds) : '—'],
      ['Wired memory', mem.wiredBytes != null ? formatBytes(mem.wiredBytes) : '—'],
      ['Compressed memory', mem.compressedBytes != null ? formatBytes(mem.compressedBytes) : '—'],
      [
        'Swap memory',
        mem.swap && mem.swap.totalBytes > 0
          ? `${formatBytes(mem.swap.usedBytes)} / ${formatBytes(mem.swap.totalBytes)} (${mem.swap.usedPercent}%)`
          : '0 B (no swap pressure)',
      ],
      ['GPU', gpu ? `${gpu.name}${gpu.inUseMemoryBytes ? ` · ${formatBytes(gpu.inUseMemoryBytes)} in use` : ''}` : 'No GPU stats exposed'],
      [
        'Ollama GPU RAM',
        runningModels.length > 0
          ? `${runningModels.map((m) => m.name).join(', ')} (${formatBytes(totalVram)})`
          : 'None loaded',
      ],
    ];
    if (metrics.battery) {
      const b = metrics.battery;
      const est =
        b.minutesRemaining == null || b.minutesRemaining === 0
          ? ''
          : ` · ${Math.floor(b.minutesRemaining / 60)}h ${b.minutesRemaining % 60}m ${b.state === 'discharging' ? 'left' : 'to full'}`;
      rows.splice(3, 0, [
        'Battery',
        `${b.percent ?? '—'}%${b.state ? ` · ${b.state}` : ''}${est}${b.powerSource ? ` · ${b.powerSource}` : ''}`,
      ]);
    }
    details.innerHTML = rows
      .map(([k, v]) => `<div class="detail-row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
      .join('');
  }

  $('#monitor-unload-btn')?.classList.toggle('hidden', runningModels.length === 0);
  const alertEl = $('#monitor-memory-alert');
  if (alertEl) {
    const highSwap = (mem.swap?.usedBytes || 0) >= 2 * 1024 ** 3;
    const highMem = (mem.usedPercent || 0) >= 85;
    if (runningModels.length > 0 && (highSwap || highMem)) {
      alertEl.textContent = `High memory pressure (${mem.usedPercent ?? '?'}% RAM${highSwap ? `, ${formatBytes(mem.swap.usedBytes)} swap` : ''}) while ${runningModels.map((m) => m.name).join(', ')} is loaded (${formatBytes(totalVram)}). Click "Free Ollama RAM" to reclaim memory immediately.`;
      alertEl.classList.remove('hidden');
    } else {
      alertEl.classList.add('hidden');
    }
  }

  const disksBody = $('#monitor-disks');
  if (disksBody) {
    disksBody.innerHTML = (metrics.disks || [])
      .map(
        (d) => `<tr>
          <td>${escapeHtml(d.mount)}</td>
          <td>${formatBytes(d.usedBytes)}</td>
          <td>${formatBytes(d.availableBytes)}</td>
          <td><span class="usage-pill" data-tone="${usageTone(d.usedPercent)}">${d.usedPercent}%</span></td>
        </tr>`
      )
      .join('') || '<tr><td colspan="4">No volumes reported.</td></tr>';
  }

  const procsBody = $('#monitor-processes');
  if (procsBody) {
    const procList =
      state.monitorProcessSort === 'memory' && Array.isArray(metrics.processesByMemory)
        ? metrics.processesByMemory
        : metrics.processes || [];
    procsBody.innerHTML = procList
      .map(
        (p) => `<tr>
          <td>${escapeHtml(p.command)}</td>
          <td>${p.pid}</td>
          <td><span class="usage-pill" data-tone="${usageTone(p.cpuPercent)}">${p.cpuPercent}</span></td>
          <td>${p.memPercent}</td>
          <td>${formatBytes(p.rssBytes)}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="5">No processes reported.</td></tr>';
  }

  const updated = $('#monitor-updated');
  if (updated) updated.textContent = `Updated ${new Date(metrics.timestamp).toLocaleTimeString()} · samples refresh every 4 s`;
}

async function refreshSystemMetrics() {
  try {
    const data = await apiRequest('/api/system/metrics');
    state.metrics = data.metrics || null;
    if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'monitor') renderMonitor();
  } catch {
    // Keep the last snapshot; the next tick retries.
  }
}

function updateMonitorAutoRefresh() {
  const shouldRun =
    (state.view === 'dashboard' || state.view === 'monitor') &&
    (state.view !== 'monitor' || $('#monitor-autorefresh')?.checked !== false);
  if (shouldRun && !state.monitorTimer) {
    state.monitorTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshSystemMetrics();
    }, 4000);
  } else if (!shouldRun && state.monitorTimer) {
    clearInterval(state.monitorTimer);
    state.monitorTimer = null;
  }
}

function renderScheduleWeek() {
  const host = $('#schedule-week');
  if (!host) return;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const today = new Date().getDay();
  const entries = state.schedule || [];
  const oneOffs = entries
    .filter((e) => e.date)
    .sort((a, b) => String(a.date + a.time).localeCompare(String(b.date + b.time)));
  const oneOffHtml = oneOffs.length
    ? `<div class="week-day week-oneoffs">
        <div class="week-day-name">One-offs &amp; reminders</div>
        <ul class="week-list">${oneOffs
          .map(
            (e) => `<li class="week-item${e.enabled === false ? ' disabled' : ''}">
              <div class="week-item-top">
                <span class="agenda-time">${escapeHtml(e.time)}</span>
                <span class="agenda-meta">${escapeHtml(String(e.date))}</span>
                <button type="button" class="icon-btn week-delete" data-id="${escapeHtml(e.id)}" title="Delete entry" aria-label="Delete ${escapeHtml(e.title)}">×</button>
              </div>
              <div class="week-item-title" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</div>
            </li>`
          )
          .join('')}</ul>
      </div>`
    : '';
  host.innerHTML =
    order
    .map((day) => {
      const dayEntries = entries
        .filter((e) => Array.isArray(e.days) && e.days.includes(day))
        .sort((a, b) => String(a.time).localeCompare(String(b.time)));
      const items = dayEntries
        .map(
          (e) => `<li class="week-item${e.enabled === false ? ' disabled' : ''}">
            <div class="week-item-top">
              <span class="agenda-time">${escapeHtml(e.time)}</span>
              <span class="agenda-meta">${escapeHtml(String(e.durationMin || 30))}m</span>
              <button type="button" class="icon-btn week-delete" data-id="${escapeHtml(e.id)}" title="Delete entry" aria-label="Delete ${escapeHtml(e.title)}">×</button>
            </div>
            <div class="week-item-title" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</div>
          </li>`
        )
        .join('') || '<li class="agenda-empty">Nothing</li>';
      return `<div class="week-day${day === today ? ' today' : ''}">
        <div class="week-day-name">${names[day]}${day === today ? ' · today' : ''}</div>
        <ul class="week-list">${items}</ul>
      </div>`;
    })
    .join('') + oneOffHtml;
}

async function loadSchedule() {
  try {
    const data = await apiRequest('/api/schedule');
    state.schedule = data.entries || [];
    state.scheduleToday = data.today || [];
    renderAgenda();
    renderDashboard();
    renderScheduleWeek();
  } catch {
    // Keep the last known schedule; the next view switch retries.
  }
}

function updateHeaderControls() {
  if (!state.config) return;
  const prov = state.config.provider || 'ollama';
  const model = state.config.model || 'qwen3.5:4b';
  const provLabel = prov === 'ollama' ? 'Local' : state.presets?.[prov]?.label?.split(' ')[0] || prov;
  $('#active-model-label').textContent = `${model} (${provLabel})`;

  const thinkBtn = $('#thinking-toggle');
  thinkBtn.classList.toggle('active', Boolean(state.config.thinking));
  thinkBtn.textContent = `Deep Think: ${state.config.thinking ? 'On' : 'Off'}`;

  const safetyBtn = $('#safety-toggle');
  const isAuto = state.config.safetyMode === 'auto';
  safetyBtn.classList.toggle('warn', isAuto);
  safetyBtn.textContent = `Safety: ${isAuto ? 'Auto' : 'Ask'}`;

  const ctxLimit = state.config.numCtx || 8192;
  const ctxSelect = $('#num-ctx-select');
  if (ctxSelect) ctxSelect.value = String(ctxLimit);
  const agendaOnEl = $('#agenda-notifications');
  if (agendaOnEl) agendaOnEl.checked = state.config.agendaNotifications !== false;
  const agendaLeadEl = $('#agenda-lead');
  if (agendaLeadEl) agendaLeadEl.value = String(state.config.agendaLeadMinutes ?? 5);
  const estimatedTokens = state.contextTokens || estimateTokens(state.activeSession?.messages || []);
  updateContextMeter(estimatedTokens, ctxLimit);
}

function renderSidebarStatus() {
  if (!state.health) return;
  const { system, ollama } = state.health;
  $('#sidebar-chip-label').textContent = `${system.arch === 'arm64' ? 'Apple M-Series' : system.arch} · ${system.totalRamGb} GB`;

  const dot = $('#ollama-dot');
  const txt = $('#ollama-status-text');
  if (ollama?.running) {
    dot.className = 'status-dot online';
    const count = ollama.models.length;
    txt.textContent = `Ollama ready (${count} ${count === 1 ? 'model' : 'models'})`;
  } else {
    dot.className = 'status-dot offline';
    txt.textContent = system.tools?.ollama ? 'Ollama stopped' : 'Ollama not installed';
  }
  $('#disk-status-text').textContent =
    system.freeDiskGb !== null ? `SSD: ${system.freeDiskGb} GB free` : 'Disk info unavailable';
}

function renderSessionsList() {
  const q = ($('#session-search').value || '').toLowerCase().trim();
  const listEl = $('#sessions-list');
  const searchMode = Boolean(state.sessionSearchQuery);
  const filtered = searchMode
    ? state.sessions
    : state.sessions.filter((s) => !q || (s.title || '').toLowerCase().includes(q));

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="status-sub" style="padding: 8px;">${
      searchMode ? 'No matching conversations' : 'No tasks yet'
    }</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map(
      (s) => `
      <div class="session-item ${state.activeSession?.id === s.id ? 'active' : ''}" data-id="${escapeHtml(s.id)}">
        ${state.isRunning && state.runningSessionId === s.id ? '<span class="session-running-dot" title="Running"></span>' : ''}
        <span class="session-title-wrap">
          <span class="session-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>
          ${s.snippet ? `<span class="session-snippet" title="${escapeHtml(s.snippet)}">${escapeHtml(s.snippet)}</span>` : ''}
        </span>
        ${s.source === 'scheduled' ? '<span class="session-badge">Auto</span>' : ''}
        <span class="session-meta">
          <span class="session-time">${escapeHtml(formatRelativeTime(s.updatedAt))}</span>
          <button type="button" class="session-del-btn" data-del="${escapeHtml(s.id)}" title="Delete session">×</button>
        </span>
      </div>`
    )
    .join('');

  listEl.querySelectorAll('.session-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.session-del-btn')) return;
      openSession(el.dataset.id);
    });
  });
  listEl.querySelectorAll('.session-del-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      await apiRequest(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (state.activeSession?.id === id) {
        state.activeSession = null;
        renderMessages();
      }
      await loadSessions();
    });
  });
}

function renderAttachments() {
  const bar = $('#attachments-bar');
  if (state.attachments.length === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = state.attachments
    .map(
      (a, idx) => `
      <div class="attach-chip">
        ${a.previewUrl ? `<img src="${a.previewUrl}" alt="" />` : ''}
        <span title="${escapeHtml(a.path)}">${escapeHtml(a.name)}</span>
        <button type="button" data-idx="${idx}" aria-label="Remove attachment">×</button>
      </div>`
    )
    .join('');

  bar.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.attachments.splice(Number(btn.dataset.idx), 1);
      renderAttachments();
    });
  });
}

function groupMessagesForDisplay(messages = []) {
  const items = [];
  let currentAssistant = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (msg.isCompactionSummary) {
        items.push({ type: 'compaction', content: msg.content });
      } else {
        currentAssistant = null;
        items.push({ type: 'user', msg });
      }
    } else if (msg.role === 'assistant') {
      if (!currentAssistant) {
        currentAssistant = {
          type: 'assistant',
          thinking: [],
          tools: [],
          content: '',
          plan: null,
          selfImprovedLessons: [],
          isError: false,
        };
        items.push(currentAssistant);
      }
      if (msg.thinking) currentAssistant.thinking.push(msg.thinking);
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          currentAssistant.tools.push({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            status: 'done',
            output: '',
            diff: '',
            images: [],
          });
        }
      }
      if (msg.content) {
        currentAssistant.content += (currentAssistant.content ? '\n\n' : '') + msg.content;
      }
      if (msg.isError) currentAssistant.isError = true;
    } else if (msg.role === 'tool' && currentAssistant) {
      const toolEntry = currentAssistant.tools.find((t) => t.id === msg.toolCallId);
      if (toolEntry) {
        toolEntry.output = msg.content || '';
        toolEntry.diff = msg.diff || '';
        toolEntry.images = msg.images || [];
        if (toolEntry.name === 'update_plan') {
          currentAssistant.plan = parsePlanFromOutput(msg.content || '');
        }
        const out = String(msg.content || '');
        const exitNonZero = /^Exit code:\s*(?!0\b)\d+/m.test(out);
        const failed =
          out.startsWith('Blocked') ||
          out.startsWith('User denied') ||
          out.startsWith('Tool ') ||
          out.startsWith('[Self-Healing Loop Breaker]') ||
          out.includes('failed') ||
          exitNonZero;
        toolEntry.status = failed ? 'fail' : 'ok';
      }
    }
  }
  return items;
}

function parsePlanFromOutput(output) {
  const lines = String(output || '').split('\n');
  const steps = [];
  for (const line of lines) {
    const m = /^\[([x>\s])\]\s*(.+)$/.exec(line.trim());
    if (m) {
      const mark = m[1].trim();
      steps.push({ text: m[2].trim(), status: mark === 'x' ? 'done' : mark === '>' ? 'active' : 'pending' });
    }
  }
  return steps.length > 0 ? steps : null;
}

function buildPlanHtml(item) {
  const plan = item.plan;
  if (!Array.isArray(plan) || plan.length === 0) return '';
  const done = plan.filter((s) => s.status === 'done').length;
  const rows = plan
    .map((s) => {
      const icon = s.status === 'done' ? '&#10003;' : s.status === 'active' ? '&#9679;' : '&#9675;';
      const cls = s.status === 'done' ? 'done' : s.status === 'active' ? 'active' : 'pending';
      return `<li class="plan-step ${cls}"><span class="plan-icon">${icon}</span><span class="plan-text">${escapeHtml(s.text)}</span></li>`;
    })
    .join('');
  return `<div class="plan-panel"><div class="plan-head"><span>Plan</span><span class="plan-progress">${done}/${plan.length}</span></div><ul class="plan-list">${rows}</ul></div>`;
}

function buildToolBodyHtml(tool) {
  const diff = String(tool.diff || '');
  if (diff) {
    const lines = diff.split('\n');
    const shown = lines.slice(0, 140);
    const body = shown
      .map((line) => {
        const cls =
          line.startsWith('+++') || line.startsWith('---')
            ? 'diff-meta'
            : line.startsWith('+')
              ? 'diff-add'
              : line.startsWith('-')
                ? 'diff-del'
                : 'diff-ctx';
        return `<span class="diff-line ${cls}">${escapeHtml(line) || ' '}</span>`;
      })
      .join('');
    const truncated = lines.length > shown.length ? '<span class="diff-line diff-meta">... diff truncated</span>' : '';
    return `<div class="tool-body tool-diff">${body}${truncated}</div>`;
  }

  const output = String(tool.output || '');
  if (output) {
    if (tool.status === 'running' || output.length <= 600) {
      return `<pre class="tool-body">${escapeHtml(output)}</pre>`;
    }
    return `<details class="tool-details"><summary>Output · ${output.split('\n').length} lines</summary><pre class="tool-body">${escapeHtml(output)}</pre></details>`;
  }

  return `<pre class="tool-body">${escapeHtml(JSON.stringify(tool.arguments || {}, null, 2))}</pre>`;
}

function buildToolsHtml(tools = []) {
  return (tools || [])
    .map((t) => {
      const badgeCls = t.status === 'ok' ? 'ok' : t.status === 'fail' ? 'fail' : t.status === 'wait' ? 'wait' : '';
      const badgeLabel =
        t.status === 'ok'
          ? 'Done'
          : t.status === 'fail'
            ? 'Self-Healed / Error'
            : t.status === 'wait'
              ? 'Needs approval'
              : 'Running';
      const durationHtml =
        Number.isFinite(t.durationMs) && t.durationMs > 0
          ? `<span class="tool-duration">${(t.durationMs / 1000).toFixed(1)}s</span>`
          : '';
      const thumbs =
        Array.isArray(t.images) && t.images.length > 0
          ? `<div class="media-thumbs">${t.images
              .map((b64) => `<img class="media-thumb" src="${b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`}" alt="Media preview" />`)
              .join('')}</div>`
          : '';

      let approvalHtml = '';
      if (t.approval) {
        approvalHtml = `
          <div class="approval-panel" data-tool-id="${escapeHtml(t.id)}">
            <div class="approval-reason">${escapeHtml(t.approval.reason || 'Approval required')}</div>
            ${
              t.name === 'run_command'
                ? `<input type="text" class="approval-cmd-edit" data-tool-id="${escapeHtml(t.id)}" value="${escapeHtml(t.approval.editedValue ?? t.approval.preview ?? t.arguments?.command ?? '')}" />`
                : `<pre class="tool-body" style="margin:0;">${escapeHtml(t.approval.preview || '')}</pre>`
            }
            <div class="approval-actions">
              <button type="button" class="primary-btn approve-btn" data-tool-id="${escapeHtml(t.id)}">Approve & Run</button>
              <button type="button" class="danger-btn deny-btn" data-tool-id="${escapeHtml(t.id)}">Deny</button>
            </div>
          </div>`;
      }

      return `
        <div class="tool-card" data-card-tool-id="${escapeHtml(t.id)}">
          <div class="tool-head">
            <span class="tool-name">${escapeHtml(t.name)}</span>
            <span class="tool-head-right">${durationHtml}<span class="tool-badge ${badgeCls}">${badgeLabel}</span></span>
          </div>
          ${buildToolBodyHtml(t)}
          ${thumbs}
          ${approvalHtml}
        </div>`;
    })
    .join('');
}

function buildDisplayItemHtml(item, idx) {
  if (item.type === 'compaction') {
    return `<div class="thinking-box"><details><summary>Compacted earlier context</summary><div class="thinking-content">${escapeHtml(item.content)}</div></details></div>`;
  }
  if (item.type === 'user') {
    const attachTag =
      Array.isArray(item.msg.attachments) && item.msg.attachments.length > 0
        ? `<div style="font-size:11.5px;opacity:0.85;margin-top:4px;">Attached: ${item.msg.attachments.map((p) => escapeHtml(p.split('/').pop())).join(', ')}</div>`
        : '';
    const textOnly = String(item.msg.content || '').replace(/\n\n\[Attached files\][\s\S]*$/, '');
    return `<div class="msg-row"><div class="msg-user">${escapeHtml(textOnly)}${attachTag}</div></div>`;
  }

  const thinkingCombined = (item.thinking || []).join('').trim();
  const thinkingHtml = thinkingCombined
    ? `<details class="thinking-box" ${item.isStreaming && !item.content ? 'open' : ''}><summary>Thinking</summary><div class="thinking-content">${escapeHtml(thinkingCombined)}</div></details>`
    : '';

  const toolsHtml = buildToolsHtml(item.tools);

  const selfImprovedHtml =
    Array.isArray(item.selfImprovedLessons) && item.selfImprovedLessons.length > 0
      ? `<div class="self-improved-card">
          <div class="self-improved-head">Self-Programmed Lesson (Saved to LEARNED_FIXES.md)</div>
          <ul class="self-improved-list">
            ${item.selfImprovedLessons.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}
          </ul>
        </div>`
      : '';

  const showActions = (!item.isStreaming && item.content) || item.isError;
  const actionsHtml = showActions
    ? `<div class="msg-actions">
        <button type="button" class="msg-action-btn retry-turn-btn" data-idx="${idx}">Retry turn</button>
        ${
          !item.isStreaming && item.content
            ? `<button type="button" class="msg-action-btn copy-reply-btn" data-idx="${idx}">Copy reply</button>
               <button type="button" class="msg-action-btn teach-skill-btn" data-idx="${idx}">Teach as skill</button>
               <button type="button" class="msg-action-btn save-auto-btn" data-idx="${idx}">Save automation</button>`
            : ''
        }
      </div>`
    : '';

  const phaseLabel =
    item.thinking?.length > 0 && !item.content && item.tools?.length === 0
      ? 'Deep thinking'
      : item.tools?.some((t) => t.status === 'wait')
        ? 'Waiting for your approval'
        : item.tools?.some((t) => t.status === 'running')
          ? 'Running tools'
          : !item.content
            ? `Running ${escapeHtml(state.config?.model || 'model')}`
            : 'Streaming reply';

  const elapsedSec = Math.max(0, Math.floor((Date.now() - state.runStartedAt) / 1000));
  const liveStatusHtml = item.isStreaming
    ? `<div class="live-status-line"><span class="pulse-dot"></span><span id="live-status-phase">${phaseLabel}</span> (<span id="live-elapsed-seconds">${elapsedSec}</span>s)...</div>`
    : '';

  return `
    <div class="msg-row" ${item.isStreaming ? 'id="live-assistant-row"' : ''}>
      <div class="msg-assistant${item.isError ? ' error' : ''}">
        ${liveStatusHtml}
        <div class="live-plan-slot">${buildPlanHtml(item)}</div>
        <div class="live-thinking-slot">${thinkingHtml}</div>
        <div class="live-tools-slot">${toolsHtml}</div>
        <div class="live-self-improved-slot">${selfImprovedHtml}</div>
        <div class="live-md-slot">${item.content ? `<div class="md-body">${renderMarkdown(item.content)}</div>` : ''}</div>
        ${actionsHtml}
      </div>
    </div>`;
}

function updateScrollButton() {
  const scrollBox = $('#chat-scroll');
  const btn = $('#scroll-bottom-btn');
  if (!scrollBox || !btn) return;
  const hasContent = (state.activeSession?.messages?.length || 0) > 0 || Boolean(state.liveAssistantMsg);
  const distanceFromBottom = scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight;
  btn.classList.toggle('hidden', !hasContent || distanceFromBottom < 220);
}

function scrollToBottomIfPinned(force = false) {
  const scrollBox = $('#chat-scroll');
  if (!scrollBox) return;
  const distanceFromBottom = scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight;
  if (force || distanceFromBottom < 140) {
    scrollBox.scrollTop = scrollBox.scrollHeight;
  }
  updateScrollButton();
}

/**
 * Full render of historical conversation messages + optional live row mount.
 */
function renderMessages(forceScroll = false) {
  const messages = state.activeSession?.messages || [];
  const showLiveHere = Boolean(
    state.liveAssistantMsg &&
      (!state.runningSessionId || state.activeSession?.id === state.runningSessionId)
  );
  const hasAny = messages.length > 0 || showLiveHere;
  $('#welcome-state').classList.toggle('hidden', hasAny);
  const container = $('#chat-messages');

  if (!hasAny) {
    state.displayedItems = [];
    container.innerHTML = '';
    updateScrollButton();
    return;
  }

  const historyItems = groupMessagesForDisplay(messages);
  state.displayedItems = showLiveHere ? [...historyItems, state.liveAssistantMsg] : historyItems;

  const historyHtml = historyItems.map((item, idx) => buildDisplayItemHtml(item, idx)).join('');
  const liveHtml = showLiveHere ? buildDisplayItemHtml(state.liveAssistantMsg, historyItems.length) : '';

  container.innerHTML = `<div id="chat-history-items">${historyHtml}</div><div id="chat-live-slot">${liveHtml}</div>`;
  scrollToBottomIfPinned(forceScroll);
}

/**
 * Coalesced 60fps partial DOM update for the active streaming assistant bubble only,
 * updating sub-slots granularly so text streaming never re-decodes tool images or resets inputs.
 */
function scheduleLiveUpdate() {
  if (state.rafPending) return;
  state.rafPending = true;
  requestAnimationFrame(() => {
    state.rafPending = false;
    const item = state.liveAssistantMsg;
    if (!item) return;
    if (state.runningSessionId && state.activeSession?.id !== state.runningSessionId) return;
    const slot = $('#chat-live-slot');
    if (!slot) {
      renderMessages();
      return;
    }

    const liveRow = slot.querySelector('#live-assistant-row');
    if (!liveRow) {
      const idx = Math.max(0, state.displayedItems.length - 1);
      slot.innerHTML = buildDisplayItemHtml(item, idx);
      scrollToBottomIfPinned(false);
      return;
    }

    const phaseEl = liveRow.querySelector('#live-status-phase');
    if (phaseEl) {
      phaseEl.textContent =
        item.thinking?.length > 0 && !item.content && item.tools?.length === 0
          ? 'Deep thinking'
          : item.tools?.some((t) => t.status === 'wait')
            ? 'Waiting for your approval'
            : item.tools?.some((t) => t.status === 'running')
              ? 'Running tools'
              : !item.content
                ? `Running ${state.config?.model || 'model'}`
                : 'Streaming reply';
    }

    const thinkingCombined = (item.thinking || []).join('').trim();
    if (item._lastThinkingRendered !== thinkingCombined) {
      item._lastThinkingRendered = thinkingCombined;
      const thinkSlot = liveRow.querySelector('.live-thinking-slot');
      if (thinkSlot) {
        const existingDetails = thinkSlot.querySelector('details.thinking-box');
        if (existingDetails && thinkingCombined) {
          const contentDiv = existingDetails.querySelector('.thinking-content');
          if (contentDiv) contentDiv.textContent = thinkingCombined;
        } else {
          thinkSlot.innerHTML = thinkingCombined
            ? `<details class="thinking-box" ${!item.content ? 'open' : ''}><summary>Thinking</summary><div class="thinking-content">${escapeHtml(thinkingCombined)}</div></details>`
            : '';
        }
      }
    }

    const toolsSig = JSON.stringify(
      (item.tools || []).map((t) => [
        t.id,
        t.status,
        t.output?.length || 0,
        t.diff?.length || 0,
        t.images?.length || 0,
        Boolean(t.approval),
        t.durationMs || 0,
      ])
    );
    if (item._lastToolsSig !== toolsSig) {
      item._lastToolsSig = toolsSig;
      const toolsSlot = liveRow.querySelector('.live-tools-slot');
      if (toolsSlot) {
        const activeEdit = toolsSlot.querySelector('.approval-cmd-edit');
        const focusedToolId =
          document.activeElement && document.activeElement.classList.contains('approval-cmd-edit')
            ? document.activeElement.dataset.toolId
            : null;
        if (activeEdit && activeEdit.dataset.toolId) {
          const targetTool = item.tools.find((t) => t.id === activeEdit.dataset.toolId);
          if (targetTool?.approval) {
            targetTool.approval.editedValue = activeEdit.value;
          }
        }

        toolsSlot.innerHTML = buildToolsHtml(item.tools);

        if (focusedToolId) {
          const restoredInput = toolsSlot.querySelector(`.approval-cmd-edit[data-tool-id="${CSS.escape(focusedToolId)}"]`);
          if (restoredInput) {
            restoredInput.focus();
            const len = restoredInput.value.length;
            restoredInput.setSelectionRange(len, len);
          }
        }
      }
    }

    const planSig = JSON.stringify(item.plan || []);
    if (item._lastPlanSig !== planSig) {
      item._lastPlanSig = planSig;
      const planSlot = liveRow.querySelector('.live-plan-slot');
      if (planSlot) planSlot.innerHTML = buildPlanHtml(item);
    }

    const lessonsSig = (item.selfImprovedLessons || []).join('|');
    if (item._lastLessonsSig !== lessonsSig) {
      item._lastLessonsSig = lessonsSig;
      const selfSlot = liveRow.querySelector('.live-self-improved-slot');
      if (selfSlot) {
        selfSlot.innerHTML =
          item.selfImprovedLessons?.length > 0
            ? `<div class="self-improved-card">
                <div class="self-improved-head">Self-Programmed Lesson (Saved to LEARNED_FIXES.md)</div>
                <ul class="self-improved-list">
                  ${item.selfImprovedLessons.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}
                </ul>
              </div>`
            : '';
      }
    }

    const now = performance.now();
    if (
      item._lastContentRendered !== item.content &&
      shouldRenderStreamingMarkdown(item._lastMarkdownRenderAt, now)
    ) {
      item._lastContentRendered = item.content;
      item._lastMarkdownRenderAt = now;
      const mdSlot = liveRow.querySelector('.live-md-slot');
      if (mdSlot) {
        mdSlot.innerHTML = item.content ? `<div class="md-body">${renderMarkdown(item.content)}</div>` : '';
      }
    }

    scrollToBottomIfPinned(false);
  });
}

async function resolveApproval(toolCallId, approved, editedCommand) {
  if (!state.activeSession) return;
  const tool = state.liveAssistantMsg?.tools?.find((t) => t.id === toolCallId);
  if (tool) {
    tool.approval = null;
    tool.status = approved ? 'running' : 'fail';
    if (approved) tool.startedAt = Date.now();
    scheduleLiveUpdate();
  }
  await apiRequest(`/api/sessions/${encodeURIComponent(state.activeSession.id)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ toolCallId, approved, editedCommand }),
  });
}

async function loadSessions() {
  const res = await apiRequest('/api/sessions');
  state.sessions = res.sessions || [];
  state.sessionSearchQuery = '';
  const searchInput = $('#session-search');
  if (searchInput && document.activeElement !== searchInput) searchInput.value = '';
  renderSessionsList();
}

async function runSessionSearch(query) {
  const res = await apiRequest(`/api/sessions/search?q=${encodeURIComponent(query)}`);
  state.sessionSearchQuery = query;
  state.sessions = res.results || [];
  renderSessionsList();
}

async function openSession(id) {
  const res = await apiRequest(`/api/sessions/${encodeURIComponent(id)}`);
  state.sessionSearchQuery = '';
  const searchInput = $('#session-search');
  if (searchInput) searchInput.value = '';
  state.activeSession = res.session;
  state.contextTokens = estimateTokens(state.activeSession.messages || []);
  updateContextMeter(state.contextTokens, state.config?.numCtx);
  switchView('agent');
  await loadSessions();
  renderMessages(true);
}

async function createNewTask() {
  const res = await apiRequest('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'New Task' }),
  });
  state.activeSession = res.session;
  if (!state.isRunning) state.liveAssistantMsg = null;
  state.contextTokens = 0;
  updateContextMeter(0, state.config?.numCtx);
  await loadSessions();
  switchView('agent');
  renderMessages(true);
  $('#prompt-input').focus();
}

function renderQueuedBar() {
  const bar = $('#queued-bar');
  if (!state.queuedMessages || state.queuedMessages.length === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const count = state.queuedMessages.length;
  const next = state.queuedMessages[0];
  const prefix = count > 1 ? `Queued (${count} · next)` : 'Queued next';
  $('#queued-text').textContent = `${prefix}: ${next.text || '(attached files)'}`;
}

async function sendPrompt(overridePayload = null) {
  const input = $('#prompt-input');
  const text = overridePayload ? overridePayload.text : input.value.trim();
  const attachPaths = overridePayload ? overridePayload.attachments : state.attachments.map((a) => a.path);

  if (!text && attachPaths.length === 0) return;

  if (state.isRunning) {
    state.queuedMessages.push({
      text,
      attachments: attachPaths,
      sessionId: overridePayload?.sessionId || state.activeSession?.id || state.runningSessionId || null,
    });
    if (!overridePayload) {
      input.value = '';
      input.style.height = 'auto';
      state.attachments = [];
      renderAttachments();
    }
    renderQueuedBar();
    showToast(`Follow-up queued (#${state.queuedMessages.length} — runs next, or click Send now)`);
    return;
  }

  if (overridePayload?.sessionId && state.activeSession?.id !== overridePayload.sessionId) {
    try {
      const loaded = await apiRequest(`/api/sessions/${encodeURIComponent(overridePayload.sessionId)}`);
      state.activeSession = loaded.session;
    } catch {
      // Fall back to active session
    }
  }

  if (!state.activeSession) {
    const created = await apiRequest('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: text.slice(0, 48) || 'New Task' }),
    });
    state.activeSession = created.session;
  }

  const runSessionId = state.activeSession.id;
  if (!overridePayload) {
    input.value = '';
    input.style.height = 'auto';
    state.attachments = [];
    renderAttachments();
  }

  state.activeSession.messages.push({
    role: 'user',
    content: text,
    attachments: attachPaths,
  });

  state.liveAssistantMsg = {
    type: 'assistant',
    isStreaming: true,
    thinking: [],
    tools: [],
    content: '',
    plan: null,
    selfImprovedLessons: [],
  };
  state.isRunning = true;
  state.runningSessionId = runSessionId;
  state.runStartedAt = Date.now();
  state.runAbort = new AbortController();
  clearInterval(state.timerHandle);

  // Update ONLY the elapsed seconds span every 1s so we never destroy DOM or interrupt button clicks!
  state.timerHandle = setInterval(() => {
    const elapsedEl = $('#live-elapsed-seconds');
    if (elapsedEl && state.isRunning) {
      elapsedEl.textContent = String(Math.max(0, Math.floor((Date.now() - state.runStartedAt) / 1000)));
    }
  }, 1000);

  $('#send-btn').textContent = 'Queue';
  $('#stop-btn').classList.remove('hidden');
  renderSessionsList();
  renderMessages(true);

  try {
    await streamSse(
      `/api/sessions/${encodeURIComponent(runSessionId)}/run`,
      {
        message: text,
        attachments: attachPaths,
        provider: state.config?.provider,
        model: state.config?.model,
        thinking: state.config?.thinking,
        safetyMode: state.config?.safetyMode,
      },
      (evt) => {
        if (!state.liveAssistantMsg) return;
        if (evt.type === 'thinking_delta') {
          state.liveAssistantMsg.thinking.push(evt.text);
        } else if (evt.type === 'text_delta') {
          state.liveAssistantMsg.content += evt.text;
        } else if (evt.type === 'plan_update') {
          state.liveAssistantMsg.plan = Array.isArray(evt.plan) ? evt.plan : null;
        } else if (evt.type === 'tool_call') {
          state.liveAssistantMsg.tools.push({
            id: evt.toolCallId,
            name: evt.name,
            arguments: evt.arguments,
            status: 'running',
            output: '',
            diff: '',
            images: [],
            startedAt: Date.now(),
          });
        } else if (evt.type === 'approval_required') {
          const t = state.liveAssistantMsg.tools.find((x) => x.id === evt.toolCallId);
          if (t) {
            t.status = 'wait';
            t.approval = { reason: evt.reason, preview: evt.preview };
          }
        } else if (evt.type === 'tool_output') {
          const t = state.liveAssistantMsg.tools.find((x) => x.id === evt.toolCallId);
          if (t) t.output += evt.text;
        } else if (evt.type === 'tool_result') {
          const t = state.liveAssistantMsg.tools.find((x) => x.id === evt.toolCallId);
          if (t) {
            t.approval = null;
            t.status = evt.ok ? 'ok' : 'fail';
            t.output = evt.output || '';
            t.diff = evt.diff || '';
            t.images = evt.images || [];
            t.durationMs = t.startedAt ? Date.now() - t.startedAt : null;
          }
        } else if (evt.type === 'self_improved') {
          if (evt.resolvedModel && state.config) {
            state.config.model = evt.resolvedModel;
            updateHeaderControls();
          }
          if (Array.isArray(evt.lessons)) {
            for (const lesson of evt.lessons) {
              if (!state.liveAssistantMsg.selfImprovedLessons.includes(lesson)) {
                state.liveAssistantMsg.selfImprovedLessons.push(lesson);
              }
            }
          }
        } else if (evt.type === 'context_stats') {
          if (state.activeSession?.id === runSessionId) {
            state.contextTokens = Number(evt.tokens) || 0;
            updateContextMeter(state.contextTokens, evt.numCtx || state.config?.numCtx);
          }
          return;
        } else if (evt.type === 'compacted') {
          if (state.activeSession?.id === runSessionId && Number.isFinite(evt.tokensAfter)) {
            state.contextTokens = evt.tokensAfter;
            updateContextMeter(state.contextTokens, state.config?.numCtx);
          }
          showToast('Context compacted automatically');
        } else if (evt.type === 'error') {
          showToast(evt.message || 'Model error');
          state.liveAssistantMsg.content += `\n\n> Error: ${evt.message}`;
        }
        scheduleLiveUpdate();
      },
      state.runAbort.signal
    );
  } catch (err) {
    if (err.name !== 'AbortError') showToast(err.message);
  } finally {
    clearInterval(state.timerHandle);
    state.timerHandle = null;
    state.isRunning = false;
    state.runningSessionId = null;
    state.runAbort = null;
    state.liveAssistantMsg = null;
    $('#send-btn').textContent = 'Run';
    $('#stop-btn').classList.add('hidden');

    if (state.activeSession?.id === runSessionId) {
      try {
        const refreshed = await apiRequest(`/api/sessions/${encodeURIComponent(runSessionId)}`);
        if (state.activeSession?.id === runSessionId) {
          state.activeSession = refreshed.session;
        }
      } catch {
        // Keep current messages if reload fails
      }
      state.contextTokens = estimateTokens(state.activeSession?.messages || []);
      updateContextMeter(state.contextTokens, state.config?.numCtx);
      renderMessages(false);
    }
    if (!state.sessionSearchQuery) {
      await loadSessions().catch(() => {});
    } else {
      renderSessionsList();
    }

    if (state.queuedMessages.length > 0) {
      const nextPayload = state.queuedMessages.shift();
      renderQueuedBar();
      sendPrompt(nextPayload);
    }
  }
}

// Model Switcher Popover
function renderModelPopover() {
  const pop = $('#model-popover');
  const ollamaModels = state.health?.ollama?.models || [];
  const currentProv = state.config?.provider || 'ollama';
  const currentModel = state.config?.model || 'qwen3.5:4b';

  const localItems =
    ollamaModels.length > 0
      ? ollamaModels
          .map(
            (m) => `
          <button type="button" class="popover-item ${currentProv === 'ollama' && currentModel === m.name ? 'selected' : ''}" data-provider="ollama" data-model="${escapeHtml(m.name)}">
            <span>${escapeHtml(m.name)}</span>
            <small>${formatBytes(m.size)}</small>
          </button>`
          )
          .join('')
      : `<div class="status-sub" style="padding:6px 10px;">No local models pulled yet (pull qwen3.5:9b in Settings)</div>`;

  const cloudItems = Object.values(state.presets || {})
    .map((preset) => {
      const configured = Boolean(state.configuredKeys?.[preset.id]) || preset.id === 'custom';
      const models = preset.suggestedModels?.length ? preset.suggestedModels : [state.config?.customModel || preset.defaultModel];
      return `
        <div class="popover-group-title">${escapeHtml(preset.label)} ${configured ? '' : '(No key yet)'}</div>
        ${models
          .map(
            (m) => `
          <button type="button" class="popover-item ${currentProv === preset.id && currentModel === m ? 'selected' : ''}" data-provider="${escapeHtml(preset.id)}" data-model="${escapeHtml(m)}">
            <span>${escapeHtml(m)}</span>
            <small>${configured ? 'Ready' : 'Setup'}</small>
          </button>`
          )
          .join('')}`;
    })
    .join('');

  pop.innerHTML = `<div class="popover-group-title">Local Ollama (M4 · Zero Tokens)</div>${localItems}${cloudItems}`;

  pop.querySelectorAll('.popover-item').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const prov = btn.dataset.provider;
      const model = btn.dataset.model;
      pop.classList.add('hidden');
      if (prov !== 'ollama' && prov !== 'custom' && !state.configuredKeys?.[prov]) {
        switchView('settings');
        showToast(`Add your ${prov} API key in Settings first`);
        return;
      }
      const res = await apiRequest('/api/models/config', {
        method: 'POST',
        body: JSON.stringify({ provider: prov, model }),
      });
      state.config = res.config;
      state.configuredKeys = res.configuredKeys;
      updateHeaderControls();
      showToast(`Switched to ${model}`);
    });
  });
}

// Skills & Knowledge Views
async function loadSkills() {
  const res = await apiRequest('/api/skills');
  state.skills = res.skills || [];
  renderSkillsGrid();
}

function renderSkillsGrid() {
  const q = ($('#skills-search').value || '').toLowerCase().trim();
  const filtered = state.skills.filter(
    (s) => !q || s.slug.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  );
  $('#skills-grid').innerHTML =
    filtered
      .map(
        (s) => `
      <div class="card">
        <div class="card-top">
          <div class="card-title">${escapeHtml(s.slug)}</div>
          <span class="card-tag">${s.source ? 'Imported' : s.isStarter ? 'Starter' : 'Learned'}</span>
        </div>
        <div class="card-desc">${escapeHtml(s.description)}</div>
        <div class="card-actions">
          <button type="button" class="secondary-btn edit-skill-btn" data-slug="${escapeHtml(s.slug)}">Edit</button>
          ${s.source ? `<button type="button" class="secondary-btn refresh-skill-btn" data-slug="${escapeHtml(s.slug)}">Refresh</button>` : ''}
          <button type="button" class="danger-btn del-skill-btn" data-slug="${escapeHtml(s.slug)}">Delete</button>
        </div>
      </div>`
      )
      .join('') || '<div class="status-sub">No matching skills.</div>';

  $('#skills-grid').querySelectorAll('.edit-skill-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const res = await apiRequest(`/api/skills/${encodeURIComponent(b.dataset.slug)}`);
      openSkillModal(res.skill);
    });
  });
  $('#skills-grid').querySelectorAll('.refresh-skill-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Refreshing...';
      try {
        await apiRequest(`/api/skills/${encodeURIComponent(b.dataset.slug)}/refresh`, { method: 'POST' });
        await loadSkills();
        showToast(`Refreshed skill ${b.dataset.slug}`);
      } catch (err) {
        showToast(err.message);
        b.disabled = false;
        b.textContent = 'Refresh';
      }
    });
  });
  $('#skills-grid').querySelectorAll('.del-skill-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      await apiRequest(`/api/skills/${encodeURIComponent(b.dataset.slug)}`, { method: 'DELETE' });
      await loadSkills();
      showToast(`Deleted skill ${b.dataset.slug}`);
    });
  });
}

async function loadKnowledge() {
  const res = await apiRequest('/api/knowledge');
  state.knowledge = res.docs || [];
  renderKnowledgeGrid();
  await refreshLearnedFixesBanner();
}

async function refreshLearnedFixesBanner() {
  const countEl = $('#learned-fixes-count');
  const previewEl = $('#learned-fixes-preview');
  if (!countEl || !previewEl) return;
  try {
    const res = await apiRequest('/api/knowledge/LEARNED_FIXES');
    const content = String(res.doc?.content || '');
    const rules = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '));
    countEl.textContent = `${rules.length} active rule${rules.length === 1 ? '' : 's'} · ${res.doc?.sizeBytes ?? content.length} B`;
    previewEl.textContent =
      rules.length > 0
        ? rules.slice(-2).join('\n')
        : 'No custom mistake rules recorded yet. Rules are added automatically whenever LocalGravity recovers from a tool or output error.';
  } catch {
    countEl.textContent = 'Ready';
  }
}

async function openLearnedFixesEditor() {
  try {
    const res = await apiRequest('/api/knowledge/LEARNED_FIXES');
    openKnowledgeModal(res.doc);
  } catch {
    openKnowledgeModal({
      name: 'LEARNED_FIXES',
      title: 'Self-Learned Mistake Prevention & Recovery Rules',
      tags: ['self-improvement', 'mistakes', 'auto-learned'],
      content: '# Autonomous Self-Learned Mistake Prevention Rules\n\n- ',
    });
  }
}

async function resetLearnedFixesRules() {
  try {
    await apiRequest('/api/knowledge/LEARNED_FIXES/reset', { method: 'POST' });
    await loadKnowledge();
    showToast('Reset LEARNED_FIXES.md to default baseline rules');
  } catch (err) {
    showToast(err.message);
  }
}

function renderKnowledgeGrid() {
  const q = ($('#knowledge-search').value || '').toLowerCase().trim();
  const filtered = state.knowledge.filter(
    (d) =>
      !q ||
      d.name.toLowerCase().includes(q) ||
      d.title.toLowerCase().includes(q) ||
      (d.tags || []).join(' ').toLowerCase().includes(q)
  );
  $('#knowledge-grid').innerHTML =
    filtered
      .map(
        (d) => `
      <div class="card">
        <div class="card-top">
          <div class="card-title">${escapeHtml(d.title)}</div>
          <span class="card-tag">${d.name === 'MEMORY' ? 'Pinned Memory' : d.name === 'LEARNED_FIXES' ? 'Auto-Learned' : `${d.sizeBytes} B`}</span>
        </div>
        <div class="card-desc">ID: <code>${escapeHtml(d.name)}</code>${d.tags?.length ? ` · Tags: ${escapeHtml(d.tags.join(', '))}` : ''}</div>
        <div class="card-actions">
          <button type="button" class="secondary-btn edit-know-btn" data-name="${escapeHtml(d.name)}">Open / Edit</button>
          ${d.name !== 'MEMORY' && d.name !== 'LEARNED_FIXES' ? `<button type="button" class="danger-btn del-know-btn" data-name="${escapeHtml(d.name)}">Delete</button>` : ''}
        </div>
      </div>`
      )
      .join('') || '<div class="status-sub">No knowledge docs yet.</div>';

  $('#knowledge-grid').querySelectorAll('.edit-know-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const res = await apiRequest(`/api/knowledge/${encodeURIComponent(b.dataset.name)}`);
      openKnowledgeModal(res.doc);
    });
  });
  $('#knowledge-grid').querySelectorAll('.del-know-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      await apiRequest(`/api/knowledge/${encodeURIComponent(b.dataset.name)}`, { method: 'DELETE' });
      await loadKnowledge();
      showToast(`Deleted knowledge doc ${b.dataset.name}`);
    });
  });
}

// Automations View
async function loadAutomations() {
  const res = await apiRequest('/api/automations');
  state.automations = res.automations || [];
  renderAutomationsGrid();
}

function renderAutomationsGrid() {
  const grid = $('#automations-grid');
  if (state.automations.length === 0) {
    grid.innerHTML = `<div class="status-sub">No saved automations yet. Click "+ Create automation" or save one from any agent reply.</div>`;
    return;
  }
  grid.innerHTML = state.automations
    .map(
      (a) => `
      <div class="card">
        <div class="card-top">
          <div class="card-title">${escapeHtml(a.name)}</div>
          <span class="card-tag">${a.schedule?.enabled ? `Scheduled (${a.schedule.frequency})` : 'Manual'}</span>
        </div>
        <div class="card-desc">${escapeHtml(a.prompt.slice(0, 140))}${a.prompt.length > 140 ? '...' : ''}</div>
        <div class="status-sub">${a.lastRunAt ? `Last run: ${new Date(a.lastRunAt).toLocaleString()} (${a.lastRunStatus})` : 'Never run yet'}</div>
        <div class="card-actions">
          <button type="button" class="primary-btn run-auto-btn" data-id="${escapeHtml(a.id)}">Run now</button>
          <button type="button" class="secondary-btn sched-auto-btn" data-id="${escapeHtml(a.id)}">Schedule</button>
          <button type="button" class="danger-btn del-auto-btn" data-id="${escapeHtml(a.id)}">Delete</button>
        </div>
      </div>`
    )
    .join('');

  grid.querySelectorAll('.run-auto-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const auto = state.automations.find((x) => x.id === b.dataset.id);
      if (!auto) return;
      await createNewTask();
      $('#prompt-input').value = auto.prompt;
      await sendPrompt();
    });
  });

  grid.querySelectorAll('.sched-auto-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const auto = state.automations.find((x) => x.id === b.dataset.id);
      if (auto) openScheduleModal(auto);
    });
  });

  grid.querySelectorAll('.del-auto-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      await apiRequest(`/api/automations/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' });
      await loadAutomations();
      showToast('Automation deleted');
    });
  });
}

// Settings & Models View
function renderSettingsView() {
  if (!state.health) return;
  const { system, ollama } = state.health;

  $('#system-stats-grid').innerHTML = `
    <div class="stat-box"><span>Chip / RAM</span><strong>${escapeHtml(system.arch)} · ${system.totalRamGb} GB</strong></div>
    <div class="stat-box"><span>Free SSD</span><strong>${system.freeDiskGb ?? '?'} GB / ${system.totalDiskGb ?? '?'} GB</strong></div>
    <div class="stat-box"><span>ffmpeg / ImageMagick</span><strong>${system.tools.ffmpeg ? 'Ready' : 'Missing'} / ${system.tools.magick ? 'Ready' : 'Missing'}</strong></div>
    <div class="stat-box"><span>Ollama</span><strong>${ollama.running ? 'Running' : 'Stopped'}</strong></div>
  `;

  $('#ollama-models-list').innerHTML =
    (ollama.models || [])
      .map(
        (m) => `
      <div class="model-row">
        <div>
          <strong>${escapeHtml(m.name)}</strong>
          <div class="status-sub">${formatBytes(m.size)}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button type="button" class="secondary-btn use-ollama-btn" data-model="${escapeHtml(m.name)}">Use</button>
          <button type="button" class="danger-btn del-ollama-btn" data-model="${escapeHtml(m.name)}">Remove</button>
        </div>
      </div>`
      )
      .join('') || '<div class="status-sub">No local Ollama models detected yet.</div>';

  $('#ollama-models-list').querySelectorAll('.use-ollama-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const res = await apiRequest('/api/models/config', {
        method: 'POST',
        body: JSON.stringify({ provider: 'ollama', model: b.dataset.model }),
      });
      state.config = res.config;
      updateHeaderControls();
      showToast(`Active model set to ${b.dataset.model}`);
    });
  });

  $('#ollama-models-list').querySelectorAll('.del-ollama-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      await apiRequest(`/api/models/ollama/${encodeURIComponent(b.dataset.model)}`, { method: 'DELETE' });
      await refreshHealth();
      showToast(`Removed ${b.dataset.model}`);
    });
  });

  $('#providers-list').innerHTML = Object.values(state.presets || {})
    .map((p) => {
      const hasKey = Boolean(state.configuredKeys?.[p.id]);
      return `
      <div class="provider-card" data-prov="${escapeHtml(p.id)}">
        <div class="card-top">
          <strong>${escapeHtml(p.label)}</strong>
          <span class="card-tag">${hasKey ? 'Key saved' : p.id === 'custom' ? 'Local/Custom' : 'Not set'}</span>
        </div>
        ${
          p.id === 'custom'
            ? `<input type="text" class="text-input prov-url-input" placeholder="Base URL (e.g. http://127.0.0.1:1234/v1)" value="${escapeHtml(state.config?.customBaseUrl || '')}" />
               <input type="text" class="text-input prov-model-input" placeholder="Model ID" value="${escapeHtml(state.config?.customModel || '')}" />`
            : ''
        }
        <input type="password" class="text-input prov-key-input" placeholder="${hasKey ? 'Key saved (paste new key to replace)' : 'Paste API key...'}" />
        <div style="display:flex;gap:8px;">
          <button type="button" class="primary-btn save-prov-btn" data-prov="${escapeHtml(p.id)}">Save & Use</button>
          ${hasKey ? `<button type="button" class="danger-btn clear-prov-btn" data-prov="${escapeHtml(p.id)}">Clear key</button>` : ''}
        </div>
      </div>`;
    })
    .join('');

  $('#providers-list').querySelectorAll('.save-prov-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const prov = b.dataset.prov;
      const card = b.closest('.provider-card');
      const keyVal = card.querySelector('.prov-key-input').value.trim();
      const urlVal = card.querySelector('.prov-url-input')?.value.trim();
      const modelVal = card.querySelector('.prov-model-input')?.value.trim();
      const preset = state.presets[prov];

      const payload = {
        provider: prov,
        model: modelVal || preset.defaultModel,
        ...(urlVal !== undefined ? { customBaseUrl: urlVal } : {}),
        ...(modelVal !== undefined ? { customModel: modelVal } : {}),
        ...(keyVal ? { apiKeys: { [prov]: keyVal } } : {}),
      };
      const res = await apiRequest('/api/models/config', { method: 'POST', body: JSON.stringify(payload) });
      state.config = res.config;
      state.configuredKeys = res.configuredKeys;
      updateHeaderControls();
      renderSettingsView();
      showToast(`Connected ${preset.label}`);
    });
  });

  $('#providers-list').querySelectorAll('.clear-prov-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const prov = b.dataset.prov;
      const defaultLocal = state.health?.ollama?.models?.[0]?.name || 'qwen3.5:4b';
      const res = await apiRequest('/api/models/config', {
        method: 'POST',
        body: JSON.stringify({ apiKeys: { [prov]: null }, provider: 'ollama', model: defaultLocal }),
      });
      state.config = res.config;
      state.configuredKeys = res.configuredKeys;
      updateHeaderControls();
      renderSettingsView();
      showToast(`Cleared ${prov} key`);
    });
  });
}

// Modals
let modalReturnFocusEl = null;

function openModal(title, htmlContent) {
  modalReturnFocusEl = document.activeElement;
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = htmlContent;
  $('#modal-backdrop').classList.remove('hidden');
  $('#modal-close-btn')?.focus();
}

function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
  $('#modal-body').innerHTML = '';
  if (modalReturnFocusEl && typeof modalReturnFocusEl.focus === 'function') {
    modalReturnFocusEl.focus();
  }
  modalReturnFocusEl = null;
}

function openSkillModal(existing) {
  const isNew = !existing;
  openModal(
    isNew ? 'Create New Skill' : `Edit Skill: ${existing.meta.slug}`,
    `
    <div class="form-field">
      <label>Slug (lowercase letters, numbers, hyphens)</label>
      <input id="m-skill-name" class="text-input" value="${escapeHtml(existing?.meta?.slug || '')}" ${isNew ? '' : 'readonly'} placeholder="e.g. instagram-reel-export" />
    </div>
    <div class="form-field">
      <label>Description (when should the agent use this?)</label>
      <input id="m-skill-desc" class="text-input" value="${escapeHtml(existing?.meta?.description || '')}" placeholder="One-line trigger description" />
    </div>
    <div class="form-field">
      <label>Triggers (comma separated)</label>
      <input id="m-skill-triggers" class="text-input" value="${escapeHtml((existing?.meta?.triggers || []).join(', '))}" placeholder="reel, export, instagram" />
    </div>
    <div class="form-field">
      <label>Instructions (Markdown)</label>
      <textarea id="m-skill-body">${escapeHtml(existing?.content || '# Workflow Steps\n\n1. ')}</textarea>
    </div>
    <div class="modal-footer">
      <button type="button" class="secondary-btn" id="m-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="m-save-skill">Save skill</button>
    </div>`
  );
  $('#m-cancel').onclick = closeModal;
  $('#m-save-skill').onclick = async () => {
    try {
      await apiRequest('/api/skills', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#m-skill-name').value.trim(),
          description: $('#m-skill-desc').value.trim(),
          triggers: $('#m-skill-triggers')
            .value.split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          content: $('#m-skill-body').value,
        }),
      });
      closeModal();
      await loadSkills();
      showToast('Skill saved');
    } catch (err) {
      showToast(err.message);
    }
  };
}

function openKnowledgeUrlModal() {
  openModal(
    'Import Knowledge from URL',
    `
    <p class="section-hint">Fetches a public page or raw text file and saves its readable text as a Knowledge Base document.</p>
    <div class="form-field">
      <label>URL</label>
      <input id="m-know-url" class="text-input" placeholder="https://example.com/article" />
    </div>
    <div class="form-field">
      <label>Title (optional)</label>
      <input id="m-know-url-title" class="text-input" placeholder="Defaults to the site hostname" />
    </div>
    <div class="modal-footer">
      <button type="button" class="secondary-btn" id="m-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="m-do-import-know-url">Import</button>
    </div>`
  );
  $('#m-cancel').onclick = closeModal;
  $('#m-do-import-know-url').onclick = async () => {
    const url = $('#m-know-url').value.trim();
    if (!url) {
      showToast('Paste a URL first');
      return;
    }
    const btn = $('#m-do-import-know-url');
    btn.disabled = true;
    btn.textContent = 'Importing...';
    try {
      const res = await apiRequest('/api/knowledge/import-url', {
        method: 'POST',
        body: JSON.stringify({ url, title: $('#m-know-url-title').value.trim() || undefined }),
      });
      closeModal();
      await loadKnowledge();
      showToast(`Saved ${res.saved.name} (${Math.round(res.chars / 1000)}k chars)`);
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  };
}

function exportActiveConversation() {
  const session = state.activeSession;
  const messages = session?.messages || [];
  if (messages.length === 0) {
    showToast('No conversation to export');
    return;
  }
  const lines = [
    `# ${session.title || 'LocalGravity conversation'}`,
    '',
    `Exported: ${new Date().toISOString()}`,
    `Model: ${session.model || state.config?.model || 'unknown'}`,
    '',
  ];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.isCompactionSummary) {
      lines.push('> Compacted earlier context', '');
      continue;
    }
    if (msg.role === 'user') {
      lines.push('## You', '', String(msg.content || '').trim(), '');
    } else if (msg.role === 'assistant') {
      const text = String(msg.content || '').trim();
      if (text) lines.push('## LocalGravity', '', text, '');
      const tools = (msg.toolCalls || []).map((t) => t.name).filter(Boolean);
      if (tools.length > 0) lines.push(`*Tools used: ${tools.join(', ')}*`, '');
    }
  }
  const markdownContent = `${lines.join('\n').trimEnd()}\n`;
  const filename = `${String(session.title || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'conversation'}.md`;

  if (hasSwiftBridge()) {
    postSwiftAction('saveFile', { filename, content: markdownContent });
    return;
  }

  const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Conversation exported as Markdown');
}

function openKnowledgeModal(existing) {
  const isNew = !existing;
  openModal(
    isNew ? 'New Knowledge Document' : `Edit Knowledge: ${existing.title}`,
    `
    <div class="form-field">
      <label>Document ID</label>
      <input id="m-know-name" class="text-input" value="${escapeHtml(existing?.name || '')}" ${isNew ? '' : 'readonly'} placeholder="e.g. brand-guidelines" />
    </div>
    <div class="form-field">
      <label>Title</label>
      <input id="m-know-title" class="text-input" value="${escapeHtml(existing?.title || '')}" placeholder="Human readable title" />
    </div>
    <div class="form-field">
      <label>Tags (comma separated)</label>
      <input id="m-know-tags" class="text-input" value="${escapeHtml((existing?.tags || []).join(', '))}" placeholder="branding, video, preferences" />
    </div>
    <div class="form-field">
      <label>Knowledge Content (Markdown or Plain Text)</label>
      <textarea id="m-know-body">${escapeHtml(existing?.content || '')}</textarea>
    </div>
    <div class="modal-footer">
      <button type="button" class="secondary-btn" id="m-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="m-save-know">Save knowledge</button>
    </div>`
  );
  $('#m-cancel').onclick = closeModal;
  $('#m-save-know').onclick = async () => {
    try {
      await apiRequest('/api/knowledge', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#m-know-name').value.trim(),
          title: $('#m-know-title').value.trim(),
          tags: $('#m-know-tags')
            .value.split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          content: $('#m-know-body').value,
        }),
      });
      closeModal();
      await loadKnowledge();
      showToast('Knowledge saved');
    } catch (err) {
      showToast(err.message);
    }
  };
}

function openAutomationModal(prefill = {}) {
  openModal(
    'Create Automation',
    `
    <div class="form-field">
      <label>Name</label>
      <input id="m-auto-name" class="text-input" value="${escapeHtml(prefill.name || '')}" placeholder="e.g. Weekly Downloads Cleanup" />
    </div>
    <div class="form-field">
      <label>Prompt</label>
      <textarea id="m-auto-prompt">${escapeHtml(prefill.prompt || '')}</textarea>
    </div>
    <div class="modal-footer">
      <button type="button" class="secondary-btn" id="m-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="m-save-auto">Save automation</button>
    </div>`
  );
  $('#m-cancel').onclick = closeModal;
  $('#m-save-auto').onclick = async () => {
    await apiRequest('/api/automations', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#m-auto-name').value.trim(),
        prompt: $('#m-auto-prompt').value.trim(),
      }),
    });
    closeModal();
    await loadAutomations();
    showToast('Automation saved');
  };
}

function openScheduleModal(auto) {
  const sched = auto.schedule || { enabled: false, frequency: 'daily', hour: 9, minute: 0 };
  openModal(
    `Schedule: ${auto.name}`,
    `
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <input type="checkbox" id="m-sched-enabled" ${sched.enabled ? 'checked' : ''} />
      <span>Enable background launchd schedule</span>
    </label>
    <div class="form-field">
      <label>Frequency</label>
      <select id="m-sched-freq" class="select-input">
        <option value="daily" ${sched.frequency === 'daily' ? 'selected' : ''}>Daily</option>
        <option value="hourly" ${sched.frequency === 'hourly' ? 'selected' : ''}>Hourly</option>
      </select>
    </div>
    <div class="form-field">
      <label>Daily Time (Hour 0-23 : Minute)</label>
      <div style="display:flex;gap:8px;">
        <input id="m-sched-hour" class="text-input" type="number" min="0" max="23" value="${sched.hour ?? 9}" />
        <input id="m-sched-min" class="text-input" type="number" min="0" max="59" value="${sched.minute ?? 0}" />
      </div>
    </div>
    <div class="warning-box">
      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;">
        <input type="checkbox" id="m-sched-autorun" ${auto.allowAutoRun ? 'checked' : ''} />
        <span><strong>Allow auto-run when unattended</strong> — Leave unchecked for safe Read-Only Audit mode. Checking this lets the background job run shell commands and modify files without asking (catastrophic commands stay blocked).</span>
      </label>
    </div>
    <div class="modal-footer">
      <button type="button" class="secondary-btn" id="m-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="m-save-sched">Save schedule</button>
    </div>`
  );
  $('#m-cancel').onclick = closeModal;
  $('#m-save-sched').onclick = async () => {
    try {
      await apiRequest(`/api/automations/${encodeURIComponent(auto.id)}/schedule`, {
        method: 'POST',
        body: JSON.stringify({
          enabled: $('#m-sched-enabled').checked,
          frequency: $('#m-sched-freq').value,
          hour: Number($('#m-sched-hour').value),
          minute: Number($('#m-sched-min').value),
          allowAutoRun: $('#m-sched-autorun').checked,
        }),
      });
      closeModal();
      await loadAutomations();
      showToast('Schedule updated');
    } catch (err) {
      showToast(err.message);
    }
  };
}

function openImportUrlModal() {
  openModal(
    'Import Skills from GitHub',
    `
    <p class="section-hint">
      Paste a raw <code>SKILL.md</code> URL or a GitHub file link
      (<code>github.com/owner/repo/blob/main/skills/name/SKILL.md</code>), one per line.
      The skill is validated and saved into <code>~/.localgravity/skills/</code>.
    </p>
    <div class="form-field">
      <label>Skill URLs</label>
      <textarea id="m-skill-urls" placeholder="https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md"></textarea>
    </div>
    <div class="modal-footer">
      <button type="button" class="secondary-btn" id="m-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="m-do-import-url">Import skills</button>
    </div>`
  );
  $('#m-cancel').onclick = closeModal;
  $('#m-do-import-url').onclick = async () => {
    const urls = $('#m-skill-urls')
      .value.split(/\n+/)
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      showToast('Paste at least one skill URL');
      return;
    }
    const btn = $('#m-do-import-url');
    btn.disabled = true;
    btn.textContent = 'Importing...';
    try {
      const res = await apiRequest('/api/skills/import-url', {
        method: 'POST',
        body: JSON.stringify({ urls }),
      });
      await loadSkills();
      if (res.errors?.length) {
        showToast(`Imported ${res.imported.length} skill(s); ${res.errors.length} failed: ${res.errors[0].error}`);
      } else {
        closeModal();
        showToast(`Imported ${res.imported.length} skill(s)`);
      }
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
      btn.textContent = 'Import skills';
    }
  };
}

async function openSkillLibraryModal() {
  openModal('Skill Library', '<p class="section-hint">Scanning the skill libraries on this Mac...</p>');
  let res;
  try {
    res = await apiRequest('/api/skills/external');
  } catch (err) {
    closeModal();
    showToast(err.message);
    return;
  }

  const sources = (res.sources || []).filter((source) => Array.isArray(source.skills));
  if (sources.length === 0) {
    showToast('No local skill libraries found');
    return;
  }

  let activeId =
    sources.find((source) => source.skills.some((skill) => !skill.installed))?.id || sources[0].id;
  let query = '';

  openModal(
    'Skill Library',
    `
    <p class="section-hint">
      Copy skills already installed on this Mac into LocalGravity. Skills you already have are marked and disabled.
    </p>
    <div id="skill-library-tabs" class="skill-library-tabs"></div>
    <input id="m-skill-lib-search" class="text-input" type="search" placeholder="Filter skills..." />
    <div id="skill-library-meta" class="status-sub"></div>
    <div id="skill-library-list" class="skill-library-list"></div>
    <div class="modal-footer">
      <button type="button" class="secondary-btn" id="m-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="m-do-import">Import selected</button>
    </div>`
  );

  const tabRow = $('#skill-library-tabs');
  const listEl = $('#skill-library-list');
  const metaEl = $('#skill-library-meta');
  const importBtn = $('#m-do-import');
  const searchInput = $('#m-skill-lib-search');

  const activeSource = () => sources.find((source) => source.id === activeId) || sources[0];

  const updateImportButton = () => {
    const count = $$('.lib-skill-cb:checked').length;
    importBtn.disabled = count === 0;
    importBtn.textContent = count > 0 ? `Import ${count} skill${count === 1 ? '' : 's'}` : 'Import selected';
  };

  const renderList = () => {
    const source = activeSource();
    const needle = query.toLowerCase();
    const matches = source.skills.filter(
      (skill) =>
        !needle ||
        skill.slug.toLowerCase().includes(needle) ||
        String(skill.description || '').toLowerCase().includes(needle)
    );
    const shown = matches.slice(0, 250);
    metaEl.textContent = `${source.skills.length} skill${source.skills.length === 1 ? '' : 's'} in ${source.dir}${matches.length > shown.length ? ` (showing first ${shown.length})` : ''}`;

    if (source.skills.length === 0) {
      listEl.innerHTML = `<div class="status-sub">No skills found in <code>${escapeHtml(source.dir)}</code>.</div>`;
      return;
    }
    if (shown.length === 0) {
      listEl.innerHTML = '<div class="status-sub">No skills match that filter.</div>';
      return;
    }

    listEl.innerHTML = shown
      .map(
        (skill) => `
        <label class="skill-library-row${skill.installed ? ' installed' : ''}">
          <input type="checkbox" class="lib-skill-cb" value="${escapeHtml(skill.slug)}" ${skill.installed ? 'disabled' : ''} />
          <span class="skill-library-copy">
            <strong>${escapeHtml(skill.slug)}</strong>
            ${skill.installed ? '<span class="card-tag">Installed</span>' : ''}
            <span class="status-sub">${escapeHtml(skill.description || 'No description')}</span>
          </span>
        </label>`
      )
      .join('');
    listEl.querySelectorAll('.lib-skill-cb').forEach((cb) => cb.addEventListener('change', updateImportButton));
  };

  const renderTabs = () => {
    tabRow.innerHTML = sources
      .map((source) => {
        const fresh = source.skills.filter((skill) => !skill.installed).length;
        return `<button type="button" class="skill-library-tab${source.id === activeId ? ' active' : ''}" data-source="${escapeHtml(source.id)}">${escapeHtml(source.label)} <span>${fresh}</span></button>`;
      })
      .join('');
    tabRow.querySelectorAll('.skill-library-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeId = btn.dataset.source;
        renderTabs();
        renderList();
        updateImportButton();
      });
    });
  };

  importBtn.disabled = true;
  importBtn.textContent = 'Import selected';
  importBtn.onclick = async () => {
    const names = $$('.lib-skill-cb:checked').map((cb) => cb.value);
    if (names.length === 0) return;
    importBtn.disabled = true;
    importBtn.textContent = 'Importing...';
    try {
      const imp = await apiRequest('/api/skills/import-external', {
        method: 'POST',
        body: JSON.stringify({ sourceId: activeId, names }),
      });
      closeModal();
      await loadSkills();
      showToast(`Imported ${imp.imported.length} skill${imp.imported.length === 1 ? '' : 's'}`);
    } catch (err) {
      showToast(err.message);
      importBtn.disabled = false;
      updateImportButton();
    }
  };

  $('#m-cancel').onclick = closeModal;
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = searchInput.value.trim();
      renderList();
      updateImportButton();
    }, 120);
  });
  renderTabs();
  renderList();
  updateImportButton();
}

async function refreshHealth() {
  const data = await apiRequest('/api/health');
  state.health = data;
  state.config = data.config;
  state.configuredKeys = data.configuredKeys;
  state.presets = data.presets;
  renderSidebarStatus();
  updateHeaderControls();
  if (state.view === 'settings') renderSettingsView();
  else if (state.view === 'dashboard') renderDashboard();
  else if (state.view === 'monitor') renderMonitor();
}

async function unloadOllamaMemory() {
  try {
    showToast('Unloading resident Ollama models…');
    const res = await apiRequest('/api/models/ollama/unload', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await Promise.all([refreshHealth(), refreshSystemMetrics()]);
    const count = Array.isArray(res.unloaded) ? res.unloaded.length : 0;
    showToast(count > 0 ? `Unloaded ${res.unloaded.join(', ')} (RAM freed)` : 'No Ollama models were loaded');
  } catch (err) {
    showToast(err.message || 'Could not unload Ollama models');
  }
}

const PALETTE_ACTION_ITEMS = [
  { label: 'New task', hint: 'Start a fresh conversation', keywords: 'create session new chat', run: () => createNewTask() },
  { label: 'Go to Dashboard', hint: 'Clock, agenda, and Mac stats', keywords: 'view dashboard home clock', run: () => switchView('dashboard') },
  { label: 'Go to Agent', hint: 'Return to the chat timeline', keywords: 'view chat', run: () => switchView('agent') },
  { label: 'Go to System Monitor', hint: 'CPU, memory, GPU, storage, processes', keywords: 'view monitor cpu memory gpu task manager', run: () => switchView('monitor') },
  { label: 'Go to Timetable', hint: 'Weekly schedule and reminders', keywords: 'view timetable schedule agenda', run: () => switchView('schedule') },
  { label: 'Go to Skills & Knowledge', hint: 'Manage skills, memory, and docs', keywords: 'view skills knowledge', run: () => switchView('skills') },
  { label: 'Go to Automations', hint: 'Saved workflows and schedules', keywords: 'view jobs launchd', run: () => switchView('automations') },
  { label: 'Go to Models & Settings', hint: 'Providers, models, runtime', keywords: 'view settings config', run: () => switchView('settings') },
  { label: 'Toggle sidebar', hint: 'Hide or show task history for a focused chat', keywords: 'sidebar collapse expand focus layout', run: () => toggleSidebar() },
  { label: 'Import skill from GitHub', hint: 'Paste a SKILL.md or GitHub link', keywords: 'skill install github url', run: () => openImportUrlModal() },
  { label: 'Open Skill Library', hint: 'Copy skills installed on this Mac', keywords: 'skills import library', run: () => openSkillLibraryModal() },
  { label: 'Create new skill', hint: 'Write a reusable SKILL.md', keywords: 'skills teach new', run: () => openSkillModal(null) },
  { label: 'New knowledge doc', hint: 'Save notes, preferences, or reference material', keywords: 'knowledge memory new', run: () => openKnowledgeModal(null) },
  { label: 'Create automation', hint: 'Save a workflow for one-click or scheduled runs', keywords: 'automation workflow schedule new', run: () => openAutomationModal() },
  { label: 'Unload Ollama models (Free RAM)', hint: 'Evict resident local models from Apple Silicon GPU memory', keywords: 'ollama unload free ram memory swap', run: () => unloadOllamaMemory() },
  { label: 'Toggle Deep Think', hint: 'Slower, more deliberate reasoning', keywords: 'thinking model reasoning', run: () => $('#thinking-toggle').click() },
  { label: 'Toggle Safety mode', hint: 'Switch Ask / Auto command approval', keywords: 'safety approval auto', run: () => $('#safety-toggle').click() },
  { label: 'Compact conversation', hint: 'Summarize older turns to free context', keywords: 'context tokens compact summarize', run: () => $('#compact-btn').click() },
  { label: 'Export conversation', hint: 'Download the current chat as Markdown', keywords: 'download markdown save export', run: () => $('#export-chat-btn').click() },
  { label: 'Inspect Self-Learned Fixes', hint: 'View and edit LEARNED_FIXES.md mistake prevention rules', keywords: 'learned fixes self-improve rules mistakes', run: () => openLearnedFixesEditor() },
  { label: 'Reset Self-Learned Fixes', hint: 'Restore LEARNED_FIXES.md to clean baseline rules', keywords: 'reset learned fixes self-improve rules', run: () => resetLearnedFixesRules() },
  { label: 'Keyboard shortcuts', hint: 'Show every shortcut', keywords: 'help keys hotkeys', run: () => openShortcutsModal() },
];

function paletteGroups() {
  const sessionItems = state.sessions.slice(0, 40).map((session) => ({
    label: session.title || 'Untitled task',
    hint: `${session.messageCount || 0} messages${session.updatedAt ? ` · ${new Date(session.updatedAt).toLocaleDateString()}` : ''}`,
    badge: session.source === 'scheduled' ? 'Auto' : '',
    keywords: session.title || '',
    run: () => openSession(session.id),
  }));

  const skillItems = state.skills.map((skill) => ({
    label: skill.slug,
    hint: skill.description || '',
    badge: skill.source ? 'Imported' : skill.isStarter ? 'Starter' : 'Learned',
    keywords: `${skill.slug} ${skill.description || ''}`,
    run: async () => {
      const res = await apiRequest(`/api/skills/${encodeURIComponent(skill.slug)}`);
      openSkillModal(res.skill);
    },
  }));

  const knowledgeItems = state.knowledge.map((doc) => ({
    label: doc.title || doc.name,
    hint: `ID: ${doc.name}${doc.tags?.length ? ` · ${doc.tags.join(', ')}` : ''}`,
    badge: doc.name === 'MEMORY' ? 'Memory' : doc.name === 'LEARNED_FIXES' ? 'Auto' : '',
    keywords: `${doc.name} ${doc.title || ''} ${(doc.tags || []).join(' ')}`,
    run: async () => {
      const res = await apiRequest(`/api/knowledge/${encodeURIComponent(doc.name)}`);
      openKnowledgeModal(res.doc);
    },
  }));

  return [
    { id: 'actions', label: 'Actions', items: PALETTE_ACTION_ITEMS },
    { id: 'sessions', label: 'Tasks', items: sessionItems, limit: 6 },
    { id: 'skills', label: 'Skills', items: skillItems, limit: 6 },
    { id: 'knowledge', label: 'Knowledge', items: knowledgeItems, limit: 5 },
  ];
}

function renderPalette(query = '') {
  state.paletteItems = buildPaletteItems({
    query,
    groups: paletteGroups(),
    limits: { actions: 10 },
  });
  if (state.paletteIndex >= state.paletteItems.length) {
    state.paletteIndex = Math.max(0, state.paletteItems.length - 1);
  }

  const results = $('#palette-results');
  if (!results) return;
  if (state.paletteItems.length === 0) {
    results.innerHTML = '<div class="palette-empty">No matching tasks, skills, docs, or commands.</div>';
    return;
  }

  let html = '';
  let lastGroup = '';
  state.paletteItems.forEach((item, idx) => {
    if (item.group !== lastGroup) {
      html += `<div class="palette-group">${escapeHtml(item.group)}</div>`;
      lastGroup = item.group;
    }
    html += `
      <button type="button" id="palette-opt-${idx}" class="palette-item${idx === state.paletteIndex ? ' active' : ''}" data-idx="${idx}" role="option" aria-selected="${idx === state.paletteIndex}">
        <span class="palette-item-main">
          <span class="palette-item-label">${escapeHtml(item.label)}</span>
          ${item.hint ? `<span class="palette-item-hint">${escapeHtml(item.hint)}</span>` : ''}
        </span>
        ${item.badge ? `<span class="palette-badge">${escapeHtml(item.badge)}</span>` : ''}
      </button>`;
  });
  results.innerHTML = html;
  results.querySelectorAll('.palette-item').forEach((btn) => {
    btn.addEventListener('click', () => runPaletteItem(Number(btn.dataset.idx)));
  });
  results.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  const paletteInput = $('#palette-input');
  if (paletteInput) {
    if (state.paletteItems.length > 0) {
      paletteInput.setAttribute('aria-activedescendant', `palette-opt-${state.paletteIndex}`);
    } else {
      paletteInput.removeAttribute('aria-activedescendant');
    }
  }
}

async function runPaletteItem(index) {
  const item = state.paletteItems[index];
  if (!item) return;
  closeCommandPalette();
  try {
    await item.run();
  } catch (err) {
    showToast(err.message);
  }
}

function movePalette(delta) {
  if (state.paletteItems.length === 0) return;
  state.paletteIndex =
    (state.paletteIndex + delta + state.paletteItems.length) % state.paletteItems.length;
  renderPalette($('#palette-input').value.trim());
}

async function openCommandPalette() {
  if (!$('#modal-backdrop').classList.contains('hidden')) closeModal();
  state.paletteOpen = true;
  state.paletteIndex = 0;
  $('#palette-backdrop').classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  input.setAttribute('aria-expanded', 'true');
  renderPalette('');
  setTimeout(() => input.focus(), 0);

  const jobs = [];
  if (state.skills.length === 0) {
    jobs.push(
      apiRequest('/api/skills').then((res) => {
        state.skills = res.skills || [];
      })
    );
  }
  if (state.knowledge.length === 0) {
    jobs.push(
      apiRequest('/api/knowledge').then((res) => {
        state.knowledge = res.docs || [];
      })
    );
  }
  if (jobs.length > 0) {
    await Promise.all(jobs).catch(() => {});
    if (state.paletteOpen) renderPalette($('#palette-input').value.trim());
  }
}

function closeCommandPalette() {
  state.paletteOpen = false;
  state.paletteItems = [];
  state.paletteIndex = 0;
  $('#palette-backdrop').classList.add('hidden');
  $('#palette-results').innerHTML = '';
  const input = $('#palette-input');
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
}

function toggleCommandPalette() {
  if (state.paletteOpen) closeCommandPalette();
  else openCommandPalette();
}

function openShortcutsModal() {
  const rows = [
    ['Command palette', ['⌘', 'K']],
    ['Dashboard / Agent / Monitor / Timetable', ['⌘', '1-4']],
    ['Toggle sidebar', ['⌘', '\\']],
    ['Send message', ['⌘', '↵']],
    ['Export conversation', ['⌘', '⇧', 'E']],
    ['Keyboard shortcuts', ['⌘', '/']],
    ['Navigate palette', ['↑', '↓']],
    ['Open highlighted result', ['↵']],
    ['Close palette or dialog', ['Esc']],
  ];
  openModal(
    'Keyboard Shortcuts',
    `<div class="shortcut-list">${rows
      .map(
        ([label, keys]) =>
          `<div class="shortcut-row"><span>${escapeHtml(label)}</span><span>${keys
            .map((key) => `<kbd>${escapeHtml(key)}</kbd>`)
            .join('')}</span></div>`
      )
      .join('')}</div>
    <p class="section-hint">Shortcuts work while typing. Esc closes the palette first, then any open dialog.</p>`
  );
}

function wireEvents() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $$('.seg-btn[data-subtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.subtab = btn.dataset.subtab;
      $$('.seg-btn[data-subtab]').forEach((b) => b.classList.toggle('active', b === btn));
      $$('.subtab').forEach((t) => t.classList.toggle('active', t.id === `subtab-${state.subtab}`));
    });
  });

  // Dashboard, monitor, and timetable controls
  $('#monitor-refresh-btn')?.addEventListener('click', () => refreshSystemMetrics());
  $('#monitor-autorefresh')?.addEventListener('change', () => updateMonitorAutoRefresh());
  $('#sched-refresh-btn')?.addEventListener('click', () => loadSchedule());
  $('#dash-open-timetable')?.addEventListener('click', () => switchView('schedule'));
  $('#dash-open-monitor')?.addEventListener('click', () => switchView('monitor'));
  $('#dash-add-event')?.addEventListener('click', () => {
    switchView('schedule');
    $('#sched-title')?.focus();
  });
  $('#dash-set-reminder')?.addEventListener('click', () => {
    const form = $('#quick-reminder-form');
    const btn = $('#dash-set-reminder');
    const willShow = form?.classList.contains('hidden');
    form?.classList.toggle('hidden', !willShow);
    btn?.setAttribute('aria-expanded', String(Boolean(willShow)));
    if (willShow) $('#reminder-minutes')?.focus();
  });

  $('#quick-reminder-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const minutes = Number($('#reminder-minutes').value);
    const message = $('#reminder-message').value.trim();
    if (!Number.isFinite(minutes) || minutes <= 0 || !message) {
      showToast('Enter minutes and a message.');
      return;
    }
    try {
      const data = await apiRequest('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes, message }),
      });
      $('#reminder-message').value = '';
      $('#quick-reminder-form').classList.add('hidden');
      $('#dash-set-reminder')?.setAttribute('aria-expanded', 'false');
      showToast(data.output || 'Reminder set');
    } catch (err) {
      showToast(err.message || 'Could not set the reminder.');
    }
  });
  $('#dash-new-task')?.addEventListener('click', () => $('#new-task-btn')?.click());
  $('#dash-open-settings')?.addEventListener('click', () => switchView('settings'));
  $('#dash-unload-ram-btn')?.addEventListener('click', unloadOllamaMemory);
  $('#monitor-unload-btn')?.addEventListener('click', unloadOllamaMemory);
  $('#dash-quick-ask-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const qInput = $('#dash-quick-ask-input');
    const promptText = qInput?.value.trim() || '';
    if (!promptText) return;
    qInput.value = '';
    await createNewTask();
    await sendPrompt({ text: promptText, attachments: [] });
  });

  $$('.mon-sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.monitorProcessSort = btn.dataset.sort === 'memory' ? 'memory' : 'cpu';
      $$('.mon-sort-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderMonitor();
    });
  });

  const setScheduleFormMode = (mode) => {
    state.scheduleFormMode = mode === 'once' ? 'once' : 'weekly';
    $$('.sched-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.scheduleFormMode));
    $('#sched-days-fieldset')?.classList.toggle('hidden', state.scheduleFormMode === 'once');
    $('#sched-date-field')?.classList.toggle('hidden', state.scheduleFormMode !== 'once');
    const dateInput = $('#sched-date');
    if (state.scheduleFormMode === 'once' && dateInput && !dateInput.value) {
      const d = new Date();
      dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  };
  $$('.sched-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setScheduleFormMode(btn.dataset.mode));
  });

  $('#agenda-save-btn')?.addEventListener('click', async () => {
    try {
      const res = await apiRequest('/api/models/config', {
        method: 'POST',
        body: JSON.stringify({
          agendaNotifications: $('#agenda-notifications').checked,
          agendaLeadMinutes: Number($('#agenda-lead').value) || 5,
        }),
      });
      state.config = res.config;
      showToast('Agenda nudges updated');
    } catch (err) {
      showToast(err.message || 'Could not save the agenda settings.');
    }
  });

  $('#schedule-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#sched-title').value.trim();
    const time = $('#sched-time').value;
    const durationMin = Number($('#sched-duration').value) || 30;
    const notes = $('#sched-notes').value.trim();
    if (!title || !time) {
      showToast('Enter a title and a start time.');
      return;
    }
    let payload;
    if (state.scheduleFormMode === 'once') {
      const date = $('#sched-date')?.value || '';
      if (!date) {
        showToast('Pick a date for this one-off entry.');
        return;
      }
      payload = { title, time, date, durationMin, notes };
    } else {
      const days = $$('input[name="sched-day"]:checked').map((el) => Number(el.value));
      if (days.length === 0) {
        showToast('Pick at least one weekday.');
        return;
      }
      payload = { title, time, days, durationMin, notes };
    }
    try {
      await apiRequest('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      $('#sched-title').value = '';
      $('#sched-notes').value = '';
      showToast('Timetable entry saved');
      await loadSchedule();
    } catch (err) {
      showToast(err.message || 'Could not save the entry.');
    }
  });

  $('#schedule-week')?.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('.week-delete');
    if (!delBtn) return;
    try {
      await apiRequest(`/api/schedule/${encodeURIComponent(delBtn.dataset.id)}`, { method: 'DELETE' });
      showToast('Entry removed');
      await loadSchedule();
    } catch (err) {
      showToast(err.message || 'Could not remove the entry.');
    }
  });

  // Single delegated event listener on #chat-messages so buttons work smoothly even while streaming
  $('#chat-messages').addEventListener('click', async (e) => {
    const copyCodeBtn = e.target.closest('.copy-code-btn');
    if (copyCodeBtn) {
      navigator.clipboard.writeText(copyCodeBtn.dataset.code || '');
      showToast('Code copied');
      return;
    }

    const copyReplyBtn = e.target.closest('.copy-reply-btn');
    if (copyReplyBtn) {
      const target = state.displayedItems[Number(copyReplyBtn.dataset.idx)];
      navigator.clipboard.writeText(target?.content || '');
      showToast('Reply copied');
      return;
    }

    const teachBtn = e.target.closest('.teach-skill-btn');
    if (teachBtn) {
      $('#prompt-input').value =
        'Distill the exact working workflow we just completed into a reusable SKILL.md using save_skill.';
      sendPrompt();
      return;
    }

    const saveAutoBtn = e.target.closest('.save-auto-btn');
    if (saveAutoBtn) {
      const lastUser = [...(state.activeSession?.messages || [])].reverse().find((m) => m.role === 'user');
      openAutomationModal({ name: state.activeSession?.title || '', prompt: lastUser?.content || '' });
      return;
    }

    const retryBtn = e.target.closest('.retry-turn-btn');
    if (retryBtn) {
      const lastUser = [...(state.activeSession?.messages || [])].reverse().find((m) => m.role === 'user');
      if (lastUser?.content) {
        $('#prompt-input').value = lastUser.content;
        await sendPrompt();
      }
      return;
    }

    const approveBtn = e.target.closest('.approve-btn');
    if (approveBtn) {
      const toolCallId = approveBtn.dataset.toolId;
      const panel = approveBtn.closest('.approval-panel');
      const editedInput = panel?.querySelector('.approval-cmd-edit');
      const editedCommand = editedInput ? editedInput.value : undefined;
      await resolveApproval(toolCallId, true, editedCommand);
      return;
    }

    const denyBtn = e.target.closest('.deny-btn');
    if (denyBtn) {
      await resolveApproval(denyBtn.dataset.toolId, false);
    }
  });

  $('#new-task-btn').addEventListener('click', createNewTask);
  $('#sidebar-toggle').addEventListener('click', toggleSidebar);
  $('#sidebar-expand-fab')?.addEventListener('click', toggleSidebar);
  let sessionSearchTimer = null;
  $('#session-search').addEventListener('input', (e) => {
    const query = e.target.value.trim();
    clearTimeout(sessionSearchTimer);
    sessionSearchTimer = setTimeout(async () => {
      if (query.length < 2) {
        await loadSessions();
        return;
      }
      try {
        await runSessionSearch(query);
      } catch (err) {
        showToast(err.message);
      }
    }, 220);
  });
  $('#skills-search').addEventListener('input', renderSkillsGrid);
  $('#knowledge-search').addEventListener('input', renderKnowledgeGrid);

  $('#model-picker-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('#model-popover');
    const wasHidden = pop.classList.contains('hidden');
    if (wasHidden) {
      renderModelPopover();
      pop.classList.remove('hidden');
    } else {
      pop.classList.add('hidden');
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#model-popover') && !e.target.closest('#model-picker-btn')) {
      $('#model-popover').classList.add('hidden');
    }
  });

  $('#thinking-toggle').addEventListener('click', async () => {
    const res = await apiRequest('/api/models/config', {
      method: 'POST',
      body: JSON.stringify({ thinking: !state.config.thinking }),
    });
    state.config = res.config;
    updateHeaderControls();
  });

  $('#safety-toggle').addEventListener('click', async () => {
    const next = state.config.safetyMode === 'auto' ? 'ask' : 'auto';
    const res = await apiRequest('/api/models/config', {
      method: 'POST',
      body: JSON.stringify({ safetyMode: next }),
    });
    state.config = res.config;
    updateHeaderControls();
  });

  $('#compact-btn').addEventListener('click', async () => {
    if (!state.activeSession) return;
    const res = await apiRequest(`/api/sessions/${encodeURIComponent(state.activeSession.id)}/compact`, {
      method: 'POST',
    });
    state.activeSession = res.session;
    state.contextTokens = estimateTokens(state.activeSession.messages || []);
    updateContextMeter(state.contextTokens, state.config?.numCtx);
    renderMessages();
    showToast(res.compacted ? 'Conversation compacted' : 'Context is already compact');
  });

  const promptInput = $('#prompt-input');
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
  });
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  $('#send-btn').addEventListener('click', () => sendPrompt());
  $('#stop-btn').addEventListener('click', async () => {
    state.runAbort?.abort();
    const targetId = state.runningSessionId || state.activeSession?.id;
    if (targetId) {
      await apiRequest(`/api/sessions/${encodeURIComponent(targetId)}/cancel`, { method: 'POST' }).catch(() => {});
    }
  });
  $('#queued-now-btn').addEventListener('click', async () => {
    if (!state.queuedMessages || state.queuedMessages.length === 0) return;
    state.runAbort?.abort();
    const targetId = state.runningSessionId || state.activeSession?.id;
    if (targetId) {
      await apiRequest(`/api/sessions/${encodeURIComponent(targetId)}/cancel`, { method: 'POST' }).catch(() => {});
    }
  });
  $('#queued-cancel-btn').addEventListener('click', () => {
    state.queuedMessages = [];
    renderQueuedBar();
  });

  $$('.quick-card').forEach((card) => {
    card.addEventListener('click', () => {
      promptInput.value = card.dataset.prompt || '';
      promptInput.style.height = 'auto';
      promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
      promptInput.focus();
    });
  });

  $('#attach-btn').addEventListener('click', () => {
    if (hasSwiftBridge()) {
      postSwiftAction('pickFiles');
    } else {
      $('#browser-file-input').click();
    }
  });

  $('#browser-file-input').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    window.__lgReceiveFiles(files.map((f) => f.path || f.name));
  });

  const dropzone = $('#composer-dropzone');
  const overlay = $('#drop-overlay');
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    overlay.classList.remove('hidden');
  });
  dropzone.addEventListener('dragleave', (e) => {
    if (!dropzone.contains(e.relatedTarget)) overlay.classList.add('hidden');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    overlay.classList.add('hidden');
    const files = Array.from(e.dataTransfer?.files || []);
    const paths = files.map((f) => f.path || f.name).filter(Boolean);
    if (paths.length > 0) window.__lgReceiveFiles(paths);
  });

  $('#new-skill-btn').addEventListener('click', () => openSkillModal(null));
  $('#import-url-btn').addEventListener('click', openImportUrlModal);
  $('#skill-library-btn').addEventListener('click', openSkillLibraryModal);
  $('#open-learned-fixes-btn')?.addEventListener('click', openLearnedFixesEditor);
  $('#reset-learned-fixes-btn')?.addEventListener('click', resetLearnedFixesRules);
  $('#new-knowledge-btn').addEventListener('click', () => openKnowledgeModal(null));
  $('#upload-knowledge-btn').addEventListener('click', () => $('#knowledge-file-input').click());
  $('#import-know-url-btn').addEventListener('click', openKnowledgeUrlModal);
  $('#export-chat-btn').addEventListener('click', exportActiveConversation);
  $('#knowledge-file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const content = await file.text();
      await apiRequest('/api/knowledge/upload', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, content }),
      });
    }
    e.target.value = '';
    await loadKnowledge();
    showToast(`Uploaded ${files.length} knowledge doc(s)`);
  });

  $('#new-automation-btn').addEventListener('click', () => openAutomationModal());
  $('#modal-close-btn').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('#modal-backdrop')) closeModal();
  });

  $('#num-ctx-select').addEventListener('change', async (e) => {
    const res = await apiRequest('/api/models/config', {
      method: 'POST',
      body: JSON.stringify({ numCtx: Number(e.target.value) }),
    });
    state.config = res.config;
    showToast(`Context budget set to ${e.target.value}`);
  });

  $('#start-ollama-btn').addEventListener('click', async () => {
    showToast('Checking Ollama...');
    try {
      await apiRequest('/api/models/ollama/start', { method: 'POST' });
      await refreshHealth();
      showToast('Ollama is running');
    } catch (err) {
      showToast(err.message);
    }
  });

  $('#unload-ollama-btn')?.addEventListener('click', unloadOllamaMemory);

  const doPull = async (modelName) => {
    const tag = modelName.trim();
    if (!tag) return;
    const progEl = $('#pull-progress');
    progEl.classList.remove('hidden');
    progEl.textContent = `Pulling ${tag}...`;
    try {
      await streamSse('/api/models/ollama/pull', { name: tag }, (evt) => {
        if (evt.error) {
          progEl.textContent = `Error: ${evt.error}`;
          return;
        }
        if (evt.total && evt.completed !== undefined) {
          const pct = Math.round((evt.completed / evt.total) * 100);
          progEl.textContent = `${evt.status || 'Downloading'}: ${pct}% (${formatBytes(evt.completed)} / ${formatBytes(evt.total)})`;
        } else if (evt.status) {
          progEl.textContent = evt.status;
        }
      });
      await refreshHealth();
      showToast(`Installed ${tag}`);
    } catch (err) {
      progEl.textContent = `Failed: ${err.message}`;
    }
  };

  $('#pull-model-btn').addEventListener('click', () => doPull($('#pull-model-input').value));
  $$('.pull-preset').forEach((b) => {
    b.addEventListener('click', () => {
      $('#pull-model-input').value = b.dataset.model;
      doPull(b.dataset.model);
    });
  });

  $$('.copy-code-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.code || '');
      showToast('Command copied');
    });
  });

  // Command palette and global shortcuts
  $('#palette-open-btn').addEventListener('click', openCommandPalette);
  $('#palette-close-btn').addEventListener('click', closeCommandPalette);
  $('#palette-shortcuts-btn').addEventListener('click', () => {
    closeCommandPalette();
    openShortcutsModal();
  });
  $('#palette-backdrop').addEventListener('click', (e) => {
    if (e.target === $('#palette-backdrop')) closeCommandPalette();
  });
  $('#palette-input').addEventListener('input', (e) => {
    state.paletteIndex = 0;
    renderPalette(e.target.value.trim());
  });
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      movePalette(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      movePalette(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      runPaletteItem(state.paletteIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCommandPalette();
    }
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = String(e.key || '').toLowerCase();
    if (mod && key === 'k') {
      e.preventDefault();
      toggleCommandPalette();
      return;
    }
    if (mod && key === '\\') {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    const viewShortcut = { '1': 'dashboard', '2': 'agent', '3': 'monitor', '4': 'schedule' }[e.key];
    if (mod && viewShortcut) {
      e.preventDefault();
      switchView(viewShortcut);
      return;
    }
    if (mod && key === '/') {
      e.preventDefault();
      if (state.paletteOpen) closeCommandPalette();
      openShortcutsModal();
      return;
    }
    if (mod && e.shiftKey && key === 'e') {
      e.preventDefault();
      $('#export-chat-btn').click();
      return;
    }
    if (mod && e.key === 'Enter' && !state.paletteOpen) {
      const active = document.activeElement;
      if (active === $('#prompt-input') || active === document.body) {
        e.preventDefault();
        sendPrompt();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (state.paletteOpen) {
        e.preventDefault();
        closeCommandPalette();
        return;
      }
      if (!$('#modal-backdrop').classList.contains('hidden')) {
        e.preventDefault();
        closeModal();
      }
    }
  });

  $('#chat-scroll').addEventListener('scroll', updateScrollButton, { passive: true });
  $('#scroll-bottom-btn').addEventListener('click', () => {
    scrollToBottomIfPinned(true);
    updateScrollButton();
  });

  window.addEventListener('focus', () => {
    if (!state.sessionSearchQuery) {
      loadSessions().catch(() => {});
    }
  });
}

async function init() {
  try {
    setSidebarCollapsed(localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1', false);
  } catch {
    setSidebarCollapsed(false, false);
  }
  wireEvents();
  tickClock();
  setInterval(tickClock, 1000);
  await Promise.all([refreshHealth(), loadSessions()]);
  renderMessages(true);
  switchView('dashboard');
}

init().catch((err) => showToast(err.message));
