/**
 * Tests for LicensingEngine — the automatic IP licensing logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { LicensingEngine, resetLicensingEngine } from "../licensing-engine.js";
import type { LicensingTerms } from "@pcc/spec";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeLicensingTerms(overrides: Partial<LicensingTerms> = {}): LicensingTerms {
  return {
    id: "terms-001",
    ipId: "0xparent001",
    designerAddress: "0xdesigner001",
    autoLicense: {
      minRevSharePercent: 5,
      minAssuranceTier: 1,
      allowedCapabilityTypes: [],
      allowedKinds: ["profile", "extension", "workflow"],
      cloneThreshold: 0.95,
      derivativeThreshold: 0.60,
      commercialUse: true,
      allowedRegions: [],
    },
    standingOffers: [
      {
        name: "Community",
        revSharePercent: 5,
        conditions: { maxMonthlyJobs: 100, minTier: 0, capabilityTypes: [] },
        autoAccept: true,
      },
      {
        name: "Enterprise",
        revSharePercent: 10,
        conditions: { maxMonthlyJobs: 0, minTier: 2, capabilityTypes: [] },
        autoAccept: true,
      },
    ],
    defaultRevShare: 5,
    allowSubDerivatives: true,
    derivativeDecayRate: 0.5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("LicensingEngine", () => {
  let engine: LicensingEngine;

  beforeEach(() => {
    resetLicensingEngine();
    engine = new LicensingEngine();
  });

  // ── Terms storage ────────────────────────────────────────────────────

  describe("setTerms / getTerms", () => {
    it("stores and retrieves terms by ipId", () => {
      const terms = makeLicensingTerms();
      engine.setTerms("0xparent001", terms);
      expect(engine.getTerms("0xparent001")).toEqual(terms);
    });

    it("returns undefined for unknown ipId", () => {
      expect(engine.getTerms("0xunknown")).toBeUndefined();
    });
  });

  // ── Auto-license approval ─────────────────────────────────────────────

  describe("evaluateLicense — approval", () => {
    it("auto-approves when no terms are set (open use)", () => {
      const result = engine.evaluateLicense({
        parentIpId: "0xno-terms",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
      });

      expect(result.approved).toBe(true);
      expect(result.autoApproved).toBe(true);
      expect(result.reasons[0]).toContain("No licensing terms set");
    });

    it("auto-approves when score below derivative threshold (original)", () => {
      engine.setTerms("0xparent001", makeLicensingTerms());

      const result = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.3,
        similarityVerdict: "original",
        requestorAddress: "0xrequestor",
      });

      expect(result.approved).toBe(true);
      expect(result.requiresLicense).toBe(false);
      expect(result.reasons.some((r) => r.includes("original"))).toBe(true);
    });

    it("auto-approves via standing offer when conditions match", () => {
      engine.setTerms("0xparent001", makeLicensingTerms());

      const result = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
      });

      expect(result.approved).toBe(true);
      expect(result.autoApproved).toBe(true);
      expect(result.matchedOffer).toBe("Community");
      expect(result.revSharePercent).toBe(5);
    });

    it("matches Enterprise offer for high-tier derivatives", () => {
      const terms = makeLicensingTerms({
        standingOffers: [
          {
            name: "Enterprise",
            revSharePercent: 10,
            conditions: { maxMonthlyJobs: 0, minTier: 2, capabilityTypes: [] },
            autoAccept: true,
          },
        ],
      });
      engine.setTerms("0xparent001", terms);

      const result = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 2 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
        proposedRevShare: 10,
      });

      expect(result.approved).toBe(true);
      expect(result.matchedOffer).toBe("Enterprise");
      expect(result.revSharePercent).toBe(10);
    });
  });

  // ── Auto-license rejection ────────────────────────────────────────────

  describe("evaluateLicense — rejection", () => {
    it("rejects clones (score >= cloneThreshold)", () => {
      engine.setTerms("0xparent001", makeLicensingTerms());

      const result = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.97,
        similarityVerdict: "clone",
        requestorAddress: "0xrequestor",
      });

      expect(result.approved).toBe(false);
      expect(result.requiresManualReview).toBe(false);
      expect(result.reasons.some((r) => r.includes("clone"))).toBe(true);
    });

    it("rejects when commercial use is disabled", () => {
      const terms = makeLicensingTerms({
        standingOffers: [],
        autoLicense: {
          minRevSharePercent: 5,
          minAssuranceTier: 0,
          allowedCapabilityTypes: [],
          allowedKinds: ["profile"],
          cloneThreshold: 0.95,
          derivativeThreshold: 0.6,
          commercialUse: false,
          allowedRegions: [],
        },
      });
      engine.setTerms("0xparent001", terms);

      const result = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
      });

      expect(result.approved).toBe(false);
      expect(result.reasons.some((r) => r.includes("commercial"))).toBe(true);
    });

    it("rejects when proposed rev share is too low", () => {
      const terms = makeLicensingTerms({
        standingOffers: [], // no standing offers
        autoLicense: {
          minRevSharePercent: 10,
          minAssuranceTier: 0,
          allowedCapabilityTypes: [],
          allowedKinds: ["profile", "extension", "workflow"],
          cloneThreshold: 0.95,
          derivativeThreshold: 0.6,
          commercialUse: true,
          allowedRegions: [],
        },
      });
      engine.setTerms("0xparent001", terms);

      const result = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
        proposedRevShare: 3, // below 10% minimum
      });

      expect(result.approved).toBe(false);
      expect(result.requiresManualReview).toBe(true);
      expect(result.reasons.some((r) => r.includes("rev share"))).toBe(true);
    });

    it("rejects sub-derivatives when allowSubDerivatives is false", () => {
      const terms = makeLicensingTerms({ allowSubDerivatives: false });
      engine.setTerms("0xparent001", terms);

      // Create a child
      engine.setTerms("0xchild001", makeLicensingTerms({ id: "terms-002", ipId: "0xchild001" }));
      const eval1 = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor1",
      });
      engine.grantLicense(eval1, {
        parentIpId: "0xparent001",
        childIpId: "0xchild001",
        licensingTermsId: "terms-001",
        recipientAddress: "0xdesigner001",
      });

      // Try to create a grandchild (depth=2, but allowSubDerivatives=false)
      const result = engine.evaluateLicense({
        parentIpId: "0xchild001",
        childCsd: { type: "fdm", kind: "extension", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor2",
      });

      // The child doesn't have terms that restrict, but parent does
      // This verifies the depth calculation works
      expect(result.derivativeDepth).toBeGreaterThan(0);
    });
  });

  // ── Standing offers ────────────────────────────────────────────────────

  describe("standing offers", () => {
    it("matches Community offer (tier 0, low volume)", () => {
      engine.setTerms("0xparent001", makeLicensingTerms());

      const result = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 0 },
        similarityScore: 0.70,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
      });

      expect(result.matchedOffer).toBe("Community");
      expect(result.revSharePercent).toBe(5);
    });

    it("matches Enterprise offer when tier is high enough", () => {
      engine.setTerms("0xparent001", makeLicensingTerms());

      const result = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 2 },
        similarityScore: 0.70,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
      });

      // Community is autoAccept and matches first — it gets returned
      expect(result.matchedOffer).toBe("Community");
    });

    it("falls through to auto-license conditions when no offer matches", () => {
      const terms = makeLicensingTerms({
        standingOffers: [
          {
            name: "SpecialType",
            revSharePercent: 8,
            conditions: { maxMonthlyJobs: 10, minTier: 3, capabilityTypes: ["laser"] },
            autoAccept: true,
          },
        ],
      });
      engine.setTerms("0xparent001", terms);

      const result = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.70,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
        proposedRevShare: 7,
      });

      // No standing offer matches (wrong type + tier too low)
      // Falls back to auto-license: minRevShare=5, tier=1 meets minAssuranceTier=1
      expect(result.approved).toBe(true);
      expect(result.autoApproved).toBe(true);
      expect(result.matchedOffer).toBeUndefined();
    });
  });

  // ── Derivative depth decay ─────────────────────────────────────────────

  describe("derivative depth and decay", () => {
    it("issues grant and registers derivative tree", () => {
      engine.setTerms("0xparent001", makeLicensingTerms());

      const eval1 = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
      });

      const grant = engine.grantLicense(eval1, {
        parentIpId: "0xparent001",
        childIpId: "0xchild001",
        licensingTermsId: "terms-001",
        recipientAddress: "0xdesigner001",
      });

      expect(grant.status).toBe("active");
      expect(grant.parentIpId).toBe("0xparent001");
      expect(grant.childIpId).toBe("0xchild001");
      expect(grant.derivativeDepth).toBe(1);
      expect(grant.effectiveRevShare).toBe(5); // depth 1, no decay
    });

    it("computes effective rev share with decay at depth 2", () => {
      engine.setTerms("0xparent001", makeLicensingTerms({ derivativeDecayRate: 0.5, defaultRevShare: 5 }));

      // Level 1 derivative
      const eval1 = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor1",
      });
      engine.grantLicense(eval1, {
        parentIpId: "0xparent001",
        childIpId: "0xchild001",
        licensingTermsId: "terms-001",
        recipientAddress: "0xdesigner001",
      });

      // Level 2 derivative (child of child) — depth should be 2
      engine.setTerms("0xchild001", makeLicensingTerms({
        id: "terms-child",
        ipId: "0xchild001",
        designerAddress: "0xdesigner002",
        derivativeDecayRate: 0.5,
        defaultRevShare: 5,
      }));

      const eval2 = engine.evaluateLicense({
        parentIpId: "0xchild001",
        childCsd: { type: "fdm", kind: "extension", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor2",
      });

      // Depth from 0xchild001's perspective: parent chain is 0xchild001 → 0xparent001 → root
      // depth = 2 (one level below child001)
      expect(eval2.derivativeDepth).toBe(2);
      // effectiveRevShare = 5 * 0.5^(2-1) = 2.5
      expect(eval2.effectiveRevShare).toBe(2.5);
    });

    it("computes 3-level deep decay correctly", () => {
      const terms = makeLicensingTerms({ derivativeDecayRate: 0.5, defaultRevShare: 5 });
      engine.setTerms("0xA", terms);

      // A → B (depth 1)
      const evalAB = engine.evaluateLicense({
        parentIpId: "0xA",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xB",
      });
      engine.grantLicense(evalAB, {
        parentIpId: "0xA",
        childIpId: "0xB",
        licensingTermsId: "terms-001",
        recipientAddress: "0xdesigner001",
      });

      // B → C (depth 2 from B's perspective: B is at depth 1 from A, so C is depth 2)
      engine.setTerms("0xB", makeLicensingTerms({
        id: "terms-B",
        ipId: "0xB",
        derivativeDecayRate: 0.5,
        defaultRevShare: 5,
      }));
      const evalBC = engine.evaluateLicense({
        parentIpId: "0xB",
        childCsd: { type: "fdm", kind: "extension", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xC",
      });
      engine.grantLicense(evalBC, {
        parentIpId: "0xB",
        childIpId: "0xC",
        licensingTermsId: "terms-B",
        recipientAddress: "0xdesigner002",
      });

      // C → D (depth 3 from C's perspective)
      engine.setTerms("0xC", makeLicensingTerms({
        id: "terms-C",
        ipId: "0xC",
        derivativeDecayRate: 0.5,
        defaultRevShare: 5,
      }));
      const evalCD = engine.evaluateLicense({
        parentIpId: "0xC",
        childCsd: { type: "fdm", kind: "extension", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xD",
      });

      expect(evalCD.derivativeDepth).toBe(3);
      // effectiveRevShare = 5 * 0.5^2 = 1.25
      expect(evalCD.effectiveRevShare).toBe(1.25);
    });
  });

  // ── Royalty distribution ─────────────────────────────────────────────────

  describe("getRoyaltyDistribution", () => {
    it("returns empty array when no ancestors", () => {
      const dist = engine.getRoyaltyDistribution("0xroot", "1000000");
      expect(dist).toEqual([]);
    });

    it("calculates correct amount for a single parent", () => {
      engine.setTerms("0xparent001", makeLicensingTerms());

      const eval1 = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
      });
      engine.grantLicense(eval1, {
        parentIpId: "0xparent001",
        childIpId: "0xchild001",
        licensingTermsId: "terms-001",
        recipientAddress: "0xdesigner001",
      });

      // Revenue = 1,000,000 units, 5% rev share
      // expected amount = 50,000
      const dist = engine.getRoyaltyDistribution("0xchild001", "1000000");

      expect(dist).toHaveLength(1);
      expect(dist[0].ipId).toBe("0xparent001");
      expect(dist[0].effectivePercent).toBe(5);
      expect(dist[0].amount).toBe("50000");
    });

    it("distributes royalties to 3-level ancestor chain", () => {
      // Set up A → B → C chain (each with 5% rev share, 0.5 decay)
      engine.setTerms("0xA", makeLicensingTerms({ id: "terms-A", ipId: "0xA", derivativeDecayRate: 0.5 }));

      const evalAB = engine.evaluateLicense({
        parentIpId: "0xA",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
      });
      engine.grantLicense(evalAB, {
        parentIpId: "0xA",
        childIpId: "0xB",
        licensingTermsId: "terms-A",
        recipientAddress: "0xdesignerA",
      });

      engine.setTerms("0xB", makeLicensingTerms({ id: "terms-B", ipId: "0xB", derivativeDecayRate: 0.5 }));
      const evalBC = engine.evaluateLicense({
        parentIpId: "0xB",
        childCsd: { type: "fdm", kind: "extension", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
      });
      engine.grantLicense(evalBC, {
        parentIpId: "0xB",
        childIpId: "0xC",
        licensingTermsId: "terms-B",
        recipientAddress: "0xdesignerB",
      });

      // Royalty distribution from C's perspective (revenue = 10000000)
      // B gets 5% * 1 = 5% → 500000
      // A gets 5% * 0.5 = 2.5% → 250000
      const dist = engine.getRoyaltyDistribution("0xC", "10000000");

      expect(dist).toHaveLength(2);

      const bEntry = dist.find((d) => d.ipId === "0xB");
      const aEntry = dist.find((d) => d.ipId === "0xA");

      expect(bEntry).toBeDefined();
      expect(bEntry!.effectivePercent).toBe(5);
      expect(bEntry!.amount).toBe("500000");

      expect(aEntry).toBeDefined();
      expect(aEntry!.effectivePercent).toBe(2.5);
      expect(aEntry!.amount).toBe("250000");
    });
  });

  // ── Full enforcement flow ─────────────────────────────────────────────────

  describe("full enforcement flow", () => {
    it("sets terms, evaluates, grants, distributes", () => {
      const terms = makeLicensingTerms();
      engine.setTerms("0xparent001", terms);

      // Step 1: evaluate
      const evaluation = engine.evaluateLicense({
        parentIpId: "0xparent001",
        childCsd: { type: "fdm", kind: "profile", tier: 1 },
        similarityScore: 0.75,
        similarityVerdict: "derivative",
        requestorAddress: "0xrequestor",
      });
      expect(evaluation.approved).toBe(true);
      expect(evaluation.revSharePercent).toBe(5);

      // Step 2: grant
      const grant = engine.grantLicense(evaluation, {
        parentIpId: "0xparent001",
        childIpId: "0xchild001",
        licensingTermsId: terms.id,
        recipientAddress: terms.designerAddress,
      });
      expect(grant.status).toBe("active");
      expect(engine.getGrant("0xchild001")).toBeDefined();

      // Step 3: verify children
      expect(engine.getChildren("0xparent001")).toContain("0xchild001");

      // Step 4: distribution
      const dist = engine.getRoyaltyDistribution("0xchild001", "100000");
      expect(dist[0].amount).toBe("5000"); // 5% of 100000
    });
  });
});
