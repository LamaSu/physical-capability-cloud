# PCC Physical-Task Lifecycle, Timeout, Heartbeat, and Durable-Execution Audit

**AGENT_NAME**: auditor-lifecycle-alpha  
**Date**: 2026-06-22  
**Status**: DONE  
**Scope**: Read-only audit — no source files modified.

---

## 1. Canonical Job / Task Lifecycle States (with file:line)

### 1a. KernelJob (kernel-side, spec-canonical)

Defined in `packages/spec/src/types/kernel.ts:126–128`:

```
"queued" | "preparing" | "executing" | "collecting_evidence" |
"awaiting_pickup" | "completed" | "failed" | "cancelled"
```

**Transitions**:
- Gateway dispatches → `queued` (job inserted to DB at `packages/gateway/src/facades/job.facade.ts:249`)
- Kernel `POST /execute` accepts → `preparing` (`packages/kernel/src/server.ts:158`)
- JobRunner starts → `executing` (`packages/kernel/src/server.ts:170`)
- EvidenceEmitter fires bundle → `awaiting_pickup` (transition in `evidenceEmitter.onBundle` at `packages/kernel/src/server.ts:91–95`)
- Gateway `PUT /api/jobs/:id/complete` → `evidence_submitted` → `settled` / `completed` (`packages/gateway/src/routes/paid-job-flow.ts:1047–1060`)
- JobRunner throws → `failed` (`packages/kernel/src/server.ts:180–183`)

**Is there a TIMEOUT / TIMED_OUT state?** NO. No such enum member exists in the spec, DB schema, or any job status union. The string `"timed_out"` does not appear anywhere in the codebase.

### 1b. Gateway DB Status (actual stored values)

`packages/db/src/schema/jobs.ts:12` (comment on text field):

```
"queued" | "preparing" | "executing" | "collecting_evidence" |
"awaiting_pickup" | "completed" | "failed" | "cancelled"
```

Additional gateway-layer status strings used in routes (not in the spec enum):
- `"active"`, `"pending"`, `"evidence_submitted"`, `"evidence_stored"`, `"settled"` —
  used in `packages/gateway/src/routes/paid-job-flow.ts:441–447, 1047–1060`

So in practice the gateway writes string status values freely; no DB check constraint enforces the spec enum.

### 1c. ProtocolRun states

`packages/spec/src/types/protocol.ts:222–228`:

```
"binding" | "ready" | "running" | "paused" | "completed" | "failed" | "cancelled"
```

No `TIMEOUT` state here either.

### 1d. ProtocolRunStep states

`packages/spec/src/types/protocol.ts:254–262`:

```
"pending" | "waiting_transfer" | "queued" | "running" |
"completed" | "failed" | "skipped"
```

### 1e. @pcc/workflow WorkflowRun states

`packages/workflow/src/store/sqlite.ts:144–145` (SQLite CHECK constraint):

```
'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
```

### 1f. JobSpec `deadlineSeconds` field

`packages/spec/src/types/job-spec.ts:51–53` — `constraints.deadlineSeconds` is a field in the `JobSpec` schema. However, there is NO code anywhere in the gateway or kernel that reads `deadlineSeconds` and enforces a wall-clock deadline against a running job. It is written to the spec but not enforced at runtime.

---

## 2. Hung-Job Mechanisms: Dispatch-Side and Execution-Side

### 2a. Execution-side (kernel local, `JobRunner`)

**THE ONLY REAL TIMEOUT IN THE ENTIRE JOB PIPELINE** is in `packages/kernel/src/job-runner.ts:207–219`:

```typescript
private async waitForCompletion(timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (true) {
    const progress = await this.machine.getProgress();
    if (progress >= 100) return;
    const status = await this.machine.getStatus();
    if (status === "error") throw new Error("Machine reported error");
    if (status === "idle" && progress < 100) throw new Error("Machine went idle before completion");
    if (Date.now() - start > timeoutMs) throw new Error("Job timed out");
    await new Promise((r) => setTimeout(r, 500));
  }
}
```

