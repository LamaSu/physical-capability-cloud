/**
 * LicensingEngine — automatic IP licensing brain for PCC.
 *
 * Pure logic (no chain calls). Responsibilities:
 *   1. Store licensing terms per IP Asset
 *   2. Evaluate whether a derivative request meets auto-license conditions
 *   3. Calculate effective revenue shares with decay for nested derivatives
 *   4. Issue license grants
 *   5. Track the full derivative tree for royalty distribution
 *
 * Revenue decay example (decayRate=0.5, base revShare=5%):
 *   Level 1 → 5% to original
 *   Level 2 → 5%*0.5=2.5% to original, 5% to level-1
 *   Level 3 → 5%*0.25=1.25% to original, 2.5% to level-1, 5% to level-2
 */

import { randomUUID } from "node:crypto";
import type {
  LicensingTerms,
  LicenseGrant,
  StandingOffer,
} from "@pcc/spec";

// ── Public interfaces ─────────────────────────────────────────────────

export interface LicenseEvaluation {
  approved: boolean;
  autoApproved: boolean;
  /** True when the similarity score puts this in derivative range — license required */
  requiresLicense: boolean;
  matchedOffer?: string;           // standing offer name
  revSharePercent: number;
  effectiveRevShare: number;
  derivativeDepth: number;
  reasons: string[];               // why approved/rejected
  requiresManualReview: boolean;
}

export interface EffectiveRevShareChain {
  /** The IP Asset being evaluated */
  ipId: string;
  /** Each ancestor IP with its effective cut from a derivative job */
  chain: Array<{
    ipId: string;
    depth: number;
    baseRevShare: number;
    effectiveRevShare: number;
    recipientAddress: string;
  }>;
  /** Total rev share consumed by the ancestor chain (sum of effective shares) */
  totalAncestorShare: number;
}

export interface RoyaltyDistribution {
  recipientAddress: string;
  ipId: string;
  depth: number;
  sharePercent: number;
  effectivePercent: number;        // after decay
  amount: string;                  // calculated from jobRevenue
}

// ── Internal tree node ────────────────────────────────────────────────

interface DerivativeNode {
  childIpId: string;
  parentIpId: string;
  grant: LicenseGrant;
}

// ── LicensingEngine ───────────────────────────────────────────────────

export class LicensingEngine {
  /** Licensing terms keyed by ipId */
  private readonly terms = new Map<string, LicensingTerms>();

  /** Grants keyed by child IP Asset ID */
  private readonly grants = new Map<string, LicenseGrant>();

  /** Parent→children adjacency for the derivative tree */
  private readonly children = new Map<string, string[]>();

  /** Child→parent mapping */
  private readonly parents = new Map<string, string>();

  // ── Terms storage ────────────────────────────────────────────────────

  setTerms(ipId: string, terms: LicensingTerms): void {
    this.terms.set(ipId, terms);
  }

  getTerms(ipId: string): LicensingTerms | undefined {
    return this.terms.get(ipId);
  }

  // ── License evaluation ───────────────────────────────────────────────

