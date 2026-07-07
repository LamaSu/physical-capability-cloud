# RTP Absorption #03 — First-Class Timeout & Request-Freshness for the PCC Physical-Task Lifecycle

> **Status:** Design proposal (research pass). **No source code is changed by this document.**
> **Scope of this pass:** research + design only. The only artifacts produced are this doc and the
> scratch notes under `docs/rtp-absorption/research-notes/`. No PCC source was modified, no
> dependencies installed, no third-party code executed (clean-room study of open-source projects).
> **Audience:** PCC core maintainers deciding how a *physical* task that hangs — a print that never
> finishes, a kernel that goes dark mid-job, a drone that never acknowledges — should fail safely,
> refund escrow, and stay cryptographically accountable.
> **Baseline to match-or-beat:** RTP (`github.com/plagtech/rtp-spec`) — PCC must do everything RTP does
> (a `timeout_seconds` → `FAILED` → auto-refund clock, plus an `issued_at` 5-minute request-freshness
> window) *plus* thread its signed-evidence/provenance model through the timeout mechanism, which RTP
> does not.
> **Companion docs:** this is the lifecycle/settlement counterpart to
> [`02-connection-transport-abstraction.md`](./02-connection-transport-abstraction.md), and it answers
> that doc's **open question #5** ("how do challenge windows and escrow timeouts interact with
> legitimately-delayed intermittent devices?") and **#7** (the evidence-submit dedup gap).

All code/schema blocks below are **illustrative sketches for discussion only** — they are not real
source files and must not be copied verbatim into the tree. They carry `// ILLUSTRATIVE` banners.

---

## Table of Contents

