const state = {
  agent: null,
  property: null,
  settings: null,
  conversations: [],
  stats: null,
  filter: 'open',
  query: '',
  activeId: null,
  active: null,
  socket: null,
  listTimer: null,
  typingTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const el = (tag, className) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

boot();

async function boot() {
  bindStaticHandlers();
  try {
    const me = await api('/api/auth/me');
    state.agent = me.agent;
    state.property = me.property;
    await enterApp();
  } catch (error) {
    $('#app').hidden = false;
    toast(`Could not load the workspace: ${error.message}`);
  }
}

async function enterApp() {
  $('#app').hidden = false;
  $('#agent-name').textContent = state.agent.name;
  $('#agent-avatar').textContent = initials(state.agent.name);
  $('#agent-status').value = state.agent.status;
  updateStatusDot(state.agent.status);
  $('#property-name').textContent = state.property.name;
  await loadSettings();
  await loadConversations();
  connectSocket();
}

function bindStaticHandlers() {
  $('#filters').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    [...$('#filters').children].forEach((node) => node.classList.toggle('active', node === button));
    loadConversations();
  });

  let searchTimer;
  $('#search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = event.target.value.trim();
      loadConversations();
    }, 220);
  });

  $('#conversation-list').addEventListener('click', (event) => {
    const row = event.target.closest('.conv');
    if (row) selectConversation(row.dataset.id);
  });

  $('#reply-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#reply-input');
    const body = input.value.trim();
    if (!body || !state.activeId) return;
    input.value = '';
    input.style.height = 'auto';
    try {
      const result = await api(`/api/conversations/${state.activeId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      appendMessage(result.message);
      bumpConversation(result.message);
      sendSocket({ type: 'typing', conversationId: state.activeId, isTyping: false });
    } catch {
      toast('Could not send that reply.');
    }
  });

  $('#reply-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#reply-form').requestSubmit();
    }
  });

  let typingSent = 0;
  $('#reply-input').addEventListener('input', (event) => {
    const text = event.target.value;
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
    const now = Date.now();
    if (state.activeId && now - typingSent > 1200) {
      typingSent = now;
      sendSocket({ type: 'typing', conversationId: state.activeId, isTyping: Boolean(text) });
    }
  });

  $('#tag-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = event.target.tag;
    const tag = input.value.trim();
    if (!tag || !state.activeId) return;
    input.value = '';
    try {
      const result = await api(`/api/conversations/${state.activeId}/tags`, {
        method: 'POST', body: JSON.stringify({ add: [tag] }),
      });
      state.active.tags = result.tags;
      renderTags();
      refreshSoon();
    } catch {
      toast('Could not add that tag.');
    }
  });

  $('#tag-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-tag]');
    if (!button || !state.activeId) return;
    try {
      const result = await api(`/api/conversations/${state.activeId}/tags`, {
        method: 'POST', body: JSON.stringify({ remove: [button.dataset.tag] }),
      });
      state.active.tags = result.tags;
      renderTags();
    } catch {
      toast('Could not remove that tag.');
    }
  });

  $('#end-btn').addEventListener('click', async () => {
    if (!state.activeId) return;
    if (!confirm('End this conversation? The visitor will be notified.')) return;
    try {
      await api(`/api/conversations/${state.activeId}/end`, { method: 'POST' });
      toast('Conversation ended.');
      await loadConversations();
      await selectConversation(state.activeId, { silent: true });
    } catch {
      toast('Could not end the conversation.');
    }
  });

  $('#export-btn').addEventListener('click', () => {
    if (state.activeId) window.open(`/api/export/${state.activeId}`, '_blank', 'noopener');
  });

  $('#agent-status').addEventListener('change', async (event) => {
    const status = event.target.value;
    updateStatusDot(status);
    try {
      await api('/api/agents/me', { method: 'PATCH', body: JSON.stringify({ status }) });
      state.agent.status = status;
      sendSocket({ type: 'status', status });
    } catch {
      toast('Could not update your status.');
    }
  });

  $('#open-settings').addEventListener('click', openSettings);
  $('#close-settings').addEventListener('click', () => { $('#settings-modal').hidden = true; });
  $('#settings-modal').addEventListener('click', (event) => {
    if (event.target === $('#settings-modal')) $('#settings-modal').hidden = true;
  });
  $('#settings-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (!button) return;
    [...$('#settings-tabs').children].forEach((node) => node.classList.toggle('active', node === button));
    document.querySelectorAll('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== button.dataset.tab;
    });
  });
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#webhook-form').addEventListener('submit', addWebhook);
  $('#webhook-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-hook]');
    if (!button) return;
    if (!confirm('Delete this webhook endpoint?')) return;
    await api(`/api/webhooks/${button.dataset.hook}`, { method: 'DELETE' }).catch(() => {});
    await loadWebhooks();
  });
  $('#copy-embed').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#embed-code').textContent);
      $('#copy-done').hidden = false;
      setTimeout(() => { $('#copy-done').hidden = true; }, 1600);
    } catch {
      toast('Copy failed — select the snippet manually.');
    }
  });
}

/* -------------------------------------------------------------- data */
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload.data;
}

async function loadSettings() {
  const result = await api('/api/settings');
  state.settings = result.settings;
  state.property = result.property;
  $('#property-name').textContent = result.property.name;
  renderQuickReplies();
}

async function loadConversations({ keepActive = true } = {}) {
  try {
    const result = await api(`/api/conversations?status=${encodeURIComponent(state.filter)}&q=${encodeURIComponent(state.query)}`);
    state.conversations = result.conversations;
    state.stats = result.stats;
    renderConversations();
    renderStats();
    if (keepActive && state.activeId) {
      const exists = state.conversations.some((conversation) => conversation.id === state.activeId);
      if (!exists && state.filter !== 'all') {
        state.activeId = null;
        state.active = null;
        renderThread();
      }
    }
  } catch {
    toast('Could not load conversations.');
  }
}

function refreshSoon() {
  clearTimeout(state.listTimer);
  state.listTimer = setTimeout(() => loadConversations(), 450);
}

async function selectConversation(id, { silent = false } = {}) {
  if (!silent && state.activeId === id) return;
  state.activeId = id;
  document.querySelectorAll('.conv').forEach((row) => row.classList.toggle('active', row.dataset.id === id));
  try {
    const result = await api(`/api/conversations/${id}`);
    state.active = result.conversation;
    renderThread();
    renderDetails();
    const row = state.conversations.find((conversation) => conversation.id === id);
    if (row) row.unread_agent = 0;
    renderConversations();
  } catch {
    toast('Could not open that conversation.');
  }
}

/* -------------------------------------------------------------- render */
function renderStats() {
  const stats = state.stats;
  if (!stats) return;
  $('#stats').innerHTML = `
    <span class="stat-pill"><b>${stats.open}</b> open</span>
    <span class="stat-pill"><b>${stats.messagesToday}</b> messages today</span>
    <span class="stat-pill"><b>${stats.visitorsToday}</b> visitors today</span>
    <span class="stat-pill"><b>${stats.rating ?? '—'}</b> rating</span>`;
}

function renderConversations() {
  const list = $('#conversation-list');
  if (!state.conversations.length) {
    list.innerHTML = `<div class="list-empty">${state.query ? 'No conversations match that search.' : state.filter === 'open' ? 'No open conversations. New chats appear here in real time.' : 'Nothing here yet.'}</div>`;
    return;
  }
  list.innerHTML = state.conversations.map((conversation) => {
    const name = conversation.visitor_name || conversation.visitor_email || 'Visitor';
    return `
      <div class="conv ${conversation.id === state.activeId ? 'active' : ''}" data-id="${conversation.id}">
        <span class="conv-avatar">${escapeHtml(initials(name))}</span>
        <div class="conv-main">
          <div class="conv-top">
            <strong>${escapeHtml(name)}</strong>
            <span class="conv-time">${relativeTime(conversation.last_message_at)}</span>
          </div>
          <span class="conv-preview">${conversation.last_sender === 'agent' ? 'You: ' : ''}${escapeHtml(conversation.last_message || conversation.subject || 'No messages yet')}</span>
          ${conversation.tags.length ? `<span class="conv-tags">${conversation.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</span>` : ''}
        </div>
        ${conversation.unread_agent ? `<span class="unread-badge">${conversation.unread_agent}</span>` : ''}
      </div>`;
  }).join('');
}

function renderThread() {
  const empty = $('#thread-empty');
  const view = $('#thread-view');
  if (!state.active) {
    empty.hidden = false;
    view.hidden = true;
    return;
  }
  empty.hidden = true;
  view.hidden = false;
  const conversation = state.active;
  $('#thread-title').textContent = conversation.visitor_name || conversation.visitor_email || 'Visitor';
  const started = new Date(conversation.started_at);
  $('#thread-sub').textContent = `${conversation.status === 'open' ? 'Open' : 'Closed'} · started ${started.toLocaleString()}`;
  $('#end-btn').disabled = conversation.status !== 'open';
  renderMessages();
  renderQuickReplies();
}

function renderMessages() {
  const container = $('#messages');
  if (!state.active) { container.innerHTML = ''; return; }
  const messages = state.active.messages || [];
  if (!messages.length) {
    container.innerHTML = `<div class="list-empty">No messages yet. Say hello.</div>`;
    return;
  }
  let lastDay = '';
  const html = [];
  for (const message of messages) {
    const day = new Date(message.created_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (day !== lastDay) {
      lastDay = day;
      html.push(`<div class="day-divider">${escapeHtml(day)}</div>`);
    }
    if (message.type === 'system') {
      html.push(`<div class="msg-system">${escapeHtml(message.body)}</div>`);
      continue;
    }
    const mine = message.sender_type === 'agent';
    html.push(`
      <div class="msg-row ${mine ? 'mine' : ''}" data-message-id="${message.id}">
        <span class="msg-avatar">${escapeHtml(initials(mine ? message.sender_name || 'You' : state.active.visitor_name || 'V'))}</span>
        <div class="msg-stack">
          <span class="msg-author">${escapeHtml(mine ? message.sender_name || 'You' : state.active.visitor_name || 'Visitor')}</span>
          <div class="msg-bubble">${linkify(escapeHtml(message.body))}</div>
          <span class="msg-time">${formatTime(message.created_at)}${message.seen_at && mine ? ' · seen' : ''}</span>
        </div>
      </div>`);
  }
  container.innerHTML = html.join('');
  container.scrollTop = container.scrollHeight;
}

function appendMessage(message) {
  if (!state.active || !message) return;
  if (!message.conversation_id || message.conversation_id !== state.active.id) return;
  if (state.active.messages.some((existing) => existing.id === message.id)) return;
  state.active.messages.push(message);
  renderMessages();
}

function bumpConversation(message) {
  const row = state.conversations.find((conversation) => conversation.id === message.conversation_id);
  if (row) {
    row.last_message = message.body;
    row.last_message_at = message.created_at;
    row.last_sender = message.sender_type;
    state.conversations.sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)));
    renderConversations();
  }
}

function renderQuickReplies() {
  const container = $('#quick-replies');
  const replies = state.settings?.quickReplies || [];
  container.innerHTML = replies.map((reply) => `<button type="button" class="quick-reply" data-reply="${escapeHtml(reply)}">${escapeHtml(reply)}</button>`).join('');
  container.onclick = (event) => {
    const button = event.target.closest('[data-reply]');
    if (!button) return;
    const input = $('#reply-input');
    input.value = button.dataset.reply;
    input.focus();
  };
}

function renderDetails() {
  const body = $('#details-body');
  if (!state.active) {
    body.hidden = true;
    $('#details').querySelector('.details-empty').hidden = false;
    return;
  }
  body.hidden = false;
  $('#details').querySelector('.details-empty').hidden = true;
  const visitor = state.active;
  $('#visitor-name').textContent = visitor.visitor_name || 'Visitor';
  $('#visitor-email').textContent = visitor.visitor_email || 'No email yet';
  $('#visitor-avatar').textContent = initials(visitor.visitor_name || visitor.visitor_email || 'V');
  const page = $('#visitor-page');
  page.textContent = visitor.page_url || 'Unknown page';
  page.href = visitor.page_url || '#';
  const first = new Date(visitor.first_seen);
  const last = new Date(visitor.last_seen || visitor.started_at);
  $('#visitor-meta').textContent = `${visitor.city ? `${visitor.city}, ` : ''}${visitor.country || 'Unknown location'} · first seen ${first.toLocaleDateString()} · last active ${relativeTime(last.toISOString())}`;
  renderTags();
  const attributes = visitor.attributes || {};
  const entries = Object.entries(attributes);
  $('#attributes').innerHTML = entries.length
    ? entries.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value)}</dd>`).join('')
    : '<dt>No custom attributes</dt><dd></dd>';
  const events = visitor.events || [];
  $('#events').innerHTML = events.length
    ? events.slice(-8).reverse().map((event) => {
      const meta = event.meta && Object.keys(event.meta).length ? ` · ${escapeHtml(JSON.stringify(event.meta))}` : '';
      return `<li><span>${escapeHtml(event.name)}${meta}</span></li>`;
    }).join('')
    : '<li><span>Conversation started</span></li>';
}

