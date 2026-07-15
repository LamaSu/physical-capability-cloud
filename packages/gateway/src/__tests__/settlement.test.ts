/**
 * Tests for the evidence-to-settlement flow:
 *   SettlementService.processEvidence  — store bundle, persist to DB, submit on-chain
 *   SettlementService.releaseMilestone — release escrow, update job status
 *   GET  /api/evidence/:jobId          — evidence bundle details
 *   POST /api/settlement/release       — manually release a milestone
 *   GET  /api/settlement/:jobId        — settlement status for a job
 *
 * ALL external calls (IPFS, blockchain) are mocked. No real network traffic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { settlementRoutes } from "../routes/settlement.js";
import { initStore, closeStore } from "../db.js";
import { resetSettlementService, getSettlementService } from "../services/settlement-service.js";
import { closeWorkflowStore } from "../workflow-store.js";
import type { EvidenceBundle } from "@pcc/spec";
import type { OracleAttestation } from "@pcc/contracts";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

// Mock the evidence storage factory so no real Helia / IPFS node is spun up
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({
      cid: "bafytest123",
      metadataCid: "bafymeta456",
    }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({
      cid: "bafyenc789",
      metadataCid: "bafyencmeta012",
    }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Mock the on-chain escrow client so no real blockchain calls are made
vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({
    transactionHash: "0xtest_evidence_tx123",
    status: "submitted",
  }),
  releaseMilestone: vi.fn().mockResolvedValue({
    transactionHash: "0xtest_release_tx456",
    status: "submitted",
  }),
  isWriteEnabled: vi.fn().mockReturnValue(false), // default: no private key configured
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  // Batch settlement re-exports from the same mock
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
}));

// Mock the batch-settlement module (imported by settlement routes)
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal EvidenceBundle that matches @pcc/spec's EvidenceBundle type.
 *
 * Defaults to job-004 (seeded as "completed", kernelId=kernel-nyc, NO pre-seeded evidence bundles).
 * job-001 and job-002 already have seeded evidence bundles (bun_001, bun_002) — avoid them for insert tests.
 * Use job-003 (queued, kernel-nyc, no bundles) for 404 tests.
 */
function makeBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    id: "bundle-test-001",
    jobId: "job-004",
    stepId: "step-4",
    kernelId: "kernel-nyc",
    assuranceTier: 0,
    bundleHash: "sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1" as `sha256:${string}`,
    kernelSignature: {
      signer: "0x0000000000000000000000000000000000000000" as const,
      algorithm: "secp256k1" as const,
      value: "mock_sig_test",
    },
    createdAt: new Date().toISOString(),
    events: [
      {
        id: "ev-001",
        type: "execution_started",
        timestamp: new Date().toISOString(),
        source: {
          deviceId: "dev-fdm-prusa-mk4",
          deviceType: "controller",
          kernelId: "kernel-nyc",
        },
        payload: { message: "Job started" },
        hash: "sha256:hash_ev001" as `sha256:${string}`,
      },
    ],
    ...overrides,
  };
}

/**
 * Deterministic oracle-signed attestation bound to the shared test escrow.
 * The release path now REQUIRES this (SettlementService.releaseMilestone +
 * POST /api/settlement/release both re-verify the struct on-chain via
 * PCCProtocol.collectFeeWithAttestation). Here the on-chain call is mocked,
 * so only the shape + a truthy escrowAddress (the route/service guard) matter.
 * Mirrors the fixture in settlement-telemetry.test.ts.
 */
function mkAttestation(
  escrowAddress: `0x${string}` = "0xDeAdBeEf00000000000000000000000000000001",
): OracleAttestation {
  return {
    version: 1,
    escrowAddress,
    jobId: "job-001",
    evidenceHash:
      "0xaabbcc00000000000000000000000000000000000000000000000000000000ee" as `0x${string}`,
    tier: 0,
    verified: true,
    timestamp: 1700000000n,
    nonce: ("0x" + "c".repeat(64)) as `0x${string}`,
    extraData: "0x" as `0x${string}`,
    signature: "0x" as `0x${string}`,
  };
}

/**
 * JSON-safe attestation for HTTP payloads. Over the wire `timestamp` is a
 * number (JSON has no BigInt); the route reads the struct opaquely (only
 * escrowAddress is validated) and hands it to the mocked on-chain release.
 */
function mkAttestationBody(): Record<string, unknown> {
  return { ...mkAttestation(), timestamp: 1700000000 };
}

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

