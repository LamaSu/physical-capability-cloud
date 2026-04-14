/**
 * Tests for compliance routes.
 *
 * Strategy: mock ComplianceFacade at the module level, then spin up a
 * minimal Fastify instance with only the complianceRoutes plugin registered.
 * This isolates route logic from DB/OTel/auth middleware.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { complianceRoutes } from "../routes/compliance.js";

// ── Fixture data ───────────────────────────────────────────────────────────────

const CAPABILITY_ID = "cap_test_001";
const JOB_ID = "job_test_001";
const BUNDLE_ID = "bundle_test_001";

const mockComplianceReport = {
  capabilityId: CAPABILITY_ID,
  kernelId: "kernel_test_001",
  satisfiedStandards: ["ISO-9001:8.5.1", "FDA-21CFR-Part11"],
  alcoaStatus: {
    attributable: true,
    legible: true,
    contemporaneous: true,
    original: true,
    accurate: true,
    consistent: true,
    complete: true,
    credible: true,
    enduring: false,
    available: true,
  },
  tierCompliance: { 0: true, 1: true, 2: false, 3: false },
  recentEvidence: [],
  driftAlerts: [],
};

const mockDriftAlerts = [
  {
    type: "power_anomaly" as const,
    severity: "medium" as const,
    message: "Power draw 15% above expected",
    expectedValue: "5.0W",
    actualValue: "5.75W",
    timestamp: "2026-04-03T10:00:00Z",
  },
];

const mockEvidenceList = [
  {
    id: BUNDLE_ID,
    jobId: JOB_ID,
    stepId: "step_001",
    assuranceTier: 1,
    eventCount: 12,
    bundleHash: "a".repeat(64),
    createdAt: "2026-04-03T09:00:00Z",
    verified: true,
    storageCid: "bafybeiczsscdsbs7aaqz55asqdf3smv6klcw3gofszvwlyarci47bgf354",
  },
];

const mockBundle = mockEvidenceList[0];

const mockTierCompliance = {
  tier: 1,
  compliant: true,
  missingEventTypes: [],
  presentEventTypes: ["execution_started", "execution_completed"],
  totalEvents: 12,
  minimumRequired: 3,
};

const mockAggregatedAttestation = {
  jobId: JOB_ID,
  attestations: [
    {
      verifierId: "verifier_001",
      result: "valid" as const,
      confidence: 95,
      timestamp: "2026-04-03T10:01:00Z",
    },
  ],
  consensus: "valid" as const,
  quorumRequired: 1,
  quorumAchieved: 1,
  aggregatedConfidence: 0.95,
};

// ── Mock getComplianceFacade ───────────────────────────────────────────────────
//
// We mock the entire facades/index.js module so that getComplianceFacade()
// returns a controlled object whose methods can be swapped per-test via vi.fn().

const mockFacade = {
  generateComplianceReport: vi.fn(),
  detectDrift: vi.fn(),
  getEvidenceForJob: vi.fn(),
  getBundle: vi.fn(),
  checkTierCompliance: vi.fn(),
  aggregateAttestations: vi.fn(),
};

vi.mock("../facades/index.js", () => ({
  getComplianceFacade: () => mockFacade,
}));

// ── Mock getRepos ──────────────────────────────────────────────────────────────
//
// POST /api/jobs/:jobId/attestations/aggregate checks job + kernel ownership
// before delegating to the facade (R3-03 security hardening).
// We mock repos so the auth check finds the job and matches the caller.

const mockJobsRepo = {
  findById: vi.fn(),
};
const mockKernelsRepo = {
  findById: vi.fn(),
};

vi.mock("../db.js", () => ({
  getRepos: () => ({
    jobs: mockJobsRepo,
    kernels: mockKernelsRepo,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok<T>(data: T) {
  return { success: true as const, data };
}

function notFound(entity: string, id: string) {
  return {
    success: false as const,
    error: {
      code: "COMPLIANCE_NOT_FOUND",
      message: `${entity} '${id}' not found`,
      httpStatus: 404,
    },
  };
}

/**
 * Build an app without injected auth — used by the public read routes.
 */
