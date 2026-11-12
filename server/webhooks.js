import { createHmac, randomUUID } from 'node:crypto';

const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 15_000;

export function createWebhookService({ db, fetchImpl = globalThis.fetch, logger = console }) {
  const sign = (secret, body) => createHmac('sha256', secret).update(body).digest('hex');

  function list(propertyId) {
    return db.prepare('SELECT * FROM webhooks WHERE property_id = ? ORDER BY created_at DESC')
      .all(propertyId)
      .map((hook) => ({ ...hook, events: JSON.parse(hook.events), active: Boolean(hook.active) }));
  }

  function add(propertyId, { url, events = ['*'], secret }) {
    const hookSecret = secret || randomUUID().replaceAll('-', '');
    const id = randomUUID();
    db.prepare('INSERT INTO webhooks (id,property_id,url,secret,events,active,created_at) VALUES (?,?,?,?,?,1,?)')
      .run(id, propertyId, url, hookSecret, JSON.stringify(events), new Date().toISOString());
    return { id, url, secret: hookSecret, events, active: true };
  }

  function remove(propertyId, id) {
    const hook = db.prepare('SELECT id FROM webhooks WHERE property_id = ? AND id = ?').get(propertyId, id);
    if (!hook) return false;
    db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(id);
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return true;
  }

  function emit(propertyId, event, payload) {
    const hooks = db.prepare('SELECT * FROM webhooks WHERE property_id = ? AND active = 1').all(propertyId);
    const dispatchTime = new Date().toISOString();
    let queued = 0;
    for (const hook of hooks) {
      const events = JSON.parse(hook.events);
      if (!events.includes('*') && !events.includes(event)) continue;
      const body = JSON.stringify({ event, ...payload });
      db.prepare(`INSERT INTO webhook_deliveries
        (id,webhook_id,event,payload,attempts,status,next_attempt_at,last_error,created_at)
        VALUES (?,?,?,?,0,'pending',?,NULL,?)`)
        .run(randomUUID(), hook.id, event, body, dispatchTime, dispatchTime);
      queued += 1;
    }
    if (queued) void flush();
    return queued;
  }

  async function deliver(row) {
    const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(row.webhook_id);
    if (!hook || !hook.active) {
      db.prepare("UPDATE webhook_deliveries SET status = 'dead' WHERE id = ?").run(row.id);
      return;
    }
    const attempts = row.attempts + 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImpl(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sparrow-signature': sign(hook.secret, row.payload),
          'x-sparrow-event': row.event,
          'x-sparrow-event-id': row.id,
          'user-agent': 'Sparrow-Webhooks/1.0',
        },
        body: row.payload,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      db.prepare("UPDATE webhook_deliveries SET attempts = ?, status = 'delivered', last_error = NULL WHERE id = ?")
        .run(attempts, row.id);
    } catch (error) {
      clearTimeout(timeout);
      const delay = BASE_DELAY_MS * 2 ** Math.min(attempts - 1, 5);
      const next = new Date(Date.now() + delay).toISOString();
      const dead = attempts >= MAX_ATTEMPTS ? 1 : 0;
      db.prepare(`UPDATE webhook_deliveries SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`)
        .run(attempts, dead ? 'dead' : 'pending', next, String(error.message || error).slice(0, 500), row.id);
      if (dead) logger.warn(`[webhooks] delivery ${row.id} gave up after ${attempts} attempts`);
    }
  }

  async function flush() {
    if (flush.running) {
      flush.again = true;
      return;
    }
    flush.running = true;
    try {
      let rows;
      do {
        rows = db.prepare(`SELECT * FROM webhook_deliveries
          WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT 25`)
          .all(new Date().toISOString());
        if (rows.length) await Promise.all(rows.map(deliver));
      } while (rows.length);
    } catch (error) {
      logger.error('[webhooks] flush failed', error);
    } finally {
      flush.running = false;
      if (flush.again) {
        flush.again = false;
        void flush();
      }
    }
  }

  const timer = setInterval(() => { void flush(); }, 15_000);
  timer.unref?.();

  function stop() {
    clearInterval(timer);
  }

  function deliveries(propertyId, limit = 50) {
    return db.prepare(`SELECT d.* FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE w.property_id = ? ORDER BY d.created_at DESC LIMIT ?`).all(propertyId, limit)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  return { list, add, remove, emit, flush, stop, deliveries, sign };
}

export function chatStartPayload({ conversation, visitor, message, property }) {
  return {
    chatId: conversation.id,
    time: message.created_at,
    domain: safeHost(visitor.page_url),
    referrer: visitor.referrer || '',
    message: { text: message.body, type: message.type, sender: { type: message.sender_type } },
    visitor: {
      name: visitor.name || `V${String(visitor.first_seen).replace(/\D/g, '').slice(0, 13)}`,
      email: visitor.email || '',
      city: visitor.city || '',
      country: visitor.country || '',
    },
    property: { id: property.id, name: property.name },
  };
}

export function chatEndPayload({ conversation, visitor, property }) {
  return {
    chatId: conversation.id,
    time: conversation.ended_at,
    domain: safeHost(visitor.page_url),
    referrer: visitor.referrer || '',
    visitor: { name: visitor.name || '', email: visitor.email || '', city: visitor.city || '', country: visitor.country || '' },
    property: { id: property.id, name: property.name },
  };
}

export function transcriptPayload({ conversation, visitor, property, messages }) {
  return {
    time: conversation.ended_at,
    domain: safeHost(visitor.page_url),
    referrer: visitor.referrer || '',
    property: { id: property.id, name: property.name },
    chat: {
      id: conversation.id,
      visitor: { name: visitor.name || '', email: visitor.email || '', city: visitor.city || '', country: visitor.country || '' },
      messages: messages.map((message) => ({
        sender: {
          t: message.sender_type === 'visitor' ? 'v' : message.sender_type === 'agent' ? 'a' : 's',
          ...(message.sender_name ? { n: message.sender_name } : {}),
          ...(message.sender_id ? { id: message.sender_id } : {}),
        },
        type: message.type,
        msg: message.body,
        time: message.created_at,
      })),
    },
  };
}

export function ticketPayload({ ticket, property }) {
  return {
    time: ticket.created_at,
    property: { id: property.id, name: property.name },
    requester: { name: ticket.name || '', email: ticket.email || '', type: 'visitor' },
    ticket: { id: ticket.id, subject: ticket.message.slice(0, 80), message: ticket.message },
  };
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}