/** Round-6 A4: the low-level settlement routes are gated by this internal token. */
const SETTLEMENT_TOKEN = "test-settlement-admin-token";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.SETTLEMENT_ADMIN_TOKEN = SETTLEMENT_TOKEN; // round-6 A4: arm the privileged-caller gate
  // POST /api/settlement/release routes through releaseMilestoneByJobActivity,
  // which uses the durable workflow store for on-chain-op idempotency. Give each
  // test a fresh in-memory store so release attempts across tests can't collide
  // on the same (jobId, milestone, action) idempotency key.
  process.env.WORKFLOW_DB_PATH = ":memory:";
  closeWorkflowStore();
  initStore({ seed: true });

  resetSettlementService();

  const app = Fastify({ logger: false });
  await app.register(settlementRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// SettlementService unit tests
// ---------------------------------------------------------------------------

describe("SettlementService", () => {
  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetSettlementService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeStore();
    resetSettlementService();
  });

  describe("processEvidence", () => {
    it("stores the bundle and persists to DB", async () => {
      const service = getSettlementService();
      const bundle = makeBundle();

      const result = await service.processEvidence(bundle, bundle.jobId);

      expect(result.jobId).toBe("job-004");
      expect(result.evidenceBundleId).toBe("bundle-test-001");
      // CID should come from the mocked storage
      expect(result.cid).toBe("bafytest123");
      // No error
      expect(result.error).toBeUndefined();
    });

    it("persists bundle to DB evidence repository", async () => {
      const service = getSettlementService();
      const bundle = makeBundle();

      await service.processEvidence(bundle, bundle.jobId);

      // Verify it was written to DB
      const { getRepos } = await import("../db.js");
      const repos = getRepos();
      const stored = repos.evidence.findByJob("job-004");
      expect(stored.length).toBeGreaterThan(0);
      expect(stored[0].id).toBe("bundle-test-001");
      expect(stored[0].bundleHash).toBe(bundle.bundleHash);
    });

    it("persists evidence events to DB", async () => {
      const service = getSettlementService();
      const bundle = makeBundle();

      await service.processEvidence(bundle, bundle.jobId);

      const { getRepos } = await import("../db.js");
      const repos = getRepos();
      const events = repos.evidence.findEventsByBundle("bundle-test-001");
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("execution_started");
    });

    it("skips on-chain submission when write is not enabled (graceful degradation)", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(false);

      const service = getSettlementService();
      const bundle = makeBundle();

      const result = await service.processEvidence(bundle, bundle.jobId, {
        contractAddress: "0xDeAdBeEf00000000000000000000000000000001",
      });

      // No transaction hash — write was skipped
      expect(result.evidenceTxHash).toBeUndefined();
      // Result is still valid
      expect(result.evidenceBundleId).toBe("bundle-test-001");
    });

    it("submits evidence on-chain when write is enabled and contract address is provided", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

      const service = getSettlementService();
      const bundle = makeBundle({
        bundleHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as `sha256:${string}`,
      });

      const result = await service.processEvidence(bundle, bundle.jobId, {
        contractAddress: "0xDeAdBeEf00000000000000000000000000000001",
        milestoneIndex: 0,
      });

      expect(result.evidenceTxHash).toBe("0xtest_evidence_tx123");
      expect(escrowMod.submitEvidence).toHaveBeenCalledOnce();
    });

    it("auto-releases for tier 0 when autoRelease=true and write is enabled", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

      const service = getSettlementService();
      const bundle = makeBundle({ assuranceTier: 0 });

      const result = await service.processEvidence(bundle, bundle.jobId, {
        contractAddress: "0xDeAdBeEf00000000000000000000000000000001",
        autoRelease: true,
        attestation: mkAttestation(),
      });

      expect(result.releaseTxHash).toBe("0xtest_release_tx456");
      expect(result.settled).toBe(true);
    });

    it("does not auto-release when autoRelease=false (default)", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

      const service = getSettlementService();
      const bundle = makeBundle();

      const result = await service.processEvidence(bundle, bundle.jobId, {
        contractAddress: "0xDeAdBeEf00000000000000000000000000000001",
        autoRelease: false,
      });

      expect(result.releaseTxHash).toBeUndefined();
      expect(result.settled).toBe(false);
    });

    it("handles IPFS storage failure gracefully (best-effort)", async () => {
      const storageMod = await import("@pcc/kernel/evidence-storage-factory");
      vi.mocked(storageMod.createEvidenceStorage).mockRejectedValueOnce(
        new Error("IPFS connection refused"),
      );

      const service = getSettlementService();
      const bundle = makeBundle();

      // Should not throw — storage failure is best-effort
      const result = await service.processEvidence(bundle, bundle.jobId);

      expect(result.evidenceBundleId).toBe("bundle-test-001");
      // No CID since storage failed
      expect(result.cid).toBeUndefined();
    });

    // ── Fabrication gate (detector side, coord #312/#316) ──────────────
    // Fabricated bundle: one structurally-valid event tagged both ways.
    const makeFabricatedBundle = (tier: 0 | 1 | 2) =>
      makeBundle({
        assuranceTier: tier,
        events: [
          {
            id: "ev-fab-001",
            type: "execution_completed",
            timestamp: new Date().toISOString(),
            source: {
              deviceId: "dev-mock-001",
              deviceType: "controller",
              kernelId: "kernel-nyc",
              simulated: true,
            },
            payload: { mock: true },
            hash: "sha256:fabhash" as `sha256:${string}`,
          },
        ],
      });

    it("refuses to settle a fabricated bundle at a paid tier (>=1): no on-chain submit or release", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

      const service = getSettlementService();
      const result = await service.processEvidence(makeFabricatedBundle(1), "job-004", {
        contractAddress: "0xDeAdBeEf00000000000000000000000000000001",
        autoRelease: true,
      });

      // Refused: fail-closed — no on-chain evidence submission, no release.
      expect(result.error).toBe("fabricated_evidence");
      expect(result.settled).toBe(false);
      expect(result.evidenceTxHash).toBeUndefined();
      expect(escrowMod.submitEvidence).not.toHaveBeenCalled();
      expect(escrowMod.releaseMilestone).not.toHaveBeenCalled();
    });

    it("still submits on-chain for an HONEST paid-tier bundle (real passes)", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

      const service = getSettlementService();
      const result = await service.processEvidence(
        makeBundle({
          assuranceTier: 1,
          bundleHash:
            "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as `sha256:${string}`,
        }),
        "job-004",
        { contractAddress: "0xDeAdBeEf00000000000000000000000000000001" },
      );

      expect(result.error).not.toBe("fabricated_evidence");
      expect(escrowMod.submitEvidence).toHaveBeenCalledOnce();
      expect(result.evidenceTxHash).toBe("0xtest_evidence_tx123");
    });

    it("does NOT block tier 0 (self-attested dev floor) even if fabricated", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

      const service = getSettlementService();
      const result = await service.processEvidence(makeFabricatedBundle(0), "job-004", {
        contractAddress: "0xDeAdBeEf00000000000000000000000000000001",
      });

      // The gate fires only at tier >= 1; tier 0 is unaffected.
      expect(result.error).not.toBe("fabricated_evidence");
      expect(escrowMod.submitEvidence).toHaveBeenCalledOnce();
    });
  });

  describe("releaseMilestone", () => {
    it("returns failed with write_disabled when no private key", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(false);

      const service = getSettlementService();
      const result = await service.releaseMilestone("job-001", 0, "0xDeAdBeEf00000000000000000000000000000001");

      expect(result.status).toBe("failed");
      expect(result.error).toBe("write_disabled");
    });

    it("returns failed with no_contract_address when no address configured", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);
      // Ensure env var not set
      delete process.env.ESCROW_CONTRACT_ADDRESS;

      const service = getSettlementService();
      const result = await service.releaseMilestone("job-001", 0);

      expect(result.status).toBe("failed");
      expect(result.error).toBe("no_contract_address");
    });

    it("releases milestone and returns txHash on success", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

      const service = getSettlementService();
      const result = await service.releaseMilestone(
        "job-001",
        0,
        mkAttestation(),
        "0xDeAdBeEf00000000000000000000000000000001",
      );

      expect(result.status).toBe("released");
      expect(result.txHash).toBe("0xtest_release_tx456");
      expect(result.jobId).toBe("job-001");
    });

    it("updates job status to settled in DB after release", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

      const service = getSettlementService();
      await service.releaseMilestone(
        "job-001",
        0,
        mkAttestation(),
        "0xDeAdBeEf00000000000000000000000000000001",
      );

      const { getRepos } = await import("../db.js");
      const repos = getRepos();
      const job = repos.jobs.findById("job-001");
      expect(job?.status).toBe("settled");
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP Route tests
// ---------------------------------------------------------------------------

describe("Settlement Routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    closeWorkflowStore();
    resetSettlementService();
  });

  // ── GET /api/evidence/:jobId ────────────────────────────────────────────

  describe("GET /api/evidence/:jobId", () => {
    it("returns 404 for a job with no evidence", async () => {
      // job-003 is seeded (queued) but has no evidence bundles seeded
      const res = await app.inject({
        method: "GET",
        url: "/api/evidence/job-003",
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe("SETTLEMENT_NOT_FOUND");
    });

    it("returns evidence bundle details after evidence is processed", async () => {
      // job-004 is seeded (completed, kernel-nyc) with no pre-seeded evidence bundles
      const service = getSettlementService();
      const bundle = makeBundle(); // defaults to job-004
      await service.processEvidence(bundle, "job-004");

      const res = await app.inject({
        method: "GET",
        url: "/api/evidence/job-004",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jobId).toBe("job-004");
      expect(Array.isArray(body.bundles)).toBe(true);
      expect(body.bundles.length).toBeGreaterThan(0);
      expect(body.bundles[0].bundleId).toBe("bundle-test-001");
      expect(body.bundles[0].hash).toBeDefined();
      expect(body.count).toBe(1);
    });

    it("includes event details in the response", async () => {
      const service = getSettlementService();
      const bundle = makeBundle(); // defaults to job-004
      await service.processEvidence(bundle, "job-004");

      const res = await app.inject({
        method: "GET",
        url: "/api/evidence/job-004",
      });
      const body = res.json();
      expect(body.bundles[0].eventCount).toBe(1);
      expect(Array.isArray(body.bundles[0].events)).toBe(true);
    });
  });

  // ── POST /api/settlement/release ─────────────────────────────────────────

  describe("POST /api/settlement/release", () => {
    it("returns 400 when jobId is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settlement/release",
        headers: { "x-settlement-admin-token": SETTLEMENT_TOKEN },
        payload: { milestoneIndex: 0 },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("jobId is required");
    });

    it("returns 502 when write is disabled (graceful degradation)", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(false);

      const res = await app.inject({
        method: "POST",
        url: "/api/settlement/release",
        headers: { "x-settlement-admin-token": SETTLEMENT_TOKEN },
        payload: { jobId: "job-001", milestoneIndex: 0, attestation: mkAttestationBody() },
      });
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.error).toBe("release_failed");
    });

    it("returns 200 with txHash when release succeeds", async () => {
      const escrowMod = await import("../contracts/escrow-client.js");
      vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

      const res = await app.inject({
        method: "POST",
        url: "/api/settlement/release",
        headers: { "x-settlement-admin-token": SETTLEMENT_TOKEN },
        payload: {
          jobId: "job-001",
          milestoneIndex: 0,
          contractAddress: "0xDeAdBeEf00000000000000000000000000000001",
          attestation: mkAttestationBody(),
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.txHash).toBe("0xtest_release_tx456");
      expect(body.status).toBe("released");
      expect(body.jobId).toBe("job-001");
      expect(body.milestoneIndex).toBe(0);
    });

    // ── Round-6 A4: privileged-caller gate (ordinary callers cannot invoke the low-level APIs) ──
    it("A4: release WITHOUT the settlement token → 403 (an ordinary provisioned agent is rejected)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settlement/release",
        payload: { jobId: "job-001", milestoneIndex: 0, attestation: mkAttestationBody() },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("forbidden");
    });

    it("A4: release with a WRONG settlement token → 403", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settlement/release",
        headers: { "x-settlement-admin-token": "not-the-token" },
        payload: { jobId: "job-001", milestoneIndex: 0, attestation: mkAttestationBody() },
      });
      expect(res.statusCode).toBe(403);
    });

    it("A4: submit WITHOUT the settlement token → 403 (gated BEFORE the batch-enabled check)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settlement/submit",
        payload: {
          intentId: "i1",
          agentId: "a1",
          escrowAddress: "0xDeAdBeEf00000000000000000000000000000001",
          operation: { type: "release" },
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("forbidden");
    });

    it("A4: submit WITH the correct settlement token passes the gate (reaches the batch-disabled 503)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settlement/submit",
        headers: { "x-settlement-admin-token": SETTLEMENT_TOKEN },
        payload: {
          intentId: "i1",
          agentId: "a1",
          escrowAddress: "0xDeAdBeEf00000000000000000000000000000001",
          operation: { type: "release" },
        },
      });
      // Past the gate; batch settlement is disabled in tests → 503 (NOT 403). Proves the token opens it.
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("batch_disabled");
    });

    it("A4: flush WITHOUT the settlement token → 403 (the epoch-settlement flush endpoint is gated too)", async () => {
      const res = await app.inject({ method: "POST", url: "/api/settlement/flush", payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("forbidden");
    });
  });

  // ── GET /api/settlement/:jobId ─────────────────────────────────────────

  describe("GET /api/settlement/:jobId", () => {
    it("returns 404 for unknown job", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/settlement/job-nonexistent-xyz",
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe("SETTLEMENT_NOT_FOUND");
    });

    it("returns settlement status for a known job (seeded)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/settlement/job-001",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jobId).toBe("job-001");
      expect(typeof body.status).toBe("string");
      expect(typeof body.settled).toBe("boolean");
    });

    it("shows settled=true for a completed job", async () => {
      // job-004 is seeded with status "completed"
      const res = await app.inject({
        method: "GET",
        url: "/api/settlement/job-004",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.settled).toBe(true);
    });

    it("does not match static routes like 'status'", async () => {
      // /api/settlement/status should not be caught by the :jobId handler
      const res = await app.inject({
        method: "GET",
        url: "/api/settlement/status",
      });
      // Status route returns queue status (200), not a 404
      expect(res.statusCode).toBe(200);
    });

    it("includes evidenceBundleId when evidence was processed", async () => {
      const service = getSettlementService();
      const bundle = makeBundle({ jobId: "job-004" });
      await service.processEvidence(bundle, "job-004");

      const res = await app.inject({
        method: "GET",
        url: "/api/settlement/job-004",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evidenceBundleId).toBe("bundle-test-001");
      expect(body.evidenceHash).toBeDefined();
    });
  });

  // ── GET /api/settlement/status ─────────────────────────────────────────

  describe("GET /api/settlement/status", () => {
    it("returns queue status", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/settlement/status",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("pending");
      expect(body).toHaveProperty("totalValue");
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: full evidence-to-settlement flow
// ---------------------------------------------------------------------------

describe("Full evidence-to-settlement flow", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    closeWorkflowStore();
    resetSettlementService();
  });

  it("processes evidence then settles (with write enabled)", async () => {
    const escrowMod = await import("../contracts/escrow-client.js");
    vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(true);

    // Step 1: Process evidence (simulates KernelService calling after job completion)
    // Use job-004: seeded as "completed", kernel-nyc, no pre-seeded evidence bundles.
    const service = getSettlementService();
    const bundle = makeBundle(); // defaults to job-004
    const result = await service.processEvidence(bundle, "job-004", {
      contractAddress: "0xDeAdBeEf00000000000000000000000000000001",
      milestoneIndex: 0,
      autoRelease: true,
      attestation: mkAttestation(),
    });

    expect(result.cid).toBe("bafytest123");
    expect(result.evidenceTxHash).toBe("0xtest_evidence_tx123");
    expect(result.releaseTxHash).toBe("0xtest_release_tx456");
    expect(result.settled).toBe(true);

    // Step 2: Verify evidence is stored in DB and retrievable via API
    const evidenceRes = await app.inject({
      method: "GET",
      url: "/api/evidence/job-004",
    });
    expect(evidenceRes.statusCode).toBe(200);
    const evidenceBody = evidenceRes.json();
    expect(evidenceBody.bundles[0].bundleId).toBe("bundle-test-001");

    // Step 3: Verify settlement status reflects settled state
    const settlementRes = await app.inject({
      method: "GET",
      url: "/api/settlement/job-004",
    });
    expect(settlementRes.statusCode).toBe(200);
    const settlementBody = settlementRes.json();
    expect(settlementBody.settled).toBe(true);
  });

  it("processes evidence without on-chain calls when write is disabled", async () => {
    const escrowMod = await import("../contracts/escrow-client.js");
    vi.mocked(escrowMod.isWriteEnabled).mockReturnValue(false);

    const service = getSettlementService();
    const bundle = makeBundle(); // defaults to job-004
    const result = await service.processEvidence(bundle, "job-004", {
      contractAddress: "0xDeAdBeEf00000000000000000000000000000001",
      autoRelease: true,
    });

    // Evidence is stored but not settled on-chain
    expect(result.cid).toBe("bafytest123");
    expect(result.evidenceTxHash).toBeUndefined();
    expect(result.releaseTxHash).toBeUndefined();
    expect(result.settled).toBe(false);

    // Evidence is still retrievable via API
    const evidenceRes = await app.inject({
      method: "GET",
      url: "/api/evidence/job-004",
    });
    expect(evidenceRes.statusCode).toBe(200);
  });
});
