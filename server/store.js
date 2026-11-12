import { randomUUID } from 'node:crypto';

export const now = () => new Date().toISOString();

const parseJson = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

export function getProperty(db, propertyId) {
  return db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId) || null;
}

export function getDefaultAgent(db, propertyId = null) {
  const columns = 'id, property_id, email, name, role, status, avatar_color';
  const rank = "CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at";
  return propertyId
    ? db.prepare(`SELECT ${columns} FROM agents WHERE property_id = ? ORDER BY ${rank} LIMIT 1`).get(propertyId) || null
    : db.prepare(`SELECT ${columns} FROM agents ORDER BY ${rank} LIMIT 1`).get() || null;
}

export function getSettings(db, propertyId) {
  const row = db.prepare('SELECT settings FROM properties WHERE id = ?').get(propertyId);
  return row ? parseJson(row.settings, {}) : null;
}

export function updateSettings(db, propertyId, settings) {
  db.prepare('UPDATE properties SET settings = ? WHERE id = ?').run(JSON.stringify(settings), propertyId);
  return settings;
}

export function agentStatuses(db, propertyId) {
  return db.prepare('SELECT status, COUNT(*) AS count FROM agents WHERE property_id = ? GROUP BY status')
    .all(propertyId).reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {});
}

export function isPropertyOnline(db, propertyId) {
  return db.prepare("SELECT COUNT(*) AS c FROM agents WHERE property_id = ? AND status = 'online'").get(propertyId).c > 0;
}

