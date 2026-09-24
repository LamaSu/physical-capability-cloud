/**
 * Kernel-operator authorization — ONE implementation of "may this principal act
 * for this kernel?", shared by every route that binds work to a physical site.
 *
 * Why this is its own module (round 2). LO-GW-3a added an ownership check to
 * `POST /api/job-offers/:id/claim`, but that guard lived inside that one route
 * file — and `POST /api/courier-jobs/:id/claim` writes the SAME field of the
 * SAME store (`JobOffersStore.claim` sets `claimedByKernelId`) through the
 * backward-compat shim, with no check at all. A guard that protects one door
 * into a store protects nothing; the second door has to enforce the same rule,
 * from the same code, or the two drift apart again the next time either moves.
 *
 * The predicate itself is unchanged and matches what the rest of the codebase
 * already uses for site ownership: `shop_kernels.operatorAddress === principal`
 * (routes/carrier.ts, mcp/operation-policy.ts). It fails closed — an unknown
 * kernel, a failed lookup, or a kernel with no recorded owner all refuse.
 */

import type { FastifyReply } from "fastify";
import { getKernelFacade } from "../facades/index.js";

/** The unowned placeholder a kernel row carries before a signer is bound. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Result of resolving who owns a kernel, WITHOUT deciding what to do about it.
 *
 * Callers need the three cases apart: a route that requires a kernel (job-offers)
 * turns `not_found` into a 404, while a route whose identifier is not
 * necessarily a kernel (the courier shim's `driverAgent`) needs to fall through
 * to its own rule instead. Collapsing them into a boolean is what would force
 * the second caller to re-implement the lookup.
 */
export type KernelOwnerLookup =
  | { found: true; owner: string | null }
  | { found: false; reason: "not_found" | "lookup_failed" };

/**
 * Case-insensitive principal comparison.
 *
 * Principals arrive as either an EVM address (case-insensitive by definition —
 * EIP-55 only varies the checksum casing) or an email. Comparing them raw would
 * make `0xAB…` and `0xab…` different operators for the same key.
 */
export function isSamePrincipal(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Look up a kernel's recorded operator.
 *
 * Never throws: `getKernelFacade()` constructs a facade over `getRepos()`, which
 * throws when the store is not initialised, and an authorization helper that
 * throws would surface as a 500 on a path whose correct answer is "refuse".
 */
export async function lookupKernelOwner(kernelId: string): Promise<KernelOwnerLookup> {
  try {
    const res = await getKernelFacade().getById(kernelId);
    if (!res.success) {
      return { found: false, reason: res.error.httpStatus === 404 ? "not_found" : "lookup_failed" };
    }
    return { found: true, owner: (res.data as { operatorAddress?: string }).operatorAddress ?? null };
  } catch {
    return { found: false, reason: "lookup_failed" };
  }
}

/**
 * LO-GW-3a — authorize `principal` to act for `kernelId`, replying on refusal.
 *
 * Claiming an offer is the step that binds a job to a physical site, so the
 * claimant has to be that site's operator. Before this guard, the claim routes
 * read a kernel id straight off the request body and passed it to the store:
 * any caller could name ANY kernel and the offer was recorded as claimed by it.
 * A body field is a CLAIM about identity that has to be checked, never an
 * identity in itself.
 *
 * Returns true when authorized. Otherwise it has already sent the reply.
 */
export async function requireKernelOperator(
  reply: FastifyReply,
  principal: string,
  kernelId: string,
): Promise<boolean> {
  const lookup = await lookupKernelOwner(kernelId);
  if (!lookup.found) {
    void reply.code(lookup.reason === "not_found" ? 404 : 502).send({
      error: lookup.reason === "not_found" ? "kernel_not_found" : "kernel_lookup_failed",
      message: `Cannot verify operator ownership of kernel '${kernelId}'`,
    });
    return false;
  }
  if (!lookup.owner || lookup.owner === ZERO_ADDRESS) {
    // No principal to authorize against — refuse rather than treat "nobody
    // owns it" as "everybody may claim for it".
    void reply.code(403).send({
      error: "kernel_unowned",
      message: `Kernel '${kernelId}' has no recorded operator; it cannot claim offers`,
    });
    return false;
  }
  if (!isSamePrincipal(lookup.owner, principal)) {
    void reply.code(403).send({
      error: "not_kernel_operator",
      message: "You can only claim offers for a kernel you operate",
    });
    return false;
  }
  return true;
}
