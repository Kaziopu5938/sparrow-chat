# Sparrow Chat

A self-hosted live chat and customer messaging suite — embeddable widget, real-time agent
inbox, offline tickets, and signed webhooks. Built as an independent implementation after
reverse-engineering how tawk.to works; see [`docs/EVIDENCE.md`](docs/EVIDENCE.md).

```
┌──────────────────────┐        WebSocket         ┌──────────────────────┐
│  Visitor's website   │  ─────────────────────►  │  Sparrow server      │
│  <script src="/embed"│  ◄─────────────────────  │  Express + ws        │
│  Shadow-DOM widget   │        JSON events       │  SQLite              │
└──────────────────────┘                          └──────────┬───────────┘
                                                             │
                                              ┌──────────────┴───────────┐
                                              │  Agent inbox (direct)    │
                                              │  /dashboard/  no sign-in │
                                              └──────────────────────────┘
```

## Features

**Visitor widget**

- One script tag, zero build step, rendered in a Shadow DOM (host CSS cannot leak in or out)
- Launcher bubble, unread badge, mobile layout, light theme driven by workspace branding
- Home screen with greeting, FAQ, and "start a conversation"; optional pre-chat form
- Real-time messages, typing indicator, read receipts, rating, transcript download
- Offline mode with an email/offline form that creates a ticket
- Queueing JavaScript API (`Sparrow_API.*`) that works before the socket is ready
- Session restore from `localStorage`, reconnect with backoff

**Agent inbox**

- Opens directly as the workspace's default agent — no sign-up, sign-in, or password
- Live conversation list, unread counts, search, open/closed/all filters
- Thread view with visitor typing indicator, quick replies, Enter-to-send
- Visitor panel: page URL, location, custom attributes, tags, activity timeline
- End chat, export CSV, satisfaction ratings, workspace stats
- Settings: branding, position, greeting, pre-chat/offline behavior, ratings
- Webhook endpoint management with signed deliveries and retry history

**Platform**

- Single Node process: Express REST API + `ws` realtime + static widget/dashboard
- SQLite via Node's built-in `node:sqlite` (no native dependencies)
- Visitor session keys/tokens (HMAC-signed), message persistence, webhooks with retries
- Integration tests for API, realtime, and webhook signature/retry behavior

## Quick start

Requires Node **22.5+** (uses `node:sqlite`).

```bash
npm install
npm start
```

Open:

| URL | What |
| --- | --- |
| `http://127.0.0.1:4870/demo` | Demo storefront with the live widget |
| `http://127.0.0.1:4870/dashboard/` | Agent inbox — opens directly |
| `http://127.0.0.1:4870/embed/sparrow-demo` | The embed loader served for the demo property |

Try it: open the demo, send a message in the bubble, then watch it appear in the inbox in
real time and reply. The widget and dashboard use the same server, so this works locally
with no configuration.

Reset the demo database at any time:

```bash
rm -rf data          # macOS/Linux
Remove-Item data -Recurse -Force   # Windows PowerShell
```

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4870` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose) |
| `SPARROW_DATA_DIR` | `./data` | SQLite + generated secret directory |
| `SPARROW_SECRET` | generated | HMAC secret for visitor tokens |
| `SPARROW_SEED` | `1` | Set to `0` to start with an empty database |
| `SPARROW_PUBLIC_URL` | `http://localhost:4870` | Public base URL |

The seeded workspace is `Sparrow Demo Store` (`sparrow-demo`) with one agent, Alex Rivers.

## No authentication (by design)

This build is **single-workspace and trusts the local dashboard**. Every request to an
agent endpoint is resolved to the workspace's default agent, and the agent WebSocket does
the same. There is no sign-up, sign-in, password, or session cookie for human users.

That is the requested behavior, not an oversight. It assumes the dashboard is only
reachable by trusted people (localhost, a private network, or behind your own auth proxy).
The agent WebSocket still rejects cross-origin browser connections, so a random website
cannot attach to the inbox socket.

