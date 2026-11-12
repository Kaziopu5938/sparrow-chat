# Captured tawk.to evidence

All artifacts here were captured on **2026-11-11** from public production surfaces. The
analysis and conclusions are written up in [`../docs/EVIDENCE.md`](../docs/EVIDENCE.md).

| File | What it is |
| --- | --- |
| `widget/loader.js` | The 1,158-byte property-scoped loader at `https://embed.tawk.to/521727297ca1334016000005/18nms7gql` |
| `widget/twk-main.js` | The main ES module (`.../6af164091d5/js/twk-main.js`, 329,547 bytes) |
| `widget/twk-main.pretty.js` | Prettified copy used for line citations in the report |
| `tawk-widget-settings.json` | Live `GET https://va.tawk.to/v1/widget-settings` response |
| `network-capture.json` | Network trace summary: loader, config, session endpoint, chunk graph, language files |
| `rea-summary.json` | REA static-analysis summary for the widget tree |
| `widget-evidence.json.gz` | Full REA evidence bundle, gzip-compressed (82 MB raw → 13.5 MB) |
| `tawk-home.html`, `help-home.html`, `jsapi.html`, `webhooks.html` | Saved public pages used for the report |

## Reproducing the widget capture

From this directory:

```bash
node fetch-assets.mjs
npx --yes prettier@3 --parser babel widget/twk-main.js > widget/twk-main.pretty.js
```

`fetch-assets.mjs` downloads the loader and main module with browser-like headers; the
chunk list in `network-capture.json` came from the browser's
`PerformanceResourceTiming` entries rather than from parsing the minified bundle.

REA analysis (run from the project root):

```bash
npx -y rea-agents@latest analyze-javascript-application research/widget \
  --detail summary --evidence_output research/widget-evidence.json \
  > research/rea-summary.json
```

The complete evidence bundle was then gzip-compressed to
`research/widget-evidence.json.gz`.

## Scope and ethics

- Public, unauthenticated surfaces only.
- No accounts created, no dashboard API probing, no chat messages sent to tawk.to.
- The tawk.to widget automatically registered an anonymous session when its public
  marketing page was opened; nothing beyond that was initiated.
- No tawk.to code or assets are included in Sparrow Chat. The captures exist as evidence,
  and the implementation is original.
