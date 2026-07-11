/**
 * Tests for the paid job flow — end-to-end wiring from discovery through settlement.
 *
 * Flow: DHT discovery -> negotiation -> escrow -> scope -> execution -> evidence -> settlement
 *
 * ALL external calls (IPFS, blockchain) are mocked. No real network traffic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { ot2RelayRoutes } from "../routes/ot2-relay.js";
import { ot2ScopeRoutes } from "../routes/ot2-scope.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest123", metadataCid: "bafymeta456" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc789", metadataCid: "bafyencmeta012" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xtest_evidence_tx", status: "submitted" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xtest_release_tx", status: "submitted" }),
  isWriteEnabled: vi.fn().mockReturnValue(false),
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
}));

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "epoch-1", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

// The PUT /api/jobs/:jobId/complete flow does best-effort IPFS archive +
// Starknet anchor + oracle verification I/O (all mock/fallback here) that can
// exceed vitest's 5s default on constrained/CI machines. Give the suite headroom
// so these I/O-heavy paths don't flake on timing.
vi.setConfig({ testTimeout: 20000 });

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  // Enable mock settlement for testing
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(ot2RelayRoutes);
  await app.register(ot2ScopeRoutes);
  await app.register(jobRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Paid Job Flow", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/jobs/submit-from-discovery
  // ═══════════════════════════════════════════════════════════════════════

  describe("POST /api/jobs/submit-from-discovery", () => {
    it("creates a fast-track job with all pieces wired", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          parameters: { volume: 100, tipType: "p300" },
          paymentMethod: "testnet-mock",
          userAgentId: "user-agent-001",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();

      // All pieces present
      expect(body.sessionId).toBeDefined();
      expect(body.jobId).toBeDefined();
      expect(body.scopeId).toBeDefined();
      expect(body.escrowId).toBeDefined();
      expect(body.escrowAddress).toBeDefined();
      expect(body.escrowStatus).toBe("funded");
      expect(body.quote).toBeDefined();
      expect(body.contractTerms).toBeDefined();
      expect(body.message).toContain("Fast-track job created");
    });

    it("rejects when required fields are missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          // missing capabilityType and userAgentId
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain("required");
    });

    it("creates a job in 'queued' status (mock settlement, control-plane gateway)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: "user-agent-001",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();

      // SEAM-1: this test app registers no local KernelService, so the gateway is
      // control-plane only — createJobFromSession routes a fresh job to "queued"
      // for a remote operator daemon (which polls status=queued) to pick up. This
      // is the production topology (capability.network holds no local kernel). A
      // gateway WITH a matching local kernel would mark it "active". Either way the
      // escrow is funded — the money-path assertion below is unchanged.
      const repos = getRepos();
      const job = repos.jobs.findById(body.jobId);
      expect(job).toBeDefined();
      expect(job!.status).toBe("queued");
    });

    it("creates an escrow in 'funded' status (mock settlement)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: "user-agent-001",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();

      // Verify escrow in DB
      const repos = getRepos();
      const escrow = repos.escrows.findById(body.escrowId);
      expect(escrow).toBeDefined();
      expect(escrow!.status).toBe("funded");
    });

    it("creates an active execution scope tied to the job", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: "user-agent-001",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();

      // Verify scope in DB
      const scopeRes = await app.inject({
        method: "GET",
        url: `/api/ot2/scope/${body.scopeId}`,
      });

      expect(scopeRes.statusCode).toBe(200);
      const scope = scopeRes.json();
      expect(scope.status).toBe("active");
      expect(scope.jobId).toBe(body.jobId);
      expect(scope.kernelId).toBe("kernel-nyc");
      expect(Array.isArray(scope.allowedTools)).toBe(true);
      expect(scope.allowedTools.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Negotiation commit -> paid job wiring
  // ═══════════════════════════════════════════════════════════════════════

  describe("Negotiation COMMITTED -> Job + Escrow + Scope", () => {
    it("creates job, escrow, and scope when session is committed", async () => {
      // Step 1: Create session
      const createRes = await app.inject({
        method: "POST",
        url: "/api/negotiate/session",
        payload: {
          userAgentId: "user-agent-002",
          // negotiation now gates on the kernel actually offering the capability
          // type (checkKernelOffersCapability → 404 otherwise). kernel-nyc offers
          // fdm/laser-cut, not liquid-handler; kernel-nanoclaw is the seeded
          // liquid-handler kernel, so it clears the gate.
          kernelId: "kernel-nanoclaw",
          capabilityType: "liquid-handler",
        },
      });
      expect(createRes.statusCode).toBe(200);
      const { session } = createRes.json();
      const sessionId = session.id;

      // Step 2: Compute quote
      const quoteRes = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/quote`,
      });
      expect(quoteRes.statusCode).toBe(200);

      // Step 3: Generate contract terms (review)
      const reviewRes = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/review`,
      });
      expect(reviewRes.statusCode).toBe(200);

      // Step 4: Commit
      const commitRes = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/commit`,
      });
      expect(commitRes.statusCode).toBe(200);
      const commitBody = commitRes.json();

      // Verify all pieces were created
      expect(commitBody.jobId).toBeDefined();
      expect(commitBody.scopeId).toBeDefined();
      expect(commitBody.escrowId).toBeDefined();
      expect(commitBody.escrowAddress).toBeDefined();
      expect(commitBody.escrowStatus).toBe("funded");
      expect(commitBody.message).toContain("escrow");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PUT /api/jobs/:jobId/complete
  // ═══════════════════════════════════════════════════════════════════════

  describe("PUT /api/jobs/:jobId/complete", () => {
    it("completes a job and settles (mock settlement)", async () => {
      // First create a job via fast-track
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: "user-agent-003",
        },
      });
      const { jobId, scopeId } = createRes.json();

      // Simulate some tool calls under the scope
      await app.inject({
        method: "POST",
        url: "/api/ot2/tool-call",
        payload: {
          kernelId: "kernel-nyc",
          scopeId,
          toolName: "ot2_aspirate",
          args: { volume: 100, well: "A1" },
        },
      });

      // Complete the job
      const completeRes = await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {
          evidenceEvents: [
            { type: "photo_captured", payload: { frameId: "frame-001" } },
          ],
        },
      });

      expect(completeRes.statusCode).toBe(200);
      const body = completeRes.json();

      expect(body.jobId).toBe(jobId);
      expect(body.status).toBe("settled");
      expect(body.evidenceBundleId).toBeDefined();
      expect(body.evidenceHash).toMatch(/^sha256:/);
      expect(body.settledAt).toBeDefined();
      expect(body.toolCallsRecorded).toBeGreaterThanOrEqual(1);
      expect(body.message).toContain("settled");
    });

    it("returns 404 for unknown job", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/jobs/nonexistent-job/complete",
        payload: {},
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 409 for already completed job", async () => {
      // Create and complete a job
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: "user-agent-004",
        },
      });
      const { jobId } = createRes.json();

      // Complete once
      await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {},
      });

      // Try to complete again
      const res = await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {},
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toContain("already completed");
    });

    it("leaves execution scopes active after completion (revoked at expiry, not on complete)", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: "user-agent-005",
        },
      });
      const { jobId, scopeId } = createRes.json();

      // Complete the job
      await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {},
      });

      // Deliberate (paid-job-flow.ts §"Execution scopes — left active"): scopes
      // are NOT revoked on job completion; they stay active for follow-up tool
      // calls (camera, diagnostics) until their 1h expiry. completeBody would
      // report scopesRevoked === 0 accordingly.
      const scopeRes = await app.inject({
        method: "GET",
        url: `/api/ot2/scope/${scopeId}`,
      });

      expect(scopeRes.statusCode).toBe(200);
      const scope = scopeRes.json();
      expect(scope.status).toBe("active");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/jobs/:jobId/settlement
  // ═══════════════════════════════════════════════════════════════════════

  describe("GET /api/jobs/:jobId/settlement", () => {
    it("returns settlement status for a pending job", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: "user-agent-006",
        },
      });
      const { jobId } = createRes.json();

      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}/settlement`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.jobId).toBe(jobId);
      expect(body.status).toBeDefined();
      expect(body.escrowAddress).toBeDefined();
      expect(body.currency).toBe("USDC");
      expect(body.milestones).toBeDefined();
      expect(Array.isArray(body.milestones)).toBe(true);
      expect(body.session).toBeDefined();
    });

    it("returns settled status after job completion", async () => {
      // Create and complete
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: "user-agent-007",
        },
      });
      const { jobId } = createRes.json();

      await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {},
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}/settlement`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.status).toBe("settled");
      expect(body.evidenceHash).toBeDefined();
      expect(body.evidenceBundleId).toBeDefined();
    });

    it("returns 404 for unknown job", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/jobs/nonexistent-job/settlement",
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Escrow verification in tool relay
  // ═══════════════════════════════════════════════════════════════════════

  describe("Escrow verification on tool calls", () => {
    it("allows tool calls when escrow is funded", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: "user-agent-008",
        },
      });
      const { scopeId } = createRes.json();

      // Tool call should succeed — escrow is mock-funded
      const toolRes = await app.inject({
        method: "POST",
        url: "/api/ot2/tool-call",
        payload: {
          kernelId: "kernel-nyc",
          scopeId,
          toolName: "ot2_aspirate",
          args: { volume: 50 },
        },
      });

      expect(toolRes.statusCode).toBe(201);
    });

    it("allows safe tools regardless of escrow status", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          userAgentId: "user-agent-009",
        },
      });
      const { scopeId } = createRes.json();

      // Safe tool (ot2_health) should always work
      const toolRes = await app.inject({
        method: "POST",
        url: "/api/ot2/tool-call",
        payload: {
          kernelId: "kernel-nyc",
          scopeId,
          toolName: "ot2_health",
          args: {},
        },
      });

      expect(toolRes.statusCode).toBe(201);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Full end-to-end flow
  // ═══════════════════════════════════════════════════════════════════════

  describe("Full end-to-end: discovery -> negotiation -> execution -> settlement", () => {
    it("completes the entire paid job lifecycle", async () => {
      // ── Step 1: Submit from discovery (fast-track) ─────────────────
      const submitRes = await app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        payload: {
          kernelId: "kernel-nyc",
          capabilityType: "liquid-handler",
          parameters: { protocol: "pcr-prep", volume: 50 },
          paymentMethod: "testnet-mock",
          userAgentId: "user-agent-e2e",
        },
      });

      expect(submitRes.statusCode).toBe(201);
      const { jobId, scopeId, escrowId, escrowStatus } = submitRes.json();
      expect(escrowStatus).toBe("funded");

      // ── Step 2: Execute tool calls under scope ─────────────────────
      const call1 = await app.inject({
        method: "POST",
        url: "/api/ot2/tool-call",
        payload: {
          kernelId: "kernel-nyc",
          scopeId,
          toolName: "ot2_aspirate",
          args: { volume: 50, well: "A1" },
        },
      });
      expect(call1.statusCode).toBe(201);

      const call2 = await app.inject({
        method: "POST",
        url: "/api/ot2/tool-call",
        payload: {
          kernelId: "kernel-nyc",
          scopeId,
          toolName: "ot2_dispense",
          args: { volume: 50, well: "B1" },
        },
      });
      expect(call2.statusCode).toBe(201);

      // ── Step 3: Complete the job ───────────────────────────────────
      const completeRes = await app.inject({
        method: "PUT",
        url: `/api/jobs/${jobId}/complete`,
        payload: {
          evidenceEvents: [
            { type: "photo_captured", payload: { note: "post-dispense photo" } },
          ],
        },
      });

      expect(completeRes.statusCode).toBe(200);
      const completeBody = completeRes.json();
      expect(completeBody.status).toBe("settled");
      expect(completeBody.toolCallsRecorded).toBe(2);
      expect(completeBody.evidenceHash).toMatch(/^sha256:/);
      expect(completeBody.scopesRevoked).toBe(0);

      // ── Step 4: Verify settlement status ───────────────────────────
      const settlementRes = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}/settlement`,
      });

      expect(settlementRes.statusCode).toBe(200);
      const settlement = settlementRes.json();
      expect(settlement.status).toBe("settled");
      expect(settlement.evidenceHash).toBeDefined();
      expect(settlement.milestones.length).toBeGreaterThan(0);
      expect(settlement.milestones[0].status).toBe("released");
      expect(settlement.currency).toBe("USDC");

      // ── Step 5: Scope stays active post-completion (revoked at expiry) ──
      // completeBody.scopesRevoked === 0 above already asserts none were revoked.
      const scopeRes = await app.inject({
        method: "GET",
        url: `/api/ot2/scope/${scopeId}`,
      });
      expect(scopeRes.statusCode).toBe(200);
      expect(scopeRes.json().status).toBe("active");

      // ── Step 6: Verify job in jobs list ────────────────────────────
      const jobRes = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}`,
      });
      expect(jobRes.statusCode).toBe(200);
      const jobBody = jobRes.json();
      expect(jobBody.job.status).toBe("settled");
      // GET /api/jobs/:jobId returns { job, evidence } — the route lifts the
      // detail DTO's evidenceBundles out to a top-level `evidence` array (not a
      // scalar job.evidenceBundleId). Completion persisted a bundle, so it is
      // non-empty.
      expect(jobBody.evidence.length).toBeGreaterThan(0);
    });
  });
});