If you expose the dashboard publicly, put it behind your own auth layer or keep it on a
private network. `SPARROW_ADMIN_HOST` can also confine dashboard and agent routes to a
separate admin hostname, leaving only the widget endpoints on the public host. Visitor
identities are still protected by server-issued session keys and HMAC tokens; those are
unrelated to dashboard access.

## Project layout

```
server/
  index.js      Express app, embed loader, static files, HTTP/WS upgrade, shutdown
  api.js        REST API (widget, session, inbox, settings, webhooks, export)
  realtime.js   WebSocket hub: visitor + agent sockets, typing/read/end, presence
  store.js      SQLite queries and domain operations
  db.js         schema, demo seed
  auth.js       HMAC visitor tokens + persistent secret
  webhooks.js   signed delivery queue with exponential backoff
  config.js     defaults and environment config
public/
  widget/       Shadow-DOM widget bundle (plain ES module, no build)
  dashboard/    Inbox UI (plain ES modules, no framework)
  demo.html     Pine & Loom demo storefront
test/           node:test integration tests
research/       Captured tawk.to evidence (loader, bundle, settings, REA output)
docs/EVIDENCE.md  Reverse-engineering report
```

## How it works

### 1. Embed

```html
<script>
  window.Sparrow_API = window.Sparrow_API || {};
  (function () {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://chat.example.com/embed/sparrow-demo';
    document.body.appendChild(s);
  })();
</script>
```

`/embed/:propertyId` returns a property-scoped loader that sets
`window.$_Sparrow_AccountKey`, `window.$_Sparrow_WidgetId`, and `window.$_Sparrow_Server`,
then injects the widget module from the Sparrow server. Because the server origin is passed
explicitly, the widget works when embedded on **any** customer domain; the public
`/api/v1/*` routes and `/widget/*` assets send `Access-Control-Allow-Origin: *`.

### 2. Session

The widget calls:

```
POST /api/v1/session/start
{
  "propertyId": "sparrow-demo",
  "sessionKey": "<stored, optional>",
  "url": "https://shop.example.com/item",
  "referrer": "https://google.com/",
  "visitor": { "name": "Ada", "email": "ada@example.com", "attributes": { "plan": "pro" } }
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "sessionKey": "…",
    "token": "…",
    "visitor": { "id": "…", "name": "Ada", "email": "ada@example.com", "attributes": {} },
    "conversation": { "id": "…", "status": "open", "startedAt": "…" },
    "pageStatus": "online",
    "socketPath": "/ws/visitor?propertyId=…&sessionKey=…&token=…",
    "messages": []
  }
}
```

The socket path is signed per property/session; the server verifies it on upgrade.

### 3. Realtime

`/ws/visitor` and `/ws/agent` use JSON frames. Visitor messages are persisted first, then
broadcast to every tab in the conversation and every agent socket in the property.

Server → client: `ready`, `message`, `typing`, `seen`, `presence`, `conversation:update`,
`conversation:ended`, `rating`, `visitor:update`, `visitor:event`, `ticket:create`.
Client → server: `message`, `typing`, `seen`, `rating`, `attributes`, `event`, `end`,
`status`, `ping`.

### 4. Inbox

The dashboard is a static SPA at `/dashboard/`. It loads `/api/auth/me` (which resolves the
default agent), lists conversations, subscribes to `/ws/agent`, marks conversations read,
posts replies, manages tags, and edits settings. No login screen exists.

## API summary

