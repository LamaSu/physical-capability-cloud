/**
 * Job lifecycle — first-class timeout states, causes, and policy.
 *
 * RTP-absorption doc 03: first-class timeout for the PCC physical-task lifecycle.
 * This module is transport-INDEPENDENT. The connection/transport abstraction of
 * doc 02 is gated on the libp2p-vs-dht-core owner decision and is NOT built here;
 * see docs/rtp-absorption/04-transport-abstraction-implementation-plan.md.
 *
 * What this adds (the non-transport parts of doc 03 §6–§7):
 *   - a first-class `timed_out` TERMINAL state + a `TimeoutCause` discriminator
 *     (dispatch | execution | heartbeat), plus the dispatched/accepted ACK split
 *     so "kernel never accepted" is distinguishable from "accepted then stalled";
 *   - a per-phase `TimeoutPolicy` — three independent deadlines (dispatch,
 *     execution, heartbeat) mapped to the Temporal / Step-Functions taxonomy;
 *   - `JobTimeoutMeta` recording why/when a job timed out, so an escrow refund
 *     can later be audited against it (the on-chain reclaim path is doc 03 Phase 4,
 *     a separate lane — NOT built here).
 *
 * The PURE reducer + in-memory registry that DRIVE these states live in
 * `../util/job-lifecycle.ts`. Wiring them to gateway routes
 * (POST /api/jobs/:id/ack, POST /api/jobs/:id/heartbeat) + DB persistence + the
 * @pcc/workflow reaper Activity is a thin adapter intentionally left to the
 * job-status lane (it overlaps active work — see the PR notes).
 */

/**
 * Canonical kernel job status union, extended with the timeout lifecycle.
 *
 * New vs the legacy union (`packages/spec/src/types/kernel.ts`):
 *   - "dispatched" — job pushed to a kernel, awaiting its ACK (two-phase dispatch).
 *   - "accepted"   — kernel ACKed; the execution + heartbeat clocks start.
 *   - "timed_out"  — NEW first-class terminal state (see {@link TimeoutCause}).
 *
 * Back-compat: every legacy status is preserved, so existing jobs keep their
 * meaning and a job that never uses the ACK/heartbeat protocol still flows
 * queued → preparing → executing → … exactly as before.
 */
export type KernelJobStatus =
  | "queued"
  | "dispatched"
  | "accepted"
  | "preparing"
  | "executing"
  | "collecting_evidence"
  | "awaiting_pickup"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/**
 * Which deadline a `timed_out` job breached.
 *   - "dispatch"  — kernel never acknowledged the job (ScheduleToStart).
 *   - "execution" — work ran past its hard wall-clock (StartToClose).
 *   - "heartbeat" — kernel went dark mid-run (rolling Heartbeat gap).
 */
export type TimeoutCause = "dispatch" | "execution" | "heartbeat";

/** The four terminal statuses (no transitions leave these). */
export const TERMINAL_JOB_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const satisfies readonly KernelJobStatus[];

/** Recorded when a job transitions to `timed_out`. Provenance for the refund. */
export interface JobTimeoutMeta {
  /** Which clock fired. */
  cause: TimeoutCause;
  /** The breached window, in seconds. */
  deadlineSeconds: number;
  /** RFC3339 instant the timeout was observed. */
  observedAt: string;
  /** RFC3339 of the last heartbeat seen (present for cause:"heartbeat"). */
  lastHeartbeatAt?: string;
  /** Last kernel-signed evidence event hash seen, if any (chains provenance). */
  lastEventHash?: string;
  /**
   * CID of a `timeout_attestation` evidence event, once emitted (doc 03 Phase 2/4).
   * Left optional here: emitting the attestation + the on-chain reclaim that
   * references it is the evidence/escrow lane, not this transport-independent slice.
   */
  attestationCid?: string;
}

/**
 * Per-job timeout policy: three independent deadlines mapped to the Temporal /
 * AWS Step Functions taxonomy. An omitted field ⇒ NO timeout for that phase
 * (back-compat: a job with no policy behaves exactly as it does today).
 *
 * Deadlines are intended to be transport-aware (doc 03 §6.3): a store-and-forward
 * kernel legitimately takes a long time to accept, so its `dispatchTimeoutS` is
 * large — but choosing those per-transport defaults is doc-02 territory and is
 * deferred. Here the policy is just data the reducer evaluates.
 */
export interface TimeoutPolicy {
  /** queued/dispatched → accepted (ScheduleToStart). Kernel never ACKs. */
  dispatchTimeoutS?: number;
  /** accepted → collecting_evidence (StartToClose). Work runs past wall-clock. */
  executionTimeoutS?: number;
  /** Rolling max gap between heartbeats while executing (Heartbeat). Kernel went dark. */
  heartbeatTimeoutS?: number;
}

/** Progress detail carried on a job heartbeat (Temporal heartbeat "details"). */
export interface HeartbeatDetail {
  /** 0–100 progress, if known. */
  progress?: number;
  /** Last kernel-signed evidence event hash, if any. */
  lastEventHash?: string;
}

/**
 * Durable state the lifecycle reducer evolves. All times are epoch MILLISECONDS so
 * the reducer stays pure and clock-injectable — there is no `Date.now()` inside the
 * reducer. The caller owns persistence (gateway DB / @pcc/workflow EventStore).
 */
export interface JobLifecycleState {
  jobId: string;
  status: KernelJobStatus;
  policy: TimeoutPolicy;
  /** When the job entered the queue — the dispatch-clock origin. */
  createdAt: number;
  /** When it was pushed to the kernel. */
  dispatchedAt?: number;
  /** When the kernel ACKed / work started — the execution + heartbeat clock origin. */
  acceptedAt?: number;
  /** Most recent heartbeat — the heartbeat-clock reset point. */
  lastHeartbeatAt?: number;
  /** Last reported progress 0–100. */
  lastProgress?: number;
  /** Last kernel-signed evidence event hash. */
  lastEventHash?: string;
  /** When a terminal state was reached. */
  terminatedAt?: number;
  /** Populated iff `status === "timed_out"`. */
  timeout?: JobTimeoutMeta;
}
