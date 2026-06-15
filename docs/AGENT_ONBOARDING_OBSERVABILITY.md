# Agent-Onboarding Observability — Design

**Status**: REFERENCE DRAFT
**Branch**: `feat/agent-onboarding-observability`
**Base**: `lamasu/master` @ `512d7c3`
**Author**: implementer-papa (per inbox observability lane, #066)
**Date**: 2026-06-14

## Why this file exists

Real agents consuming `agent-package.json` and trying to onboard as users
or operators will hit silent 500s, take wrong branches, give up — and we
need to see WHY. Today the gateway already has good OTel + an
in-memory `TraceCollector` for self-traces (`packages/gateway/src/trace-collector.ts`),
but they are not stitched into the per-agent onboarding journey. The
existing `Result<T>` carries `code` + `message` + `httpStatus` but no
`hint` or `docs` field — so the agent has no path forward when an error
fires. There is no first-class `pcc_report` feedback tool, no funnel
view, no canary, and no centralized private-DB sink for cross-agent
analysis.

This document defines the 6-piece observability + feedback system that
closes the gap. This PR ships the design doc plus reference-drafts for
pieces 1-3 (the substrate-touching ones). Pieces 4-6 are documented
here and deferred to a follow-on PR — they layer on top of the trace_id
substrate this PR introduces.

## The six pieces

### 1. Trace correlation (`x-pcc-trace-id` header propagation)

**Problem**. An agent calls `POST /api/auth/provision`, gets a key,
later calls `POST /api/build/contract`, that fails. There is no thread
to follow that connects the two calls into one "this agent's onboarding
journey". OTel traces exist per-request but the agent itself never sees
a trace ID to quote back when filing a report.

**Solution**.

1. Mint a `trace_id` at the two onboarding-entry routes:
   - `POST /api/auth/provision` — every new agent that lands here gets
     a stamped trace_id returned in the response body AND set in the
     `x-pcc-trace-id` response header.
   - `POST /api/onboard/redeem` — same treatment for the
     invite-code path.

2. The agent is instructed (via `agent-package.json` system_prompt
   update) to echo the trace_id in the `x-pcc-trace-id` request header
   on EVERY subsequent call. The gateway reads that header, propagates
   it as an OTel span attribute, and stamps it on telemetry/logs.

3. An incoming `x-pcc-trace-id` header is honored on its own — even on
   non-entry routes. Routes that don't see one mint a fresh one for
   internal correlation but it is NOT treated as a "journey".

**Implementation surface**.

- New plugin `packages/gateway/src/middleware/trace-id.ts` registers an
  `onRequest` hook. The hook:
  - Reads `x-pcc-trace-id` from the incoming request.
  - If absent: mints `tr_<random16hex>` and stamps the request.
  - If present: validates shape `^tr_[0-9a-f]{16,32}$`, accepts or
    mints a fresh one if malformed.
  - Decorates `req.traceId` (typed accessor).
  - Sets the trace_id on the active OTel span via
    `trace.getActiveSpan()?.setAttribute("pcc.trace_id", req.traceId)`.
  - Adds `onSend` hook to set `x-pcc-trace-id` response header.

- `routes/provision.ts` — on the 201 success branch, include
  `trace_id: req.traceId` in the response body.
- `routes/onboard.ts` `/redeem` — same treatment.

**Why an `onRequest` plugin and not just route-local code**. We want
EVERY call (not only entry routes) to carry the header through, so the
OTel span attribute always exists. Entry routes additionally surface
the trace_id in the JSON body so the agent can save it.

**Out of scope for THIS PR**. The OTLP exporter side that ships
trace_id-tagged spans to the centralized sink (piece 5) is wired
implicitly through existing `OTEL_EXPORTER_OTLP_ENDPOINT` config —
this PR does not change that.

### 2. Rich agent-readable `Result<T>` errors

**Problem**. Today's `PCCError` shape is:

```typescript
{ code, message, details?, retryable, httpStatus }
```

An agent that gets `"code": "WORKFLOW_DAG_INVALID"` cannot recover —
there is no `hint` ("provide an `outcomeType` and a non-empty `steps`
array") and no `docs` URL pointing at the relevant guide section.

**Solution**. Extend `PCCError` with three new OPTIONAL fields:

```typescript
export interface PCCError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
  httpStatus: number;
  /** Stamped at error boundary; identifies the agent's onboarding journey */
  trace_id?: string;
  /** Human-readable suggestion: "try X first, then retry" */
  hint?: string;
  /** Documentation URL — relative path or absolute URL */
  docs?: string;
}
```

**Backward compatibility**. All three fields are OPTIONAL. Existing
`err()` calls keep working. Callers that consume `Result<T>` and
destructure `{ code, message }` keep working.

**New helper factory**. `errRich(code, message, httpStatus, opts)`
accepts `hint` and `docs` in `opts`. Plus convenience helpers:

```typescript
export const Errors = {
  // ... existing ...
  notFoundWithHint: (entity, id, hint, docs) =>
    errRich(`${entity.toUpperCase()}_NOT_FOUND`, ..., 404, { hint, docs }),
  badRequestWithHint: (message, hint, docs, details?) =>
    errRich("BAD_REQUEST", message, 400, { hint, docs, details }),
} as const;
```

**Auto-stamping trace_id at the route boundary**. The trace-id
middleware sets `req.traceId`. The simplest pattern: at the route
boundary where a `Result<T>` Err is serialized to a reply, call the
new helper `stampTrace(err, req.traceId)` which returns an Err with
`error.trace_id = traceId`. The existing `BaseFacade.execute()` does
not need to change — facades are not request-aware. Routes do.

A small helper `packages/gateway/src/middleware/result-serializer.ts`
holds `stampTrace()` and a `sendResult(reply, req, result)` shorthand.

### 3. `pcc_report` feedback tool

**Problem**. When agents get stuck, they have nowhere to send their
trace_id + a description of what confused them. Real-world friction
data never reaches us.

**Solution**.

- New route `POST /api/feedback/agent-report` registered via
  `packages/gateway/src/routes/agent-feedback.ts`. PUBLIC (no auth
  required — stuck agents may not have a key yet).
- Body shape:
  ```typescript
  {
    trace_id?: string,           // What they have so far
    summary: string,             // 1-line description
    detail?: string,             // Multi-line context
    last_endpoint?: string,      // Which route they were on
    last_error_code?: string,    // From a Result<T> error
    agent_kind?: string,         // "claude", "gpt-4o", etc.
    confused_about?: string,     // Free-form category
  }
  ```
- Stored in a new table `agent_reports` (schema design: piece 5 below;
  this PR uses the existing audit-service + telemetry as the temporary
  sink — see "Storage in this PR" below).
- Emits OTel event `pcc.feedback.agent_report` so the centralized sink
  can subscribe.
- Returns `{ ok: true, report_id, trace_id }`.

- Add `pcc_report` tool entry to `agent-package.json` via
  `scripts/update-agent-package-v2.14-observability.mjs`:
  ```json
  {
    "name": "pcc_report",
    "description": "Report friction, confusion, or bugs you hit while onboarding ...",
    "endpoint": { "method": "POST", "path": "/api/feedback/agent-report" }
  }
  ```

- Add ONE sentence to the `system_prompt`:
  > When you get stuck, confused, or hit an error you cannot recover
  > from, call `pcc_report` with your `trace_id` and a brief summary.
  > This is how PCC learns about agent friction.

**Storage in this PR**. The route persists reports via the existing
`auditService.log()` (under `eventType: "agent.report"`) AND emits a
telemetry event. A dedicated table + private-DB sink (piece 5) is
deferred to the follow-on. This way piece 3 ships now without
schema-migration risk; the data is preserved in the audit log until
the dedicated table lands.

### 4. Onboarding funnel telemetry (DEFERRED to follow-on)

**Goal**. Per-trace_id counters at every onboarding stage:

```
provision  → 100% (entry)
discover   →  73% (first /api/capabilities call)
build      →  58% (first /api/build/contract)
fund       →  42% (first wallet fund)
submit     →  29% (first /api/jobs/submit)
settle     →  17% (first /api/escrow/release)
```

**Implementation sketch**.

- New module `packages/gateway/src/services/funnel-tracker.ts`:
  - Detects "stage events" by route + status (e.g. discover = any 2xx
    on `/api/capabilities*`).
  - Records `{trace_id, stage, ts, route, status}` to the audit log.
  - Provides `getFunnelForTraceId(traceId)` + `getCohortFunnel(since)`
    aggregates.

- Stage map:
  | Stage | Detection rule |
  |-------|---------------|
  | provision | `POST /api/auth/provision` 201 OR `POST /api/onboard/redeem` 200 |
  | discover | First `GET /api/capabilities*` 200 with matching trace_id |
  | build | First `POST /api/build/contract` 200 with matching trace_id |
  | fund | First `POST /api/fiat-ramp/onramp/*` 200 OR `POST /api/escrow/fund` 200 |
  | submit | First `POST /api/jobs/submit` 200 |
  | settle | First `POST /api/escrow/*/release` 200 |

- Stages are recorded ONCE per trace_id (deduped by `trace_id || stage`).
- Reads at `GET /api/admin/funnel` (admin-only) and
  `GET /api/admin/funnel/:traceId` for individual journey replay.

**Why deferred**. The detection rules need design review with whoever
owns each stage definition (build/fund/settle); shipping it without
buy-in risks miscounted funnels and false alarms. Trace_id propagation
(piece 1) is the prerequisite that makes piece 4 a small follow-on PR.

### 5. Centralized private-DB sink (DEFERRED to follow-on)

Per coord doc #062, all observability flows (traces + reports + funnel)
land in the owner-ruled PRIVATE DB at item 18. This PR does NOT touch
the private-DB schema.

**Design sketch for the follow-on**.

- New schema `pcc_observability` in the private DB (NOT the operator-
  facing gateway DB):
  ```sql
  CREATE TABLE agent_trace_events (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    route TEXT NOT NULL,
    method TEXT NOT NULL,
    status INT NOT NULL,
    operator_id TEXT,
    error_code TEXT,
    span_attrs JSONB,
    INDEX (trace_id),
    INDEX (ts),
    INDEX (operator_id, ts)
  );

  CREATE TABLE agent_reports (
    id TEXT PRIMARY KEY,
    trace_id TEXT,
    ts TIMESTAMPTZ NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT,
    last_endpoint TEXT,
    last_error_code TEXT,
    agent_kind TEXT,
    confused_about TEXT,
    INDEX (trace_id),
    INDEX (ts)
  );

  CREATE TABLE agent_funnel_events (
    trace_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    route TEXT,
    PRIMARY KEY (trace_id, stage)
  );
  ```

- Ingestion path:
  - OTel spans → OTLP collector → Tempo/Jaeger-style backend on the
    private DB box. Wire by setting `OTEL_EXPORTER_OTLP_ENDPOINT` to
    the private collector.
  - Audit log entries with `eventType` starting `agent.` → batch ETL
    job (cron) that copies into `agent_reports` / `agent_trace_events`.

- Troubleshooting views:
  - `view_agent_journey(trace_id)` — full ordered event list per
    trace_id.
  - `view_funnel_cohort(since, until)` — funnel by date cohort.
  - `view_error_class_freq(since)` — error code histogram.
  - `view_agent_friction_stream(since)` — recent reports + linked
    journey.

- Alerts (also follow-on):
  - New error class never seen before → Slack notify.
  - Funnel stage drop >X% week-over-week → page on-call.
  - Report rate spike >Y/hour → page on-call.

### 6. Synthetic canary agent (DEFERRED to follow-on)

**Goal**. Run the FULL onboarding loop end-to-end against staging on a
cron (every 5 min). Catches regressions before real agents hit them.

**Implementation sketch**.

`scripts/canary-agent-onboarding.mjs`:
1. Fetch `agent-package.json` from staging.
2. Provision a fresh key via `/api/auth/provision` (test mode).
3. Save the returned trace_id.
4. Walk a small but representative subset of the onboarding tools:
   - `list_capability_types`
   - `get_build_options` for one type
   - `calculate_price`
   - `build_contract`
   - (skip actual submit — canary is read-mostly)
5. On any failure: file `pcc_report` with `agent_kind: "canary"`
   AND set non-zero exit code so the cron job alerts.
6. On success: emit one telemetry event and a healthcheck heartbeat
   to a status page (TBD).

Run via:
- `node scripts/canary-agent-onboarding.mjs --target=https://staging.capability.network`
- Wired into a GitHub Actions workflow `.github/workflows/canary-agent.yml`
  on a `schedule: */5 * * * *` cron.
- Failures open a GitHub issue labeled `canary-fail`.

**Why deferred**. The canary needs the OBSERVABILITY plumbing to be
done first — it depends on trace_id, the `pcc_report` route, and ideally
the funnel tracker for richer telemetry. Piece 1+3 ship in this PR;
piece 6 lands once piece 4+5 are in place so failures emit actionable
funnel diff data.

## Reference-draft scope for THIS PR

Pieces 1, 2, 3 are implemented with tests. Pieces 4, 5, 6 are documented
above and deferred. Concretely this PR ships:

| Piece | File(s) | Status |
|-------|---------|--------|
| 1 | `packages/gateway/src/middleware/trace-id.ts` (new) | DRAFT |
| 1 | `packages/gateway/src/server.ts` (1 register call added) | DRAFT |
| 1 | `packages/gateway/src/routes/provision.ts` (trace_id in 201) | DRAFT |
| 1 | `packages/gateway/src/routes/onboard.ts` (trace_id in /redeem) | DRAFT |
| 2 | `packages/spec/src/types/result.ts` (PCCError + errRich) | DRAFT |
| 2 | `packages/gateway/src/middleware/result-serializer.ts` (new) | DRAFT |
| 3 | `packages/gateway/src/routes/agent-feedback.ts` (new) | DRAFT |
| 3 | `packages/gateway/src/server.ts` (register feedback) | DRAFT |
| 3 | `apps/dashboard/public/agent-package.json` (pcc_report tool) | DRAFT |
| 3 | `scripts/update-agent-package-v2.14-observability.mjs` (new) | DRAFT |
| TEST | `packages/gateway/src/__tests__/trace-id-middleware.test.ts` | DRAFT |
| TEST | `packages/gateway/src/__tests__/agent-feedback.test.ts` | DRAFT |
| TEST | `packages/spec/src/types/result.test.ts` (errRich) | DRAFT |

## Open questions for review

1. **Trace-id format**. Proposed `tr_<random16hex>`. Alternatives:
   ULID, UUID, OTel-native 128-bit trace_id hex. Picked `tr_<hex>`
   because it is half the length of a UUID and visibly different from
   an operator_id or job_id — easy to grep, hard to confuse.

2. **Should `pcc_report` require auth?** Decision: NO. Stuck agents may
   not have provisioned yet. We accept the spam risk and rate-limit
   the route by IP (same `canProvision` pattern from `security-hardening`).

3. **Where do reports land before piece 5?** Decision: existing
   `auditService.log()` with `eventType: "agent.report"`. Already
   queryable via `/audit`. No schema change in this PR.

4. **Should we wire `req.traceId` via decorator or AsyncLocalStorage?**
   Decision: Fastify `decorateRequest` is sufficient and matches the
   existing `decorateRequest("pccSession")` pattern in server.ts. ALS
   is overkill here since we never need cross-await propagation outside
   the request lifecycle.

5. **Backward compat on `Result<T>`**. Adding optional fields to
   `PCCError` is safe at the structural-typing level. Callers that
   destructure `{ code, message }` keep working. Tests cover this.

## How to validate the PR locally

```bash
# Build the gateway
spark-run "cd ~/projects/physical-capability-cloud && pnpm --filter @pcc/gateway build"

# Run gateway tests
spark-run "cd ~/projects/physical-capability-cloud && pnpm --filter @pcc/gateway test"

# Run spec tests for the Result<T> extension
spark-run "cd ~/projects/physical-capability-cloud && pnpm --filter @pcc/spec test"

# Re-run the agent-package update script
node scripts/update-agent-package-v2.14-observability.mjs
```

## References

- coord doc #062: private-DB ownership
- coord doc #066: observability lane (inbox source)
- `packages/gateway/src/trace-collector.ts` — existing in-memory trace
  collector (kept as-is; not modified)
- `packages/gateway/src/otel.ts` — existing OTel init (kept as-is)
- `packages/spec/src/types/result.ts` — extended in this PR
- `apps/dashboard/public/agent-package.json` — `pcc_report` tool added
- `MCP_INSTALL.md` (TBD path) — auth doc target for `docs` field