function renderTags() {
  const tags = state.active?.tags || [];
  $('#tag-list').innerHTML = tags.map((tag) => `
    <span class="tag">${escapeHtml(tag)}<button type="button" data-tag="${escapeHtml(tag)}" aria-label="Remove ${escapeHtml(tag)}">×</button></span>`).join('')
    || '<span class="muted small">No tags</span>';
}

function renderTyping(show) {
  $('#visitor-typing').hidden = !show;
}

/* -------------------------------------------------------------- settings */
async function openSettings() {
  if (!state.settings) await loadSettings();
  const settings = state.settings;
  const form = $('#settings-form');
  form.name.value = state.property.name;
  form.color.value = settings.branding.color;
  form.greeting.value = settings.widget.greeting;
  form.subtitle.value = settings.widget.subtitle;
  form.position.value = settings.widget.position;
  form.showWhenOffline.checked = Boolean(settings.behavior.showWhenOffline);
  form.prechat.checked = Boolean(settings.behavior.prechat);
  form.rating.checked = Boolean(settings.features.rating);
  $('#embed-code').textContent = `<script>\n  window.Sparrow_API = window.Sparrow_API || {};\n  (function () {\n    var s = document.createElement('script');\n    s.async = true;\n    s.src = '${location.origin}/embed/${state.property.id}';\n    document.body.appendChild(s);\n  })();\n</script>`;
  $('#settings-modal').hidden = false;
  await loadWebhooks();
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.target;
  const payload = {
    branding: { color: form.color.value },
    widget: {
      greeting: form.greeting.value.trim(),
      subtitle: form.subtitle.value.trim(),
      position: form.position.value,
    },
    behavior: {
      showWhenOffline: form.showWhenOffline.checked,
      prechat: form.prechat.checked,
    },
    features: { rating: form.rating.checked },
  };
  try {
    const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    state.settings = result.settings;
    state.property.name = form.name.value.trim() || state.property.name;
    $('#property-name').textContent = state.property.name;
    renderQuickReplies();
    $('#settings-saved').hidden = false;
    setTimeout(() => { $('#settings-saved').hidden = true; }, 1600);
    toast('Settings saved. Reload the widget to see the new skin.');
  } catch {
    toast('Could not save settings.');
  }
}

