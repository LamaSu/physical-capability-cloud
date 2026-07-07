# SOTA: Timeout / Freshness / Liveness — RTP Baseline + Survey

AGENT_NAME: scout-sota-rtp-delta
OUTPUT_FILE: docs/rtp-absorption/research-notes/sota-timeout-and-rtp.md

## Progress Tracker
- [x] Read existing rtp-spec-study.md
- [x] Fetch RTP-1.0.md (confirm timeout + freshness fields)
- [x] Search + fetch Temporal activity timeout taxonomy
- [x] Search + fetch Cadence timeout equivalents
- [x] Search + fetch Saga / compensating transaction pattern
- [x] Search + fetch Stripe idempotency + IETF draft
- [x] Search + fetch AWS SigV4 clock-skew + EIP-712 nonce
- [x] Search + fetch etcd lease / ZooKeeper / K8s Lease / Step Functions heartbeat
- [x] Write comparison table
- [x] Write synthesis summary

---

## Part 1 — RTP Timeout / Freshness Baseline

### Source: https://raw.githubusercontent.com/plagtech/rtp-spec/main/spec/RTP-1.0.md (Section 6, 7, 12)

#### 1.1 `timeout_seconds` — Task-Level Execution Deadline

**Field definition (Task Envelope, Section 6):**
```json
"timeout_seconds": 60   // integer, optional, default 60
```
> "Max execution time before TIMEOUT (default: 60)"

**Behavior on expiry:**
> "TIMEOUT → treated as FAILED if no completion within timeout_seconds"

- Transition path: `IN_PROGRESS → TIMEOUT` (exceeds `timeout_seconds` without a COMPLETED or FAILED completion signal from the robot)
- On TIMEOUT: funds automatically refunded to the agent (same as FAILED)
- Callback URL is fired with `status: "TIMEOUT"` in the result envelope

**Key gap:** RTP has a single, undifferentiated timeout covering both "how long until the robot picks up the task" AND "how long the robot spends executing it." There is no dispatch-timeout vs. execution-timeout split. If a robot is slow to acknowledge (DISPATCHED → IN_PROGRESS) versus slow to finish (IN_PROGRESS → COMPLETED), the same `timeout_seconds` clock covers both — and a retry simply requeues with a fresh payment, burning another `timeout_seconds` budget from scratch.

#### 1.2 `issued_at` — Request Freshness Window

**Field definition (Task Envelope, Section 6):**
```json
"issued_at": "2026-03-11T12:00:00Z"   // ISO 8601, REQUIRED
```

**Freshness rule (Security Considerations, Section 12):**
> "issued_at freshness window (default 5 min)"

- **Window:** 300 seconds (5 minutes) before or after gateway receipt
- Envelopes with `issued_at` outside this window are **rejected** — the task never enters PENDING
- Prevents an intercepted, signed task envelope from being replayed hours later

**Exact behavior:** The gateway compares `now()` against `issued_at`. If `|now - issued_at| > 300s`, the envelope is rejected before x402 payment validation even begins.

#### 1.3 Replay / Nonce Protection

**From Section 12:**
> "Replay protection: task_id is unique + single-use; issued_at freshness window (default 5 min)"

- `task_id`: required, unique, single-use — gateway deduplicates on it
- `issued_at` freshness: secondary guard (ensures even a replayed task_id cannot be reused after 5 min)
- **No cryptographic nonce field** — uniqueness is enforced by gateway state (task_id registry), not a counter or HMAC nonce

#### 1.4 Task Lifecycle States

```
PENDING     → payment being validated on-chain (x402)
DISPATCHED  → payment confirmed; envelope sent to robot via connection type
IN_PROGRESS → robot ACK'd receipt; executing
COMPLETED   → robot self-reported success; escrow releases to operator
FAILED      → robot self-reported failure; funds refunded to agent
TIMEOUT     → timeout_seconds elapsed without COMPLETED/FAILED; funds refunded
```

On COMPLETED: escrow releases, `callback_url` fired.
On FAILED or TIMEOUT: funds returned to agent, `callback_url` fired.

#### 1.5 RTP's Structural Limitations (vs PCC needs)

