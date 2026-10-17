import { emergencyStopState } from "../routes/device-relay.js";
import { isJobHeld } from "./job-holds.js";

/** Production requires an exact opt-in; development retains exact true opt-out. */
export function jobSubmitQueueOnly(): boolean {
  return process.env.NODE_ENV === "production"
    ? process.env.PCC_JOB_SUBMIT_QUEUE_ONLY !== "false"
    : process.env.PCC_JOB_SUBMIT_QUEUE_ONLY === "true";
}

export type LocalJobDispatchReason = "queue_only" | "emergency_stop" | "policy_unavailable" | "held"
  | "not_local" | "no_configured_local_kernel";

/** One decision for dispatch, queued replies, audit, detect and the boot log. */
export function localJobDispatchDecision(
  localKernelId: unknown,
  kernelId: string,
  hasExplicitConfig: boolean,
  queueOnly?: unknown,
  jobId?: string,
): { ok: true } | { ok: false; reason: LocalJobDispatchReason } {
  if (hasExplicitConfig !== true || localKernelId === "kernel_dev_001") {
    return { ok: false, reason: "no_configured_local_kernel" };
  }
  if (jobSubmitQueueOnly() || queueOnly === true) return { ok: false, reason: "queue_only" };
  if (typeof localKernelId !== "string" || localKernelId.length === 0 || kernelId !== localKernelId) {
    return { ok: false, reason: "not_local" };
  }
  const stop = emergencyStopState(kernelId);
  if (stop === "clear") {
    if (jobId && isJobHeld(jobId)) return { ok: false, reason: "held" };
    return { ok: true };
  }
  return { ok: false, reason: stop === "stopped" ? "emergency_stop" : "policy_unavailable" };
}

/**
 * N104 / WP-C: local actuation requires an explicit kernel identity match and
 * a readable, clear emergency stop. Everything else takes the external queue.
 * Read this again after an await before starting a runner, including the job's
 * hold: a stop followed by a reset during admission still needs a release.
 */
export function canDispatchJobLocally(localKernelId: unknown, kernelId: string, hasExplicitConfig: boolean, jobId?: string): boolean {
  return localJobDispatchDecision(localKernelId, kernelId, hasExplicitConfig, undefined, jobId).ok;
}
