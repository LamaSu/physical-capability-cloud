/**
 * Completion pipeline attests at the job's REAL assurance tier (finding #3 / A-3).
 *
 * The N3 fix put honest tiers (1/2) on-chain as the milestone requiredTier, but
 * PUT /api/jobs/:jobId/complete still hardcoded assuranceTier 0 into the evidence
 * bundle, the oracle call, the ZK proof, and the EAS metadata. A tier>=1 milestone
 * could then be unreleasable (evidence attested at a weaker tier than the escrow
 * requires). The fix derives the tier from the job's session contractTerms and
 * propagates it through the whole completion pipeline.
 *
 * Observable proof: the stored evidence bundle's assuranceTier (the same variable
 * that feeds the oracle + EAS calls) equals the negotiated tier, not 0.
 *
 * Mock settlement is on; IPFS + chain are mocked. The verification oracle is
 * mocked to a working (verified:true, non-degraded) verdict: S4 made the
 * *degraded* mock fallback (no PCC_ORACLE_KEY) fail CLOSED for paid tiers (>=1),
 * so a paid-tier completion 422s at the settlement chokepoint without a real
 * oracle. These tests assert the attested TIER, not oracle honesty (that lives
 * in oracle-client-mock-honesty.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { initStore, closeStore, getRepos } from "../db.js";

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
  submitEvidenceV2: vi.fn().mockResolvedValue({ transactionHash: "0xtest_evidence_v2" }),
  submitAttestationV2: vi.fn().mockResolvedValue({ transactionHash: "0xtest_attest_v2" }),
  getMilestoneV2: vi.fn().mockResolvedValue({ stepId: "0xstep" }),
  resolveMockUSDCAddress: vi.fn().mockReturnValue("0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb"),
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

// A working (non-degraded) verification oracle. S4 made the *degraded* mock
// fallback (no PCC_ORACLE_KEY) fail CLOSED for paid tiers (>=1), so a paid-tier
// completion now 422s at the settlement chokepoint (paid-job-flow.ts:1195)
// without a real oracle. These tests assert WHICH tier completion attests at
// (the negotiated tier, not a hardcoded 0) — not oracle honesty, which is pinned
// in oracle-client-mock-honesty.test.ts. So a real oracle is simulated here:
// verifyWithOracle returns verified:true with NO mode/degraded flags (absence
// === live, per the S4 provenance contract). importOriginal preserves the real
// EAS helpers; only verifyWithOracle is overridden. Pattern mirrors
// settlement-crank-wiring.test.ts.
vi.mock("../services/oracle-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/oracle-client.js")>();
  return {
    ...actual,
    verifyWithOracle: vi.fn(async (req: Parameters<typeof actual.verifyWithOracle>[0]) => ({
      result: {
        verified: true,
        tier: req.assuranceTier,
        reason: "verified",
        checks: { evidenceExists: true, hashMatches: true, tierMet: true, notReplay: true, identityValid: true },
      },
      attestation: {
        version: 1,
        escrowAddress: req.escrowAddress,
        jobId: req.jobId,
        evidenceHash: req.evidenceHash,
        tier: req.assuranceTier,
        verified: true,
        timestamp: Math.floor(Date.now() / 1000),
        nonce: "0x" + "0".repeat(64),
        extraData: "0x",
        signature: "0x" + "1".repeat(130),
      },
      easAttestation: req.mintEasAttestation
        ? { easUid: "0x" + "ea".repeat(32), schemaUid: req.schemaUid ?? "0x" + "00".repeat(32) }
        : null,
      oracle: "0x" + "ab".repeat(20),
      chainId: req.chainId,
      // No mode/degraded — a real (non-degraded) oracle verdict, per S4 provenance.
    })),
  };
});

const KERNEL = "kernel-biolab-01";
const CAP = "liquid-handler";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.ready();
  return app;
}

describe("completion attests at the job's real assurance tier (finding #3 / A-3)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  async function negotiateJob(agent: string, selections: Record<string, unknown>): Promise<string> {
    const create = await app.inject({
      method: "POST",
      url: "/api/negotiate/session",
      payload: { userAgentId: agent, kernelId: KERNEL, capabilityType: CAP },
    });
    expect(create.statusCode).toBe(200);
    const id = create.json().session.id as string;
    expect((await app.inject({ method: "PATCH", url: `/api/negotiate/session/${id}/select`, payload: { selections } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/quote` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/review` })).statusCode).toBe(200);
    const commit = await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit` });
    expect(commit.statusCode).toBe(200);
    const jobId = commit.json().jobId as string;
    expect(jobId).toMatch(/^job-/);
    return jobId;
  }

  function complete(jobId: string) {
    return app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
  }

  it("stores the evidence bundle at the negotiated tier 2 (not the hardcoded 0)", async () => {
    // evidenceTier 'full' => tier 2 on-chain (N3). Completion must attest at tier 2.
    const jobId = await negotiateJob("a3-full", { evidenceTier: "full", quantity: 1 });

    const res = await complete(jobId);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("settled");

    const bundles = getRepos().evidence.findByJob(jobId);
    expect(bundles.length).toBe(1);
    // The stored tier is the SAME variable fed to the oracle + EAS calls.
    expect(bundles[0].assuranceTier).toBe(2);
  });

  it("stores the evidence bundle at the negotiated tier 1 for evidenceTier 'basic'", async () => {
    const jobId = await negotiateJob("a3-basic", { evidenceTier: "basic", quantity: 1 });

    const res = await complete(jobId);
    expect(res.statusCode).toBe(200);

    const bundles = getRepos().evidence.findByJob(jobId);
    expect(bundles.length).toBe(1);
    expect(bundles[0].assuranceTier).toBe(1);
  });

  it("keeps tier 0 for a fast-track job (submit-from-discovery is tier 0 by design)", async () => {
    const ft = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: { kernelId: KERNEL, capabilityType: CAP, userAgentId: "a3-ft" },
    });
    expect(ft.statusCode).toBe(201);
    const jobId = ft.json().jobId as string;

    const res = await complete(jobId);
    expect(res.statusCode).toBe(200);

    const bundles = getRepos().evidence.findByJob(jobId);
    expect(bundles.length).toBe(1);
    expect(bundles[0].assuranceTier).toBe(0);
  });
});
