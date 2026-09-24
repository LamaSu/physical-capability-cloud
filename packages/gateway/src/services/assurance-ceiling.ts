/**
 * Assurance ceiling — the ONE server-side authority for the assurance tiers a
 * kernel, and every capability it lists, may be SERVED, SEARCHED or SELECTED at.
 *
 * Why this exists (WP-C, MUST-CLOSE 5): a kernel's `maxAssuranceTier` and each
 * capability's `assuranceTiers` are operator-SUBMITTED claims. Before this
 * module the gateway stored and served them verbatim (defaulting an omitted
 * claim to 2), and the only server-side cap was an opt-in populator branch that
 * nothing opted into. A fresh kernel could therefore advertise tier 3 and be
 * selected for tier-3 work. Claims are still stored, but only as CLAIMS: every
 * read, search and selection path serves the clamped value from here, and
 * nothing writes the ceiling back into the row.
 *
 * THE RULE (decided; implement here and nowhere else):
 *
 *   authorizedAssuranceCeiling(kernel) =
 *     0  if the kernel has no proven signing key
 *        (no signingKeyAlgorithm+signingKeyPublicKey AND no signingAddress)
 *     else min(3, reputationService.getMaxAllowedTier(
 *                   effectiveReputation(kernel), kernel.totalJobsCompleted ?? 0))
 *   normalizeClaim(x)            = integer in 0..3, else 0   (NOT 2)
 *   effectiveMaxAssuranceTier(k) = min(normalizeClaim(k.maxAssuranceTier),
 *                                      authorizedAssuranceCeiling(k))
 *
 * AUTHORITY. Reputation (decayed and cold-start gated by ReputationService) is
 * the INTERIM authority. The intended future authority is an MS-11
 * NodeCapabilityCertificate, which may RAISE the ceiling per evidence profile.
 * That is not built here; when it lands it plugs in at
 * authorizedAssuranceCeiling() and nowhere else. Tier math is reused from
 * ReputationService (getMaxAllowedTier + computeEffectiveReputation), never
 * re-derived.
 *
 * FAIL CLOSED. Missing, malformed or ambiguous input grants nothing:
 *   - a signing identity counts as proven only when it has the exact shape the
 *     proof-of-possession path persists (ed25519: "0x"+64 hex under the
 *     "ed25519" tag; secp256k1: a 0x+40-hex address under the "secp256k1" tag or
 *     the untagged legacy #230 lane). An unknown tag or a malformed key is
 *     treated as absent, the same way the signer bind treats it;
 *   - non-finite / negative reputation or job counts are read as 0;
 *   - a claimed tier that is not an integer in 0..3 normalizes to 0;
 *   - an unknown owning kernel means a ceiling of 0.
 */

import type { AssuranceTier } from "@pcc/spec";
import { getReputationService } from "./reputation-service.js";

/** Highest assurance tier that exists. */
export const MAX_ASSURANCE_TIER: AssuranceTier = 3;

/**
 * The kernel-row fields the ceiling reads. These are `shop_kernels` columns.
 * Every field is optional so a partial or legacy row fails closed instead of
 * crashing.
 */
export interface AssuranceCeilingKernel {
  signingAddress?: string | null;
  signingKeyAlgorithm?: string | null;
  signingKeyPublicKey?: string | null;
  reputation?: number | null;
  reputationUpdatedAt?: string | null;
  totalJobsCompleted?: number | null;
}

/** A kernel row plus its stored (claimed) max tier. */
export interface AssuranceClaimKernel extends AssuranceCeilingKernel {
  maxAssuranceTier?: unknown;
}

/** Shape the proof-of-possession path persists for an Ed25519 key ("0x"+64 hex). */
const ED25519_PUBLIC_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
/** Shape the proof-of-possession path persists for a secp256k1 identity. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** True iff `x` is an integer tier in 0..3. Strings, floats, NaN and out-of-range values are rejected. */
export function isAssuranceTier(x: unknown): x is AssuranceTier {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= MAX_ASSURANCE_TIER;
}

/**
 * Normalize a CLAIMED tier: an integer in 0..3 is kept, anything else is 0.
 * A malformed claim grants the lowest tier, never the old default of 2.
 */
export function normalizeClaim(x: unknown): AssuranceTier {
  return isAssuranceTier(x) ? x : 0;
}

/**
 * True iff the kernel row carries a proven signing identity, meaning one the
 * registration path only persists after a verified proof-of-possession:
 *   - ed25519: `signingKeyAlgorithm === "ed25519"` + a well-formed `signingKeyPublicKey`;
 *   - secp256k1: tag "secp256k1" or untagged (legacy #230) + a well-formed `signingAddress`.
 * Anything else (no key, an unknown tag, a malformed value) is not proven.
 */
