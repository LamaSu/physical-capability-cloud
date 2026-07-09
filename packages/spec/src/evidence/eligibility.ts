/**
 * Evidence-eligibility lint (spec §5) — the concrete tier-eligibility rule.
 *
 * The rule (report-only first, then the oracle — same logic both places):
 *
 *   A CSD is tier-N eligible iff for every k ≤ N its tier-k evidence set
 *     (a) is non-empty,
 *     (b) references only status:"active" primitives (unknown/reserved cap at
 *         tier 0), each with tierSupport ∋ k,
 *     (c) satisfies dependency closure (every dependsOn present in the same or
 *         lower tier),
 *     (d) for k ≥ 2 includes ≥1 Family-G (human-attestation) primitive — the
 *         tier≥2 human floor the oracle already enforces, and
 *     (e) for k ≥ 1 includes ≥1 primitive that is NOT decl.self_attested (the
 *         typed tier-0 floor grants only tier 0).
 *   Anything else — unknown ids, reserved primitives, free-text-only required[]
 *   — CAPS at tier 0, and stays listable (tier 0 is the permissionless on-ramp).
 *
 * This is REPORT-ONLY by default: it returns an ELIGIBLE/CAPPED(reason) verdict;
 * callers do not (yet) reject registration on it. Pass
 * `requireImplementedVerifier: true` for the oracle-enforcing path, where a
 * referenced primitive whose verifier has not shipped caps its tier (spec §8
 * stub policy). Verifier stubs are surfaced as advisories in report-only mode.
 */

import {
  EVIDENCE_PRIMITIVES,
  HUMAN_ATTESTATION_FAMILY,
  type EvidencePrimitiveDef,
} from "./primitives.js";
import type { CSD, CsdEvidenceTier } from "../csd/schema.js";

const TIER_KEY = /^tier([0-3])$/;

export interface TierEligibility {
  tier: number;
  /** Strict result of the tier's checks. */
  eligible: boolean;
  /** Empty when eligible; else the capping reasons. */
  reasons: string[];
  /** Advisory (non-capping in report-only): referenced primitives whose verifier
   *  is not yet live. Becomes a capping reason under requireImplementedVerifier. */
  stubVerifierPrimitives: string[];
}

export interface CsdEligibilityReport {
  url: string;
  verdict: "ELIGIBLE" | "CAPPED";
  /** Highest tier N for which tiers 0..N are all eligible. Always ≥ 0: tier 0 is
   *  the permissionless, always-listable floor. */
  eligibleTier: number;
  /** Highest tier the CSD declares evidence for. */
  declaredTier: number;
  perTier: TierEligibility[];
  /** First capping reason (from the tier that capped), when CAPPED. */
  cappedReason?: string;
}

export interface EligibilityOptions {
  /** Primitive index to resolve ids against. Defaults to the v1 vocabulary. */
  index?: ReadonlyMap<string, EvidencePrimitiveDef>;
  /** Oracle-enforcing mode (spec §8 stub policy): a referenced primitive whose
   *  verifierStatus !== "live" caps its tier. Default false = report-only lint. */
  requireImplementedVerifier?: boolean;
}

function defaultIndex(): ReadonlyMap<string, EvidencePrimitiveDef> {
  return new Map(EVIDENCE_PRIMITIVES.map((d) => [d.id, d]));
}

/**
 * Evaluate one tier's structured `primitives[]` against the rule. `priorIds` is
 * the set of primitive ids present in strictly-lower tiers (for same-or-lower
 * dependency closure).
 */