async function loadWebhooks() {
  try {
    const result = await api('/api/webhooks');
    const list = $('#webhook-list');
    list.innerHTML = result.webhooks.length
      ? result.webhooks.map((hook) => `
        <li>
          <code>${escapeHtml(hook.url)}</code>
          <span class="muted small">${hook.events.join(', ')}</span>
          <button class="link-btn" data-hook="${hook.id}" aria-label="Delete webhook">Delete</button>
        </li>`).join('')
      : '<li class="muted small">No endpoints yet. Add one to receive chat events.</li>';
  } catch {
    /* ignore */
  }
}

async function addWebhook(event) {
  event.preventDefault();
  const input = event.target.url;
  try {
    const result = await api('/api/webhooks', {
      method: 'POST', body: JSON.stringify({ url: input.value.trim(), events: ['*'] }),
    });
    input.value = '';
    await loadWebhooks();
    toast(`Endpoint added. Secret: ${result.webhook.secret.slice(0, 12)}…`);
  } catch {
    toast('Could not add that endpoint. Use a full https URL.');
  }
}

/* -------------------------------------------------------------- realtime */
function connectSocket() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/ws/agent`);
  state.socket = socket;
  socket.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    handleRealtime(data);
  });
  socket.addEventListener('close', () => {
    setTimeout(connectSocket, 2500);
  });
}

function sendSocket(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
  }
}

function handleRealtime(data) {
  switch (data.type) {
    case 'message': {
      const message = data.message;
      if (state.activeId && message.conversation_id === state.activeId) {
        appendMessage(message);
      }
      if (message.sender_type === 'visitor') {
        refreshSoon();
        if (message.conversation_id !== state.activeId) {
          toast(`New message: ${message.body.slice(0, 70)}`);
        }
      }
      break;
    }
    case 'typing': {
      if (data.conversationId === state.activeId && data.from === 'visitor') {
        clearTimeout(state.typingTimer);
        renderTyping(data.isTyping);
        if (data.isTyping) {
          state.typingTimer = setTimeout(() => renderTyping(false), 4000);
        }
      }
      break;
    }
    case 'conversation:update':
    case 'seen':
      refreshSoon();
      break;
    case 'conversation:ended': {
      toast('A conversation ended.');
      refreshSoon();
      if (data.conversationId === state.activeId) {
        selectConversation(state.activeId, { silent: true });
      }
      break;
    }
    case 'visitor:online':
      refreshSoon();
      break;
    case 'visitor:update':
      if (data.conversationId === state.activeId && state.active) {
        state.active.visitor_name = data.visitor.name || state.active.visitor_name;
        state.active.visitor_email = data.visitor.email || state.active.visitor_email;
        renderDetails();
      }
      break;
    case 'ticket:create':
      toast('New offline message received.');
      break;
    case 'presence':
      break;
    case 'agent:status':
      break;
  }
}

/* -------------------------------------------------------------- helpers */
function updateStatusDot(status) {
  const dot = $('#status-dot');
  dot.className = `status-dot ${status === 'away' ? 'away' : status === 'offline' ? 'offline' : ''}`;
}

function toast(text) {
  const stack = $('#toast-stack');
  const node = el('div', 'toast');
  node.textContent = text;
  stack.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

function formatTime(value) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function relativeTime(value) {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  if (diff < minute) return 'now';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)}m`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))}h`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function linkify(text) {
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}