- Default: 120 seconds (2 minutes). Hard-coded default, no env override wired.
- Effect: throws `"Job timed out"`, caught at `packages/kernel/src/job-runner.ts:201–204`, sets `result.success = false`, causes `packages/kernel/src/server.ts:180: job.status = "failed"`.
- Coverage: only the local `@pcc/kernel` server (`packages/kernel/src/server.ts`), which uses the `JobRunner` class. Digital kernels using `@pcc/kernel-sdk/src/job-handler.ts` have NO such timeout — the `execute()` call at line 220 is unbounded.

### 2b. Dispatch-side (gateway → kernel)

For the **external kernel path** (a job dispatched to a remote kernel daemon): the gateway inserts the job with status `"queued"` (`packages/gateway/src/facades/job.facade.ts:249`) and returns `{jobId, status: "queued"}`. After that, **there is no gateway-level deadline that cancels or fails the job if the kernel never picks it up**. The external kernel path at `packages/gateway/src/facades/job.facade.ts:258–286` returns immediately; no timeout/watchdog is started.

For the **local kernel path**: `svc.submitJob(...)` is called and awaited, but `KernelService.submitJob` also does not set any deadline on the actual hardware execution beyond what `JobRunner.waitForCompletion` does (see above).

**Conclusion**: There is NO mechanism that fails or cancels a hung job after a deadline at the gateway (dispatch) side. If a kernel never accepts a job, the DB row stays `"queued"` forever. If a kernel accepts but never finishes (e.g., adapter hangs after receiving `start` but before reporting `progress>=100`), the only protection is the 120s `waitForCompletion` timeout in `JobRunner`, and only for the local kernel path.

### 2c. AnomalyDetector timeout monitoring

`packages/kernel/src/anomaly-detector.ts:117–143`: `recordJobDuration()` emits `"timeout"` category anomaly reports (warning at >5 min, critical at >15 min). Default `jobTimeoutMs = 300_000` (5 min). However:
- These are **retroactive**: called only after a job completes (by observing the duration), not during execution.
- They do NOT cause the job to be cancelled or failed.
- The detector is in the kernel package; no route wires it into any automatic cancellation path.

---

## 3. Acknowledgement (ACK) Model

Mapping to doc-02's transport models:

**No explicit ACK distinct from the final result exists for job dispatch.**

- **Model A (gateway-embedded)**: `POST /api/jobs/submit` → `packages/gateway/src/facades/job.facade.ts:289–295` returns `{jobId, status: "queued"}` immediately. This is a submission receipt, not an acceptance ACK. The kernel has not yet been informed.
- **Model B (standalone HTTP, external kernel)**: no dispatch call is made at all — the external kernel daemon is expected to poll for jobs (`packages/gateway/src/facades/job.facade.ts:269–285`). No acknowledgement exists.
- **Model C (A2A bus)**: not used for job dispatch.

For the **local path**, `KernelService.submitJob()` returns `{jobId, deviceId, status}` synchronously. The kernel's `POST /execute` at `packages/kernel/src/server.ts:140–188` returns `{jobId, status: "executing"}` immediately — this is the closest thing to an ACK, but it is an HTTP response from the `runner.run()` promise which is fire-and-forgotten. The gateway wraps this in a try/catch; any transport failure marks the DB job `"failed"`.

**There is no two-phase ACK (accept → then async complete) pattern.** The kernel's `POST /execute` kicks off a fire-and-forget `runner.run()` and returns `{jobId, status: "executing"}` in the same HTTP response. The gateway polls `GET /jobs/:id` or waits for status change.

---

## 4. Heartbeat Analysis

### 4a. Kernel heartbeat

