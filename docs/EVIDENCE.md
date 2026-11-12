# How tawk.to works — evidence log

Captured on **2026-11-11** from the public production surfaces of tawk.to. No authenticated
areas were accessed, no accounts were created, and no traffic was modified. The goal was to
understand the architecture and client protocol well enough to build an independent clone
(`Sparrow Chat`) with the same shape and none of the same code.

Artifacts referenced below live in [`research/`](../research/).

---

## 1. Product surfaces observed

| Surface | URL | What it is | Evidence |
| --- | --- | --- | --- |
| Marketing site | `https://www.tawk.to/` | Next.js/Turbopack marketing app | `research/tawk-home.html`, network capture shows `_next/static/chunks/turbopack-*.js` |
| Embeddable widget | `https://embed.tawk.to/...` | The actual chat widget loaded on customer pages | `research/widget/loader.js`, `research/widget/twk-main.js` |
| Configuration API | `https://va.tawk.to/v1/widget-settings` | Returns the widget's skin/settings JSON | `research/tawk-widget-settings.json` |
| Session API | `https://va.tawk.to/v1/session/start` | Registers a visitor and opens their session | client code, `twk-main.pretty.js:14764` |
| Agent dashboard | `https://dashboard.tawk.to/login` | Agent inbox; sign-in required | observed redirect to the login page |
| Help center | `https://help.tawk.to/` | Public knowledge base, also runs the widget | tawk links under property `521727297ca1334016000005` |

The marketing site itself dogfoods the widget: its live instance exposed property
`521727297ca1334016000005`, widget `18nms7gql`, and the full session lifecycle below.

---

## 2. The embed: one script tag, one ES module

A customer installs a snippet whose shape is:

```html
<script type="text/javascript">
var Tawk_API=Tawk_API||{}, Tawk_LoadStart=new Date();
(function(){
  var s1=document.createElement("script"),s0=document.getElementsByTagName("script")[0];
  s1.async=true;
  s1.src='https://embed.tawk.to/<PROPERTY_ID>/<WIDGET_ID>';
  s1.charset='UTF-8';
  s1.setAttribute('crossorigin','*');
  s0.parentNode.insertBefore(s1,s0);
})();
</script>
```

The property-scoped URL is not the app bundle; it is a small loader. The live response
(`research/widget/loader.js`, 1,158 bytes, SHA-256 prefix `0e6e5ff8a40ddb20`) does this:

```js
global.$_Tawk_AccountKey = '521727297ca1334016000005';
global.$_Tawk_WidgetId    = '18nms7gql';
global.$_Tawk_Unstable    = true;
global.$_Tawk = global.$_Tawk || {};
// ... on load, inject:
s1.src = 'https://embed.tawk.to/_s/v4/app/6af164091d5/js/twk-main.js';
s1.type = 'module';
s1.setAttribute('crossorigin','anonymous');
```

The loader's own source comments say this is **Vite `output.format: 'es'`** and that the
entry must load as `type="module"` so native `import()` resolves the chunks. That is a
useful architectural fact: the widget is a modern ES-module bundle with a content-hashed
app directory (`/v4/app/<build-id>/`), not a legacy single-file script.

### Bundle and chunk graph

From the live network trace (`research/network-capture.json`):

```
embed.tawk.to/521727297ca1334016000005/18nms7gql          loader (1.1 KB)
embed.tawk.to/_s/v4/app/6af164091d5/js/twk-main.js        main module (329,547 bytes)
  ├─ twk-MinWidget-9V8ZkuBw.js                            collapsed bubble state
  ├─ twk-BubbleWidget-SWFLECQ0.js                         launcher bubble
  ├─ twk-MessagePreview-DO-XLFMx.js                       proactive message preview
  ├─ twk-BrandingWidget-B2Df8pOj.js                       "Powered by tawk.to"
  ├─ twk-iframe-styles-CXt6ZRSO.js                        styles for embedded frame
  ├─ twk-messenger-components.es-CPwW-3VV.js              messenger UI
  └─ twk-message-format-DKJXm_pH.js                       message formatting
languages/en.json, languages/en_dev.json                   runtime i18n
assets/audio/chat_sound.mp3                                notification sound
```

The split tells us the UI is lazy-loaded per surface: minimized bubble, maximized chat,
message preview, branding, and messenger components are separate chunks.

---

## 3. Configuration API — the widget settings document

The client fetches:

