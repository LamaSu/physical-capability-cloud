# Critical Operator Onboarding Audit — review-bravo

**Date**: 2026-04-24
**Branch**: `feat/agent-onboarder-v2`
**Persona**: Operator / pointman onboarding their enterprise (machine shop, fleet, lab, data product) onto PCC via the chat or voice agent.
**Scope**: Walk the entire OPERATOR onboarding flow critically — from `/orchestrator` landing through `/operator/[id]` post-build dashboard, including the v1 patched chat (`/onboard/chat`), the v2.5 generic chat (`/orchestrator/[slug]/chat`), all backend wiring, every package this depends on, and 30 named scenarios.

Adversarial mindset; symptoms, root causes, severity, repair.

---

## TL;DR (the air goes out of the room here)

The most important single finding from this audit is that **the v2 dashboard chat console calls eight gateway routes that do not exist on the server**. Every single action the operator can take (start session, paste URL, paste docs, drop PDFs, type "build") will return HTTP 404 (or worse — fall through to whatever Fastify error handler is mounted). The chat has graceful error UX so it won't crash, but it is **completely non-functional end-to-end**. The v2.5 generic console at `/orchestrator/[slug]/chat` has the same problem AND additionally hits a `/api/orchestrator/<slug>/start` prefix that has no implementation at all (the `orchestrator.ts` file in the gateway is the OLD biotech-lab transfer-graph route and has nothing to do with templates).

This is a P0 ship-blocker. The rest of the audit catalogs additional P1/P2/P3 issues, but none of them matter until a wave-2-alpha agent (or whoever was supposed to land that wiring) implements the eight routes. Detail in scenario 29 + the cross-cutting summary.

---

## Code walked (all read-only, all absolute paths)

- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\routes\orchestrator\index.tsx` — v2.5 landing picker
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\routes\orchestrator\[slug]\chat\index.tsx` — v2.5 generic chat console
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\routes\orchestrator\templates.ts` — client-side template mirror (2 entries)
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\routes\onboard\chat\index.tsx` — v1-patched chat console
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\routes\operator\[id]\index.tsx` — alias to OperatorA2APage
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\routes\operator\OperatorA2APage.tsx` — operator dashboard (live data + 5-Q form + escrow)
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\components\onboard\ChatThread.tsx`
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\components\onboard\ActivityFeed.tsx`
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\components\onboard\activity-feed-logic.ts`
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\components\onboard\input-parser.ts`
- `C:\Users\globa\physical-capability-cloud\apps\dashboard\src\stores\auth-store.ts`
- `C:\Users\globa\physical-capability-cloud\packages\orchestrator-sdk\src\core\state-machine.ts`
- `C:\Users\globa\physical-capability-cloud\packages\orchestrator-sdk\src\core\event-bus.ts`
- `C:\Users\globa\physical-capability-cloud\packages\orchestrator-sdk\src\templates\registry.ts`
- `C:\Users\globa\physical-capability-cloud\packages\orchestrator-sdk\src\tools\web-extract.ts`
- `C:\Users\globa\physical-capability-cloud\packages\orchestrator-sdk\src\tools\pcc-discovery.ts`
- `C:\Users\globa\physical-capability-cloud\packages\orchestrator-sdk\src\tools\static-mirror.ts`
- `C:\Users\globa\physical-capability-cloud\packages\orchestrator-sdk\src\tools\wallet.ts`
- `C:\Users\globa\physical-capability-cloud\packages\agent-onboarder\src\onboarder-agent.ts` (this is the actual physical-operator template — the package was renamed from `template-physical-operator`)
- `C:\Users\globa\physical-capability-cloud\packages\agent-onboarder\src\manifest.ts`
- `C:\Users\globa\physical-capability-cloud\packages\template-data-product\src\manifest.ts`
- `C:\Users\globa\physical-capability-cloud\packages\template-data-product\src\flow.ts`
- `C:\Users\globa\physical-capability-cloud\packages\agent-runtime\src\llm-agent.ts`
- `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\onboard.ts` — only `/api/onboard/{analyze,register,registrations,redeem,check,status}` exist; NONE of the chat-console routes
- `C:\Users\globa\physical-capability-cloud\packages\gateway\src\routes\orchestrator.ts` — biotech transfer-graph routes; nothing template-related

---

## Scenario walk-through (30 scenarios)

### Scenario 1 — First-time operator hits /orchestrator landing

**Symptom**: Operator sees two cards: "Physical Operator" and "Data Product." The descriptions read like internal jargon ("kernel-agent", "produces_kind"). For a non-technical pointman ("we run a machine shop"), the picker gives no guidance about which template fits their business.
**Root cause**: `apps/dashboard/src/routes/orchestrator/index.tsx` displays raw `template.produces_kind` and `template.capability_class` as pills, which read "kernel-agent" and "physical." Both are SDK terms, not user terms. The descriptions in `templates.ts` are written for engineers, not for the operator (e.g. "Onboard a machine shop, fleet, lab, or warehouse to PCC. Drop website, ERP/CMMS connections, SOPs/MOPs"). MOP/CMMS/ERP are not consumer-friendly.
**Severity**: P2 (UX, but not blocking). Conversion will leak here.
**Repair**: Replace pills with plain-English category labels ("Physical site" vs "Data product"). Rewrite descriptions in operator voice ("Your shop, lab, or warehouse becomes a billable PCC capability — customers can route real jobs to you and pay via on-chain escrow"). Effort: 1h, copy-only.

