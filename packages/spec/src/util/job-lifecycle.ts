/**
 * Job lifecycle reducer — pure transition + timeout evaluation logic.
 *
 * RTP-absorption doc 03 (the transport-INDEPENDENT slice). This is the engine
 * behind the first-class `timed_out` state and the kernel heartbeat-and-ack
 * protocol. It mirrors the existing agent-heartbeat-monitor pattern
 * (`packages/gateway/src/services/agent-heartbeat-monitor.ts`) but at JOB grain.
 *
 * Design:
 *   - Every function is PURE and takes `now` (epoch ms) as an argument — no
 *     `Date.now()` is called inside the reducer, so transitions and timeout
 *     evaluation are fully deterministic and unit-testable.
 *   - The {@link JobLifecycleRegistry} is a thin in-memory convenience wrapper
 *     (Map + injectable clock) for callers that want an ACK/heartbeat monitor
 *     today. Durable callers (gateway DB, @pcc/workflow reaper Activity) use the
 *     pure functions directly against their own persisted {@link JobLifecycleState}.
 */

import type {
  JobLifecycleState,
  KernelJobStatus,
  TimeoutCause,
  TimeoutPolicy,
  HeartbeatDetail,
} from "../types/job-lifecycle.js";
import { TERMINAL_JOB_STATUSES } from "../types/job-lifecycle.js";

const TERMINAL = new Set<KernelJobStatus>(TERMINAL_JOB_STATUSES);

