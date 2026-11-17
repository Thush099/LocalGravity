import { apiRequest, hasSwiftBridge, postSwiftAction, setAuthToken, streamSse } from './lib/api.js';
import { escapeHtml, renderMarkdown } from './lib/markdown.js';

const state = {
  view: 'agent',
  subtab: 'skills',
  health: null,
  config: null,
  configuredKeys: {},
  presets: {},
  sessions: [],
  activeSession: null,
  skills: [],
  knowledge: [],
  automations: [],
  attachments: [],
  isRunning: false,
  runAbort: null,
  liveAssistantMsg: null,
  pendingApprovals: new Map(),
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

// Swift native bridges
window.__lgSetToken = (token) => setAuthToken(token);
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
  if (viewName === 'skills') {
    loadSkills();
    loadKnowledge();
  } else if (viewName === 'automations') {
    loadAutomations();
  } else if (viewName === 'settings') {
    refreshHealth();
  }
}

function updateHeaderControls() {
  if (!state.config) return;
  const prov = state.config.provider || 'ollama';
  const model = state.config.model || 'qwen3.5:9b';
  const provLabel = prov === 'ollama' ? 'Local' : state.presets?.[prov]?.label?.split(' ')[0] || prov;
  $('#active-model-label').textContent = `${model} (${provLabel})`;

  const thinkBtn = $('#thinking-toggle');
  thinkBtn.classList.toggle('active', Boolean(state.config.thinking));
  thinkBtn.textContent = `Thinking: ${state.config.thinking ? 'On' : 'Off'}`;

  const safetyBtn = $('#safety-toggle');
  const isAuto = state.config.safetyMode === 'auto';
  safetyBtn.classList.toggle('warn', isAuto);
  safetyBtn.textContent = `Safety: ${isAuto ? 'Auto' : 'Ask'}`;

  const ctxSelect = $('#num-ctx-select');
  if (ctxSelect) ctxSelect.value = String(state.config.numCtx || 16384);
}

