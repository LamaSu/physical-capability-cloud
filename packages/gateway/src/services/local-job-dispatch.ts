import { emergencyStopState } from "../routes/device-relay.js";

/** Production requires an exact opt-in; development retains exact true opt-out. */
export function jobSubmitQueueOnly(): boolean {
  return process.env.NODE_ENV === "production"
    ? process.env.PCC_JOB_SUBMIT_QUEUE_ONLY !== "false"
    : process.env.PCC_JOB_SUBMIT_QUEUE_ONLY === "true";
}

export type LocalJobDispatchReason = "queue_only" | "emergency_stop" | "policy_unavailable"
  | "not_local" | "no_configured_local_kernel" | "no_kernel_signer";

/** One decision for dispatch, queued replies, audit, detect and the boot log.
 * N267: production refuses only an exact true report of the test-only signer. */
export function localJobDispatchDecision(
  localKernelId: unknown,
  kernelId: string,
  hasExplicitConfig: boolean,
  queueOnly?: unknown,
  usesTestSigner?: unknown,
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
    if (process.env.NODE_ENV === "production" && usesTestSigner === true) {
      return { ok: false, reason: "no_kernel_signer" };
    }
    return { ok: true };
  }
  return { ok: false, reason: stop === "stopped" ? "emergency_stop" : "policy_unavailable" };
}

/**
 * N104 / WP-C: local actuation requires an explicit kernel identity match and
 * a readable, clear emergency stop. Everything else takes the external queue.
 * Read this again after an await before starting a runner.
 */
export function canDispatchJobLocally(localKernelId: unknown, kernelId: string, hasExplicitConfig: boolean): boolean {
  return localJobDispatchDecision(localKernelId, kernelId, hasExplicitConfig).ok;
}
