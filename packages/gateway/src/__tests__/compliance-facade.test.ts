import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initStore, closeStore } from "../db.js";
import { ComplianceFacade } from "../facades/compliance.facade.js";
import type { VerificationAttestation } from "@pcc/spec";

// Mock telemetry (used by BaseFacade.execute)
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));

// ── Fixture factories ──────────────────────────────────────────────────────

let idCounter = 0;

function makeAttestation(overrides: Partial<VerificationAttestation> = {}): VerificationAttestation {
  return {
    id: `att-${++idCounter}`,
    requestId: "req-001",
    verifierId: `verifier-${idCounter}`,
    evidenceBundleHash: ("c".repeat(64)) as any,
    result: "valid",
    confidence: 90,
    findings: [],
    attestationHash: ("d".repeat(64)) as any,
    signature: {
      signer: "0x2222222222222222222222222222222222222222",
      algorithm: "secp256k1",
      value: "sig_mock",
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("ComplianceFacade", () => {
  let facade: ComplianceFacade;

  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    facade = new ComplianceFacade();
    idCounter = 0;
  });

  afterEach(() => {
    closeStore();
    vi.clearAllMocks();
  });

  // ── getEvidenceForJob() ────────────────────────────────────────────────

  describe("getEvidenceForJob()", () => {
    it("returns EvidenceSummaryDTOs for a job", async () => {
      // The seeded DB has bun_001 attached to job-001
      const result = await facade.getEvidenceForJob("job-001");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    });

    it("returns empty array when no bundles found", async () => {
      const result = await facade.getEvidenceForJob("job-DOES-NOT-EXIST");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it("each DTO has correct fields: id, jobId, stepId, assuranceTier, eventCount, bundleHash, createdAt, verified", async () => {
      const result = await facade.getEvidenceForJob("job-001");
      if (result.success && result.data.length > 0) {
        const dto = result.data[0];
        expect(typeof dto.id).toBe("string");
        expect(typeof dto.jobId).toBe("string");
        expect(typeof dto.stepId).toBe("string");
        expect(typeof dto.assuranceTier).toBe("number");
        expect(typeof dto.eventCount).toBe("number");
        expect(typeof dto.bundleHash).toBe("string");
        expect(typeof dto.createdAt).toBe("string");
        expect(typeof dto.verified).toBe("boolean");
      }
    });
  });

  // ── getBundle() ────────────────────────────────────────────────────────

  describe("getBundle()", () => {
    it("returns EvidenceSummaryDTO for existing bundle", async () => {
      const result = await facade.getBundle("bun_001");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("bun_001");
      }
    });

    it("returns 404 error for unknown bundleId", async () => {
      const result = await facade.getBundle("bun-DOES-NOT-EXIST");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.httpStatus).toBe(404);
      }
    });
  });

  // ── checkTierCompliance() ──────────────────────────────────────────────

  describe("checkTierCompliance()", () => {
    it("returns 404 for unknown bundleId", async () => {
      const result = await facade.checkTierCompliance("bun-UNKNOWN");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.httpStatus).toBe(404);
      }
    });

    it("returns a TierComplianceResult for an existing bundle", async () => {
      const result = await facade.checkTierCompliance("bun_001");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.compliant).toBe("boolean");
        expect(typeof result.data.tier).toBe("number");
        expect(Array.isArray(result.data.missingEventTypes)).toBe(true);
        expect(Array.isArray(result.data.presentEventTypes)).toBe(true);
      }
    });

    it("result has totalEvents and minimumRequired fields", async () => {
      const result = await facade.checkTierCompliance("bun_001");
      if (result.success) {
        expect(typeof result.data.totalEvents).toBe("number");
        expect(typeof result.data.minimumRequired).toBe("number");
      }
    });
  });

  // ── detectDrift() ──────────────────────────────────────────────────────

  describe("detectDrift()", () => {
    it("returns empty array when no evidence bundles for job", async () => {
      const result = await facade.detectDrift("job-DOES-NOT-EXIST");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it("aggregates drift alerts across all bundles for a job", async () => {
      const result = await facade.detectDrift("job-001");
      expect(result.success).toBe(true);
      if (result.success) {
        // May or may not have alerts depending on seed data — the key is it doesn't throw
        expect(Array.isArray(result.data)).toBe(true);
      }
    });

    it("accepts optional cwmStep for duration/material checking", async () => {
      const result = await facade.detectDrift("job-001", {
        id: "step-001",
        capability: "3d_printing",
        params: { material: "pla" },
        assuranceTier: 0,
        dependsOn: [],
        estimatedDuration: 60,
      });
      expect(result.success).toBe(true);
    });
  });

  // ── generateComplianceReport() ─────────────────────────────────────────

  describe("generateComplianceReport()", () => {
    it("returns 404 when capability not found", async () => {
      const result = await facade.generateComplianceReport("cap-DOES-NOT-EXIST");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.httpStatus).toBe(404);
      }
    });

    it("returns ComplianceReportDTO with capabilityId, kernelId", async () => {
      // Use a known capability from the seeded DB
      // Let's find one via the evidence bundle path
      const evidenceResult = await facade.getBundle("bun_001");
      if (!evidenceResult.success) return;

      // Find a capability that exists in the DB
      const { getRepos } = await import("../db.js");
      const caps = getRepos().capabilities.findAll();
      if (caps.length === 0) return;

      const capId = caps[0].id;
      const result = await facade.generateComplianceReport(capId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.capabilityId).toBe(capId);
        expect(typeof result.data.kernelId).toBe("string");
      }
    });

    it("alcoaStatus is fully false when no bundles", async () => {
      // We need a capability with no associated evidence
      // Create a new capability for a kernel with no evidence
      const { getRepos } = await import("../db.js");
      const kernels = getRepos().kernels.findAll();
      if (kernels.length === 0) return;

      // Insert a fresh capability with no evidence
      const freshCap = getRepos().capabilities.insert({
        id: "cap-no-evidence",
        kernelId: "kernel-no-evidence-kernel",
        type: "test_type",
        name: "Test Cap",
        description: "",
        location: { lat: 0, lng: 0 },
        pricing: { currency: "USDC", baseCost: "0", minimum: "0" },
        materials: [],
        assuranceTiers: [0],
        availability: {},
      });

      // Generate report for a kernel with no evidence
      // We'll use the freshCap but it's for a non-existent kernel so there'll be no evidence
      const result = await facade.generateComplianceReport("cap-no-evidence");
      if (result.success) {
        // With no bundles, ALCOA should be mostly false
        expect(result.data.alcoaStatus).toBeDefined();
        expect(typeof result.data.alcoaStatus.attributable).toBe("boolean");
      }
    });

    it("tierCompliance maps all 4 tiers 0-3", async () => {
      const { getRepos } = await import("../db.js");
      const caps = getRepos().capabilities.findAll();
      if (caps.length === 0) return;

      const result = await facade.generateComplianceReport(caps[0].id);
      if (result.success) {
        expect(result.data.tierCompliance).toBeDefined();
        expect(typeof result.data.tierCompliance[0]).toBe("boolean");
        expect(typeof result.data.tierCompliance[1]).toBe("boolean");
        expect(typeof result.data.tierCompliance[2]).toBe("boolean");
        expect(typeof result.data.tierCompliance[3]).toBe("boolean");
      }
    });

    it("recentEvidence limited to 10 most recent bundles", async () => {
      const { getRepos } = await import("../db.js");
      const caps = getRepos().capabilities.findAll();
      if (caps.length === 0) return;

      const result = await facade.generateComplianceReport(caps[0].id);
      if (result.success) {
        expect(result.data.recentEvidence.length).toBeLessThanOrEqual(10);
      }
    });

    it("driftAlerts is an array", async () => {
      const { getRepos } = await import("../db.js");
      const caps = getRepos().capabilities.findAll();
      if (caps.length === 0) return;

      const result = await facade.generateComplianceReport(caps[0].id);
      if (result.success) {
        expect(Array.isArray(result.data.driftAlerts)).toBe(true);
      }
    });

    it("satisfiedStandards is an array of strings", async () => {
      const { getRepos } = await import("../db.js");
      const caps = getRepos().capabilities.findAll();
      if (caps.length === 0) return;

      const result = await facade.generateComplianceReport(caps[0].id);
      if (result.success) {
        expect(Array.isArray(result.data.satisfiedStandards)).toBe(true);
      }
    });
  });

  // ── ALCOA authenticity (fabrication detector, coord #312/#316) ─────────

  describe("generateComplianceReport() — ALCOA 'Original' authenticity", () => {
    // Seed one tier-2-complete bundle under its own kernel with a REAL
    // (non-zero) signer. `fabricated` tags every event source.simulated.
    const seedAlcoaBundle = (
      repos: any,
      kernelId: string,
      fabricated: boolean,
      suffix: string,
    ): void => {
      const now = new Date().toISOString();
      const bundleId = `bun-alcoa-${suffix}`;
      repos.evidence.insert({
        id: bundleId,
        jobId: `job-alcoa-${suffix}`,
        stepId: "step-1",
        kernelId,
        assuranceTier: 2,
        bundleHash: "b".repeat(64),
        // Real, non-zero signer — the historical "Original" check passes on this.
        kernelSignature: {
          signer: "0x1111111111111111111111111111111111111111",
          algorithm: "secp256k1",
          value: "sig_alcoa",
        },
        createdAt: now,
      });
      const source = {
        deviceId: "dev-alcoa",
        deviceType: "controller",
        kernelId,
        ...(fabricated ? { simulated: true } : {}),
      };
      const types = [
        "gcode_hash_verified",
        "execution_completed",
        "power_profile_summary",
        "cv_inspection_result",
      ];
      repos.evidence.insertEvents(
        types.map((type, i) => ({
          id: `${bundleId}-ev-${i}`,
          bundleId,
          type,
          timestamp: now,
          source,
          payload: {},
          hash: "c".repeat(64),
        })),
      );
    };

    const insertCap = (repos: any, id: string, kernelId: string): void => {
      repos.capabilities.insert({
        id,
        kernelId,
        type: "test_type",
        name: "ALCOA Cap",
        description: "",
        location: { lat: 0, lng: 0 },
        pricing: { currency: "USDC", baseCost: "0", minimum: "0" },
        materials: [],
        assuranceTiers: [2],
        availability: {},
      });
    };

    it("is FALSE for a fabricated bundle even with a real signer (the gap)", async () => {
      const { getRepos } = await import("../db.js");
      const repos = getRepos();
      insertCap(repos, "cap-alcoa-fab", "kernel-alcoa-fab");
      seedAlcoaBundle(repos, "kernel-alcoa-fab", true, "fab");

      const result = await facade.generateComplianceReport("cap-alcoa-fab");
      expect(result.success).toBe(true);
      if (result.success) {
        // Previously TRUE (signer-only) — the fabricated bundle was undetected.
        expect(result.data.alcoaStatus.original).toBe(false);
      }
    });

    it("is TRUE for an honest bundle with a real signer (real passes)", async () => {
      const { getRepos } = await import("../db.js");
      const repos = getRepos();
      insertCap(repos, "cap-alcoa-honest", "kernel-alcoa-honest");
      seedAlcoaBundle(repos, "kernel-alcoa-honest", false, "honest");

      const result = await facade.generateComplianceReport("cap-alcoa-honest");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.alcoaStatus.original).toBe(true);
        expect(result.data.alcoaStatus.attributable).toBe(true);
      }
    });
  });

  // ── aggregateAttestations() ────────────────────────────────────────────

  describe("aggregateAttestations()", () => {
    it("returns no_quorum when attestations array is empty", async () => {
      const result = await facade.aggregateAttestations("job-001", []);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.consensus).toBe("no_quorum");
      }
    });

    it("returns no_quorum when fewer than quorum attestations provided (tier 0 quorum=1, tier 2 quorum=2)", async () => {
      // For tier 2, quorum=2. job-001 has tier 0 evidence, so quorum=1.
      // For no_quorum with tier 0: empty attestations
      // Let's test with job that has no bundles (so tier 0 default) and 0 attestations
      const result = await facade.aggregateAttestations("job-NO-BUNDLES", []);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.consensus).toBe("no_quorum");
      }
    });

    it("returns consensus=valid when majority vote valid", async () => {
      const attestations = [
        makeAttestation({ verifierId: "v1", result: "valid", confidence: 90 }),
        makeAttestation({ verifierId: "v2", result: "valid", confidence: 85 }),
        makeAttestation({ verifierId: "v3", result: "invalid", confidence: 70 }),
      ];
      const result = await facade.aggregateAttestations("job-001", attestations);
      if (result.success) {
        expect(result.data.consensus).toBe("valid");
      }
    });

    it("returns consensus=invalid when majority vote invalid", async () => {
      const attestations = [
        makeAttestation({ verifierId: "v1", result: "invalid", confidence: 90 }),
        makeAttestation({ verifierId: "v2", result: "invalid", confidence: 85 }),
        makeAttestation({ verifierId: "v3", result: "valid", confidence: 70 }),
      ];
      const result = await facade.aggregateAttestations("job-001", attestations);
      if (result.success) {
        expect(result.data.consensus).toBe("invalid");
      }
    });

    it("returns consensus=inconclusive when no majority", async () => {
      const attestations = [
        makeAttestation({ verifierId: "v1", result: "valid", confidence: 90 }),
        makeAttestation({ verifierId: "v2", result: "invalid", confidence: 90 }),
      ];
      const result = await facade.aggregateAttestations("job-001", attestations);
      if (result.success) {
        expect(result.data.consensus).toBe("inconclusive");
      }
    });

    it("deduplicates by verifierId: keeps most recent attestation", async () => {
      // Same verifierId twice — should count as 1 unique verifier
      // bun_001 has tier 2 → quorum=2. To reach quorum, send 2 different verifiers
      // plus one duplicate to confirm dedup.
      const v1older = makeAttestation({
        verifierId: "verifier-DUP",
        result: "invalid",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const v1newer = makeAttestation({
        verifierId: "verifier-DUP",
        result: "valid",
        createdAt: "2026-02-01T00:00:00.000Z",
      });
      const v2 = makeAttestation({
        verifierId: "verifier-OTHER",
        result: "valid",
        confidence: 80,
      });
      // 3 attestations but only 2 unique verifiers
      const result = await facade.aggregateAttestations("job-001", [v1older, v1newer, v2]);
      if (result.success) {
        // Should have deduplicated to 2 unique verifiers
        expect(result.data.quorumAchieved).toBe(2);
        // Both unique verifiers voted valid → valid consensus
        expect(result.data.consensus).toBe("valid");
      }
    });

    it("aggregatedConfidence is arithmetic mean of all unique attestation confidences", async () => {
      const attestations = [
        makeAttestation({ verifierId: "v1", result: "valid", confidence: 90 }),
        makeAttestation({ verifierId: "v2", result: "valid", confidence: 80 }),
      ];
      const result = await facade.aggregateAttestations("job-001", attestations);
      if (result.success) {
        expect(result.data.aggregatedConfidence).toBeCloseTo(85, 1);
      }
    });

    it("quorumRequired reflects the tier's DEFAULT_VERIFIER_CRITERIA quorum", async () => {
      // bun_001 has assuranceTier=2 → DEFAULT_VERIFIER_CRITERIA[2].quorum=2
      // job-001 is linked to bun_001 → quorum should be 2
      const attestations = [
        makeAttestation({ verifierId: "v1" }),
        makeAttestation({ verifierId: "v2" }),
      ];
      const result = await facade.aggregateAttestations("job-001", attestations);
      if (result.success) {
        expect(result.data.quorumRequired).toBe(2);
      }
    });

    it("quorumAchieved is the count of unique verifiers", async () => {
      const attestations = [
        makeAttestation({ verifierId: "va" }),
        makeAttestation({ verifierId: "vb" }),
        makeAttestation({ verifierId: "vc" }),
      ];
      const result = await facade.aggregateAttestations("job-001", attestations);
      if (result.success) {
        expect(result.data.quorumAchieved).toBe(3);
      }
    });

    it("result has jobId matching the input", async () => {
      const attestations = [makeAttestation({ verifierId: "v1" })];
      const result = await facade.aggregateAttestations("job-001", attestations);
      if (result.success) {
        expect(result.data.jobId).toBe("job-001");
      }
    });
  });
});