- **Type**: kernel-level. `packages/spec/src/types/kernel.ts:164–177` defines `KernelHeartbeat`.
- **Route**: `POST /api/kernels/:kernelId/heartbeat` (confirmed in CLAUDE.md API reference).
- **Staleness threshold**: `packages/gateway/src/facades/populators/staleness.ts:20–27`
  - No active listing: `STALE_HEARTBEAT_MS = 5 * 60 * 1000` (5 min)
  - Active listing (≥1 capability): `ACTIVE_LISTING_GRACE_MS = 24 * 60 * 60 * 1000` (24 h)
- **Effect of staleness**: `isKernelStale()` at line 42 marks the kernel's DTO `available: false` in the capability populator. **Staleness does NOT touch in-flight jobs** — there is no code that transitions jobs to `failed` when the kernel is stale.

### 4b. Agent heartbeat (AgentHeartbeatMonitor)

`packages/gateway/src/services/agent-heartbeat-monitor.ts`:
- **Check interval**: `DEFAULT_CHECK_INTERVAL_MS = 30_000` (30 s) at line 28
- **Suspicious threshold**: 3 missed beats (90 s silence) at line 35
- **Rogue threshold**: 5 missed beats (150 s silence) at line 42
- **Effect on rogue**: broadcasts anomaly, revokes agent scopes (`execution_scopes` → `"suspended_rogue"` at lines 370–382), unregisters from bus.
- **Does NOT touch jobs**: rogue detection does NOT set any in-flight `jobs` row to `failed`. Scope suspension prevents new tool calls from being authorized, but existing executing jobs continue.

### 4c. No job-level or activity-level heartbeat

There is no `POST /api/jobs/:jobId/heartbeat` endpoint. No dispatch-side "I'm still working" keepalive. Once a job is dispatched to a kernel, the gateway has no liveness signal from the kernel about that specific job. **Confirmed: no job-level heartbeat exists.**

---

## 5. @pcc/workflow: Durable Execution Analysis

### 5a. Is @pcc/workflow actually used for real jobs/escrow?

**Partially adopted — more than CLAUDE.md suggests:**

- **Escrow operations**: `packages/gateway/src/activities/escrow.ts` defines 6 Activity wrappers using `@pcc/workflow`'s `defineActivity`:
  - `fundEscrowActivity`, `releaseMilestoneActivity`, `fileDisputeActivity`, `depositBondActivity`, `submitEvidenceActivity`, `releaseMilestoneByJobActivity`
  - These are **actually wired into routes**: `packages/gateway/src/routes/escrow.ts:8–12, 199, 303, 345, 429` calls `.invoke()` on all of them.
  - So escrow fund/release/dispute **ARE using @pcc/workflow Activities** (with idempotency + retry), contrary to the CLAUDE.md migration note.
- **Protocol runner** (`packages/orchestrator/src/protocol-runner.ts`): still uses an in-memory `Map<string, ProtocolRun>` at line 24. NOT migrated to @pcc/workflow. ProtocolRunner state is entirely ephemeral.
- **Compose route** (`packages/gateway/src/routes/compose.ts:530–657`): uses `WorkflowEngine` and `openSqliteStore` for composition DAG execution.
- **Raw jobs/submit path** (`packages/gateway/src/facades/job.facade.ts`, `packages/gateway/src/routes/paid-job-flow.ts`): does NOT use @pcc/workflow. Jobs are submitted fire-and-forget.

### 5b. Activity retry policy

`packages/workflow/src/shared/types.ts:57–65` (DEFAULT_RETRY_POLICY):
```
initialIntervalMs: 1_000
backoffCoefficient: 2.0
maxIntervalMs: 100_000
maximumAttempts: 5
nonRetryableErrorPatterns: []
jitterFactor: 0.2
```

Escrow activities override to `initialIntervalMs: 2_000` or `3_000`, `maximumAttempts: 3 or 5`.

### 5c. 3-tier idempotency keys + TTL