```
GET https://va.tawk.to/v1/widget-settings?propertyId=<id>&widgetId=<id>&sv=<version>
```

A live capture is saved at `research/tawk-widget-settings.json` (10,508 bytes). Current
shape (schema version `2-1078-1`):

```json
{
  "ok": true,
  "data": {
    "settingsVersion": "2-1078-1",
    "propertyName": "tawk.to",
    "branding": { "whitelabeled": false, "text": ":tawky: Add free *live chat* to your site", "url": "..." },
    "widget": {
      "type": "inline",
      "version": 918,
      "agentDrivenStatus": true,
      "language": "en",
      "minimized": { "desktop": { "type": "round" }, "mobile": { "type": "round" } },
      "maximized": { "desktop": { "width": 450, "height": 700 } },
      "bubble": { "type": "image", "config": { "image": { "type": "gallery", "content": "168" }, "width": 124, "height": 79 } },
      "theme": { "header": { "background": "#05a84e", "text": "#ffffff" } }
    },
    "voice": { ... }
  }
}
```

Notable: branding, widget presentation, and voice are top-level domains; `settingsVersion`
is sent as the `sv` query parameter so the CDN/API can answer cheaply with `304`/unchanged
responses. `widget.type: "inline"`, 450×700 maximum desktop panel, round minimized bubble,
and a server-driven agent online/offline state (`agentDrivenStatus`).

---

## 4. Session lifecycle

Client code: `twk-main.pretty.js:14673–14736` (register payload) and
`twk-main.pretty.js:14764–14796` (HTTP call).

```
POST https://va.tawk.to/v1/session/start
Optional header: X-Tawk-Token: <stored visitor token>
```

`registerData` fields sent by the widget:

| Field | Meaning |
| --- | --- |
| `p` | property/account id |
| `w` | widget id |
| `platform` | `desktop` or `mobile` |
| `tzo` | browser timezone offset (clamped ±900) |
| `url`, `referrer` | page context |
| `vss` | previous visitor session key, if any |
| `user` | visitor identity when the site passed `Tawk_API.visitor` |
| `consent` | cookie/consent flag |
| `wss` | widget state at registration: `min` or `max` |
| `u`, `uv`, `uw` | visitor UUID + version (+ partial flag) |
| `uik` | idempotency key when no UUID is available |

The client also writes a `TawkConnectionTime` cookie every 100 ms while registering and
uses a 90-second request timeout, retry backoff, and a max retry count
(`twk-main.pretty.js:14738–14835`).

The response populates a client session store with these fields
(`twk-main.pretty.js:9802–9844`):

`sessionKey`, `visitorSocketServer`, `token`, `tokenExpiry`, `pageStatus`,
`pageStatusVersion`, `previousSessionKey`, `departments`, `prechatFormSubmitted`,
`waitTime`, `lastMessageTimestamp`.

`visitorSocketServer` is the host used for the WebSocket, and `token`/`sessionKey` are
passed on every connection. A visitor session is therefore **server-issued**, not
self-generated.

---

## 5. Real-time protocol

Connection setup — `twk-main.pretty.js:11729–11754`:

```js
this.io = new window.$__TawkSocket(`wss://${G().visitorSocketServer}/`, {
  transports: ['websocket'],
  engineIo: window.$__TawkEngine,
  path: '/s',
  query: {
    k:    G().sessionKey,
    cver: Z().chat.version,
    pop:  z().isWindowed,
    asver:G().pageStatusVersion,
    tkn:  G().token,
  },
});
```

So: **raw WebSocket transport, Engine.IO-style handshake, path `/s`**, with the session
key (`k`), chat/schema version (`cver`), popup state (`pop`), page-status version (`asver`),
and visitor token (`tkn`) in the query string. It uses bundled `$__TawkSocket` /
`$__TawkEngine` implementations rather than depending on a page-global `io`.

### Server → client events observed in the client (`twk-main.pretty.js:11779–11902`)

| Event | Purpose |
| --- | --- |
| `ready` | handshake complete; returns self origin, conversation, page status |
| `visitorMessage` | incoming agent/visitor message |
| `visitorConversationPresenceUpdate` | presence/typing-style conversation update |
| `visitorChatSeen` | read receipt |
| `visitorChatDismiss` | dismiss message preview |
| `visitorTagsUpdate` | tags changed |
| `visitorDataUpdate` | visitor identity/attributes/department/prechat |
| `visitorSound` | sound preference changed |
| `visitorPopupFocus` | popup focus state |
| `visitorChatWindowState` | minimized/maximized state across tabs |
| `chatBubbleClosed` | bubble closed elsewhere |
| `pageStatus` | agent online/offline |
| `pageDisable` | page/widget disabled remotely |
| `agentIsTyping` / `agentStopedTyping` | agent typing indicator |
| `uploadProgress` / `uploadFinished` / `uploadError` | file transfer lifecycle |
| `visitorChatTransfer` | chat transferred between departments/agents |
| `remoteDisconnect` | server-side disconnect (`BANNED` handled specially) |

### Client → server commands

Rather than exposing dozens of REST calls, the socket multiplexes "service" commands.
Examples (`twk-main.pretty.js:11959–12018`):

```js
sendChatMessage(data)     → io.send('service','visitor-chat','/v1/message/visitor', data)
notifyOfflineMessage(data)→ io.send('service','visitor-chat','/v1/visitor/offline-form', data)
visitorChatSeen(data)     → io.send('service','visitor-chat','/v1/visitor/messages-seen', data)
notifyPrechat(data)       → io.send('service','visitor-chat','/v1/visitor/prechat-form', data)
notifyNameChange(data)    → io.send('saveNameChangeForm', data)
notifyEmailTranscript(data)→ io.send('saveTranscriptEmailForm', data)
endVisitorChat(data)      → io.send('endChat', data)
addEvent / setAttributes / addTags / removeTags / fileUploadMessage
```

Commands issued before the socket is ready are queued and flushed on `ready`
(`twk-main.pretty.js:11907–11935`). This is why the JS API can be called immediately after
the snippet, even before the network round-trips finish.

---

## 6. Agent-facing and integration surfaces

### Dashboard

`dashboard.tawk.to/login` is a separate authenticated app. I deliberately did **not**
reverse-engineer its internal APIs or attempt to authenticate. Evidence is limited to the
public login surface; the clone's dashboard is therefore an original implementation.

### Webhooks (`developer.tawk.to/webhooks`)

Public documentation states:

- Configure one or more HTTPS endpoints in the dashboard; use `webhook.site` for testing.
- Events: `chat:start`, `chat:end`, `chat:transcript_created`, `ticket:create` — only these
  four are supported.
- Signing: an `X-Tawk-Signature` header containing a SHA-1 HMAC of the request body.
- Delivery: if a 2xx is not returned, retry for up to 12 hours, max 3 retries.
- `chat:transcript_created` includes the full message array with sender type `v` (visitor),
  `a` (agent), `s` (system).
- `ticket:create` covers offline forms; `chat:end` carries chat and visitor identity.

Captured pages: `research/webhooks.html`.

### JavaScript API (`developer.tawk.to/jsapi`)

Documented surface includes lifecycle callbacks (`onLoad`, `onChatMaximized`,
`onChatMinimized`, `onChatStarted`, `onChatEnded`, `onMessageSend`,
`onChatMessageVisitor`, `onChatMessageAgent`, `onAgentTyping`, `onStatusChange`,
`onTagsUpdated`, `onUnreadCountChanged`, `onPrechatSubmit`, `onOfflineSubmit`,
`onTranscriptEmail`), control methods (`maximize`, `minimize`, `toggle`, `showWidget`,
`hideWidget`, `getStatus`, `endChat`), visitor data (`visitor`, `setAttributes`,
`addEvent`, `addTags`, `removeTags`), and `Tawk_API.ready`/queued invocation semantics.
Captured page: `research/jsapi.html`.

The command names found in the bundle match this API one-for-one, confirming the docs are
a thin façade over the socket commands above.

---

## 7. Inferred data model

From the fields, events, and payloads observed:

```
Property / account (account key, plan, settings)
  └── Widget (skin, position, theme, schedule, departments)
  └── Agent (identity, status, role)
  └── Visitor (uuid, session key, page url, referrer, timezone, attributes, tags)
        └── Conversation / chat (status, department, assigned agent, rating, timestamps)
              └── Message (sender type, text, attachments, seen state, timestamp)
              └── Event (navigation, rating, transfer, tags, custom events)
  └── Offline ticket (name, email, message)
  └── Webhook endpoint (url, secret, enabled events, delivery attempts)
```

The clone uses the same conceptual entities in SQLite; see `server/db.js`.

---

## 8. REA static analysis

The widget tree (`research/widget/`) was analyzed with the reverse-engineer-anything CLI:

```bash
npx -y rea-agents@latest analyze-javascript-application research/widget \
  --detail summary --evidence_output research/widget-evidence.json \
  > research/rea-summary.json