| Gap | Detail |
|-----|--------|
| Single timeout | No dispatch-vs-execution split; one clock covers queuing + execution |
| No heartbeat | Robot goes silent → only detected at `timeout_seconds` expiry; no progressive liveness |
| No result signing | Robot self-reports completion via unsigned plain HTTP POST; gateway cannot verify |
| No evidence model | No sensor attestation, photo, CID, ZK proof — binary success/failure only |
| Fixed 5-min freshness | Hardcoded; no mechanism to extend for very long-running physical tasks |
| task_id dedup only | No HMAC-nonce; gateway state required to enforce uniqueness (stateless replay not detectable) |

---

## Part 2 — SOTA Survey

### 2(a) Temporal Activity Timeout Taxonomy

**Sources:**
- https://temporal.io/blog/activity-timeouts
- https://docs.temporal.io/encyclopedia/detecting-activity-failures

#### Core Idea

Temporal decomposes activity lifetime into four orthogonal timeout dimensions, each targeting a different failure mode:

| Timeout | What it measures | Failure mode detected | Retries on expiry? |
|---------|-----------------|----------------------|--------------------|
| **ScheduleToStart** | Queue wait time (task sits in queue before any worker picks it up) | Worker pool exhaustion; task never dispatched | No — retry would re-queue to same saturated pool |
| **StartToClose** | Single execution attempt duration (worker-to-completion) | Worker crash mid-execution; hung process | Yes |
| **ScheduleToClose** | Total time across ALL retry attempts (schedule to final completion) | Global SLA breach including retries | Yes (caps the retry budget) |
| **Heartbeat** | Maximum silence between heartbeat pings during execution | Worker stall / hung sub-step within a long activity | Yes |

**ScheduleToStart is the dispatch timeout.** StartToClose + Heartbeat address execution liveness. ScheduleToClose is the overall SLA envelope.

> "Start-To-Close Timeout: We recommend ALWAYS setting this! Limits the maximum execution time of a single execution."
> "Schedule-To-Start: it doesn't result in a retry — all a retry would do is pop the activity right back on to the same queue!"

#### Heartbeat Mechanism

```go
activity.RecordHeartbeat(ctx, progress)  // SDK call from within activity
```

- Worker sends ping to Temporal Service at intervals ≤ `heartbeatTimeout`
- **Throttle rule:** SDK throttles sends to `min(heartbeatTimeout × 0.8, maxHeartbeatThrottleInterval)`; defaults are 30s and 60s respectively
- **Progress payload:** each heartbeat carries arbitrary serializable data (`details`/`progress`)
- **On heartbeat timeout:** activity marked failed → retry triggered; **next attempt receives the last heartbeat's progress payload**, enabling resumption mid-task rather than restart from zero
- External heartbeat possible: `client.RecordActivityHeartbeat(ctx, taskToken, details)` — allows out-of-band liveness reporting from a separate process

#### Retry Policy Interplay

- RetryPolicy: `initialInterval`, `backoffCoefficient`, `maximumInterval`, `maximumAttempts`
- `ScheduleToClose` overrides `maximumAttempts` — whichever is hit first terminates retries
- `StartToClose` timeout → retry (attempt count increments)
- `ScheduleToClose` timeout → no retry (total budget exhausted)

#### Workflow-Level Timeouts

- **WorkflowRunTimeout:** single execution run (resets on `ContinueAsNew`)
- **WorkflowExecutionTimeout:** total across all runs/`ContinueAsNew` chains — the hard global SLA

#### Rating vs RTP for PCC

**BETTER.** Temporal's four-timeout taxonomy directly addresses PCC's need to distinguish dispatch timeout (kernel not responding) from execution timeout (job hung mid-run). The heartbeat mechanism with progress payload gives exactly the liveness semantics needed for long physical jobs (3D print, HPLC run) without waiting for the full execution timeout to fire. The retry-with-last-progress model enables safe job resumption after kernel restart. RTP has none of this.

---

### 2(b) Cadence — Temporal's Predecessor

**Source:** https://cadenceworkflow.io/docs/workflow-troubleshooting/timeouts

#### Core Idea

Cadence (Uber, open-sourced 2017; Temporal forked from it in 2019) has the same timeout taxonomy:

- **ScheduleToClose:** Overall activity execution time from schedule to completion
- **StartToClose:** Single attempt execution time (worker pickup → completion)
- **ScheduleToStart:** Queue wait time before any worker picks up the task
- **Heartbeat Timeout:** Maximum silence during execution
- **Workflow Execution Timeout:** Total workflow duration
- **Decision Task Timeout:** Maximum time a workflow decision (Workflow Task in Temporal) can take — specific to the event-loop model where the workflow code itself must respond within this window to avoid being marked failed

#### Key Continuity Note

Temporal is a near-direct fork of Cadence at the API level. The timeout taxonomy is preserved 1:1. Cadence's "Decision Task" became Temporal's "Workflow Task." For PCC's purposes, evaluating Temporal is sufficient to understand both systems.

#### Rating vs RTP for PCC

**BETTER** (same as Temporal — Cadence originated the model). Historical note only: production systems on Cadence (Uber, Airbnb, etc.) validate that this timeout taxonomy works at scale for long-running physical-world workflows.

---

### 2(c) Saga Pattern / Compensating Transactions

**Sources:**
- https://learn.microsoft.com/en-us/azure/architecture/patterns/saga
- https://temporal.io/blog/mastering-saga-patterns-for-distributed-transactions-in-microservices
- https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-choreography.html

#### Core Idea

A saga is a sequence of local transactions where each step has a **compensating transaction** that undoes its effect if a later step fails. Sagas replace 2PC distributed transactions with eventual consistency + rollback.

**Two variants:**

| Variant | Coordinator | Timeout handling |
|---------|------------|-----------------|
| **Orchestration** | Central orchestrator tracks state, triggers compensations | Orchestrator detects timeout; triggers compensating transactions for completed steps in reverse order |
| **Choreography** | Services react to events, no central coordinator | No built-in saga-level timeout; each service must implement its own timeout + emit a compensating event |

#### Timeout → Auto-Refund Mapping

Saga's "compensate completed steps on failure" is the **conceptual parent of RTP's auto-refund on TIMEOUT**:
- RTP: `timeout_seconds` expires → TIMEOUT state → escrow refund (a single-step saga compensation)
- Full saga: step N fails/times out → compensate steps N-1, N-2, … N-k

For PCC, the saga model applies when a multi-step physical job (e.g., OT-2 protocol with 5 liquid handling steps + HPLC analysis + report upload) must be unrolled if any step times out — not just the payment, but the physical state of the equipment.

> "Choreography has no concept of a saga-level timeout by default, and saga timeout handling requires explicit design of what the expected system state is when a timeout fires."

#### Physical Task Mapping

- **Dispatch timeout** → the saga never started; compensation = refund payment only
- **Execution timeout mid-step** → compensation = reset equipment to known state + refund + emit `job.failed` event
- **Partial completion** → selective compensation (completed steps may not be reversible — e.g., material already dispensed)

#### Rating vs RTP for PCC

**BETTER** for multi-step protocol orchestration. RTP's single-timeout / single-refund is a degenerate one-step saga. PCC's evidence-threaded multi-step jobs need the full saga model: per-step compensating logic, equipment state rollback, and partial-success evidence preservation. RTP cannot model this.

---

### 2(d) Idempotency Keys with Freshness / Expiry Windows

**Sources:**
- https://docs.stripe.com/api/idempotent_requests
- https://stripe.com/blog/idempotency
- https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-05
- https://brandur.org/idempotency-keys

#### Stripe Implementation

- **Key:** client-generated UUID or random string sent in `Idempotency-Key` header
- **Retention window:** 24 hours from first receipt
  > "clients can safely retry requests that include an idempotency key as long as the second request occurs within 24 hours from when you first receive the key"
- **Cached result:** first request's response (status code + body) is cached and returned verbatim to retries with the same key — including 500 errors
- **No freshness window on submission:** Stripe does not reject a request because the key is "too old relative to request body" — it's purely a dedup mechanism, not a replay-prevention mechanism

#### IETF `Idempotency-Key` Header Draft (draft-05)