export function listConversations(db, propertyId, { status = 'open', q = '' } = {}) {
  const params = [propertyId];
  let where = `c.property_id = ? AND EXISTS (
    SELECT 1 FROM messages m WHERE m.conversation_id = c.id
  )`;
  if (status && status !== 'all') {
    where += ' AND c.status = ?';
    params.push(status);
  }
  if (q) {
    where += ` AND (v.name LIKE ? OR v.email LIKE ? OR c.subject LIKE ? OR EXISTS (
      SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.body LIKE ?
    ))`;
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const rows = db.prepare(`
    SELECT c.*, v.name AS visitor_name, v.email AS visitor_email, v.page_url, v.city, v.country,
      (SELECT body FROM messages m WHERE m.conversation_id = c.id AND m.type != 'system'
        ORDER BY m.created_at DESC LIMIT 1) AS last_message,
      (SELECT sender_type FROM messages m WHERE m.conversation_id = c.id AND m.type != 'system'
        ORDER BY m.created_at DESC LIMIT 1) AS last_sender
    FROM conversations c
    JOIN visitors v ON v.id = c.visitor_id
    WHERE ${where}
    ORDER BY c.last_message_at DESC
    LIMIT 200
  `).all(...params);
  return rows.map((row) => ({
    ...row,
    tags: parseJson(row.tags, []),
    unread_agent: Number(row.unread_agent),
    unread_visitor: Number(row.unread_visitor),
  }));
}

export function getConversation(db, propertyId, conversationId) {
  const row = db.prepare(`
    SELECT c.*, v.name AS visitor_name, v.email AS visitor_email, v.page_url, v.referrer,
      v.city, v.country, v.attributes, v.first_seen, v.last_seen, v.id AS visitor_id
    FROM conversations c JOIN visitors v ON v.id = c.visitor_id
    WHERE c.id = ? AND c.property_id = ?
  `).get(conversationId, propertyId);
  if (!row) return null;
  return {
    ...row,
    tags: parseJson(row.tags, []),
    attributes: parseJson(row.attributes, {}),
    messages: listMessages(db, conversationId),
    events: listEvents(db, conversationId),
    unread_agent: Number(row.unread_agent),
    unread_visitor: Number(row.unread_visitor),
  };
}

export function listMessages(db, conversationId) {
  return db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(conversationId)
    .map((m) => ({ ...m, meta: parseJson(m.meta, {}) }));
}

export function listEvents(db, conversationId) {
  return db.prepare(`SELECT * FROM conversation_events WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(conversationId)
    .map((e) => ({ ...e, meta: parseJson(e.meta, {}) }));
}

export function findOpenConversation(db, propertyId, visitorId) {
  return db.prepare(`SELECT * FROM conversations WHERE property_id = ? AND visitor_id = ? AND status = 'open'
    ORDER BY started_at DESC LIMIT 1`).get(propertyId, visitorId) || null;
}

export function createConversation(db, { propertyId, visitorId, subject = null, assignedAgentId = null }) {
  const id = randomUUID();
  const time = now();
  db.prepare(`INSERT INTO conversations
    (id,property_id,visitor_id,status,subject,tags,rating,assigned_agent_id,started_at,last_message_at,ended_at,unread_agent,unread_visitor)
    VALUES (?,?,?,'open',?, '[]', NULL,?,?,?,NULL,0,0)`)
    .run(id, propertyId, visitorId, subject, assignedAgentId, time, time);
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

export function createVisitor(db, { propertyId, sessionKey, name = null, email = null, attributes = {}, pageUrl = null, referrer = null }) {
  const id = randomUUID();
  const time = now();
  db.prepare(`INSERT INTO visitors
    (id,property_id,session_key,name,email,attributes,first_seen,last_seen,page_url,referrer,country,city)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, propertyId, sessionKey, name, email, JSON.stringify(attributes), time, time, pageUrl, referrer, null, null);
  return db.prepare('SELECT * FROM visitors WHERE id = ?').get(id);
}

export function getVisitorBySession(db, propertyId, sessionKey) {
  return db.prepare('SELECT * FROM visitors WHERE property_id = ? AND session_key = ?').get(propertyId, sessionKey) || null;
}

export function touchVisitor(db, visitorId, { name, email, attributes, pageUrl } = {}) {
  const current = db.prepare('SELECT * FROM visitors WHERE id = ?').get(visitorId);
  if (!current) return null;
  const merged = { ...parseJson(current.attributes, {}), ...(attributes || {}) };
  if (name) current.name = name;
  if (email) current.email = email;
  db.prepare('UPDATE visitors SET name = ?, email = ?, attributes = ?, last_seen = ?, page_url = COALESCE(?, page_url) WHERE id = ?')
    .run(current.name, current.email, JSON.stringify(merged), now(), pageUrl || null, visitorId);
  return db.prepare('SELECT * FROM visitors WHERE id = ?').get(visitorId);
}

export function addMessage(db, {
  conversationId, senderType, senderId = null, senderName = null,
  body, type = 'text', meta = {},
}) {
  const id = randomUUID();
  const created = now();
  db.prepare(`INSERT INTO messages (id,conversation_id,sender_type,sender_id,sender_name,body,type,meta,created_at,seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,NULL)`)
    .run(id, conversationId, senderType, senderId, senderName, body, type, JSON.stringify(meta), created);

  const unreadAgent = senderType === 'visitor' ? 1 : 0;
  const unreadVisitor = senderType === 'agent' ? 1 : 0;
  db.prepare(`UPDATE conversations SET last_message_at = ?, unread_agent = unread_agent + ?, unread_visitor = unread_visitor + ?
    WHERE id = ?`).run(created, unreadAgent, unreadVisitor, conversationId);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

export function markSeen(db, conversationId, side) {
  const field = side === 'agent' ? 'unread_agent' : 'unread_visitor';
  db.prepare(`UPDATE conversations SET ${field} = 0 WHERE id = ?`).run(conversationId);
  if (side === 'agent') {
    db.prepare(`UPDATE messages SET seen_at = ? WHERE conversation_id = ? AND sender_type = 'visitor' AND seen_at IS NULL`)
      .run(now(), conversationId);
  } else {
    db.prepare(`UPDATE messages SET seen_at = ? WHERE conversation_id = ? AND sender_type = 'agent' AND seen_at IS NULL`)
      .run(now(), conversationId);
  }
}

export function updateTags(db, conversationId, { add = [], remove = [] }) {
  const row = db.prepare('SELECT tags FROM conversations WHERE id = ?').get(conversationId);
  if (!row) return null;
  const tags = new Set(parseJson(row.tags, []));
  add.forEach((tag) => tags.add(String(tag).slice(0, 40)));
  remove.forEach((tag) => tags.delete(String(tag)));
  const next = [...tags].slice(0, 20);
  db.prepare('UPDATE conversations SET tags = ? WHERE id = ?').run(JSON.stringify(next), conversationId);
  return next;
}

export function setRating(db, conversationId, rating) {
  db.prepare('UPDATE conversations SET rating = ? WHERE id = ?').run(rating, conversationId);
}

export function endConversation(db, conversationId, agentName = 'System') {
  const time = now();
  const row = db.prepare("SELECT * FROM conversations WHERE id = ? AND status = 'open'").get(conversationId);
  if (!row) return null;
  db.prepare("UPDATE conversations SET status = 'closed', ended_at = ? WHERE id = ?").run(time, conversationId);
  addMessage(db, {
    conversationId, senderType: 'system', senderName: agentName,
    body: `${agentName} ended the conversation`, type: 'system',
  });
  db.prepare(`INSERT INTO conversation_events (id,conversation_id,name,meta,created_at) VALUES (?,?,?,?,?)`)
    .run(randomUUID(), conversationId, 'chat:end', '{}', time);
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
}

export function addEvent(db, conversationId, name, meta = {}) {
  db.prepare(`INSERT INTO conversation_events (id,conversation_id,name,meta,created_at) VALUES (?,?,?,?,?)`)
    .run(randomUUID(), conversationId, name, JSON.stringify(meta), now());
}

export function createTicket(db, { propertyId, visitorId = null, name, email, message }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO tickets (id,property_id,visitor_id,name,email,message,status,created_at)
    VALUES (?,?,?,?,?,?,'open',?)`)
    .run(id, propertyId, visitorId, name || null, email || null, message, now());
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

export function listTickets(db, propertyId) {
  return db.prepare('SELECT * FROM tickets WHERE property_id = ? ORDER BY created_at DESC LIMIT 200').all(propertyId);
}

export function statsFor(db, propertyId) {
  const countable = `property_id = ? AND EXISTS (
    SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id
  )`;
  const open = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE ${countable} AND status = 'open'`).get(propertyId).c;
  const closed = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE ${countable} AND status = 'closed'`).get(propertyId).c;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const messagesToday = db.prepare(`SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.property_id = ? AND m.created_at >= ?`).get(propertyId, today.toISOString()).c;
  const visitorsToday = db.prepare('SELECT COUNT(*) AS c FROM visitors WHERE property_id = ? AND first_seen >= ?')
    .get(propertyId, today.toISOString()).c;
  const rating = db.prepare('SELECT AVG(rating) AS avg, COUNT(rating) AS count FROM conversations WHERE property_id = ? AND rating IS NOT NULL')
    .get(propertyId);
  return {
    open, closed, messagesToday, visitorsToday,
    rating: rating.avg ? Number(rating.avg.toFixed(2)) : null,
    ratings: Number(rating.count),
  };
}

export { parseJson };
