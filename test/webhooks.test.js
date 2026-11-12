import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { openSocket, startServer, waitFor, waitUntil } from './helpers.js';

describe('webhooks', () => {
  let server;
  let receiver;
  let received = [];
  let webhook;

  before(async () => {
    server = await startServer();
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          received.push({ headers: req.headers, body, json: JSON.parse(body) });
        } catch {
          received.push({ headers: req.headers, body, json: null });
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const port = receiver.address().port;
    const added = await server.request('/api/webhooks', {
      method: 'POST',
      body: { url: `http://127.0.0.1:${port}/hooks`, events: ['*'] },
    });
    assert.equal(added.status, 200);
    webhook = added.payload.data.webhook;
  });

  after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
    await server.close();
  });

  it('signs chat:start deliveries with HMAC-SHA256', async () => {
    const session = await server.startSession({ name: 'Webhook Wendy', email: 'wendy@example.com' });
    const socket = await openSocket(server.base.replace('http', 'ws') + session.socketPath);
    await waitFor(socket, (data) => data.type === 'ready');
    socket.send(JSON.stringify({ type: 'message', body: 'First message triggers the webhook' }));

    const delivery = await waitUntil(() => received.find((item) => item.json?.event === 'chat:start'));
    assert.equal(delivery.json.chatId, session.conversation.id);
    assert.equal(delivery.json.visitor.name, 'Webhook Wendy');
    assert.equal(delivery.json.property.id, 'sparrow-demo');
    assert.equal(delivery.json.message.text, 'First message triggers the webhook');
    assert.equal(delivery.headers['x-sparrow-event'], 'chat:start');
    assert.ok(delivery.headers['x-sparrow-event-id']);

    const expected = createHmac('sha256', webhook.secret).update(delivery.body).digest('hex');
    assert.equal(delivery.headers['x-sparrow-signature'], expected);

    const ended = await server.request(`/api/conversations/${session.conversation.id}/end`, {
      method: 'POST',
    });
    assert.equal(ended.status, 200);
    await waitUntil(() => received.find((item) => item.json?.event === 'chat:end'));
    const transcript = await waitUntil(() => received.find((item) => item.json?.event === 'chat:transcript_created'));
    assert.ok(transcript.json.chat.messages.length >= 1);
    assert.equal(transcript.json.chat.messages[0].sender.t, 'v');

    socket.close();
  });

  it('emits ticket:create for offline messages', async () => {
    const response = await server.request('/api/v1/offline-form', {
      method: 'POST',
      body: {
        propertyId: 'sparrow-demo', name: 'Ticket Tina',
        email: 'tina@example.com', message: 'My order never arrived.',
      },
    });
    assert.equal(response.status, 200);
    const delivery = await waitUntil(() => received.find((item) => item.json?.event === 'ticket:create'));
    assert.equal(delivery.json.requester.email, 'tina@example.com');
    assert.match(delivery.json.ticket.message, /never arrived/);
  });

  it('lists and deletes endpoints and exposes delivery history', async () => {
    const listed = await server.request('/api/webhooks');
    assert.equal(listed.status, 200);
    assert.ok(listed.payload.data.webhooks.some((hook) => hook.id === webhook.id));

    const deliveries = await server.request('/api/webhooks/deliveries');
    assert.equal(deliveries.status, 200);
    assert.ok(deliveries.payload.data.deliveries.some((item) => item.status === 'delivered'));

    const removed = await server.request(`/api/webhooks/${webhook.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const after = await server.request('/api/webhooks');
    assert.ok(!after.payload.data.webhooks.some((hook) => hook.id === webhook.id));
  });
});