- **Normative stance on retention:** none. "The resource MAY enforce time based idempotency keys, thus, be able to purge or delete a key upon its expiry."
- **Expiry policy:** servers MUST publish their expiry policy, but the spec mandates no duration
- **Uniqueness rule:** key MUST be unique per request payload; same key + different payload MUST be rejected
- **No freshness window:** the draft contains no recommendation on how long a key remains valid before the initial request, only how long the cached result is retained after

#### Contrast with RTP's `issued_at`

| Mechanism | Purpose | Window | Enforcement |
|-----------|---------|--------|-------------|
| Stripe idempotency key | Dedup retries of same request | 24h retention (server-side) | Server caches first result |
| IETF Idempotency-Key | Same as Stripe, standardized | Implementation-defined | Same |
| RTP `issued_at` | **Replay prevention** of captured requests | 5 min freshness (submission window) | Gateway rejects stale envelopes |

RTP's `issued_at` is a **submission freshness guard** — it prevents replaying a captured valid request. Stripe's idempotency key is a **retry dedup mechanism** — it prevents double-charging on legitimate retries. These solve orthogonal problems. PCC needs **both**: replay prevention (`issued_at` + nonce) AND retry safety (idempotency key per job submission).

#### Rating vs RTP for PCC

**EQUAL (complementary, not replacement).** Stripe/IETF idempotency keys don't replace `issued_at`-style freshness; they add retry safety that RTP lacks. PCC should adopt idempotency keys for job submission retries AND keep the `issued_at` freshness window for replay prevention.

---

### 2(e) Nonce / Replay Protection + Signed-Request Freshness

**Sources:**
- https://dev.to/kanywst/aws-sigv4-and-sigv4a-deep-dive-12li
- https://docs.aws.amazon.com/IAM/latest/UserGuide/signing-elements.html
- https://eips.ethereum.org/EIPS/eip-712
- https://medium.com/@mahdidarzi1024/understanding-ethereum-improvement-proposal-712-eip-712-7428facbabd8

#### AWS SigV4 — Signed `X-Amz-Date` + Clock-Skew Window

```
X-Amz-Date: 20260622T120000Z   // ISO 8601 basic, second precision, in CredentialScope + signed headers
```

- **Clock-skew tolerance:** ±15 minutes (900 seconds). Requests outside this window → `RequestTimeTooSkewed` error
- **Replay window:** same signed request can be replayed within the 15-minute window (SigV4 provides no nonce; replay prevention is purely timestamp-based)
- **CredentialScope:** date + region + service + `aws4_request` — further scopes the signature to prevent cross-service/cross-region replays
- **HMAC-SHA256** over canonical request including the timestamp → timestamp tampering invalidates signature

**Pattern:** `signed_timestamp + max_age_window` — identical to RTP's `issued_at + 5min`. AWS uses ±15 min (900s); RTP uses ±5 min (300s). RTP's window is tighter.

#### EIP-712 — Typed Structured Data + Nonce + Deadline

```solidity
struct PermitMessage {
    address owner;
    address spender;
    uint256 value;
    uint256 nonce;     // per-owner counter, consumed and incremented per signature
    uint256 deadline;  // block.timestamp must be <= deadline
}
bytes32 domainSeparator = keccak256(abi.encode(
    DOMAIN_TYPEHASH, name, version, chainId, verifyingContract
));
```

- **Domain separator:** prevents cross-contract, cross-chain, cross-version replays
- **Nonce:** per-account counter; consuming the nonce increments it, making old signatures invalid even within the deadline window
- **Deadline:** Unix timestamp after which the signed message is rejected — the equivalent of `issued_at + max_age` but expressed as an absolute expiry
- **Combined protection:** nonce (state-based) + deadline (time-based) + domain separator (context-based) → three independent layers vs RTP's single `issued_at` + `task_id` dedup

**EIP-712 vs RTP `issued_at`:**

| Dimension | RTP | EIP-712 |
|-----------|-----|---------|
| Freshness | `issued_at` + 5-min window (relative) | `deadline` (absolute expiry) |
| Dedup | `task_id` uniqueness (gateway state) | `nonce` counter (on-chain state) |
| Scope | None (any gateway) | `domainSeparator` (contract + chain) |
| Signing | x402 payment signature (payment only) | ECDSA over full structured payload |