gzip -9 research/widget-evidence.json   # 82 MB → 13.5 MB
```

Results (`research/rea-summary.json`, view evidence
`ev_baf755425695489aefc95e774065759df193b55345302e871669854d138e48f0`):

| Metric | Value |
| --- | --- |
| Files examined | 3 |
| Bytes read | 897,277 |
| Parsed JS files | 3 (0 failures) |
| AST nodes visited | 209,756 |
| Findings | 428 |
| Static modules resolved | 0 (minified, dynamic-import-heavy bundle) |
| Semantic coverage | partial (6,456 dynamic-call unknowns; 706 dynamic-property unknowns) |
| Analysis status | `partial`, artifact authority `shipped-artifact` |

The analyzer confirms the artifact is valid, fully parseable JavaScript and that the
interesting behavior is concentrated in dynamic dispatch (the socket command multiplexer
and chunk loader). That is exactly where manual reading of the prettified bundle was
required; REA was used to validate structure, not to pretend the minified dynamic code
could be fully recovered automatically.

The full 82 MB evidence bundle is compressed at `research/widget-evidence.json.gz`
(13.5 MB). The raw bundle was deleted after compression; the summary and captured source
artifacts remain.

Artifact digests:

| File | Bytes | SHA-256 prefix |
| --- | --- | --- |
| `research/widget/loader.js` | 1,158 | `0e6e5ff8a40ddb20` |
| `research/widget/twk-main.js` | 329,547 | `76e72817dd5cae07` |
| `research/tawk-widget-settings.json` | 10,508 | `6fe9327f563ada9b` |
| `research/widget/twk-main.pretty.js` | 566,572 | `698538d11601e5d6` |

---

## 9. What Sparrow Chat copies, and what it changes

| Concern | tawk.to (observed) | Sparrow Chat (implemented) |
| --- | --- | --- |
| Embed | `<script src="https://embed.tawk.to/{property}/{widget}">` loader → ES module | `<script src="/embed/{propertyId}">` loader → ES module |
| Widget isolation | dedicated widget bundle/iframe styles | Shadow DOM (no iframe), scoped CSS |
| Config | `GET va.tawk.to/v1/widget-settings`, versioned `sv` | `GET /api/v1/widget-settings?propertyId=...` |
| Session | `POST /v1/session/start`, server-issued session key + token | `POST /api/v1/session/start`, same shape |
| Transport | WebSocket, Engine.IO-style, path `/s`, token in query | WebSocket, path `/ws/visitor`, token in query |
| Commands | `service` channel multiplexing to `/v1/...` paths | typed JSON events over one WebSocket |
| Events | `visitorMessage`, `agentIsTyping`, `visitorChatSeen`, … | `message`, `typing`, `seen`, `conversation:update`, … |
| Dashboard | separate authenticated app | same-origin app, **no sign-in** (default agent) |
| Persistence | proprietary backend | SQLite (`node:sqlite`) |
| Webhooks | SHA-1 signature, 12h retry window, 4 events | HMAC-SHA256, exponential backoff, same 4 events |
| JS API | queued before ready, callbacks + control methods | queued before ready, same control/data surface |

### Deliberate differences

1. **No authentication wall.** The dashboard is single-workspace and always acts as the
   default agent, per the product requirement. This is documented as a deployment
   assumption, not a security feature.
2. **No copy of tawk.to code or assets.** All HTML/CSS/JS/server code here is original.
   The evidence was used for architecture and protocol understanding only.
3. **Typed JSON WebSocket messages** instead of the Engine.IO-style `service` envelope.
4. **SQLite** instead of a proprietary backend, so the project runs with zero external
   services.

---

## 10. Evidence limitations

- The WSS frames themselves were not captured; the protocol is reconstructed from the
  shipped client code and its event/command handlers. That is strong evidence of the
  client contract, but not a byte-level capture of server frames.
- The agent dashboard API was not inspected; it requires authentication and probing it was
  out of scope.
- The minified bundle can change at any deploy (`6af164091d5` is the captured build id).
  Hash/digest values above pin the exact artifacts used.
- The marketing site's widget configuration is a live third-party tenant. No chat messages
  were sent to tawk.to; loading the marketing page caused the widget to perform its normal
  anonymous session registration.
