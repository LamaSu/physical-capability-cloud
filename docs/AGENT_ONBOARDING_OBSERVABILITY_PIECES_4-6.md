# Agent-Onboarding Observability & Feedback — Design (comprehensive)

**Status**: DESIGN + REFERENCE DRAFT — HALT-safe (no deploy)
**Lane**: `observability` (coord LANE observability)
**Worktree / branch**: `/tmp/sgo-observability` → `sgo/obs-1781554598` off `master @ 799eff6`
**Supersedes / extends**: `docs/AGENT_ONBOARDING_OBSERVABILITY.md` (the piece-1-3 shipping doc, merged in PR #141)
**Author**: implementer (observability follow-on)
**Date**: 2026-06-15

---

## 0. TL;DR — what this document is

PR **#141** (`f61b3ec`) already shipped the **substrate** of agent-onboarding
observability: trace-id correlation (piece 1), rich agent-readable `Result<T>`
errors (piece 2), and the `pcc_report` feedback tool + system_prompt line
(piece 3). Pieces **4 (onboarding funnel), 5 (centralized sink + troubleshooting
view + alerts), and 6 (synthetic canary)** were explicitly **deferred**.

This document is the **comprehensive end-to-end design** for the whole system,
and the **follow-on** that designs + reference-drafts the three deferred pieces.
It is grounded in the real substrate:

| Grounding anchor | File | What it gives us |
|---|---|---|
| Telemetry | `packages/gateway/src/telemetry.ts` (`PipelineTelemetryService`) | per-job ring buffer, OTel span events, Sentry breadcrumbs, SSE publish |
| Result type | `packages/spec/src/types/result.ts` (`PCCError`, `errRich`, `stampTrace`, `Errors.*WithHint`) | rich error envelope (trace_id + hint + docs) — **shipped** |
| Trace id | `packages/gateway/src/middleware/trace-id.ts` (`tr_<16hex>`, `x-pcc-trace-id`) | per-request correlation id, OTel span attr `pcc.trace_id` — **shipped** |
| Feedback | `packages/gateway/src/routes/agent-feedback.ts` (`POST /api/feedback/agent-report`) | `pcc_report` sink → `auditService` + PostHog + OTel — **shipped** |
| Agent package | `apps/dashboard/public/agent-package.json` (v2.14.0, 249 tools) | `pcc_report` tool + system_prompt friction line — **shipped** |
| Agent health | `packages/gateway/src/routes/agent-heartbeat.ts` (`GET /api/agents/health`) | liveness model the canary heartbeats into |
| OTel | `packages/gateway/src/otel.ts` (`OTLPTraceExporter` when `OTEL_EXPORTER_OTLP_ENDPOINT` set) | the export path the sink subscribes to |
| Audit sink | `packages/gateway/src/services/audit-service.ts` (`log`/`query`/`stats`) | durable append-only event store + ETL source |
| Analytics | `packages/gateway/src/services/posthog-service.ts` (`trackServerEvent`) | server-side PostHog — funnel adopt path |
| DB | `packages/gateway/src/db.ts` (SQLite via `@pcc/store`) | the **operator-facing** DB — deliberately *not* the private sink |

**The constraint is HALT-safe**: everything wired in this PR is inert by default
(`PCC_FUNNEL_ENABLED` defaults off; the canary GitHub workflow is gated on a
`CANARY_ENABLED` repo variable). The centralized private DB (piece 5) ships as
pure reference (DDL + ETL + alert rules) — no live migration, no new runtime
dependency.

---

## 1. The problem we are closing

Real agents consume `agent-package.json` and try to onboard as **users**
(discover → build → fund → submit → settle) or **operators** (provision →
detect → register device → test-job → prove). When they hit a silent 500,
take a wrong branch, or give up, **we cannot see why**. This is the exact pain
we hit debugging the V1/V2 settlement 500s (#138–#145): an opaque error with
no thread back to the agent's journey and no path forward for the agent.

The six pieces, as a system, give us:

1. **A thread to pull** — one `trace_id` per agent journey, on every request/response/log/span. *(shipped)*
2. **A path forward for the agent** — every error carries a `hint` + `docs` URL it can act on. *(shipped)*
3. **A back-channel** — the agent can file friction reports tied to its `trace_id`. *(shipped)*
4. **A shape of failure** — where in the funnel agents drop off. *(this PR — draft)*
5. **A place to look** — a centralized sink + troubleshooting view (journey replay, error rates, feedback stream) and **alerts**. *(this PR — reference draft)*
6. **A smoke alarm** — a synthetic canary that walks the real onboarding loop on a loop and screams before real agents hit a regression. *(this PR — draft)*

```
                      ┌─────────────────────────────────────────────────────┐
   agent ── x-pcc-trace-id ──▶  PCC Gateway (Fastify monolith)                │
   (consumes               │   ┌──────────────┐  ┌───────────────────────┐   │
    agent-package.json)    │   │ trace-id mw  │  │ funnel-tracker (P4)    │   │
        ▲                  │   │  (P1)        │  │  onResponse → stage    │   │
        │ trace_id +       │   └──────┬───────┘  └───────────┬───────────┘   │
        │ hint + docs (P2) │          │                      │               │
        │                  │   errRich/stampTrace (P2)        │               │
        │  pcc_report (P3) ─┼──▶ /api/feedback/agent-report ──┤               │
        └──────────────────┘          │                      │               │
                                       ▼                      ▼               │
              ┌──────────────┐  ┌─────────────┐  ┌────────────────────────┐  │
              │ OTel spans   │  │ auditService│  │ PostHog (identify+      │  │
              │ pcc.trace_id │  │  (SQLite)   │  │  capture, distinct=trace│  │
              └──────┬───────┘  └──────┬──────┘  └───────────┬────────────┘  │
                     │                 │                     │               │
        OTLP exporter│        ETL cron │             PostHog │ funnels       │
        (existing)   │        (P5)     │             (cloud) │ (P4 view)     │
                     ▼                 ▼                     ▼               │
        ┌────────────────────────────────────────────────────────────┐     │
        │  Centralized PRIVATE sink (P5)  —  Postgres + TimescaleDB    │     │
        │  agent_trace_events · agent_reports · agent_funnel_events ·  │     │
        │  agent_canary_runs   +  continuous-aggregate funnel view     │     │
        └───────────────┬───────────────────────────┬──────────────────┘    │
                        │ troubleshooting view (P5)  │ alert-evaluator (P5)   │
                        ▼                            ▼                        │
              journey-by-trace_id · funnel ·   new-error-class · funnel-drop ·│
              error-rates · feedback stream    report-spike  → Slack/page     │
                                                                              │
   Sentry Trace Explorer (existing) ── interactive trace-by-id waterfall ─────┘
   GitHub Actions cron ──▶ canary-agent (P6) ──▶ full onboarding loop on staging
                                  └─ on fail: pcc_report(agent_kind=canary) + non-zero exit + open issue
```

---

## 2. What already shipped (pieces 1–3) — the substrate this builds on

These are **done and merged** (#141). Summarized here so the design is
self-contained; see `docs/AGENT_ONBOARDING_OBSERVABILITY.md` for the original
shipping notes.

### Piece 1 — trace correlation
`middleware/trace-id.ts` registers a **non-encapsulated** (`skip-override`)
`onRequest`/`onSend` hook pair. It mints `tr_<16hex>` (or echoes a well-formed
incoming `x-pcc-trace-id`), decorates `req.traceId`, sets the OTel span
attribute `pcc.trace_id`, and echoes the header on every response. Registered
in `server.ts` at line 332 (after `siweAuthPlugin`, before `apiGate`). Entry
routes (`/api/auth/provision`, `/api/onboard/redeem`) additionally surface
`trace_id` in the JSON body.

### Piece 2 — rich `Result<T>` errors
`PCCError` gained three **optional** fields: `trace_id`, `hint`, `docs`
(backward-compatible — existing `err()` callers untouched). New factories:
`errRich()`, `stampTrace(result, trace_id)`, and `Errors.{notFound,badRequest,
unauthorized,forbidden}WithHint`. This is the fix for the silent-500 pain: an
agent that gets `BUILD_OPTIONS_INVALID` now also gets *"provide a `type` from
`list_capability_types` first"* + a docs link + its `trace_id`.

### Piece 3 — `pcc_report` feedback tool
`routes/agent-feedback.ts` exposes `POST /api/feedback/agent-report` (PUBLIC,
IP-rate-limited 30/hr). It writes to `auditService.log({eventType:
"agent.report"})`, fires `trackServerEvent("agent_report_filed")`, and emits the
OTel span `pcc.feedback.agent_report`. The `pcc_report` tool is in
`agent-package.json` (v2.14.0) and the system_prompt already instructs agents:
*"When you get stuck… call `pcc_report` with your `trace_id`… every report goes
to a dashboard that the team reads."* **That dashboard is piece 5, which this
follow-on builds.**

---

## 3. Landscape — adopt / extend / build (wheel-scout gate)

Full report: the scout evaluated ≥3 named, currently-maintained (2025–2026)
solutions per area, weighing the fact that **PostHog, OTel, and Sentry are
already in the stack**. Condensed verdicts:

### Piece 4 — funnel analytics → **ADOPT PostHog**
| Solution | Solves it? | In stack? | Verdict |
|---|---|---|---|
| **PostHog Funnels** | Fully | **Yes** | **ADOPT** |
| Amplitude | Fully | No | Skip (2nd vendor, no marginal benefit) |
| Mixpanel | Fully | No | Skip |
| Custom SQL funnel table | Fully | Partially | Keep as durable audit-trail fallback |

PostHog `capture()` accepts any string as `distinct_id`, so we key every
onboarding event on `trace_id`. **Gotcha the design must honor:** PostHog funnel
*conversion* requires **identified** events — we must call `posthog.identify(trace_id)`
once (at the `provision` stage) to anchor the person profile; anonymous capture
alone under-counts. Sources: [PostHog funnels](https://posthog.com/docs/product-analytics/funnels),
[identity resolution](https://posthog.com/docs/product-analytics/identity-resolution).

### Piece 5 — troubleshooting view + sink → **EXTEND Sentry, ADOPT Postgres/TimescaleDB**
| Solution | Solves it? | In stack? | Verdict |
|---|---|---|---|
| **Sentry Trace Explorer** | Fully (trace-by-id waterfall, error-linked) | **Yes** | **EXTEND** (zero new infra) |
| **Grafana Tempo + TraceQL** | Fully (cheap trace-by-id at volume) | No (but OTLP wired) | ADOPT later (config-only via OTel Collector) |
| Jaeger | Fully | No | Skip (needs Cassandra/ES) |
| Highlight.io / OpenReplay | Partially (browser replay, not server HTTP) | No | Skip |
| **Sink: Postgres+TimescaleDB** | Fully | Partially (SQLite→PG natural step) | **ADOPT** for sink |
| Sink: ClickHouse | Fully (high volume) | No | Defer until >1M spans/day |

"Show me everything for `trace_id` X" is **free today** in Sentry's Trace
Explorer if `@sentry/node` instruments the handlers; Tempo is the volume/retention
upgrade (route a copy of OTLP spans via the collector — no code). For the
relational sink (funnel/reports/canary rows + custom journey view),
**TimescaleDB** wins on ops-simplicity at startup scale (continuous aggregates,
team already knows Postgres). Sources: [Sentry Trace Explorer](https://docs.sentry.io/product/explore/traces),
[Tempo TraceQL](https://grafana.com/docs/tempo/latest/traceql/),
[Timescale vs ClickHouse benchmark](https://dev.to/aws-builders/i-benchmarked-timescaledb-vs-clickhouse-vs-mongodb-for-observability-data-the-results-surprised-me-3d7d).

### Piece 6 — synthetic canary → **BUILD (minimal) on GitHub Actions cron**
| Solution | Solves it? | Verdict |
|---|---|---|
| **GitHub Actions cron + Node script** | Fully | **BUILD** |
| Checkly (multistep API) | Fully | EXTEND path (if multi-region/guaranteed scheduling needed; ~$24/mo) |
| Grafana k6 synthetic | Partially | Skip (adds Grafana Cloud) |
| Uptime Kuma | Partially (heartbeat only) | **Pair** as dead-man's-switch |
| Datadog Synthetics | Fully | Skip (cost, vendor) |

No hosted synthetic service can **consume our own `agent-package.json` and file
a `pcc_report` on failure** — that is the requirement, so we build a ~100-line
Node script. GH Actions scheduled workflows can be silently delayed/skipped and
auto-disable after 60 days inactivity → pair with an Uptime-Kuma push heartbeat.
Sources: [GH Actions schedule](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule),
[Checkly synthetic](https://www.checklyhq.com/product/synthetic-monitoring/),
[Uptime Kuma](https://github.com/louislam/uptime-kuma).

---

## 4. Piece 4 — Onboarding funnel telemetry

**Goal.** Per-`trace_id` counters at each onboarding stage so we can see drop-off:

```
provision  → 100%  (entry)
discover   →  73%  (first /api/capabilities* 2xx)
build      →  58%  (first /api/build/contract 2xx)
fund       →  42%  (first /api/escrow/fund or /api/fiat-ramp/onramp/* 2xx)
submit     →  29%  (first /api/jobs/submit 2xx)
settle     →  17%  (first /api/escrow/:id/release 2xx)
```

**Design.** A Fastify `onResponse` hook (`services/funnel-tracker.ts`) — registered
right after the trace-id plugin, also non-encapsulated so it sees every route —
classifies `(method, routeOptions.url, statusCode)` into a stage, dedupes once
per `(trace_id, stage)`, and emits **three** sinks:

1. **Durable** — `auditService.log({ eventType: "agent.funnel", resourceId:
   trace_id, action: stage, metadata: { route, status, stage } })`. This is the
   fallback funnel table (queryable via `/audit` today, ETL'd to the private DB
   in piece 5).
2. **Analytics** — on the `provision` stage, `identifyAgent(trace_id)` (new
   `posthog-service` helper) to anchor the profile, then for every stage
   `trackServerEvent("onboarding_" + stage, { trace_id, route, status },
   /*distinctId*/ trace_id)`. PostHog reconstructs the funnel chart natively.
3. **Trace** — span event `pcc.funnel.<stage>` on the active OTel span, so the
   Tempo/Sentry waterfall shows funnel progress inline.

**Stage detection** (`detectStage`):

| Stage | Rule (2xx only) |
|---|---|
| provision | `POST /api/auth/provision` OR `POST /api/onboard/redeem` |
| discover | `GET /api/capabilities` / `…/types` / `…/search` / `…/by-*` |
| build | `POST /api/build/contract` |
| fund | `POST /api/escrow/fund` OR `POST /api/fiat-ramp/onramp/*` |
| submit | `POST /api/jobs/submit` |
| settle | `POST /api/escrow/:id/release` |

**Read API** (`getFunnelForTraceId`, `getCohortFunnel`) reads back from
`auditService.query({ eventType: "agent.funnel", since })`. Exposed via
admin routes (piece 5 view). Dedup state is a bounded LRU `Map<trace_id,
Set<stage>>` (cap 5000 journeys) — the durable record is the audit log, so
restart just loses in-memory dedup (a stage may double-count once; acceptable,
and the private-DB version dedupes on the `(trace_id, stage)` primary key).

**HALT-safe.** The whole plugin is a no-op unless `PCC_FUNNEL_ENABLED==="true"`.
Server.ts gains exactly one `await app.register(funnelTrackerPlugin)` line; the
plugin self-disables. No behavior change on merge.

**Reference drafts (this PR):**
- `packages/gateway/src/services/funnel-tracker.ts` (new) — plugin + detection + read API
- `packages/gateway/src/services/posthog-service.ts` (edit) — `identifyAgent(traceId, props?)`
- `packages/gateway/src/server.ts` (edit) — 1 register line (flag-gated inside plugin)
- `packages/gateway/src/__tests__/funnel-tracker.test.ts` (new) — stage detection + dedup + read aggregate

---

## 5. Piece 5 — Centralized private-DB sink + troubleshooting view + alerts

Per coord doc #062, all observability flows land in the **owner-ruled PRIVATE
DB** — *not* the operator-facing gateway SQLite (`db.ts`). This PR ships the
sink as **pure reference** (DDL + ETL + alert rules); no live migration.

### 5.1 Data model — Postgres + TimescaleDB (`ops/observability/schema.sql`)

```sql
CREATE SCHEMA IF NOT EXISTS pcc_observability;
-- agent_trace_events: one row per significant request (ETL from audit + OTLP)
-- → hypertable on ts; indexed by trace_id for journey replay
-- agent_reports:      pcc_report rows (ETL from eventType='agent.report')
-- agent_funnel_events: (trace_id, stage) PK — deduped funnel progression
-- agent_canary_runs:  one row per canary loop (pass/fail + stage reached)
-- + continuous aggregate `funnel_cohort_daily` materializing daily conversion
```

(Full DDL + the four troubleshooting **views** are in the file.)

### 5.2 Troubleshooting view — layered, cheapest-first

1. **Interactive trace-by-id → Sentry Trace Explorer (already wired).** No new
   infra. Paste the `trace_id`; Sentry shows the span waterfall + linked errors.
   This covers the "replay one agent's journey" need for day-to-day debugging.
2. **Relational views over the private DB** (`ops/observability/schema.sql`):
   - `view_agent_journey(trace_id)` — full ordered event list per journey.
   - `view_funnel_cohort(since, until)` — funnel by date cohort (backed by the
     continuous aggregate).
   - `view_error_class_freq(since)` — error-code histogram (drives "new error
     class" alert).
   - `view_agent_friction_stream(since)` — recent `pcc_report`s joined to their
     journey + funnel stage reached.
3. **High-volume trace search → Grafana Tempo (later).** Config-only: add an
   `otlphttp` exporter to the OTel Collector pointing at Tempo, in parallel with
   the existing `OTEL_EXPORTER_OTLP_ENDPOINT`. No gateway code change.
4. **In-gateway admin read API** (`routes/admin-observability.ts`, flag-gated,
   authed, admin-allowlisted) — surfaces the same funnel/journey/error/feedback
   reads from the **audit log today** so the view works before the private DB
   exists; the production deployment points these handlers at the private DB.

### 5.3 Ingestion — two paths, both already feasible

- **Spans** — the existing `OTLPTraceExporter` (`otel.ts`) ships every span
  tagged with `pcc.trace_id` to `OTEL_EXPORTER_OTLP_ENDPOINT`. Point the
  collector at the sink (Tempo and/or a span→Postgres processor). No code.
- **Audit/report/funnel rows** — a cron ETL
  (`scripts/observability/etl-audit-to-private-db.mjs`) reads
  `auditService.query({ eventType: "agent.*", since })` in batches and upserts
  into the private DB. Uses a dynamic `import("pg")` with graceful degrade (same
  pattern as `posthog-service.ts`) so **no new hard dependency** is added.

### 5.4 Alerts (`scripts/observability/alert-evaluator.mjs`)

Reads the views and fires on:
- **New error class** — an `error_code` in `view_error_class_freq(last 1h)`
  never seen in the prior 30 days → Slack notify.
- **Funnel-stage drop** — any stage's conversion in `view_funnel_cohort(today)`
  is >X% (default 20) below its trailing 7-day mean → page on-call.
- **Report spike** — `pcc_report` rate >Y/hour (default 10) → page on-call.
- **Canary down** — no `agent_canary_runs` row with `ok=true` in the last 15 min
  → page (this is the dead-man's-switch crossover with piece 6).

Thresholds are env-configurable; the script is a reference (cron-runnable) draft
using stdlib `fetch` for the Slack webhook + dynamic `import("pg")`.

**Reference drafts (this PR):**
- `ops/observability/schema.sql` — DDL + continuous aggregate + 4 views
- `scripts/observability/etl-audit-to-private-db.mjs` — audit→private-DB ETL
- `scripts/observability/alert-evaluator.mjs` — the 4 alert rules
- `packages/gateway/src/routes/admin-observability.ts` — read API (flag+admin gated)

---

## 6. Piece 6 — Synthetic canary agent

**Goal.** Run the FULL onboarding loop end-to-end against staging on a ~5-min
cron, consuming the **real** `agent-package.json` (not a hardcoded list), so we
catch regressions before real agents do.

**Design** (`scripts/canary-agent-onboarding.mjs`, plain Node, stdlib `fetch`):

1. **Fetch the real contract** — `GET <target>/agent-package.json`. Resolve the
   `provision_api_key` and the stage tools (`list_capability_types`,
   `get_build_options`, `calculate_price`, `build_contract`, `pcc_report`) from
   the package's `tools[].endpoint` mapping — so if an endpoint path changes in
   the package, the canary follows it automatically.
2. **Provision** a fresh key via `POST /api/auth/provision` (test identity).
   Save the returned `trace_id`.
3. **Echo `x-pcc-trace-id: <trace_id>`** on every subsequent call — exercises the
   piece-1 propagation exactly as a real agent would.
4. **Walk the funnel** (read-mostly — does NOT fund/submit real jobs on staging):
   `discover` (list types + search) → `build` (build options → calculate price →
   build contract). Each step asserts `2xx` and a well-formed `Result<T>`/body.
5. **On any failure** — file `POST /api/feedback/agent-report` with
   `agent_kind: "canary"`, the failing `last_endpoint`, `last_error_code`, the
   `trace_id`, and a `detail` dump → then **exit non-zero** so the cron alerts.
   This dogfoods piece 3 and seeds piece 5's friction stream with a labeled,
   reproducible report.
6. **On success** — emit a heartbeat: `POST /api/agents/heartbeat
   {agentId:"canary"}` (best-effort — tolerates 404 if not pre-registered in the
   `agent-heartbeat-monitor`) AND, if `CANARY_HEARTBEAT_URL` is set, GET it
   (Uptime-Kuma-style push) as a dead-man's-switch.

**Scheduling** (`.github/workflows/canary-agent.yml`):
- `on: schedule: "*/5 * * * *"` **and** `workflow_dispatch`.
- **HALT-safe gate:** the job runs only `if: vars.CANARY_ENABLED == 'true'` and
  targets `${{ vars.STAGING_URL }}`. Until those repo variables are set, the
  workflow is inert even if merged — nothing deploys, nothing runs against any
  environment. Enabling the canary is a deliberate, separate action.
- On failure: opens/updates a GitHub issue labeled `canary-fail` (`permissions:
  issues: write`).

**Why the canary depends on 1+3 (and benefits from 4+5):** it needs the
`trace_id` substrate (so its failures are replayable), the `pcc_report` route
(its failure channel), and — once piece 4/5 land — its failures carry funnel-diff
context ("regressed at the `build` stage") straight into the troubleshooting view.

**Reference drafts (this PR):**
- `scripts/canary-agent-onboarding.mjs` — the loop (consumes real agent-package.json)
- `.github/workflows/canary-agent.yml` — cron + dispatch, gated inert

---

## 7. Privacy, security, retention

- **`pcc_report` is PUBLIC + unauthenticated** (stuck agents may have no key) —
  already IP-rate-limited (30/hr). The private-DB sink stores reports verbatim;
  the ETL **must redact** any token-shaped strings in `detail`/`summary` before
  insert (reuse the gateway's DLP redactor patterns — `middleware/dlp-redactor`).
- **trace_id is not a secret** but correlates a journey — keep the troubleshooting
  view behind admin auth (`PCC_OBSERVABILITY_ADMINS` allowlist) + the feature flag.
- **Retention** — TimescaleDB drop-chunks policy: `agent_trace_events` 30 days,
  `agent_funnel_events`/`agent_reports`/`agent_canary_runs` 1 year (aggregates
  kept indefinitely). Set via `add_retention_policy`.
- **No new runtime dependency** is added to the gateway: funnel-tracker uses only
  existing imports; ETL/alerts/canary are `scripts/` (dynamic `import("pg")`,
  graceful degrade) → **Gate A clean** (no `package.json` change to vet).

---

## 8. Rollout plan (HALT-safe → live, in order)

| Step | Action | Gate |
|---|---|---|
| 0 | **This PR** — design + drafts, all inert. | merge (no behavior change) |
| 1 | Set `PCC_FUNNEL_ENABLED=true` on **staging** gateway. | observe funnel events in `/audit` + PostHog |
| 2 | Verify PostHog funnel chart (identify+capture keyed on trace_id). | manual review |
| 3 | Stand up the private DB (Postgres+Timescale), apply `schema.sql`. | owner-ruled infra task |
| 4 | Schedule the ETL (`etl-audit-to-private-db.mjs`) + alert-evaluator cron. | dry-run first (`--dry-run`) |
| 5 | Wire Sentry Trace Explorer access for the team (verify spans arrive). | manual |
| 6 | Set `CANARY_ENABLED=true` + `STAGING_URL` repo vars → canary goes live. | watch first runs green |
| 7 | Flip `PCC_FUNNEL_ENABLED=true` on **prod** once staging is clean. | sign-off |
| 8 | (Later) add Tempo via OTel Collector if trace volume/retention demands. | config-only |

---

## 9. File manifest (this PR)

| Piece | File | New/Edit | Wired? |
|---|---|---|---|
| design | `ai/research/agent-onboarding-observability.md` | new | n/a |
| 4 | `packages/gateway/src/services/funnel-tracker.ts` | new | yes (flag-gated) |
| 4 | `packages/gateway/src/services/posthog-service.ts` | edit | yes (`identifyAgent`) |
| 4 | `packages/gateway/src/server.ts` | edit | yes (1 register line) |
| 4 | `packages/gateway/src/__tests__/funnel-tracker.test.ts` | new | test |
| 5 | `packages/gateway/src/routes/admin-observability.ts` | new | yes (flag+admin gated) |
| 5 | `ops/observability/schema.sql` | new | reference |
| 5 | `scripts/observability/etl-audit-to-private-db.mjs` | new | reference |
| 5 | `scripts/observability/alert-evaluator.mjs` | new | reference |
| 6 | `scripts/canary-agent-onboarding.mjs` | new | reference |
| 6 | `.github/workflows/canary-agent.yml` | new | inert (gated) |

---

## 10. Open questions for review

1. **PostHog `identify` cost** — anchoring a person profile per `trace_id` creates
   one PostHog person per agent journey. At canary cadence + real traffic this is
   fine; at scale consider a coarser `distinct_id` (e.g. operator_id when known,
   trace_id only for anonymous). *Recommendation: trace_id for anonymous/onboarding,
   switch to operator_id post-provision.*
2. **Sink = private DB vs PostHog** — PostHog already stores the funnel; do we
   need the relational sink on day one? *Recommendation: yes, but only as the ETL
   target — it's the system of record for the canary + reports + journey replay
   that PostHog's model (distinct_id-centric) reconstructs awkwardly.*
3. **Admin auth for the troubleshooting read API** — allowlist env var
   (`PCC_OBSERVABILITY_ADMINS`) vs a proper `observability:read` scope in the
   existing `scopeChecker`. *Recommendation: ship the allowlist now; migrate to a
   scope when the RBAC table gains the permission.*
4. **Canary write-safety on staging** — the canary is read-mostly (no fund/submit).
   Do we ever want a full settle loop on a dedicated test kernel? *Recommendation:
   keep read-mostly for the 5-min canary; add a separate nightly "deep canary"
   that does a full settle against a mock kernel.*
5. **Funnel dedup after restart** — in-memory dedup loses state on deploy. Accept
   the rare double-count, or move dedup to the audit-log read path? *Recommendation:
   accept it; the private-DB `(trace_id, stage)` PK is the real dedup.*

---

## 11. References

- `docs/AGENT_ONBOARDING_OBSERVABILITY.md` — pieces 1-3 shipping doc (#141)
- coord #062 (private-DB ownership), #066 (observability lane)
- Substrate: `telemetry.ts`, `result.ts`, `trace-id.ts`, `agent-feedback.ts`,
  `otel.ts`, `audit-service.ts`, `posthog-service.ts`, `agent-heartbeat.ts`,
  `db.ts`, `agent-package.json`
- Landscape sources: PostHog funnels/identity, Sentry Trace Explorer, Grafana
  Tempo/TraceQL, Checkly, Uptime Kuma, Timescale-vs-ClickHouse benchmark (URLs in §3)