1. [Why this exists (problem statement)](#1-why-this-exists)
2. [PCC current-state audit (with file cites)](#2-pcc-current-state-audit)
3. [The RTP baseline — what we must match](#3-the-rtp-baseline)
4. [SOTA survey of timeout / freshness / liveness](#4-sota-survey)
5. [Comparison table — options rated vs RTP](#5-comparison-table-rated-vs-rtp)
6. [Recommended PCC-native design](#6-recommended-pcc-native-design)
7. [Illustrative interfaces & schemas](#7-illustrative-interfaces--schemas)
8. [Migration path](#8-migration-path)
9. [Open questions](#9-open-questions)
10. [Appendix — research notes & sources](#10-appendix)

---

## 1. Why this exists

PCC settles real money against real physical work. The happy path is mature: a job runs, the kernel
signs an `EvidenceBundle`, a verifier attests it, escrow releases. But PCC has **no answer to the
unhappy path where nothing comes back**. There is no terminal `timed_out` state, no dispatch deadline,
no per-job heartbeat, and — most consequentially — **no way to ever reclaim escrowed funds from a job
that hangs before evidence is submitted** (§2.5). The money is simply stuck.

This matters more for PCC than for any pure-software task queue, because the failure modes are
physical and the counterparty is paid:

| Failure mode | What happens in PCC today |
|---|---|
| **Dispatch never lands** — external kernel never picks up the job (the no-op dispatch gap from doc 02). | Job sits `queued` **forever**; escrow funded but never released or refunded. |
| **Kernel accepts, then dies mid-run** — power cut, firmware hang, drone loses link. | No heartbeat exists to notice; the in-memory waiter is lost on gateway restart; job is orphaned. |
| **Execution runs past any sane wall-clock** — a 20-minute print stuck at 4 hours. | `JobSpec.constraints.deadlineSeconds` exists but is **never enforced** (`packages/spec/src/types/job-spec.ts:51`). |
| **Replayed / stale request** — a captured "fund" or "submit evidence" call resent later. | Bearer tokens carry no `issued_at`/expiry; the evidence endpoint does not dedup by bundle hash (§2.4). |

RTP at least has a single blunt instrument for the first three: a `timeout_seconds` clock that flips the
task to `TIMEOUT` and auto-refunds, plus a 5-minute `issued_at` freshness window for the fourth. PCC
today has **neither**, and PCC additionally throws away its one structural advantage when it does add
them: a timeout in PCC should not be a bare clock event — it should be a **signed, evidenced,
provenance-bearing fact** that the escrow refund can be audited against. That last clause is the whole
differentiator and the reason this is a PCC-native design rather than "port RTP's field."

---

## 2. PCC current-state audit

Everything below was read first-hand by four read-only auditors; the load-bearing claims (no
`timed_out` state, no escrow reclaim path, `ctx.sleep` unimplemented, the challenge/deadline fields)
were re-verified directly. Citations are repo-relative `path:line`. Full notes:
`docs/rtp-absorption/research-notes/pcc-audit-{lifecycle-timeout,escrow-refund,freshness-replay}.md`.

### 2.1 The task lifecycle today — and the absent state

The canonical kernel job status union is:

```
queued → preparing → executing → collecting_evidence → awaiting_pickup → completed | failed | cancelled
```

(`packages/spec/src/types/kernel.ts:126-128`). **There is no `timed_out` / `TIMEOUT` state anywhere in
the codebase.** Separately, the gateway DB persists *informal* status strings (`active`, `pending`,
`evidence_submitted`, `settled`) with **no CHECK constraint** binding them to the spec enum
(`packages/db/src/schema/jobs.ts:12`) — so even the existing states are not authoritative end-to-end.

The lifecycle is also missing the two transitions that make a timeout *meaningful*: there is **no
explicit dispatch acknowledgement** (the `POST /execute` HTTP response simultaneously *is* the ACK and
the job start — `packages/kernel/src/server.ts:172`), so "kernel never accepted" and "kernel accepted
but stalled" are indistinguishable. RTP at least models `DISPATCHED` vs `IN_PROGRESS`; PCC collapses
them.

### 2.2 Timeouts & deadlines that *do* exist (all partial, none lifecycle-grade)

| Mechanism | What it does | Why it doesn't solve a hung physical job | Cite |
|---|---|---|---|
| `JobRunner.waitForCompletion(120_000ms)` | Local in-process path throws "Job timed out", sets `status="failed"`. | **Local kernel only.** External/remote kernels never reach this code; the dispatch path has no equivalent. | `packages/kernel/src/job-runner.ts:207` |
| `AnomalyDetector.recordJobDuration()` | Flags duration drift (5 min warn / 15 min critical). | **Retroactive telemetry, not enforcement** — it never cancels or fails the job. | `packages/kernel/src/anomaly-detector.ts:117` |
| `JobSpec.constraints.deadlineSeconds` | "Hard wall-clock after JobSpec sealed." | **Field exists, zero runtime enforcement.** Nothing reads it to time anything out. | `packages/spec/src/types/job-spec.ts:51` |
| Kernel SDK `execute()` | Runs the operator's handler synchronously. | **Unbounded** — a hung handler blocks indefinitely; no `AbortController`/deadline wraps it. | `packages/kernel-sdk/src/job-handler.ts:220` |
| `ProtocolRunner` (multi-step) | Tracks runs in `Map<string, ProtocolRun>`. | **Entirely in-memory** — a gateway crash loses every in-flight run, deadlines included. | `packages/orchestrator/src/protocol-runner.ts:24` |

### 2.3 Heartbeat & acknowledgement today (kernel/agent grain, never job grain)

PCC *does* have liveness machinery — but it operates one or two levels above the job, and **none of it
touches an in-flight job**:

- **Kernel staleness**: `isKernelStale()` marks a kernel `available=false` after 5 min (and offline
  after 24 h). It affects *discovery/routing only* — it never fails the jobs that kernel is running
  (`packages/gateway/src/facades/populators/staleness.ts:20,42`).
- **Agent "rogue" detection**: 150 s of agent silence revokes that agent's *execution scopes*; it does
  **not** fail the job (`packages/gateway/src/services/agent-heartbeat-monitor.ts:42`). This is the
  closest existing watchdog — and the right pattern to copy down to job grain (§6).
- **No job-level heartbeat**: there is no `POST /api/jobs/:jobId/heartbeat`; a kernel has no way to say
  "still printing, 60% done" and the gateway has no way to notice it stopped saying so.

### 2.4 Request-freshness & replay today

The freshness/TTL surface is real but uneven, and the strongest control (block-anchored anti-replay)
is **opt-in**:

| Window | Default | Cite |
|---|---|---|
| `WorkflowChallenge.maxAgeSeconds` (evidence anti-replay) | **600 s (10 min)** | `packages/spec/src/types/evidence.ts:155` |
| Capture nonce (CVP "Contemporaneous" hard cap) | **120 s** | `packages/.../challenge-service.ts:36-37,209` |
| Idempotency cache TTL (`IDEMPOTENCY_TTL_MS`) | **24 h** | `packages/gateway/src/middleware/idempotency.ts:23` |
| Negotiation session | **30 min** (lazy, checked on read) | `packages/spec/src/types/negotiation.ts:203-204` |
| Execution scope | **30 min** default (doc max 120 min) | `packages/gateway/src/routes/ot2-scope.ts:84` |
| Wizard session | **24 h** | `packages/gateway/src/routes/wizard.ts:62` |
| SIWE session cookie | **24 h** | `packages/.../auth/siwe-auth.ts:28` |
| Attestation `expirationTime` | **0 = never** (optional) | `packages/attestations/src/off-chain.ts:200` |

**Anti-replay PCC HAS:** block-anchored `WorkflowChallenge` + `ExecutionProof` (the proof binds to a
specific `blockHash` with strict `computedAtBlock > anchor.blockNumber` ordering —
`packages/spec/src/types/evidence.ts:143-165`); a 120 s capture nonce with visual echo + block anchor;
permanent on-chain `captureHash` dedup; per-attestation EIP-712 32-byte random salt.

**Anti-replay PCC LACKS:**
1. **No signed inbound request-freshness.** Inbound calls carry a static Bearer token (no `issued_at`,
   no expiry) or a 24 h SIWE cookie. **Zero gateway routes check a signed timestamp on the HTTP
   envelope** — a stolen Bearer is valid indefinitely. RTP's `issued_at` 5-min window has **no PCC
   equivalent**.
2. **The verifier's freshness check is optional.** Omitting `challenge`/`executionProof` silently skips
   the block-time anti-replay check (`packages/verifier/src/evidence-verifier.ts:156`).
3. **No evidence dedup.** `POST /api/operator/evidence` mints a fresh `bundleId` per call and does not
   dedup by `bundleHash` (`packages/.../operator-relay.ts:120`) — doc 02 open Q7, confirmed.
4. **Idempotency covers only 3 routes** (quote/simulate/route) — **not** escrow-fund or job-submit.
5. **No consumed-challenge set** — replay defense leans on the TTL window alone, never single-use IDs.

The threat model nominally claims coverage — "Replay old telemetry → Nonce in job commitment;
timestamps checked against block time" (`docs/THREAT_MODEL.md`) — but that mitigation is only *partially
true* (the check is opt-in) and the 58-line document does not address the dedup gap, stolen-token
replay, the stale-HTTP-request window, or lazy scope expiry.

### 2.5 Escrow refund semantics today — the locked-funds gap

`MilestoneEscrowV2` (and V1, and the draft V3) share one 9-value status enum
(`packages/contracts/src/MilestoneEscrowV2.sol:94`):

```
Unfunded(0) → Funded(1) → Locked(2) → Evidenced(3) → Attested(4) → Released(5) | Disputed(6) | Refunded(7) | Slashed(8)
```

**There is no `reclaim`, `cancel`, `expire`, or deadline-gated function in any version.** The full
function set (`:415-1165`) is initialize / addMilestone / fund / depositBond / submitEvidence /
submitAttestation / release / fileDispute / resolveDispute (+ views). Every `deadline`/`expire` token
in the source is a *comment about the challenge window*, not a job deadline.

Consequently, **`Refunded(7)` is reachable only via `resolveDispute(idx, true)`**
(`:1113-1156`), and `fileDispute()` requires the milestone to already be `Attested`
(`:1080`). So the exact failure this document targets — **a job that hangs *before* evidence is ever
submitted** — can never reach a disputable state. Funds sit in `Funded`/`Locked`
**permanently**. The `MilestoneRefunded` event (`:265`) is defined but unreachable on a hung job. The
off-chain settlement ledger even has a `deadline` column (`packages/db/src/schema/settlement.ts:13`)
that nothing enforces on-chain.

- **Challenge window:** set inside `submitAttestation()` as `block.timestamp + m.challengeWindowSeconds`
  (`MilestoneEscrowV2.sol:857-911`); `release()` (`:940`, "after challenge window expires") requires it
  *closed*, `fileDispute()` requires it *open*. It governs a *completed* job's dispute period — not a
  *stalled* job's refund.
- **Nearest existing analog:** the MPP "default payment protocol" session has a 30-min idle
  `timeoutMs` (`packages/payments/src/mpp-session.ts:87`) — but timeout only triggers a **soft
  off-chain `close()`**; **no on-chain escrow action occurs**. This is the pattern to extend on-chain.
- **Which contract to target:** V3 is a draft (adds payer `approveAndRelease()` —
  `MilestoneEscrowV3.sol:839` — but no timeout path) and is **not yet deployed**, so a refund-on-timeout
  function should land in V3-pre-deploy or a V4 rather than patching the deployed V2.

### 2.6 PCC HAS vs LACKS — the honest ledger

**PCC already HAS:**
1. A signed, content-addressed **evidence model** + verifier + tier requirements (`evidence.ts:168-211`)
   — the substrate to make a *timeout itself* an evidenced fact.
2. **Block-anchored anti-replay** primitives (`WorkflowChallenge`/`ExecutionProof`, `evidence.ts:143-165`)
   and transport-agnostic **Ed25519 sign/verify** (`packages/a2a/src/crypto.ts`, per doc 02).
3. A **durable execution runtime** (`@pcc/workflow`) with Activity retry + 3-tier idempotency keys,
   `ctx.step()` memoization, and `WorkflowEngine.recover()` (`packages/workflow/src/workflow/engine.ts:158,353`)
   — and escrow routes are **already wired onto it** (`packages/gateway/src/activities/escrow.ts`;
   `routes/escrow.ts:199,303,345,429`). *(Note: CLAUDE.md's "escrow not yet migrated" is stale.)*
4. A working **watchdog pattern** (agent-heartbeat-monitor, 150 s → scope revoke) to copy to job grain.
5. **TTL precedents** (negotiation 30 min, execution scope 30 min, wizard 24 h, idempotency 24 h) and an
   unenforced **`deadlineSeconds`** field already in the spec.
6. An **idempotency middleware** and an off-chain **settlement ledger with a `deadline` column**.

**PCC LACKS (the gaps this design closes):**
1. **A first-class `timed_out` lifecycle state** (and any way to distinguish dispatch vs execution vs
   liveness failure).
2. **A dispatch deadline** — external-kernel jobs sit `queued` forever (doc 02's no-op dispatch gap).
3. **An enforced execution deadline** — `deadlineSeconds` and `execute()` are both unbounded.
4. **A job-level heartbeat** + heartbeat-timeout (kernel-went-dark detection).
5. **A two-phase dispatch ACK** (so "never accepted" ≠ "accepted then stalled").
6. **A crash-safe deadline timer** — `ctx.sleep()` throws `NotImplementedError`
   (`engine.ts:416`); in-memory waiters die on restart; no hung-job reaper exists.
7. **Signed request-freshness + nonce replay** on inbound calls (no `issued_at`/expiry/nonce, evidence
   dedup gap).
8. **Escrow auto-refund-on-timeout** — funds are unrecoverable on a pre-evidence hang (§2.5).
9. **Timeout provenance** — no `timeout_attestation` evidence type to make a refund auditable.

---

## 3. The RTP baseline

RTP gives the physical-task lifecycle exactly two timeout/freshness mechanisms, both deliberately
minimal (source: `research-notes/rtp-spec-study.md` + `sota-timeout-and-rtp.md`):

### 3.1 The single `timeout_seconds` clock

- A Task Envelope carries an optional **`timeout_seconds`** (default **60**). It is a **single clock**
  covering *both* dispatch (`DISPATCHED → IN_PROGRESS`) *and* execution (`IN_PROGRESS → COMPLETED`).
- On expiry the gateway moves the task to **`TIMEOUT`** and **auto-refunds** the escrowed payment to the
  agent.
- RTP lifecycle: `PENDING → DISPATCHED → IN_PROGRESS → COMPLETED | FAILED | TIMEOUT`. `COMPLETED`
  releases escrow; `FAILED`/`TIMEOUT` refund it.
- **No heartbeat.** A silent robot is only noticed at the *full* `timeout_seconds` expiry — there is no
  mid-execution liveness signal, and no way to give a long-but-healthy job more time.
- **No dispatch/execution split.** A robot that's slow to *accept* and a robot that's slow to *finish*
  are charged against the same clock.

### 3.2 The `issued_at` 5-minute freshness window

- Every envelope carries a required **`issued_at`** (ISO-8601). The gateway rejects any envelope where
  `|now − issued_at| > 300 s` (a 5-minute window), **before** validating x402 payment — a cheap
  stale/replay filter.
- **Replay protection** = `task_id` uniqueness (the gateway must remember every `task_id` it has seen)
  **plus** the `issued_at` window. There is **no cryptographic nonce**, and `issued_at` is **not
  signed** — it rides in the envelope and is trusted as-is.

### 3.3 The RTP checklist PCC must cover — and beat

To match RTP, PCC needs: a task-timeout that flips state and auto-refunds; a request-freshness window
that rejects stale/replayed calls. **PCC then adds, on top of each:** a *split* dispatch-vs-execution
(vs RTP's single clock); a *heartbeat* liveness signal for long physical jobs (RTP has none); a
*signed* `issued_at`+nonce+expiry (vs RTP's unsigned `issued_at` + stateful `task_id` set); a
*crash-safe* durable timer (RTP says nothing about gateway restarts); and — the differentiator — a
**signed, verifier-attested `timeout_attestation`** so the auto-refund is provenance-bearing instead of
fired on a bare clock. §6 is how we get all of that.

---

## 4. SOTA survey

Each approach below was studied clean-room (full notes: `research-notes/sota-timeout-and-rtp.md`). For
each: the idea, how it maps to a physical task that hangs, and the lesson PCC takes.

### 4.1 Temporal — the activity timeout taxonomy (the model to adopt)

Temporal splits an activity's life into **four** distinct timeouts, which is precisely the
dispatch/execution distinction RTP collapses:

| Temporal timeout | Covers | Physical-task analog |
|---|---|---|
| **ScheduleToStart** | Time in the queue before a worker *picks it up*. | Kernel hasn't *accepted* the job yet (dispatch). |
| **StartToClose** | Time from pickup to completion of *one attempt*. | The machine is running but hasn't *finished* (execution). |
| **Heartbeat** | Max gap between `RecordActivityHeartbeat` calls. | Kernel went *dark* mid-run (liveness). |
| **ScheduleToClose** | Total wall-clock across all retries. | The job's hard SLA. |

The **heartbeat** carries a *details* payload (last-known progress) that survives into the next retry —
the direct model for "still printing, layer 240/400, last evidence event = 0x…". A heartbeat timeout
fires *long before* a multi-hour `StartToClose` would, so a dead kernel is caught in seconds, not hours.
**Lesson: adopt the dispatch/execution/heartbeat split wholesale.**

### 4.2 Cadence — same taxonomy, proven at scale

Cadence (Temporal's predecessor) has the identical activity/decision timeout model. Its relevance is
confirmation: the four-timeout taxonomy is battle-tested in production task systems, not a Temporal
idiosyncrasy. **Lesson: the model is safe to standardize on.**

### 4.3 Saga / compensation — the conceptual parent of auto-refund

A saga executes a sequence of steps, each with a **compensating action** that undoes it. If a step
fails or times out, the saga runs the compensations for all completed steps in reverse. **RTP's
"auto-refund on timeout" is a degenerate one-step saga**: the only completed step is "escrow funded,"
and its compensation is "refund." PCC's milestone escrow is *natively* multi-step (milestones), so the
saga framing generalizes cleanly: a timeout compensates the *unreached* milestones (refund) while
*reached* ones stay released. **Lesson: model timeout-refund as compensation, per-milestone, not
all-or-nothing.**

### 4.4 Idempotency keys with freshness windows (Stripe / IETF)

Stripe idempotency keys are retained ~24 h: a retried request with the same key returns the original
result instead of re-charging. The IETF `Idempotency-Key` draft generalizes this. This is **retry
de-duplication, not replay prevention** — it protects against *honest* double-sends, not *malicious*
ones. PCC's idempotency middleware (24 h TTL) is exactly this and is complementary to, not a substitute
for, a nonce. **Lesson: keep idempotency for retries; add a nonce for replay — they are different
controls** (and today idempotency doesn't even cover the payment routes — §2.4).

### 4.5 Nonce / replay + signed-request freshness (EIP-712, JWT, SigV4)

The general pattern across mature systems is **signed `issued_at` + max-age + single-use nonce**:
- **EIP-712 / on-chain nonces** — a per-account monotonic or random nonce makes each signed message
  single-use; PCC already uses a 32-byte EIP-712 salt per attestation.
- **JWT `jti` + `exp`** — a unique token ID plus a hard expiry; the verifier rejects expired or
  replayed `jti`s.
- **AWS SigV4 `X-Amz-Date`** — the request is *signed over its timestamp* and rejected outside a
  clock-skew window (~5–15 min). This is RTP's `issued_at` **done right**: signed, not trusted.
**Lesson: RTP's unsigned `issued_at` + `task_id` set is the weakest version of this. PCC should sign
the freshness fields (it already has Ed25519 keys) and add a single-use nonce with a consumed-set TTL.**

### 4.6 Lease / dead-man-switch / watchdog (etcd, K8s, SWF, hardware)

The "renew-or-lose" family detects failure *between* timeouts by requiring continuous proof of life:
- **etcd lease** — a key with a TTL that must be `keepAlive`-renewed; if renewal stops, the key is
  deleted and watchers fire. **A deleted lease = an automatic "job orphaned" signal.**
- **ZooKeeper / Chubby ephemeral nodes** — vanish when the session's heartbeat lapses.
- **Kubernetes Lease + liveness probes** — a failed probe restarts the container; the Lease object
  drives leader failover.
- **AWS Step Functions `HeartbeatSeconds`** — an activity task can wait up to a *year* as long as it
  keeps heartbeating; miss a heartbeat and it fails immediately. This is the exact shape PCC wants: a
  long physical job is *allowed* to be long, but must *prove* it's alive.
- **Hardware watchdog timers** — the kernel-side complement: a counter the firmware must reset, or the
  device resets itself. The hardest dead-man-switch, and the right last line of defense for a kernel
  that has truly hung (ties to §6.4 and doc 02's constrained-device classes).
**Lesson: a missed heartbeat should *lease-expire* a job into `timed_out`, and the kernel-side watchdog
is the physical backstop.**

---

## 5. Comparison table — options rated vs RTP

"Rating vs RTP" answers: *for PCC's needs — distinguish dispatch from execution, detect a dark kernel
mid-job, sign freshness + dedup replay, auto-refund on timeout, **and** keep the timeout
provenance-bearing — is this approach WORSE / EQUAL / BETTER than RTP's single-clock + unsigned
`issued_at`?* Only EQUAL-or-better mechanisms are adopted into the design.

| Approach | RTP analog | Dispatch/exec split | Mid-job liveness | Signed freshness + replay | Refund-on-timeout fit | Preserves evidence | **vs RTP** |
|---|---|---|---|---|---|---|---|
| **Temporal 4-timeout taxonomy** | `timeout_seconds` | **Yes** (Sched/Start/Close) | **Yes** (heartbeat + detail) | n/a (orchestration) | via app | n/a | **BETTER** |
| **Cadence (same taxonomy)** | `timeout_seconds` | Yes | Yes | n/a | via app | n/a | **BETTER** |
| **Saga / compensation** | auto-refund | n/a | n/a | n/a | **Excellent** (per-milestone) | n/a | **BETTER** (multi-step) |
| **Step Functions `HeartbeatSeconds`** | *(none)* | **Yes** | **Yes** (up to 1-yr w/ heartbeat) | n/a | via app | n/a | **BETTER** |
| **etcd / ZK / K8s lease** | *(none)* | partial | **Yes** (renew-or-lose) | n/a | orphan signal | n/a | **BETTER** |
| **Hardware watchdog** | *(none)* | no | **Yes** (kernel-side) | no | no | n/a | **BETTER** (backstop) |
| **EIP-712 nonce / JWT `jti`+`exp`** | `task_id` + `issued_at` | n/a | n/a | **Yes** (signed, single-use) | n/a | compatible | **BETTER** |
| **AWS SigV4 `X-Amz-Date`** | `issued_at` | n/a | n/a | **Yes** (signed timestamp) | n/a | compatible | **EQUAL/BETTER** (RTP's window is unsigned) |
| **Stripe / IETF idempotency keys** | *(none)* | n/a | n/a | retry-dedup only | n/a | compatible | **EQUAL** (complementary, not a nonce) |
| **RTP single `timeout_seconds`** | — | **No** | **No** | unsigned `issued_at` + `task_id` | refund (self-clocked) | **No** | *(baseline)* |

### 5.1 Mapping RTP's two mechanisms → recommended PCC design

| RTP mechanism | PCC design (this doc) | Concrete shape | Why it beats RTP |
|---|---|---|---|
| `timeout_seconds` (single clock) | **Three clocks**: `dispatch_timeout_s`, `execution_timeout_s`, `heartbeat_timeout_s` | First-class `timed_out{cause}` state; Temporal/SFN taxonomy | Catches a dark kernel in seconds; lets a long-but-healthy job continue while heartbeating; transport-aware dispatch window (answers doc 02 Q5). |
| auto-refund on `TIMEOUT` | **Evidenced auto-refund**: `reclaimAfterDeadline()` gated on a verifier-attested `timeout_attestation` | New escrow fn (V3-pre/V4) + durable `@pcc/workflow` Activity | Refund is provenance-bearing and ALCOA+ accountable, not fired on a bare unsigned clock; per-milestone (saga) not all-or-nothing. |
| unsigned `issued_at` + `task_id` set | **Signed freshness envelope**: Ed25519 over `{issuedAt, expiry, nonce, jobId}` + single-use nonce set | Extends doc 02's `TransportEnvelope`; reuses `a2a/crypto` | Signed (not trusted), single-use nonce (not just TTL), closes the stolen-Bearer and evidence-dedup gaps. |

---

## 6. Recommended PCC-native design

### 6.1 Design principles

1. **Timeout is a first-class lifecycle state, not an ad-hoc timer.** Promote `timed_out` to a real
   terminal state alongside `failed`/`cancelled`, carrying a `cause` discriminator. A timeout is a
   *fact about the job*, persisted and queryable — not a log line.
2. **Split the clock (beat RTP).** Three deadlines, mapped to Temporal/SFN: dispatch, execution,
   heartbeat. They are *transport-aware* (a Waku/XMTP store-and-forward kernel from doc 02 legitimately
   takes hours to accept — its `dispatch_timeout_s` is large or shadow-driven).
3. **Durable & crash-safe (beat RTP).** Deadlines live in the `@pcc/workflow` EventStore so they survive
   a gateway restart — not in the in-memory waiters that die today. Near-term: a reaper Activity.
   Long-term: native `ctx.sleep()` durable timers (v0.2).
4. **The timeout is sacred evidence.** A timeout emits a signed `timeout_attestation` evidence event; a
   verifier attests it; the escrow refund references its CID. **This is the clause RTP cannot satisfy.**
5. **Reuse before build.** Reuse `EvidenceBundle`/verifier (untouched), `a2a/crypto` Ed25519 (freshness
   signatures), the agent-heartbeat-monitor watchdog pattern, the `@pcc/workflow` escrow Activities, and
   doc 02's `TransportEnvelope`. Add only: the state + cause enum, three deadlines, the job heartbeat,
   the signed freshness fields, the `timeout_attestation` event, and one escrow function.
6. **Opt-in, zero-break.** Jobs without deadlines behave exactly as today; `timed_out` is additive.

### 6.2 The lifecycle, with dispatch/execution/heartbeat made observable

```
ILLUSTRATIVE — proposed lifecycle (additions in **bold**), not a code change

  queued ──dispatch──▶ **dispatched** ──ack(within dispatch_timeout_s)──▶ **accepted**
                            │                                                  │
            (no ack in dispatch_timeout_s)                          executing ◀─┘  ──heartbeat every ≤ heartbeat_timeout_s──▶ (loops)
                            │                                                  │
                            ▼                          (no heartbeat)          │ (complete within execution_timeout_s)
                   **timed_out{dispatch}**  ◀──────────────────────────────────┤
                            │                  **timed_out{heartbeat}**         ▼
                            │                  **timed_out{execution}**   collecting_evidence ─▶ awaiting_pickup ─▶ completed
                            ▼
                   escrow reclaimAfterDeadline()         failed (kernel reported error)   cancelled (payer/agent aborted)
```

The three new terminal `timed_out` causes are kept **distinct** from `failed` (the kernel ran and
reported an error — there *is* attempt evidence) and `cancelled` (a principal deliberately aborted).
This distinction drives refund policy (§6.5) and dispute eligibility.

### 6.3 The three deadlines

| Deadline | Window | Temporal/SFN analog | Fires when | Default source |
|---|---|---|---|---|
| `dispatch_timeout_s` | `queued`/`dispatched` → `accepted` | ScheduleToStart | kernel never acknowledges | transport-aware: small for `https`, large/shadow-driven for store-and-forward (doc 02 `connection.capabilities.storeAndForward`) |
| `execution_timeout_s` | `accepted` → `collecting_evidence` | StartToClose | work runs past its hard wall-clock | `JobSpec.constraints.deadlineSeconds` (finally enforced) + capability hint |
| `heartbeat_timeout_s` | rolling, during `executing` | Heartbeat / `HeartbeatSeconds` | kernel goes dark mid-run | capability/tier; default ≈ the existing 150 s watchdog cadence |

`heartbeat_timeout_s` is what lets a *legitimately long* physical job (a 6-hour CNC run) proceed without
a huge `execution_timeout_s`: the job may take hours, but it must *prove liveness* every ≤
`heartbeat_timeout_s`, exactly like Step Functions.

### 6.4 Acknowledgement, heartbeat & the kernel-side watchdog

- **Two-phase dispatch.** A new `POST /api/jobs/:jobId/ack` lets a kernel confirm receipt:
  `dispatched → accepted`, which *stops* `dispatch_timeout_s` and *starts* `execution_timeout_s` +
  `heartbeat_timeout_s`. This is the missing ACK from §2.1 and disambiguates "never accepted" from
  "accepted then stalled."
- **Job heartbeat.** A new `POST /api/jobs/:jobId/heartbeat { progress, lastEventHash? }` resets
  `heartbeat_timeout_s` and carries last-known progress (Temporal's heartbeat *detail*). The gateway's
  hung-job reaper (§6.6) treats a lapsed heartbeat as a lease expiry → `timed_out{heartbeat}`.
- **Kernel-side watchdog (backstop).** For constrained/intermittent kernels (doc 02 classes b–d) that
  cannot ping every 150 s, "liveness" is the **device-twin shadow `reported` version bump** from doc 02,
  not an HTTP heartbeat — and a firmware watchdog timer is the physical last resort. The heartbeat is
  therefore *transport-aware*, the same way the dispatch window is.

### 6.5 Escrow auto-refund-on-timeout (the evidenced version)

When a job reaches `timed_out`, the gateway runs a **durable `@pcc/workflow` Activity** (escrow is
*already* on this runtime — §2.6) that:

1. **Emits a `timeout_attestation` evidence event** (§7.4): `{ cause, lastHeartbeatAt, lastEventHash,
   blockAnchor, deadline, observedAt }`, hashed and signed. When the kernel is dark, the **gateway signs
   it as the observing principal**, chaining onto the last *kernel-signed* heartbeat — so provenance is
   preserved (ALCOA+ "Attributable": the observer is a known principal). For tier 2/3 a verifier quorum
   MAY co-sign (open Q #4).
2. **Calls a new escrow function `reclaimAfterDeadline(milestoneIndex)`** (§7.3) on the **V3-pre-deploy
   / V4** contract. It requires `status ∈ {Funded, Locked}` (i.e., *before* `Attested` — exactly the gap
   in §2.5), `block.timestamp > deadline`, refunds the milestone to the payer, sets `status = Refunded`,
   and emits `MilestoneRefunded`. Per-milestone (saga compensation — §4.3): reached milestones stay
   released, only unreached ones refund.
3. **References the attestation CID** in the refund so the on/off-chain record points at *why* the
   refund happened. RTP refunds on a bare clock; PCC refunds against a signed, verifier-checkable fact.

**Until the contract ships**, the same Activity records a refund-*intent* in the off-chain settlement
ledger (the `deadline` column already exists — `db/src/schema/settlement.ts:13`) and reconciles to
`reclaimAfterDeadline()` once V4 is live. Because the Activity is idempotent and crash-recoverable, a
refund is never double-issued and never lost to a restart.

This is the precise answer to **doc 02 open question #5**: a store-and-forward device's *long but
legitimate* delay is absorbed by a transport-aware `dispatch_timeout_s` (and the shadow model), so the
deadline that triggers refund is set with knowledge of the transport — a Waku-queued job is not refunded
just because it took 3 hours to be picked up.

### 6.6 The crash-safe deadline timer

Today there is no durable timer (`ctx.sleep()` throws — `engine.ts:416`) and in-memory waiters die on
restart. Two-track resolution:
- **Near-term — reaper Activity.** A periodic `@pcc/workflow` Activity scans for jobs whose
  `dispatch`/`execution`/`heartbeat` deadline has passed (the deadlines persisted in the EventStore) and
  drives the `timed_out` transition + refund. Crash-safe because the deadlines and the reaper's progress
  are both durable. This is the etcd-lease "watcher fires on expiry" pattern, polled.
- **Long-term — native durable timers.** When `ctx.sleep()` lands in `@pcc/workflow` v0.2, each job
  workflow simply `await ctx.sleep("deadline", execution_timeout_ms)` races against completion — the
  reaper becomes unnecessary. The design is forward-compatible: the reaper is an interim implementation
  of the same semantics.

### 6.7 Signed request-freshness & replay

Extend doc 02's `TransportEnvelope` (which already carries `nonce` + `ts`) into a signed freshness
contract applied to every state-changing inbound call (dispatch, ack, heartbeat, result, escrow-intent):

- Add **`issuedAt`** + **`expiry`** to the envelope; the **`senderSig`** (Ed25519 via `a2a/crypto`) now
  covers `{payloadHash, issuedAt, expiry, nonce, jobId}`. RTP's `issued_at` is *trusted*; PCC's is
  *signed*.
- The gateway checks: `|now − issuedAt| ≤ freshnessWindow` using **`Date.now()`** (constraint C-3 —
  block timestamps lag), `now < expiry`, and **`nonce ∉ consumedSet`** (single-use; consumed-set TTL =
  `freshnessWindow`). This is the EIP-712/JWT/SigV4 pattern, threaded through PCC's existing keys.
- This simultaneously closes §2.4's gaps: stolen Bearer tokens stop being replayable, and the evidence
  endpoint dedups by `bundleHash` (constraints C-2, C-6) instead of minting a fresh `bundleId`.

### 6.8 Conformance invariants (what any timeout/freshness change MUST preserve)

Derived from the verifier's requirements and the freshness auditor's findings; a change is non-compliant
if it violates any (mirrors doc 02 §6.4):

1. **Bundle immutability** — replay/freshness keys live *alongside* bundles, never inside; `bundleHash`
   must not change (C-1).
2. **Single-use challenge/nonce** — a consumed-ID set with TTL = `maxAgeSeconds`/`freshnessWindow`;
   never rely on the window alone (C-2).
3. **Wall-clock for request freshness** — use `Date.now()`, not block time (C-3).
4. **Refund must be evidenced** — `reclaimAfterDeadline()` is gated on a `timeout_attestation`; no
   unevidenced auto-refund (the RTP anti-pattern).
5. **Timeout attestation chains real signatures** — gateway-observed timeout references the last
   *kernel-signed* heartbeat; provenance is additive, never forged over the sealed bundle.
6. **Evidence dedup by `bundleHash`**, not a random ID (C-6).
7. **Attestation `expirationTime` (if set) outlives the dispute window** — up to 72 h for tier 3 (C-4).
8. **Capture-nonce ≤ 120 s stays** — it is the ALCOA+ "Contemporaneous" anchor; do not loosen (C-5).
9. **Per-milestone refund** — timeout compensates only *unreached* milestones (saga semantics).
10. **Transport-aware deadlines** — `dispatch_timeout_s`/`heartbeat_timeout_s` are functions of the
    kernel's `connection` spec (doc 02), so store-and-forward devices are not falsely timed out (C-7's
    proactive-stop also applies: a real timeout should issue a hardware STOP, not just reject calls).

---

## 7. Illustrative interfaces & schemas

> **Discussion sketches, not source files.** Shapes are aligned with existing PCC types
> (`@pcc/spec`, `a2a/crypto`, `MilestoneEscrowV2`) so reviewers can judge fit. Do not paste into the tree.

### 7.1 The lifecycle state + timeout cause

```ts
// ILLUSTRATIVE — proposed addition to @pcc/spec job status (NOT real source)
// extends packages/spec/src/types/kernel.ts:126-128

export type KernelJobStatus =
  | "queued" | "dispatched" | "accepted"        // ← dispatched/accepted are new (the ACK split)
  | "preparing" | "executing"
  | "collecting_evidence" | "awaiting_pickup"
  | "completed" | "failed" | "cancelled"
  | "timed_out";                                // ← NEW first-class terminal state

export type TimeoutCause = "dispatch" | "execution" | "heartbeat";

export interface JobTimeoutMeta {
  cause: TimeoutCause;
  deadlineSeconds: number;       // the breached window
  lastHeartbeatAt?: string;      // RFC3339; present for cause:"heartbeat"
  lastEventHash?: string;        // last kernel-signed evidence event seen
  attestationCid?: string;       // CID of the timeout_attestation (§7.4)
}
```

### 7.2 The three deadlines on the job spec

```ts
// ILLUSTRATIVE — extends ConstraintsSchema at packages/spec/src/types/job-spec.ts:49-59
// (deadlineSeconds already exists at :51 but is unenforced — this wires it up + splits it)

export interface TimeoutPolicy {
  dispatchTimeoutS: number;      // queued/dispatched → accepted (transport-aware default)
  executionTimeoutS: number;     // accepted → collecting_evidence (from deadlineSeconds)
  heartbeatTimeoutS: number;     // max gap between heartbeats while executing
  // omitted fields ⇒ no timeout for that phase (back-compat: today's behavior)
}
```

### 7.3 The escrow `reclaimAfterDeadline` (the missing refund path)

```solidity
// ILLUSTRATIVE — proposed for MilestoneEscrowV3 (pre-deploy) or V4. NOT real source.
// Closes the gap at MilestoneEscrowV2.sol: Refunded(7) is only reachable via resolveDispute.

uint256 deadline;  // per-milestone; set at addMilestone()/fund() time

function reclaimAfterDeadline(uint256 milestoneIndex)
    external
    nonReentrant
    milestoneExists(milestoneIndex)
{
    Milestone storage m = milestones[milestoneIndex];
    // Only a job that hung BEFORE attestation — the exact §2.5 gap:
    require(m.status == MilestoneStatus.Funded || m.status == MilestoneStatus.Locked, "not refundable");
    require(block.timestamp > m.deadline, "deadline not reached");
    // Optional: require a recorded timeout_attestation CID (invariant 4) — see open Q #8.
    m.status = MilestoneStatus.Refunded;          // status 7, now reachable on a hung job
    _transfer(payer, m.amount);                    // full refund; protocol fee NOT taken (open Q #5)
    emit MilestoneRefunded(milestoneIndex, m.amount);
}
```

### 7.4 The `timeout_attestation` evidence event (provenance for the refund)

```jsonc
// ILLUSTRATIVE — a new EvidenceEvent type, hashed/signed like every event
// (mirrors the DEFAULT_TIER_REQUIREMENTS event-type pattern at evidence.ts:168-211)
{
  "type": "timeout_attestation",
  "timestamp": "2026-06-22T15:04:05Z",
  "source": { "kernelId": "kernel_drone_alpha", "observerId": "gateway-prod-1" },
  "payload": {
    "cause": "heartbeat",
    "deadlineSeconds": 150,
    "lastHeartbeatAt": "2026-06-22T15:01:30Z",
    "lastEventHash": "sha256:…",          // chains onto the last KERNEL-signed heartbeat
    "blockAnchor": { "chainId": 84532, "blockNumber": "…", "blockHash": "0x…" }
  },
  "hash": "sha256:…"                       // gateway-signed when the kernel is dark (invariant 5)
}
```

### 7.5 The signed freshness envelope (extends doc 02's `TransportEnvelope`)

```ts
// ILLUSTRATIVE — additive fields on the doc-02 TransportEnvelope. NOT real source.
export interface FreshnessFields {
  issuedAt: string;     // RFC3339; SIGNED (RTP leaves issued_at unsigned)
  expiry: string;       // RFC3339; hard reject after this
  nonce: string;        // single-use; gateway keeps a consumedSet with TTL = freshnessWindow
  // senderSig (already in TransportEnvelope) now covers:
  //   { payloadHash, issuedAt, expiry, nonce, jobId }  — Ed25519 via a2a/crypto.ts:sign
}
// Gateway check (illustrative):
//   assert Math.abs(Date.now() - Date.parse(issuedAt)) <= FRESHNESS_WINDOW_MS   // C-3: wall clock
//   assert Date.now() < Date.parse(expiry)
//   assert !consumedNonces.has(nonce); consumedNonces.add(nonce, ttl=FRESHNESS_WINDOW_MS)
//   assert verify(senderSig, signerPubKey)                                       // RTP can't: unsigned
```

---

## 8. Migration path

Phased, opt-in, modeled on the `@pcc/workflow` adoption ladder. The evidence model and verifier are
**never** modified; every phase is independently shippable.

**Phase 0 — State + cause enum, no behavior change (LOW risk).**
Add `timed_out` + `TimeoutCause` + `JobTimeoutMeta` to `@pcc/spec`; add `TimeoutPolicy` and *wire*
`deadlineSeconds`. Add the conformance test suite (§6.8). Deadlines are *computed and logged only* — no
job is actually timed out yet. *No existing behavior changes.*

**Phase 1 — Dispatch timeout + two-phase ACK + the reaper (MEDIUM risk).**
Add `POST /api/jobs/:id/ack`; add the durable reaper Activity that drives `timed_out{dispatch}` when an
external kernel never acknowledges — finally closing doc 02's no-op dispatch gap. In-flight HTTPS jobs
untouched. Deadlines persisted in the `@pcc/workflow` EventStore (crash-safe).

**Phase 2 — Job heartbeat + heartbeat timeout + timeout-as-evidence (MEDIUM risk).**
Add `POST /api/jobs/:id/heartbeat`; reuse the agent-heartbeat-monitor pattern at job grain;
`timed_out{heartbeat}`/`{execution}` transitions. Emit the `timeout_attestation` evidence event and have
the verifier attest it. *Brings dark-kernel detection in seconds.*

**Phase 3 — Signed freshness + nonce + dedup (MEDIUM risk; security-relevant).**
Add `issuedAt`/`expiry`/`nonce` to the inbound envelope, signed via `a2a/crypto`; consumed-nonce set;
dedup the evidence endpoint by `bundleHash`; extend idempotency to the payment routes. (If implemented,
this is the kind of change that warrants Gate A/Gate B before ship — out of scope for this doc-only
pass.)

**Phase 4 — Escrow `reclaimAfterDeadline` (HIGH risk; on-chain).**
Add the per-milestone `deadline` + `reclaimAfterDeadline()` to **V3-pre-deploy or V4** (never the
deployed V2); have the durable escrow Activity call it on `timed_out`, referencing the attestation CID.
Until the contract ships, the Activity records refund-intent in the off-chain settlement ledger (the
`deadline` column already exists). Contract change requires audit + redeploy; rollback = ship without
the new function (off-chain intent remains the bridge).

**Phase 5 — Native durable timers (LOW risk; internal).**
When `@pcc/workflow` v0.2 lands `ctx.sleep()`, replace the polled reaper with per-job durable timers.
Pure internal swap; semantics unchanged.

**Rollback:** every phase is additive and opt-in; jobs without a `TimeoutPolicy` behave exactly as
today. Because L4 evidence is never modified, **no phase can corrupt or invalidate historical
evidence**, and no refund can fire without an attestation it can be audited against.

---

## 9. Open questions

1. **Partial-work refunds.** A print that's 80% done when `execution_timeout` fires — full refund,
   pro-rata, or operator keeps a materials fee? The saga framing (§4.3) refunds *unreached milestones*;
   but a *single* milestone partially executed has no clean split. Needs a policy (and possibly a
   tier-dependent one).
2. **Heartbeat vs constrained transports.** Doc 02's MQTT-SN/Waku/XMTP devices can't ping every 150 s.
   Is "liveness" for them the shadow `reported` version bump (doc 02 §6.5), and how does that reconcile
   with a tight `heartbeat_timeout_s`? (Directly entangled with doc 02 open Q5.)
3. **Transport-aware default deadlines.** Where do the per-transport `dispatch_timeout_s` defaults live —
   the kernel manifest `connection` spec, a capability template, or a gateway policy table?
4. **Who signs a timeout when the kernel is dark.** Gateway-as-observer is the §6.5 default. Should tier
   2/3 require a *verifier quorum* co-signature on the `timeout_attestation` to prevent a malicious
   gateway from timing out a healthy job to trigger a refund?
5. **Protocol fee on refund.** The 2.35% protocol fee is taken on settlement. Should a *timeout refund*
   be full (no fee, since no work was verified) or net-of-fee? Affects the `_transfer` in §7.3.
6. **Reclaim authorization.** Is `reclaimAfterDeadline()` `onlyPayer`, or permissionless-but-refunds-to-
   payer (so a watchtower bot can trigger it)? Permissionless improves liveness but widens the surface.
7. **Clock authority across parties.** Request freshness uses `Date.now()` (C-3), but the escrow
   `deadline` is a *block* timestamp. The two clocks differ by ~1–2 blocks; define which governs the
   `timed_out` transition vs the on-chain refund gate, and the tolerance between them.
8. **Mandatory vs advisory attestation gate.** Should `reclaimAfterDeadline()` *require* an on-chain
   reference to the `timeout_attestation` CID (strongest provenance, higher gas/complexity) or treat it
   as off-chain-auditable only (cheaper)? Invariant 4 wants the former; gas wants the latter.
9. **Interaction with the existing challenge window.** A job can *complete* near its `execution_timeout`
   and then enter the challenge window. Define the precedence so a job isn't simultaneously
   `collecting_evidence` and eligible for `reclaimAfterDeadline()` (race between completion and reaper).
10. **`@pcc/workflow` durable-timer ETA.** The whole Phase 1–2 reaper is interim scaffolding for
    `ctx.sleep()` (v0.2). If v0.2 is near, is the reaper worth building, or should Phase 1 wait?

---

## 10. Appendix

### 10.1 Research notes produced this pass (`docs/rtp-absorption/research-notes/`)
- `pcc-audit-lifecycle-timeout.md` — lifecycle states, ACK/heartbeat gaps, `@pcc/workflow` durable-exec status (auditor-lifecycle-alpha).
- `pcc-audit-escrow-refund.md` — `MilestoneEscrowV2` status enum, the no-reclaim gap, MPP-session analog, V2→V3 delta (auditor-escrow-bravo).
- `pcc-audit-freshness-replay.md` — every freshness/TTL window, the replay/dedup gaps, the C-1…C-7 conformance constraints (auditor-freshness-charlie).
- `sota-timeout-and-rtp.md` — RTP timeout/freshness baseline + Temporal/Cadence/saga/idempotency/nonce/lease survey + rated table (scout-sota-rtp-delta).
- `rtp-spec-study.md` — RTP architecture (from doc 02's pass; reused for the timeout/freshness specifics).

### 10.2 Key PCC files cited *(load-bearing claims re-verified first-hand: ⋆)*
- ⋆`packages/spec/src/types/evidence.ts:143-165,168-211` (WorkflowChallenge/ExecutionProof/maxAgeSeconds 600s; tier requirements)
- ⋆`packages/spec/src/types/job-spec.ts:49-59` (`deadlineSeconds`, unenforced)
- ⋆`packages/contracts/src/MilestoneEscrowV2.sol:94,102,265,857,940,1080,1113` (status enum; no reclaim/deadline fn; Refunded only via resolveDispute)
- ⋆`packages/workflow/src/workflow/engine.ts:158,353,416` (recover/step memoization; `ctx.sleep` → NotImplementedError, v0.2)
- `packages/spec/src/types/kernel.ts:126-128` (job status union; no `timed_out`)
- `packages/db/src/schema/jobs.ts:12`, `packages/db/src/schema/settlement.ts:13` (informal statuses; unenforced `deadline` column)
- `packages/kernel/src/job-runner.ts:207`, `packages/kernel/src/anomaly-detector.ts:117`, `packages/kernel-sdk/src/job-handler.ts:220`, `packages/kernel/src/server.ts:172`
- `packages/gateway/src/facades/populators/staleness.ts:20,42`, `packages/gateway/src/services/agent-heartbeat-monitor.ts:42`
- `packages/gateway/src/activities/escrow.ts`, `packages/gateway/src/routes/escrow.ts:199,303,345,429`, `packages/gateway/src/middleware/idempotency.ts:23`
- `packages/gateway/src/routes/{ot2-scope.ts:84,142,wizard.ts:62,negotiation.ts:289,operator-relay.ts:120}`, `packages/verifier/src/evidence-verifier.ts:156`
- `packages/payments/src/mpp-session.ts:87`, `packages/orchestrator/src/protocol-runner.ts:24`, `packages/contracts/src/MilestoneEscrowV3.sol:839`
- `packages/attestations/src/off-chain.ts:200`, `docs/{THREAT_MODEL,EXECUTION_SCOPE_PROTOCOL,CAPTURE_VERIFICATION,WORKFLOW_RUNTIME}.md`

### 10.3 External sources (clean-room; not installed/executed)
RTP: `github.com/plagtech/rtp-spec`, `docs.spraay.app`. Temporal: activity timeouts + `RecordActivityHeartbeat`
(`docs.temporal.io`). Cadence: `cadenceworkflow.io`. Saga/compensation: Garcia-Molina & Salem 1987;
microservices.io saga pattern. Idempotency: Stripe API idempotency docs; IETF `Idempotency-Key` HTTP
header draft. Nonce/freshness: EIP-712; JWT RFC 7519 (`jti`/`exp`); AWS SigV4 `X-Amz-Date` clock-skew.
Leases/watchdogs: etcd lease docs; ZooKeeper/Chubby (Burrows 2006); Kubernetes Lease + liveness probes;
AWS Step Functions `HeartbeatSeconds`; hardware watchdog timer references. (Full URLs in the scratch notes.)

---

*End of design proposal. No PCC source code was modified in producing this document.*
