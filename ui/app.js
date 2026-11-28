import { apiRequest, hasSwiftBridge, postSwiftAction, setAuthToken, streamSse } from './lib/api.js';
import { escapeHtml, highlightCode, renderMarkdown } from './lib/markdown.js';
import { shouldRenderStreamingMarkdown } from './lib/streaming.js';
import { createOllamaWarmupRequester } from './lib/ollama-warmup.js';
import { describeRuntimeState, getLivePhase } from './lib/live-status.js';
import { buildPaletteItems } from './lib/palette.js';
import { debounce } from './lib/utils.js';
import { getPerformanceMetrics, perfSummary, recordLatency, recordTokenUsage, getModelSpeeds, recordModelSpeed } from './lib/performance.js';
import {
  renderMemoryDonut,
  renderNetworkDonut,
  renderNetworkHistoryChart,
  renderMultiSeriesChart,
  renderSparkline,
  renderWeeklyScheduleChart,
} from './lib/charts.js';
import {
  formatClockDate,
  formatClockTime,
  formatMinutesUntil,
  formatUptime,
  greetingFor,
  isStorageLow,
  metricsPollDelay,
  nextEntryFrom,
  usageTone,
} from './lib/dashboard.js';

const SIDEBAR_STORAGE_KEY = 'lg-sidebar-collapsed';
const THEME_STORAGE_KEY = 'lg-theme';

const TASK_STARTERS = [
  {
    id: 'mac-storage',
    cat: 'mac',
    catLabel: 'Mac & Files',
    title: 'Organize Mac storage & caches',
    desc: 'Inspect ~/Downloads, Desktop & heavy folders with a safe dry-run plan',
    prompt: 'Audit my Mac storage and show me what is taking up space in ~/Downloads, ~/Desktop, and safe developer caches (read-only dry run first).',
  },
  {
    id: 'spotlight-find',
    cat: 'mac',
    catLabel: 'Mac & Files',
    title: 'Find files anywhere with Spotlight',
    desc: 'Instant mdfind lookup across PDFs, decks, invoices, and projects',
    prompt: 'Use spotlight_search to find the files I ask for next across my Mac: ',
  },
  {
    id: 'memory-audit',
    cat: 'mac',
    catLabel: 'Mac & Files',
    title: 'Diagnose RAM, swap & heavy apps',
    desc: 'Snapshot CPU hogs, unified RAM pressure, and speed wins',
    prompt: 'Run system_stats (with top processes) and check swap pressure, GPU RAM, and CPU hogs. Recommend 3 specific ways to speed up this Mac right now.',
  },
  {
    id: 'review-code',
    cat: 'code',
    catLabel: 'Code',
    title: 'Review git diff & catch bugs',
    desc: 'Inspect local repository changes, run tests, and highlight risks',
    prompt: 'Inspect the current repository git status and recent diff, check for bugs or edge cases, and run the project check command.',
  },
  {
    id: 'write-tests',
    cat: 'code',
    catLabel: 'Code',
    title: 'Write unit & regression tests',
    desc: 'Follow Red-Green-Refactor cleanly with verifiable edge cases',
    prompt: 'Read the module I point you to next and write clean regression tests covering edge cases: ',
  },
  {
    id: 'screen-inspect',
    cat: 'media',
    catLabel: 'Media & Screen',
    title: 'Inspect what is on my screen',
    desc: 'Take a screenshot right now and analyze UI, errors, or layout',
    prompt: 'Take a screenshot of my screen right now using take_screenshot and explain what you see or highlight any issues.',
  },
  {
    id: 'edit-media',
    cat: 'media',
    catLabel: 'Media & Screen',
    title: 'Edit video or photo with verification',
    desc: 'Trim, reframe 9:16 for Reels/Shorts, compress, and inspect frames',
    prompt: 'Help me inspect and edit a video or photo using ffmpeg/ImageMagick with visual before-and-after verification.',
  },
  {
    id: 'humanize-clip',
    cat: 'write',
    catLabel: 'Writing',
    title: 'Humanize & polish clipboard text',
    desc: 'Read macOS clipboard, remove robotic tone, and copy back cleanly',
    prompt: 'Read my macOS clipboard using paste_from_clipboard, rewrite it to sound natural and direct without AI clichés, and copy the improved text back with copy_to_clipboard.',
  },
  {
    id: 'apple-notes',
    cat: 'write',
    catLabel: 'Writing',
    title: 'Search or draft Apple Notes',
    desc: 'Read existing notes or capture structured ideas into Apple Notes',
    prompt: 'List my recent Apple Notes using manage_notes and help me organize or draft a note about: ',
  },
  {
    id: 'web-research',
    cat: 'daily',
    catLabel: 'Daily & Web',
    title: 'Research topic on the live web',
    desc: 'Run DuckDuckGo web search + summarize sources cleanly',
    prompt: 'Use search_web to research the following topic and present a concise summary with clickable URLs: ',
  },
  {
    id: 'plan-day',
    cat: 'daily',
    catLabel: 'Daily & Web',
    title: 'Plan today & schedule blocks',
    desc: 'Read timetable, review free slots, and add deep-focus blocks',
    prompt: 'Check list_schedule_items (today_only: true) and help me organize deep-focus blocks for today.',
  },
  {
    id: 'teach-skill',
    cat: 'code',
    catLabel: 'Skills',
    title: 'Teach a reusable SKILL.md',
    desc: 'Turn any repeatable prompt or script into a permanent skill',
    prompt: 'Let us create a new reusable SKILL.md workflow using save_skill for the task I describe next: ',
  },
];

// Deterministic on-device lookups that answer instantly with no model inference.
const INSTANT_ACTIONS = [
  { id: 'system_health', label: 'System health', desc: 'CPU, memory, GPU, disk and top processes' },
  { id: 'storage_audit', label: 'Storage & clutter', desc: 'What is taking up space in Downloads, Desktop and Documents' },
  { id: 'large_files', label: 'Largest files', desc: 'Biggest files in Downloads and Desktop to review and clean' },
  { id: 'clipboard_read', label: 'Read clipboard', desc: 'Show what is on the macOS clipboard' },
  { id: 'schedule_today', label: 'Today’s schedule', desc: 'Timetable entries for today' },
  { id: 'organize_plan', label: 'Organize preview', desc: 'Preview how loose files would sort, without moving anything' },
  { id: 'docker_ps', label: 'Docker status', desc: 'List running containers' },
  { id: 'top_processes', label: 'Memory & CPU hogs', desc: 'What is eating your RAM and CPU right now — close a big one to speed up the local AI' },
];

const SLASH_COMMANDS = [
  { cmd: '/health', desc: 'Audit CPU, swap, GPU RAM, storage & top processes', tag: 'Run', prompt: 'Run system_stats (with top processes) and check swap pressure, GPU RAM, and disk usage. Give me 3 concrete ways to speed up this Mac right now.', autoRun: true },
  { cmd: '/brief', desc: 'Morning briefing: today’s timetable + Mac health', tag: 'Run', prompt: 'Check list_schedule_items (today_only: true) and system_stats, then give me a crisp briefing for today.', autoRun: true },
  { cmd: '/screenshot', desc: 'Capture screen now & ask the agent to analyze it', tag: 'Run', prompt: 'Take a screenshot of my screen right now using take_screenshot and explain what you see.', autoRun: true },
  { cmd: '/clipboard', desc: 'Humanize & polish text currently on macOS clipboard', tag: 'Run', prompt: 'Read my macOS clipboard using paste_from_clipboard, rewrite it clearly without AI clichés, and copy the improved version back with copy_to_clipboard.', autoRun: true },
  { cmd: '/clean', desc: 'Read-only storage clutter audit across Downloads & Desktop', tag: 'Run', prompt: 'Audit ~/Downloads and ~/Desktop by size (read-only dry run first, do not move or delete anything yet).', autoRun: true },
  { cmd: '/web', desc: 'Search the live public web (search_web)', tag: 'Prompt', prompt: 'Use search_web to research: ', autoRun: false },
  { cmd: '/spotlight', desc: 'Find files anywhere on Mac via Spotlight (mdfind)', tag: 'Prompt', prompt: 'Use spotlight_search to find files matching: ', autoRun: false },
  { cmd: '/notes', desc: 'List, read, or create Apple Notes', tag: 'Prompt', prompt: 'Use manage_notes to check Apple Notes for: ', autoRun: false },
  { cmd: '/compact', desc: 'Compact conversation history to free context window', tag: 'Action', action: () => $('#compact-btn')?.click() },
  { cmd: '/export', desc: 'Export active conversation as Markdown', tag: 'Action', action: () => $('#export-chat-btn')?.click() },
  { cmd: '/unload', desc: 'Unload Ollama GPU models to immediately reclaim RAM', tag: 'Action', action: () => unloadOllamaMemory() },
  { cmd: '/clear', desc: 'Start a fresh blank task', tag: 'Action', action: () => createNewTask() },
];

const HUMAN_TOOL_META = {
  list_dir: { label: 'List Folder', summarize: (a) => a.path || '.' },
  read_file: { label: 'Read File', summarize: (a) => a.path ? String(a.path).split('/').pop() : '' },
  read_document: { label: 'Read Document', summarize: (a) => a.path ? String(a.path).split('/').pop() : '' },
  write_file: { label: 'Write File', summarize: (a) => a.path ? String(a.path).split('/').pop() : '' },
  edit_file: { label: 'Edit File', summarize: (a) => a.path ? String(a.path).split('/').pop() : '' },
  move_file: { label: 'Move File', summarize: (a) => `${String(a.source || '').split('/').pop()} → ${String(a.destination || '').split('/').pop()}` },
  undo_file_moves: { label: 'Undo File Moves', summarize: (a) => `${a.count || 1} move${(a.count || 1) === 1 ? '' : 's'}` },
  search_files: { label: 'Search Files', summarize: (a) => a.query || a.root || '' },
  spotlight_search: { label: 'Spotlight Search', summarize: (a) => a.query || '' },
  run_command: { label: 'Shell Command', summarize: (a) => String(a.command || '').split('\n')[0].slice(0, 48) },
  run_applescript: { label: 'AppleScript', summarize: () => 'osascript' },
  run_shortcut: { label: 'Apple Shortcut', summarize: (a) => a.name || '' },
  calculate: { label: 'Calculator', summarize: (a) => a.expression || '' },
  update_plan: { label: 'Task Plan', summarize: (a) => `${a.steps?.length || 0} steps` },
  inspect_media: { label: 'Inspect Media', summarize: (a) => a.path ? String(a.path).split('/').pop() : '' },
  download_media: { label: 'Download Media', summarize: (a) => a.url ? String(a.url).split('/').filter(Boolean).pop() || a.url : '' },
  take_screenshot: { label: 'Take Screenshot', summarize: (a) => a.mode || 'screen' },
  search_web: { label: 'Web Search', summarize: (a) => a.query || '' },
  fetch_url: { label: 'Fetch Page', summarize: (a) => a.url || '' },
  git_op: { label: 'Git Operation', summarize: (a) => `${a.action || 'status'}${a.message ? ` · ${a.message}` : ''}` },
  sqlite_query: { label: 'SQLite Query', summarize: (a) => a.db_path ? String(a.db_path).split('/').pop() : '' },
  docker_op: { label: 'Docker Monitor', summarize: (a) => `${a.action || 'ps'}${a.container_id ? ` · ${a.container_id.slice(0, 8)}` : ''}` },
  delegate_task: { label: 'Delegate Sub-task', summarize: (a) => a.task.slice(0, 50) },
  open_url: { label: 'Open URL', summarize: (a) => a.url || '' },
  copy_to_clipboard: { label: 'Copy to Clipboard', summarize: (a) => `${String(a.text || '').length} chars` },
  paste_from_clipboard: { label: 'Read Clipboard', summarize: () => 'pbpaste' },
  show_notification: { label: 'Notification', summarize: (a) => a.title || a.message || '' },
  open_app: { label: 'Open App', summarize: (a) => a.name || '' },
  manage_notes: { label: 'Apple Notes', summarize: (a) => `${a.action || 'list'}${a.title ? ` · ${a.title}` : ''}` },
  set_reminder: { label: 'Set Reminder', summarize: (a) => `${a.seconds || 0}s` },
  system_stats: { label: 'System Stats', summarize: () => 'CPU, RAM, GPU & Swap' },
  network_usage: { label: 'Network Usage', summarize: () => 'Data used per app & this month' },
  speed_test: { label: 'Speed Test', summarize: () => 'Live internet speed' },
  world_news: { label: 'World News', summarize: () => 'Top global headlines' },
  read_email: { label: 'Email', summarize: () => "Today's messages" },
  daily_briefing: { label: 'Daily Briefing', summarize: () => 'News, email & day summary' },
  large_files: { label: 'Largest Files', summarize: (a) => (Array.isArray(a.folders) && a.folders.length ? a.folders.join(', ') : 'Downloads, Desktop, Documents') },
  add_schedule_item: { label: 'Add Timetable Block', summarize: (a) => `${a.time || ''} ${a.title || ''}`.trim() },
  list_schedule_items: { label: 'Read Timetable', summarize: (a) => (a.today_only ? 'Today' : 'Full week') },
  remove_schedule_item: { label: 'Remove Block', summarize: (a) => a.id || '' },
  list_skills: { label: 'List Skills', summarize: () => '' },
  read_skill: { label: 'Load Skill', summarize: (a) => a.name || '' },
  save_skill: { label: 'Save Skill', summarize: (a) => a.name || '' },
  self_improve: { label: 'Self-Improve Rule', summarize: (a) => a.skill_name || 'LEARNED_FIXES.md' },
  list_knowledge: { label: 'List Knowledge', summarize: () => '' },
  search_knowledge: { label: 'Search Knowledge', summarize: (a) => a.query || '' },
  read_knowledge: { label: 'Read Knowledge', summarize: (a) => a.name || '' },
  save_knowledge: { label: 'Save Knowledge', summarize: (a) => a.name || '' },
};

const requestOllamaWarmup = createOllamaWarmupRequester(
  () =>
    apiRequest('/api/models/ollama/warm', {
      method: 'POST',
      body: '{}',
      priority: 'low',
    }),
  {
    getStatus: (model) =>
      apiRequest(`/api/models/ollama/warm/status?model=${encodeURIComponent(model)}`, { priority: 'low' }),
  }
);

