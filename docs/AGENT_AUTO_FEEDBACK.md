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

### Phase 2 — bounded `logs` + server-side secret redaction + dedup + telemetry — IN PROGRESS

Scope: an optional bounded `logs` array on `pcc_report`/`/api/feedback` (recent step
summaries, not bodies); **server-side redaction** of secret-shaped strings on ingest
(defense-in-depth over the agent-side "never send secrets"); dedup to collapse
retry-loops; fold the orphaned `/api/feedback/agent-report` OTel/PostHog telemetry into
`/api/feedback`. Rounds logged below.

- _round 1: pending_

### Phase 3 — admin/observability view + deprecate agent-report — NOT STARTED

## Test surface

`packages/gateway/src/__tests__/`: `report-hint.test.ts`, `feedback.test.ts`,
`agent-package-auto-feedback.test.ts`. Wiring script:
`scripts/update-agent-package-auto-feedback.mjs` (idempotent). Server:
`packages/gateway/src/server.ts` (setErrorHandler + onSend), `report-hint.ts`,
`routes/feedback.ts`.
