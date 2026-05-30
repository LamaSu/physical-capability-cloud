/**
 * Tests for the EAS attestation bridge — /complete response shape.
 *
 * Asserts:
 *   - response has `alkahest: null` (Alkahest path was deleted)
 *   - response has `easAttestationUid` key present (null in mock-settlement mode)
 *
 * All heavy deps (escrow-client, oracle-client, evidence-storage) are mocked
 * so the Fastify route loads cleanly. No real network calls.
 *
 * Uses seeded jobs from initStore({seed:true}) so no manual DB insert is needed.
 * Seeded job-001 is in "executing" status on kernel-nyc.
 *
 * Authored by: test-writer-hotel (split from eas-attestation-bridge.test.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { ot2RelayRoutes } from "../routes/ot2-relay.js";
import { ot2ScopeRoutes } from "../routes/ot2-scope.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore } from "../db.js";

// ---------------------------------------------------------------------------
// Module mocks — hoisted file-wide (vitest hoists vi.mock to top of file)
// Mock everything that the route module imports so it loads without errors.
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
  submitAttestationV2: vi.fn().mockResolvedValue({ transactionHash: "0xtest_attest_tx", status: "submitted" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xtest_release_tx", status: "submitted" }),
  isWriteEnabled: vi.fn().mockReturnValue(false), // keeps test in mock-settlement path
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
  flushSettlements: vi.fn().mockResolvedValue({
    epochId: "epoch-1", totalIntents: 0, batches: [], byAgent: {}, byOperation: {},
    startedAt: 0, completedAt: 0,
  }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

vi.mock("../services/oracle-client.js", () => ({
  verifyWithOracle: vi.fn().mockResolvedValue({
    result: { verified: true, tier: 1, reason: "mock ok", checks: [] },
    attestation: {
      escrowAddress: "0xabc",
      evidenceHash: "0xdeadbeef",
      tier: 1,
      verified: true,
      nonce: "0x00",
      signature: "0x00",
    },
  }),
  attestEvidenceOnChain: vi.fn().mockResolvedValue({ uid: "0xeasuid001" }),
  attestEvidenceByDelegation: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
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

describe("/complete response shape — EAS bridge", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("response has alkahest: null (Alkahest path deleted)", async () => {
    // Use the seeded executing job — initStore({seed:true}) populates job-001
    const res = await app.inject({
      method: "PUT",
      url: "/api/jobs/job-001/complete",
      payload: {
        kernelId: "kernel-nyc",
        assuranceTier: 1,
        evidence: { events: [], bundleHash: null },
        evidenceEvents: [],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // alkahest MUST be null — the Alkahest mock bridge was deleted
    expect(body).toHaveProperty("alkahest");
    expect(body.alkahest).toBeNull();
  });

  it("response has easAttestationUid key (null in mock-settlement mode)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/jobs/job-002/complete",
      payload: {
        kernelId: "kernel-sf",
        assuranceTier: 1,
        evidence: { events: [], bundleHash: null },
        evidenceEvents: [],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Key must be present. In mock-settlement mode (isWriteEnabled=false)
    // the on-chain path is skipped, so the uid is null.
    expect(body).toHaveProperty("easAttestationUid");
    expect(body.easAttestationUid).toBeNull();
  });
});
