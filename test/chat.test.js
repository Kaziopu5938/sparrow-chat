import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { openSocket, startServer, waitFor } from './helpers.js';

describe('realtime chat', () => {
  let server;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });

  it('delivers visitor messages to the agent and agent replies to the visitor', async () => {
    const session = await server.startSession({ name: 'Realtime Rita', email: 'rita@example.com' });
    const visitorSocket = await openSocket(server.base.replace('http', 'ws') + session.socketPath);
    const visitorReady = await waitFor(visitorSocket, (data) => data.type === 'ready');
    assert.equal(visitorReady.conversationId, session.conversation.id);

    const agentSocket = await openSocket(`${server.base.replace('http', 'ws')}/ws/agent`);
    await waitFor(agentSocket, (data) => data.type === 'ready');

    const agentGetsMessage = waitFor(agentSocket, (data) =>
      data.type === 'message' && data.message.sender_type === 'visitor' && data.message.body === 'Hello from Rita');
    const visitorEcho = waitFor(visitorSocket, (data) =>
      data.type === 'message' && data.message.body === 'Hello from Rita');
    visitorSocket.send(JSON.stringify({ type: 'message', body: 'Hello from Rita', clientId: 'abc' }));
    const [toAgent, echo] = await Promise.all([agentGetsMessage, visitorEcho]);
    assert.equal(toAgent.message.conversation_id, session.conversation.id);
    assert.equal(echo.clientId, 'abc');

    const reply = await server.request(`/api/conversations/${session.conversation.id}/messages`, {
      method: 'POST',
      body: { body: 'Hi Rita, happy to help.' },
    });
    assert.equal(reply.status, 200);

    const visitorGetsReply = await waitFor(visitorSocket, (data) =>
      data.type === 'message' && data.message.sender_type === 'agent' && data.message.body === 'Hi Rita, happy to help.');
    assert.equal(visitorGetsReply.message.conversation_id, session.conversation.id);

    const contact = await server.request(`/api/conversations/${session.conversation.id}`);
    assert.equal(contact.payload.data.conversation.visitor_name, 'Realtime Rita');
    assert.ok(contact.payload.data.conversation.messages.length >= 2);

    visitorSocket.close();
    agentSocket.close();
  });

  it('relays typing indicators and read receipts', async () => {
    const session = await server.startSession({ name: 'Typing Tom' });
    const visitorSocket = await openSocket(server.base.replace('http', 'ws') + session.socketPath);
    await waitFor(visitorSocket, (data) => data.type === 'ready');
    const agentSocket = await openSocket(`${server.base.replace('http', 'ws')}/ws/agent`);
    await waitFor(agentSocket, (data) => data.type === 'ready');

    const typing = waitFor(agentSocket, (data) =>
      data.type === 'typing' && data.conversationId === session.conversation.id && data.isTyping === true);
    visitorSocket.send(JSON.stringify({ type: 'typing', isTyping: true }));
    await typing;

    const seen = waitFor(visitorSocket, (data) => data.type === 'seen');
    const read = await server.request(`/api/conversations/${session.conversation.id}/read`, {
      method: 'POST',
    });
    assert.equal(read.status, 200);
    await seen;

    const rating = waitFor(agentSocket, (data) =>
      data.type === 'rating' && data.conversationId === session.conversation.id);
    visitorSocket.send(JSON.stringify({ type: 'rating', value: 1 }));
    const rated = await rating;
    assert.equal(rated.value, 1);

    const conversation = await server.request(`/api/conversations/${session.conversation.id}`);
    assert.equal(conversation.payload.data.conversation.rating, 1);

    visitorSocket.close();
    agentSocket.close();
  });

  it('ends a conversation and notifies both sides', async () => {
    const session = await server.startSession({ name: 'Ending Ed' });
    const visitorSocket = await openSocket(server.base.replace('http', 'ws') + session.socketPath);
    await waitFor(visitorSocket, (data) => data.type === 'ready');
    const agentSocket = await openSocket(`${server.base.replace('http', 'ws')}/ws/agent`);
    await waitFor(agentSocket, (data) => data.type === 'ready');

    const endedVisitor = waitFor(visitorSocket, (data) => data.type === 'conversation:ended');
    const endedAgent = waitFor(agentSocket, (data) =>
      data.type === 'conversation:ended' && data.conversationId === session.conversation.id);
    const result = await server.request(`/api/conversations/${session.conversation.id}/end`, {
      method: 'POST',
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.data.conversation.status, 'closed');
    await Promise.all([endedVisitor, endedAgent]);

    const closed = await server.request(`/api/conversations/${session.conversation.id}/messages`, {
      method: 'POST', body: { body: 'too late' },
    });
    assert.equal(closed.status, 409);

    visitorSocket.close();
    agentSocket.close();
  });

  it('rejects visitor sockets with an invalid session token', async () => {
    const closed = new Promise((resolve, reject) => {
      const socket = new WebSocket(`${server.base.replace('http', 'ws')}/ws/visitor?propertyId=sparrow-demo&sessionKey=x&token=y`);
      const timer = setTimeout(() => reject(new Error('socket not closed')), 3000);
      socket.on('close', (code) => { clearTimeout(timer); resolve(code); });
      socket.on('error', () => {});
    });
    assert.equal(await closed, 4001);
  });

  it('rejects cross-origin agent sockets without blocking the direct dashboard', async () => {
    const closeCode = (options) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`${server.base.replace('http', 'ws')}/ws/agent`, options);
      const timer = setTimeout(() => reject(new Error('socket not closed')), 3000);
      socket.on('close', (code) => { clearTimeout(timer); resolve(code); });
      socket.on('error', () => {});
    });

    assert.equal(await closeCode({ headers: { origin: 'https://evil.example' } }), 4003);

    const sameOrigin = await openSocket(`${server.base.replace('http', 'ws')}/ws/agent`, {
      headers: { origin: server.base },
    });
    await waitFor(sameOrigin, (data) => data.type === 'ready');
    sameOrigin.close();
  });
});