For PCC: EIP-712-style `deadline` + per-kernel `nonce` would be strictly stronger than RTP's `issued_at` + `task_id` dedup. The domain separator pattern maps naturally to PCC's kernel identity (kernel-scoped replays are prevented).

#### JWT `jti` + `exp`

- `exp`: absolute expiry timestamp (Unix); token rejected after this time
- `jti`: JWT ID — unique per-token; server must track used `jti` values within `[iat, exp]` window to prevent replay
- Similar to RTP: `iat` (issued_at equivalent) + `exp` (deadline) + `jti` (task_id equivalent)
- JWT adds: issuer (`iss`), audience (`aud`), subject (`sub`) for cross-service scope

#### TOTP (RFC 6238)

- Time-based one-time password: `HMAC(secret, floor(timestamp / step_size))` where `step_size` = 30s
- Effectively a sliding 30s window with automatic key rotation
- Applicable to: PCC kernel → gateway liveness heartbeat tokens (each 30s window produces a unique TOTP; replay of a captured token is only valid for ≤30s)

#### Rating vs RTP for PCC

**BETTER** (EIP-712 / JWT jti+exp pattern). RTP's `issued_at` + `task_id` dedup is a correct but thin implementation of signed-request freshness. EIP-712's nonce + deadline + domain separator pattern provides stateless (on-chain) replay prevention without requiring gateway state to track `task_id` uniqueness. For PCC's on-chain escrow settlement path, adopting EIP-712 structured signing for task envelopes would: (a) enable stateless replay detection, (b) scope signatures to specific kernels, (c) preserve signed evidence chain integrity that RTP cannot provide.

---

### 2(f) Lease / Dead-Man-Switch / Watchdog

**Sources:**
- https://etcd.io/docs/v3.4/learning/api/
- https://singhajit.com/distributed-systems/lease/
- https://docs.aws.amazon.com/step-functions/latest/dg/concepts-activities.html

#### etcd Lease (TTL + KeepAlive)

```
LeaseGrant(TTL=30s) → LeaseID
LeaseKeepAlive(LeaseID) [bidirectional gRPC stream] → new TTL on each ack
keys.Put(key, value, LeaseID)  // key is attached to lease
```

- **Expiry:** if KeepAlive stream breaks or stops sending within TTL window → lease expires → **all keys attached to that lease are automatically deleted**, generating delete events in history
- **KeepAlive response:** returns remaining TTL; client knows if server is lagging
- **LeaseTimeToLive API:** check remaining TTL and which keys are held under a lease
- **Dead-man-switch:** renew or lose — no explicit "failure" signal needed; absence of renewal is the signal

**Physical task mapping:**
- Kernel holds a lease on its `job/active/{jobId}` key
- Kernel must call KeepAlive within TTL (e.g., every 10s with TTL=30s)
- If kernel goes dark mid-job → key disappears → PCC gateway detects job orphan → triggers auto-refund + compensation
- Heartbeat progress payload: store last-known job state as the key value; on expiry, that value is available in the delete event

#### ZooKeeper / Chubby Ephemeral Sessions

- Ephemeral node: created on a session; auto-deleted when session expires (client disconnects or fails to send heartbeats)
- Leader election: lowest-sequence ephemeral node holds leadership; on crash, node disappears, next takes over
- Same renew-or-lose pattern; TTL is the session timeout (default ZK: 2× negotiated timeout)

#### Kubernetes Lease + Liveness Probes

```yaml
# Kubernetes Lease object (coordination.k8s.io/v1)
spec:
  holderIdentity: "kernel-node-abc"
  leaseDurationSeconds: 30
  acquireTime: ...
  renewTime: ...   # updated by holder on each renewal
```

- **Liveness probe:** kubelet polls `/healthz` (or exec/TCP); failure → container restart
- **Readiness probe:** gates traffic routing (not liveness)
- K8s Lease is used for leader election; liveness probe is the per-container dead-man-switch
- Combined: lease (cluster-level) + liveness probe (container-level) = two-layer watchdog

**Physical kernel mapping:** a PCC kernel node can hold a K8s Lease while running a job; liveness probe checks the job sub-process. If the job hangs → liveness fails → container restarts → lease expires → gateway detects orphan.

#### AWS Step Functions Heartbeat (`HeartbeatSeconds` + `SendTaskHeartbeat`)