`packages/workflow/src/activity/idempotency-key.ts:47–66`:
1. **Tier 1** (client-provided Stripe-style key): `http:<actor>:<method>:<path>` scope
2. **Tier 2** (workflow content-address): `sha256(canonicalJSON({activityName, args, workflowRunId, attemptNumber}))`, scope `workflow:activity:<name>`
3. **Tier 3** (on-chain semantic): `keccak256(ABI-encode(jobId, milestoneIdx, action, attempt))`, scope `onchain:escrow`

TTLs in `packages/workflow/src/store/sqlite.ts:50–52`:
```
TTL_HTTP_MS = 24 * 60 * 60 * 1000      // 24 h
TTL_ONCHAIN_MS = 30 * 24 * 60 * 60 * 1000  // 30 d
TTL_WORKFLOW_MS = 7 * 24 * 60 * 60 * 1000  // 7 d
```

### 5d. Workflow step memoization and crash recovery

`packages/workflow/src/workflow/engine.ts:353–394`: `ctx.step(id, fn)` looks up `(runId, stepId)` in `step_results`. On cache hit, returns cached result without running `fn`. On miss, runs `fn`, memoizes on success. A crash between fn completion and memoization is at-least-once.

`WorkflowEngine.recover()` at `packages/workflow/src/workflow/engine.ts:158–177` resumes all incomplete runs. Designed to be called at app startup.

### 5e. `ctx.sleep(id, ms)` — NotImplementedError

`packages/workflow/src/workflow/engine.ts:416–422`:
```typescript
async sleep(id: string, ms: number): Promise<void> {
  void id;
  void ms;
  throw new NotImplementedError(
    'WorkflowContext.sleep',
    'Durable timers land in v0.2 (design §12.6). Use setTimeout inside ctx.step() for non-durable delays.',
  );
},
```
**Confirmed: `ctx.sleep()` throws `NotImplementedError` in v0.1.**

### 5f. Per-activity `timeoutMs`

Searching the entire `packages/workflow/src/` tree: **no `timeoutMs` field exists** in `ActivityContext`, `DefineActivityOptions`, or `RetryPolicy`. There is no per-activity wall-clock timeout. An activity handler that hangs (e.g., a hung blockchain RPC call) will block indefinitely — there is no escape valve except the process-level Node.js timeout or the OS.

### 5g. Signal delivery limits

`packages/workflow/src/workflow/engine.ts:436–455`: signal delivery is single-process only. Signals registered via `ctx.signal(name)` register a `Promise` waiter in an in-memory `Map`. A crash drops the waiter; the run transitions to `status='paused'` in DB. Recovery on next startup re-runs the workflow, which can re-register the waiter. A signal sent to a crashed run is persisted as a `WorkflowSignalReceived` event (`packages/workflow/src/workflow/engine.ts:462–473`); future recovery can observe it.

---

## 6. TTL Precedents Elsewhere

### Negotiation session (30 min)

- Defined: `packages/spec/src/types/negotiation.ts:204`: `export const SESSION_TTL_MS = 30 * 60_000;`
- Applied: `packages/gateway/src/routes/negotiation.ts:147` sets `expiresAt = now + SESSION_TTL_MS`
- Enforced: `packages/gateway/src/routes/negotiation.ts:289` — on GET of session, if `expiresAt < now && status !== "committed"`, marks `status: "expired"` and returns 410. Enforcement is **lazy** (on-read), not proactive (no background job cancels expired sessions).
- Also used as fast-track TTL: `packages/gateway/src/routes/paid-job-flow.ts:551`: `const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString()`

### Wizard session (24 h)

- Defined and applied: `packages/gateway/src/routes/wizard.ts:62`: `const TTL_MS = 24 * 60 * 60 * 1000;`
- Enforcement: `packages/gateway/src/routes/wizard.ts:73–79` — `pruneExpiredSessions()` deletes expired sessions from the in-memory `Map` (called every 5 minutes via `PRUNE_INTERVAL_MS`). Also lazy: checked in the GET/PUT handlers.
- Store: **in-memory only** — wizard sessions do not persist to SQLite.

