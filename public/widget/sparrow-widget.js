const ACCOUNT_KEY = window.$_Sparrow_AccountKey;
const WIDGET_ID = window.$_Sparrow_WidgetId || 'default';
const SERVER = (window.$_Sparrow_Server || window.location.origin).replace(/\/$/, '');
const STORAGE_KEY = `sparrow:${ACCOUNT_KEY}`;

if (ACCOUNT_KEY && !document.getElementById('sparrow-widget-host')) {
  boot();
}

async function boot() {
  const stored = readStore();
  const api = (window.Sparrow_API = window.Sparrow_API || {});
  const callbacks = {
    onLoad: api.onLoad,
    onStatusChange: api.onStatusChange,
    onChatMaximized: api.onChatMaximized,
    onChatMinimized: api.onChatMinimized,
    onChatStarted: api.onChatStarted,
    onChatEnded: api.onChatEnded,
  };
  const queued = Array.isArray(window.__sparrowQueue) ? window.__sparrowQueue : [];

  const state = {
    settings: null,
    pageStatus: 'offline',
    session: null,
    messages: [],
    open: false,
    view: 'home',
    ws: null,
    connected: false,
    reconnectAttempts: 0,
    unread: 0,
    typing: false,
    typingTimer: null,
    ended: false,
    rating: null,
    sending: false,
    pending: new Map(),
    visitor: stored.visitor || {},
    inputDraft: '',
  };

  let shadow;
  try {
    const res = await fetch(`${SERVER}/api/v1/widget-settings?propertyId=${encodeURIComponent(ACCOUNT_KEY)}&widgetId=${encodeURIComponent(WIDGET_ID)}`);
    const payload = await res.json();
    if (!payload.ok) throw new Error(payload.error || 'SETTINGS_FAILED');
    state.settings = payload.data.settings;
    state.pageStatus = payload.data.pageStatus;
  } catch (error) {
    console.warn('[Sparrow] unable to load widget settings', error);
    return;
  }

  buildHost();
  installApi();
  await startSession();
  connectSocket();
  render();
  notify('onLoad');
  while (queued.length) {
    const [method, args] = queued.shift();
    try { api[method]?.(...(args || [])); } catch {}
  }

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
  }

  function writeStore(patch) {
    try {
      const next = { ...readStore(), ...patch };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  }

  function notify(name, ...args) {
    const handler = callbacks[name] || window.Sparrow_API?.[name];
    if (typeof handler === 'function') {
      try { handler(...args); } catch (error) { console.warn('[Sparrow] callback error', error); }
    }
  }

  async function startSession() {
    try {
      const res = await fetch(`${SERVER}/api/v1/session/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          propertyId: ACCOUNT_KEY,
          sessionKey: stored.sessionKey || null,
          url: location.href,
          referrer: document.referrer || null,
          visitor: state.visitor,
        }),
      });
      const payload = await res.json();
      if (!payload.ok) throw new Error(payload.error);
      state.session = payload.data;
      state.messages = payload.data.messages || [];
      state.pageStatus = payload.data.pageStatus;
      writeStore({ sessionKey: payload.data.sessionKey, visitor: payload.data.visitor });
    } catch (error) {
      state.pageStatus = 'offline';
      console.warn('[Sparrow] session start failed', error);
    }
  }

  function wsBase() {
    const url = new URL(SERVER);
    return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
  }

  function connectSocket() {
    if (!state.session) return;
    try {
      state.ws = new WebSocket(`${wsBase()}${state.session.socketPath}`);
    } catch {
      scheduleReconnect();
      return;
    }
    state.ws.addEventListener('open', () => {
      state.connected = true;
      state.reconnectAttempts = 0;
      updateConnectionBanner();
      flushPending();
    });
    state.ws.addEventListener('message', (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      handleSocket(data);
    });
    state.ws.addEventListener('close', () => {
      state.connected = false;
      updateConnectionBanner();
      scheduleReconnect();
    });
    state.ws.addEventListener('error', () => {
      state.connected = false;
      updateConnectionBanner();
    });
  }

  function scheduleReconnect() {
    if (state.ws?.readyState === WebSocket.OPEN || state.ws?.readyState === WebSocket.CONNECTING) return;
    state.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** (state.reconnectAttempts - 1), 15000);
    setTimeout(connectSocket, delay);
  }

  function handleSocket(data) {
    switch (data.type) {
      case 'ready':
        state.connected = true;
        updateConnectionBanner();
        break;
      case 'message': {
        const incoming = data.message;
        if (data.clientId && state.pending.has(data.clientId)) {
          const temp = state.pending.get(data.clientId);
          const index = state.messages.findIndex((m) => m.id === temp);
          if (index !== -1) state.messages.splice(index, 1);
          state.pending.delete(data.clientId);
        }
        if (!state.messages.some((m) => m.id === incoming.id)) {
          state.messages.push(incoming);
          if (incoming.sender_type === 'agent') {
            state.typing = false;
            if (!state.open) {
              state.unread += 1;
              chime();
            }
            notify('onChatMessageAgent', incoming.body);
          } else if (incoming.sender_type === 'visitor') {
            notify('onChatMessageVisitor', incoming.body);
          }
        }
        if (state.view !== 'chat') state.view = 'chat';
        renderMessages();
        renderLauncher();
        break;
      }
      case 'typing':
        if (data.from === 'agent') {
          state.typing = Boolean(data.isTyping);
          renderTyping();
        }
        break;
      case 'presence':
        if (state.pageStatus !== data.pageStatus) {
          state.pageStatus = data.pageStatus;
          notify('onStatusChange', state.pageStatus);
        }
        updateHeaderStatus();
        break;
      case 'conversation:ended':
        state.ended = true;
        state.typing = false;
        renderMessages();
        renderStatusPill();
        notify('onChatEnded');
        break;
      case 'seen':
        break;
    }
  }

  function send(payload) {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function flushPending() {
    for (const item of state.pendingQueue || []) send(item);
    state.pendingQueue = [];
  }

  function submitMessage(text) {
    const body = String(text || '').trim();
    if (!body || state.ended) return;
    const clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tempId = `temp_${clientId}`;
    state.messages.push({
      id: tempId,
      sender_type: 'visitor',
      sender_name: state.visitor.name || 'You',
      body,
      type: 'text',
      created_at: new Date().toISOString(),
      pending: true,
    });
    state.pending.set(clientId, tempId);
    state.view = 'chat';
    renderMessages();
    const sent = send({ type: 'message', body, clientId });
    if (!sent) {
      state.pendingQueue = state.pendingQueue || [];
      state.pendingQueue.push({ type: 'message', body, clientId });
      scheduleReconnect();
    }
    const input = shadow?.querySelector('.sp-input');
    if (input) input.value = '';
  }

  function setView(view) {
    state.view = view;
    if (view === 'chat') {
      state.unread = 0;
      setTimeout(() => shadow?.querySelector('.sp-input')?.focus(), 50);
    }
    render();
  }

  function togglePanel(force) {
    const next = typeof force === 'boolean' ? force : !state.open;
    if (next === state.open) return;
    state.open = next;
    if (next) {
      state.unread = 0;
      if (state.settings.behavior.prechat && !state.visitor.email && !state.messages.length) {
        state.view = 'prechat';
      } else if (state.ended) {
        state.view = 'ended';
      } else {
        state.view = state.messages.length ? 'chat' : 'home';
      }
      notify('onChatMaximized');
    } else {
      notify('onChatMinimized');
    }
    render();
  }

  function buildHost() {
    const colors = state.settings.branding;
    const host = document.createElement('div');
    host.id = 'sparrow-widget-host';
    host.style.cssText = 'position:fixed;z-index:2147483000;inset:auto 0 0 auto;width:0;height:0;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${styles(colors)}</style>
      <div class="sp-root" data-position="${state.settings.widget.position}" data-theme="${state.settings.behavior.theme}">
        <button class="sp-launcher" type="button" aria-label="Open chat" aria-expanded="false">
          <span class="sp-launcher-icon">
            <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3C8.8 3 3 8.03 3 14.24c0 3.36 1.55 6.4 4.01 8.47-.16 1.96-.83 3.9-2.02 5.61-.3.44.1 1.02.6.9 2.66-.64 4.9-1.9 6.5-3.2 1.23.3 2.52.46 3.91.46 7.2 0 13-5.03 13-11.24S23.2 3 16 3Z" fill="currentColor"/></svg>
          </span>
          <span class="sp-badge" hidden>0</span>
        </button>
        <section class="sp-panel" hidden aria-label="Chat panel">
          <header class="sp-header">
            <div class="sp-avatar">${escapeHtml(colors.logoText || 'S')}</div>
            <div class="sp-heading">
              <strong>${escapeHtml(colors.name)}</strong>
              <span class="sp-status"><i></i><span class="sp-status-text">Online</span></span>
            </div>
            <div class="sp-header-actions">
              <button class="sp-transcript" type="button" title="Email transcript" aria-label="Transcript">✉</button>
              <button class="sp-minimize" type="button" title="Minimize" aria-label="Minimize">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 9h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
              </button>
            </div>
          </header>
          <div class="sp-connection" hidden>Reconnecting…</div>
          <div class="sp-body"></div>
          <div class="sp-footer"></div>
        </section>
      </div>`;
    document.documentElement.appendChild(host);

    shadow.querySelector('.sp-launcher').addEventListener('click', () => togglePanel());
    shadow.querySelector('.sp-minimize').addEventListener('click', () => togglePanel(false));
    shadow.querySelector('.sp-transcript').addEventListener('click', () => requestTranscript());
    shadow.addEventListener('click', (event) => {
      const action = event.target.closest?.('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'start') {
        if (state.settings.behavior.prechat && !state.visitor.email) setView('prechat');
        else { setView('chat'); notify('onChatStarted'); }
      }
      if (action === 'close') togglePanel(false);
      if (action === 'rate-up') submitRating(1);
      if (action === 'rate-down') submitRating(-1);
      if (action === 'faq') event.target.closest('.sp-faq')?.classList.toggle('open');
      if (action === 'new') {
        state.ended = false;
        state.rating = null;
        setView('chat');
      }
      if (action === 'minimize') togglePanel(false);
      if (event.target.closest?.('.sp-download')) requestTranscript();
    });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.settings.behavior.closeOnEsc !== false) togglePanel(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) togglePanel(false);
    });
  }

  function render() {
    const root = shadow?.querySelector('.sp-root');
    if (!root) return;
    root.classList.toggle('is-open', state.open);
    shadow.querySelector('.sp-panel').hidden = !state.open;
    const launcher = shadow.querySelector('.sp-launcher');
    launcher.setAttribute('aria-expanded', String(state.open));
    renderLauncher();
    renderBody();
    renderFooter();
    updateHeaderStatus();
  }

  function renderLauncher() {
    const button = shadow?.querySelector('.sp-launcher');
    const badge = shadow?.querySelector('.sp-badge');
    if (!button || !badge) return;
    const show = state.unread > 0 && !state.open;
    badge.hidden = !show;
    badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
    button.classList.toggle('is-open', state.open);
    const label = state.pageStatus === 'online' ? state.settings.widget.minimizedText : 'Leave us a message';
    button.title = label;
  }

  function renderBody() {
    const body = shadow.querySelector('.sp-body');
    if (!body) return;
    if (state.view === 'prechat') return renderPrechat(body);
    if (state.view === 'ended') return renderEnded(body);
    if (state.view === 'chat') return renderChat(body);
    return renderHome(body);
  }

  function renderHome(body) {
    const settings = state.settings;
    const offline = state.pageStatus === 'offline';
    body.innerHTML = `
      <div class="sp-home">
        <div class="sp-hero">
          <div class="sp-hero-avatar">${escapeHtml(settings.branding.logoText || 'S')}</div>
          <h2>${escapeHtml(settings.widget.greeting)}</h2>
          <p>${escapeHtml(offline ? settings.widget.offlineMessage : settings.widget.subtitle)}</p>
          <button class="sp-primary" type="button" data-action="start">
            ${offline ? 'Leave a message' : 'Start a conversation'}
          </button>
        </div>
        ${settings.features.knowledgeBase && settings.faq?.length ? `
          <div class="sp-faqs">
            <h3>Quick answers</h3>
            ${settings.faq.map((item) => `
              <div class="sp-faq" data-action="faq">
                <button type="button" data-action="faq">${escapeHtml(item.question)}<span>+</span></button>
                <p>${escapeHtml(item.answer)}</p>
              </div>`).join('')}
          </div>` : ''}
        <p class="sp-powered">Powered by <strong>Sparrow</strong></p>
      </div>`;
  }

  function renderPrechat(body) {
    const offline = state.pageStatus === 'offline';
    body.innerHTML = `
      <form class="sp-form" novalidate>
        <h2>${offline ? 'Leave a message' : 'Before we start'}</h2>
        <p>${offline ? "We'll reply by email as soon as we're back." : 'Tell us who you are so we can help faster.'}</p>
        <label>Name<input name="name" autocomplete="name" value="${escapeHtml(state.visitor.name || '')}" placeholder="Your name"></label>
        <label>Email<input name="email" type="email" autocomplete="email" value="${escapeHtml(state.visitor.email || '')}" placeholder="you@example.com" ${state.settings.behavior.requireEmail ? 'required' : ''}></label>
        ${offline ? '<label>Message<textarea name="message" rows="4" placeholder="How can we help?"></textarea></label>' : ''}
        <button class="sp-primary" type="submit">${offline ? 'Send message' : 'Continue'}</button>
        <div class="sp-error" hidden></div>
      </form>`;
    const form = body.querySelector('form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const name = String(data.get('name') || '').trim();
      const email = String(data.get('email') || '').trim();
      if (state.settings.behavior.requireEmail && !email) return showFormError(form, 'Please enter your email.');
      state.visitor = { ...state.visitor, name: name || state.visitor.name, email: email || state.visitor.email };
      writeStore({ visitor: state.visitor });
      if (state.session) {
        send({ type: 'attributes', name: state.visitor.name, email: state.visitor.email });
      }
      if (offline) {
        await submitOffline(form, data);
        return;
      }
      setView('chat');
      notify('onChatStarted');
    });
  }

  async function submitOffline(form, data) {
    const message = String(data.get('message') || '').trim();
    if (!message) return showFormError(form, 'Please add a short message.');
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const res = await fetch(`${SERVER}/api/v1/offline-form`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          propertyId: ACCOUNT_KEY,
          sessionKey: state.session?.sessionKey,
          name: state.visitor.name, email: state.visitor.email, message,
        }),
      });
      const payload = await res.json();
      if (!payload.ok) throw new Error(payload.error);
      form.innerHTML = `<div class="sp-success"><div class="sp-check">✓</div><h2>Message sent</h2><p>Thanks ${escapeHtml(state.visitor.name || '')}. We'll reply to ${escapeHtml(state.visitor.email || 'you')} shortly.</p></div>`;
    } catch (error) {
      button.disabled = false;
      showFormError(form, 'Could not send that. Please try again.');
    }
  }

  function showFormError(form, text) {
    const el = form.querySelector('.sp-error');
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
  }

  function renderChat(body) {
    const hadFocus = shadow.activeElement?.classList.contains('sp-input');
    body.innerHTML = `
      <div class="sp-chat" role="log" aria-live="polite">
        <div class="sp-messages"></div>
        <div class="sp-typing" hidden><span></span><span></span><span></span></div>
      </div>`;
    renderMessages();
    renderTyping();
    if (hadFocus) setTimeout(() => shadow.querySelector('.sp-input')?.focus(), 0);
  }

  function renderMessages() {
    const container = shadow?.querySelector('.sp-messages');
    if (!container) return;
    if (!state.messages.length) {
      container.innerHTML = `<div class="sp-empty"><p>${escapeHtml(state.settings.widget.greeting)}</p><span>Send a message to get started.</span></div>`;
      return;
    }
    let lastDate = '';
    const parts = [];
    for (const message of state.messages) {
      if (message.type === 'system') {
        parts.push(`<div class="sp-system">${escapeHtml(message.body)}</div>`);
        continue;
      }
      const date = new Date(message.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      if (date !== lastDate) {
        lastDate = date;
        parts.push(`<div class="sp-day">${escapeHtml(date)}</div>`);
      }
      const mine = message.sender_type === 'visitor';
      parts.push(`
        <div class="sp-msg ${mine ? 'mine' : 'theirs'} ${message.pending ? 'pending' : ''}">
          ${!mine ? `<span class="sp-sender">${escapeHtml(message.sender_name || state.settings.branding.name)}</span>` : ''}
          <div class="sp-bubble">${linkify(escapeHtml(message.body))}</div>
          <time>${formatTime(message.created_at)}</time>
        </div>`);
    }
    container.innerHTML = parts.join('');
    container.scrollTop = container.scrollHeight;
    const scroller = shadow.querySelector('.sp-chat');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    renderStatusPill();
  }

  function renderStatusPill() {
    const existing = shadow?.querySelector('.sp-ended');
    existing?.remove();
    if (!state.ended) return;
    const chat = shadow.querySelector('.sp-chat');
    if (!chat) return;
    const el = document.createElement('div');
    el.className = 'sp-ended';
    el.innerHTML = `<p>This conversation has ended.</p><button type="button" data-action="new">Start a new chat</button>`;
    chat.appendChild(el);
  }

  function renderTyping() {
    const el = shadow?.querySelector('.sp-typing');
    if (el) el.hidden = !state.typing;
  }

  function renderFooter() {
    const footer = shadow.querySelector('.sp-footer');
    if (!footer) return;
    if (state.view !== 'chat') { footer.innerHTML = ''; return; }
    footer.innerHTML = `
      <form class="sp-composer">
        <textarea class="sp-input" rows="1" placeholder="Write a message…" aria-label="Message">${escapeHtml(state.inputDraft || '')}</textarea>
        <button type="submit" aria-label="Send" ${state.ended ? 'disabled' : ''}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.3 2.6a.8.8 0 0 1 .9-.9l14.2 7.5a.8.8 0 0 1 0 1.4L3.2 18.1a.8.8 0 0 1-1.1-1l2.2-5.6a1 1 0 0 1 .6-.6l6.2-1.4a.4.4 0 0 0 0-.8L5 7.3a1 1 0 0 1-.6-.6L2.3 2.6Z" fill="currentColor"/></svg>
        </button>
      </form>
      <p class="sp-powered">Powered by <strong>Sparrow</strong></p>`;
    const form = footer.querySelector('form');
    const input = footer.querySelector('.sp-input');
    input.addEventListener('input', () => {
      state.inputDraft = input.value;
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
      send({ type: 'typing', isTyping: Boolean(input.value.trim()) });
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      state.inputDraft = '';
      submitMessage(input.value);
      input.style.height = 'auto';
    });
  }

  function renderEnded(body) {
    body.innerHTML = `
      <div class="sp-home sp-ended-view">
        <div class="sp-hero">
          <div class="sp-check">✓</div>
          <h2>Thanks for chatting</h2>
          <p>How did we do?</p>
          ${state.settings.features.rating ? `
            <div class="sp-rating">
              <button type="button" data-action="rate-up" aria-label="Good" class="${state.rating === 1 ? 'active' : ''}">👍</button>
              <button type="button" data-action="rate-down" aria-label="Bad" class="${state.rating === -1 ? 'active' : ''}">👎</button>
            </div>` : ''}
          <button class="sp-primary" type="button" data-action="new">Start a new chat</button>
          <button class="sp-link sp-download" type="button">Download transcript</button>
        </div>
      </div>`;
  }

  function submitRating(value) {
    if (state.rating === value) return;
    state.rating = value;
    send({ type: 'rating', value });
    render();
  }

  function requestTranscript() {
    if (!state.session) return;
    const url = `${SERVER}/api/v1/transcript/${state.session.conversation.id}?propertyId=${encodeURIComponent(ACCOUNT_KEY)}&sessionKey=${encodeURIComponent(state.session.sessionKey)}&token=${encodeURIComponent(state.session.token)}`;
    window.open(url, '_blank', 'noopener');
  }

  function updateConnectionBanner() {
    const el = shadow?.querySelector('.sp-connection');
    if (el) el.hidden = state.connected;
  }

  function updateHeaderStatus() {
    const label = shadow?.querySelector('.sp-status-text');
    const dot = shadow?.querySelector('.sp-status i');
    if (!label) return;
    const online = state.pageStatus === 'online';
    label.textContent = online ? 'Online' : 'Offline';
    if (dot) dot.style.background = online ? '#22c55e' : '#94a3b8';
    if (state.settings?.widget.subtitle) {
      label.title = online ? state.settings.widget.subtitle : state.settings.widget.offlineMessage;
    }
  }

  function chime() {
    if (!state.settings?.features.sound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.start(); osc.stop(ctx.currentTime + 0.26);
    } catch {}
  }

  function installApi() {
    const api = window.Sparrow_API || {};
    Object.assign(api, {
      maximize: () => togglePanel(true),
      minimize: () => togglePanel(false),
      toggle: () => togglePanel(),
      showWidget: () => { shadow.querySelector('.sp-root').style.display = ''; },
      hideWidget: () => { shadow.querySelector('.sp-root').style.display = 'none'; },
      toggleVisibility: () => {
        const root = shadow.querySelector('.sp-root');
        root.style.display = root.style.display === 'none' ? '' : 'none';
      },
      getStatus: () => state.pageStatus,
      isChatMaximized: () => state.open,
      isChatHidden: () => shadow.querySelector('.sp-root').style.display === 'none',
      isChatOngoing: () => Boolean(state.messages.length) && !state.ended,
      isVisitorEngaged: () => state.messages.some((m) => m.sender_type === 'visitor') && !state.ended,
      endChat: () => {
        send({ type: 'end' });
        state.ended = true;
        render();
      },
      setAttributes: (attributes, callback) => {
        const { name, email, ...rest } = attributes || {};
        state.visitor = { ...state.visitor, ...(name ? { name } : {}), ...(email ? { email } : {}) };
        writeStore({ visitor: state.visitor });
        const sent = send({ type: 'attributes', name, email, attributes: rest });
        callback?.(sent ? null : 'DISCONNECTED');
      },
      addEvent: (name, metadata, callback) => {
        const ok = send({ type: 'event', name, metadata });
        callback?.(ok ? null : 'DISCONNECTED');
      },
      setChatInputMessage: (text, callback) => {
        state.inputDraft = String(text || '');
        const input = shadow.querySelector('.sp-input');
        if (input) input.value = state.inputDraft;
        callback?.();
      },
      popup: () => togglePanel(true),
      getWindowType: () => 'embed',
    });
    window.Sparrow_API = api;
  }
}