const state = {
  view: 'dashboard',
  themeMode: 'auto',
  welcomeCategory: 'all',
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
  suggestions: [],
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
  collapsedToolGroups: new Set(),
  pendingApprovals: new Map(),
  contextTokens: 0,
  paletteOpen: false,
  paletteItems: [],
  paletteIndex: 0,
  slashOpen: false,
  slashItems: [],
  slashIndex: 0,
  metrics: null,
  metricsHistory: [],
  monitorChartSeries: 'all',
  monitorProcessSort: 'cpu',
  scheduleFormMode: 'weekly',
  schedule: [],
  scheduleToday: [],
  monitorTimer: null,
  activeArtifact: null,
  artifactsList: [],
  artifactDrawerOpen: false,
  editingMessageIndex: null,
  speakingMessageIndex: null,
  voiceRecognition: null,
  isListening: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showToast(msg) {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 200);
  }, 3200);
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

function applyTheme(mode = 'auto', persist = true) {
  const themes = ['dark', 'light', 'nord', 'solarized', 'cyberpunk', 'auto'];
  const valid = themes.includes(mode) ? mode : 'auto';
  state.themeMode = valid;
  if (valid === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = valid;

  const btn = $('#theme-toggle-btn');
  if (btn) {
    btn.textContent = valid.charAt(0).toUpperCase() + valid.slice(1);
    btn.title = `Theme: ${btn.textContent} (click to switch)`;
  }
  if (hasSwiftBridge()) {
    postSwiftAction('setTheme', { theme: valid });
  }
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, valid);
    } catch {
      // ignore storage failure
    }
  }
}

function cycleTheme() {
  const themes = ['auto', 'dark', 'light', 'nord', 'solarized', 'cyberpunk'];
  const idx = themes.indexOf(state.themeMode);
  const next = themes[(idx + 1) % themes.length];
  applyTheme(next, true);
  const labels = {
    auto: 'Auto (System)',
    dark: 'Graphite Dark',
    light: 'Paper Light',
    nord: 'Nordic Frost',
    solarized: 'Solarized Dark',
    cyberpunk: 'Synthwave Night',
  };
  showToast(`Theme: ${labels[next] || next}`);
}

function renderWelcomeTaskGrid() {
  const grid = $('#welcome-task-grid');
  if (!grid) return;
  const cat = state.welcomeCategory || 'all';
  const list =
    cat === 'all'
      ? TASK_STARTERS.slice(0, 6)
      : TASK_STARTERS.filter((item) => item.cat === cat);

  grid.innerHTML = list
    .map(
      (item) => `
      <button type="button" class="quick-card" data-starter-id="${escapeHtml(item.id)}" data-prompt="${escapeHtml(item.prompt)}">
        <div class="quick-card-top">
          <span class="quick-cat">${escapeHtml(item.catLabel)}</span>
        </div>
        <strong>${escapeHtml(item.title)}</strong>
        <span class="quick-card-desc">${escapeHtml(item.desc)}</span>
      </button>`
    )
    .join('');

  grid.querySelectorAll('.quick-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      const promptInput = $('#prompt-input');
      if (!promptInput) return;
      const text = card.dataset.prompt || '';
      promptInput.value = text;
      promptInput.style.height = 'auto';
      promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
      promptInput.focus();
      if (e.shiftKey && !text.endsWith(' ')) {
        sendPrompt();
      }
    });
  });
}

function renderInstantActions() {
  const row = $('#instant-actions-row');
  if (!row) return;
  row.innerHTML = INSTANT_ACTIONS.map(
    (a) => `
      <button type="button" class="instant-chip" data-instant-id="${escapeHtml(a.id)}" data-instant-label="${escapeHtml(a.label)}" title="${escapeHtml(a.desc)}">
        <span>${escapeHtml(a.label)}</span>
      </button>`
  ).join('');
  row.querySelectorAll('.instant-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      runInstantActionTurn(chip.dataset.instantId, chip.dataset.instantLabel);
    });
  });
}

function renderSidebarBadges() {
  $('#nav-agent-pulse')?.classList.toggle('hidden', !state.isRunning);
  const badge = $('#nav-agenda-badge');
  if (badge) {
    const now = new Date();
    const curMin = now.getHours() * 60 + now.getMinutes();
    const remaining = (state.scheduleToday || []).filter((e) => e.startMinutes + (e.durationMin || 0) > curMin).length;
    badge.textContent = String(remaining);
    badge.classList.toggle('hidden', remaining <= 0);
  }
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

function formatThinkingHtml(thinkingText, isOpen = false) {
  const clean = String(thinkingText || '').trim();
  if (!clean) return '';
  const steps = clean
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const innerHtml =
    steps.length > 1
      ? `<ol class="thinking-steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
      : escapeHtml(clean);
  const label = steps.length > 1 ? `Thinking · ${steps.length} steps` : 'Thinking';
  return `<details class="thinking-box" ${isOpen ? 'open' : ''}><summary>${label}</summary><div class="thinking-content">${innerHtml}</div></details>`;
}

window.__lgSetToken = (token) => setAuthToken(token);
window.__lgFileSaved = (savedPath) => {
  const base = String(savedPath || '').split('/').pop() || 'file';
  showToast(`Saved ${base}`);
};
window.__lgFolderPicked = async (folderPath) => {
  if (folderPath) {
    await setSessionWorkspaceCwd(folderPath).catch((err) => showToast(err.message));
  }
};
window.__lgMenuAction = (action) => {
  if (!action) return;
  if (action === 'newTask') createNewTask();
  else if (action === 'export') exportActiveConversation();
  else if (action === 'palette') openCommandPalette();
  else if (action === 'settings') switchView('settings');
  else if (action === 'pickFolder') pickWorkspaceFolder();
  else if (action === 'toggleSidebar') toggleSidebar();
  else if (typeof action === 'string' && action.startsWith('view:')) switchView(action.slice(5));
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
    refreshSuggestions();
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

// Split "44%" / "11.8 GB" into a big number plus a small unit; leave compound
// values like "11.8 GB / 16 GB" untouched so they stay readable at a glance.
function valueWithUnit(text) {
  const s = String(text);
  const m = /^([\d.,]+)\s*([%A-Za-z]+(?:\s+[A-Za-z]+)?)$/.exec(s.trim());
  return m ? `${escapeHtml(m[1])}<span class="unit">${escapeHtml(m[2])}</span>` : escapeHtml(s);
}

function setUsageBar(barId, valueId, percent, valueLabel) {
  const bar = $(barId);
  const label = $(valueId);
  const p = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : null;
  if (bar) {
    bar.style.width = p === null ? '0%' : `${p}%`;
    bar.dataset.tone = p === null ? 'ok' : usageTone(p);
  }
  if (label) label.innerHTML = valueWithUnit(valueLabel ?? (p === null ? '—' : `${Math.round(p)}%`));
}

// Render a real-time wave (area sparkline) for a stat tile from recent history,
// replacing the static usage bar with a live trend.
function setStatSpark(sparkId, valueId, percent, valueLabel, values = [], color = 'var(--accent)') {
  const spark = $(sparkId);
  const label = $(valueId);
  const p = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : null;
  if (label) label.innerHTML = valueWithUnit(valueLabel ?? (p === null ? '—' : `${Math.round(p)}%`));
  if (spark) {
    const clean = (values || []).filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
    spark.innerHTML = renderSparkline(clean, { color, width: 220, height: 42, min: 0, max: 100, label: `${sparkId}-trend` });
  }
}

// When storage runs low, surface a prominent, actionable recovery path that
// launches the Clean-downloads capability instead of a bare warning.
let storageAuditText = '';
let lastAlertDisk = null;
function renderStorageAlert(disk) {
  const el = $('#dash-storage-alert');
  if (!el) return;
  lastAlertDisk = disk;
  if (!isStorageLow(disk)) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const freeBytes = disk?.availableBytes ?? 0;
  const usedPercent = disk?.usedPercent ?? 0;
  el.classList.remove('hidden');
  el.innerHTML = `<span>Storage is low — ${escapeHtml(formatBytes(freeBytes))} free (${Math.round(usedPercent)}% used). Clearing downloads is the fastest way to reclaim space.</span>
    <button type="button" class="primary-btn" data-storage-audit="1">${storageAuditText ? 'Hide details' : "What's eating space?"}</button>
    <button type="button" class="primary-btn" data-clean-downloads="1">Clean downloads plan</button>
    ${storageAuditText ? `<pre class="storage-audit-out">${escapeHtml(storageAuditText)}</pre>` : ''}`;
}

// Fetch the instant storage audit (read-only culprits) on demand and show it
// inline, so a full disk explains itself without waiting on the slow model.
async function loadStorageAudit() {
  if (storageAuditText) {
    storageAuditText = '';
    renderStorageAlert(lastAlertDisk);
    return;
  }
  storageAuditText = 'Scanning what is eating your space…';
  renderStorageAlert(lastAlertDisk);
  try {
    const res = await apiRequest('/api/actions/run', { method: 'POST', body: JSON.stringify({ action: 'storage_audit' }) });
    storageAuditText = res?.output || '(no output)';
  } catch (err) {
    storageAuditText = `Could not load the storage audit: ${err.message}`;
  }
  renderStorageAlert(lastAlertDisk);
}

async function runCapability(promptText, autorun = true) {
  if (!promptText) return;
  if (autorun) {
    await createNewTask();
    await sendPrompt({ text: promptText, attachments: [] });
    return;
  }
  await createNewTask();
  const pi = $('#prompt-input');
  if (pi) {
    pi.value = promptText;
    pi.style.height = 'auto';
    pi.style.height = `${Math.min(pi.scrollHeight, 180)}px`;
    pi.focus();
  }
}

function getCleanDownloadsPrompt() {
  const card = $$('.superpower-card').find((c) => /clean folder grouping/i.test(c.dataset.prompt || ''));
  return card?.dataset.prompt || 'Inspect ~/Downloads and propose a clean folder grouping by file type and age (read-only audit first, do not move or delete anything without asking).';
}

function topDisk(metrics) {
  const disks = metrics?.disks || [];
  return disks.find((d) => d.mount === '/System/Volumes/Data') || disks.find((d) => d.mount === '/') || disks[0] || null;
}

// The dashboard metric tiles are shortcuts into the System Monitor for detail.
function wireStatTiles() {
  const grid = $('#dash-stats');
  if (!grid) return;
  grid.querySelectorAll('.stat-tile').forEach((tile) => {
    const label = tile.querySelector('.stat-label')?.textContent?.trim() || 'Metric';
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.setAttribute('aria-label', `${label} — open in System Monitor`);
  });
  const go = (e) => {
    if (!e.target.closest('.stat-tile')) return;
    if (e.type === 'keydown') {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
    }
    switchView('monitor');
  };
  grid.addEventListener('click', go);
  grid.addEventListener('keydown', go);
}

// One source of truth for where the active model runs and the health of that
// runtime, so the top-right mode pill and the sidebar chip can never disagree.
// The derivation lives in ui/lib/live-status.js (pure + unit-tested).
function describeModelRuntime() {
  return describeRuntimeState(state.config || {}, state.presets || {}, state.health || {});
}

let suggestionRequestId = 0;

async function refreshSuggestions() {
  const requestId = ++suggestionRequestId;
  try {
    const data = await apiRequest('/api/suggestions');
    if (requestId !== suggestionRequestId) return;
    state.suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
    renderSmartAssist();
  } catch {
    // Keep existing suggestions silently if unavailable
  }
}

const TONES_FOR_UI = ['urgent', 'warn', 'info', 'calm'];

// A distinct glyph per suggestion keeps the strip scannable at a glance; the
// tone class supplies the matching colour so icon, edge and action agree.
const SUGGESTION_ICONS = {
  'free-space': `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="6.2" rx="2" /><rect x="3" y="13.3" width="18" height="6.2" rx="2" /><path d="M7 7.6h.01M7 16.4h.01" stroke-width="2.6" /></svg>`,
  'tidy-storage': `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="6.2" rx="2" /><rect x="3" y="13.3" width="18" height="6.2" rx="2" /><path d="M7 7.6h.01M7 16.4h.01" stroke-width="2.6" /></svg>`,
  'organize-downloads': `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6v10.2M7.6 9.8L12 14.2l4.4-4.4" /><path d="M4.6 16.4v2.1a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-2.1" /></svg>`,
  'summarize-inbox': `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.6" /><path d="M3.8 6.8L12 12.9l8.2-6.1" /></svg>`,
  'inbox-glance': `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.6" /><path d="M3.8 6.8L12 12.9l8.2-6.1" /></svg>`,
  'review-schedule': `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.4" y="5" width="17.2" height="15.4" rx="2.6" /><path d="M8 3v4M16 3v4M3.4 10h17.2" /></svg>`,
  'daily-brief': `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.2v3.2M7.8 6.3l2 2.2M16.2 6.3l-2 2.2" /><path d="M5 16.2a7 7 0 0 0 14 0" /><path d="M3 20h18" /></svg>`,
  'wrap-up': `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.4A8.2 8.2 0 0 1 9.6 4 8.6 8.6 0 1 0 20 14.4Z" /></svg>`,
  'network-insight': `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.4 8.8a13 13 0 0 1 17.2 0M6.6 12.4a8.4 8.4 0 0 1 10.8 0M9.8 16a3.9 3.9 0 0 1 4.4 0" /><circle cx="12" cy="19.4" r="1.2" fill="currentColor" stroke="none" /></svg>`,
};

function renderSmartAssist() {
  const host = $('#dash-smart-assist');
  if (!host) return;
  const items = state.suggestions || [];
  if (items.length === 0) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }
  host.classList.remove('hidden');
  host.innerHTML = items
    .map((s) => {
      const tone = TONES_FOR_UI.includes(s.tone) ? s.tone : 'info';
      const icon = SUGGESTION_ICONS[s.id] || '✨';
      return `
      <div class="smart-assist-card" data-tone="${tone}" data-sug-id="${escapeHtml(s.id)}">
        <div class="smart-assist-top">
          <span class="smart-assist-icon" aria-hidden="true">${icon}</span>
          <span class="smart-assist-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>
          <button type="button" class="smart-assist-dismiss" data-dismiss-sug="${escapeHtml(s.id)}" title="Dismiss suggestion" aria-label="Dismiss ${escapeHtml(s.title)}">×</button>
        </div>
        <div class="smart-assist-detail">${escapeHtml(s.detail || '')}</div>
        ${
          s.action
            ? `<div class="smart-assist-foot"><button type="button" class="smart-assist-action" data-run-sug="${escapeHtml(s.id)}">${escapeHtml(s.actionLabel || 'Run')}</button></div>`
            : ''
        }
      </div>`;
    })
    .join('');
}