function renderSidebarStatus() {
  if (!state.health) return;
  const { system, ollama } = state.health;
  $('#sidebar-chip-label').textContent = `${system.arch === 'arm64' ? 'Apple M-Series' : system.arch} · ${system.totalRamGb} GB`;

  const dot = $('#ollama-dot');
  const txt = $('#ollama-status-text');
  if (ollama?.running) {
    dot.className = 'status-dot online';
    txt.textContent = `Ollama ready (${ollama.models.length} models)`;
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
  const filtered = state.sessions.filter((s) => !q || (s.title || '').toLowerCase().includes(q));

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="status-sub" style="padding: 8px;">No tasks yet</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map(
      (s) => `
      <div class="session-item ${state.activeSession?.id === s.id ? 'active' : ''}" data-id="${escapeHtml(s.id)}">
        <span class="session-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>
        ${s.source === 'scheduled' ? '<span class="session-badge">Auto</span>' : ''}
        <button type="button" class="session-del-btn" data-del="${escapeHtml(s.id)}" title="Delete session">×</button>
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
        currentAssistant = { type: 'assistant', thinking: [], tools: [], content: '' };
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
    } else if (msg.role === 'tool' && currentAssistant) {
      const toolEntry = currentAssistant.tools.find((t) => t.id === msg.toolCallId);
      if (toolEntry) {
        toolEntry.output = msg.content || '';
        toolEntry.diff = msg.diff || '';
        toolEntry.images = msg.images || [];
        toolEntry.status = String(msg.content || '').startsWith('Blocked') || String(msg.content || '').startsWith('Tool ') ? 'fail' : 'ok';
      }
    }
  }
  return items;
}

function renderMessages() {
  const messages = state.activeSession?.messages || [];
  const hasAny = messages.length > 0 || Boolean(state.liveAssistantMsg);
  $('#welcome-state').classList.toggle('hidden', hasAny);
  const container = $('#chat-messages');

  if (!hasAny) {
    container.innerHTML = '';
    return;
  }

  const displayItems = groupMessagesForDisplay(messages);
  if (state.liveAssistantMsg) {
    displayItems.push(state.liveAssistantMsg);
  }

  container.innerHTML = displayItems
    .map((item, idx) => {
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

      const thinkingCombined = item.thinking.join('\n').trim();
      const thinkingHtml = thinkingCombined
        ? `<details class="thinking-box" ${item.isStreaming && !item.content ? 'open' : ''}><summary>Thinking</summary><div class="thinking-content">${escapeHtml(thinkingCombined)}</div></details>`
        : '';

      const toolsHtml = item.tools
        .map((t) => {
          const badgeCls = t.status === 'ok' ? 'ok' : t.status === 'fail' ? 'fail' : t.status === 'wait' ? 'wait' : '';
          const badgeLabel =
            t.status === 'ok'
              ? 'Done'
              : t.status === 'fail'
                ? 'Blocked / Error'
                : t.status === 'wait'
                  ? 'Needs approval'
                  : 'Running';
          const bodyText = t.diff || t.output || JSON.stringify(t.arguments || {}, null, 2);
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
                    ? `<input type="text" class="approval-cmd-edit" value="${escapeHtml(t.approval.preview || t.arguments?.command || '')}" />`
                    : `<pre class="tool-body" style="margin:0;">${escapeHtml(t.approval.preview || '')}</pre>`
                }
                <div class="approval-actions">
                  <button type="button" class="primary-btn approve-btn" data-tool-id="${escapeHtml(t.id)}">Approve & Run</button>
                  <button type="button" class="danger-btn deny-btn" data-tool-id="${escapeHtml(t.id)}">Deny</button>
                </div>
              </div>`;
          }

          return `
            <div class="tool-card">
              <div class="tool-head">
                <span class="tool-name">${escapeHtml(t.name)}</span>
                <span class="tool-badge ${badgeCls}">${badgeLabel}</span>
              </div>
              <div class="tool-body">${escapeHtml(bodyText)}</div>
              ${thumbs}
              ${approvalHtml}
            </div>`;
        })
        .join('');

      const actionsHtml =
        !item.isStreaming && item.content
          ? `<div class="msg-actions">
              <button type="button" class="msg-action-btn copy-reply-btn" data-idx="${idx}">Copy reply</button>
              <button type="button" class="msg-action-btn teach-skill-btn" data-idx="${idx}">Teach as skill</button>
              <button type="button" class="msg-action-btn save-auto-btn" data-idx="${idx}">Save automation</button>
            </div>`
          : '';

      return `
        <div class="msg-row">
          <div class="msg-assistant">
            ${thinkingHtml}
            ${toolsHtml}
            ${item.content ? `<div class="md-body">${renderMarkdown(item.content)}</div>` : ''}
            ${actionsHtml}
          </div>
        </div>`;
    })
    .join('');

  // Wire interactive events on rendered cards
  container.querySelectorAll('.copy-code-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.code || '');
      showToast('Code copied');
    });
  });

  container.querySelectorAll('.copy-reply-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = displayItems[Number(btn.dataset.idx)];
      navigator.clipboard.writeText(target?.content || '');
      showToast('Reply copied');
    });
  });

  container.querySelectorAll('.teach-skill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#prompt-input').value =
        'Distill the exact working workflow we just completed into a reusable SKILL.md using save_skill.';
      sendPrompt();
    });
  });

  container.querySelectorAll('.save-auto-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lastUser = [...(state.activeSession?.messages || [])].reverse().find((m) => m.role === 'user');
      openAutomationModal({ name: state.activeSession?.title || '', prompt: lastUser?.content || '' });
    });
  });

  container.querySelectorAll('.approve-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const toolCallId = btn.dataset.toolId;
      const panel = btn.closest('.approval-panel');
      const editedInput = panel?.querySelector('.approval-cmd-edit');
      const editedCommand = editedInput ? editedInput.value : undefined;
      await resolveApproval(toolCallId, true, editedCommand);
    });
  });

  container.querySelectorAll('.deny-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await resolveApproval(btn.dataset.toolId, false);
    });
  });

  const scrollBox = $('#chat-scroll');
  scrollBox.scrollTop = scrollBox.scrollHeight;
}