```json
// State machine definition
{
  "Type": "Task",
  "Resource": "arn:aws:states:::activity:FDM_Print",
  "TimeoutSeconds": 7200,
  "HeartbeatSeconds": 120
}
```

- **Activity worker** polls `GetActivityTask` → receives `taskToken` + input JSON
- Worker calls `SendTaskHeartbeat(taskToken)` at intervals ≤ `HeartbeatSeconds`
- Each call **resets the heartbeat clock** — not the execution timeout
- If `HeartbeatSeconds` expires without a heartbeat OR if `TimeoutSeconds` expires overall → `ExecutionTimedOut` → task token invalidated → further `SendTaskHeartbeat` calls fail with `TaskTimedOut`
- Maximum supported wait: **up to 1 year** (with `TimeoutSeconds: 31536000` + active heartbeating)

**Key distinction from Temporal:** Step Functions separates the heartbeat reset (`HeartbeatSeconds`) from the overall execution deadline (`TimeoutSeconds`) — exact same conceptual split as Temporal's Heartbeat Timeout vs StartToClose Timeout. Both better than RTP's single `timeout_seconds`.

#### Hardware Watchdog Timer

- MCU/kernel watchdog: timer counts down from T; firmware must write a specific byte to reset it before T reaches 0
- If main loop hangs (deadlock, exception, infinite loop) → watchdog fires → hardware reset
- **Directly applicable:** PCC kernel daemon running a print job can register a watchdog; if the job control loop hangs, watchdog fires, kernel restarts cleanly
- OS-level: Linux `/dev/watchdog` device; daemon writes to it periodically; kernel panic + reboot on silence

#### Unifying Pattern: Renew-or-Lose

All six mechanisms above (etcd, ZooKeeper, K8s, Step Functions, hardware watchdog, Temporal heartbeat) implement the same pattern:
1. Holder acquires resource with TTL T
2. Holder must actively renew within T
3. Failure to renew → automatic recovery action (key deletion, leadership transfer, container restart, task timeout, hardware reset)
4. Progress state can be preserved in the renewal signal (Temporal heartbeat detail; etcd key value)

**RTP has none of this.** A robot that goes dark mid-job is detected only when `timeout_seconds` expires — a passive timeout, not an active liveness mechanism.

#### Rating vs RTP for PCC

**BETTER.** The lease/dead-man-switch pattern is the highest-value addition PCC can make over RTP for physical kernel reliability. A kernel holding a job lease (etcd or K8s Lease) with heartbeat renewal, combined with Temporal-style heartbeat progress payloads, gives PCC: (a) sub-timeout failure detection, (b) safe job orphan detection, (c) evidence preservation up to last heartbeat, and (d) automatic escrow trigger on silence. RTP requires waiting the full `timeout_seconds` with no intermediate signal.

---

## Part 3 — Comparison Table

PCC evaluation criteria:
1. **Dispatch vs execution timeout split** — detect "kernel never picked up" separately from "kernel hung mid-job"
2. **Heartbeat liveness for long physical jobs** — sub-timeout failure detection with progress preservation
3. **Signed `issued_at` + nonce freshness/replay protection** — prevent replayed payment envelopes
4. **Escrow auto-refund on timeout** — funds return on failure without manual intervention
5. **Signed evidence / provenance** — cryptographically verifiable result (RTP cannot do this; PCC must exceed it)

