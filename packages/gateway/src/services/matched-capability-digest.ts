/**
 * A stable binding digest for a capability AS MATCHED, for composition's
 * compositionRoot commitment (coord #1439).
 *
 * ── READ THIS BEFORE USING IT ──────────────────────────────────────────────
 * THIS IS NOT `capabilityContractDigest`. Composition asked for that field, and
 * it is genuinely the right one — but it CANNOT BE COMPUTED HERE TODAY, and
 * quietly shipping something else under that name would be worse than shipping
 * nothing.
 *
 * `capabilityContractDigest` (packages/spec/src/csd/capability-contract-identity.ts)
 * is SHA-256 over the canonicalized RESOLVED CSD, which requires a CSD and a
 * `CsdRegistry` to resolve `baseDefinition` inheritance. The decomposer has
 * neither: it matches against `CapabilityLite` (id / type / name / kernelId /
 * pricing / tiers / tags / materials), and — verified 2026-08-26 — capability
 * rows carry NO csdUri, csdRef, or contractRef field of any kind. There is no
 * join from a matched capability to its CSD. That join is the real prerequisite
 * for `capabilityContractDigest`, and it does not exist yet.
 *
 * So this digest binds THE SNAPSHOT THE MATCH WAS MADE AGAINST. It answers
 * "did the thing I matched change underneath me?" — which is what makes a
 * commitment meaningful — but it does NOT carry CSD-resolution semantics, and
 * a consumer must not assume it does.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "node:crypto";
import { canonicalize } from "@pcc/spec";

/** The subset of a matched capability this digest commits to. */
export interface MatchedCapabilitySnapshot {
  capabilityId: string;
  capabilityType: string;
  kernelId: string;
  price: number;
  currency: string;
  assuranceTiers: number[];
}

/**
 * Fields deliberately EXCLUDED, and why — this list is the contract:
 *
 *  - `score`      the matcher's confidence, not a property of the capability.
 *                 Two runs may score differently for identical capabilities;
 *                 including it would make the digest unstable for no gain.
 *  - `name`       human-facing and freely editable. A rename is not a change
 *                 in what was bought.
 *  - `tags`,
 *    `materials`  descriptive. They influence WHETHER something matched, not
 *                 WHAT the operator is committing to deliver or be paid.
 *
 * Included, and why: id and type identify it; kernelId says WHO performs it
 * (the same capability type on a different kernel is a different commitment);
 * price and currency are the money; assuranceTiers are the evidence obligation.
 * If any of those six move, the commitment should not silently still verify.
 */
export function matchedCapabilityDigest(
  snap: MatchedCapabilitySnapshot,
): `0x${string}` {
  if (!Number.isFinite(snap.price)) {
    throw new TypeError(
      `matchedCapabilityDigest: price must be finite, got ${snap.price}. ` +
        `An unpriced match must not produce a digest that looks valid.`,
    );
  }
  const canonical = canonicalize({
    capabilityId: snap.capabilityId,
    capabilityType: snap.capabilityType,
    kernelId: snap.kernelId,
    // Price as a fixed-precision STRING, never a float. 0.1 + 0.2 style drift
    // in a JS number would move this digest for two runs that agree on the
    // money, and the shared canonicalizer's number serialization is not
    // RFC 8785 either.
    price: snap.price.toFixed(2),
    currency: snap.currency,
    // Sorted so the digest cannot depend on registry iteration order.
    assuranceTiers: [...snap.assuranceTiers].sort((a, b) => a - b),
  });
  return `0x${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** The canonical pre-image, exposed so a cross-lane mismatch is diffable. */
export function matchedCapabilityDigestPreImage(
  snap: MatchedCapabilitySnapshot,
): string {
  return canonicalize({
    capabilityId: snap.capabilityId,
    capabilityType: snap.capabilityType,
    kernelId: snap.kernelId,
    price: snap.price.toFixed(2),
    currency: snap.currency,
    assuranceTiers: [...snap.assuranceTiers].sort((a, b) => a - b),
  });
}
