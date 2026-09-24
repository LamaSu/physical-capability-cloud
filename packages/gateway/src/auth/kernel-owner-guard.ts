/**
 * Kernel-owner guard: WP-C's THIN wrapper over the one kernel-ownership
 * predicate in ./kernel-operator.ts (PR #335, copied verbatim; never edit that
 * file here, so the branches merge cleanly).
 *
 * Who owns a kernel, and whether a principal is that owner, is decided ONLY by
 * `lookupKernelOwner` + `ZERO_ADDRESS` + `isSamePrincipal` from
 * ./kernel-operator.ts, the same rule `requireKernelOperator` enforces on the
 * job-claim doors. This file adds exactly three things on top:
 *
 *   1. A PRESENT actor. The identity is apiGate's (`operatorId ?? userId`).
 *      When apiGate skipped the path because a public allowlist entry is not
 *      method-aware (POST /api/capabilities and the /api/marketplace/ writes,
 *      coord-watch #2608), the same resolvers apiGate uses (API key, then SIWE
 *      session) run here instead. No identity means 401. A write handler never
 *      treats a missing actor as "anyone" and never relies on apiGate having run.
 *   2. WP-C's error codes: 401 `api_key_required`, 404 `kernel_not_found`,
 *      403 `not_kernel_owner` (for a legacy unowned placeholder AND for a
 *      different principal), 502 `kernel_lookup_failed`.
 *   3. `ownsKernel`, the same comparison as `requireKernelOperator` (an
 *      unowned placeholder owns nothing, then `isSamePrincipal`) for callers
 *      that already hold the kernel row from a batched load. It is not a second
 *      rule: it is built only from the shared module's primitives.
 *
 * Legacy rows whose owner is a placeholder ("" or the zero address) are owned by
 * nobody. They must be claimed through an authenticated POST /api/kernels first.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveApiKey } from "./api-key-auth.js";
import { resolveSession } from "./siwe-auth.js";
import { isSamePrincipal, lookupKernelOwner, ZERO_ADDRESS } from "./kernel-operator.js";

/** A usable principal: a string that is not blank. Anything else is no principal. */
function presentPrincipal(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * The authenticated actor of a request, or undefined.
 *
 * apiGate's identity first (`operatorId ?? userId`). Otherwise the same
 * resolvers apiGate uses (API key, then SIWE session), because apiGate never
 * resolves identity on a path its allowlist treats as public. A resolver that
 * throws (credential store unavailable) yields no identity (fail closed).
 */
export function resolveRequestActor(req: FastifyRequest): string | undefined {
  const r = req as unknown as { operatorId?: unknown; userId?: unknown };
  const fromGate = presentPrincipal(r.operatorId) ?? presentPrincipal(r.userId);
  if (fromGate) return fromGate;
  try {
    const fromKey = presentPrincipal(resolveApiKey(req)?.operatorId);
    if (fromKey) return fromKey;
    return presentPrincipal(resolveSession(req)?.address);
  } catch {
    return undefined;
  }
}

/**
 * True iff `actor` owns a kernel whose recorded operator is `owner`.
 * Same comparison as `requireKernelOperator`: an unowned placeholder
 * (missing, "" or the zero address) owns nothing, then `isSamePrincipal`.
 */
export function ownsKernel(owner: unknown, actor: unknown): boolean {
  const principal = presentPrincipal(actor);
  if (!principal) return false;
  if (typeof owner !== "string" || !owner || owner === ZERO_ADDRESS) return false;
  return isSamePrincipal(owner, principal);
}

export type KernelOwnerVerdict =
  | { ok: true; actor: string }
  | { ok: false; status: 401 | 403 | 404 | 502; error: string; message: string };

const ACTOR_REQUIRED = {
  ok: false,
  status: 401,
  error: "api_key_required",
  message: "This action requires the API key (or session) of the kernel's operator.",
} as const;

/**
 * Decide whether `actor` may mutate `kernelId`. Never throws. The owner comes
 * from `lookupKernelOwner` (shared module), so an unknown kernel (404) and a
 * failed lookup (502) are told apart, and both refuse.
 */
export async function checkKernelOwner(
  actor: string | undefined,
  kernelId: string,
): Promise<KernelOwnerVerdict> {
  const principal = presentPrincipal(actor);
  if (!principal) return ACTOR_REQUIRED;
  const lookup = await lookupKernelOwner(kernelId);
  if (!lookup.found) {
    return lookup.reason === "not_found"
      ? {
          ok: false,
          status: 404,
          error: "kernel_not_found",
          message: `Kernel '${kernelId}' does not exist`,
        }
      : {
          ok: false,
          status: 502,
          error: "kernel_lookup_failed",
          message: `Cannot verify operator ownership of kernel '${kernelId}'`,
        };
  }
  if (!ownsKernel(lookup.owner, principal)) {
    return {
      ok: false,
      status: 403,
      error: "not_kernel_owner",
      message:
        !lookup.owner || lookup.owner === ZERO_ADDRESS
          ? `Kernel '${kernelId}' has no recorded operator; claim it with an authenticated POST /api/kernels first`
          : `Authenticated actor does not own kernel '${kernelId}'`,
    };
  }
  return { ok: true, actor: principal };
}

/**
 * Route helper: resolve the actor, refuse (401) when there is none, and return it.
 * Returns null after sending the refusal.
 */
export function requireActor(req: FastifyRequest, reply: FastifyReply): string | null {
  const actor = resolveRequestActor(req);
  if (actor) return actor;
  void reply.code(ACTOR_REQUIRED.status).send({ error: ACTOR_REQUIRED.error, message: ACTOR_REQUIRED.message });
  return null;
}

/**
 * Route helper: the request's actor must own `kernelId`. Returns the actor when
 * authorized. Otherwise it has already sent the refusal and returns null.
 * Call it BEFORE any write so a refusal leaves state untouched.
 */
export async function requireKernelOwner(
  req: FastifyRequest,
  reply: FastifyReply,
  kernelId: string,
): Promise<string | null> {
  const verdict = await checkKernelOwner(resolveRequestActor(req), kernelId);
  if (verdict.ok) return verdict.actor;
  void reply.code(verdict.status).send({ error: verdict.error, message: verdict.message, kernelId });
  return null;
}
