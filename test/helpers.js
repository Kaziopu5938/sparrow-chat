import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../server/index.js';

export async function startServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-test-'));
  const app = createServer({ dataDir, tokenSecret: 'test-secret', seedDemo: true, ...overrides });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;

  async function request(pathname, { method = 'GET', body } = {}) {
    const response = await fetch(base + pathname, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload, headers: response.headers };
  }

  async function startSession(visitor = { name: 'Test Visitor', email: 'visitor@example.com' }) {
    const response = await request('/api/v1/session/start', {
      method: 'POST',
      body: { propertyId: 'sparrow-demo', url: 'https://shop.example.com/item', visitor },
    });
    return response.payload.data;
  }

  async function close() {
    await app.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  return { ...app, base, request, startSession, close, dataDir };
}

export function openSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.__inbox = [];
    socket.on('message', (raw) => {
      try { socket.__inbox.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    const timer = setTimeout(() => reject(new Error(`socket timeout: ${url}`)), 4000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function waitFor(socket, predicate, timeout = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const index = socket.__inbox.findIndex(predicate);
    if (index !== -1) return socket.__inbox.splice(index, 1)[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for socket message; inbox: ${JSON.stringify(socket.__inbox)}`);
}

export async function waitUntil(fn, { timeout = 5000, interval = 50 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('condition not met before timeout');
}
