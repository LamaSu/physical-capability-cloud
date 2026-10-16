import { emergencyStopState } from "../routes/device-relay.js";

/** Operator-only switch: request bodies never participate in dispatch policy. */
export function jobSubmitQueueOnly(): boolean {
  return process.env.PCC_JOB_SUBMIT_QUEUE_ONLY === "true";
}

/**
 * N104 / WP-C: local actuation requires an explicit kernel identity match and
 * a readable, clear emergency stop. Everything else takes the external queue.
 * Read this again after an await before starting a runner.
 */
export function canDispatchJobLocally(localKernelId: unknown, kernelId: string): boolean {
  return !jobSubmitQueueOnly()
    && typeof localKernelId === "string"
    && localKernelId.length > 0
    && kernelId === localKernelId
    && emergencyStopState(kernelId) === "clear";
}
