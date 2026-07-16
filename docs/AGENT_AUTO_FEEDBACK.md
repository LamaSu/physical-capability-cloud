# Agent auto-feedback

Make third-party agents **automatically report failures + logs** the moment they hit
an issue working with PCC, instead of only when they remember the `pcc_report` tool.

Full design (all phases): `ai/research/agent-feedback-auto-design.md`.
Branch: `feat/agent-auto-feedback`. Nothing deployed; `/api/feedback` report-sink is public.

## How it works

- **At the failure site (server):** every JSON **5xx** response carries a `report_hint`
  block — `{ tool, how, traceId, note, send:{ type, endpoint, method, status, errorCode } }`
  — so a cold agent (no API key yet) is told exactly how to report + handed its journey
  trace. `4xx` are client-fixable and are not decorated; the feedback sink's own
  failures are never decorated (no report-loop). Thrown errors get it via
  `setErrorHandler` (with the precise `error.code`); explicitly-returned 5xx get it via
  an `onSend` decorator — so the "any 5xx carries `report_hint`" contract is true.
- **The contract (agent package):** `pcc_report` points at the durable, admin-readable
  `POST /api/feedback`; the `system_prompt` carries a strict, throttled trigger
  (report on 5xx / unrecoverable 4xx / repeat-failure; **once, never loop; never send
  secrets**); a top-level `error_reporting` field lets a harness that never parses the
  22k-char prompt still honor the contract.
- **The sink:** `POST /api/feedback` (public, rate-limited, honeypot) appends durable
  JSONL on the mounted volume, pings Discord, and is readable via
  `GET /api/admin/feedback` (X-Admin-Token). Persists the failure context
  (`endpoint`, `method`, `httpStatus`, `errorCode`, `traceId`, …).

## Build + review loop (this doc coordinates it)

Process per the operator's directive: **attempt Fable → fall back to Opus for code
(Fable's classifier declines this security-heavy codebase) → sol (GPT-5.6) reviews in
rounds until done.** Each phase runs its own round(s); a phase is "done" when sol has
no remaining real findings.

### Phase 1 — failure-site report_hint + strict contract — DONE ✅

Commits `0203dc6e` (build) + `5822a1ef` (review fixes). 29 tests green, tsc clean.

**sol review round 1** (6 findings): #2 HIGH (onSend for explicit 5xx) FIXED · #3 MED
(feedback-loop guard) FIXED · #4/#5/#6 LOW FIXED · #1 HIGH was a false positive (the
agent-package.json JSON was excluded from the code-only review diff but IS committed).

### Phase 2 — bounded `logs` + server-side secret redaction + dedup + telemetry — BUILT, IN REVIEW

Commit `c4b86cf2`. 62 tests green (redaction 8, feedback +logs/redaction/dedup,
agent-feedback 20 unaffected), tsc clean. Delivered:
- `logs` array on `pcc_report`/`/api/feedback` — `[{step, method, path, status, note}]`,
  bounded to 20 entries, each note ≤500 chars and secret-scrubbed.
- `redaction.ts` — scrubs Bearer/`pcc_live_`/JWT/64-hex-private-key/vendor-key shapes
  from `summary`/`detail`/`logs[].note`; never redacts a public 40-hex address.
- dedup — collapse identical reports (principal+endpoint+errorCode+summary) in a 5-min
  window; accepted 200 (agent won't retry) but not persisted/re-notified.
- telemetry fold — PostHog `feedback_filed` event from `/api/feedback`.

**sol round 1** (`c4b86cf2` → fixes `5868961b`) — 6 findings, all valid, all fixed:
#1 HIGH redaction skipped structured fields (endpoint/logs.path/errorCode → query-strip
+ redact); #2 HIGH scrubber gaps (pcc keys w/ `_-`, bare 64-hex, `sk-proj-`); #3 HIGH
failed-write → permanent dedup loss (mark key only after append); #4 MED weak dedup key
(SHA-256 over a trusted ip principal + full fields); #5 MED NaN window → dedup-forever
(validated); #6 LOW redact-after-truncate (redact before clamp). 66 tests green.

**sol round 2** (fixes `87418838`) — 4 findings, all valid, all fixed: #1 HIGH more
fields bypassed the scrubber (method now HTTP-verb-validated; traceId/email/wallet
redacted); #2 MED dedup prefers an authed principal over shared NAT IP; #3 LOW 0X
uppercase hex; #4 LOW pre-redaction size cap (DoS bound on the public route). 68 green.

**sol rounds 3–6** — the adversarial loop converged on the public sink:
- r3 (5): hex `_`-adjacency lookarounds; method HTTP-verb allowlist; path pre-cap before
  split; email drop-if-redaction-alters; namespace-tagged dedup principal.
