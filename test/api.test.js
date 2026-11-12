import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers.js';

function getWithHost(base, path, host) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    http.get({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { host },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

describe('public API and dashboard access', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server.close(); });

  it('serves health and widget settings', async () => {
    const health = await server.request('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.data.status, 'up');

    const settings = await server.request('/api/v1/widget-settings?propertyId=sparrow-demo&widgetId=default');
    assert.equal(settings.status, 200);
    assert.equal(settings.payload.data.propertyName, 'Sparrow Demo Store');
    assert.equal(settings.payload.data.settings.widget.position, 'br');
    assert.equal(settings.payload.data.pageStatus, 'online');
  });

  it('rejects unknown properties and widgets', async () => {
    assert.equal((await server.request('/api/v1/widget-settings?propertyId=nope')).status, 404);
    assert.equal((await server.request('/api/v1/widget-settings?propertyId=sparrow-demo&widgetId=other')).status, 404);
  });

  it('serves a property-scoped embed loader', async () => {
    const response = await fetch(server.base + '/embed/sparrow-demo');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    const text = await response.text();
    assert.match(text, /sparrow-demo/);
    assert.match(text, /sparrow-widget\.js/);
    assert.match(text, /__sparrowQueue/);
    assert.match(text, /Sparrow_API/);
    assert.match(text, /\$_Sparrow_Server/);
    assert.match(text, new RegExp(`${server.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/widget/sparrow-widget\\.js`));

    const missing = await fetch(server.base + '/embed/missing');
    assert.equal(missing.status, 404);
  });

  it('serves the widget API and module with CORS for external sites', async () => {
    const origin = 'https://shop.example.com';
    const settings = await fetch(`${server.base}/api/v1/widget-settings?propertyId=sparrow-demo&widgetId=default`, {
      headers: { origin },
    });
    assert.equal(settings.headers.get('access-control-allow-origin'), '*');

    const preflight = await fetch(`${server.base}/api/v1/session/start`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

    const widget = await fetch(`${server.base}/widget/sparrow-widget.js`, { headers: { origin } });
    assert.equal(widget.status, 200);
    assert.equal(widget.headers.get('access-control-allow-origin'), '*');
  });

  it('creates a visitor session and returns a signed socket path', async () => {
    const data = await server.startSession();
    assert.ok(data.sessionKey);
    assert.ok(data.token);
    assert.ok(data.conversation.id);
    assert.equal(data.pageStatus, 'online');
    assert.match(data.socketPath, /^\/ws\/visitor\?/);
    assert.ok(Array.isArray(data.messages));
  });

  it('opens the dashboard as the default agent without signing in', async () => {
    const me = await server.request('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.payload.data.agent.email, 'admin@sparrow.local');
    assert.equal(me.payload.data.agent.name, 'Alex Rivers');
    assert.equal(me.payload.data.property.id, 'sparrow-demo');
  });

  it('lists seeded conversations with visitor details and stats', async () => {
    const list = await server.request('/api/conversations?status=open');
    assert.equal(list.status, 200);
    assert.ok(list.payload.data.conversations.length >= 3);
    const first = list.payload.data.conversations[0];
    assert.ok(first.visitor_name);
    assert.ok(Array.isArray(first.tags));
    assert.equal(typeof list.payload.data.stats.open, 'number');
    assert.ok(list.payload.data.stats.open >= 3);
  });

  it('supports search, tags, ending a chat and CSV export', async () => {
    const search = await server.request('/api/conversations?status=all&q=Maya');
    assert.equal(search.status, 200);
    assert.ok(search.payload.data.conversations.some((item) => item.visitor_name === 'Maya Chen'));
    const id = search.payload.data.conversations[0].id;

    const tags = await server.request(`/api/conversations/${id}/tags`, {
      method: 'POST', body: { add: ['vip', 'wholesale'] },
    });
    assert.equal(tags.status, 200);
    assert.ok(tags.payload.data.tags.includes('vip'));
    assert.ok(tags.payload.data.tags.includes('wholesale'));

    const ended = await server.request(`/api/conversations/${id}/end`, { method: 'POST' });
    assert.equal(ended.status, 200);
    assert.equal(ended.payload.data.conversation.status, 'closed');
    assert.ok(ended.payload.data.conversation.messages.some((message) => message.type === 'system'));

    const csv = await fetch(`${server.base}/api/export/${id}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const text = await csv.text();
    assert.match(text, /sender_type/);
  });

  it('updates widget settings', async () => {
    const updated = await server.request('/api/settings', {
      method: 'PUT',
      body: { branding: { color: '#123456' }, widget: { greeting: 'Hey there' } },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.payload.data.settings.branding.color, '#123456');
    assert.equal(updated.payload.data.settings.widget.greeting, 'Hey there');
    assert.equal(updated.payload.data.settings.branding.name, 'Sparrow');
  });

  it('creates an offline ticket', async () => {
    const response = await server.request('/api/v1/offline-form', {
      method: 'POST',
      body: {
        propertyId: 'sparrow-demo', name: 'Offline Olive',
        email: 'olive@example.com', message: 'Please call me back.',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.data.ticket.email, 'olive@example.com');

    const tickets = await server.request('/api/tickets');
    assert.equal(tickets.status, 200);
    assert.ok(tickets.payload.data.tickets.some((ticket) => ticket.email === 'olive@example.com'));
  });

  it('keeps dashboard and agent APIs on the admin host only', async () => {
    const secured = await startServer({ adminHost: 'admin.example.test' });
    try {
      const blocked = await getWithHost(secured.base, '/api/conversations', 'chat.example.test');
      assert.equal(blocked.status, 404);

      const dashboard = await getWithHost(secured.base, '/dashboard/', 'chat.example.test');
      assert.equal(dashboard.status, 404);

      const widget = await getWithHost(
        secured.base,
        '/api/v1/widget-settings?propertyId=sparrow-demo&widgetId=default',
        'chat.example.test',
      );
      assert.equal(widget.status, 200);

      const admin = await getWithHost(secured.base, '/api/conversations', 'admin.example.test');
      assert.equal(admin.status, 200);
    } finally {
      await secured.close();
    }
  });
});
