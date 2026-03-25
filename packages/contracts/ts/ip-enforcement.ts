/**
 * IPEnforcementBridge — connects similarity detection → licensing engine → Story Protocol.
 *
 * Main entry points:
 *   enforceOnRegistration() — run before allowing a new CSD to be registered as IP
 *   settleRoyalties()       — auto-distribute revenue up the derivative tree when escrow releases
 */

import type { CSD } from "@pcc/spec";
import type { LicensingEngine, RoyaltyDistribution } from "./licensing-engine.js";
import type { StoryIPService } from "./story-ip-service.js";
import type { LicenseGrant } from "@pcc/spec";

// ── Inline types to avoid cross-package relative imports ──────────────
// These mirror the types from @pcc/verifier/bittensor

export interface SimilarityEntry {
  registeredUrl: string;
  overallScore: number;
  dimensions: Record<string, number>;
  verdict: "original" | "derivative" | "clone";
  ipId?: string;
}

export interface SimilarityScoringSynapse {
  candidateCsd: {
    url: string;
    name: string;
    description: string;
    kind: string;
    parameters: Array<{ key: string; type: string; label: string }>;
    constraints: Array<{ expression: string }>;
    pricing: { basePrice: string; currency: string; unit?: string };
  };
  registeredCsds: Array<{
    url: string;
    name: string;
    description: string;
    kind: string;
    parameters: Array<{ key: string; type: string; label: string }>;
    constraints: Array<{ expression: string }>;
    pricing: { basePrice: string; currency: string; unit?: string };
    ipId?: string;
    registeredAt: string;
  }>;
}

export interface SimilarityResult {
  similarities: SimilarityEntry[];
  minerCount: number;
  totalTimeMs: number;
}

export interface ISimilarityRouter {
  detectSimilarity(synapse: SimilarityScoringSynapse): Promise<SimilarityResult>;
}

// ── Public interfaces ─────────────────────────────────────────────────

export interface EnforcementResult {
  allowed: boolean;
  requiresLicense: boolean;
  autoLicensed: boolean;
  similarityResults: SimilarityEntry[];
  licenseGrant?: LicenseGrant;
  royaltyChain: RoyaltyDistribution[];
  reasons: string[];
}

export interface RoyaltySettlement {
  distributions: Array<{
    recipientAddress: string;
    amount: string;
    ipId: string;
    txHash: string;
  }>;
  totalDistributed: string;
}

// ── IPEnforcementBridge ───────────────────────────────────────────────

export class IPEnforcementBridge {
  constructor(
    private readonly similarityRouter: ISimilarityRouter,
    private readonly licensingEngine: LicensingEngine,
    private readonly storyService: StoryIPService,
  ) {}

