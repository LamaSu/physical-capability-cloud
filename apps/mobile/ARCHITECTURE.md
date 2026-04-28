# `@pcc/mobile` — Architecture decisions

**Date:** 2026-04-28
**Status:** Week 1 (decision-grade for v1)

## TL;DR

For v1 the Capacitor shell wraps the deployed dashboard PWA via `server.url`
rather than bundling a per-release web build into the binary. This means we
ship updates by deploying the web app, not by submitting a new app-store
binary. App-store binaries change only when the native shell or plugins
change. The dashboard PWA at `/operator/mobile` continues to work in any
browser as a no-app fallback.

## 1. Standalone bundle vs wrap-deployed-PWA

### The two options

| Option | What ships in the IPA/APK | How users get updates |
|---|---|---|
| **A. Standalone bundle** | Full web build (`apps/dashboard/dist`) copied into the IPA/APK at build-time. Capacitor `webDir` points at `dist`, no `server.url`. | New app-store release for every web change. Apple/Google review on every iteration (1-7 days). |
| **B. Wrap deployed PWA (chosen)** | Tiny native shell + a `server.url` pointing at `https://capability.network/operator/mobile`. The web "ships" by deploying the dashboard. | Same as the web — instant. App-store review only when native shell or plugins change. |

### Why option B for v1

1. **Iteration speed.** PCC's web side is iterating multiple times per week
   (CI deploys `:staging` → `:prod` artifact promotion every PR merge per
   `docs/DEPLOY.md`). Forcing every change through Apple review would gate
   the whole substrate on a 1-7 day human cycle, which is prohibitive
   pre-product-market-fit.
2. **Capacitor is friendly to it.** Setting `server.url` is officially
   supported and well-documented. The shell still has access to all native
   plugins (camera, biometrics, push, BLE etc.) — they just call into the
   loaded web page through the JS bridge.
3. **The PWA already exists.** `OperatorMobilePage.tsx` is 779 LOC of
   polished mobile-first UI shipping to operators today. Bundling a copy
   into the IPA forks the codebase into two: any dashboard change has to be
   re-pulled into `apps/mobile/dist` and re-shipped through stores. That's
   exactly the cost we're avoiding.
4. **Apple's rules permit it.** Guideline 4.7 allows web content as long
   as the wrapping app provides a meaningful container experience (app
   icon, splash, native plugin integrations) and the content matches the
   app's stated purpose. PCC clears this with passkey integration, native
   camera capture, and (in future weeks) Live Activities + push.
5. **Substrate alignment.** The phone's role in the substrate is
   "hardware-backed signer + presence terminal" (per
   `15-MOBILE-APP-FIRST-PRINCIPLES.md` §8), not a separate runtime. A
   wrapping shell makes that explicit: the dashboard is the runtime, the
   shell adds OS integration on top.

### Why we'd flip to option A later

- **App Store review hostility.** If at some point Apple Connect rejects
  builds that load too much remote content (their policy posture has
  shifted in the past), we can flip to a bundled web build with one
  capacitor.config.ts change + a CI step that copies `apps/dashboard/dist`
  into `apps/mobile/dist` before `cap sync`.
- **Offline-first guarantees.** A bundled build means the app boots even
  with zero connectivity, falling back to remote updates when reachable.
  Worth doing if operator scenarios increasingly happen in cell-dead
  environments. The offline queue scaffold (Week 1, this package) already
  hardens the "in-flight loses signal" case; bundled-build hardens the
  "cold start with no signal" case.
- **App size optimization.** Bundling the web also lets us tree-shake
  dashboard-only code paths the mobile binary doesn't need.

We treat the migration A→B (bundle → wrap) as cheap and reversible. Both
are supported configurations.

### How the shell knows where to load from

`capacitor.config.ts` reads two env vars at config-load time:

- `CAP_DEV=1` → activate dev mode (cleartext OK)
- `CAP_SERVER_URL=...` → override the URL the shell loads