function styles(colors) {
  return `
  :host { all: initial; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  .sp-root {
    --brand: ${colors.color};
    --accent: ${colors.accent};
    --on-brand: ${colors.textOnColor || '#fff'};
    --bg: #ffffff;
    --panel-bg: #ffffff;
    --text: #0f172a;
    --muted: #64748b;
    --line: #e2e8f0;
    --radius: 18px;
    position: fixed;
    bottom: ${Number(state_offset_y(colors)) || 0}px;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    z-index: 2147483000;
  }
  .sp-launcher {
    position: fixed; bottom: 24px; right: 24px;
    width: 60px; height: 60px; border-radius: 22px; border: 0;
    background: linear-gradient(145deg, var(--brand), var(--accent));
    color: #fff; cursor: pointer; display: grid; place-items: center;
    box-shadow: 0 12px 30px -8px color-mix(in srgb, var(--brand) 55%, transparent), 0 4px 12px rgba(15,23,42,.18);
    transition: transform .18s ease, box-shadow .18s ease;
  }
  .sp-launcher:hover { transform: translateY(-2px) scale(1.03); }
  .sp-launcher:focus-visible { outline: 3px solid color-mix(in srgb, var(--brand) 40%, white); outline-offset: 3px; }
  .sp-launcher.is-open .sp-launcher-icon svg { transform: rotate(90deg); }
  .sp-launcher-icon svg { width: 30px; height: 30px; transition: transform .2s ease; }
  .sp-badge {
    position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px;
    border-radius: 999px; background: #ef4444; color: #fff; font-size: 11px; font-weight: 700;
    display: grid; place-items: center; border: 2px solid #fff;
  }
  [data-position="bl"] .sp-launcher { left: 24px; right: auto; }
  .sp-panel {
    position: fixed; bottom: 100px; right: 24px;
    width: 380px; height: min(640px, calc(100vh - 140px));
    background: var(--panel-bg); border-radius: var(--radius);
    box-shadow: 0 24px 60px -12px rgba(15,23,42,.28), 0 8px 24px rgba(15,23,42,.12);
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid rgba(15,23,42,.06);
    animation: sp-in .2s ease;
  }
  [data-position="bl"] .sp-panel { left: 24px; right: auto; }
  @keyframes sp-in { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
  .sp-header {
    display: flex; align-items: center; gap: 12px; padding: 16px 16px 14px;
    background: linear-gradient(135deg, var(--brand), var(--accent)); color: var(--on-brand);
  }
  .sp-avatar {
    width: 40px; height: 40px; border-radius: 14px; background: rgba(255,255,255,.18);
    display: grid; place-items: center; font-weight: 700; font-size: 18px;
    border: 1px solid rgba(255,255,255,.28);
  }
  .sp-heading { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .sp-heading strong { font-size: 15px; letter-spacing: -.01em; }
  .sp-status { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: .92; }
  .sp-status i { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 3px rgba(255,255,255,.15); }
  .sp-header-actions { margin-left: auto; display: flex; gap: 4px; }
  .sp-header-actions button {
    width: 30px; height: 30px; border-radius: 9px; border: 0; background: rgba(255,255,255,.12);
    color: inherit; cursor: pointer; display: grid; place-items: center; font-size: 14px;
  }
  .sp-header-actions button:hover { background: rgba(255,255,255,.22); }
  .sp-header-actions svg { width: 16px; height: 16px; }
  .sp-connection { padding: 6px 14px; background: #fef3c7; color: #92400e; font-size: 12px; text-align: center; }
  .sp-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
  .sp-footer { border-top: 1px solid var(--line); background: #fff; }
  .sp-footer:empty { display: none; }
  .sp-home { padding: 24px 20px; overflow-y: auto; }
  .sp-hero { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .sp-hero-avatar {
    width: 64px; height: 64px; border-radius: 22px; display: grid; place-items: center;
    background: linear-gradient(145deg, var(--brand), var(--accent)); color: #fff;
    font-size: 26px; font-weight: 700; margin-bottom: 4px;
    box-shadow: 0 10px 24px -10px color-mix(in srgb, var(--brand) 60%, transparent);
  }
  .sp-hero h2 { margin: 0; font-size: 20px; letter-spacing: -.02em; }
  .sp-hero p { margin: 0; color: var(--muted); font-size: 13.5px; line-height: 1.55; max-width: 260px; }
  .sp-primary {
    margin-top: 10px; width: 100%; max-width: 260px; border: 0; border-radius: 12px;
    background: var(--brand); color: var(--on-brand); padding: 12px 16px; font-size: 14px; font-weight: 600;
    cursor: pointer; transition: filter .15s ease;
  }
  .sp-primary:hover { filter: brightness(1.06); }
  .sp-faqs { margin-top: 26px; }
  .sp-faqs h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 8px; }
  .sp-faq { border: 1px solid var(--line); border-radius: 12px; margin-bottom: 8px; overflow: hidden; }
  .sp-faq button {
    width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 10px;
    background: none; border: 0; padding: 12px 14px; text-align: left; font-size: 13px; color: var(--text); cursor: pointer;
  }
  .sp-faq button span { color: var(--muted); font-size: 16px; transition: transform .2s; }
  .sp-faq.open button span { transform: rotate(45deg); }
  .sp-faq p { display: none; margin: 0; padding: 0 14px 12px; font-size: 12.5px; color: var(--muted); line-height: 1.55; }
  .sp-faq.open p { display: block; }
  .sp-powered { text-align: center; font-size: 11px; color: #94a3b8; margin: 18px 0 0; }
  .sp-powered strong { color: #64748b; }
  .sp-chat { flex: 1; overflow-y: auto; padding: 18px 16px 8px; display: flex; flex-direction: column; gap: 10px; background: #f8fafc; }
  .sp-messages { display: flex; flex-direction: column; gap: 10px; }
  .sp-day { align-self: center; font-size: 11px; color: #94a3b8; background: #eef2f7; padding: 3px 10px; border-radius: 999px; }
  .sp-msg { display: flex; flex-direction: column; max-width: 82%; }
  .sp-msg.theirs { align-self: flex-start; }
  .sp-msg.mine { align-self: flex-end; align-items: flex-end; }
  .sp-sender { font-size: 11px; color: var(--muted); margin: 0 0 4px 4px; }
  .sp-bubble {
    padding: 10px 13px; border-radius: 14px; font-size: 13.5px; line-height: 1.5;
    background: #fff; border: 1px solid rgba(15,23,42,.05); box-shadow: 0 1px 2px rgba(15,23,42,.04);
    white-space: pre-wrap; word-break: break-word;
  }
  .sp-msg.mine .sp-bubble { background: var(--brand); color: var(--on-brand); border-color: transparent; }
  .sp-msg.pending .sp-bubble { opacity: .65; }
  .sp-msg time { font-size: 10px; color: #94a3b8; margin-top: 4px; }
  .sp-msg.mine time { text-align: right; }
  .sp-system { align-self: center; font-size: 11.5px; color: var(--muted); background: #eef2f7; padding: 5px 12px; border-radius: 999px; }
  .sp-typing { display: flex; gap: 4px; padding: 8px 12px; background: #fff; border: 1px solid rgba(15,23,42,.05); border-radius: 14px; width: fit-content; }
  .sp-typing span { width: 6px; height: 6px; border-radius: 50%; background: #94a3b8; animation: sp-bounce 1.2s infinite; }
  .sp-typing span:nth-child(2) { animation-delay: .15s; }
  .sp-typing span:nth-child(3) { animation-delay: .3s; }
  @keyframes sp-bounce { 0%,60%,100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }
  .sp-empty { margin: auto; text-align: center; color: var(--muted); padding: 30px 20px; }
  .sp-empty p { font-size: 17px; color: var(--text); margin: 0 0 6px; font-weight: 600; }
  .sp-composer { display: flex; align-items: flex-end; gap: 8px; padding: 12px 14px 4px; }
  .sp-input {
    flex: 1; resize: none; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px;
    font: inherit; font-size: 13.5px; line-height: 1.45; max-height: 120px; outline: none; background: #f8fafc;
  }
  .sp-input:focus { border-color: color-mix(in srgb, var(--brand) 55%, white); background: #fff; box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 12%, transparent); }
  .sp-composer button {
    width: 38px; height: 38px; border-radius: 11px; border: 0; background: var(--brand); color: #fff;
    display: grid; place-items: center; cursor: pointer; flex: none;
  }
  .sp-composer button svg { width: 18px; height: 18px; }
  .sp-composer button:disabled { opacity: .5; cursor: default; }
  .sp-form { padding: 24px 22px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; }
  .sp-form h2 { margin: 0; font-size: 19px; letter-spacing: -.02em; }
  .sp-form p { margin: -6px 0 4px; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .sp-form label { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; font-weight: 600; color: #334155; }
  .sp-form input, .sp-form textarea {
    border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font: inherit; font-size: 13.5px;
    font-weight: 400; color: var(--text); outline: none; background: #fff;
  }
  .sp-form input:focus, .sp-form textarea:focus { border-color: color-mix(in srgb, var(--brand) 55%, white); box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 12%, transparent); }
  .sp-error { color: #b91c1c; font-size: 12.5px; }
  .sp-success { text-align: center; padding: 40px 10px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .sp-success h2 { margin: 0; font-size: 19px; }
  .sp-success p { margin: 0; color: var(--muted); font-size: 13.5px; line-height: 1.55; }
  .sp-check {
    width: 54px; height: 54px; border-radius: 50%; background: color-mix(in srgb, var(--brand) 12%, white);
    color: var(--brand); display: grid; place-items: center; font-size: 26px; font-weight: 700; margin-bottom: 6px;
  }
  .sp-ended { margin: 18px 0 4px; text-align: center; }
  .sp-ended p { font-size: 12px; color: var(--muted); margin: 0 0 8px; }
  .sp-ended button { border: 1px solid var(--line); background: #fff; border-radius: 10px; padding: 8px 14px; font: inherit; font-size: 12.5px; cursor: pointer; }
  .sp-ended-view .sp-hero { padding-top: 10px; }
  .sp-rating { display: flex; gap: 10px; margin: 6px 0; }
  .sp-rating button {
    width: 48px; height: 48px; border-radius: 14px; border: 1px solid var(--line); background: #fff;
    font-size: 22px; cursor: pointer; transition: all .15s ease;
  }
  .sp-rating button.active { border-color: var(--brand); background: color-mix(in srgb, var(--brand) 10%, white); transform: translateY(-1px); }
  .sp-link { background: none; border: 0; color: var(--muted); font-size: 12px; text-decoration: underline; cursor: pointer; margin-top: 6px; }
  .sp-powered:last-child { margin: 4px 0 10px; }
  @media (max-width: 480px) {
    .sp-panel { width: calc(100vw - 16px); height: calc(100dvh - 104px); right: 8px; bottom: 88px; border-radius: 16px; }
    [data-position="bl"] .sp-panel { left: 8px; right: auto; }
    .sp-launcher { right: 16px; bottom: 16px; }
    [data-position="bl"] .sp-launcher { left: 16px; right: auto; }
  }
  .sp-root[data-theme="dark"] { --bg: #0f172a; --panel-bg: #0f172a; --text: #e2e8f0; --muted: #94a3b8; --line: #1e293b; }
  .sp-root[data-theme="dark"] .sp-chat { background: #0b1220; }
  .sp-root[data-theme="dark"] .sp-bubble { background: #1e293b; color: #e2e8f0; border-color: #1e293b; }
  .sp-root[data-theme="dark"] .sp-footer { background: #0f172a; }
  .sp-root[data-theme="dark"] .sp-input { background: #1e293b; color: #e2e8f0; border-color: #334155; }
  .sp-root[data-theme="dark"] .sp-input:focus { background: #1e293b; }
  .sp-root[data-theme="dark"] .sp-faq { border-color: #1e293b; }
  .sp-root[data-theme="dark"] .sp-day,
  .sp-root[data-theme="dark"] .sp-system { background: #1e293b; color: #94a3b8; }
  .sp-root[data-theme="dark"] .sp-msg .sp-bubble { box-shadow: none; }
  .sp-root[data-theme="dark"] .sp-ended button { background: #1e293b; color: #e2e8f0; border-color: #334155; }
  .sp-root[data-theme="dark"] .sp-form input,
  .sp-root[data-theme="dark"] .sp-form textarea { background: #1e293b; color: #e2e8f0; border-color: #334155; }
  .sp-root[data-theme="dark"] .sp-rating button { background: #1e293b; border-color: #334155; }
  .sp-root[data-theme="dark"] .sp-primary { color: #fff; }`;
}

function state_offset_y(colors) {
  return colors?.offsetY ?? 0;
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
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">$1</a>');
}

function formatTime(value) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}