async function refreshBriefing(force = false) {
  const btn = $('#dash-briefing-refresh');
  if (force && btn) {
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
  }
  try {
    const data = await apiRequest(force ? '/api/briefing?refresh=1' : '/api/briefing');
    state.briefing = data.briefing || null;
    state.briefingAt = Date.now();
    renderBriefing();
    renderNetwork();
    refreshSuggestions();
  } catch {
    // Keep the last briefing; the next refresh retries.
  } finally {
    if (force && btn) {
      btn.disabled = false;
      btn.textContent = 'Refresh';
    }
  }
}

function renderBriefing() {
  const el = $('#dash-briefing');
  const sub = $('#dash-briefing-sub');
  const b = state.briefing;
  if (!el) return;
  if (!b) {
    el.textContent = 'Loading today’s briefing…';
    return;
  }
  if (sub) sub.textContent = `Updated ${new Date(b.updatedAt).toLocaleTimeString()} · weather, news & email`;

  const newsItems = (b.news || []).slice(0, 3);
  const newsHtml = newsItems.length
    ? `<ol class="brief-list">${newsItems
        .map((n) => {
          const href = String(n.link || '').trim();
          const titleHtml = /^https?:\/\//i.test(href)
            ? `<a class="brief-title brief-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.title)}</a>`
            : `<span class="brief-title">${escapeHtml(n.title)}</span>`;
          return `<li>${titleHtml}<span class="brief-meta">${escapeHtml(n.source)}</span></li>`;
        })
        .join('')}</ol>`
    : '<div class="brief-body quiet">News unavailable right now.</div>';

  let emailHtml;
  if (b.email?.ok && b.email.count) {
    // A summary of the inbox, not a list of every message.
    emailHtml = `<div class="brief-body">${escapeHtml(b.email.summary || `${b.email.count} new emails today.`)}</div>`;
  } else if (b.email?.ok) {
    emailHtml = '<div class="brief-body quiet">No new messages today.</div>';
  } else {
    emailHtml = `<div class="brief-body quiet">${escapeHtml(b.email?.error || 'Email unavailable.')}</div>`;
  }

  const w = b.weather;
  const weatherHtml = w?.ok
    ? `<div class="brief-body"><span class="weather-icon" aria-hidden="true">${w.icon || ''}</span><strong>${w.temp != null ? `${w.temp}°C` : '—'}</strong> ${escapeHtml(String(w.description || ''))}${w.feelsLike != null ? ` · feels like ${w.feelsLike}°` : ''} · high ${w.high ?? '—'}° · low ${w.low ?? '—'}°${w.city ? ` · ${escapeHtml(String(w.city))}` : ''}</div>`
    : `<div class="brief-body quiet">${escapeHtml(String(w?.error || 'Weather unavailable.'))}</div>`;

  el.innerHTML = `
    <div class="brief-cols">
      <div class="brief-col"><div class="brief-label">World news</div>${newsHtml}</div>
      <div class="brief-col"><div class="brief-label">Email today</div>${emailHtml}<div class="brief-label">Weather</div>${weatherHtml}</div>
    </div>`;
}

function renderNetwork() {
  const el = $('#dash-network');
  const net = state.briefing?.network;
  if (!el) return;
  if (!net) {
    el.textContent = 'Loading network usage…';
    return;
  }
  // Month-to-date per-app totals are the honest source for a "this month" ring;
  // the since-launch counters are only a fallback before the first sample lands.
  const monthApps = (net.monthApps || []).filter((a) => Number(a?.total) > 0);
  const usingMonth = monthApps.length > 0;
  const donut = renderNetworkDonut(usingMonth ? monthApps : net.topApps || [], {
    size: 132,
    centerLabel: usingMonth ? 'this month' : 'since launch',
  });
  const bars = renderNetworkHistoryChart(net.history || {}, { month: net.month || '' });
  const hasTraffic = Object.values(net.history || {}).some((v) => Number(v) > 0);
  const legendNote = usingMonth
    ? ''
    : '<div class="net-legend-note">Per-app totals build up while LocalGravity runs.</div>';
  const emptyHint = (() => {
    if (!hasTraffic && !Number(net.monthBytes || 0)) {
      return '<div class="net-empty-hint">No traffic sampled yet — this fills in after the first five-minute sample.</div>';
    }
    // A month that only has a few recorded days (the app started tracking
    // mid-month) reads as broken unless we say so. Name the start date so the
    // empty leading days look intentional rather than like missing data.
    const activeDays = Object.keys(net.history || {}).filter((k) => Number(net.history[k]) > 0).sort();
    const first = activeDays[0] || '';
    if (first && !first.endsWith('-01') && activeDays.length < 20) {
      const since = new Date(first).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return `<div class="net-empty-hint">Daily totals recorded since ${escapeHtml(since)}.</div>`;
    }
    return '';
  })();
  const speedMbps = state.lastSpeedMbps ?? net.lastSpeedMbps ?? null;
  el.innerHTML = `
    <div class="net-flex">
      ${donut.svg}
      <div class="donut-legend">${donut.legendHtml}${legendNote}</div>
    </div>
    ${bars ? `<div class="net-bars-wrap"><div class="brief-label">Daily usage this month</div>${bars}${emptyHint}</div>` : ''}
    <div class="net-stats">
      <div class="net-stat"><span class="k">This month</span><span class="v">${escapeHtml(formatBytes(net.monthBytes || 0))}</span></div>
      <div class="net-stat"><span class="k">Today</span><span class="v">${escapeHtml(formatBytes(net.todayBytes || 0))}</span></div>
      <div class="net-stat"><span class="k">Since restart</span><span class="v">${escapeHtml(formatBytes(net.sinceBootBytes || 0))}</span></div>
      <div class="net-stat"><span class="k">Live speed</span><span class="v" id="dash-live-speed">${speedMbps ? `${Math.round(speedMbps)} Mbps` : '—'}</span></div>
    </div>`;
}

async function runSpeedTest() {
  const btn = $('#dash-speed-test');
  const speedEl = $('#dash-live-speed');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Testing…';
  }
  if (speedEl) speedEl.textContent = '…';
  try {
    const data = await apiRequest('/api/network/speed', { method: 'POST' });
    if (data.mbps) state.lastSpeedMbps = data.mbps;
    if (speedEl) speedEl.textContent = data.mbps ? `${Math.round(data.mbps)} Mbps` : '—';
  } catch {
    if (speedEl) speedEl.textContent = 'failed';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Test speed';
    }
  }
}

function renderDashboard() {
  const metrics = state.metrics;
  const mem = metrics?.memory || {};
  const gpu = metrics?.gpu;
  const disk = topDisk(metrics);
  const hist = state.metricsHistory || [];
  const series = (key) => hist.map((h) => h[key]);
  setStatSpark('#dash-cpu-spark', '#dash-cpu', metrics?.cpu?.percent, null, series('cpu'), 'var(--app-1)');
  setStatSpark('#dash-mem-spark', '#dash-mem', mem.usedPercent, mem.totalBytes ? formatBytes(mem.usedBytes || 0) : '—', series('mem'), 'var(--app-2)');
  setStatSpark('#dash-gpu-spark', '#dash-gpu', gpu?.utilizationPercent, gpu ? (gpu.utilizationPercent === null ? 'n/a' : `${gpu.utilizationPercent}%`) : '—', series('gpu'), 'var(--app-3)');
  const diskLow = Boolean(disk) && isStorageLow(disk);
  setStatSpark('#dash-disk-spark', '#dash-disk', disk?.usedPercent, disk ? `${formatBytes(disk.availableBytes)} free` : '—', series('disk'), diskLow ? 'var(--signal-red)' : 'var(--app-5)');
  // A healthy disk should look healthy: flip the storage tile to the alert hue
  // only while it actually needs attention, so the grid reads at a glance.
  const diskTile = document.querySelector('.stat-tile[data-metric="disk"]');
  if (diskTile) diskTile.classList.toggle('is-critical', diskLow);
  renderStorageAlert(disk);

  const cpuSub = $('#dash-cpu-sub');
  if (cpuSub) {
    cpuSub.textContent = metrics?.loadAvg
      ? `Load ${metrics.loadAvg[0]} · ${metrics.cpu?.cores || '?'} cores`
      : 'CPU utilization';
  }
  const memSub = $('#dash-mem-sub');
  if (memSub) {
    const ofTotal = mem.totalBytes ? `of ${formatBytes(mem.totalBytes)}` : 'Unified RAM';
    const swapPart = mem.swap?.usedBytes > 0 ? ` · Swap ${formatBytes(mem.swap.usedBytes)}` : '';
    memSub.textContent = `${ofTotal}${swapPart}`;
  }
  const gpuSub = $('#dash-gpu-sub');
  if (gpuSub) {
    gpuSub.textContent = gpu?.inUseMemoryBytes ? `${formatBytes(gpu.inUseMemoryBytes)} active GPU mem` : 'Apple Silicon GPU';
  }
  const diskSub = $('#dash-disk-sub');
  if (diskSub) {
    diskSub.textContent = disk ? `${formatBytes(disk.usedBytes)} of ${formatBytes(disk.totalBytes)} used` : 'SSD capacity';
  }

  const now = new Date();
  const next = nextEntryFrom(state.scheduleToday, now);
  const remaining = state.scheduleToday.filter((e) => e.startMinutes + (e.durationMin || 0) > now.getHours() * 60 + now.getMinutes()).length;
  const summary = $('#dash-summary');
  if (summary) {
    summary.textContent = next
      ? `${remaining} item${remaining === 1 ? '' : 's'} left today · ${next.inProgress ? `now: ${next.entry.title}` : `next: ${next.entry.title} ${formatMinutesUntil(next.minutesUntil)}`}`
      : `${remaining} item${remaining === 1 ? '' : 's'} left today · nothing else scheduled`;
  }
  renderSidebarBadges();
  renderBriefing();
  renderNetwork();
  if (!state.briefing || Date.now() - (state.briefingAt || 0) > 300000) refreshBriefing();

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
  const modePill = $('#dash-mode-text');
  const rt = describeModelRuntime();
  if (modePill) {
    modePill.textContent = rt.isLocal
      ? `Local · ${rt.model} · ${rt.mode}`
      : `Cloud · ${rt.provLabel} · ${rt.model}`;
  }
  if (runtimeEl) {
    const activeLabel = `${rt.model} (${rt.isLocal ? 'Local' : rt.provLabel})`;
    const running = rt.runningModels;
    if (running.length > 0) {
      const totalVram = running.reduce((acc, m) => acc + (m.sizeVram || m.size || 0), 0);
      runtimeEl.textContent = `Active: ${activeLabel} · ${rt.mode} · Loaded in GPU: ${running.map((m) => m.name).join(', ')} (${formatBytes(totalVram)})`;
      unloadBtn?.classList.remove('hidden');
    } else if (rt.daemon === 'idle') {
      runtimeEl.textContent = `Active: ${activeLabel} · ${rt.mode} · Ollama idle (0 B GPU RAM used)`;
      unloadBtn?.classList.add('hidden');
    } else {
      runtimeEl.textContent = `Active: ${activeLabel} · ${rt.mode} · Ollama stopped (auto-starts on your first local task)`;
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
    mem.totalBytes ? formatBytes(mem.usedBytes || 0) : '—'
  );
  setUsageBar('#mon-gpu-bar', '#mon-gpu', gpu?.utilizationPercent, gpu ? (gpu.utilizationPercent === null ? 'n/a' : `${gpu.utilizationPercent}%`) : '—');
  setUsageBar(
    '#mon-disk-bar',
    '#mon-disk',
    disk?.usedPercent,
    disk ? `${formatBytes(disk.availableBytes)} free` : '—'
  );

  const runningModels = state.health?.ollama?.runningModels || [];
  const totalVram = runningModels.reduce((acc, m) => acc + (m.sizeVram || m.size || 0), 0);

  const telChart = $('#monitor-timeline-chart');
  const telStats = $('#monitor-telemetry-stats');
  if (telChart) {
    const chart = renderMultiSeriesChart(state.metricsHistory, { activeSeries: state.monitorChartSeries });
    telChart.innerHTML = chart.svg;
    if (telStats) {
      const fmtMetric = (label, color, s) =>
        s.current === null
          ? `<span class="telemetry-stat-pill"><span class="telemetry-dot" style="background:${color}"></span>${label}: —</span>`
          : `<span class="telemetry-stat-pill"><span class="telemetry-dot" style="background:${color}"></span><strong>${label}</strong> ${s.current}% · peak ${s.peak}% · avg ${s.avg}%</span>`;
      telStats.innerHTML = [
        fmtMetric('CPU', 'var(--accent)', chart.stats.cpu),
        fmtMetric('Memory', 'var(--signal-green)', chart.stats.mem),
        fmtMetric('GPU', 'var(--signal-amber)', chart.stats.gpu),
      ].join('');
    }
  }

  const donutEl = $('#monitor-memory-donut');
  if (donutEl) {
    const donut = renderMemoryDonut(mem, totalVram);
    donutEl.innerHTML = `${donut.svg}<div class="donut-legend">${donut.legendHtml}</div>`;
  }

  const details = $('#monitor-details');
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
          <td>
            <div class="inline-meter-cell">
              <div class="inline-meter-track"><span class="inline-meter-fill" style="width:${Math.min(100, d.usedPercent || 0)}%"></span></div>
              <span class="usage-pill" data-tone="${usageTone(d.usedPercent)}">${d.usedPercent}%</span>
            </div>
          </td>
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
    const maxRss = Math.max(1, ...procList.map((p) => p.rssBytes || 0));
    procsBody.innerHTML = procList
      .map(
        (p) => `<tr>
          <td>${escapeHtml(p.command)}</td>
          <td>${p.pid}</td>
          <td><span class="usage-pill" data-tone="${usageTone(p.cpuPercent)}">${p.cpuPercent}</span></td>
          <td>${p.memPercent}</td>
          <td>
            <div class="inline-meter-cell">
              <div class="inline-meter-track"><span class="inline-meter-fill" style="width:${Math.min(100, Math.round(((p.rssBytes || 0) / maxRss) * 100))}%"></span></div>
              <span>${formatBytes(p.rssBytes)}</span>
            </div>
          </td>
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
    const hadMetrics = Boolean(state.metrics);
    state.metrics = data.metrics || null;
    if (Array.isArray(data.history) && data.history.length > 0) {
      state.metricsHistory = data.history;
    } else if (state.metrics) {
      state.metricsHistory.push({
        t: state.metrics.timestamp,
        cpu: state.metrics.cpu?.percent ?? null,
        mem: state.metrics.memory?.usedPercent ?? null,
        gpu: state.metrics.gpu?.utilizationPercent ?? null,
        disk: state.metrics.disks?.[0]?.usedPercent ?? null,
      });
      if (state.metricsHistory.length > 60) state.metricsHistory.shift();
    }
    if (state.view === 'dashboard') {
      renderDashboard();
      if (!hadMetrics) refreshSuggestions();
    } else if (state.view === 'monitor') renderMonitor();
  } catch {
    // Keep the last snapshot; the next tick retries.
  }
}