### Execution scope (1 h)

- Created with: `packages/gateway/src/routes/paid-job-flow.ts:457`: `expiry = new Date(Date.now() + 60 * 60_000).toISOString()`
- Enforced lazily at tool-relay time: `packages/gateway/src/routes/device-relay.ts:89–90` and `packages/gateway/src/routes/ot2-relay.ts:55–56`: if `scope.expiresAt < now`, rejects tool call with `"scope_expired"`. Background pruning in `device-relay.ts:664–669`.

### Gateway idempotency keys

- Default TTL: `packages/gateway/src/middleware/idempotency.ts:23`: `TTL_MS = parseInt(IDEMPOTENCY_TTL_MS, 10) || 24 * 60 * 60 * 1000` (24 h)
- SIWE auth session: `packages/gateway/src/auth/siwe-auth.ts:28`: 24 h

---

## 7. Dispatch-to-Execution ACK Gap (Summary)

```
Gateway (job.facade.ts:submit)
  → insert job DB status="queued"
  → if external kernel: return {status:"queued"} — kernel NEVER notified, no ACK, no deadline
  → if local kernel: svc.submitJob() → KernelService → POST /execute to local kernel HTTP
      ↳ kernel/server.ts: creates KernelJob{status:"preparing"}, starts runner.run() async
      ↳ returns {jobId, status:"executing"} immediately — this is the only "ACK"
      ↳ runner.run() calls waitForCompletion(120_000ms) — the only job-level timeout
      ↳ if waitForCompletion throws → job.status = "failed" (kernel-local only)

Gateway polling (job.facade.ts:getStatus)
  → queries DB; or calls svc.getJobStatus() which queries in-memory kernel state
  → No push notification, no SSE from kernel to gateway about job progress
  → No deadline that transitions "executing" → "failed" at the gateway layer
```

---

## PCC HAS (for timeout/heartbeat/ACK/durable-execution)

1. **`JobRunner.waitForCompletion(120_000ms)`** at `packages/kernel/src/job-runner.ts:207` — local-path execution timeout; throws, job → `failed`.
2. **`AnomalyDetector.recordJobDuration()`** at `packages/kernel/src/anomaly-detector.ts:117` — retroactive anomaly reporting (5 min warning, 15 min critical). Read-only; does not cancel jobs.
3. **Kernel-level heartbeat** at `packages/gateway/src/facades/populators/staleness.ts:20–27` — marks kernel `available: false` after 5 min (no listing) or 24 h (with listing). Affects discovery, not in-flight jobs.
4. **Agent-level heartbeat** at `packages/gateway/src/services/agent-heartbeat-monitor.ts` — check interval 30 s, rogue at 150 s. Revokes scopes, but NOT jobs.
5. **Negotiation session TTL (30 min)** at `packages/spec/src/types/negotiation.ts:204` — lazy enforcement on read.
6. **Execution scope TTL (1 h)** at `packages/gateway/src/routes/paid-job-flow.ts:457` — enforced at tool-relay call time.
7. **Wizard session TTL (24 h)** at `packages/gateway/src/routes/wizard.ts:62` — in-memory; pruned every 5 min.
8. **`@pcc/workflow` Activity idempotency + retry** — escrow fund/release/dispute/evidence wired in `packages/gateway/src/routes/escrow.ts`. 5 attempts, exponential backoff, non-retryable error list.
9. **`@pcc/workflow` step memoization** — `ctx.step(id, fn)` in `packages/workflow/src/workflow/engine.ts:353`. Crash-safe across restarts.
10. **`WorkflowEngine.recover()`** at `packages/workflow/src/workflow/engine.ts:158` — resumes incomplete runs on startup.
11. **`JobSpec.constraints.deadlineSeconds`** field at `packages/spec/src/types/job-spec.ts:51` — exists in spec/schema but **no enforcement code reads it**.
12. **`waitForTransactionReceipt({ timeout: 90_000 })`** at `packages/gateway/src/routes/paid-job-flow.ts:341` — 90s timeout for `addMilestone` on-chain tx; drop → retry with fresh escrow (up to 3 attempts).
13. **Stuck-processing reclaim** in `packages/workflow/src/store/sqlite.ts:56–57`: `DEFAULT_STUCK_HTTP_MS = 60s`, `DEFAULT_STUCK_ONCHAIN_MS = 10 min` — idempotency store can reclaim stuck-processing rows; not yet wired to a periodic sweeper.

