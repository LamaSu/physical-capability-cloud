# Control Plane — walkthrough-first shell (B1.shell)

A dependency-free, single-directory web shell over the harness capability
surface: first-run guided walkthrough, an Ask box that routes plain words to
capabilities, a federated catalog with trust badges, self-expanding regions
(Activity / Approvals / lens consoles appear only once used), and a
schema-generated detail view (form → run → AG-UI stream) for every
capability. No build step, no framework — five files, relative paths, works
from `file://`, an http server, or an Android WebView.

## Files

| File | Role |
|---|---|
| `index.html` | Markup + all CSS (theme vars, light/dark, mobile-first) |
| `shell.js` | Spine: `CP.bus`, `CP.api` (engine client + AG-UI stream), lenses, regions, Ask routing, header/status |
| `walkthrough.js` | First-run tour (6 steps, skippable, replay via `?`), persists `cp.walkthrough.done` |
| `expand.js` | Self-expanding regions; progressive reveal persisted in `localStorage` (`cp.regions`) |
| `catalog.js` | Federated catalog: starter grid → full registry, source filters, generated detail/run view |

## Engine mount (already live on the dashboard server)

`shell.js` resolves its API base as: `?api=` query param → `localStorage
cp.apiBase` → same-origin (when served over http/https) →
`http://localhost:3457` (file://, WebView). It consumes three endpoints, all
already served by `C:\Users\globa\.claude\lib\dashboard-server.js`:

- `GET /api/health` (line ~1083) — connectivity ping
- `GET /api/capabilities` (line ~1141) — the GenUI registry (~94 capabilities)
- `POST /api/agui/run` (line ~1268) — AG-UI SSE-framed capability dispatch

When no engine is reachable, the shell mounts a **builtin fallback** (5
starter capabilities, header shows `engine: builtin`) so the UI is never
blank — this is the state the verification screenshots below capture.

## B2 hook 1 — serve route: `GET /control` on dashboard-server.js

`index.html` loads its JS via relative `<script src="./shell.js">` tags, so
the route must serve the whole directory, not just the HTML. Model it on the
existing `/viz` branch (line ~1029). Add near the path constants (~line 120):

```js
const controlPlaneDir = path.join(__dirname, 'control-plane');
```

and in the router, after the `/viz` branch (~line 1037):

```js
  } else if (url.pathname === '/control' || url.pathname.startsWith('/control/')) {
    const rel = (url.pathname === '/control' || url.pathname === '/control/')
      ? 'index.html'
      : url.pathname.slice('/control/'.length);
    const file = path.join(controlPlaneDir, path.normalize(rel));
    const types = { '.html': 'text/html', '.js': 'application/javascript',
                    '.css': 'text/css', '.json': 'application/json',
                    '.svg': 'image/svg+xml', '.png': 'image/png' };
    try {
      if (!file.startsWith(controlPlaneDir + path.sep)) throw new Error('traversal');
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(body);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('control-plane asset not found: ' + url.pathname);
    }
```

Served same-origin at `http://localhost:3457/control`, the shell's API base
resolves to `''` (same-origin) and the engine mounts with zero configuration.

## B2 hook 2 — packaging into pcc-agentpack

Copy the five files verbatim into:

```
C:\Users\globa\pcc-agentpack\apps\dashboard\public\control\
```

`apps/dashboard` is a Vite app; everything under `public/` is served
unprocessed at the site root, so the shell lands at `https://<deploy>/control/`
(Vite dev server and Vercel — `vercel.json` is present — both resolve
`/control/` → `/control/index.html`). No build wiring, no imports to add.
Point the shell at a non-same-origin engine with
`https://<deploy>/control/?api=https://<engine-host>` (persisted to
`localStorage cp.apiBase` after first visit).

## B2 hook 3 — Android (Capacitor WebView)

The Android app found during the scout is **not** a repo named
`pcc-android-app`; it is the PCC mobile app inside the worktree:

```
C:\Users\globa\physical-capability-cloud-wt-android\apps\mobile
```

- Branch `feat/android-build-publish`; Capacitor 7; `appId
  network.capability.mobile`, `appName PCC`; native scaffold in
  `apps\mobile\android\`; CI `.github/workflows/android-build.yml` (AAB
  verified green).
- It is a **`server.url` WebView wrapper** (`capacitor.config.ts`): default
  `https://capability.network`, overridable with the `CAP_SERVER_URL` env var
  at `npx cap sync` time.

To point it at the control plane:

- **Prod path**: ship hook 2 (agentpack dashboard deploys behind
  capability.network) then set `CAP_SERVER_URL=https://capability.network/control`.
  No `allowNavigation` change needed — `capability.network` and
  `*.capability.network` are already allowlisted.
- **Dev path**: `CAP_DEV=1 CAP_SERVER_URL=http://10.0.2.2:3457/control npx cap sync android`
  (`10.0.2.2` = emulator loopback to the host's dashboard-server; `CAP_DEV=1`
  enables cleartext http).
- **Any other host** must be added to `server.allowNavigation` in
  `capacitor.config.ts`.
- The shell is WebView-safe by construction: no modules, no build, `https`
  androidScheme OK, and the builtin engine fallback covers the cold-offline
  case alongside Capacitor's `server.errorPath` offline page.

## Zero-install preview

Open `file:///C:/Users/globa/.claude/lib/control-plane/index.html` directly —
API base falls back to `http://localhost:3457` if the dashboard is running,
builtin engine otherwise.

## Verification (2026-07-06)

Rendered in chromium-1217 (Playwright `executablePath` pin — the global
`@playwright/cli` alpha wants uninstalled build 1212; use
`camoufox-mcp-server`'s `playwright-core@1.59.1` with
`C:\Users\globa\AppData\Local\ms-playwright\chromium-1217\chrome-win64\chrome.exe`).
Full first-run flow exercised with zero console/page errors: walkthrough
auto-start → Skip tour → home (Ask + Catalog, 5 builtin starters, "Show all
94 capabilities") → card tap → generated detail view (provenance + Run).
Screenshots:

- `C:\Users\globa\ai\supervisor\artifacts\control-plane-verify\01-walkthrough.png`
- `C:\Users\globa\ai\supervisor\artifacts\control-plane-verify\02-home.png`
- `C:\Users\globa\ai\supervisor\artifacts\control-plane-verify\03-capability.png`