function updateMonitorAutoRefresh() {
  const shouldRun =
    (state.view === 'dashboard' || state.view === 'monitor') &&
    (state.view !== 'monitor' || $('#monitor-autorefresh')?.checked !== false);
  if (state.monitorTimer) {
    clearTimeout(state.monitorTimer);
    state.monitorTimer = null;
  }
  if (shouldRun) scheduleMetricsPoll();
}

// Self-scheduling so focus/visibility changes adjust the cadence each tick.
function scheduleMetricsPoll() {
  const visible = document.visibilityState === 'visible';
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  state.monitorTimer = setTimeout(async () => {
    state.monitorTimer = null;
    if (document.visibilityState === 'visible') await refreshSystemMetrics();
    updateMonitorAutoRefresh();
  }, metricsPollDelay({ focused, visible }));
}

function renderScheduleWeek() {
  const entries = state.schedule || [];
  const today = new Date().getDay();

  const chartHost = $('#schedule-week-chart');
  const kpiHost = $('#schedule-chart-kpis');
  if (chartHost) {
    const chart = renderWeeklyScheduleChart(entries, today);
    chartHost.innerHTML =
      chart.svg +
      (chart.totalHours === 0
        ? '<div class="chart-empty-note">No blocks this week yet — add one on the left and these bars fill in.</div>'
        : '');
    if (kpiHost) {
      kpiHost.innerHTML = [
        `<span class="telemetry-stat-pill"><strong>${chart.totalHours}h</strong> planned this week</span>`,
        `<span class="telemetry-stat-pill">Busiest: <strong>${escapeHtml(chart.busiestDayLabel)}</strong></span>`,
        `<span class="telemetry-stat-pill"><strong>${chart.totalBlocks}</strong> active blocks</span>`,
      ].join('');
    }
  }

  const host = $('#schedule-week');
  if (!host) return;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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
    renderSidebarBadges();
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

  const compBadge = $('#composer-provider-badge');
  if (compBadge) {
    const isLocal = prov === 'ollama';
    compBadge.innerHTML = `<span class="status-dot online" aria-hidden="true"></span> ${escapeHtml(
      isLocal ? `On-device · ${model}` : `Cloud · ${provLabel} · ${model}`
    )}`;
  }
}

function renderSidebarStatus() {
  if (!state.health) return;
  const { system, ollama } = state.health;
  $('#sidebar-chip-label').textContent = `${system.arch === 'arm64' ? 'Apple M-Series' : system.arch} · ${system.totalRamGb} GB`;

  const dot = $('#ollama-dot');
  const txt = $('#ollama-status-text');
  const rt = describeModelRuntime();
  if (!rt.isLocal) {
    dot.className = 'status-dot online';
    txt.textContent = `Cloud · ${rt.provLabel} · ${rt.model}`;
  } else if (rt.daemon === 'not-installed') {
    dot.className = 'status-dot offline';
    txt.textContent = 'Ollama not installed';
  } else if (rt.runningModels.length > 0) {
    dot.className = 'status-dot online';
    txt.textContent = `Ollama ready · ${rt.runningModels.map((m) => m.name).join(', ')} loaded`;
  } else if (ollama?.running) {
    dot.className = 'status-dot online';
    const count = (ollama.models || []).length;
    txt.textContent = `Ollama ready (${count} ${count === 1 ? 'model' : 'models'})`;
  } else {
    dot.className = 'status-dot offline';
    txt.textContent = 'Ollama stopped';
  }
  $('#disk-status-text').textContent =
    system.freeDiskGb !== null ? `SSD: ${system.freeDiskGb} GB free` : 'Disk info unavailable';
}

function syncSessionToolbar() {
  const cwdLabel = $('#workspace-cwd-label');
  const cwdBtn = $('#workspace-cwd-btn');
  const cwd = state.activeSession?.cwd || '';
  if (cwdLabel) {
    if (!cwd) {
      cwdLabel.textContent = 'Home (~)';
    } else {
      const parts = cwd.split('/').filter(Boolean);
      cwdLabel.textContent = parts.pop() || cwd;
    }
  }
  if (cwdBtn) {
    cwdBtn.title = cwd
      ? `Working folder: ${cwd} (click to change)`
      : 'Select project working folder for this chat';
  }
  const revealBtn = $('#workspace-reveal-btn');
  if (revealBtn) {
    revealBtn.classList.toggle('hidden', !hasSwiftBridge() || !cwd);
  }
  const modeSelect = $('#composer-mode-select');
  if (modeSelect) {
    modeSelect.value = state.activeSession?.mode || 'auto';
  }
}

async function ensureActiveSession(defaultTitle = 'New Task') {
  if (state.activeSession?.id) return state.activeSession;
  const created = await apiRequest('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title: defaultTitle,
      mode: $('#composer-mode-select')?.value || 'auto',
    }),
  });
  state.activeSession = created.session;
  syncSessionToolbar();
  await loadSessions().catch(() => {});
  return state.activeSession;
}

async function setSessionWorkspaceCwd(cwd) {
  const session = await ensureActiveSession();
  const res = await apiRequest(`/api/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ cwd: cwd || '' }),
  });
  state.activeSession = res.session;
  syncSessionToolbar();
  await loadSessions().catch(() => {});
  showToast(res.session.cwd ? `Workspace folder: ${res.session.cwd}` : 'Workspace reset to Home (~)');
}

function pickWorkspaceFolder() {
  if (hasSwiftBridge()) {
    postSwiftAction('pickFolder');
    return;
  }
  openModal(
    'Project Working Folder',
    `
    <div class="form-field">
      <label>Absolute folder path</label>
      <input id="m-cwd-input" class="text-input" value="${escapeHtml(state.activeSession?.cwd || '')}" placeholder="/Users/you/Projects/my-app" />
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
      <button type="button" id="m-cwd-reset" class="secondary-btn">Use Home (~)</button>
      <button type="button" id="m-cwd-save" class="primary-btn">Set Folder</button>
    </div>`
  );
  $('#m-cwd-input')?.focus();
  $('#m-cwd-reset')?.addEventListener('click', async () => {
    try {
      await setSessionWorkspaceCwd('');
      closeModal();
    } catch (err) {
      showToast(err.message);
    }
  });
  $('#m-cwd-save')?.addEventListener('click', async () => {
    try {
      const nextCwd = ($('#m-cwd-input')?.value || '').trim();
      await setSessionWorkspaceCwd(nextCwd);
      closeModal();
    } catch (err) {
      showToast(err.message);
    }
  });
}

function openRenameSessionModal(session) {
  if (!session?.id) return;
  openModal(
    'Rename Conversation',
    `
    <div class="form-field">
      <label>Title</label>
      <input id="m-session-title" class="text-input" value="${escapeHtml(session.title || '')}" placeholder="Conversation title" />
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
      <button type="button" id="m-rename-cancel" class="secondary-btn">Cancel</button>
      <button type="button" id="m-rename-save" class="primary-btn">Save</button>
    </div>`
  );
  const input = $('#m-session-title');
  input?.focus();
  input?.select();
  $('#m-rename-cancel')?.addEventListener('click', closeModal);
  const saveRename = async () => {
    const title = (input?.value || '').trim();
    if (!title) return;
    try {
      const res = await apiRequest(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      });
      if (state.activeSession?.id === session.id) {
        state.activeSession = res.session;
      }
      await loadSessions();
      closeModal();
      showToast('Conversation renamed');
    } catch (err) {
      showToast(err.message);
    }
  };
  $('#m-rename-save')?.addEventListener('click', saveRename);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRename();
    }
  });
}

function isPreviewableArtifactLang(lang = '') {
  const norm = String(lang || '').trim().toLowerCase();
  return norm === 'html' || norm === 'htm' || norm === 'svg';
}

function setArtifactTab(tab = 'preview') {
  const active = state.activeArtifact;
  const resolved = tab === 'preview' && active?.isPreviewable ? 'preview' : 'code';
  if (active) active.tab = resolved;
  $$('.artifact-view-tab').forEach((btn) => {
    const isThis = btn.dataset.tab === resolved;
    btn.classList.toggle('active', isThis);
    if (btn.dataset.tab === 'preview') {
      btn.disabled = !active?.isPreviewable;
    }
  });
  $('#artifact-preview-pane')?.classList.toggle('active', resolved === 'preview');
  $('#artifact-code-pane')?.classList.toggle('active', resolved === 'code');
}

function renderArtifactSwitcher() {
  const container = $('#artifact-switcher');
  if (!container) return;
  container.innerHTML = state.artifactsList
    .map(
      (art, index) => `
      <button type="button" class="artifact-switch-pill${art.id === state.activeArtifact?.id ? ' active' : ''}" data-art-idx="${index}">
        ${escapeHtml(art.title)}
      </button>`
    )
    .join('');
}

async function openArtifactInCanvas({ code = '', lang = 'text', title = '' }) {
  const normLang = String(lang || 'text').trim().toLowerCase() || 'text';
  const rawCode = String(code || '');
  if (!rawCode) return;

  let entry = state.artifactsList.find((a) => a.code === rawCode && a.lang === normLang);
  if (!entry) {
    const isPreviewable = isPreviewableArtifactLang(normLang);
    const num = state.artifactsList.length + 1;
    entry = {
      id: `art-${Date.now()}-${num}`,
      title: title || `${normLang === 'svg' ? 'Vector SVG' : normLang === 'html' || normLang === 'htm' ? 'HTML Widget' : `${normLang.charAt(0).toUpperCase() + normLang.slice(1)} Snippet`} #${num}`,
      lang: normLang,
      code: rawCode,
      isPreviewable,
      previewUrl: null,
      tab: isPreviewable ? 'preview' : 'code',
    };
    state.artifactsList.push(entry);
  }

  state.activeArtifact = entry;
  state.artifactDrawerOpen = true;
  $('#agent-split')?.classList.add('canvas-open');
  $('#artifact-title').textContent = entry.title;
  $('#artifact-lang-badge').textContent = entry.lang;
  $('#artifact-code-body').innerHTML = highlightCode(entry.code);
  renderArtifactSwitcher();
  setArtifactTab(entry.isPreviewable ? entry.tab || 'preview' : 'code');

  if (entry.isPreviewable) {
    const iframe = $('#artifact-iframe');
    if (!entry.previewUrl) {
      if (iframe) iframe.src = 'about:blank';
      try {
        const res = await apiRequest('/api/artifacts/stage', {
          method: 'POST',
          body: JSON.stringify({
            title: entry.title,
            lang: entry.lang,
            code: entry.code,
          }),
        });
        entry.previewUrl = res.previewUrl;
      } catch (err) {
        showToast(err.message || 'Could not stage sandbox preview');
        setArtifactTab('code');
        return;
      }
    }
    if (iframe && state.activeArtifact?.id === entry.id && entry.previewUrl) {
      iframe.src = entry.previewUrl;
    }
  }
}

function closeArtifactCanvas() {
  state.artifactDrawerOpen = false;
  $('#agent-split')?.classList.remove('canvas-open');
}

async function stopSpeakAudio() {
  state.speakingMessageIndex = null;
  await apiRequest('/api/chat/speak/stop', { method: 'POST' }).catch(() => {});
  renderMessages(false);
}

async function toggleSpeakMessage(idx, rawText) {
  if (state.speakingMessageIndex === idx) {
    await stopSpeakAudio();
    return;
  }
  const clean = String(rawText || '').trim();
  if (!clean) return;
  state.speakingMessageIndex = idx;
  renderMessages(false);
  try {
    await apiRequest('/api/chat/speak', {
      method: 'POST',
      body: JSON.stringify({ text: clean }),
    });
    showToast('Reading reply aloud via macOS voice');
  } catch (err) {
    state.speakingMessageIndex = null;
    renderMessages(false);
    showToast(err.message || 'Could not speak reply');
  }
}

function toggleVoiceDictation() {
  const btn = $('#composer-voice-btn');
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    showToast('Speech recognition is unavailable in this browser');
    return;
  }
  if (state.isListening && state.voiceRecognition) {
    state.isListening = false;
    btn?.classList.remove('listening');
    try {
      state.voiceRecognition.stop();
    } catch {
      // ignore stop error
    }
    return;
  }
  try {
    const rec = new SpeechRec();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    const input = $('#prompt-input');
    const baseText = input ? input.value.trim() : '';

    rec.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i][0]?.transcript || '';
      }
      if (input && transcript.trim()) {
        input.value = baseText ? `${baseText} ${transcript.trim()}` : transcript.trim();
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
      }
    };
    rec.onerror = () => {
      state.isListening = false;
      btn?.classList.remove('listening');
      showToast('Voice dictation stopped or denied');
    };
    rec.onend = () => {
      state.isListening = false;
      btn?.classList.remove('listening');
    };

    state.voiceRecognition = rec;
    state.isListening = true;
    btn?.classList.add('listening');
    rec.start();
    showToast('Listening for voice input…');
  } catch (err) {
    state.isListening = false;
    btn?.classList.remove('listening');
    showToast(err.message || 'Could not start microphone');
  }
}