async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(complianceRoutes);
  return app;
}

/**
 * Build an app with an injected authenticated operator — used by the
 * POST /api/jobs/:jobId/attestations/aggregate tests because that route
 * now requires auth + job ownership.
 */
async function buildAuthedApp(operatorId = "op-submitter") {
  const app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.addHook("onRequest", async (req) => {
    (req as unknown as { operatorId: string }).operatorId = operatorId;
  });
  await app.register(complianceRoutes);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("complianceRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /api/capabilities/:capabilityId/compliance ────────────────────────

  describe("GET /api/capabilities/:capabilityId/compliance", () => {
    it("returns ComplianceReportDTO shape on success", async () => {
      mockFacade.generateComplianceReport.mockResolvedValue(ok(mockComplianceReport));
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/api/capabilities/${CAPABILITY_ID}/compliance`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.capabilityId).toBe(CAPABILITY_ID);
      expect(body.kernelId).toBe("kernel_test_001");
      expect(Array.isArray(body.satisfiedStandards)).toBe(true);
      expect(body.alcoaStatus).toBeDefined();
      expect(body.tierCompliance).toBeDefined();
      expect(Array.isArray(body.recentEvidence)).toBe(true);
      expect(Array.isArray(body.driftAlerts)).toBe(true);
    });

    it("delegates to facade.generateComplianceReport with the correct capabilityId", async () => {
      mockFacade.generateComplianceReport.mockResolvedValue(ok(mockComplianceReport));
      const app = await buildApp();

      await app.inject({
        method: "GET",
        url: `/api/capabilities/${CAPABILITY_ID}/compliance`,
      });

      expect(mockFacade.generateComplianceReport).toHaveBeenCalledOnce();
      expect(mockFacade.generateComplianceReport).toHaveBeenCalledWith(CAPABILITY_ID);
    });

    it("returns 404 when capability is not found", async () => {
      mockFacade.generateComplianceReport.mockResolvedValue(
        notFound("capability", "cap_unknown"),
      );
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: "/api/capabilities/cap_unknown/compliance",
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe("COMPLIANCE_NOT_FOUND");
      expect(body.message).toMatch("cap_unknown");
    });
  });

  // ── GET /api/jobs/:jobId/drift-alerts ─────────────────────────────────────

  describe("GET /api/jobs/:jobId/drift-alerts", () => {
    it("returns DriftAlertDTO[] on success", async () => {
      mockFacade.detectDrift.mockResolvedValue(ok(mockDriftAlerts));
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${JOB_ID}/drift-alerts`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].type).toBe("power_anomaly");
      expect(body[0].severity).toBe("medium");
    });

    it("delegates to facade.detectDrift with the correct jobId", async () => {
      mockFacade.detectDrift.mockResolvedValue(ok(mockDriftAlerts));
      const app = await buildApp();

      await app.inject({
        method: "GET",
        url: `/api/jobs/${JOB_ID}/drift-alerts`,
      });

      expect(mockFacade.detectDrift).toHaveBeenCalledOnce();
      expect(mockFacade.detectDrift).toHaveBeenCalledWith(JOB_ID);
    });

    it("returns empty array when no drift is detected", async () => {
      mockFacade.detectDrift.mockResolvedValue(ok([]));
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${JOB_ID}/drift-alerts`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("returns 404 for unknown job", async () => {
      mockFacade.detectDrift.mockResolvedValue(notFound("job", "job_unknown"));
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: "/api/jobs/job_unknown/drift-alerts",
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── GET /api/jobs/:jobId/evidence ─────────────────────────────────────────

  describe("GET /api/jobs/:jobId/evidence", () => {
    it("returns EvidenceSummaryDTO[] for a job", async () => {
      mockFacade.getEvidenceForJob.mockResolvedValue(ok(mockEvidenceList));
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${JOB_ID}/evidence`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].id).toBe(BUNDLE_ID);
      expect(body[0].jobId).toBe(JOB_ID);
      expect(typeof body[0].eventCount).toBe("number");
    });

    it("delegates to facade.getEvidenceForJob with the correct jobId", async () => {
      mockFacade.getEvidenceForJob.mockResolvedValue(ok(mockEvidenceList));
      const app = await buildApp();

      await app.inject({
        method: "GET",
        url: `/api/jobs/${JOB_ID}/evidence`,
      });

      expect(mockFacade.getEvidenceForJob).toHaveBeenCalledOnce();
      expect(mockFacade.getEvidenceForJob).toHaveBeenCalledWith(JOB_ID);
    });
  });

  // ── GET /api/compliance/evidence/:bundleId ───────────────────────────────────────────

  describe("GET /api/compliance/evidence/:bundleId", () => {
    it("returns EvidenceSummaryDTO for a single bundle", async () => {
      mockFacade.getBundle.mockResolvedValue(ok(mockBundle));
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/api/compliance/evidence/${BUNDLE_ID}`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(BUNDLE_ID);
      expect(body.bundleHash).toHaveLength(64);
      expect(typeof body.verified).toBe("boolean");
    });

    it("delegates to facade.getBundle with the correct bundleId", async () => {
      mockFacade.getBundle.mockResolvedValue(ok(mockBundle));
      const app = await buildApp();

      await app.inject({
        method: "GET",
        url: `/api/compliance/evidence/${BUNDLE_ID}`,
      });

      expect(mockFacade.getBundle).toHaveBeenCalledOnce();
      expect(mockFacade.getBundle).toHaveBeenCalledWith(BUNDLE_ID);
    });

    it("returns 404 for unknown bundle", async () => {
      mockFacade.getBundle.mockResolvedValue(notFound("evidence bundle", "bundle_unknown"));
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: "/api/compliance/evidence/bundle_unknown",
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toMatch("bundle_unknown");
    });
  });

  // ── GET /api/compliance/evidence/:bundleId/tier-compliance ───────────────────────────

  describe("GET /api/compliance/evidence/:bundleId/tier-compliance", () => {
    it("returns TierComplianceResult for a bundle", async () => {
      mockFacade.checkTierCompliance.mockResolvedValue(ok(mockTierCompliance));
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/api/compliance/evidence/${BUNDLE_ID}/tier-compliance`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.tier).toBe("number");
      expect(typeof body.compliant).toBe("boolean");
      expect(Array.isArray(body.missingEventTypes)).toBe(true);
      expect(Array.isArray(body.presentEventTypes)).toBe(true);
      expect(typeof body.totalEvents).toBe("number");
      expect(typeof body.minimumRequired).toBe("number");
    });

    it("delegates to facade.checkTierCompliance with the correct bundleId", async () => {
      mockFacade.checkTierCompliance.mockResolvedValue(ok(mockTierCompliance));
      const app = await buildApp();

      await app.inject({
        method: "GET",
        url: `/api/compliance/evidence/${BUNDLE_ID}/tier-compliance`,
      });

      expect(mockFacade.checkTierCompliance).toHaveBeenCalledOnce();
      expect(mockFacade.checkTierCompliance).toHaveBeenCalledWith(BUNDLE_ID);
    });

    it("returns 404 for unknown bundle", async () => {
      mockFacade.checkTierCompliance.mockResolvedValue(
        notFound("evidence bundle", "bundle_unknown"),
      );
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: "/api/compliance/evidence/bundle_unknown/tier-compliance",
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── POST /api/jobs/:jobId/attestations/aggregate ──────────────────────────
  //
  // Note: this route was hardened by security commit R3-03 (April 10, 2026):
  //   - Requires an authenticated operator on req.operatorId / req.userId
  //   - Operator must be the job submitter OR the kernel operator
  // Tests therefore build an app with an injected operatorId and wire up
  // mockJobsRepo.findById() to return a job the operator owns.
  describe("POST /api/jobs/:jobId/attestations/aggregate", () => {
    const OPERATOR_ID = "op-submitter";

    beforeEach(() => {
      // Default: job exists and is owned by OPERATOR_ID (submitter path).
      mockJobsRepo.findById.mockReturnValue({
        id: JOB_ID,
        submittedBy: OPERATOR_ID,
        kernelId: "kernel_test_001",
      });
      mockKernelsRepo.findById.mockReturnValue(null);
    });

    it("returns AggregatedAttestationDTO on success", async () => {
      mockFacade.aggregateAttestations.mockResolvedValue(ok(mockAggregatedAttestation));
      const app = await buildAuthedApp(OPERATOR_ID);

      const res = await app.inject({
        method: "POST",
        url: `/api/jobs/${JOB_ID}/attestations/aggregate`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attestations: [
            {
              id: "att_001",
              requestId: "req_001",
              verifierId: "verifier_001",
              evidenceBundleHash: "b".repeat(64),
              result: "valid",
              confidence: 95,
              findings: [],
              attestationHash: "c".repeat(64),
              signature: "0xsig",
              createdAt: "2026-04-03T10:01:00Z",
            },
          ],
        }),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jobId).toBe(JOB_ID);
      expect(body.consensus).toMatch(/^(valid|invalid|inconclusive|no_quorum)$/);
      expect(typeof body.quorumRequired).toBe("number");
      expect(typeof body.quorumAchieved).toBe("number");
      expect(typeof body.aggregatedConfidence).toBe("number");
    });

    it("delegates to facade.aggregateAttestations with the correct jobId and attestation array", async () => {
      mockFacade.aggregateAttestations.mockResolvedValue(ok(mockAggregatedAttestation));
      const app = await buildAuthedApp(OPERATOR_ID);

      const attestations = [
        {
          id: "att_001",
          requestId: "req_001",
          verifierId: "verifier_001",
          evidenceBundleHash: "b".repeat(64),
          result: "valid" as const,
          confidence: 95,
          findings: [],
          attestationHash: "c".repeat(64),
          signature: "0xsig",
          createdAt: "2026-04-03T10:01:00Z",
        },
      ];

      await app.inject({
        method: "POST",
        url: `/api/jobs/${JOB_ID}/attestations/aggregate`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attestations }),
      });

      expect(mockFacade.aggregateAttestations).toHaveBeenCalledOnce();
      expect(mockFacade.aggregateAttestations).toHaveBeenCalledWith(JOB_ID, attestations);
    });

    it("handles empty attestation array (no_quorum path)", async () => {
      const noQuorumResult = {
        jobId: JOB_ID,
        attestations: [],
        consensus: "no_quorum" as const,
        quorumRequired: 1,
        quorumAchieved: 0,
        aggregatedConfidence: 0,
      };
      mockFacade.aggregateAttestations.mockResolvedValue(ok(noQuorumResult));
      const app = await buildAuthedApp(OPERATOR_ID);

      const res = await app.inject({
        method: "POST",
        url: `/api/jobs/${JOB_ID}/attestations/aggregate`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attestations: [] }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().consensus).toBe("no_quorum");
    });

    it("defaults attestations to empty array when body is missing the field", async () => {
      const noQuorumResult = {
        jobId: JOB_ID,
        attestations: [],
        consensus: "no_quorum" as const,
        quorumRequired: 1,
        quorumAchieved: 0,
        aggregatedConfidence: 0,
      };
      mockFacade.aggregateAttestations.mockResolvedValue(ok(noQuorumResult));
      const app = await buildAuthedApp(OPERATOR_ID);

      // Send body without the attestations key
      const res = await app.inject({
        method: "POST",
        url: `/api/jobs/${JOB_ID}/attestations/aggregate`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.statusCode).toBe(200);
      // The route should have passed [] to the facade
      expect(mockFacade.aggregateAttestations).toHaveBeenCalledWith(JOB_ID, []);
    });
  });
});
