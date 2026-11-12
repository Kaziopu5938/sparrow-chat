import express from 'express';
import { randomUUID } from 'node:crypto';
import { verifyVisitorToken, visitorToken } from './auth.js';
import {
  addEvent, addMessage, createConversation, createTicket, createVisitor, endConversation,
  findOpenConversation, getConversation, getDefaultAgent, getProperty, getSettings, getVisitorBySession,
  isPropertyOnline, listConversations, listMessages, listTickets, markSeen, now,
  parseJson, setRating, statsFor, touchVisitor, updateSettings, updateTags,
} from './store.js';
import { chatEndPayload, ticketPayload, transcriptPayload } from './webhooks.js';

const MAX_MESSAGE_LENGTH = 4000;

const ok = (res, data = {}) => res.json({ ok: true, data });
const fail = (res, status, error) => res.status(status).json({ ok: false, error });

export function createApi({ db, secret, webhooks, realtime }) {
  const router = express.Router();

  // Single-workspace mode: the dashboard always acts as the workspace's default agent.
  const agentOnly = (req, res, next) => {
    const agent = getDefaultAgent(db);
    if (!agent) return fail(res, 503, 'NO_AGENT_CONFIGURED');
    req.agent = agent;
    next();
  };

  router.get('/health', (req, res) => ok(res, { status: 'up', time: now() }));

  // ---------------------------------------------------------------- public widget API
  router.get('/v1/widget-settings', (req, res) => {
    const propertyId = String(req.query.propertyId || '');
    const property = getProperty(db, propertyId);
    if (!property) return fail(res, 404, 'PROPERTY_NOT_FOUND');
    const settings = getSettings(db, propertyId);
    if (req.query.widgetId && req.query.widgetId !== settings.widgetId) {
      return fail(res, 404, 'WIDGET_NOT_FOUND');
    }
    ok(res, {
      settingsVersion: `1-${property.name.length}-1`,
      propertyName: property.name,
      propertyId,
      pageStatus: isPropertyOnline(db, propertyId) ? 'online' : 'offline',
      settings,
    });
  });

  router.post('/v1/session/start', (req, res) => {
    const body = req.body || {};
    const propertyId = String(body.propertyId || '');
    const property = getProperty(db, propertyId);
    if (!property) return fail(res, 404, 'PROPERTY_NOT_FOUND');

    let visitor = null;
    if (body.sessionKey) {
      visitor = getVisitorBySession(db, propertyId, String(body.sessionKey));
    }
    if (!visitor) {
      visitor = createVisitor(db, {
        propertyId,
        sessionKey: randomUUID(),
        name: body.visitor?.name || null,
        email: body.visitor?.email || null,
        attributes: body.visitor?.attributes || {},
        pageUrl: body.url || null,
        referrer: body.referrer || null,
      });
    } else {
      visitor = touchVisitor(db, visitor.id, {
        name: body.visitor?.name || undefined,
        email: body.visitor?.email || undefined,
        attributes: body.visitor?.attributes || {},
        pageUrl: body.url || null,
      });
    }

    let conversation = findOpenConversation(db, propertyId, visitor.id);
    if (!conversation) conversation = createConversation(db, { propertyId, visitorId: visitor.id });

    const token = visitorToken(secret, propertyId, visitor.session_key);
    ok(res, {
      sessionKey: visitor.session_key,
      token,
      visitor: {
        id: visitor.id,
        name: visitor.name,
        email: visitor.email,
        attributes: parseJson(visitor.attributes, {}),
      },
      conversation: {
        id: conversation.id,
        status: conversation.status,
        startedAt: conversation.started_at,
      },
      pageStatus: isPropertyOnline(db, propertyId) ? 'online' : 'offline',
      socketPath: `/ws/visitor?propertyId=${encodeURIComponent(propertyId)}&sessionKey=${encodeURIComponent(visitor.session_key)}&token=${encodeURIComponent(token)}`,
      messages: listMessages(db, conversation.id),
    });
  });

  function visitorConversation(req, res, next) {
    const propertyId = String(req.query.propertyId || req.body?.propertyId || '');
    const conversationId = String(req.params.conversationId || req.params.id || '');
    const sessionKey = String(req.query.sessionKey || req.body?.sessionKey || '');
    const token = String(req.query.token || req.body?.token || '');
    if (!verifyVisitorToken(secret, propertyId, sessionKey, token)) return fail(res, 401, 'UNAUTHORIZED');
    const conversation = getConversation(db, propertyId, conversationId);
    const visitor = getVisitorBySession(db, propertyId, sessionKey);
    if (!conversation || !visitor || conversation.visitor_id !== visitor.id) {
      return fail(res, 404, 'CONVERSATION_NOT_FOUND');
    }
    req.conversation = conversation;
    req.visitor = visitor;
    next();
  }

  router.get('/v1/conversation/:conversationId', visitorConversation, (req, res) => {
    ok(res, {
      conversation: {
        id: req.conversation.id,
        status: req.conversation.status,
        messages: req.conversation.messages,
      },
    });
  });

  router.post('/v1/conversation/:conversationId/rating', visitorConversation, (req, res) => {
    const value = Number(req.body?.value);
    const rating = value === 1 ? 1 : value === -1 ? -1 : 0;
    setRating(db, req.conversation.id, rating);
    addEvent(db, req.conversation.id, 'rating', { value: rating });
    realtime.broadcastToAgents(req.conversation.property_id, 'rating', {
      conversationId: req.conversation.id, value: rating,
    });
    ok(res, { rating });
  });

  router.post('/v1/offline-form', (req, res) => {
    const body = req.body || {};
    const propertyId = String(body.propertyId || '');
    const property = getProperty(db, propertyId);
    if (!property) return fail(res, 404, 'PROPERTY_NOT_FOUND');
    const visitor = body.sessionKey ? getVisitorBySession(db, propertyId, String(body.sessionKey)) : null;
    const ticket = createTicket(db, {
      propertyId, visitorId: visitor?.id || null,
      name: body.name, email: body.email, message: String(body.message || '').slice(0, MAX_MESSAGE_LENGTH),
    });
    webhooks.emit(propertyId, 'ticket:create', ticketPayload({ ticket, property }));
    realtime.broadcastToAgents(propertyId, 'ticket:create', { ticket });
    ok(res, { ticket });
  });

  router.get('/v1/transcript/:conversationId', visitorConversation, (req, res) => {
    const lines = req.conversation.messages.map((message) => {
      const who = message.sender_type === 'visitor' ? (req.visitor.name || 'Visitor')
        : message.sender_type === 'agent' ? (message.sender_name || 'Agent') : 'System';
      return `[${message.created_at}] ${who}: ${message.body}`;
    });
    res.type('text/plain').send(`Sparrow Chat transcript\nConversation ${req.conversation.id}\n\n${lines.join('\n')}`);
  });

  // ---------------------------------------------------------------- workspace identity
  router.get('/auth/me', agentOnly, (req, res) => {
    const property = getProperty(db, req.agent.property_id);
    ok(res, {
      agent: req.agent,
      property: { id: property.id, name: property.name, domain: property.domain },
    });
  });

  // ---------------------------------------------------------------- agent inbox
  router.get('/conversations', agentOnly, (req, res) => {
    ok(res, {
      conversations: listConversations(db, req.agent.property_id, {
        status: String(req.query.status || 'open'),
        q: String(req.query.q || ''),
      }),
      stats: statsFor(db, req.agent.property_id),
    });
  });

  router.get('/conversations/:id', agentOnly, (req, res) => {
    markSeen(db, req.params.id, 'agent');
    const conversation = getConversation(db, req.agent.property_id, req.params.id);
    if (!conversation) return fail(res, 404, 'CONVERSATION_NOT_FOUND');
    realtime.broadcastToVisitors(conversation.id, 'seen', { at: now() });
    ok(res, { conversation });
  });

  router.post('/conversations/:id/messages', agentOnly, (req, res) => {
    const conversation = getConversation(db, req.agent.property_id, req.params.id);
    if (!conversation) return fail(res, 404, 'CONVERSATION_NOT_FOUND');
    if (conversation.status !== 'open') return fail(res, 409, 'CONVERSATION_CLOSED');
    const body = String(req.body?.body || '').trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!body) return fail(res, 400, 'EMPTY_MESSAGE');
    if (!conversation.assigned_agent_id) {
      db.prepare('UPDATE conversations SET assigned_agent_id = ? WHERE id = ?').run(req.agent.id, conversation.id);
    }
    const message = addMessage(db, {
      conversationId: conversation.id, senderType: 'agent', senderId: req.agent.id,
      senderName: req.agent.name, body,
    });
    realtime.broadcastToVisitors(conversation.id, 'message', { message });
    realtime.broadcastToAgents(req.agent.property_id, 'message', { conversationId: conversation.id, message });
    ok(res, { message });
  });

  router.post('/conversations/:id/read', agentOnly, (req, res) => {
    const conversation = db.prepare('SELECT id FROM conversations WHERE id = ? AND property_id = ?')
      .get(req.params.id, req.agent.property_id);
    if (!conversation) return fail(res, 404, 'CONVERSATION_NOT_FOUND');
    markSeen(db, conversation.id, 'agent');
    realtime.broadcastToVisitors(conversation.id, 'seen', { at: now() });
    ok(res);
  });

  router.post('/conversations/:id/end', agentOnly, (req, res) => {
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND property_id = ? AND status = ?')
      .get(req.params.id, req.agent.property_id, 'open');
    if (!conversation) return fail(res, 404, 'CONVERSATION_NOT_FOUND');
    const ended = endConversation(db, conversation.id, req.agent.name);
    const details = getConversation(db, req.agent.property_id, conversation.id);
    const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(conversation.visitor_id);
    const property = getProperty(db, req.agent.property_id);
    webhooks.emit(property.id, 'chat:end', chatEndPayload({ conversation: ended, visitor, property }));
    webhooks.emit(property.id, 'chat:transcript_created', transcriptPayload({
      conversation: ended, visitor, property, messages: details.messages,
    }));
    realtime.broadcastToVisitors(conversation.id, 'conversation:ended', { conversation: details });
    realtime.broadcastToAgents(req.agent.property_id, 'conversation:ended', { conversationId: conversation.id, conversation: details });
    ok(res, { conversation: details });
  });

  router.post('/conversations/:id/tags', agentOnly, (req, res) => {
    const conversation = db.prepare('SELECT id FROM conversations WHERE id = ? AND property_id = ?')
      .get(req.params.id, req.agent.property_id);
    if (!conversation) return fail(res, 404, 'CONVERSATION_NOT_FOUND');
    const tags = updateTags(db, conversation.id, { add: req.body?.add || [], remove: req.body?.remove || [] });
    realtime.broadcastToAgents(req.agent.property_id, 'tags', { conversationId: conversation.id });
    ok(res, { tags });
  });

  router.get('/stats', agentOnly, (req, res) => {
    ok(res, { stats: statsFor(db, req.agent.property_id) });
  });

  router.patch('/agents/me', agentOnly, (req, res) => {
    const status = ['online', 'away', 'offline'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return fail(res, 400, 'INVALID_STATUS');
    db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, req.agent.id);
    realtime.broadcastPresence(req.agent.property_id);
    ok(res, { status });
  });

  // ---------------------------------------------------------------- settings
  router.get('/settings', agentOnly, (req, res) => {
    const property = getProperty(db, req.agent.property_id);
    ok(res, { property: { id: property.id, name: property.name, domain: property.domain }, settings: getSettings(db, property.id) });
  });

  router.put('/settings', agentOnly, (req, res) => {
    if (req.agent.role !== 'admin') return fail(res, 403, 'ADMIN_ONLY');
    const current = getSettings(db, req.agent.property_id);
    const incoming = req.body || {};
    const settings = {
      ...current,
      ...incoming,
      branding: { ...current.branding, ...(incoming.branding || {}) },
      widget: { ...current.widget, ...(incoming.widget || {}) },
      behavior: { ...current.behavior, ...(incoming.behavior || {}) },
      features: { ...current.features, ...(incoming.features || {}) },
    };
    updateSettings(db, req.agent.property_id, settings);
    realtime.broadcastToAgents(req.agent.property_id, 'settings:update', { settings });
    ok(res, { settings });
  });

  // ---------------------------------------------------------------- webhooks
  router.get('/webhooks', agentOnly, (req, res) => {
    ok(res, { webhooks: webhooks.list(req.agent.property_id) });
  });

  router.post('/webhooks', agentOnly, (req, res) => {
    if (req.agent.role !== 'admin') return fail(res, 403, 'ADMIN_ONLY');
    const url = String(req.body?.url || '');
    if (!/^https?:\/\//i.test(url)) return fail(res, 400, 'INVALID_URL');
    const events = Array.isArray(req.body?.events) && req.body.events.length ? req.body.events : ['*'];
    ok(res, { webhook: webhooks.add(req.agent.property_id, { url, events }) });
  });

  router.delete('/webhooks/:id', agentOnly, (req, res) => {
    if (req.agent.role !== 'admin') return fail(res, 403, 'ADMIN_ONLY');
    const removed = webhooks.remove(req.agent.property_id, req.params.id);
    if (!removed) return fail(res, 404, 'WEBHOOK_NOT_FOUND');
    ok(res);
  });

  router.get('/webhooks/deliveries', agentOnly, (req, res) => {
    ok(res, { deliveries: webhooks.deliveries(req.agent.property_id) });
  });

  router.get('/tickets', agentOnly, (req, res) => {
    ok(res, { tickets: listTickets(db, req.agent.property_id) });
  });

  router.get('/export/:id', agentOnly, (req, res) => {
    const conversation = getConversation(db, req.agent.property_id, req.params.id);
    if (!conversation) return fail(res, 404, 'CONVERSATION_NOT_FOUND');
    const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [['created_at', 'sender_type', 'sender_name', 'body'].map(escape).join(',')];
    for (const message of conversation.messages) {
      rows.push([message.created_at, message.sender_type, message.sender_name, message.body].map(escape).join(','));
    }
    res.type('text/csv').setHeader('content-disposition', `attachment; filename="conversation-${conversation.id}.csv"`);
    res.send(rows.join('\n'));
  });

  return router;
}
