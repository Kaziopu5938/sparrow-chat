import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  created_at TEXT NOT NULL,
  settings TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',
  status TEXT NOT NULL DEFAULT 'online',
  avatar_color TEXT NOT NULL DEFAULT '#0f766e',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  session_key TEXT NOT NULL UNIQUE,
  name TEXT,
  email TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  page_url TEXT,
  referrer TEXT,
  country TEXT,
  city TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  visitor_id TEXT NOT NULL REFERENCES visitors(id),
  status TEXT NOT NULL DEFAULT 'open',
  subject TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  rating INTEGER,
  assigned_agent_id TEXT,
  started_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  ended_at TEXT,
  unread_agent INTEGER NOT NULL DEFAULT 0,
  unread_visitor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_type TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  seen_at TEXT
);

CREATE TABLE IF NOT EXISTS conversation_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  name TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  visitor_id TEXT,
  name TEXT,
  email TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_property ON conversations(property_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON webhook_deliveries(status, next_attempt_at);
`;

export function openDb(dataDir, { seed = true } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'sparrow.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  if (seed) seedDemo(db);
  return db;
}

export function seedDemo(db) {
  const existing = db.prepare('SELECT id FROM properties LIMIT 1').get();
  if (existing) return existing.id;

  const now = Date.now();
  const iso = (offsetMs = 0) => new Date(now - offsetMs).toISOString();
  const propertyId = 'sparrow-demo';
  const agentId = randomUUID();

  db.prepare('INSERT INTO properties (id,name,domain,created_at,settings) VALUES (?,?,?,?,?)')
    .run(propertyId, 'Sparrow Demo Store', 'localhost', iso(), JSON.stringify(DEFAULT_SETTINGS));
  db.prepare(`INSERT INTO agents (id,property_id,email,name,role,status,avatar_color,created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(agentId, propertyId, 'admin@sparrow.local', 'Alex Rivers', 'admin', 'online', '#0f766e', iso());

  const visitors = [
    ['Maya Chen', 'maya@example.com', 'https://shop.example.com/cart', 'I ordered the linen shirt in medium — can I still swap it before it ships?', 4 * 60_000, 'Shipping'],
    ['Tomás Reyes', 'tomas@example.com', 'https://shop.example.com/pricing', 'Do you offer a team plan for five seats?', 26 * 60_000, 'Billing'],
    ['Anna Kowalski', null, 'https://shop.example.com/products/oak-desk', 'The desk arrived with a scratch on the top. Photos attached.', 3 * 60 * 60_000, 'Damaged item'],
  ];

  const insertVisitor = db.prepare(`INSERT INTO visitors
    (id,property_id,session_key,name,email,attributes,first_seen,last_seen,page_url,referrer,country,city)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertConv = db.prepare(`INSERT INTO conversations
    (id,property_id,visitor_id,status,subject,tags,rating,assigned_agent_id,started_at,last_message_at,ended_at,unread_agent,unread_visitor)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertMsg = db.prepare(`INSERT INTO messages
    (id,conversation_id,sender_type,sender_id,sender_name,body,type,meta,created_at,seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  visitors.forEach(([name, email, pageUrl, text, age, tag], index) => {
    const visitorId = randomUUID();
    const conversationId = randomUUID();
    const sessionKey = randomUUID();
    const started = iso(age + 120_000);
    insertVisitor.run(visitorId, propertyId, sessionKey, name, email,
      JSON.stringify({ plan: index === 1 ? 'trial' : 'buyer', order: `#48${21 + index}` }),
      started, iso(age), pageUrl, 'https://www.google.com/', 'US', ['Austin', 'Chicago', 'Seattle'][index]);
    insertConv.run(conversationId, propertyId, visitorId, 'open', tag, JSON.stringify([tag.toLowerCase()]),
      null, agentId, started, iso(age), null, index === 0 ? 1 : 0, 0);
    insertMsg.run(randomUUID(), conversationId, 'visitor', visitorId, name, text, 'text', '{}', started, null);
    if (index === 0) {
      insertMsg.run(randomUUID(), conversationId, 'agent', agentId, 'Alex Rivers',
        'Hi Maya! Good news — the order has not left the warehouse yet, so I can swap the size for you.',
        'text', '{}', iso(age + 60_000), iso(age + 30_000));
    }
    if (index === 1) {
      insertMsg.run(randomUUID(), conversationId, 'system', null, null,
        'Pre-chat form submitted', 'system', '{}', iso(age + 90_000), null);
    }
  });

  return propertyId;
}