  /**
   * Evaluate whether a derivative request should be auto-approved.
   *
   * Logic:
   *   1. If similarity < derivativeThreshold → original, no license needed
   *   2. If similarity >= cloneThreshold → clone, reject
   *   3. Otherwise → check auto-license conditions and standing offers
   */
  evaluateLicense(request: {
    parentIpId: string;
    childCsd: { type: string; kind: string; tier: number };
    similarityScore: number;
    similarityVerdict: "original" | "derivative" | "clone";
    requestorAddress: string;
    proposedRevShare?: number;
  }): LicenseEvaluation {
    const reasons: string[] = [];

    const terms = this.terms.get(request.parentIpId);
    if (!terms) {
      // No terms set → open, no license required
      return {
        approved: true,
        autoApproved: true,
        requiresLicense: false,
        revSharePercent: 0,
        effectiveRevShare: 0,
        derivativeDepth: this.computeDepth(request.parentIpId),
        reasons: ["No licensing terms set — open use"],
        requiresManualReview: false,
      };
    }

    const { autoLicense } = terms;
    const depth = this.computeDepth(request.parentIpId);

    // Clone detection — hard reject
    if (
      request.similarityVerdict === "clone" ||
      request.similarityScore >= autoLicense.cloneThreshold
    ) {
      reasons.push(
        `Similarity score ${request.similarityScore.toFixed(3)} >= clone threshold ${autoLicense.cloneThreshold} — rejected as clone`,
      );
      return {
        approved: false,
        autoApproved: false,
        requiresLicense: false, // clone = rejection, not licensing issue
        revSharePercent: 0,
        effectiveRevShare: 0,
        derivativeDepth: depth,
        reasons,
        requiresManualReview: false,
      };
    }

    // Below derivative threshold → original, no license needed
    if (
      request.similarityVerdict === "original" ||
      request.similarityScore < autoLicense.derivativeThreshold
    ) {
      reasons.push(
        `Similarity score ${request.similarityScore.toFixed(3)} < derivative threshold ${autoLicense.derivativeThreshold} — original, no license required`,
      );
      return {
        approved: true,
        autoApproved: true,
        requiresLicense: false,
        revSharePercent: 0,
        effectiveRevShare: 0,
        derivativeDepth: depth,
        reasons,
        requiresManualReview: false,
      };
    }

    // From here on, the similarity is in the derivative range → requires license
    // Sub-derivatives check
    if (!terms.allowSubDerivatives && depth > 1) {
      reasons.push(
        `Parent IP disallows sub-derivatives (depth would be ${depth})`,
      );
      return {
        approved: false,
        autoApproved: false,
        requiresLicense: true,
        revSharePercent: 0,
        effectiveRevShare: 0,
        derivativeDepth: depth,
        reasons,
        requiresManualReview: true,
      };
    }

    // Commercial use check
    if (!autoLicense.commercialUse) {
      reasons.push("Parent IP does not allow commercial use");
      return {
        approved: false,
        autoApproved: false,
        requiresLicense: true,
        revSharePercent: 0,
        effectiveRevShare: 0,
        derivativeDepth: depth,
        reasons,
        requiresManualReview: true,
      };
    }

    // Try standing offers first (best match = highest autoAccept + lowest cost to requestor)
    const matchedOffer = this.matchStandingOffer(terms.standingOffers, request);
    if (matchedOffer) {
      const revShare = matchedOffer.revSharePercent;
      const effective = this.applyDecay(revShare, terms.derivativeDecayRate, depth);
      reasons.push(`Matched standing offer: "${matchedOffer.name}"`);
      if (matchedOffer.autoAccept) {
        reasons.push("Auto-accepted via standing offer");
        return {
          approved: true,
          autoApproved: true,
          requiresLicense: true,
          matchedOffer: matchedOffer.name,
          revSharePercent: revShare,
          effectiveRevShare: effective,
          derivativeDepth: depth,
          reasons,
          requiresManualReview: false,
        };
      } else {
        reasons.push("Standing offer requires manual approval");
        return {
          approved: false,
          autoApproved: false,
          requiresLicense: true,
          matchedOffer: matchedOffer.name,
          revSharePercent: revShare,
          effectiveRevShare: effective,
          derivativeDepth: depth,
          reasons,
          requiresManualReview: true,
        };
      }
    }

    // Check auto-license conditions directly
    const proposedRevShare = request.proposedRevShare ?? terms.defaultRevShare;
    const conditionFailures = this.checkAutoLicenseConditions(
      autoLicense,
      request.childCsd,
      proposedRevShare,
    );

    if (conditionFailures.length === 0) {
      const effective = this.applyDecay(proposedRevShare, terms.derivativeDecayRate, depth);
      reasons.push("All auto-license conditions met");
      return {
        approved: true,
        autoApproved: true,
        requiresLicense: true,
        revSharePercent: proposedRevShare,
        effectiveRevShare: effective,
        derivativeDepth: depth,
        reasons,
        requiresManualReview: false,
      };
    }

    reasons.push(...conditionFailures);
    const effective = this.applyDecay(proposedRevShare, terms.derivativeDecayRate, depth);
    return {
      approved: false,
      autoApproved: false,
      requiresLicense: true,
      revSharePercent: proposedRevShare,
      effectiveRevShare: effective,
      derivativeDepth: depth,
      reasons,
      requiresManualReview: true,
    };
  }