async function resolveApproval(toolCallId, approved, editedCommand) {
  if (!state.activeSession) return;
  const tool = state.liveAssistantMsg?.tools?.find((t) => t.id === toolCallId);
  if (tool) {
    tool.approval = null;
    tool.status = approved ? 'running' : 'fail';
    renderMessages();
  }
  await apiRequest(`/api/sessions/${encodeURIComponent(state.activeSession.id)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ toolCallId, approved, editedCommand }),
  });
}

async function loadSessions() {
  const res = await apiRequest('/api/sessions');
  state.sessions = res.sessions || [];
  renderSessionsList();
}

async function openSession(id) {
  const res = await apiRequest(`/api/sessions/${encodeURIComponent(id)}`);
  state.activeSession = res.session;
  switchView('agent');
  renderSessionsList();
  renderMessages();
}

async function createNewTask() {
  const res = await apiRequest('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'New Task' }),
  });
  state.activeSession = res.session;
  state.liveAssistantMsg = null;
  await loadSessions();
  switchView('agent');
  renderMessages();
  $('#prompt-input').focus();
}

async function sendPrompt() {
  if (state.isRunning) return;
  const input = $('#prompt-input');
  const text = input.value.trim();
  if (!text && state.attachments.length === 0) return;

  if (!state.activeSession) {
    const created = await apiRequest('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: text.slice(0, 48) || 'New Task' }),
    });
    state.activeSession = created.session;
  }

  const attachPaths = state.attachments.map((a) => a.path);
  input.value = '';
  input.style.height = 'auto';
  state.attachments = [];
  renderAttachments();

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
  };
  state.isRunning = true;
  state.runAbort = new AbortController();
  $('#send-btn').classList.add('hidden');
  $('#stop-btn').classList.remove('hidden');
  renderMessages();

  try {
    await streamSse(
      `/api/sessions/${encodeURIComponent(state.activeSession.id)}/run`,
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
        } else if (evt.type === 'tool_call') {
          state.liveAssistantMsg.tools.push({
            id: evt.toolCallId,
            name: evt.name,
            arguments: evt.arguments,
            status: 'running',
            output: '',
            diff: '',
            images: [],
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
          }
        } else if (evt.type === 'context_stats') {
          $('#context-label').textContent = `${(evt.tokens / 1000).toFixed(1)}k / ${Math.round(evt.numCtx / 1000)}k`;
        } else if (evt.type === 'compacted') {
          showToast('Context compacted automatically');
        } else if (evt.type === 'error') {
          showToast(evt.message || 'Model error');
          state.liveAssistantMsg.content += `\n\n> Error: ${evt.message}`;
        }
        renderMessages();
      },
      state.runAbort.signal
    );

    const refreshed = await apiRequest(`/api/sessions/${encodeURIComponent(state.activeSession.id)}`);
    state.activeSession = refreshed.session;
    await loadSessions();
  } catch (err) {
    if (err.name !== 'AbortError') showToast(err.message);
  } finally {
    state.isRunning = false;
    state.runAbort = null;
    state.liveAssistantMsg = null;
    $('#send-btn').classList.remove('hidden');
    $('#stop-btn').classList.add('hidden');
    renderMessages();
  }
}

// Model Switcher Popover
function renderModelPopover() {
  const pop = $('#model-popover');
  const ollamaModels = state.health?.ollama?.models || [];
  const currentProv = state.config?.provider || 'ollama';
  const currentModel = state.config?.model || 'qwen3.5:9b';

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
          <span class="card-tag">${s.isStarter ? 'Starter' : 'Learned'}</span>
        </div>
        <div class="card-desc">${escapeHtml(s.description)}</div>
        <div class="card-actions">
          <button type="button" class="secondary-btn edit-skill-btn" data-slug="${escapeHtml(s.slug)}">Edit</button>
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
          <span class="card-tag">${d.name === 'MEMORY' ? 'Pinned Memory' : `${d.sizeBytes} B`}</span>
        </div>
        <div class="card-desc">ID: <code>${escapeHtml(d.name)}</code>${d.tags?.length ? ` · Tags: ${escapeHtml(d.tags.join(', '))}` : ''}</div>
        <div class="card-actions">
          <button type="button" class="secondary-btn edit-know-btn" data-name="${escapeHtml(d.name)}">Open / Edit</button>
          ${d.name !== 'MEMORY' ? `<button type="button" class="danger-btn del-know-btn" data-name="${escapeHtml(d.name)}">Delete</button>` : ''}
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
      const res = await apiRequest('/api/models/config', {
        method: 'POST',
        body: JSON.stringify({ apiKeys: { [prov]: null }, provider: 'ollama', model: 'qwen3.5:9b' }),
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
function openModal(title, htmlContent) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = htmlContent;
  $('#modal-backdrop').classList.remove('hidden');
}

function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
  $('#modal-body').innerHTML = '';
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

async function openImportAntigravityModal() {
  const res = await apiRequest('/api/skills/external');
  const items = res.skills || [];
  openModal(
    'Import Skills from Antigravity',
    items.length === 0
      ? `<p class="section-hint">No external skills found in <code>${escapeHtml(res.sourceDir)}</code>.</p>`
      : `
        <p class="section-hint">Select skills from <code>${escapeHtml(res.sourceDir)}</code> to copy into LocalGravity:</p>
        <div style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;">
          ${items
            .map(
              (s) => `
            <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;">
              <input type="checkbox" class="ag-skill-cb" value="${escapeHtml(s.slug)}" />
              <div><strong>${escapeHtml(s.slug)}</strong><div class="status-sub">${escapeHtml(s.description)}</div></div>
            </label>`
            )
            .join('')}
        </div>
        <div class="modal-footer">
          <button type="button" class="secondary-btn" id="m-cancel">Cancel</button>
          <button type="button" class="primary-btn" id="m-do-import">Import selected</button>
        </div>`
  );
  const cancelBtn = $('#m-cancel');
  if (cancelBtn) cancelBtn.onclick = closeModal;
  const importBtn = $('#m-do-import');
  if (importBtn) {
    importBtn.onclick = async () => {
      const names = $$('.ag-skill-cb:checked').map((cb) => cb.value);
      if (names.length === 0) return;
      const imp = await apiRequest('/api/skills/import-antigravity', {
        method: 'POST',
        body: JSON.stringify({ names }),
      });
      closeModal();
      await loadSkills();
      showToast(`Imported ${imp.imported.length} skill(s)`);
    };
  }
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
}

function wireEvents() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $$('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.subtab = btn.dataset.subtab;
      $$('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      $$('.subtab').forEach((t) => t.classList.toggle('active', t.id === `subtab-${state.subtab}`));
    });
  });

  $('#new-task-btn').addEventListener('click', createNewTask);
  $('#session-search').addEventListener('input', renderSessionsList);
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
    renderMessages();
    showToast(res.compacted ? 'Conversation compacted' : 'Context is already compact');
  });

  const promptInput = $('#prompt-input');
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
  });
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  $('#send-btn').addEventListener('click', sendPrompt);
  $('#stop-btn').addEventListener('click', async () => {
    state.runAbort?.abort();
    if (state.activeSession) {
      await apiRequest(`/api/sessions/${encodeURIComponent(state.activeSession.id)}/cancel`, { method: 'POST' });
    }
  });

  $$('.quick-card').forEach((card) => {
    card.addEventListener('click', () => {
      promptInput.value = card.dataset.prompt || '';
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
  $('#import-ag-skills-btn').addEventListener('click', openImportAntigravityModal);
  $('#new-knowledge-btn').addEventListener('click', () => openKnowledgeModal(null));
  $('#upload-knowledge-btn').addEventListener('click', () => $('#knowledge-file-input').click());
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

  window.addEventListener('focus', () => {
    loadSessions().catch(() => {});
  });
}

async function init() {
  wireEvents();
  await Promise.all([refreshHealth(), loadSessions()]);
  renderMessages();
}

init().catch((err) => showToast(err.message));