| Approach | Dispatch/Exec Split | Heartbeat Liveness | Signed issued_at + Nonce | Auto-Refund | Signed Evidence | vs RTP |
|----------|--------------------|--------------------|--------------------------|-------------|-----------------|--------|
| **RTP 1.0 (baseline)** | No (single `timeout_seconds`) | No | `issued_at` + `task_id` dedup (partial) | Yes | No | BASELINE |
| **Temporal 4-timeout taxonomy** | Yes (ScheduleToStart vs StartToClose) | Yes (heartbeat + progress payload) | No (separate concern) | Via saga/compensation | No (separate concern) | BETTER |
| **Cadence (Temporal predecessor)** | Yes (same taxonomy) | Yes (same mechanism) | No | Via saga/compensation | No | BETTER |
| **Saga / compensating transactions** | Indirectly (orchestrator-level) | No (depends on Temporal/SFN) | No | Yes (compensation = refund) | No | BETTER (for multi-step) |
| **Stripe/IETF idempotency keys** | No | No | No (dedup, not replay prevention) | Indirectly (via retry safety) | No | EQUAL (complementary) |
| **EIP-712 / JWT jti+exp** | No | No | Yes (nonce + deadline + domain separator; stateless) | No (separate concern) | Partial (signature on payload) | BETTER (for freshness/replay) |
| **AWS SigV4 `X-Amz-Date` ±15min** | No | No | Yes (signed timestamp + 15min window; ±15min vs RTP ±5min) | No | No | EQUAL (same pattern, wider window) |
| **etcd lease / ZooKeeper ephemeral** | Partially (lease acquisition = dispatch) | Yes (KeepAlive stream; renew-or-lose) | No | Via external observer | No | BETTER (for liveness) |
| **K8s Lease + liveness probe** | No | Yes (liveness probe + lease) | No | Via external observer | No | BETTER (for liveness) |
| **AWS Step Functions HeartbeatSeconds** | Partially (TimeoutSeconds vs HeartbeatSeconds) | Yes (SendTaskHeartbeat; up to 1yr wait) | No | Via state machine failure handling | No | BETTER |
| **Hardware watchdog** | No | Yes (renew-or-reset; hardest guarantee) | No | Via recovery handler | No | BETTER (lowest layer) |

### Synthesis: What PCC Should Adopt from This Survey

| RTP field / behavior | PCC enhancement | Best source pattern |
|---------------------|-----------------|---------------------|
| Single `timeout_seconds` | Split into `dispatch_timeout_s` (kernel pickup SLA) + `execution_timeout_s` (job run SLA) | Temporal ScheduleToStart + StartToClose |
| No heartbeat | Kernel sends `POST /api/jobs/{id}/heartbeat` with last-progress payload at configurable interval | Temporal heartbeat + Step Functions `SendTaskHeartbeat` |
| Heartbeat timeout | Auto-FAILED + auto-refund if heartbeat interval exceeded; configurable, default 120s | Step Functions `HeartbeatSeconds` |
| `issued_at` + 5-min window | Keep + add per-kernel nonce (counter, on-chain or DB-backed) for stateless replay detection | EIP-712 nonce + JWT `jti` |
| `task_id` uniqueness (gateway state) | Keep + consider kernel-scoped nonce to reduce central gateway state | EIP-712 domain separator + nonce |
| Auto-refund on TIMEOUT | Keep; extend to per-step saga compensation for multi-step protocol jobs | Saga orchestration |
| No evidence model | PCC's assurance tiers + ALCOA compliance + ZK proofs + CID storage — the primary differentiator vs RTP | (PCC-native; RTP has no analog) |
| No result signing | Evidence bundles with HMAC/ZK attestation on sensor data; this is PCC's core value add | (PCC-native) |

---

## Sources

- https://github.com/plagtech/rtp-spec (README + spec/RTP-1.0.md)
- https://temporal.io/blog/activity-timeouts
- https://docs.temporal.io/encyclopedia/detecting-activity-failures
- https://cadenceworkflow.io/docs/workflow-troubleshooting/timeouts
- https://cadenceworkflow.io/docs/concepts/activities
- https://learn.microsoft.com/en-us/azure/architecture/patterns/saga
- https://temporal.io/blog/mastering-saga-patterns-for-distributed-transactions-in-microservices
- https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-choreography.html
- https://docs.stripe.com/api/idempotent_requests
- https://stripe.com/blog/idempotency
- https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-05
- https://brandur.org/idempotency-keys
- https://eips.ethereum.org/EIPS/eip-712
- https://docs.aws.amazon.com/IAM/latest/UserGuide/signing-elements.html
- https://dev.to/kanywst/aws-sigv4-and-sigv4a-deep-dive-12li
- https://etcd.io/docs/v3.4/learning/api/
- https://singhajit.com/distributed-systems/lease/
- https://docs.aws.amazon.com/step-functions/latest/dg/concepts-activities.html
- https://docs.aws.amazon.com/step-functions/latest/apireference/API_SendTaskHeartbeat.html