export function hasProvenSigningKey(kernel: AssuranceCeilingKernel | null | undefined): boolean {
  if (!kernel) return false;
  const algorithm = kernel.signingKeyAlgorithm;
  if (algorithm === "ed25519") {
    return (
      typeof kernel.signingKeyPublicKey === "string" &&
      ED25519_PUBLIC_KEY_RE.test(kernel.signingKeyPublicKey)
    );
  }
  if (algorithm === null || algorithm === undefined || algorithm === "" || algorithm === "secp256k1") {
    return typeof kernel.signingAddress === "string" && EVM_ADDRESS_RE.test(kernel.signingAddress);
  }
  return false;
}

/** Completed jobs as a non-negative integer. Garbage reads as 0. */
function completedJobs(kernel: AssuranceCeilingKernel): number {
  const jobs = kernel.totalJobsCompleted;
  return typeof jobs === "number" && Number.isFinite(jobs) && jobs > 0 ? Math.floor(jobs) : 0;
}

/**
 * Effective (decayed + cold-start) reputation, via ReputationService. Reads the
 * RAW row. It never uses a PopulationContext reputation cache, because those
 * caches default a missing score to 500 and are display enrichment, not authority.
 */
export function effectiveReputation(kernel: AssuranceCeilingKernel): number {
  const stored = kernel.reputation;
  const base = typeof stored === "number" && Number.isFinite(stored) && stored > 0 ? stored : 0;
  return getReputationService().computeEffectiveReputation(
    base,
    kernel.reputationUpdatedAt ?? null,
    completedJobs(kernel),
  );
}

/**
 * The highest tier this kernel is AUTHORIZED to be served or selected at,
 * regardless of what it claims. See the module comment for the rule.
 * A missing kernel (e.g. a capability whose kernel row is gone) has a ceiling of 0.
 */
export function authorizedAssuranceCeiling(
  kernel: AssuranceCeilingKernel | null | undefined,
): AssuranceTier {
  if (!kernel || !hasProvenSigningKey(kernel)) return 0;
  const allowed = getReputationService().getMaxAllowedTier(
    effectiveReputation(kernel),
    completedJobs(kernel),
  );
  // normalizeClaim keeps the result a real tier even if the service ever
  // returned something outside 0..3.
  return normalizeClaim(Math.min(MAX_ASSURANCE_TIER, allowed));
}

/**
 * The tier a kernel DTO serves: its normalized claim, capped at its authorized
 * ceiling. A kernel can always claim LESS than its ceiling, never more.
 */
export function effectiveMaxAssuranceTier(
  kernel: AssuranceClaimKernel | null | undefined,
): AssuranceTier {
  if (!kernel) return 0;
  return Math.min(
    normalizeClaim(kernel.maxAssuranceTier),
    authorizedAssuranceCeiling(kernel),
  ) as AssuranceTier;
}

/**
 * Clamp a capability's claimed `assuranceTiers` to a ceiling: each value must
 * be an integer in 0..3 and at most `ceiling`. Other values are dropped, as are
 * duplicates (first-occurrence order is kept). If nothing remains, the result
 * is `[0]`. A ceiling that is not a valid tier is read as 0.
 */
export function clampAssuranceTiers(tiers: unknown, ceiling: unknown): AssuranceTier[] {
  const cap = normalizeClaim(ceiling);
  const out: AssuranceTier[] = [];
  if (Array.isArray(tiers)) {
    for (const t of tiers) {
      if (isAssuranceTier(t) && t <= cap && !out.includes(t)) out.push(t);
    }
  }
  return out.length > 0 ? out : [0];
}

/**
 * Build a kernelId → ceiling map from pre-loaded kernel rows. Batch callers use
 * this so each kernel is evaluated once. Look-ups for ids missing from the map
 * must fall back to 0 (see {@link ceilingFor}).
 */
export function buildAssuranceCeilingMap(
  kernels: Iterable<(AssuranceCeilingKernel & { id: string }) | null | undefined>,
): Map<string, AssuranceTier> {
  const map = new Map<string, AssuranceTier>();
  for (const k of kernels) {
    if (k && typeof k.id === "string") map.set(k.id, authorizedAssuranceCeiling(k));
  }
  return map;
}

/** Ceiling for `kernelId` from a pre-built map. An unknown kernel is 0 (fail closed). */
export function ceilingFor(map: ReadonlyMap<string, AssuranceTier>, kernelId: string): AssuranceTier {
  return map.get(kernelId) ?? 0;
}
