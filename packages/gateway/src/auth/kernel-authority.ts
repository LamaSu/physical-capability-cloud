/**
 * Who may act on a kernel (board N31; bus #6272; the steward's ruling #6278). One module for
 * every route that writes a kernel's operator controls: routes/operator.ts (stop, resume,
 * policy, approvals) and routes/kernel-agent-package.ts (the agent-package tool configuration,
 * which is stored in the kernel's operator policy). Cross-family review r1 of #575 found that
 * second writer checking `kernel.operatorId`, a column kernels do not have, so it never refused;
 * each route family had its own copy of the ownership check.
 *
 *   - "decide": approve, reject, emergency-resume, any write of the kernel's operator policy
 *     (PUT, PATCH, the agent-package configuration; PATCH {emergencyStop:false} is a resume by
 *     another name), and an approval submitted with autoApprove (a pre-made approval decision).
 *     It needs the gateway admin secret, or a wallet the caller PROVED that is the kernel's
 *     operator. WP-A (#326) sets req.provenWallet for a SIWE session or a key minted from one;
 *     nothing sets it before that merges, so until then only the admin decides. A claimed
 *     identity never decides: anyone can provision a key that names any wallet or email.
 *   - "stop or submit": emergency-stop, and an approval submitted as PENDING. Also the kernel's
 *     own principal: the identity its operatorAddress records, which POST /api/kernels takes from
 *     the registering caller. An operator must never lose their own e-stop, and a pending
 *     approval still needs a decision. The residual, a key provisioned under the operator's
 *     identity stopping the kernel or queueing requests, is queue item 136.
 */
import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { schema, eq } from "@pcc/store";
import { getStore } from "../db.js";

export type KernelAction = "decide" | "stop_or_submit";

export interface KernelAuthority {
  /** The request carried a valid X-Admin-Key. */
  admin: boolean;
  /** The wallet the caller proved control of (WP-A); null when none. */
  provenWallet: string | null;
  /** The caller's claimed identity: its API key's operator id, or its session's address. */
  claimed: string | null;
}

/**
 * True only when X-Admin-Key equals PCC_ADMIN_KEY, compared in constant time (both SHA-256'd to
 * fixed-length digests). An unset or blank PCC_ADMIN_KEY, or a missing, empty or repeated header,
 * grants nothing in any environment. (Same rule as routes/kernels.ts; WP-A #326 adds the shared
 * helper, auth/admin-key.ts.)
 */
function hasAdminSecret(provided: unknown, expected: string | undefined = process.env.PCC_ADMIN_KEY): boolean {
  if (typeof expected !== "string" || expected.trim().length === 0) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = crypto.createHash("sha256").update(provided, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function authorityOf(req: FastifyRequest): KernelAuthority {
  const r = req as unknown as { provenWallet?: unknown; operatorId?: unknown; userId?: unknown };
  const text = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  return {
    admin: hasAdminSecret(req.headers["x-admin-key"]),
    provenWallet: text(r.provenWallet),
    claimed: text(r.operatorId) ?? text(r.userId),
  };
}

export const isAnonymous = (a: KernelAuthority) => !a.admin && a.provenWallet === null && a.claimed === null;

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
/** operatorAddress values that record no owner: the empty string and the legacy zero placeholder. */
const UNOWNED = new Set(["", "0x0000000000000000000000000000000000000000"]);

function ownerOf(operatorAddress: unknown): string | null {
  if (typeof operatorAddress !== "string") return null;
  const owner = operatorAddress.trim().toLowerCase();
  return UNOWNED.has(owner) ? null : owner;
}

/** The admin secret, or a proven wallet equal to the kernel's operator (both compared as addresses). */
function mayDecide(a: KernelAuthority, operatorAddress: unknown): boolean {
  if (a.admin) return true;
  const owner = ownerOf(operatorAddress);
  if (owner === null || !WALLET_RE.test(owner) || a.provenWallet === null || !WALLET_RE.test(a.provenWallet)) return false;
  return a.provenWallet.toLowerCase() === owner;
}

/** Anyone who may decide, or the caller whose claimed identity is the kernel's recorded operator. */
function mayStopOrSubmit(a: KernelAuthority, operatorAddress: unknown): boolean {
  if (mayDecide(a, operatorAddress)) return true;
  const owner = ownerOf(operatorAddress);
  return owner !== null && a.claimed !== null && a.claimed.toLowerCase() === owner;
}

export const AUTHENTICATION_REQUIRED = {
  error: "authentication_required",
  message: "This operator action needs an API key or a signed-in wallet.",
};

const REFUSALS: Record<KernelAction, Record<string, string>> = {
  decide: {
    error: "forbidden",
    reason: "operator_proof_required",
    message:
      "This needs the gateway admin secret, or proof that you control the kernel's operator wallet (wallet sign-in proof, WP-A). An API key's claimed identity is not proof.",
  },
  stop_or_submit: {
    error: "forbidden",
    reason: "not_kernel_operator",
    message: "Only this kernel's operator or the gateway admin may do this.",
  },
};

export interface Refusal {
  status: 403 | 404 | 503;
  body: Record<string, string>;
}

/**
 * Null when this caller may take `action` on the kernel; otherwise the refusal to send. The admin
 * may act on any id, registered or not, as before. For anyone else an unregistered kernel is 404
 * (kernel ids are public through GET /api/kernels), and a failed kernel read is 503, never a pass.
 * Ownership is the kernel's recorded operatorAddress, the only owner column kernels have.
 */
export function refuseKernelAction(req: FastifyRequest, a: KernelAuthority, kernelId: string, action: KernelAction): Refusal | null {
  if (a.admin) return null;
  let kernel: { operatorAddress: string } | undefined;
  try {
    const { db } = getStore();
    kernel = db
      .select({ operatorAddress: schema.shopKernels.operatorAddress })
      .from(schema.shopKernels)
      .where(eq(schema.shopKernels.id, kernelId))
      .get();
  } catch (err) {
    req.log.warn({ kernelId, err }, "kernel read for an operator action failed");
    return { status: 503, body: { error: "read_failed", message: "The kernel could not be read to check who operates it. Try again shortly." } };
  }
  if (!kernel) return { status: 404, body: { error: "kernel_not_found", message: "No kernel with this id is registered." } };
  const allowed = action === "decide" ? mayDecide(a, kernel.operatorAddress) : mayStopOrSubmit(a, kernel.operatorAddress);
  return allowed ? null : { status: 403, body: REFUSALS[action] };
}