  /**
   * Main entry point: enforce IP before allowing CSD registration.
   *
   * Algorithm:
   *   1. Run similarity detection against all registered CSDs that have IP Assets
   *   2. Find the highest-scoring match
   *   3. Apply enforcement logic:
   *      - below derivativeThreshold → original, approve freely
   *      - between derivative and clone threshold → try auto-license
   *      - at or above cloneThreshold → reject as clone
   *   4. If auto-licensed, issue grant and compute royalty chain
   */
  async enforceOnRegistration(
    candidateCsd: CSD,
    registeredCsds: Array<CSD & { ipId?: string }>,
    designerAddress: string,
  ): Promise<EnforcementResult> {
    const reasons: string[] = [];

    // Filter to CSDs that have IP registrations
    const ipCsds = registeredCsds.filter((c) => c.ipId != null);

    if (ipCsds.length === 0) {
      reasons.push("No registered IP Assets to compare against — open registration");
      return {
        allowed: true,
        requiresLicense: false,
        autoLicensed: false,
        similarityResults: [],
        royaltyChain: [],
        reasons,
      };
    }

    // Build the similarity synapse
    const synapse = this.buildSynapse(candidateCsd, ipCsds);

    // Run similarity detection
    const similarityResult = await this.similarityRouter.detectSimilarity(synapse);
    const similarities = similarityResult.similarities;

    // Find the most similar IP Asset
    const top = similarities.sort((a, b) => b.overallScore - a.overallScore)[0];

    if (!top) {
      reasons.push("Similarity check returned no results — open registration");
      return {
        allowed: true,
        requiresLicense: false,
        autoLicensed: false,
        similarityResults: similarities,
        royaltyChain: [],
        reasons,
      };
    }

    const parentIpId = top.ipId;
    const terms = parentIpId ? this.licensingEngine.getTerms(parentIpId) : undefined;

    // If the top match has no IP terms, use global thresholds
    const cloneThreshold = terms?.autoLicense.cloneThreshold ?? 0.95;
    const derivativeThreshold = terms?.autoLicense.derivativeThreshold ?? 0.60;

    reasons.push(
      `Highest similarity: ${top.overallScore.toFixed(3)} (${top.verdict}) against ${top.registeredUrl}`,
    );

    // Clone — hard reject
    if (top.overallScore >= cloneThreshold || top.verdict === "clone") {
      reasons.push(`Score ${top.overallScore.toFixed(3)} >= clone threshold ${cloneThreshold} — rejected`);
      return {
        allowed: false,
        requiresLicense: false,
        autoLicensed: false,
        similarityResults: similarities,
        royaltyChain: [],
        reasons,
      };
    }

    // Original — no license needed
    if (top.overallScore < derivativeThreshold || top.verdict === "original") {
      reasons.push(`Score ${top.overallScore.toFixed(3)} < derivative threshold ${derivativeThreshold} — original`);
      return {
        allowed: true,
        requiresLicense: false,
        autoLicensed: false,
        similarityResults: similarities,
        royaltyChain: [],
        reasons,
      };
    }

    // Derivative — evaluate auto-license
    reasons.push(`Score ${top.overallScore.toFixed(3)} — derivative, evaluating auto-license`);

    if (!parentIpId) {
      reasons.push("No IP Asset ID on most similar CSD — treating as original");
      return {
        allowed: true,
        requiresLicense: true,
        autoLicensed: false,
        similarityResults: similarities,
        royaltyChain: [],
        reasons,
      };
    }

    const evaluation = this.licensingEngine.evaluateLicense({
      parentIpId,
      childCsd: {
        type: candidateCsd.adapter?.type ?? "unknown",
        kind: candidateCsd.kind,
        tier: 0, // Default tier for new registrations
      },
      similarityScore: top.overallScore,
      similarityVerdict: top.verdict,
      requestorAddress: designerAddress,
    });

    reasons.push(...evaluation.reasons);

    if (!evaluation.approved) {
      return {
        allowed: false,
        requiresLicense: true,
        autoLicensed: false,
        similarityResults: similarities,
        royaltyChain: [],
        reasons,
      };
    }

    // Auto-licensed — issue grant if there are terms
    const terms2 = this.licensingEngine.getTerms(parentIpId);
    if (!terms2) {
      return {
        allowed: true,
        requiresLicense: false,
        autoLicensed: false,
        similarityResults: similarities,
        royaltyChain: [],
        reasons,
      };
    }

    // We need a childIpId to issue the grant — use a placeholder since
    // the actual IP registration happens after enforcement clears.
    // The caller should update the grant once the actual IP is registered.
    const placeholderChildIpId = `pending:${candidateCsd.url}`;

    const grant = this.licensingEngine.grantLicense(evaluation, {
      parentIpId,
      childIpId: placeholderChildIpId,
      licensingTermsId: terms2.id,
      recipientAddress: terms2.designerAddress,
    });

    const royaltyChain = this.licensingEngine.getRoyaltyDistribution(
      placeholderChildIpId,
      "0", // Will be populated at settlement time
    );

    return {
      allowed: true,
      requiresLicense: true,
      autoLicensed: true,
      similarityResults: similarities,
      licenseGrant: grant,
      royaltyChain,
      reasons,
    };
  }

  /**
   * Auto-settle royalties when MilestoneEscrow releases funds for a job.
   *
   * Flow:
   *   1. Compute royalty distribution up the derivative tree
   *   2. Pay each ancestor via StoryIPService.payJobRoyalty()
   *   3. Return the settlement record
   */
  async settleRoyalties(
    jobId: string,
    childIpId: string,
    jobRevenue: string,
    payerAddress: string,
  ): Promise<RoyaltySettlement> {
    const distributions = this.licensingEngine.getRoyaltyDistribution(childIpId, jobRevenue);

    const settled: RoyaltySettlement["distributions"] = [];
    let totalDistributed = 0n;

    for (const dist of distributions) {
      if (dist.amount === "0") continue;

      try {
        const { txHash } = await this.storyService.payJobRoyalty(
          dist.ipId,
          dist.amount,
          payerAddress,
        );

        settled.push({
          recipientAddress: dist.recipientAddress,
          amount: dist.amount,
          ipId: dist.ipId,
          txHash,
        });

        totalDistributed += BigInt(dist.amount);
      } catch (err) {
        console.warn(
          `[ip-enforcement] Failed to settle royalty for IP ${dist.ipId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      distributions: settled,
      totalDistributed: String(totalDistributed),
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private buildSynapse(
    candidate: CSD,
    registered: Array<CSD & { ipId?: string }>,
  ) {
    const toSimilarityCsd = (csd: CSD) => ({
      url: csd.url,
      name: csd.name,
      description: csd.description,
      kind: csd.kind,
      parameters: csd.parameters.map((p) => ({
        key: p.key,
        type: p.type,
        label: p.label,
      })),
      constraints: csd.constraints.map((c) => ({
        expression: `${c.when.map((w) => `${w.param} ${w.operator} ${w.value}`).join(" AND ")}`,
      })),
      pricing: {
        basePrice: csd.pricing.basePrice,
        currency: csd.pricing.currency,
        unit: csd.pricing.unit,
      },
    });

    return {
      candidateCsd: toSimilarityCsd(candidate),
      registeredCsds: registered.map((r) => ({
        ...toSimilarityCsd(r),
        ipId: r.ipId,
        registeredAt: new Date().toISOString(),
      })),
    };
  }
}