## PCC LACKS (for timeout/heartbeat/ACK/durable-execution)

1. **`TIMED_OUT` / `TIMEOUT` job status** — no such state exists in the spec, DB schema, or any status union.
2. **Gateway-side dispatch timeout** — if a kernel never picks up a queued job, the row stays `"queued"` forever. No watchdog, no cron, no reaper.
3. **Execution-side timeout for digital kernels** — `packages/kernel-sdk/src/job-handler.ts:220` (`await execute(request.input)`) has no timeout wrapper. A hung digital kernel handler blocks indefinitely.
4. **Job-level heartbeat / progress ping** — no `POST /api/jobs/:id/heartbeat` or equivalent. The kernel does not periodically report "I'm still working" to the gateway.
5. **Two-phase ACK** (accept + complete) — no separate acceptance acknowledgment from the kernel. The fire-and-forget `/execute` HTTP response IS the ACK and the job start simultaneously.
6. **Proactive job reaping** — no background scheduler/cron that scans for jobs stuck in `"executing"` or `"queued"` beyond a deadline and fails them.
7. **Per-activity `timeoutMs`** — `@pcc/workflow`'s Activity/Workflow primitives have no timeout on the handler invocation itself.
8. **`ctx.sleep(id, ms)` durable timers** — throws `NotImplementedError` in v0.1; deferred to v0.2.
9. **Horizontal-scale signal delivery** — `ctx.signal()` is in-memory only; a crash drops the waiter even though the event is persisted.
10. **`JobSpec.deadlineSeconds` enforcement** — the field exists in the spec but no runtime code reads it to enforce a wall-clock deadline on job execution.
11. **Dispatch-to-execution `waitForCompletion` coverage outside local kernel** — the 120s timeout in `JobRunner` only protects local-kernel execution. External kernels (daemon-polled) have no equivalent.
12. **`ProtocolRunner` durability** — in-memory `Map<string, ProtocolRun>` at `packages/orchestrator/src/protocol-runner.ts:24`; a process crash loses all in-progress protocol runs.

---

## 8. Six Specific Questions (Answers with Cites)

### Q1: Canonical job/task lifecycle states and transitions — is there a TIMEOUT / TIMED_OUT state?

- Kernel-side (spec): `"queued" | "preparing" | "executing" | "collecting_evidence" | "awaiting_pickup" | "completed" | "failed" | "cancelled"` at `packages/spec/src/types/kernel.ts:126–128`.
- Gateway DB (stored): same set, plus informal strings like `"active"`, `"pending"`, `"evidence_submitted"`, `"settled"` — no DB CHECK constraint (`packages/db/src/schema/jobs.ts:12`).
- **No TIMEOUT / TIMED_OUT state exists anywhere.**

### Q2: Mechanism to fail or cancel a hung job after a deadline?

- **Execution-side (local kernel only)**: `JobRunner.waitForCompletion(120_000)` at `packages/kernel/src/job-runner.ts:207–219` throws after 2 minutes; sets `job.status = "failed"`.
- **Dispatch-side (external kernel)**: NONE. Job stays `"queued"` forever.
- **Execution-side (digital kernels via kernel-sdk)**: NONE. `execute()` at `packages/kernel-sdk/src/job-handler.ts:220` is unbounded.
- **AnomalyDetector**: retroactive warning/alert only, no cancellation (`packages/kernel/src/anomaly-detector.ts:117–143`).
- **Conclusion**: No gateway-level hung-job reaper exists. Only the local kernel `JobRunner` has a timeout; external kernels have none.