/** True if `status` is a terminal state (no further transitions allowed). */
export function isTerminalJobStatus(status: KernelJobStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Allowed forward transitions. `timed_out` is reachable from any non-terminal
 * status via {@link applyJobTimeout} (the reaper drives it), so it is NOT listed
 * here as an explicit advance target.
 */
const ALLOWED: Record<KernelJobStatus, readonly KernelJobStatus[]> = {
  queued: ["dispatched", "accepted", "preparing", "executing", "failed", "cancelled"],
  dispatched: ["accepted", "preparing", "executing", "failed", "cancelled"],
  accepted: ["preparing", "executing", "collecting_evidence", "failed", "cancelled"],
  preparing: ["executing", "collecting_evidence", "failed", "cancelled"],
  executing: ["collecting_evidence", "failed", "cancelled"],
  collecting_evidence: ["awaiting_pickup", "completed", "failed", "cancelled"],
  awaiting_pickup: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

/** Create a fresh lifecycle state in `queued` at `now`. */
export function createJobLifecycle(
  jobId: string,
  policy: TimeoutPolicy,
  now: number,
): JobLifecycleState {
  return { jobId, status: "queued", policy, createdAt: now };
}

/**
 * Advance a job to `to`, applying the timestamp side effects that the timeout
 * clocks key off. Throws on an illegal transition. Returns a NEW state (the input
 * is not mutated). Use {@link applyJobTimeout} for the `timed_out` transition.
 */
export function advanceJob(
  state: JobLifecycleState,
  to: Exclude<KernelJobStatus, "timed_out">,
  now: number,
): JobLifecycleState {
  if (!ALLOWED[state.status].includes(to)) {
    throw new Error(`illegal job transition: ${state.status} -> ${to} (job ${state.jobId})`);
  }
  const next: JobLifecycleState = { ...state, status: to };

  switch (to) {
    case "dispatched":
      next.dispatchedAt = now;
      break;
    case "accepted":
      // The ACK: stop the dispatch clock, start execution + heartbeat clocks.
      next.acceptedAt = now;
      next.lastHeartbeatAt = state.lastHeartbeatAt ?? now;
      break;
    case "preparing":
    case "executing":
      // Start-of-work establishes the execution + heartbeat origin even if the
      // job never went through an explicit ACK (e.g. the gateway-embedded model).
      next.acceptedAt = state.acceptedAt ?? now;
      next.lastHeartbeatAt = state.lastHeartbeatAt ?? now;
      break;
    case "completed":
    case "failed":
    case "cancelled":
      next.terminatedAt = now;
      break;
    default:
      // collecting_evidence / awaiting_pickup: work is done, only finalizing.
      // The execution + heartbeat clocks no longer apply (see evaluateJobTimeout).
      break;
  }
  return next;
}

/**
 * Record a heartbeat (the "kernel is still alive" signal). Resets the heartbeat
 * clock and stores last-known progress. Valid only after work has started
 * (`acceptedAt` set) and while non-terminal. Throws otherwise. Returns a NEW state.
 */
export function recordJobHeartbeat(
  state: JobLifecycleState,
  now: number,
  detail?: HeartbeatDetail,
): JobLifecycleState {
  if (isTerminalJobStatus(state.status)) {
    throw new Error(`cannot heartbeat a terminal job: ${state.status} (job ${state.jobId})`);
  }
  if (state.acceptedAt == null) {
    throw new Error(`cannot heartbeat a job before it is accepted/started (job ${state.jobId})`);
  }
  return {
    ...state,
    lastHeartbeatAt: now,
    lastProgress: detail?.progress ?? state.lastProgress,
    lastEventHash: detail?.lastEventHash ?? state.lastEventHash,
  };
}

function breachedDeadlineSeconds(policy: TimeoutPolicy, cause: TimeoutCause): number {
  switch (cause) {
    case "dispatch":
      return policy.dispatchTimeoutS ?? 0;
    case "execution":
      return policy.executionTimeoutS ?? 0;
    case "heartbeat":
      return policy.heartbeatTimeoutS ?? 0;
  }
}

/**
 * Evaluate whether a job has breached a deadline at `now`. Returns the breached
 * {@link TimeoutCause}, or null. Pure — does NOT mutate or transition; the caller
 * applies {@link applyJobTimeout}.
 *
 * Precedence in the execution phase: heartbeat is checked before execution because
 * it is the shorter window and catches a dark kernel in seconds rather than waiting
 * out the full execution wall-clock. Once a job reaches collecting_evidence /
 * awaiting_pickup (work done, only finalizing), neither execution nor heartbeat
 * applies — this avoids racing a job that completed near its execution deadline
 * into a spurious timeout (doc 03 open Q9).
 */
export function evaluateJobTimeout(
  state: JobLifecycleState,
  now: number,
): TimeoutCause | null {
  if (isTerminalJobStatus(state.status)) return null;
  const { policy } = state;
  const elapsedS = (sinceMs: number): number => (now - sinceMs) / 1000;

  // Dispatch phase: still waiting for the kernel to accept.
  if (state.status === "queued" || state.status === "dispatched") {
    if (policy.dispatchTimeoutS != null && elapsedS(state.createdAt) > policy.dispatchTimeoutS) {
      return "dispatch";
    }
    return null;
  }

  // Execution phase: accepted/working, not yet collecting evidence.
  const inExecution =
    state.acceptedAt != null &&
    (state.status === "accepted" || state.status === "preparing" || state.status === "executing");
  if (inExecution) {
    const acceptedAt = state.acceptedAt as number;
    if (
      policy.heartbeatTimeoutS != null &&
      state.lastHeartbeatAt != null &&
      elapsedS(state.lastHeartbeatAt) > policy.heartbeatTimeoutS
    ) {
      return "heartbeat";
    }
    if (policy.executionTimeoutS != null && elapsedS(acceptedAt) > policy.executionTimeoutS) {
      return "execution";
    }
  }
  return null;
}

/**
 * Transition a job to `timed_out`, recording {@link JobTimeoutMeta}. Throws if the
 * job is already terminal. Returns a NEW state. `cause` is normally the return of
 * {@link evaluateJobTimeout}.
 */
export function applyJobTimeout(
  state: JobLifecycleState,
  cause: TimeoutCause,
  now: number,
): JobLifecycleState {
  if (isTerminalJobStatus(state.status)) {
    throw new Error(`cannot time out a terminal job: ${state.status} (job ${state.jobId})`);
  }
  return {
    ...state,
    status: "timed_out",
    terminatedAt: now,
    timeout: {
      cause,
      deadlineSeconds: breachedDeadlineSeconds(state.policy, cause),
      observedAt: new Date(now).toISOString(),
      lastHeartbeatAt:
        state.lastHeartbeatAt != null ? new Date(state.lastHeartbeatAt).toISOString() : undefined,
      lastEventHash: state.lastEventHash,
    },
  };
}

/**
 * Scan many lifecycle states and return those that have timed out at `now`. PURE —
 * does not transition; the caller applies {@link applyJobTimeout}. This is the
 * shape a @pcc/workflow reaper Activity consumes against persisted state.
 */
export function reapTimedOutJobs(
  states: Iterable<JobLifecycleState>,
  now: number,
): Array<{ jobId: string; cause: TimeoutCause }> {
  const out: Array<{ jobId: string; cause: TimeoutCause }> = [];
  for (const s of states) {
    const cause = evaluateJobTimeout(s, now);
    if (cause) out.push({ jobId: s.jobId, cause });
  }
  return out;
}

/**
 * In-memory job lifecycle registry — the ACK + heartbeat monitor at job grain.
 *
 * A thin convenience over the pure reducer: holds a Map of states and an injectable
 * clock (defaults to Date.now). Mirrors the agent-heartbeat-monitor service so a
 * gateway can expose POST /api/jobs/:id/ack and /heartbeat by delegating here, and
 * a periodic tick can call {@link reap} to drive `timed_out` transitions. Durable
 * deployments should persist state and use the pure functions instead.
 */
export class JobLifecycleRegistry {
  private readonly jobs = new Map<string, JobLifecycleState>();
  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  /** Register a new job (queued) with its timeout policy. */
  create(jobId: string, policy: TimeoutPolicy = {}): JobLifecycleState {
    const state = createJobLifecycle(jobId, policy, this.clock());
    this.jobs.set(jobId, state);
    return state;
  }

  get(jobId: string): JobLifecycleState | undefined {
    return this.jobs.get(jobId);
  }

  list(): JobLifecycleState[] {
    return [...this.jobs.values()];
  }

  delete(jobId: string): boolean {
    return this.jobs.delete(jobId);
  }

  private require(jobId: string): JobLifecycleState {
    const s = this.jobs.get(jobId);
    if (!s) throw new Error(`unknown job: ${jobId}`);
    return s;
  }

  /** Mark the job as dispatched to a kernel (awaiting ACK). */
  dispatch(jobId: string): JobLifecycleState {
    const next = advanceJob(this.require(jobId), "dispatched", this.clock());
    this.jobs.set(jobId, next);
    return next;
  }

  /** Two-phase dispatch ACK: the kernel confirms receipt → `accepted`. */
  ack(jobId: string): JobLifecycleState {
    const next = advanceJob(this.require(jobId), "accepted", this.clock());
    this.jobs.set(jobId, next);
    return next;
  }

  /** Generic forward transition (preparing/executing/collecting_evidence/...). */
  advance(jobId: string, to: Exclude<KernelJobStatus, "timed_out">): JobLifecycleState {
    const next = advanceJob(this.require(jobId), to, this.clock());
    this.jobs.set(jobId, next);
    return next;
  }

  /** Record a liveness heartbeat with optional progress detail. */
  heartbeat(jobId: string, detail?: HeartbeatDetail): JobLifecycleState {
    const next = recordJobHeartbeat(this.require(jobId), this.clock(), detail);
    this.jobs.set(jobId, next);
    return next;
  }

  /**
   * Evaluate every tracked job against the clock, APPLY `timed_out` to those that
   * have breached a deadline, and return the jobs that fired. Idempotent: already
   * terminal jobs are skipped.
   */
  reap(): Array<{ jobId: string; cause: TimeoutCause; state: JobLifecycleState }> {
    const now = this.clock();
    const fired: Array<{ jobId: string; cause: TimeoutCause; state: JobLifecycleState }> = [];
    for (const [jobId, state] of this.jobs) {
      const cause = evaluateJobTimeout(state, now);
      if (cause) {
        const next = applyJobTimeout(state, cause, now);
        this.jobs.set(jobId, next);
        fired.push({ jobId, cause, state: next });
      }
    }
    return fired;
  }
}