In dev mode without an override, it loads `http://localhost:5173` (the Vite
dev server). In prod, it loads `https://capability.network`. Both can be
overridden at native-build time by setting env vars in CI, useful for
staging builds that should hit `staging.capability.network`.

## 2. Why the role-switch is in the mobile shell, not the dashboard

The substrate has **one principal** per device — a user who is sometimes a
consumer, sometimes a provider. Two binaries (PCC User + PCC Operator)
doubles cert + release cost for one logical app.

Role state is persisted in the **secure storage** (not localStorage)
because it gates which start URL the WebView opens to. If localStorage
were the source of truth, a deleted-cookies-while-app-killed scenario
would lose the user's last role and dump them onto the wrong landing.

Role switching:

```
[App boot]
    ↓
[Read role from SecureStorage] (defaults to "user")
    ↓
[role === "operator"] → load /operator/mobile in WebView
[role === "user"]     → render <UserMobilePage> (placeholder for v1)
```

The WebView and the React shell coexist because the user-mode landing is
NOT inside the dashboard PWA today (v1 dashboard is operator-only mobile).
That asymmetry is the right design until the user-side flows mature: don't
fork the dashboard prematurely just to satisfy a binary. As user-mode
features land, we either:

(a) build them into the dashboard at `/user/mobile` and switch the shell
to load that instead, OR

(b) keep them in the React shell and only the operator side wraps the
dashboard.

We don't pick yet. Week 1 ships the placeholder + the role-switch
primitive; the right answer falls out of Weeks 4-6.

## 3. Why a dedicated mobile webmanifest

The dashboard's existing `apps/dashboard/public/manifest.json` has
`start_url: "/operator"`. That's correct for a desktop "Add to Home
Screen" install — desktop users get the full operator dashboard. For a
mobile-installed PWA (or a Capacitor build that uses the manifest for
splash/icons), the right `start_url` is `/operator/mobile`.

Two options:

- **Edit the dashboard's manifest** — risks breaking desktop install
  semantics; affects every dashboard user, not just mobile.
- **Ship a dedicated mobile manifest** (chosen) — `apps/mobile/public/
  manifest.webmanifest` with `start_url: "/operator/mobile"`. The dashboard's
  manifest stays as-is. The mobile shell points the WebView's `<link
  rel="manifest">` (or Capacitor's analog) at the dedicated file.

This also gives us a place to put mobile-only manifest fields like
`shortcuts` (for App Shortcuts / Homescreen long-press menus), `protocol_
handlers` (for `pcc://` deep links), and additional icon sizes without
polluting the dashboard's manifest.

## 4. Offline queue + service-worker scope

The single biggest correctness gap in today's PWA (per researcher-hotel) is
that uploads error out the moment the phone loses signal. Operators on
shop floors and delivery routes lose connectivity routinely.

Week 1 ships the **scaffold** for an IndexedDB-backed retry queue and a
service-worker that intercepts evidence-push fetch failures and enqueues
them. It does NOT fully cover all `/api/*` endpoints — that's Week 4-6
polish. The Week 1 surface:

- **Storage**: IndexedDB store `pcc-mobile-offline-queue` with one object
  store `requests` keyed by auto-increment id, payload = method + url +
  headers + body + createdAt + attempts.
- **Enqueue**: Service worker fetch handler for `POST /api/photo/upload`,
  `POST /api/issues`, and `POST /api/photo/compare` (the three
  evidence-relevant POSTs in OperatorMobilePage). On a network failure,
  serialize the request and enqueue it. The page-side gets a 202-like
  synthetic response (`{queued: true, id}`).
- **Retry**: On `online` event or service-worker `sync` event (Background
  Sync API where supported), drain the queue oldest-first, retrying with
  exponential backoff (1s, 2s, 4s, 8s, capped at 60s, max 5 attempts before
  marking failed and surfacing a UI prompt).
- **Idempotency**: Outbound retried requests carry an `Idempotency-Key`
  header (uuid generated at enqueue) so the gateway can dedup safely. PCC's
  gateway already supports idempotency keys (24h TTL per
  `IDEMPOTENCY_TTL_MS`).