- r4 (3, 0 HIGH): fixed an r3 over-correction (blanket boundary removal → over-redaction)
  with precise `(?<![A-Za-z0-9])` lookarounds; added CONNECT/TRACE; email length-before-trim.
- r5 (1): email length check before trim.
- r6 (1, cosmetic): flipped r5 → trim first, cap the NORMALIZED email; "no other
  correctness issues." Applied the cleaner version and STOPPED per stop-at-done.

**Converged.** Findings/round: 6 → 4 → 5 → 3 → 1 → 1(cosmetic). HIGH: 2 → 1 → 1 → 0 → 0 → 0.
Commits `c4b86cf2` (build) → `5868961b` → `87418838` → `3b13e3f0` → `18b99a84` → `6fde1516`
→ `58f924db`. Phase 2 DONE.

_(Fable declined the Phase 1 + Phase 2 designs — hard classifier block on the security
vocab — so Opus designed + built per the fallback directive; sol did the 8 review rounds
total across both phases.)_

_(Fable declined the Phase 1 + Phase 2 designs — hard classifier block on the security
vocab — so Opus designed + built per the fallback directive; sol does the review rounds.)_

### Phase 3 — analysis: troubleshooting view + daily report — DONE ✅

Makes the feedback+logs analyzable in the existing surfaces.
- `/api/feedback` emits the `agent.report` audit event the admin-observability views
  read → the funnel/journey/error-histogram/feedback-stream views show the new reports
  (metadata shape mirrors `admin-observability.ts`). Old `/api/feedback/agent-report`
  is `@deprecated` (kept for back-compat).
- `scripts/daily-report.mjs`: new AGENT FEEDBACK section (by type/severity, top
  endpoints + error codes, #with-logs, recent) in the console report + saved JSON + HTML
  viewer. `summarizeFeedback` exported/pure; `getJSON` now authenticates (fixes the 401s,
  route-scoped). Terminal-escape injection hardened at ingest (`stripControl` in
  `feedback.ts`) and on display (`stripCtl`).

**Verification (local, DONE):**
- `feedback.test.ts` — audit-event shape + control-char strip.
- `feedback-observability-integration.test.ts` — **end-to-end vs a real store**: a
  posted report shows in `/api/admin/observability/feedback` + the error histogram +
  the durable `/api/admin/feedback` export.
- `summarizeFeedback` unit-checked (window bound, `__proto__` key, all-time from total).

**sol review** (3 rounds): r1 (6) redaction-of-structured-fields / terminal-injection /
pagination / auth-scoping / boundary / proto-key; r2 (4) single-line stripCtl / explicit
auth branch / safe-int total / raw-input cap; r3 (0 HIGH) Unicode-separator stripCtl —
then converged (sol began oscillating on auth-scoping). Findings/round 6→4→3, HIGH 1→1→0.

**Prod smoke — PENDING DEPLOY.** Prod runs `master` (old code: no `report_hint`,
`pcc_report`→agent-report, no logs/audit-emit). The new behavior can only be smoke-tested
on prod AFTER this PR merges + the manual deploy promotes it. Steps to run then are in the
PR / the assistant's handoff. No prod writes were made pre-deploy (nothing new to verify).

## Where feedback + logs land (for analysis)

- **Durable JSONL** — `${dirname(PCC_DB_PATH)}/feedback.jsonl` (prod: `/app/data/feedback.jsonl`, on the volume).
- **`GET /api/admin/feedback`** (`X-Admin-Token`) — full parsed export.
- **Troubleshooting view** — `GET /api/admin/observability/{feedback,errors}` are ON BY
  DEFAULT (they read the `agent.report` audit event; no `PCC_FUNNEL_ENABLED` needed).
  `funnel` + `journey/:traceId` still need `PCC_FUNNEL_ENABLED=true` (per-request journey
  recording — opt-in for perf). **Access control (fails closed):** set
  `PCC_OBSERVABILITY_ADMINS=<operatorId,…>` to grant operators; with no allowlist the
  views 403 in prod. A dev bypass requires BOTH `NODE_ENV=development` AND
  `PCC_OBSERVABILITY_DEV_OPEN=true` — a leaked var or missing `NODE_ENV` can't expose data.
- **Daily report** — `node scripts/daily-report.mjs` → AGENT FEEDBACK section (console + `ai/reports/*.json` + HTML viewer).
- **Live** — Discord webhook per report; PostHog `feedback_filed` event.

## Test surface

`packages/gateway/src/__tests__/`: `report-hint.test.ts`, `feedback.test.ts`,
`agent-package-auto-feedback.test.ts`. Wiring script:
`scripts/update-agent-package-auto-feedback.mjs` (idempotent). Server:
`packages/gateway/src/server.ts` (setErrorHandler + onSend), `report-hint.ts`,
`routes/feedback.ts`.
