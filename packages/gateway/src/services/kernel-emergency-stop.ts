/**
 * One answer to "may this kernel be given work right now?" (adk #4446).
 *
 * A kernel's emergency stop is `emergencyStop: true` in its stored operator
 * policy (set by POST /api/operator/emergency-stop, or by a policy write). Every
 * path that creates a job on a kernel, or the paid session that becomes one,
 * asks here BEFORE it writes anything or touches escrow, and so does each queue
 * that hands work to a node. The rule lives in this one file so it cannot differ
 * from one path to the next:
 *
 *   - the stored policy has emergencyStop (any truthy value)
 *       -> 409 `kernel_emergency_stopped`
 *   - there is no policy row (a kernel that never set one)
 *       -> not stopped
 *   - the policy cannot be read (the store cannot be opened, the query throws,
 *     the stored row cannot be parsed, or the policy is not an object)
 *       -> 503 `policy_unavailable`
 *
 * A read that fails is never read as "not stopped". The default policy has
 * `emergencyStop: false`, so treating an error like a missing row would turn a
 * store fault into permission to hand work to a stopped machine.
 *
 * `checkKernelAcceptsJobs` returns the verdict, for handlers that answer
 * themselves. `assertKernelAcceptsJobs` throws it as a
 * `KernelNotAcceptingJobsError`, for code that runs inside a facade (BaseFacade
 * maps it to a Result error with the same status and code) or a helper whose
 * caller decides what to answer.
 */

import type { FastifyReply } from "fastify";
import { schema, eq } from "@pcc/store";
import { getStore } from "../db.js";

const { operatorPolicies } = schema;

export const KERNEL_EMERGENCY_STOPPED = "kernel_emergency_stopped";
export const POLICY_UNAVAILABLE = "policy_unavailable";

/** Why a kernel is not given work: what to answer, and with which status. */
export type KernelJobsRefusal =
  | { status: 409; error: typeof KERNEL_EMERGENCY_STOPPED; message: string }
  | { status: 503; error: typeof POLICY_UNAVAILABLE; message: string };

export type KernelAcceptsJobs = { ok: true } | ({ ok: false } & KernelJobsRefusal);

function stopped(kernelId: string): KernelAcceptsJobs {
  return {
    ok: false,
    status: 409,
    error: KERNEL_EMERGENCY_STOPPED,
    message: `Kernel '${kernelId}' is in emergency stop and is not accepting jobs`,
  };
}

function unavailable(kernelId: string): KernelAcceptsJobs {
  return {
    ok: false,
    status: 503,
    error: POLICY_UNAVAILABLE,
    message:
      `The operator policy of kernel '${kernelId}' could not be read, so whether it is ` +
      "accepting jobs is not known; try again",
  };
}

/**
 * A plain policy object: not null, not an array, and `typeof === "object"`.
 * The ONLY shape a stored policy row may safely be read as.
 *
 * astra pack 150 HIGH: `typeof [] === "object"`, so a bare JSON array used to
 * slip past a `policy === null || typeof policy !== "object"` guard. Its
 * `.emergencyStop` then read as `undefined` (not stopped) -- and, in routes
 * that read-modify-write the policy, setting `.emergencyStop = true` on the
 * array itself "succeeded" in memory but vanished on the next JSON
 * serialization (arrays serialize only their indexed elements, never named
 * properties), so the write silently persisted nothing.
 */
function isPolicyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The result of reading a kernel's stored operator policy: see `readOperatorPolicy`. */
export type PolicyRead =
  | { kind: "missing" }
  | { kind: "ok"; policy: Record<string, unknown>; updatedAt: string }
  | { kind: "unavailable" };

/**
 * Read a kernel's stored operator policy, telling a MISSING row (the kernel
 * never set one) apart from an INVALID one (the stored value parsed fine but
 * is not a usable policy object: an array, a JSON `null`, or a primitive) and
 * from a read that failed outright (the store could not be opened, or the
 * query/JSON parse threw). The latter two collapse to the SAME "unavailable"
 * outcome on purpose: every caller must treat them identically (refuse --
 * never read either one as "no policy"), because the default policy has
 * `emergencyStop: false` and silently falling back to it on any kind of
 * unreadable row would hand a stopped kernel's work out again.
 *
 * This is the one place that decides whether a stored value may be trusted.
 * `checkKernelAcceptsJobs` below and every other consumer (GET, the
 * read-modify-write policy routes, the emergency-stop/resume routes,
 * approval creation, session creation, the A2A quote path) all read through
 * this function rather than re-deriving their own `row?.policy ?? DEFAULT`
 * check, so the validation can never drift between them again.
 */
export function readOperatorPolicy(kernelId: string): PolicyRead {
  let row: { policy: unknown; updatedAt: string } | undefined;
  try {
    row = getStore()
      .db.select()
      .from(operatorPolicies)
      .where(eq(operatorPolicies.kernelId, kernelId))
      .get();
  } catch {
    return { kind: "unavailable" };
  }
  if (!row) return { kind: "missing" };
  if (!isPolicyObject(row.policy)) return { kind: "unavailable" };
  // A PRESENT emergencyStop must be a boolean. A truthy non-boolean still stops the
  // kernel (the safe direction, read by truthiness below), but a malformed FALSY one
  // (null, 0, "") would read as "not stopped" and hand work out, so the row is
  // unavailable instead: it fails closed, never open (astra pack 150b).
  if (Object.prototype.hasOwnProperty.call(row.policy, "emergencyStop")) {
    const flag = row.policy.emergencyStop;
    if (typeof flag !== "boolean" && !flag) return { kind: "unavailable" };
  }
  return { kind: "ok", policy: row.policy, updatedAt: row.updatedAt };
}

/**
 * Whether `kernelId` may be given work now. Never throws. One read of the stored
 * policy; see the file comment for the three outcomes.
 */
export function checkKernelAcceptsJobs(kernelId: string): KernelAcceptsJobs {
  const read = readOperatorPolicy(kernelId);
  if (read.kind === "unavailable") return unavailable(kernelId);
  if (read.kind === "missing") return { ok: true };
  if (read.policy.emergencyStop) return stopped(kernelId);
  return { ok: true };
}

/** `checkKernelAcceptsJobs`, thrown. The name is what BaseFacade.execute maps to a Result error. */
export class KernelNotAcceptingJobsError extends Error {
  readonly code: KernelJobsRefusal["error"];
  readonly status: KernelJobsRefusal["status"];
  readonly kernelId: string;

  constructor(kernelId: string, refusal: KernelJobsRefusal) {
    super(refusal.message);
    this.name = "KernelNotAcceptingJobsError";
    this.code = refusal.error;
    this.status = refusal.status;
    this.kernelId = kernelId;
  }
}

/** Throws a KernelNotAcceptingJobsError unless `kernelId` may be given work now. */
export function assertKernelAcceptsJobs(kernelId: string): void {
  const verdict = checkKernelAcceptsJobs(kernelId);
  if (!verdict.ok) throw new KernelNotAcceptingJobsError(kernelId, verdict);
}

/** Send a refusal from `checkKernelAcceptsJobs` (or a KernelNotAcceptingJobsError) on a Fastify reply. */
export function replyKernelNotAccepting(
  reply: FastifyReply,
  refusal: Pick<KernelJobsRefusal, "status" | "error" | "message">,
): FastifyReply {
  return reply.status(refusal.status).send({ error: refusal.error, message: refusal.message });
}