function evaluateTier(
  k: number,
  tier: CsdEvidenceTier,
  index: ReadonlyMap<string, EvidencePrimitiveDef>,
  priorIds: ReadonlySet<string>,
  requireVerifier: boolean,
): TierEligibility {
  const reasons: string[] = [];
  const stubVerifierPrimitives: string[] = [];
  const refs = tier.primitives ?? [];

  // Legacy free-text-only tier (no structured primitives[]).
  if (refs.length === 0) {
    if (k >= 1) {
      reasons.push(
        `tier${k}: no structured primitives[] — legacy free-text required[] caps at tier 0`,
      );
    }
    return { tier: k, eligible: reasons.length === 0, reasons, stubVerifierPrimitives };
  }

  // same-or-lower id set for dependency closure.
  const availableIds = new Set(priorIds);
  for (const ref of refs) availableIds.add(ref.id);

  let hasNonDecl = false;
  let hasHumanAttestation = false;

  for (const ref of refs) {
    const def = index.get(ref.id);
    if (!def) {
      reasons.push(`tier${k}: unknown primitive "${ref.id}" — caps at tier 0`);
      continue;
    }
    if (def.status !== "active") {
      reasons.push(
        `tier${k}: primitive "${ref.id}" is status:${def.status} — caps at tier 0`,
      );
      continue;
    }
    if (!def.tierSupport.some((t) => t.tier === k)) {
      reasons.push(`tier${k}: primitive "${ref.id}" does not support tier ${k}`);
    }
    if (def.verifierStatus !== "live") {
      stubVerifierPrimitives.push(ref.id);
      if (requireVerifier) {
        reasons.push(
          `tier${k}: primitive "${ref.id}" verifier not implemented (${def.verifierStatus})`,
        );
      }
    }
    for (const dep of def.dependsOn ?? []) {
      if (!availableIds.has(dep)) {
        reasons.push(
          `tier${k}: primitive "${ref.id}" depends on "${dep}" absent from tier ≤ ${k}`,
        );
      }
    }
    if (def.id !== "decl.self_attested") hasNonDecl = true;
    if (def.family === HUMAN_ATTESTATION_FAMILY) hasHumanAttestation = true;
  }

  if (k >= 1 && !hasNonDecl) {
    reasons.push(
      `tier${k}: only decl.self_attested — tiers above 0 require a non-declaration primitive`,
    );
  }
  if (k >= 2 && !hasHumanAttestation) {
    reasons.push(
      `tier${k}: no human-attestation (Family-G) primitive — the tier≥2 human floor`,
    );
  }

  return { tier: k, eligible: reasons.length === 0, reasons, stubVerifierPrimitives };
}

/**
 * Compute the tier-eligibility report for a CSD's evidence map.
 *
 * Only needs `url` + `evidence`, so it works on partial CSDs and CSD drafts.
 */
export function computeCsdEligibility(
  csd: Pick<CSD, "url" | "evidence">,
  options: EligibilityOptions = {},
): CsdEligibilityReport {
  const index = options.index ?? defaultIndex();
  const requireVerifier = options.requireImplementedVerifier ?? false;
  const evidence = csd.evidence ?? {};

  const declaredTiers: number[] = [];
  for (const key of Object.keys(evidence)) {
    const m = TIER_KEY.exec(key);
    if (m) declaredTiers.push(Number(m[1]));
  }
  const declaredTier = declaredTiers.length ? Math.max(...declaredTiers) : 0;

  // Evaluate tiers 0..3 in order, accumulating a cumulative id set for
  // same-or-lower dependency closure.
  const cumulativeIds = new Set<string>();
  const perTier: TierEligibility[] = [];
  for (let k = 0; k <= 3; k++) {
    const tier = evidence[`tier${k}`] as CsdEvidenceTier | undefined;
    if (!tier) continue;
    perTier.push(evaluateTier(k, tier, index, cumulativeIds, requireVerifier));
    for (const ref of tier.primitives ?? []) cumulativeIds.add(ref.id);
  }

  // eligibleTier: highest N such that tiers 0..N all exist and are eligible.
  // Tier 0 is the always-listable floor: eligibleTier is never below 0, but an
  // unknown/reserved ref AT tier 0 blocks any ascent (still listable, capped at 0).
  const tier0 = perTier.find((p) => p.tier === 0);
  const tier0Blocks = tier0 !== undefined && !tier0.eligible;
  let eligibleTier = 0;
  if (!tier0Blocks) {
    for (let k = 1; k <= 3; k++) {
      const t = perTier.find((p) => p.tier === k);
      if (t && t.eligible && eligibleTier === k - 1) eligibleTier = k;
      else break;
    }
  }

  const capped = eligibleTier < declaredTier;
  const cappingTier = perTier.find((p) => p.tier === eligibleTier + 1);
  const cappedReason = capped
    ? tier0Blocks && tier0
      ? tier0.reasons[0]
      : (cappingTier?.reasons[0] ?? `tier ${eligibleTier + 1} not eligible`)
    : undefined;

  return {
    url: csd.url,
    verdict: capped ? "CAPPED" : "ELIGIBLE",
    eligibleTier,
    declaredTier,
    perTier,
    cappedReason,
  };
}
