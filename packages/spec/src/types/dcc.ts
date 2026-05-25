/**
 * Digital Capture Class (DCC) — provenance grades for indexed-tool invocations.
 *
 * Mirrors `CaptureClass` (CC0..CC5) from `./capture.ts` but for digital tool
 * calls rather than physical media captures. The same multiplier-into-base-
 * assurance-score equation applies; no new accounting is needed.
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §3.1
 *
 * The six classes in ascending order of authenticity depth:
 *
 *   DCC0 — Unsigned       no cryptographic provenance beyond bearer token
 *   DCC1 — Receipt        HMAC-signed Tool Receipt (arxiv 2603.10060)
 *   DCC2 — AEX            AEX-style request-projection + response-binding JWS
 *                         (arxiv 2603.14283)
 *   DCC3 — Sigstore       upstream response signed with Sigstore-attested cert
 *                         chain back to OIDC identity (Rekor inclusion proof)
 *   DCC4 — TEE/Enclave    response generated inside Intel SGX / AMD SEV /
 *                         Apple Secure Enclave with remote-attestation quote
 *                         (Marlin, Phala, etc.)
 *   DCC5 — ZK Proof       response accompanied by a zkSNARK proving the
 *                         execution trace (zkAgent-style)
 *
 * The multiplier folds into the same assurance score equation PCC uses for
 * physical evidence:
 *     finalScore = baseScore * dccMultiplier * trustTierGate
 *
 * This file contains types plus Zod schemas for `InvocationReceipt`-bearing
 * boundary validation. No runtime crypto — safe to import from browser code.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Digital capture classes + multipliers
// ---------------------------------------------------------------------------

/**
 * The six digital capture classes in ascending order of authenticity depth.
 * String enum for JSON interoperability and stable storage.
 */
export enum DigitalCaptureClass {
  DCC0 = "DCC0",
  DCC1 = "DCC1",
  DCC2 = "DCC2",
  DCC3 = "DCC3",
  DCC4 = "DCC4",
  DCC5 = "DCC5",
}

/**
 * Multipliers applied to the base assurance score per digital capture class.
 *
 * Rationale (spec §3.1):
 * - DCC0 (no signature)         significant penalty (0.70)
 * - DCC1 (HMAC receipt)         small penalty (0.92)
 * - DCC2 (AEX JWS)              tiny penalty (0.96)
 * - DCC3 (Sigstore)             neutral (1.00)
 * - DCC4 (TEE attestation)      neutral (1.00)
 * - DCC5 (ZK proof)             neutral (1.00)
 *
 * Matches CC0..CC5 numerics exactly — same accounting machinery applies.
 */
export const DCC_MULTIPLIERS: Record<DigitalCaptureClass, number> = {
  [DigitalCaptureClass.DCC0]: 0.70,
  [DigitalCaptureClass.DCC1]: 0.92,
  [DigitalCaptureClass.DCC2]: 0.96,
  [DigitalCaptureClass.DCC3]: 1.00,
  [DigitalCaptureClass.DCC4]: 1.00,
  [DigitalCaptureClass.DCC5]: 1.00,
};

/**
 * Ordering helper: maps DCC enum to numeric tier.
 *
 * Useful for downgrade arithmetic: `Math.min(requested_n, ceiling_n)` then map
 * back to the enum. Required for the auto-downgrade rule in §7 (spec) which
 * caps an indexed tool's effective class by the minimum of caller request,
 * tool's `assuranceCeiling`, and the trust-tier ceiling.
 */
export const DCC_TIER: Record<DigitalCaptureClass, 0 | 1 | 2 | 3 | 4 | 5> = {
  [DigitalCaptureClass.DCC0]: 0,
  [DigitalCaptureClass.DCC1]: 1,
  [DigitalCaptureClass.DCC2]: 2,
  [DigitalCaptureClass.DCC3]: 3,
  [DigitalCaptureClass.DCC4]: 4,
  [DigitalCaptureClass.DCC5]: 5,
};

/**
 * Reverse lookup: numeric tier to DCC enum. Useful after `min(...)` arithmetic.
 */
export const TIER_TO_DCC: Record<0 | 1 | 2 | 3 | 4 | 5, DigitalCaptureClass> = {
  0: DigitalCaptureClass.DCC0,
  1: DigitalCaptureClass.DCC1,
  2: DigitalCaptureClass.DCC2,
  3: DigitalCaptureClass.DCC3,
  4: DigitalCaptureClass.DCC4,
  5: DigitalCaptureClass.DCC5,
};

/**
 * Apply the standard min-of-three downgrade rule.
 *
 * effective = min(requested, trustTierCeiling, toolAssuranceCeiling)
 *
 * If any of the three caps would result in a class below DCC0, returns DCC0.
 * The returned DCC and a `reason` (present iff effective < requested) match
 * the pattern in CVP detector (`autoDowngrade.reason`).
 */
export function applyDccDowngrade(
  requested: DigitalCaptureClass,
  trustTierCeiling: DigitalCaptureClass,
  toolAssuranceCeiling: DigitalCaptureClass,
): { effective: DigitalCaptureClass; downgraded: boolean; reason?: string } {
  const r = DCC_TIER[requested];
  const t = DCC_TIER[trustTierCeiling];
  const a = DCC_TIER[toolAssuranceCeiling];
  const eTier = Math.min(r, t, a) as 0 | 1 | 2 | 3 | 4 | 5;
  const effective = TIER_TO_DCC[eTier];
  if (eTier === r) {
    return { effective, downgraded: false };
  }
  const cap = t < a ? "trustTierCeiling" : "toolAssuranceCeiling";
  return {
    effective,
    downgraded: true,
    reason: `requested ${requested} downgraded to ${effective} (${cap})`,
  };
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Zod enum schema for DCC validation at API boundaries. */
export const DigitalCaptureClassSchema = z.nativeEnum(DigitalCaptureClass);
