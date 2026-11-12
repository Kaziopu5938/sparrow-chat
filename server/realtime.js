import { WebSocketServer } from 'ws';
import { verifyVisitorToken } from './auth.js';
import {
  addMessage, addEvent, createConversation, endConversation, findOpenConversation,
  getConversation, getDefaultAgent, getProperty, getVisitorBySession, isPropertyOnline, listMessages,
  markSeen, now, setRating, touchVisitor, updateTags,
} from './store.js';
import { chatEndPayload, chatStartPayload, transcriptPayload } from './webhooks.js';

const MAX_MESSAGE_LENGTH = 4000;

export function createRealtime({ db, secret, webhooks, adminHost = '', logger = console }) {
  const visitorSockets = new Map();
  const agentSockets = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  let shuttingDown = false;

  const send = (ws, type, data = {}) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...data }));
  };

  const visitorPeers = (conversationId) => visitorSockets.get(conversationId) || new Set();
  const agentPeers = (propertyId) => agentSockets.get(propertyId) || new Set();

  function broadcastToVisitors(conversationId, type, data) {
    for (const ws of visitorPeers(conversationId)) send(ws, type, data);
  }

  function broadcastToAgents(propertyId, type, data) {
    for (const ws of agentPeers(propertyId)) send(ws, type, data);
  }

  function presenceSnapshot(propertyId) {
    const online = isPropertyOnline(db, propertyId);
    return { type: 'presence', pageStatus: online ? 'online' : 'offline', agentsOnline: online };
  }

  function broadcastPresence(propertyId) {
    if (shuttingDown) return;
    const payload = presenceSnapshot(propertyId);
    broadcastToAgents(propertyId, 'presence', payload);
    for (const set of visitorSockets.values()) {
      for (const ws of set) {
        if (ws.propertyId === propertyId) send(ws, 'presence', payload);
      }
    }
  }

  function markAgentActivity(propertyId) {
    broadcastToAgents(propertyId, 'conversation:update', {});
  }

  function registerConversation(ws, conversationId) {
    if (ws.conversationId && ws.conversationId !== conversationId) {
      visitorSockets.get(ws.conversationId)?.delete(ws);
    }
    ws.conversationId = conversationId;
    if (!visitorSockets.has(conversationId)) visitorSockets.set(conversationId, new Set());
    visitorSockets.get(conversationId).add(ws);
  }

  function emitStart({ conversation, visitor, message, property }) {
    webhooks.emit(property.id, 'chat:start', chatStartPayload({ conversation, visitor, message, property }));
  }

  function emitEnd({ conversation, visitor, property }) {
    const messages = listMessages(db, conversation.id);
    webhooks.emit(property.id, 'chat:end', chatEndPayload({ conversation, visitor, property }));
    webhooks.emit(property.id, 'chat:transcript_created', transcriptPayload({ conversation, visitor, property, messages }));
  }

  function finishConversation(property, conversationId, actorName) {
    const conversation = endConversation(db, conversationId, actorName);
    if (!conversation) return null;
    const details = getConversation(db, property.id, conversationId);
    const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(conversation.visitor_id);
    emitEnd({ conversation, visitor, property });
    broadcastToVisitors(conversationId, 'conversation:ended', { conversation: details });
    broadcastToAgents(property.id, 'conversation:ended', { conversationId, conversation: details });
    return details;
  }

  function visitorHandler(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { conversationId, visitorId, propertyId } = ws;
    const property = getProperty(db, propertyId);
    if (!property) return;

    switch (msg.type) {
      case 'message': {
        const body = String(msg.body || '').trim().slice(0, MAX_MESSAGE_LENGTH);
        if (!body) return;
        const conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND status = ?').get(conversationId, 'open');
        if (!conversation) {
          send(ws, 'error', { error: 'CONVERSATION_CLOSED' });
          return;
        }
        const before = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(conversationId).c;
        const record = addMessage(db, {
          conversationId, senderType: 'visitor', senderId: visitorId,
          senderName: ws.visitorName, body, type: 'text',
          meta: { clientId: msg.clientId || null, url: ws.pageUrl || null },
        });
        touchVisitor(db, visitorId, {});
        send(ws, 'message', { message: record, clientId: msg.clientId || null });
        broadcastToVisitors(conversationId, 'message', { message: record });
        broadcastToAgents(propertyId, 'message', { conversationId, message: record });
        markAgentActivity(propertyId);
        if (before === 0) emitStart({ conversation, visitor: ws.visitor, message: record, property });
        break;
      }
      case 'typing':
        broadcastToAgents(propertyId, 'typing', { conversationId, from: 'visitor', isTyping: Boolean(msg.isTyping) });
        break;
      case 'seen': {
        markSeen(db, conversationId, 'visitor');
        broadcastToAgents(propertyId, 'seen', { conversationId, side: 'visitor', at: now() });
        markAgentActivity(propertyId);
        break;
      }
      case 'rating': {
        const value = msg.value === 1 ? 1 : msg.value === -1 ? -1 : 0;
        setRating(db, conversationId, value);
        addEvent(db, conversationId, 'rating', { value });
        broadcastToAgents(propertyId, 'rating', { conversationId, value });
        markAgentActivity(propertyId);
        break;
      }
      case 'attributes': {
        const visitor = touchVisitor(db, visitorId, {
          name: msg.name, email: msg.email, attributes: msg.attributes || {},
        });
        if (visitor) {
          ws.visitor = visitor;
          ws.visitorName = visitor.name;
          broadcastToAgents(propertyId, 'visitor:update', {
            conversationId,
            visitor: { ...visitor, attributes: JSON.parse(visitor.attributes || '{}') },
          });
        }
        break;
      }
      case 'event': {
        const name = String(msg.name || '').slice(0, 60);
        if (!name) return;
        addEvent(db, conversationId, name, msg.metadata || {});
        broadcastToAgents(propertyId, 'visitor:event', { conversationId, name, metadata: msg.metadata || {} });
        break;
      }
      case 'ping':
        send(ws, 'pong', { at: now() });
        break;
      case 'end': {
        finishConversation(property, conversationId, 'Visitor');
        break;
      }
      default:
        send(ws, 'error', { error: 'UNKNOWN_EVENT' });
    }
  }

  function agentHandler(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { agent, propertyId } = ws;
    const property = getProperty(db, propertyId);
    if (!property) return;

    const conversation = msg.conversationId
      ? db.prepare('SELECT * FROM conversations WHERE id = ? AND property_id = ?').get(msg.conversationId, propertyId)
      : null;

    switch (msg.type) {
      case 'message': {
        if (!conversation || conversation.status !== 'open') {
          send(ws, 'error', { error: 'CONVERSATION_NOT_OPEN' });
          return;
        }
        const body = String(msg.body || '').trim().slice(0, MAX_MESSAGE_LENGTH);
        if (!body) return;
        if (!conversation.assigned_agent_id) {
          db.prepare('UPDATE conversations SET assigned_agent_id = ? WHERE id = ?').run(agent.id, conversation.id);
        }
        const record = addMessage(db, {
          conversationId: conversation.id, senderType: 'agent', senderId: agent.id,
          senderName: agent.name, body, type: 'text', meta: { clientId: msg.clientId || null },
        });
        broadcastToVisitors(conversation.id, 'message', { message: record });
        broadcastToAgents(propertyId, 'message', { conversationId: conversation.id, message: record });
        markAgentActivity(propertyId);
        break;
      }
      case 'typing':
        if (!conversation) return;
        broadcastToVisitors(conversation.id, 'typing', { from: 'agent', name: agent.name, isTyping: Boolean(msg.isTyping) });
        break;
      case 'seen':
        if (!conversation) return;
        markSeen(db, conversation.id, 'agent');
        broadcastToVisitors(conversation.id, 'seen', { at: now() });
        broadcastToAgents(propertyId, 'seen', { conversationId: conversation.id, side: 'agent', at: now() });
        markAgentActivity(propertyId);
        break;
      case 'tags':
        if (!conversation) return;
        updateTags(db, conversation.id, { add: msg.add || [], remove: msg.remove || [] });
        broadcastToAgents(propertyId, 'tags', { conversationId: conversation.id });
        markAgentActivity(propertyId);
        break;
      case 'end':
        if (!conversation) return;
        finishConversation(property, conversation.id, agent.name);
        break;
      case 'status': {
        const status = ['online', 'away', 'offline'].includes(msg.status) ? msg.status : agent.status;
        db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, agent.id);
        broadcastToAgents(propertyId, 'agent:status', { agentId: agent.id, status });
        broadcastPresence(propertyId);
        break;
      }
      case 'ping':
        send(ws, 'pong', { at: now() });
        break;
      default:
        send(ws, 'error', { error: 'UNKNOWN_EVENT' });
    }
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/ws/visitor') {
      const propertyId = url.searchParams.get('propertyId');
      const sessionKey = url.searchParams.get('sessionKey');
      const token = url.searchParams.get('token');
      if (!verifyVisitorToken(secret, propertyId, sessionKey, token)) {
        ws.close(4001, 'Unauthorized');
        return;
      }
      const visitor = getVisitorBySession(db, propertyId, sessionKey);
      if (!visitor || !getProperty(db, propertyId)) {
        ws.close(4001, 'Unauthorized');
        return;
      }
      let conversation = findOpenConversation(db, propertyId, visitor.id);
      if (!conversation) conversation = createConversation(db, { propertyId, visitorId: visitor.id });

      Object.assign(ws, {
        role: 'visitor', propertyId, visitorId: visitor.id, visitor,
        visitorName: visitor.name, pageUrl: visitor.page_url,
      });
      registerConversation(ws, conversation.id);
      send(ws, 'ready', {
        conversationId: conversation.id,
        visitorId: visitor.id,
        pageStatus: isPropertyOnline(db, propertyId) ? 'online' : 'offline',
      });
      broadcastToAgents(propertyId, 'visitor:online', { conversationId: conversation.id });
      ws.on('message', (raw) => visitorHandler(ws, raw));
    } else if (url.pathname === '/ws/agent') {
      const host = String(req.headers.host || '').split(':')[0].toLowerCase();
      if (adminHost && host !== adminHost) {
        ws.close(4003, 'Admin host required');
        return;
      }
      const origin = req.headers.origin;
      if (origin) {
        try {
          if (new URL(origin).host !== req.headers.host) {
            ws.close(4003, 'Origin not allowed');
            return;
          }
        } catch {
          ws.close(4003, 'Origin not allowed');
          return;
        }
      }
      const agent = getDefaultAgent(db);
      if (!agent) {
        ws.close(4001, 'No agent configured');
        return;
      }
      Object.assign(ws, { role: 'agent', propertyId: agent.property_id, agent });
      if (!agentSockets.has(agent.property_id)) agentSockets.set(agent.property_id, new Set());
      agentSockets.get(agent.property_id).add(ws);
      send(ws, 'ready', {
        agent,
        pageStatus: isPropertyOnline(db, agent.property_id) ? 'online' : 'offline',
      });
      broadcastPresence(agent.property_id);
      ws.on('message', (raw) => agentHandler(ws, raw));
    } else {
      ws.close(4004, 'Not found');
      return;
    }

    ws.on('close', () => {
      if (ws.role === 'visitor') {
        const set = visitorSockets.get(ws.conversationId);
        set?.delete(ws);
        if (set && set.size === 0) visitorSockets.delete(ws.conversationId);
      } else if (ws.role === 'agent') {
        agentSockets.get(ws.propertyId)?.delete(ws);
        if (!shuttingDown) broadcastPresence(ws.propertyId);
      }
    });
    ws.on('error', (error) => logger.warn('[realtime] socket error', error.message));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  function handleUpgrade(req, socket, head) {
    if (!req.url?.startsWith('/ws/')) return false;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return true;
  }

  function close() {
    shuttingDown = true;
    clearInterval(heartbeat);
    for (const ws of wss.clients) {
      ws.removeAllListeners();
      ws.terminate();
    }
    wss.close();
  }

  return { handleUpgrade, broadcastPresence, broadcastToAgents, broadcastToVisitors, close, presenceSnapshot };
}