Public:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/v1/widget-settings` | Widget settings by property/widget |
| `POST` | `/api/v1/session/start` | Create/resume visitor session |
| `GET` | `/api/v1/conversation/:id` | Visitor conversation (token-gated) |
| `POST` | `/api/v1/conversation/:id/rating` | Visitor rating |
| `GET` | `/api/v1/transcript/:id` | Plain-text transcript (token-gated) |
| `POST` | `/api/v1/offline-form` | Offline ticket |

Agent (direct, no auth wall):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/me` | Current (default) agent + property |
| `GET` | `/api/conversations?status=&q=` | Inbox list + stats |
| `GET` | `/api/conversations/:id` | Conversation + messages/events |
| `POST` | `/api/conversations/:id/messages` | Reply |
| `POST` | `/api/conversations/:id/read` | Mark read |
| `POST` | `/api/conversations/:id/end` | End chat |
| `POST` | `/api/conversations/:id/tags` | Add/remove tags |
| `GET` | `/api/stats` | Workspace stats |
| `GET/PUT` | `/api/settings` | Read/update widget settings |
| `GET/POST/DELETE` | `/api/webhooks` | Manage endpoints |
| `GET` | `/api/webhooks/deliveries` | Delivery history |
| `GET` | `/api/tickets` | Offline tickets |
| `GET` | `/api/export/:id` | Conversation CSV |

## Widget JavaScript API

```js
Sparrow_API.maximize();
Sparrow_API.minimize();
Sparrow_API.toggle();
Sparrow_API.showWidget();
Sparrow_API.hideWidget();
Sparrow_API.getStatus();          // 'online' | 'offline'
Sparrow_API.isChatMaximized();
Sparrow_API.isChatHidden();
Sparrow_API.endChat();

Sparrow_API.setAttributes(
  { name: 'Ada Lovelace', email: 'ada@example.com', plan: 'pro' },
  (error) => console.log(error || 'saved')
);
Sparrow_API.addEvent('viewed-pricing', { sku: 'oak-desk' });
Sparrow_API.setChatInputMessage('I have a question about…');

Sparrow_API.onLoad = () => {};
Sparrow_API.onChatMaximized = () => {};
Sparrow_API.onChatMinimized = () => {};
Sparrow_API.onChatMessageAgent = (text) => {};
Sparrow_API.onChatMessageVisitor = (text) => {};
Sparrow_API.onStatusChange = (status) => {};
```

Calls made before the widget finishes loading are queued and replayed.

## Webhooks

Add an endpoint in **Dashboard → Settings → Webhooks**. Each delivery includes:

| Header | Value |
| --- | --- |
| `X-Sparrow-Event` | `chat:start`, `chat:end`, `chat:transcript_created`, `ticket:create` |
| `X-Sparrow-Event-Id` | Delivery id |
| `X-Sparrow-Signature` | `HMAC-SHA256(raw_body, secret)` hex |

Retries start at 15 seconds and double up to 8 minutes, for 6 attempts total. A receiver
must return a 2xx to acknowledge. Example verification:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
const received = req.headers['x-sparrow-signature'];
const valid = expected.length === received.length &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(received));
```

Payloads:

```json
// chat:start
{ "event": "chat:start", "chatId": "…", "visitor": { "name": "Ada", "email": "…" },
  "property": { "id": "sparrow-demo" }, "message": { "text": "Hi" } }

// chat:transcript_created
{ "event": "chat:transcript_created",
  "chat": { "id": "…", "messages": [{ "sender": { "t": "v" }, "msg": "Hi" }] } }
```

## Tests

```bash
npm test
```

Covers: widget settings/loader, visitor sessions, direct dashboard access, inbox listing,
search/tags/end/CSV, settings updates, offline tickets, realtime delivery in both directions,
typing/read/rating, closed-conversation enforcement, invalid visitor tokens, webhook
signatures, retries/delivery history, and endpoint deletion.

## Deployment notes

- Persist the `data/` directory (SQLite database + generated HMAC secret).
- Set `SPARROW_SECRET` explicitly in production if you run multiple instances.
- Terminate TLS in front of the app and set `SPARROW_PUBLIC_URL` / `HOST` accordingly.
- Put the dashboard behind authentication if it is publicly reachable.
- Swap SQLite for Postgres if you need multi-instance writes; the domain layer is isolated
  in `server/store.js`.

## Evidence

The full reverse-engineering report — live endpoints, loader, session payload, WebSocket
event list, settings schema, REA analysis, hashes, and limitations — is in
[`docs/EVIDENCE.md`](docs/EVIDENCE.md). Raw captures are under `research/`.