### Scenario 2 — Operator types name with weird characters: "O'Reilly's Mill, Inc."

**Symptom**: The slug logic in `static-mirror.ts:slugify()` lowercases, strips non-alphanumerics, collapses dashes, truncates to 80. "O'Reilly's Mill, Inc." → `o-reilly-s-mill-inc`. The apostrophes and comma are silently dropped, which is fine for filenames but the static page title shows the SAFE-escaped raw name (`escapeHtml` runs on `profile.name` for the `<title>`). The HTML `<title>` will contain `O&#039;Reilly&#039;s Mill, Inc.` — readable, but the JSON-LD `name` field (line 53 in static-mirror.ts) contains the raw unescaped string — schema.org consumers will see the apostrophes correctly.
**Root cause**: Slug escapes for filename safety; HTML escapes for body; JSON-LD writes raw. Consistent enough that it works. The risk is **slug collision**: "O'Reilly's Mill" and "OReillys Mill" produce the same slug, no uniqueness check.
**Severity**: P2 (correctness — collisions silently overwrite static mirrors).
**Repair**: Append a content-hash or registration ID suffix to the slug. Effort: 30 min in `static-mirror.ts:slugify()` callers.

### Scenario 3 — Operator pastes a URL behind their internal SharePoint login

**Symptom**: `extract_url` calls `camoufoxFetch()` which spawns the harness `camoufox` CLI. SharePoint will return a 200 with a login page HTML, not the operator's actual content. Claude will then "extract" garbage (login page elements as "machines," "SOPs"). The operator's profile fills with nonsense and they don't know why.
**Root cause**: `web-extract.ts` has zero auth-detection heuristics — it forwards whatever HTML camoufox returns to Claude, and Claude is forced via `tool_choice: { type: "tool", name: "emit_result" }` to fill the schema even when the input is meaningless.
**Severity**: P1 (content correctness; user trust). 25%+ of mid-market operators have content behind auth.
**Repair**: After camoufox fetch, run a quick auth-detection regex (presence of `<form action="login">`, redirects to `/login`, content with "sign in" text density >X%). If detected, surface a friendly chat bubble ("Looks like that page needs a login. Paste a public URL or upload SOPs/MOPs as PDFs"). Effort: 2-3h.

### Scenario 4 — Operator's website is JS-rendered (SPA)