function renderSessionItemHtml(s) {
  return `
    <div class="session-item ${state.activeSession?.id === s.id ? 'active' : ''}${s.pinned ? ' is-pinned' : ''}" data-id="${escapeHtml(s.id)}">
      ${state.isRunning && state.runningSessionId === s.id ? '<span class="session-running-dot" title="Running"></span>' : ''}
      <span class="session-title-wrap">
        <span class="session-title" title="${escapeHtml(s.title)}">${s.pinned ? '<span class="session-pin-badge" title="Pinned"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 3h6l-1 7 3 3H7l3-3-1-7z"/></svg></span>' : ''}${escapeHtml(s.title)}</span>
        ${s.snippet ? `<span class="session-snippet" title="${escapeHtml(s.snippet)}">${escapeHtml(s.snippet)}</span>` : ''}
      </span>
      ${s.source === 'scheduled' ? '<span class="session-badge">Auto</span>' : ''}
      <span class="session-meta">
        <span class="session-time">${escapeHtml(formatRelativeTime(s.updatedAt))}</span>
        <span class="session-actions">
          <button type="button" class="session-action-icon session-pin-btn" data-pin="${escapeHtml(s.id)}" title="${s.pinned ? 'Unpin conversation' : 'Pin conversation'}">${s.pinned ? '★' : '☆'}</button>
          <button type="button" class="session-action-icon session-rename-btn" data-rename="${escapeHtml(s.id)}" title="Rename conversation">✎</button>
          <button type="button" class="session-del-btn" data-del="${escapeHtml(s.id)}" title="Delete session">×</button>
        </span>
      </span>
    </div>`;
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

  const pinned = filtered.filter((s) => s.pinned);
  const recent = filtered.filter((s) => !s.pinned);

  if (!searchMode && pinned.length > 0) {
    listEl.innerHTML =
      `<div class="session-group-label">Pinned</div>` +
      pinned.map(renderSessionItemHtml).join('') +
      (recent.length > 0 ? `<div class="session-group-label">Recent</div>` + recent.map(renderSessionItemHtml).join('') : '');
  } else {
    listEl.innerHTML = filtered.map(renderSessionItemHtml).join('');
  }
}