### Q3: Explicit ACK distinct from final result?

- No. For local kernels: `POST /execute` fires `runner.run()` async and returns `{jobId, status: "executing"}` in the same response — this HTTP response is simultaneously the ACK and the job-started notification (`packages/kernel/src/server.ts:172–188`).
- For external kernels: no dispatch call at all; job daemon polls. No ACK.
- In transport terms: this is closest to **Model A (gateway-embedded)** — no separate accept/complete phase.

### Q4: Heartbeat details and what staleness actually does to in-flight jobs

**Kernel heartbeat**:
- `POST /api/kernels/:kernelId/heartbeat` updates `lastHeartbeat` timestamp.
- Staleness check: `isKernelStale()` at `packages/gateway/src/facades/populators/staleness.ts:42`. Threshold: 5 min (no listing) or 24 h (active listing).
- Effect: marks DTO `available: false` in capability populator. **Does NOT affect in-flight jobs.**

**Agent heartbeat**:
- `POST /api/agents/heartbeat` → `AgentHeartbeatMonitor.recordHeartbeat()` at `packages/gateway/src/services/agent-heartbeat-monitor.ts:152`.
- Suspicious at 90 s silence, rogue at 150 s. Scope suspension on rogue.
- Effect: revokes `execution_scopes` for the agent (blocks future tool calls). **Does NOT fail in-flight jobs.**

**Job-level / activity-level heartbeat**: NONE. Confirmed absent.

### Q5: @pcc/workflow — status of ctx.sleep, per-activity timeoutMs, actual adoption

- **`ctx.sleep()`**: throws `NotImplementedError` at `packages/workflow/src/workflow/engine.ts:416–422`. Durable timers deferred to v0.2.
- **Per-activity `timeoutMs`**: does not exist in `DefineActivityOptions` or `RetryPolicy`. No timeout on activity handler execution.
- **Signal delivery**: in-memory only (single-process). Crash drops waiters; persisted events allow recovery on restart (`packages/workflow/src/workflow/engine.ts:461–473`).
- **Actual adoption**:
  - Escrow operations (fund, release, dispute, submitEvidence): YES, fully adopted via `packages/gateway/src/activities/escrow.ts` and wired in `packages/gateway/src/routes/escrow.ts`.
  - Compose route: YES, uses `WorkflowEngine` (`packages/gateway/src/routes/compose.ts:530–657`).
  - Raw job submit / paid-job-flow: NOT adopted.
  - ProtocolRunner: NOT adopted (in-memory `Map` at `packages/orchestrator/src/protocol-runner.ts:24`).
  - CLAUDE.md says escrow.ts is "NOT yet migrated" — this is **stale**; the migration IS done.

### Q6: TTL precedents elsewhere

- **Negotiation session**: 30 min (`packages/spec/src/types/negotiation.ts:204`). Lazy enforcement on GET at `packages/gateway/src/routes/negotiation.ts:289`.
- **Wizard session**: 24 h (`packages/gateway/src/routes/wizard.ts:62`). In-memory; pruned every 5 min.
- **Execution scope**: 1 h (`packages/gateway/src/routes/paid-job-flow.ts:457`). Enforced at tool-relay call time (`packages/gateway/src/routes/device-relay.ts:89–90`).
- **@pcc/workflow idempotency**: HTTP=24 h, onchain=30 d, workflow=7 d (`packages/workflow/src/store/sqlite.ts:50–52`).
- **SIWE auth session**: 24 h (`packages/gateway/src/auth/siwe-auth.ts:28`).