- **Surface**: A simple API on `window` (`pccMobile.queueSize()`) so the
  dashboard PWA can show "3 photos queued for upload" in the operator
  status bar.

The SW registers from `apps/mobile/src/sw/service-worker.ts`. The page-side
helpers live in `apps/mobile/src/sw/offline-queue.ts`. Both are tested
under jsdom + fake-indexeddb.

## 5. Migration plan to native plugins (Weeks 2-6)

Order of plugin integration (pulled from `15-MOBILE-APP-FIRST-PRINCIPLES.md`
§ 7):

| Week | Plugin / native work | Why |
|---|---|---|
| **Week 1 (this)** | secure-storage, offline queue, role switch | Foundations the rest depends on |
| Week 2 | `@aparajita/capacitor-biometric-auth`; passkey via `AuthenticationServices` / Credential Manager; pcc-wallet-passkey-bridge custom plugin | Identity must be hardware-backed before any signing or wallet flow |
| Week 3 | `@capacitor/push-notifications`; iOS Live Activities widget extension; foreground-service for Android | Push wakes the phone for sign requests; Live Activities carry the in-flight UX |
| Week 4 | `@capacitor/camera`, `@capgo/capacitor-camera-preview`; AppAttest / PlayIntegrity bridge; C2PA manifest emit | Evidence pipeline upgrade — lets us hit CC2 |
| Week 5 | `pcc-callkit-inbound` custom plugin; full-screen-Intent | Operator inbound dispatch (sub-3s accept) |
| Week 6 | `@capacitor-community/bluetooth-le`; `@capacitor-community/passive-tools/nfc` | Shop-floor device control + tap-to-pair |

The Week 1 scaffold is intentionally NOT coupled to any of these — adding
them in later weeks doesn't require revisiting the secure-storage / offline
queue / role-switch primitives. They're the substrate the rest plugs into.

## 6. What's deliberately out of scope for v1

Per `15-MOBILE-APP-FIRST-PRINCIPLES.md` § 7:

- Per-action approval for every agent action (replaced by category-level
  delegation rules configured on the dashboard)
- Full audit-log search (web only)
- Tax export (web only)
- Multi-worker dispatcher UI for managers
- Live voice agent rendering on the phone (voice is fallback adapter; only
  surfaces as Live Activity)
- Counter-agent code editing (web only)
- iOS-only or Android-only features in v1 (parity from day one)

## 7. Risks tracked from the first-principles doc that touch v1

- **Apple App Store review hostility (~25% rejection probability with
  mitigations).** v1 mitigates by reframing the app as a "service
  marketplace with on-chain receipts" — fintech passkey app, not crypto
  wallet. Per-tx consent UI on every USDC settlement (default on, even at
  $0.01). The server.url architecture cooperates because the web side
  controls all the framing copy.
- **Capacitor WebView perf scrutiny.** Reviewers may flag "this is just a
  webpage in a wrapper." Mitigation: native plugins genuinely add
  capability the WebView can't (BLE, AppAttest, biometric, Live
  Activities). Week 1 places those primitives so each subsequent week
  adds a tangible "this had to be native" justification.
- **Stolen unlocked phone = full operator access** (today, with the
  localStorage Bearer key). Week 1 mitigates by moving the API key to
  secure storage, gated behind biometric (Week 2 wires the actual
  prompt). The localStorage fallback only applies when running as a plain
  PWA outside Capacitor.

## 8. References

- `15-MOBILE-APP-FIRST-PRINCIPLES.md` — full architecture (this doc is its
  Week 1 implementation report)
- `08-existing-pcc-mobile.md` — what exists in the dashboard today
- `docs/DEPLOY.md` — PCC deploy pipeline (we cooperate with the artifact
  promotion model by NOT bundling deployable web into the mobile binary)
- `apps/dashboard/src/pages/OperatorMobilePage.tsx` — the PWA the shell
  wraps