**Symptom**: Camoufox **does** render JS (it's a real Firefox), so SPAs should work. BUT the `--json` mode returns whatever DOM was rendered at the moment camoufox bailed; if the SPA hydrates content via XHR after the page load event, camoufox might serialize the empty shell. Claude then extracts ~zero structured data.
**Root cause**: No "wait for content" parameter passed in `web-extract.ts:camoufoxFetch()` — just `[url, "--json"]`. No retry or render-wait flag.
**Severity**: P2 (works most of the time, fails silently on SPAs).
**Repair**: Pass `--wait-for-text` or implement a length-based heuristic — if rendered HTML <5KB, retry with a longer wait. Effort: 1-2h.

### Scenario 5 — Operator pastes `postgres://user:secret@host/db` in plain chat

**Symptom**: This is a **CREDENTIAL LEAK**. The `input-parser.ts:looksLikeConnString()` matches `postgres|postgresql|mysql|mongodb|redis|s3|sharepoint`. Once detected, the chat dispatches `connections` intent and calls `await scrapeUrl(sessionId, c)` (in `/onboard/chat`) which hits `POST /api/onboard/:id/scrape` with the **plaintext connection string** in the JSON body. The same string is **also pushed into `messages` state** as `pushMessage("you", text)` and **also rendered into the activity feed** if any tool emits it via `event-bus`.

In `web-extract.ts` the `extractStructured` call passes the raw URL into Claude's prompt as `URL: ${opts.url}` — so the operator's password ends up in the model context for Anthropic to see.

There is **no redaction layer anywhere** in the pipeline. The chat thread, activity feed, audit log, and Claude prompt all see the raw secret.
**Root cause**: `input-parser.ts` detects connection strings but doesn't strip auth components; chat thread renders `messages` state verbatim; activity feed renders `payload` keys verbatim; `web-extract.ts` passes the raw URL to Claude.
**Severity**: **P0 — critical data exfil bug**. Will burn the first operator who tries this and we'll discover it post-incident.
**Repair**: (a) `parseInputIntent` rewrites connection strings to `proto://USER:***@host/db` before dispatch; (b) the actual secret is stored only in a session-scoped redacted-keys vault (encrypted, in-memory or `@pcc/db` once it lands); (c) `web-extract.ts` refuses to scrape `postgres://`-style URLs at all (it's the wrong tool — connection strings need a sniffer, not a browser); (d) activity-feed payload renderer redacts known credential patterns. Effort: 1-2 days.

### Scenario 6 — Operator pastes 50 doc URLs at once

**Symptom**: `parseInputIntent` returns `scrape_many` with up to 50 URLs. The chat console then `for (const u of intent.urls) await scrapeUrl(sessionId, u)` — a serial for-loop, no concurrency limit, no progress indicator, no abort button. Each call spawns camoufox via subprocess, then makes a Claude tool-use call. At ~5-10 sec per URL, 50 docs = 4-8 minutes of frozen UI with `busy=true`. Browser tab might be killed by OS for being unresponsive.
**Root cause**: `OnboardChatPage.handleSend` uses sequential `await` with a single `setBusy(true)` flag and no chunking, no per-URL feedback.
**Severity**: P1 (UX freeze, looks like the agent died). Memory: 50 camoufox subprocesses tile the heap.
**Repair**: Cap at N (e.g., 10) per batch; chunk the rest into a queue with progress reported via `pushMessage`. Add an "abort" link. Effort: 4h.

### Scenario 7 — Operator drags a 200MB PDF into the chat

**Symptom**: `ChatThread.tsx:handleDrop` reads `e.dataTransfer.files` and passes File objects up to `OnboardChatPage`. The page calls `ingestDocs(sessionId, files.map((f) => "local://" + f.name))` — it **ignores the file content entirely** and only sends the filename as a `local://name` URL. The 200MB PDF was never read, and never uploaded. The backend (which doesn't exist anyway, see scenario 29) couldn't have done anything with it.
**Root cause**: This is the documented v1-port limitation — comment in `OnboardChatPage:269-285` says "Real upload (multipart) is alpha's territory — once the route accepts FormData we'll switch to that." So the file content is silently dropped.
**Severity**: P0 for "drop SOPs to onboard" promise — the operator UX promises file ingest in the chat (`hint="drag PDFs anywhere"`), but no file content actually leaves the browser.
**Repair**: Wire a real `multipart/form-data` upload route on the gateway (`POST /api/onboard/:id/upload-doc`), pass the File objects to FormData in the dashboard, save bytes to S3/IPFS/local. Effort: 1-2 days. Until then, replace the misleading hint text with "drop docs and I'll prompt you for download URLs."

### Scenario 8 — Operator session crashes mid-flow (browser refresh)

**Symptom**: Session ID is in React state (`useState`). Page refresh = state cleared. The operator's session ID is lost, the dashboard re-renders with `sessionId === null`, the next message is treated as a bootstrap. Worse: the **server-side `state-machine.ts` store is `new Map<string, OnboardSession>()` in module scope** — process restart drops every active session. A 5-minute Railway redeploy = every in-flight onboarding gone, with no recovery path.
**Root cause**: Documented in `state-machine.ts:9-18` — "Wave 4 of the migration plan replaces it with PCC's Postgres + RLS." Today's branch is wave-2.5; wave-4 hasn't shipped.
**Severity**: P1 for ship readiness. Acceptable for hackathon-grade demo, unacceptable for Sponsor public launch.
**Repair**: Persist sessions to Postgres (the path is documented). Until then, persist `sessionId` to `localStorage` in the dashboard so a browser refresh resumes. Effort: 3-day backend, 30 min frontend safety net.

### Scenario 9 — Operator clicks "build" before discovery completes

**Symptom**: `OnboardChatPage.buildAgent` calls `POST /api/onboard/:id/build-agent` regardless of session state. The state-machine in `state-machine.ts` has states `started → data_connected → docs_ingested → interview → capabilities_drafted → built` but `advanceSession()` doesn't enforce ordering — any caller can jump to `built`. The dashboard never asks "did discovery actually find anything?"
**Root cause**: `advanceSession()` in `state-machine.ts` accepts any `to` state with no transition validation. The build route (which doesn't exist) would have to enforce this.
**Severity**: P2 (results in an agent built from empty/null capability data — the operator gets a useless agent and doesn't know why).
**Repair**: Add transition validation to `advanceSession()` AND have the build route refuse to run if `state !== "capabilities_drafted"`. Effort: 1h.

### Scenario 10 — `build-agent` fails partway (Redis down, PCC discovery 503, etc.)

**Symptom**: The `OnboarderAgent` chains 5 tools (extract_url, search_pcc, publish_operator, write_static_mirror, create_wallet). LLMAgent's `chat()` runs them in a single `Promise.all` per turn. If `publish_operator` throws because PCC is 503, the agent gets `is_error: true` tool_result and the LLM is supposed to recover. But: there's **no idempotency contract**. If the agent then retries `publish_operator` in turn N+1, it will register the operator a SECOND time (the gateway's `POST /api/onboard/register` doesn't check for duplicates by name+wallet — it inserts a fresh row each call). After three retries the operator has three rows, three discovery URLs, and three slug-conflicting static mirrors.
**Root cause**: `pcc-discovery.ts:publishOperator` doesn't pass an idempotency key; gateway `onboard.ts:/api/onboard/register` doesn't dedupe by `enterprise_id`.
**Severity**: P1 — one failed onboarding produces multiple registrations.
**Repair**: Add `Idempotency-Key: enterprise_id` header support on the register route; have `publishOperator` set it. Effort: 4h.

### Scenario 11 — Operator agent dropped onto Guild but Guild auth expired

**Symptom**: `onboarder-agent.ts` references Guild only in TODO comments — the actual deploy step doesn't currently target Guild (only PCC's own discovery). But the `OnboardChatPage:buildAgent()` still surfaces a "Guild: ${j.agent?.url}" line in its success message. Result: even on a fully-clean build, the dashboard says "Guild: —" because the route never returned anything for that field.
**Root cause**: Frontend message hardcoded to fields that the backend has no path to populate.
**Severity**: P3 (misleading UX, no functional impact).
**Repair**: Either remove the Guild line from the success message or wire a Guild deploy step into `OnboarderAgent.buildToolCallers()`. Effort: 30 min for the former.

### Scenario 12 — Two operators with the same name onboard simultaneously

**Symptom**: Both operators get `slug = "acme-mfg"`. Both static mirrors write to `<package>/public/operators/acme-mfg.html` — last-writer-wins. One operator's SEO mirror silently disappears. The DHT announce calls happen with the same display name; PCC's discovery shows two entries with the same name and no way to disambiguate.
**Root cause**: `static-mirror.ts:slugify()` does not enforce uniqueness; `pcc-discovery.ts:publishOperator()` registers with `name` only — the upstream `MachineRegistration` schema accepts `name` as non-unique.
**Severity**: P1 — silent data loss + brand confusion.
**Repair**: Suffix the slug with the registration ID (or first 8 chars of the wallet address). Same fix as scenario 2. Effort: 30 min.

### Scenario 13 — Operator wants to edit profile after onboarding

**Symptom**: There is **no edit UX**. The operator's only post-build view is `OperatorA2APage`, which renders read-only capability/material/cert pills sourced from `/api/onboard/:id/live-data` (a route that doesn't exist). No edit button, no admin link, no "submit corrections" path.
**Root cause**: Out of scope for the wave-2.5 migration — the v1 navi flow also didn't have edit. But the dashboard now exposes operator data publicly; misinformation is permanent.
**Severity**: P1 — operator data correctness depends on edit-ability. GDPR/CCPA also implicates this.
**Repair**: Add `PATCH /api/onboard/:id/profile` route + edit form on the operator page, gated by API-key ownership. Effort: 1 day.

### Scenario 14 — Operator wants to delete / unpublish (right-to-be-forgotten)

**Symptom**: Same as 13. No deletion path. Once `publishOperator` writes to PCC's onboard registry + DHT + static mirror, there is no way to retract. The DHT announce has `ttlSeconds: 3600` (1h) but the registration record is permanent in `repos.registrations`.
**Root cause**: `onboard.ts` has no DELETE route. `static-mirror.ts` has no `removeOperatorMirror`. PCC discovery has no unpublish endpoint.
**Severity**: P1 — legal exposure (GDPR Article 17 right to erasure).
**Repair**: Add DELETE `/api/onboard/registrations/:id` (soft-delete with `status: "deleted"`); have `static-mirror.ts:removeOperatorMirror(profile)` to delete the HTML; add a `DELETE /api/dht/announce/:kernelId` (or rely on TTL). Surface as a "delete account" button on operator dashboard. Effort: 1-2 days.

### Scenario 15 — Tenant isolation: operator A queries dashboard, sees operator B's data

**Symptom**: Today every API call uses an API-key auth via `getAuthHeaders()` Bearer token. But the gateway routes that exist (`/api/onboard/registrations`, `/api/onboard/registrations/:id`) **don't filter by API-key owner** (line 116 in onboard.ts: `const registrations = repos.registrations.findAll();` — returns ALL rows). The "sanitized" projection strips wallet addresses but leaves names + capabilities — readable to any logged-in user.
**Root cause**: No RLS layer (planned for wave-4 per state-machine.ts comments). Today's `getRepos()` just queries the local sqlite/whatever with no tenant scope.
**Severity**: P1 — data leakage. Every operator can see every other operator's submitted registration.
**Repair**: Add `WHERE operatorId = $caller` filter on `findAll`; add ownership check on `findById`. Effort: 1 day for the immediate fix; full RLS is wave-4 work.

### Scenario 16 — Operator types `<script>alert(1)</script>` as a capability

**Symptom**: `static-mirror.ts:escapeHtml` escapes `&`, `<`, `>`, `"` for HTML body content. **GOOD**: capability/material/cert lists pass through `escapeHtml()` (lines 70-72). **BUT**: the JSON-LD block at line 49-66 **does not escape**. It serializes `profile.capabilities` directly into a `<script type="application/ld+json">` block. JSON.stringify handles `<` correctly for JSON syntax, but JSON-LD inside a `<script>` block has a known XSS vector when content contains `</script>`. If an operator types `</script><script>alert(1)</script>` as a capability, JSON.stringify renders `"</script><script>alert(1)</script>"` and the browser closes the script tag early.
**Root cause**: `static-mirror.ts:48-67` — `JSON.stringify(jsonLd, null, 2)` does not escape `</script>` sequences. Standard JSON-LD-in-HTML XSS pitfall.
**Severity**: P0 if the static mirror is served from a domain shared with auth-credentialed pages; P1 if isolated.
**Repair**: After `JSON.stringify(...)`, replace `</` with `<\\/` to neutralize the closing-script attack. Effort: 5 min, one line.

### Scenario 17 — Operator gives a fake company name ("Apple Inc")

**Symptom**: No verification. `pcc-discovery.ts:publishOperator()` will register "Apple Inc" with whatever wallet they give (defaulted to `0x0000...` — see line 102). Static mirror writes a page asserting "Apple Inc — PCC operator." Search engines index it. PCC is now a typosquatting amplifier.
**Root cause**: No identity verification step. The flow trusts the operator's self-attested name.
**Severity**: P1 — trademark, legal, brand-dilution exposure.
**Repair**: Add a `requires_verification` flag to registrations using known-trademark names (a hard-coded watchlist + Levenshtein fuzz to common Fortune-500 names). Hold those for human review before activation. Effort: 1 day initial + ongoing maintenance of the watchlist.

### Scenario 18 — Operator agent hits its own infinite loop

**Symptom**: `LLMAgent.chat()` defaults `maxTurns = 12` per `DEFAULT_MAX_TURNS = 12` in `llm-agent.ts:60`. Once exceeded, it throws `LLMAgent.chat exceeded maxTurns=12`. `OnboarderAgent` overrides to `12` too (line 152). **Good — there IS a circuit breaker**. But: the breaker fires AFTER the 12th turn, meaning 12 Claude calls happened. At ~2-3 sec each, that's 24-36 sec of frozen UI before the operator sees an error. And the error message bubbles up raw — `e.message` becomes "LLMAgent.chat exceeded maxTurns=12" in the chat — useless to the operator.
**Root cause**: maxTurns is enforced; user-facing error is not translated.
**Severity**: P3 (UX, not security).
**Repair**: Catch the `exceeded maxTurns` error, log to telemetry, surface to operator as "I'm having trouble onboarding you — let me know if you'd like me to try a different approach." Effort: 30 min.

### Scenario 19 — Voice flow (Vapi v1, Pipecat v2.5) drift

**Symptom**: The chat thread in `ChatThread.tsx` supports a `"voice"` role (`AVATAR_LABEL` line 44, line 220-238) — explicitly meant to mirror "the live phone agent's transcript." But: there is **no code anywhere on this branch that pushes voice messages into the chat**. The voice doorway is mentioned in `agent-onboarder/manifest.ts` adapter list (`voice: { required: false, fallback: "chat" }`) but no Pipecat or Vapi server is running, and no socket pushes voice transcripts.
**Root cause**: V1 had Vapi wired (per state-machine.ts comment "Pipecat voice doorway"). V2.5 marked it optional with chat fallback. Neither has implementation today.
**Severity**: P2 (advertised but unimplemented). Operator who calls the phone number gets nothing; chat dashboard claims to mirror voice.
**Repair**: Wire Pipecat (or remove the voice references from chat copy). Effort: 1 week for full voice; 30 min to remove copy.

### Scenario 20 — Slow network: ActivityFeed polls every 2s

**Symptom**: `ActivityFeed.tsx:pollIntervalMs = 1500` (default 1.5s). On a 3G connection or with the gateway slow-responding, polls overlap — `setInterval` doesn't wait for prior fetch to complete. Result: 5+ in-flight requests at once, hammering both the gateway and the client. No exponential backoff, no AbortController to cancel pending fetches when a new poll fires.
**Root cause**: `ActivityFeed.tsx:71-92` has `setInterval(poll, pollIntervalMs)` without coordinating in-flight polls.
**Severity**: P2 (stress on backend, dropped events).
**Repair**: Use `setTimeout` after-poll-completes (or tracked-in-flight flag). Add backoff on consecutive failures. Effort: 1h.

### Scenario 21 — Accessibility: screen reader / keyboard-only operators

**Symptom**: `ChatThread.tsx` has minimal aria — `aria-hidden` on the avatar, `aria-label` only on the activity-feed timestamp. The chat textarea has no label, no role, no `aria-live` region for streaming bot messages. Drag-drop has NO keyboard alternative — operators using AT cannot upload files. The send button is `disabled={disabled || !text.trim()}` but has no announcement of state changes. Screen-reader users won't hear new bot messages because the message list isn't `aria-live="polite"`.
**Root cause**: No accessibility pass on the React port of v1.
**Severity**: P1 — ADA / Section 508 / EN 301 549 exposure if PCC is U.S. public-facing.
**Repair**: Add `aria-live="polite"` to message list, label the textarea, add a "browse files" button as keyboard alternative to drag-drop. Effort: 4h.

### Scenario 22 — Mobile layout breaks under 900px

**Symptom**: `OnboardChatPage` line 301: `<div className="w-[380px] shrink-0 hidden lg:block min-h-0">` — the 380px activity feed is hidden below `lg:` (Tailwind = 1024px). At 900px the feed disappears. **GOOD**: at least it's behaviorally consistent. But `ChatThread.tsx` uses `max-h-[120px]` on the textarea — fixed pixel height that doesn't scale with viewport. On mobile (375px width), the input field is fine but the message bubbles use `max-w-[92%]` which is OK. The orchestrator chat (`/orchestrator/[slug]/chat`) doesn't even have a mobile breakpoint check — `<div className="orchestrator-chat">` relies on a CSS class that may not be defined responsively.
**Root cause**: Mixed Tailwind + CSS-class approach; orchestrator-chat class isn't defined in any reviewed file.
**Severity**: P2 — mobile is a real surface for ops-floor onboarding (manager onboarding from the shop floor on a tablet).
**Repair**: Test at 375px / 768px / 1024px / 1440px. Add `flex-direction: column` on smaller viewports. Effort: 4h.

### Scenario 23 — Manifest validation: `defineTemplate`

**Symptom**: `defineTemplate()` in `registry.ts:58-83` validates slug regex, display_name, description, system_prompt, flow type, and produces fields. **GOOD**: it actually does validate. Unknown fields pass through (no Zod/JSON-schema strict check). If a template manifests with `produces.kind: ""` (empty string), validation fails ("produces.{kind,capability_class} required"). A template that ships with `slug: "Foo Bar"` (with space) fails the regex check. Decent.
**Root cause**: The mirror in `apps/dashboard/src/routes/orchestrator/templates.ts` is hand-maintained and **not validated against the SDK contract** — drift is invisible until prod.
**Severity**: P2 — drift between server templates and dashboard mirror is the #1 reason operators see wrong copy.
**Repair**: At dashboard build time, run a script that imports each `template-*` package, runs `defineTemplate`, and asserts the mirror in `templates.ts` matches. Effort: 2h.

### Scenario 24 — Schema drift: dashboard mirror vs template manifest

**Symptom**: `apps/dashboard/src/routes/orchestrator/templates.ts` has `display_name`, `description`, `produces_kind`, `capability_class`, `greeting`, `api_base`. The SDK's `TemplateManifest` has different fields: `display_name`, `description`, `produces.kind`, `produces.capability_class`, `connectors_optional`, `system_prompt`, `flow`, `adapters`. The greeting and api_base are ONLY on the dashboard mirror — they don't come from the template manifest. So the SDK never sees what greeting the dashboard renders or what `api_base` it dispatches to.
**Root cause**: No source-of-truth alignment. Greeting and api_base were added client-side as a v2.5 expedience.
**Severity**: P1 — the moment a template wants its own greeting that's compiled into its system prompt, the dashboard will show stale copy. Already happening: physical-operator's greeting in `templates.ts` differs from `system-prompt.ts` ONBOARDER_SYSTEM_PROMPT in subtle wording.
**Repair**: Add `greeting` and `api_base` fields to `TemplateManifest`. Have dashboard fetch `GET /api/orchestrator/templates` (TODO in registry.ts) instead of bundling a static mirror. Effort: 1 day backend, 4h frontend swap.

### Scenario 25 — Template fails its own tests after PCC schema change (CVP, agent-package version bump)

**Symptom**: PCC's CVP introduced agent-package v2.8.0 with 218 tools (per MEMORY.md). The orchestrator-sdk's `pcc-discovery.ts` references `https://capability.network/agent-package.json` for tool list (line 11 comment). If CVP renames a tool or adds a required field, the orchestrator-sdk's hardcoded request body shape (lines 91-107) drifts. There's no version-pinning, no compatibility check.
**Root cause**: `pcc-discovery.ts` hardcodes the request shape rather than fetching the agent-package and adapting.
**Severity**: P2 — works today, breaks silently on PCC schema change.
**Repair**: Pin agent-package version (e.g., `?version=2.8.0`) and have a CI test that fails if PCC ships an incompatible version. Effort: 4h plus CI wiring.

### Scenario 26 — Data-product template hits same gap as scenario 3

**Symptom**: `template-data-product/manifest.ts` lists connectors `postgres`, `snowflake`, `bigquery`, `rest`, `graphql`, `mcp`. The flow (`flow.ts`) has a 5-state machine (identify → describe → schema → price → publish) but the actual connection steps are stubs — the operator types a Snowflake URL with credentials, and the SAME credential-leak scenario (5) applies. The data-product greeting in `templates.ts` LITERALLY asks for connection strings: "Where does your data live? (e.g. Postgres, Snowflake, BigQuery, REST API)" — practically inviting the leak.
**Root cause**: Same as scenario 5; the data-product template is even more credential-exposed because connection strings ARE the workflow input.
**Severity**: P0 — promoting the data-product template to production with the current redaction story is reckless.
**Repair**: Same as scenario 5, plus a connection-string-only redacted-credential vault required before the data-product flow can ship. Effort: 2 days, blocks data-product launch.

### Scenario 27 — Operator abandons mid-flow, comes back tomorrow

**Symptom**: Same as scenario 8 — sessions in-memory. Comes back tomorrow, `localStorage` doesn't persist `sessionId`, gateway has restarted, all state lost. Operator's only option: start over and re-do everything.
**Root cause**: No durable session store + no client-side recovery.
**Severity**: P1 — abandonment recovery is a top-3 onboarding metric in any SaaS funnel.
**Repair**: localStorage `sessionId` + Postgres-backed session store. Effort: covered by scenario 8 fix.

### Scenario 28 — Onboarding succeeds but no jobs land

**Symptom**: `publishOperator` returns with `dht_announced: true`, the agent dashboard says "ONLINE — accepting jobs," and... silence. No jobs ever come. Operator has no diagnostic. Are they listed? Are they searchable? Did the DHT announce reach a relay? **The dashboard `/operator/[id]` shows zero observability** — no "X buyers searched for your capability today," no "your capability ranks #N for query X," no "your DHT announce expires in 47 min."
**Root cause**: Observability surfaces don't exist on the operator dashboard. The `OperatorA2APage` shows capabilities/materials/certs and waits for someone to type a 5-Q form.
**Severity**: P1 — the #1 operator-rage moment ("I onboarded and got nothing"). If they don't have a self-diagnostic path, they leave.
**Repair**: Add "Discoverability" section to operator dashboard: searches matching this operator, last DHT refresh, top capability ranking, time-to-first-job. Effort: 1-2 weeks (requires gateway-side aggregation queries).

### Scenario 29 — Backend wiring: do the chat-console routes EXIST?

**Symptom**: The dashboard chat console at `/onboard/chat` calls these endpoints:
- `POST /api/onboard/start` → **MISSING**
- `POST /api/onboard/:id/scrape` → **MISSING**
- `POST /api/onboard/:id/ingest-docs` → **MISSING**
- `POST /api/onboard/:id/build-agent` → **MISSING**
- `POST /api/onboard/:id/status` (GET in OperatorA2APage) → **MISSING**
- `GET /api/onboard/:id/live-data` → **MISSING**
- `GET /api/onboard/events?since=N` → **MISSING**

The v2.5 generic chat at `/orchestrator/[slug]/chat` calls these endpoints (via `template.api_base`):
- `POST /api/onboard/start`, `POST /api/onboard/:id/scrape`, `POST /api/onboard/:id/ingest-docs`, `POST /api/onboard/:id/build-agent` (for physical-operator) — all **MISSING**
- `POST /api/orchestrator/data-product/start` etc. (for data-product) — **NO ROUTE FILE FOR THIS PREFIX EXISTS**. The `orchestrator.ts` route handler in the gateway is for biotech transfer-graphs, not for templates.

What DOES exist on `onboard.ts`:
- `POST /api/onboard/analyze` — mock document analysis (no relation to chat flow)
- `POST /api/onboard/register` — direct machine-registration (no chat session)
- `GET /api/onboard/registrations`, `GET /api/onboard/registrations/:id` — list/detail
- `POST /api/onboard/registrations/:id/approve|reject|activate|prove` — admin/fast-track flow
- `POST /api/onboard/redeem` — Gatecraft invite-code flow (one-shot, not a multi-turn chat)
- `GET /api/onboard/check/:code` and `GET /api/onboard/status` — auxiliary

None of these match the chat console's contract. The chat console assumes "wave2-alpha will land them" (see comments in `OnboardChatPage:25-26` and `ActivityFeed.tsx:28`). Wave-2-alpha has not landed those routes on this branch.

**Root cause**: The dashboard was ported from v1 navi (`packages/backend/public/index.html`) and assumes the v1 backend route layout. The v2 PCC gateway never had those routes. The migration plan presumes wave-2-alpha implementer to land them; they haven't.

**Severity**: **P0 — operator chat is end-to-end broken on this branch.** No demo, no live operator can complete the chat flow. The error UX is graceful ("Gateway error 404 on /:id/scrape") but the flow is dead.

**Repair**: Land the 8 routes. Map them to `OnboarderAgent.chat()` for the physical-operator template; spawn the data-product equivalent for that template. Wire the in-memory event-bus's `tail()` to `GET /api/onboard/events`. Effort: 2-3 days for one implementer following the plan in `docs/agent-onboarder/NAVI-V2-MIGRATION-PLAN.md`.

### Scenario 30 — CSRF / origin / auth on chat endpoints

**Symptom**: `OnboardChatPage` and `OrchestratorChatPage` both use `getAuthHeaders()` which sends a `Bearer pcc_live_*` API key from `localStorage`. The bootstrap message ("What's your company name?") happens BEFORE the user has provisioned an API key — but `getAuthHeaders()` returns `{}` if no key is in localStorage, and the gateway's `/api/onboard/*` routes that DO exist (analyze, register) do not require auth (they're public). So an anonymous visitor can spawn an onboarding session.

But: the `/api/escrow/fund` route in `OperatorA2APage:248` DEFINITELY requires auth (it touches funds). Anonymous user clicks "Lock $X in escrow" → 401. The OperatorA2APage doesn't gate the button on auth state at all.
**Root cause**: Mixed auth model — chat is anonymous-OK, escrow requires auth, no clear UX for the auth boundary.
**Severity**: P2 — confused UX, not security flaw (the gateway still rejects unauth'd escrow calls).
**Repair**: Detect missing API key in OperatorA2APage and prompt for login before showing escrow button. Effort: 1h.

There's also no CSRF token on any of these calls, but they're all `fetch()` from the same origin with custom headers, which prevents simple CSRF. SOP-wise OK.

---

## Critical findings (severity-ranked)

### P0 — ship-blockers, must fix before any real operator onboards

**P0-A: Chat console calls 8 missing backend routes (Scenario 29)**
- Symptom: every chat action (start, scrape, ingest-docs, build-agent, status, live-data, events) returns 404.
- Root cause: wave-2-alpha never landed gateway wiring in `packages/gateway/src/routes/onboard.ts` and there is NO `orchestrator/[slug]` route file at all. The existing `orchestrator.ts` is for biotech transfer-graphs.
- Repair: implement 8 routes wrapping `OnboarderAgent` (physical-operator) + a data-product equivalent. Wire `event-bus.tail()` to `/api/onboard/events`.
- Effort: 2-3 days for one implementer.

**P0-B: Plaintext credential leak via connection strings (Scenarios 5, 26)**
- Symptom: operator pastes `postgres://user:secret@host/db`; the secret enters chat thread, activity feed, audit log, and Claude prompt. The data-product template's primary input IS connection strings, so this is unavoidable on that path.
- Root cause: no redaction in `input-parser.ts`, `web-extract.ts`, `event-bus.ts`, or chat thread render. Activity feed renders payload.* keys verbatim.
- Repair: parser strips auth from URL display; Claude never sees raw URL secrets; activity-feed payload renderer redacts known credential patterns. Vault stores the real secret encrypted, scoped to session.
- Effort: 1-2 days.

**P0-C: 200MB PDF (or any file) drag-drop is a no-op (Scenario 7)**
- Symptom: dashboard accepts file drop but only sends `local://filename.pdf` URLs to the backend; the file content never leaves the browser. Promise of "drop SOPs" is broken.
- Root cause: documented v1-port limitation; multipart-upload was deferred to alpha.
- Repair: implement `POST /api/onboard/:id/upload-doc` (multipart), wire dashboard FormData submission. Or remove the misleading hint copy.
- Effort: 1-2 days.

**P0-D: JSON-LD XSS in static mirror (Scenario 16)**
- Symptom: capability label `</script><script>alert(1)</script>` breaks out of the JSON-LD script tag in the operator's static SEO page.
- Root cause: `JSON.stringify` doesn't escape `</`; one-line fix.
- Repair: replace `</` with `<\\/` after stringify.
- Effort: 5 min.

### P1 — must fix before public/Sponsor-facing launch

- **P1-A**: In-memory session store (Scenarios 8, 27) — Railway redeploy = every onboarding lost.
- **P1-B**: Tenant isolation missing (Scenario 15) — any logged-in user sees all registrations.
- **P1-C**: No edit / delete UX (Scenarios 13, 14) — GDPR Article 17 exposure.
- **P1-D**: Slug collisions silently overwrite static mirrors (Scenarios 2, 12).
- **P1-E**: Auth-walled URL extraction returns garbage (Scenario 3) — content correctness.
- **P1-F**: 50-doc batch freezes UI (Scenario 6).
- **P1-G**: Build-agent retry creates duplicate registrations (Scenario 10) — no idempotency key.
- **P1-H**: No accessibility pass (Scenario 21) — Section 508 exposure.
- **P1-I**: Trademark squatting risk (Scenario 17) — no name verification.
- **P1-J**: "Onboarded but invisible" — no discoverability diagnostics on operator dashboard (Scenario 28).
- **P1-K**: Schema drift between dashboard template mirror and SDK manifest (Scenario 24).

### P2 — quality / polish, not blocking

- Landing page copy reads as engineer jargon (Scenario 1).
- SPAs may render empty if camoufox doesn't wait for hydration (Scenario 4).
- State-machine accepts any transition; no validation (Scenario 9).
- Voice flow advertised but unimplemented (Scenario 19).
- ActivityFeed polls without coordinating in-flight requests (Scenario 20).
- Mobile layout untested below 900px (Scenario 22).
- Manifest validation not strict (Scenario 23).
- PCC agent-package version drift (Scenario 25).
- Mixed-auth UX in escrow button (Scenario 30).

### P3 — cosmetic

- "Guild: —" hardcoded message line on success (Scenario 11).
- maxTurns error message bubbles up raw (Scenario 18).

---

## Cross-cutting themes (the high-altitude takeaway)

**Theme 1: The frontend was built faster than the backend.** The dashboard chat console is fully implemented — three-pane layout, drag-drop, activity feed, intent parser, error UX — but it talks to 8 routes nobody wrote. This is the inverse of the typical "API ships, UI lags" pattern. The fix is operationally simple (one implementer, 2-3 days) but it's the entire reason this branch can't demo.

**Theme 2: Persistence is a Wave-4 IOU that landed in a Wave-2.5 release.** Sessions, tenant isolation, ownership, edit/delete, and operator-data correctness all assume a Postgres + RLS layer that the migration plan defers. Today's branch ships a v1.0-grade in-memory Map. Fine for hackathon. Not fine for "live at capability.network."

**Theme 3: The credential-handling story is missing.** The flow practically demands operators paste connection strings (data-product template literally asks for them in its first greeting). There is zero redaction, zero vault, zero audit trail. The first power user who types a real Snowflake URL with creds creates an immediate data-leak incident.

---

## Open questions (for the user / orchestrator to answer)

1. **Who owns the wave-2-alpha backend wiring?** Is it active or stalled? Without those 8 routes, none of this branch demos. Should `feat/agent-onboarder-v2` rebase off whatever branch has the wiring, or should we land it here directly?
2. **Is the data-product template intended to ship at the same time as physical-operator?** If yes, the credential-vault story (P0-B) is on the critical path and needs allocation NOW — it's harder than the missing routes. If data-product can defer, scenario-26 risk drops.
3. **GDPR/CCPA surface — is PCC publicly listing operators?** If yes, P1-C (delete) and P1-B (isolation) are legal blockers, not just product blockers.
4. **What's the auth model for the chat console?** Anonymous-start with API-key required only for escrow? Or login-gated entirely? Today's flow is the former implicitly; that may be the wrong default.
5. **Camoufox vs the auth wall** — should we attempt extraction of credentialed pages at all, or hard-refuse and route to file-upload? Refusal is a faster ship; attempt-with-extraction is a richer story.

---

End of audit. Generated 2026-04-24 by review-bravo.