  // ── Grant issuance ───────────────────────────────────────────────────

  /**
   * Issue a license grant from a successful evaluation.
   * Registers the child→parent relationship in the derivative tree.
   */
  grantLicense(
    evaluation: LicenseEvaluation,
    params: {
      parentIpId: string;
      childIpId: string;
      licensingTermsId: string;
      recipientAddress: string;
    },
  ): LicenseGrant {
    const grant: LicenseGrant = {
      id: randomUUID(),
      licensingTermsId: params.licensingTermsId,
      parentIpId: params.parentIpId,
      childIpId: params.childIpId,
      standingOfferId: evaluation.matchedOffer,
      revSharePercent: evaluation.revSharePercent,
      derivativeDepth: evaluation.derivativeDepth,
      effectiveRevShare: evaluation.effectiveRevShare,
      status: "active",
      recipientAddress: params.recipientAddress,
      grantedAt: new Date().toISOString(),
    };

    // Register in grant store and derivative tree
    this.grants.set(params.childIpId, grant);
    this.parents.set(params.childIpId, params.parentIpId);

    const existing = this.children.get(params.parentIpId) ?? [];
    if (!existing.includes(params.childIpId)) {
      existing.push(params.childIpId);
      this.children.set(params.parentIpId, existing);
    }

    return grant;
  }

  // ── Revenue chain calculation ─────────────────────────────────────────

  /**
   * Walk up the ancestor chain from a given IP Asset and compute the
   * effective revenue share for each ancestor (with decay applied).
   */
  calculateEffectiveRevShare(ipId: string): EffectiveRevShareChain {
    const chain: EffectiveRevShareChain["chain"] = [];
    let cursor = ipId;
    let totalShare = 0;

    while (this.parents.has(cursor)) {
      const parentId = this.parents.get(cursor)!;
      const grant = this.grants.get(cursor);
      if (!grant) break;

      const parentTerms = this.terms.get(parentId);
      const recipientAddress = parentTerms?.designerAddress ?? grant.recipientAddress;

      chain.push({
        ipId: parentId,
        depth: grant.derivativeDepth,
        baseRevShare: grant.revSharePercent,
        effectiveRevShare: grant.effectiveRevShare,
        recipientAddress,
      });

      totalShare += grant.effectiveRevShare;
      cursor = parentId;
    }

    return { ipId, chain, totalAncestorShare: totalShare };
  }

  /**
   * Get the full royalty distribution for a job running on a given child IP.
   * Walks the ancestor tree and computes each ancestor's cut from jobRevenue.
   *
   * Uses relative depth from child outward (1 = direct parent, 2 = grandparent, etc.)
   * Each ancestor's terms define the base rev share and decay rate.
   */
  getRoyaltyDistribution(childIpId: string, jobRevenue: string): RoyaltyDistribution[] {
    const revenueBig = BigInt(jobRevenue);
    const distributions: RoyaltyDistribution[] = [];

    // Walk up the ancestor chain, tracking relative depth from child
    let cursor = childIpId;
    let relativeDepth = 0;

    while (this.parents.has(cursor)) {
      relativeDepth++;
      const parentId = this.parents.get(cursor)!;
      const grant = this.grants.get(cursor);
      if (!grant) break;

      const parentTerms = this.terms.get(parentId);
      const recipientAddress = parentTerms?.designerAddress ?? grant.recipientAddress;
      const baseRevShare = grant.revSharePercent;
      const decayRate = parentTerms?.derivativeDecayRate ?? 0.5;

      // Effective share: apply decay based on relative depth from child
      // relativeDepth=1 (direct parent) → no decay (decay^0 = 1)
      // relativeDepth=2 (grandparent) → decay^1
      const effectivePercent = relativeDepth === 1
        ? baseRevShare
        : baseRevShare * Math.pow(decayRate, relativeDepth - 1);

      const roundedEffective = Math.round(effectivePercent * 10000) / 10000;
      const amountBig = (revenueBig * BigInt(Math.round(roundedEffective * 100))) / 10000n;

      distributions.push({
        recipientAddress,
        ipId: parentId,
        depth: relativeDepth,
        sharePercent: baseRevShare,
        effectivePercent: roundedEffective,
        amount: String(amountBig),
      });

      cursor = parentId;
    }

    return distributions;
  }

