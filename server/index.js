import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApi } from './api.js';
import { initSecret } from './auth.js';
import { loadConfig, PUBLIC_DIR } from './config.js';
import { openDb } from './db.js';
import { createRealtime } from './realtime.js';
import { getProperty, getSettings } from './store.js';
import { createWebhookService } from './webhooks.js';

export function createServer(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDb(config.dataDir, { seed: config.seedDemo });
  const secret = initSecret(config.dataDir, config.tokenSecret);
  const webhooks = createWebhookService({ db });
  const adminHost = String(config.adminHost || '').toLowerCase();
  const realtime = createRealtime({ db, secret, webhooks, adminHost });
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Keep the dashboard and agent APIs off the public widget hostname.
  if (adminHost) {
    app.use((req, res, next) => {
      const host = String(req.headers.host || '').split(':')[0].toLowerCase();
      const adminPath = req.path.startsWith('/dashboard')
        || req.path.startsWith('/api/auth')
        || req.path.startsWith('/api/conversations')
        || req.path.startsWith('/api/agents')
        || req.path.startsWith('/api/settings')
        || req.path.startsWith('/api/webhooks')
        || req.path.startsWith('/api/tickets')
        || req.path.startsWith('/api/export')
        || req.path === '/api/stats';
      if (adminPath && host !== adminHost) return res.status(404).type('text').send('Not found');
      next();
    });
  }

  // Public widget endpoints must be callable from any customer origin.
  app.use('/api/v1', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use('/api', createApi({ db, secret, webhooks, realtime }));

  app.get('/embed/:propertyId', (req, res) => {
    const property = getProperty(db, req.params.propertyId);
    if (!property) return res.status(404).type('application/javascript').send('/* unknown property */');
    const settings = getSettings(db, property.id);
    const origin = `${req.protocol}://${req.get('host')}`;
    const loader = `(function(global){
  global.$_Sparrow_AccountKey = ${JSON.stringify(property.id)};
  global.$_Sparrow_WidgetId = ${JSON.stringify(settings.widgetId || 'default')};
  global.$_Sparrow_Server = ${JSON.stringify(origin)};
  global.$_Sparrow = global.$_Sparrow || {};
  if (global.$_Sparrow.init) return;
  global.$_Sparrow.init = true;
  global.Sparrow_API = global.Sparrow_API || {};
  global.__sparrowQueue = global.__sparrowQueue || [];
  ['maximize','minimize','toggle','showWidget','hideWidget','toggleVisibility','getStatus',
   'isChatMaximized','isChatHidden','isChatOngoing','isVisitorEngaged','endChat','setAttributes',
   'addEvent','setChatInputMessage','popup'].forEach(function (name) {
    if (typeof global.Sparrow_API[name] === 'function') return;
    global.Sparrow_API[name] = function () {
      global.__sparrowQueue.push([name, Array.prototype.slice.call(arguments)]);
    };
  });
  var script = document.createElement('script');
  script.type = 'module';
  script.src = ${JSON.stringify(`${origin}/widget/sparrow-widget.js?v=4`)};
  script.async = true;
  document.head.appendChild(script);
})(window);
`;
    res.type('application/javascript').setHeader('cache-control', 'no-cache');
    res.send(loader);
  });

  app.use('/widget', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  }, express.static(path.join(PUBLIC_DIR, 'widget'), { maxAge: 0 }));
  app.use('/dashboard', express.static(path.join(PUBLIC_DIR, 'dashboard'), { maxAge: 0 }));
  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));
  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'demo.html')));
  app.get('/demo', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'demo.html')));
  app.get('/dashboard/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'index.html')));

  app.use((error, req, res, next) => {
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: 'INVALID_JSON' });
    }
    console.error('[server]', error);
    res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  });

  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    if (!realtime.handleUpgrade(req, socket, head)) socket.destroy();
  });

  function close() {
    return new Promise((resolve) => {
      realtime.close();
      webhooks.stop();
      server.close(() => {
        try { db.close(); } catch {}
        resolve();
      });
      setTimeout(resolve, 1500).unref?.();
    });
  }

  return { app, server, db, realtime, webhooks, config, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, config } = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`Sparrow Chat running at http://${config.host}:${config.port}`);
    console.log(`  Demo site:   http://${config.host}:${config.port}/demo`);
    console.log(`  Agent inbox: http://${config.host}:${config.port}/dashboard/ (opens directly)`);
  });
}