function renderAttachments() {
  const bar = $('#attachments-bar');
  if (state.attachments.length === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  const canReveal = hasSwiftBridge();
  bar.classList.remove('hidden');
  bar.innerHTML = state.attachments
    .map(
      (a, idx) => `
      <div class="attach-chip${canReveal ? ' clickable' : ''}" data-path="${escapeHtml(a.path)}" title="${escapeHtml(canReveal ? `${a.path} (click to reveal in Finder)` : a.path)}">
        ${a.previewUrl ? `<img src="${a.previewUrl}" alt="" />` : ''}
        <span>${escapeHtml(a.name)}</span>
        <button type="button" data-idx="${idx}" aria-label="Remove attachment">×</button>
      </div>`
    )
    .join('');
}

function groupMessagesForDisplay(messages = []) {
  const items = [];
  let currentAssistant = null;

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (msg.isCompactionSummary) {
        items.push({ type: 'compaction', content: msg.content, rawStartIndex: i, rawEndIndex: i });
      } else {
        currentAssistant = null;
        items.push({ type: 'user', msg, rawStartIndex: i, rawEndIndex: i });
      }
    } else if (msg.role === 'assistant') {
      if (!currentAssistant) {
        currentAssistant = {
          type: 'assistant',
          rawStartIndex: i,
          rawEndIndex: i,
          thinking: [],
          tools: [],
          content: '',
          plan: null,
          selfImprovedLessons: [],
          usage: null,
          isError: false,
        };
        items.push(currentAssistant);
      } else {
        currentAssistant.rawEndIndex = i;
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
      if (msg.usage) currentAssistant.usage = msg.usage;
      if (msg.isError) currentAssistant.isError = true;
    } else if (msg.role === 'tool' && currentAssistant) {
      currentAssistant.rawEndIndex = i;
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
        const heuristicFailed =
          out.startsWith('Blocked') ||
          out.startsWith('User denied') ||
          out.startsWith('Tool ') ||
          out.startsWith('[Self-Healing Loop Breaker]') ||
          out.includes('failed') ||
          exitNonZero;
        // Prefer the tool's real ok flag; fall back to output heuristics for older sessions.
        const failed = typeof msg.ok === 'boolean' ? !msg.ok : heuristicFailed;
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

/**
 * macOS blocks protected folders (Downloads, Desktop, Documents) with a system
 * dialog the app cannot click. When a tool reports that denial, point at the one
 * place a human can grant it permanently instead of silently failing again.
 */
function permissionHintHtml(tool) {
  const output = String(tool.output || '');
  if (!output || tool.status === 'running') return '';
  const denied =
    /(?:not authorized|operation not permitted|permission denied|errno -1|tcc|full disk access)/i.test(output);
  if (!denied) return '';
  return `<div class="permission-note">
    <span>macOS blocked a protected folder for this action. Grant it once; LocalGravity's signature is stable now, so it stays granted.</span>
    <button type="button" class="permission-btn" data-privacy-pane="allfiles">Open Privacy settings</button>
  </div>`;
}

function formatToolDisplayMeta(tool) {
  const meta = HUMAN_TOOL_META[tool.name];
  const label = meta ? meta.label : tool.name;
  let subtitle = '';
  try {
    subtitle = meta?.summarize ? String(meta.summarize(tool.arguments || {}) || '').trim() : '';
  } catch {
    subtitle = '';
  }
  return { label, subtitle };
}

function buildToolsHtml(tools = []) {
  return (tools || [])
    .map((t) => {
      const { label, subtitle } = formatToolDisplayMeta(t);
      const badgeCls = t.status === 'ok' ? 'ok' : t.status === 'fail' ? 'fail' : t.status === 'wait' ? 'wait' : '';
      const badgeLabel =
        t.status === 'ok'
          ? 'Done'
          : t.status === 'fail'
            ? 'Failed'
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
            <span class="tool-head-left">
              <span class="tool-name">${escapeHtml(label)}</span>
              ${subtitle ? `<span class="tool-subtitle" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</span>` : ''}
            </span>
            <span class="tool-head-right">${durationHtml}<span class="tool-badge ${badgeCls}">${badgeLabel}</span></span>
          </div>
          ${buildToolBodyHtml(t)}
          ${permissionHintHtml(t)}
          ${thumbs}
          ${approvalHtml}
        </div>`;
    })
    .join('');
}

function formatTelemetryBadge(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const parts = [];
  if (Number.isFinite(usage.durationMs) && usage.durationMs > 0) {
    parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`);
  }
  if (Number.isFinite(usage.completionTokens) && usage.completionTokens > 0) {
    parts.push(`${usage.completionTokens} tok`);
    if (Number.isFinite(usage.durationMs) && usage.durationMs >= 300) {
      const tps = (usage.completionTokens / (usage.durationMs / 1000)).toFixed(1);
      parts.push(`${tps} tok/s`);
    }
  }
  return parts.length > 0 ? `<span class="turn-telemetry">${escapeHtml(parts.join(' · '))}</span>` : '';
}

function buildFollowupChipsHtml(item, idx, isLastCompleted) {
  if (!isLastCompleted || item.isStreaming || item.isError || !item.content) return '';
  const chips = [
    { label: 'Summarize in 3 bullets', prompt: 'Summarize the previous answer in 3 crisp bullet points.' },
  ];
  const toolNames = new Set((item.tools || []).map((t) => t.name));
  if (toolNames.has('edit_file') || toolNames.has('write_file') || toolNames.has('run_command')) {
    chips.push({ label: 'Verify & run tests', prompt: 'Verify the changes and run the relevant checks or tests cleanly.' });
  } else {
    chips.push({ label: 'Turn into a Skill', prompt: 'Distill this approach into a reusable SKILL.md using save_skill.' });
  }
  chips.push({
    label: 'Copy reply to clipboard',
    action: 'copy',
    idx,
  });

  return `<div class="followup-chips">${chips
    .map((c) =>
      c.action === 'copy'
        ? `<button type="button" class="followup-chip followup-copy-btn" data-idx="${idx}">${escapeHtml(c.label)}</button>`
        : `<button type="button" class="followup-chip" data-prompt="${escapeHtml(c.prompt)}">${escapeHtml(c.label)}</button>`
    )
    .join('')}</div>`;
}

function buildDisplayItemHtml(item, idx, isLastCompleted = false) {
  if (item.type === 'compaction') {
    return `<div class="thinking-box"><details><summary>Compacted earlier context</summary><div class="thinking-content">${escapeHtml(item.content)}</div></details></div>`;
  }
  if (item.type === 'user') {
    const attachTag =
      Array.isArray(item.msg.attachments) && item.msg.attachments.length > 0
        ? `<div style="font-size:11.5px;opacity:0.85;margin-top:4px;">Attached: ${item.msg.attachments.map((p) => escapeHtml(p.split('/').pop())).join(', ')}</div>`
        : '';
    const textOnly = String(item.msg.content || '').replace(/\n\n\[Attached files\][\s\S]*$/, '');
    if (state.editingMessageIndex === idx) {
      return `<div class="msg-row"><div class="msg-user-wrap"><div class="user-inline-edit"><textarea id="user-inline-edit-input" data-idx="${idx}">${escapeHtml(textOnly)}</textarea><div class="user-inline-edit-actions"><button type="button" class="secondary-btn user-edit-cancel-btn">Cancel</button><button type="button" class="primary-btn user-edit-save-btn" data-idx="${idx}">Save &amp; Run</button></div></div></div></div>`;
    }
    return `<div class="msg-row"><div class="msg-user-wrap"><div class="msg-user">${escapeHtml(textOnly)}${attachTag}</div><div class="user-msg-actions"><button type="button" class="msg-action-btn user-copy-btn" data-idx="${idx}">Copy</button><button type="button" class="msg-action-btn user-edit-btn" data-idx="${idx}">Edit &amp; re-run</button><button type="button" class="msg-action-btn user-fork-btn" data-idx="${idx}">Branch</button></div></div></div>`;
  }

  const hasVisibleText = Boolean(String(item.content || '').trim());
  // A silent turn used to render as an empty bubble with no actions, which read
  // like the app had frozen. Say what happened and offer the retry.
  const blankReplyHtml =
    !item.isStreaming && !hasVisibleText
      ? '<div class="md-body empty-reply-note">No written reply came back from the model. Regenerate to try again.</div>'
      : '';
  const thinkingCombined = (item.thinking || []).join('').trim();
  const thinkingHtml = formatThinkingHtml(thinkingCombined, item.isStreaming && !item.content);

  const tools = item.tools || [];
  const canFoldTools = !item.isStreaming && tools.length >= 2 && !tools.some((t) => t.status === 'wait' || t.status === 'running');
  const isFolded = canFoldTools && state.collapsedToolGroups.has(idx);
  const toolsSummaryHtml = canFoldTools
    ? `<div class="tools-summary-bar">
        <span>${tools.length} tools executed</span>
        <button type="button" class="tools-collapse-btn" data-idx="${idx}">${isFolded ? 'Show tool details' : 'Hide tool details'}</button>
      </div>`
    : '';
  const toolsHtml = isFolded ? '' : buildToolsHtml(tools);

  const selfImprovedHtml =
    Array.isArray(item.selfImprovedLessons) && item.selfImprovedLessons.length > 0
      ? `<div class="self-improved-card">
          <div class="self-improved-head">Self-Programmed Lesson (Saved to LEARNED_FIXES.md)</div>
          <ul class="self-improved-list">
            ${item.selfImprovedLessons.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}
          </ul>
        </div>`
      : '';

  const modelLabel = item.usage?.model || state.config?.model || 'LocalGravity';
  const provKey = item.usage?.provider || state.config?.provider || 'ollama';
  const provLabel = provKey === 'ollama' ? 'Local' : state.presets?.[provKey]?.label?.split(' ')[0] || provKey;
  const isSpeaking = state.speakingMessageIndex === idx;

  const showActions = !item.isStreaming || item.isError;
  const actionsHtml = showActions
    ? `<div class="msg-actions">
        <button type="button" class="msg-action-btn retry-turn-btn" data-idx="${idx}">Regenerate</button>
        ${
          !item.isStreaming && item.content
            ? `<button type="button" class="msg-action-btn speak-reply-btn${isSpeaking ? ' speaking' : ''}" data-idx="${idx}">${isSpeaking ? 'Stop reading' : 'Read aloud'}</button>
               <button type="button" class="msg-action-btn copy-reply-btn" data-idx="${idx}">Copy reply</button>
               <button type="button" class="msg-action-btn fork-turn-btn" data-idx="${idx}">Branch</button>
               <button type="button" class="msg-action-btn teach-skill-btn" data-idx="${idx}">Teach as skill</button>
               <button type="button" class="msg-action-btn save-auto-btn" data-idx="${idx}">Save automation</button>`
            : ''
        }
        ${formatTelemetryBadge(item.usage)}
      </div>`
    : '';

  const model = state.config?.model || 'model';
  const isWarming = state.config?.provider === 'ollama' && requestOllamaWarmup.isPending(model);
  const phaseLabel = escapeHtml(getLivePhase(item, model, isWarming));

  const elapsedSec = Math.max(0, Math.floor((Date.now() - state.runStartedAt) / 1000));
  const liveStatusHtml = item.isStreaming
    ? `<div class="live-status-line"><span class="pulse-dot" aria-hidden="true"></span><span id="live-status-phase" aria-live="polite">${phaseLabel}</span> (<span id="live-elapsed-seconds">${elapsedSec}</span>s)...</div>`
    : '';

  return `
    <div class="msg-row" ${item.isStreaming ? 'id="live-assistant-row"' : ''}>
      <div class="msg-assistant${item.isError ? ' error' : ''}">
        ${liveStatusHtml}
        <div class="assistant-identity"><span class="assistant-avatar" aria-hidden="true">L</span><span>${escapeHtml(modelLabel)}</span><span class="assistant-provider-tag">${escapeHtml(provLabel)}</span></div>
        <div class="live-plan-slot">${buildPlanHtml(item)}</div>
        <div class="live-thinking-slot">${thinkingHtml}</div>
        <div class="live-tools-slot">${toolsSummaryHtml}${toolsHtml}</div>
        <div class="live-self-improved-slot">${selfImprovedHtml}</div>
        <div class="live-md-slot">${item.content ? `<div class="md-body">${renderMarkdown(item.content)}</div>` : ''}${blankReplyHtml}</div>
        ${actionsHtml}
        ${buildFollowupChipsHtml(item, idx, isLastCompleted)}
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

  const historyHtml = historyItems
    .map((item, idx) => buildDisplayItemHtml(item, idx, !showLiveHere && idx === historyItems.length - 1))
    .join('');
  const liveHtml = showLiveHere ? buildDisplayItemHtml(state.liveAssistantMsg, historyItems.length, false) : '';

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
      const model = state.config?.model || 'model';
      const isWarming = state.config?.provider === 'ollama' && requestOllamaWarmup.isPending(model);
      phaseEl.textContent = getLivePhase(item, model, isWarming);
    }

    const thinkingCombined = (item.thinking || []).join('').trim();
    if (item._lastThinkingRendered !== thinkingCombined) {
      item._lastThinkingRendered = thinkingCombined;
      const thinkSlot = liveRow.querySelector('.live-thinking-slot');
      if (thinkSlot) {
        thinkSlot.innerHTML = formatThinkingHtml(thinkingCombined, !item.content);
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
  state.collapsedToolGroups.clear();
  state.editingMessageIndex = null;
  if (state.activeSession?.id !== id) {
    closeArtifactCanvas();
    state.artifactsList = [];
    state.activeArtifact = null;
    renderArtifactSwitcher();
  }
  const searchInput = $('#session-search');
  if (searchInput) searchInput.value = '';
  state.activeSession = res.session;
  state.contextTokens = estimateTokens(state.activeSession.messages || []);
  updateContextMeter(state.contextTokens, state.config?.numCtx);
  syncSessionToolbar();
  switchView('agent');
  await loadSessions();
  renderMessages(true);
}

async function createNewTask() {
  const res = await apiRequest('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title: 'New Task',
      mode: $('#composer-mode-select')?.value || 'auto',
    }),
  });
  state.activeSession = res.session;
  state.collapsedToolGroups.clear();
  state.editingMessageIndex = null;
  closeArtifactCanvas();
  state.artifactsList = [];
  state.activeArtifact = null;
  renderArtifactSwitcher();
  if (!state.isRunning) state.liveAssistantMsg = null;
  state.contextTokens = 0;
  updateContextMeter(0, state.config?.numCtx);
  syncSessionToolbar();
  await loadSessions();
  switchView('agent');
  renderMessages(true);
  $('#prompt-input').focus();
}

function getSlashCandidates(query = '') {
  const q = String(query || '').toLowerCase();
  const instantItems = INSTANT_ACTIONS.map((a) => ({
    cmd: `/${a.id.replace(/_/g, '-')}`,
    desc: `${a.desc} (on-device · no AI)`,
    tag: 'Instant',
    action: () => runInstantActionTurn(a.id, a.label),
  }));
  const skillItems = (state.skills || []).map((s) => ({
    cmd: `/${s.slug}`,
    desc: s.description || 'Installed skill playbook',
    tag: 'Skill',
    prompt: `Use the "${s.slug}" skill (call read_skill first) to help with: `,
    autoRun: false,
  }));
  const all = [...instantItems, ...SLASH_COMMANDS, ...skillItems];
  return all
    .filter((item) => !q || item.cmd.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q))
    .slice(0, 12);
}

async function runInstantActionTurn(id, label) {
  if (!id) return;
  await sendPrompt({ text: label, attachments: [], instantAction: id });
}

function hideSlashMenu() {
  state.slashOpen = false;
  state.slashItems = [];
  state.slashIndex = 0;
  const menu = $('#slash-menu');
  if (menu) {
    menu.classList.add('hidden');
    menu.innerHTML = '';
  }
}

function renderSlashMenu(filter = '') {
  const menu = $('#slash-menu');
  if (!menu) return;
  const items = getSlashCandidates(filter);
  if (items.length === 0) {
    hideSlashMenu();
    return;
  }
  state.slashOpen = true;
  state.slashItems = items;
  if (state.slashIndex >= items.length) state.slashIndex = 0;
  menu.classList.remove('hidden');
  menu.innerHTML = items
    .map(
      (item, idx) => `<button type="button" class="slash-item${idx === state.slashIndex ? ' active' : ''}" data-idx="${idx}" role="option" aria-selected="${idx === state.slashIndex}">
        <span class="slash-cmd">${escapeHtml(item.cmd)}</span>
        <span class="slash-desc">${escapeHtml(item.desc)}</span>
        <span class="slash-tag">${escapeHtml(item.tag)}</span>
      </button>`
    )
    .join('');

  menu.querySelectorAll('.slash-item').forEach((btn) => {
    btn.addEventListener('click', () => selectSlashItem(Number(btn.dataset.idx)));
  });
  menu.querySelector('.slash-item.active')?.scrollIntoView({ block: 'nearest' });
}

function moveSlashSelection(delta) {
  if (!state.slashOpen || state.slashItems.length === 0) return;
  state.slashIndex = (state.slashIndex + delta + state.slashItems.length) % state.slashItems.length;
  renderSlashMenu($('#prompt-input')?.value?.trim().slice(1) || '');
}

async function selectSlashItem(index) {
  const item = state.slashItems[index];
  if (!item) return;
  hideSlashMenu();
  const input = $('#prompt-input');
  if (typeof item.action === 'function') {
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }
    await item.action();
    return;
  }
  if (input) {
    input.value = item.prompt || '';
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    input.focus();
  }
  if (item.autoRun) {
    await sendPrompt();
  }
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

/**
 * Map a raw model/stream error to a short, actionable message so a failure tells the
 * user what to do next instead of dumping a socket error. The technical detail is kept
 * for debugging but shown last.
 */
const ERROR_HINTS = [
  // Specific before generic: these messages also contain "Ollama", so they must
  // not be reported as "the local model is not responding".
  [/XML syntax error|malformed (tool|function)|closed by <\//i, {
    title: 'The model produced a malformed tool call.',
    hint: 'It is retried automatically — send it again if this one failed, or switch to a smaller model.',
  }],
  [/ECONNREFUSED|connection refused|fetch failed|ENOTFOUND|EAI_AGAIN|network|ollama/i, {
    title: "The local model isn't responding.",
    hint: 'Make sure Ollama is running — use "Start / Check Ollama" in Models & Settings.',
  }],
  [/401|unauthorized|forbidden|invalid (api )?key|api key|authentication/i, {
    title: 'The provider rejected the request.',
    hint: 'Check the API key for this provider in Models & Settings.',
  }],
  [/429|rate.?limit|too many requests|quota/i, {
    title: 'The provider is rate-limiting right now.',
    hint: 'Wait a few seconds and send it again.',
  }],
  [/model_not_found|no such model|model .*not (found|available)|pull .*model/i, {
    title: 'That model is not available.',
    hint: 'Pick an installed model in Models & Settings (or pull it there).',
  }],
  [/timed? ?out|timeout|ETIMEDOUT|deadline/i, {
    title: 'The request timed out.',
    hint: 'Try again — or split the task into smaller steps.',
  }],
  [/maximum context|context length|too long|exceeds? .*tokens|prompt is too long/i, {
    title: 'The conversation is too long for the model\u2019s context.',
    hint: 'It compacts automatically \u2014 send the message again.',
  }],
];

function friendlyError(message) {
  const detail = String(message || 'Model error');
  for (const [re, info] of ERROR_HINTS) {
    if (re.test(detail)) return { ...info, detail };
  }
  return { title: 'Something went wrong.', hint: 'Try again, or check Models & Settings.', detail };
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
      body: JSON.stringify({
        title: text.slice(0, 48) || 'New Task',
        mode: $('#composer-mode-select')?.value || 'auto',
      }),
    });
    state.activeSession = created.session;
    syncSessionToolbar();
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
      const phaseEl = $('#live-status-phase');
      const item = state.liveAssistantMsg;
      if (phaseEl && item) {
        const model = state.config?.model || 'model';
        const isWarming = state.config?.provider === 'ollama' && requestOllamaWarmup.isPending(model);
        phaseEl.textContent = getLivePhase(item, model, isWarming);
      }
    }
  }, 1000);

  $('#send-btn').textContent = 'Queue';
  $('#stop-btn').classList.remove('hidden');
  hideSlashMenu();
  renderSidebarBadges();
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
        cwd: state.activeSession?.cwd || undefined,
        mode: $('#composer-mode-select')?.value || state.activeSession?.mode || 'auto',
        instantAction: overridePayload?.instantAction || undefined,
      },
      (evt) => {
        if (!state.liveAssistantMsg) return;
        if (evt.type === 'thinking_delta') {
          state.liveAssistantMsg.thinking.push(evt.text);
        } else if (evt.type === 'text_delta') {
          state.liveAssistantMsg.content += evt.text;
        } else if (evt.type === 'response_reset') {
          // Tool-step narration is not the answer: drop it from the live bubble before the tool runs.
          state.liveAssistantMsg.content = '';
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
        } else if (evt.type === 'done') {
          if (evt.usage) {
            if (Number.isFinite(evt.usage.durationMs)) recordLatency(evt.usage.durationMs);
            const totalTok = (Number(evt.usage.promptTokens) || 0) + (Number(evt.usage.completionTokens) || 0);
            if (totalTok > 0) recordTokenUsage(totalTok);
            if (evt.usage.model && Number(evt.usage.completionTokens) > 0) {
              recordModelSpeed(evt.usage.model, {
                durationMs: Number(evt.usage.durationMs),
                completionTokens: Number(evt.usage.completionTokens),
              });
            }
          }
          return;
        } else if (evt.type === 'error') {
          const friendly = friendlyError(evt.message);
          showToast(friendly.title);
          state.liveAssistantMsg.isError = true;
          state.liveAssistantMsg.content += `\n\n**${friendly.title}** ${friendly.hint}\n\nTechnical detail: ${friendly.detail}`;
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
    $('#send-btn').textContent = 'Send';
    $('#stop-btn').classList.add('hidden');
    renderSidebarBadges();

    if (state.activeSession?.id === runSessionId) {
      try {
        const refreshed = await apiRequest(`/api/sessions/${encodeURIComponent(runSessionId)}`);
        if (state.activeSession?.id === runSessionId) {
          state.activeSession = refreshed.session;
          syncSessionToolbar();
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

  const speeds = getModelSpeeds();
  const fastestModel = Object.entries(speeds)
    .filter(([, entry]) => Number(entry?.tps) > 0)
    .sort((a, b) => Number(b[1].tps) - Number(a[1].tps))[0]?.[0];
  const localItems =
    ollamaModels.length > 0
      ? ollamaModels
          .map((m) => {
            // Show the speed this Mac actually measured, not a spec sheet number.
            // It is the only honest way to answer "is 9B worth the wait?".
            const tps = Number(speeds[m.name]?.tps) || 0;
            const speedText = tps > 0 ? ` · ~${tps.toFixed(1)} tok/s` : '';
            const fastestTag = fastestModel === m.name && tps > 0 ? ' · fastest' : '';
            return `
          <button type="button" class="popover-item ${currentProv === 'ollama' && currentModel === m.name ? 'selected' : ''}" data-provider="ollama" data-model="${escapeHtml(m.name)}">
            <span>${escapeHtml(m.name)}</span>
            <small>${formatBytes(m.size)}${speedText}${fastestTag}</small>
          </button>`;
          })
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
  if (filtered.length === 0) {
    const rawQuery = ($('#skills-search').value || '').trim();
    $('#skills-grid').innerHTML = emptyState({
      icon: SPARK_ICON,
      tone: 'var(--app-5)',
      stacked: state.skills.length === 0,
      title: state.skills.length === 0 ? 'No skills yet' : 'No matching skills',
      detail:
        state.skills.length === 0
          ? 'A skill is a SKILL.md the agent loads when a task matches, so it stops relearning the same workflow. Write one by hand, import from GitHub, or save a good reply as a skill.'
          : `Nothing matches "${rawQuery}". Try a shorter word, or clear the search.`,
      action: state.skills.length === 0 ? { label: 'Create your first skill', attrs: 'data-empty-action="new-skill"' } : null,
    });
    return;
  }
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
      .join('');
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
  if (filtered.length === 0) {
    const rawQuery = ($('#knowledge-search').value || '').trim();
    $('#knowledge-grid').innerHTML = emptyState({
      icon: NOTE_ICON,
      tone: 'var(--app-6)',
      stacked: state.knowledge.length === 0,
      title: state.knowledge.length === 0 ? 'No knowledge docs yet' : 'No matching docs',
      detail:
        state.knowledge.length === 0
          ? 'Knowledge is the context the agent keeps about you: preferences, projects, people, house rules. Everything lives in plain markdown you can edit.'
          : `Nothing matches "${rawQuery}". Try a different tag or word.`,
      action:
        state.knowledge.length === 0
          ? { label: 'Write your first doc', attrs: 'data-empty-action="new-knowledge"' }
          : null,
    });
    return;
  }
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
      .join('');
}

// Automations View
async function loadAutomations() {
  const res = await apiRequest('/api/automations');
  state.automations = res.automations || [];
  renderAutomationsGrid();
}

/**
 * Shared "nothing here yet" block. The glyph is trusted inline SVG supplied by
 * the call site; every text field is escaped here so user-derived copy (skill
 * slugs, folder paths) can never inject markup.
 */
function emptyState({ icon = '', tone = 'var(--accent)', title, detail = '', action = null, compact = false, stacked = false }) {
  return `<div class="empty-state${compact ? ' compact' : ''}${stacked ? ' stacked' : ''}" role="status" style="--empty-tone:${tone}">
    ${icon ? `<div class="empty-state-icon" aria-hidden="true">${icon}</div>` : ''}
    <div class="empty-state-copy">
      <div class="empty-state-title">${escapeHtml(title)}</div>
      ${detail ? `<div class="empty-state-detail">${escapeHtml(detail)}</div>` : ''}
      ${action ? `<button type="button" class="primary-btn empty-state-action" ${action.attrs || ''}>${escapeHtml(action.label)}</button>` : ''}
    </div>
  </div>`;
}

const ZAP_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></svg>';
const NOTE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h9.5L20 8v12.5H6z"/><path d="M15 3.5V8h4.5M9 12.5h7M9 16h5"/></svg>';
const SPARK_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3.4"/></svg>';

function renderAutomationsGrid() {
  const grid = $('#automations-grid');
  if (state.automations.length === 0) {
    grid.innerHTML = emptyState({
      icon: ZAP_ICON,
      tone: 'var(--app-4)',
      title: 'No automations yet',
      detail: 'Save any agent reply as a one-click workflow, then schedule it to run quietly in the background. Nothing runs until you turn it on.',
      action: { label: 'Create your first automation', attrs: 'data-empty-action="new-automation"' },
      stacked: true,
    });
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

  const perfEl = $('#ui-perf-telemetry');
  if (perfEl) {
    let metrics = { latency: 0, tokens: 0 };
    try {
      metrics = getPerformanceMetrics();
    } catch {
      // storage optional
    }
    // Read paint timing from this page load instead of localStorage, so a value
    // captured by an earlier (possibly occluded) launch can never resurface.
    const paint = (performance.getEntriesByType?.('paint') || []).find((e) => e.name === 'first-contentful-paint');
    const items = perfSummary({
      readyMs: state.uiReadyMs,
      fcpMs: paint ? paint.startTime : null,
      latencyMs: metrics.latency,
      tokens: metrics.tokens,
    });
    perfEl.innerHTML = items.length
      ? items.map((t) => `<span class="telemetry-stat-pill">${escapeHtml(t)}</span>`).join('')
      : '<span class="telemetry-stat-pill">Telemetry collects after your first prompt</span>';
  }

  const activeOllamaModel = state.config?.model || '';
  $('#ollama-models-list').innerHTML =
    (ollama.models || [])
      .map((m) => {
        const pill =
          m.name === activeOllamaModel
            ? '<span class="pill pill-green"><span class="pill-dot"></span>Active</span>'
            : '<span class="pill pill-muted"><span class="pill-dot"></span>Ready</span>';
        return `
      <div class="model-row">
        <div>
          <strong>${escapeHtml(m.name)}</strong>
          <div class="status-sub">${formatBytes(m.size)}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          ${pill}
          <button type="button" class="secondary-btn use-ollama-btn" data-model="${escapeHtml(m.name)}">Use</button>
          <button type="button" class="danger-btn del-ollama-btn" data-model="${escapeHtml(m.name)}">Remove</button>
        </div>
      </div>`;
      })
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
          ${
            hasKey
              ? '<span class="pill pill-green"><span class="pill-dot"></span>Key saved</span>'
              : p.id === 'custom'
                ? '<span class="pill pill-muted"><span class="pill-dot"></span>Local / Custom</span>'
                : '<span class="pill pill-muted"><span class="pill-dot"></span>Not set</span>'
          }
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
let paletteReturnFocusEl = null;

// While a dialog is open nothing behind it should be reachable by Tab, a screen
// reader, or a stray click. inert does that in one attribute; the Tab handler
// below keeps focus inside for browsers that only partly implement it.
function setShellInert(on) {
  const shell = $('#app-shell') || $('#app');
  if (shell) shell.inert = Boolean(on);
}

function focusableIn(container) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null);
}

function trapTabKey(container, e) {
  if (e.key !== 'Tab') return;
  const items = focusableIn(container);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !container.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !container.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

function openModal(title, htmlContent) {
  modalReturnFocusEl = document.activeElement;
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = htmlContent;
  $('#modal-backdrop').classList.remove('hidden');
  setShellInert(true);
  $('#modal-close-btn')?.focus();
}

function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
  $('#modal-body').innerHTML = '';
  if ($('#palette-backdrop').classList.contains('hidden')) setShellInert(false);
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
      listEl.innerHTML = emptyState({
        icon: SPARK_ICON,
        tone: 'var(--app-5)',
        compact: true,
        title: 'No skills in this source',
        detail: `Nothing yet in ${source.dir}. Import a skill from GitHub or add a SKILL.md by hand.`,
      });
      return;
    }
    if (shown.length === 0) {
      listEl.innerHTML = emptyState({
        icon: SPARK_ICON,
        tone: 'var(--app-2)',
        compact: true,
        title: 'No matches',
        detail: `Nothing in ${source.dir} matches "${query}". Try a shorter word.`,
      });
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
    if (count > 0) requestOllamaWarmup.reset();
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
  { label: 'Switch color theme (Auto / Dark / Light)', hint: 'Cycle Graphite, Paper, Nordic, Solarized, or System Auto', keywords: 'theme dark light appearance mode', run: () => cycleTheme() },
  { label: 'Theme: Graphite Dark', hint: 'Native macOS dark appearance', keywords: 'theme dark graphite appearance', run: () => applyTheme('dark', true) },
  { label: 'Theme: Paper Light', hint: 'Native macOS light appearance', keywords: 'theme light paper appearance', run: () => applyTheme('light', true) },
  { label: 'Theme: Nordic Frost', hint: 'Cool Arctic dark palette', keywords: 'theme nord dark frost appearance', run: () => applyTheme('nord', true) },
  { label: 'Theme: Solarized Dark', hint: 'Balanced low-glare teal slate palette', keywords: 'theme solarized dark appearance', run: () => applyTheme('solarized', true) },
  { label: 'Theme: Auto (System)', hint: 'Match macOS Dark/Light appearance automatically', keywords: 'theme auto system appearance', run: () => applyTheme('auto', true) },
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
  paletteReturnFocusEl = document.activeElement;
  state.paletteOpen = true;
  state.paletteIndex = 0;
  $('#palette-backdrop').classList.remove('hidden');
  setShellInert(true);
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
  if ($('#modal-backdrop').classList.contains('hidden')) setShellInert(false);
  if (paletteReturnFocusEl && typeof paletteReturnFocusEl.focus === 'function') {
    paletteReturnFocusEl.focus();
  }
  paletteReturnFocusEl = null;
}

function toggleCommandPalette() {
  if (state.paletteOpen) closeCommandPalette();
  else openCommandPalette();
}

function openShortcutsModal() {
  const rows = [
    ['Command palette', ['⌘', 'K']],
    ['Switch views (Dashboard .. Automations)', ['⌘', '1–6']],
    ['Models & Settings', ['⌘', ',']],
    ['Open project folder', ['⌘', 'O']],
    ['Toggle sidebar', ['⌘', '\\']],
    ['Send message / paste image', ['⌘', '↵']],
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
  $('#dash-briefing-refresh')?.addEventListener('click', () => refreshBriefing(true));
  $('#dash-smart-assist')?.addEventListener('click', async (e) => {
    const dismissBtn = e.target.closest('[data-dismiss-sug]');
    if (dismissBtn) {
      const id = dismissBtn.dataset.dismissSug;
      state.suggestions = (state.suggestions || []).filter((s) => s.id !== id);
      renderSmartAssist();
      apiRequest('/api/suggestions/dismiss', { method: 'POST', body: JSON.stringify({ id }) }).catch(() => {});
      return;
    }
    const runBtn = e.target.closest('[data-run-sug]');
    if (runBtn) {
      const item = (state.suggestions || []).find((s) => s.id === runBtn.dataset.runSug);
      if (item?.action) await runCapability(item.action, true);
    }
  });
  $('#dash-speed-test')?.addEventListener('click', runSpeedTest);
  $('#dash-briefing-ask')?.addEventListener('click', () =>
    runCapability("Give me my daily briefing: summarize today's top world news, my email, and anything I should know.", true)
  );
  $('#dash-open-settings')?.addEventListener('click', () => switchView('settings'));
  $('#dash-mode-pill')?.addEventListener('click', () => switchView('settings'));
  $('#dash-explore-tools-btn')?.addEventListener('click', () => createNewTask());
  $('#dash-unload-ram-btn')?.addEventListener('click', unloadOllamaMemory);
  $('#monitor-unload-btn')?.addEventListener('click', unloadOllamaMemory);
  $('#theme-toggle-btn')?.addEventListener('click', cycleTheme);
  $('#dash-storage-alert')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-clean-downloads]')) runCapability(getCleanDownloadsPrompt(), true);
    if (e.target.closest('[data-storage-audit]')) loadStorageAudit();
  });

  $$('.superpower-card').forEach((card) => {
    card.addEventListener('click', async () => {
      await runCapability(card.dataset.prompt || '', card.dataset.autorun === 'true');
    });
  });

  $$('.welcome-cat-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.welcomeCategory = btn.dataset.cat || 'all';
      $$('.welcome-cat-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderWelcomeTaskGrid();
    });
  });

  $$('.mon-series-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.monitorChartSeries = btn.dataset.series || 'all';
      $$('.mon-series-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderMonitor();
    });
  });

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
    const privacyBtn = e.target.closest('[data-privacy-pane]');
    if (privacyBtn) {
      try {
        await apiRequest('/api/system/privacy-pane', {
          method: 'POST',
          body: JSON.stringify({ pane: privacyBtn.dataset.privacyPane || 'allfiles' }),
        });
        showToast('Opened Privacy & Security settings');
      } catch (err) {
        showToast(err.message || 'Could not open Privacy settings.');
      }
      return;
    }
    const copyCodeBtn = e.target.closest('.copy-code-btn');
    if (copyCodeBtn) {
      navigator.clipboard.writeText(copyCodeBtn.dataset.code || '');
      const orig = copyCodeBtn.textContent;
      copyCodeBtn.textContent = 'Copied ✓';
      setTimeout(() => {
        if (copyCodeBtn.isConnected) copyCodeBtn.textContent = orig || 'Copy';
      }, 1500);
      showToast('Code copied');
      return;
    }

    const collapseBtn = e.target.closest('.tools-collapse-btn');
    if (collapseBtn) {
      const idx = Number(collapseBtn.dataset.idx);
      if (state.collapsedToolGroups.has(idx)) state.collapsedToolGroups.delete(idx);
      else state.collapsedToolGroups.add(idx);
      renderMessages(false);
      return;
    }

    const userCopyBtn = e.target.closest('.user-copy-btn');
    if (userCopyBtn) {
      const target = state.displayedItems[Number(userCopyBtn.dataset.idx)];
      const raw = String(target?.msg?.content || '').replace(/\n\n\[Attached files\][\s\S]*$/, '');
      navigator.clipboard.writeText(raw);
      showToast('Prompt copied');
      return;
    }

    const openArtBtn = e.target.closest('.open-artifact-btn');
    if (openArtBtn) {
      await openArtifactInCanvas({
        code: openArtBtn.dataset.code || '',
        lang: openArtBtn.dataset.lang || 'text',
      });
      return;
    }

    const userEditBtn = e.target.closest('.user-edit-btn');
    if (userEditBtn) {
      const idx = Number(userEditBtn.dataset.idx);
      state.editingMessageIndex = idx;
      renderMessages(false);
      const editInput = $('#user-inline-edit-input');
      if (editInput) {
        editInput.focus();
        editInput.setSelectionRange(editInput.value.length, editInput.value.length);
      }
      return;
    }

    const userEditCancelBtn = e.target.closest('.user-edit-cancel-btn');
    if (userEditCancelBtn) {
      state.editingMessageIndex = null;
      renderMessages(false);
      return;
    }

    const userEditSaveBtn = e.target.closest('.user-edit-save-btn');
    if (userEditSaveBtn) {
      const idx = Number(userEditSaveBtn.dataset.idx);
      const target = state.displayedItems[idx];
      const newText = ($('#user-inline-edit-input')?.value || '').trim();
      if (!newText) return;
      if (state.activeSession?.id && Number.isInteger(target?.rawStartIndex)) {
        try {
          const trunc = await apiRequest(
            `/api/sessions/${encodeURIComponent(state.activeSession.id)}/truncate`,
            {
              method: 'POST',
              body: JSON.stringify({ keepCount: target.rawStartIndex }),
            }
          );
          state.activeSession = trunc.session;
        } catch (err) {
          showToast(err.message || 'Could not edit prompt');
          return;
        }
      }
      state.editingMessageIndex = null;
      await sendPrompt({ text: newText, attachments: target?.msg?.attachments || [] });
      return;
    }

    const forkBtn = e.target.closest('.user-fork-btn, .fork-turn-btn');
    if (forkBtn) {
      const idx = Number(forkBtn.dataset.idx);
      const target = state.displayedItems[idx];
      if (!state.activeSession?.id || !Number.isInteger(target?.rawEndIndex)) return;
      try {
        const forked = await apiRequest(
          `/api/sessions/${encodeURIComponent(state.activeSession.id)}/fork`,
          {
            method: 'POST',
            body: JSON.stringify({ upToIndex: target.rawEndIndex + 1 }),
          }
        );
        await openSession(forked.session.id);
        showToast('Conversation branched');
      } catch (err) {
        showToast(err.message || 'Could not branch conversation');
      }
      return;
    }

    const speakBtn = e.target.closest('.speak-reply-btn');
    if (speakBtn) {
      const idx = Number(speakBtn.dataset.idx);
      const target = state.displayedItems[idx];
      await toggleSpeakMessage(idx, target?.content || '');
      return;
    }

    const copyReplyBtn = e.target.closest('.copy-reply-btn, .followup-copy-btn');
    if (copyReplyBtn) {
      const target = state.displayedItems[Number(copyReplyBtn.dataset.idx)];
      navigator.clipboard.writeText(target?.content || '');
      showToast('Reply copied to clipboard');
      return;
    }

    const followupChip = e.target.closest('.followup-chip[data-prompt]');
    if (followupChip) {
      await sendPrompt({ text: followupChip.dataset.prompt || '', attachments: [] });
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
      const idx = Number(retryBtn.dataset.idx);
      let userItem = null;
      for (let i = idx - 1; i >= 0; i -= 1) {
        if (state.displayedItems[i]?.type === 'user') {
          userItem = state.displayedItems[i];
          break;
        }
      }
      if (userItem && state.activeSession?.id && Number.isInteger(userItem.rawStartIndex)) {
        const cleanUserText = String(userItem.msg?.content || '').replace(/\n\n\[Attached files\][\s\S]*$/, '');
        try {
          const trunc = await apiRequest(
            `/api/sessions/${encodeURIComponent(state.activeSession.id)}/truncate`,
            {
              method: 'POST',
              body: JSON.stringify({ keepCount: userItem.rawStartIndex }),
            }
          );
          state.activeSession = trunc.session;
          await sendPrompt({ text: cleanUserText, attachments: userItem.msg?.attachments || [] });
        } catch (err) {
          showToast(err.message || 'Could not regenerate turn');
        }
        return;
      }
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
  $('#skills-search').addEventListener('input', debounce(renderSkillsGrid, 90));
  $('#knowledge-search').addEventListener('input', debounce(renderKnowledgeGrid, 90));

  $('#sessions-list')?.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('.session-pin-btn');
    if (pinBtn) {
      e.stopPropagation();
      const id = pinBtn.dataset.pin;
      const target = state.sessions.find((s) => s.id === id);
      if (!target) return;
      try {
        const res = await apiRequest(`/api/sessions/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ pinned: !target.pinned }),
        });
        if (state.activeSession?.id === id) state.activeSession = res.session;
        await loadSessions();
        showToast(res.session.pinned ? 'Conversation pinned' : 'Conversation unpinned');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    const renameBtn = e.target.closest('.session-rename-btn');
    if (renameBtn) {
      e.stopPropagation();
      const target = state.sessions.find((s) => s.id === renameBtn.dataset.rename);
      if (target) openRenameSessionModal(target);
      return;
    }
    const delBtn = e.target.closest('.session-del-btn');
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.dataset.del;
      await apiRequest(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (state.activeSession?.id === id) {
        state.activeSession = null;
        syncSessionToolbar();
        renderMessages();
      }
      await loadSessions();
      return;
    }
    const item = e.target.closest('.session-item');
    if (item?.dataset.id) openSession(item.dataset.id);
  });

  $('#attachments-bar')?.addEventListener('click', (e) => {
    const rmBtn = e.target.closest('button[data-idx]');
    if (rmBtn) {
      state.attachments.splice(Number(rmBtn.dataset.idx), 1);
      renderAttachments();
      return;
    }
    const chip = e.target.closest('.attach-chip[data-path]');
    if (chip && hasSwiftBridge() && chip.dataset.path) {
      postSwiftAction('revealInFinder', { path: chip.dataset.path });
    }
  });

  $('#skills-grid')?.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('.edit-skill-btn');
    if (editBtn) {
      const res = await apiRequest(`/api/skills/${encodeURIComponent(editBtn.dataset.slug)}`);
      openSkillModal(res.skill);
      return;
    }
    const refreshBtn = e.target.closest('.refresh-skill-btn');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing...';
      try {
        await apiRequest(`/api/skills/${encodeURIComponent(refreshBtn.dataset.slug)}/refresh`, { method: 'POST' });
        await loadSkills();
        showToast(`Refreshed skill ${refreshBtn.dataset.slug}`);
      } catch (err) {
        showToast(err.message);
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh';
      }
      return;
    }
    const delBtn = e.target.closest('.del-skill-btn');
    if (delBtn) {
      await apiRequest(`/api/skills/${encodeURIComponent(delBtn.dataset.slug)}`, { method: 'DELETE' });
      await loadSkills();
      showToast(`Deleted skill ${delBtn.dataset.slug}`);
    }
  });

  $('#knowledge-grid')?.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('.edit-know-btn');
    if (editBtn) {
      const res = await apiRequest(`/api/knowledge/${encodeURIComponent(editBtn.dataset.name)}`);
      openKnowledgeModal(res.doc);
      return;
    }
    const delBtn = e.target.closest('.del-know-btn');
    if (delBtn) {
      await apiRequest(`/api/knowledge/${encodeURIComponent(delBtn.dataset.name)}`, { method: 'DELETE' });
      await loadKnowledge();
      showToast(`Deleted knowledge doc ${delBtn.dataset.name}`);
    }
  });

  $('#automations-grid')?.addEventListener('click', async (e) => {
    const runBtn = e.target.closest('.run-auto-btn');
    if (runBtn) {
      const auto = state.automations.find((x) => x.id === runBtn.dataset.id);
      if (!auto) return;
      await createNewTask();
      $('#prompt-input').value = auto.prompt;
      await sendPrompt();
      return;
    }
    const schedBtn = e.target.closest('.sched-auto-btn');
    if (schedBtn) {
      const auto = state.automations.find((x) => x.id === schedBtn.dataset.id);
      if (auto) openScheduleModal(auto);
      return;
    }
    const delBtn = e.target.closest('.del-auto-btn');
    if (delBtn) {
      await apiRequest(`/api/automations/${encodeURIComponent(delBtn.dataset.id)}`, { method: 'DELETE' });
      await loadAutomations();
      showToast('Automation deleted');
    }
  });

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
  promptInput.addEventListener('focus', () => {
    const model = state.config?.model;
    if (state.config?.provider !== 'ollama' || !model) return;
    requestOllamaWarmup(model).catch(() => {});
  });
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
    const val = promptInput.value;
    if (val.startsWith('/') && !/\s/.test(val)) {
      renderSlashMenu(val.slice(1));
    } else if (state.slashOpen) {
      hideSlashMenu();
    }
  });
  promptInput.addEventListener('keydown', (e) => {
    if (state.slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSlashSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSlashSelection(-1);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        selectSlashItem(state.slashIndex);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideSlashMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  $('#composer-slash-btn')?.addEventListener('click', () => {
    if (state.slashOpen) {
      hideSlashMenu();
      promptInput.focus();
      return;
    }
    if (!promptInput.value.startsWith('/')) {
      promptInput.value = '/';
    }
    promptInput.focus();
    renderSlashMenu(promptInput.value.slice(1));
  });

  $('#composer-clipboard-btn')?.addEventListener('click', async () => {
    try {
      const res = await apiRequest('/api/chat/clipboard');
      const clip = String(res.text || '').trim();
      if (!clip) {
        showToast('Clipboard is empty');
        return;
      }
      promptInput.value = promptInput.value ? `${promptInput.value}\n\n${clip}` : clip;
      promptInput.style.height = 'auto';
      promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
      promptInput.focus();
      showToast('Inserted clipboard text');
    } catch (err) {
      showToast(err.message || 'Could not read clipboard');
    }
  });

  $('#composer-screenshot-btn')?.addEventListener('click', async () => {
    const btn = $('#composer-screenshot-btn');
    if (btn) btn.disabled = true;
    try {
      showToast('Capturing screen…');
      const res = await apiRequest('/api/chat/screenshot', { method: 'POST', body: '{}' });
      if (res.path && !state.attachments.some((a) => a.path === res.path)) {
        state.attachments.push({ path: res.path, name: res.name || 'screenshot.png', previewUrl: res.previewUrl || null });
        renderAttachments();
      }
      promptInput.focus();
      showToast('Screenshot attached');
    } catch (err) {
      showToast(err.message || 'Could not capture screenshot');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.addEventListener('click', (e) => {
    if (state.slashOpen && !e.target.closest('#slash-menu') && !e.target.closest('#composer-slash-btn') && !e.target.closest('#prompt-input')) {
      hideSlashMenu();
    }
  });

  $('#send-btn').addEventListener('click', () => sendPrompt());
  $('#workspace-cwd-btn')?.addEventListener('click', pickWorkspaceFolder);
  $('#workspace-reveal-btn')?.addEventListener('click', () => {
    const cwd = state.activeSession?.cwd;
    if (cwd && hasSwiftBridge()) postSwiftAction('revealInFinder', { path: cwd });
  });
  $('#composer-mode-select')?.addEventListener('change', async (e) => {
    const mode = e.target.value || 'auto';
    if (state.activeSession?.id) {
      try {
        const res = await apiRequest(
          `/api/sessions/${encodeURIComponent(state.activeSession.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ mode }),
          }
        );
        state.activeSession = res.session;
      } catch (err) {
        showToast(err.message || 'Could not update mode');
        return;
      }
    }
    showToast(e.target.options[e.target.selectedIndex]?.text || `Mode: ${mode}`);
  });
  $('#composer-voice-btn')?.addEventListener('click', toggleVoiceDictation);
  $('#artifact-close-btn')?.addEventListener('click', closeArtifactCanvas);
  $$('.artifact-view-tab').forEach((btn) => {
    btn.addEventListener('click', () => setArtifactTab(btn.dataset.tab));
  });
  $('#artifact-copy-btn')?.addEventListener('click', () => {
    if (!state.activeArtifact?.code) return;
    navigator.clipboard.writeText(state.activeArtifact.code);
    showToast('Artifact code copied');
  });
  $('#artifact-save-btn')?.addEventListener('click', () => {
    const art = state.activeArtifact;
    if (!art?.code) return;
    const extMap = {
      html: 'html',
      htm: 'html',
      svg: 'svg',
      js: 'js',
      javascript: 'js',
      ts: 'ts',
      typescript: 'ts',
      py: 'py',
      python: 'py',
      css: 'css',
      json: 'json',
      md: 'md',
      markdown: 'md',
      sh: 'sh',
      bash: 'sh',
      yaml: 'yaml',
      yml: 'yml',
    };
    const ext = extMap[art.lang] || 'txt';
    const base = String(art.title || 'artifact')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'artifact';
    const filename = `${base}.${ext}`;
    if (hasSwiftBridge()) {
      postSwiftAction('saveFile', { filename, content: art.code });
      return;
    }
    const blob = new Blob([art.code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Saved ${filename}`);
  });
  $('#artifact-switcher')?.addEventListener('click', (e) => {
    const pill = e.target.closest('.artifact-switch-pill[data-art-idx]');
    if (!pill) return;
    const target = state.artifactsList[Number(pill.dataset.artIdx)];
    if (target) openArtifactInCanvas(target);
  });
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

  $('#attach-btn').addEventListener('click', () => {
    if (hasSwiftBridge()) {
      postSwiftAction('pickFiles');
    } else {
      $('#browser-file-input').click();
    }
  });

  const uploadClientFile = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await apiRequest('/api/chat/attachment', {
            method: 'POST',
            body: JSON.stringify({
              filename: file.name || 'pasted-image.png',
              dataBase64: String(reader.result || ''),
            }),
          });
          resolve(res);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Could not read selected file.'));
      reader.readAsDataURL(file);
    });

  const handleSelectedClientFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    const directPaths = [];
    for (const file of files) {
      if (typeof file.path === 'string' && /^(\/|[A-Za-z]:\\)/.test(file.path)) {
        directPaths.push(file.path);
      } else {
        try {
          const uploaded = await uploadClientFile(file);
          if (uploaded?.path) directPaths.push(uploaded.path);
        } catch (err) {
          showToast(err.message || 'Could not attach file');
        }
      }
    }
    if (directPaths.length > 0) await window.__lgReceiveFiles(directPaths);
  };

  promptInput.addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.kind === 'file' && /^image\//i.test(item.type));
    if (imageItems.length === 0) return;
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter(Boolean);
    await handleSelectedClientFiles(files);
    if (files.length > 0) showToast('Pasted image attached');
  });

  $('#browser-file-input').addEventListener('change', async (e) => {
    await handleSelectedClientFiles(e.target.files);
    e.target.value = '';
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
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    overlay.classList.add('hidden');
    await handleSelectedClientFiles(e.dataTransfer?.files);
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
  $('#automations-grid').addEventListener('click', (e) => {
    if (e.target.closest('[data-empty-action="new-automation"]')) openAutomationModal();
  });
  $('#skills-grid').addEventListener('click', (e) => {
    if (e.target.closest('[data-empty-action="new-skill"]')) $('#new-skill-btn').click();
  });
  $('#knowledge-grid').addEventListener('click', (e) => {
    if (e.target.closest('[data-empty-action="new-knowledge"]')) $('#new-knowledge-btn').click();
  });
  $('#modal-close-btn').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('#modal-backdrop')) closeModal();
  });
  $('#modal-backdrop').addEventListener('keydown', (e) => trapTabKey($('.modal-card'), e));
  $('#palette-backdrop').addEventListener('keydown', (e) => trapTabKey($('.palette-card'), e));

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
    const viewShortcut = {
      '1': 'dashboard',
      '2': 'agent',
      '3': 'monitor',
      '4': 'schedule',
      '5': 'skills',
      '6': 'automations',
      ',': 'settings',
    }[e.key];
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
        return;
      }
      if (state.artifactDrawerOpen) {
        e.preventDefault();
        closeArtifactCanvas();
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

// Report window focus so the backend suppresses notification banners while the user is
// actively looking at the app — a banner then would be redundant and annoying.
function wireAppFocusReporting() {
  const report = () => {
    const focused = !document.hidden && document.hasFocus?.() !== false;
    apiRequest('/api/app-focus', { method: 'POST', body: JSON.stringify({ focused }) }).catch(() => {});
  };
  window.addEventListener('focus', report);
  window.addEventListener('blur', report);
  document.addEventListener('visibilitychange', report);
  report();
}

async function init() {
  try {
    setSidebarCollapsed(localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1', false);
    applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'auto', false);
  } catch {
    setSidebarCollapsed(false, false);
    applyTheme('auto', false);
  }
  renderWelcomeTaskGrid();
  renderInstantActions();
  wireEvents();
  wireStatTiles();
  wireAppFocusReporting();
  tickClock();
  setInterval(tickClock, 30000);
  await Promise.all([refreshHealth(), loadSessions(), loadSkills().catch(() => {})]);
  syncSessionToolbar();
  renderMessages(true);
  switchView('dashboard');
  // Time from navigation start to the first fully-populated screen. This is the
  // number that matters to a desktop app; paint entries can lag when the window
  // launches behind another app.
  state.uiReadyMs = performance.now();
  // Preload the configured local model while the user reads the dashboard.
  // Without this the first prompt paid the whole model load (one measured turn
  // spent ~120 s before its first token); the requester is idempotent, so focus
  // and this call collapse into one request.
  if (state.config?.provider === 'ollama' && state.config?.model) {
    setTimeout(() => requestOllamaWarmup(state.config.model).catch(() => {}), 1500);
  }
}

init().catch((err) => showToast(err.message));