  // ── Accessors ─────────────────────────────────────────────────────────

  getGrant(childIpId: string): LicenseGrant | undefined {
    return this.grants.get(childIpId);
  }

  getChildren(parentIpId: string): string[] {
    return this.children.get(parentIpId) ?? [];
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /**
   * Compute the derivative depth of a new IP that would be a child of parentIpId.
   * Direct child of a root IP = depth 1.
   */
  private computeDepth(parentIpId: string): number {
    let depth = 0;
    let cursor: string | undefined = parentIpId;
    while (cursor !== undefined) {
      depth++;
      cursor = this.parents.get(cursor);
    }
    return depth;
  }

  /**
   * Apply decay to a base revenue share based on depth.
   * effectiveShare = baseShare * decayRate^(depth-1)
   */
  private applyDecay(baseShare: number, decayRate: number, depth: number): number {
    if (depth <= 1) return baseShare;
    const effective = baseShare * Math.pow(decayRate, depth - 1);
    // Round to 4 decimal places
    return Math.round(effective * 10000) / 10000;
  }

  /**
   * Try to match a standing offer for the derivative request.
   * Returns the first autoAccept offer that matches, or the first matching offer otherwise.
   */
  private matchStandingOffer(
    offers: StandingOffer[],
    request: {
      childCsd: { type: string; kind: string; tier: number };
      proposedRevShare?: number;
    },
  ): StandingOffer | undefined {
    let fallback: StandingOffer | undefined;

    for (const offer of offers) {
      const { conditions } = offer;

      // Check capability type constraint
      if (
        conditions.capabilityTypes.length > 0 &&
        !conditions.capabilityTypes.includes(request.childCsd.type)
      ) {
        continue;
      }

      // Check tier constraint
      if (request.childCsd.tier < conditions.minTier) {
        continue;
      }

      // Offer matches
      if (offer.autoAccept) {
        return offer; // return the first autoAccept match immediately
      }

      if (!fallback) {
        fallback = offer;
      }
    }

    return fallback;
  }

  /**
   * Check whether the child CSD and proposed rev share meet auto-license conditions.
   * Returns an array of failure reasons (empty = all conditions met).
   */
  private checkAutoLicenseConditions(
    conditions: LicensingTerms["autoLicense"],
    childCsd: { type: string; kind: string; tier: number },
    proposedRevShare: number,
  ): string[] {
    const failures: string[] = [];

    if (proposedRevShare < conditions.minRevSharePercent) {
      failures.push(
        `Proposed rev share ${proposedRevShare}% < minimum required ${conditions.minRevSharePercent}%`,
      );
    }

    if (childCsd.tier < conditions.minAssuranceTier) {
      failures.push(
        `Child CSD tier ${childCsd.tier} < minimum required tier ${conditions.minAssuranceTier}`,
      );
    }

    if (
      conditions.allowedCapabilityTypes.length > 0 &&
      !conditions.allowedCapabilityTypes.includes(childCsd.type)
    ) {
      failures.push(
        `Capability type "${childCsd.type}" not in allowed list: [${conditions.allowedCapabilityTypes.join(", ")}]`,
      );
    }

    if (
      conditions.allowedKinds.length > 0 &&
      !conditions.allowedKinds.includes(childCsd.kind as "base" | "profile" | "extension" | "workflow")
    ) {
      failures.push(
        `CSD kind "${childCsd.kind}" not in allowed list: [${conditions.allowedKinds.join(", ")}]`,
      );
    }

    return failures;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _engine: LicensingEngine | null = null;

export function getLicensingEngine(): LicensingEngine {
  if (!_engine) {
    _engine = new LicensingEngine();
  }
  return _engine;
}

export function resetLicensingEngine(): void {
  _engine = null;
}
