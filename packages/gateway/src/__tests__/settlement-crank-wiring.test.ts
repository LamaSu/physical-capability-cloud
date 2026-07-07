/**
 * Wiring proof: /complete and resume-settlement both route their on-chain settle
 * through driveSettlement (settlement pivot Step 1).
 *
 * driveSettlement is mocked here (its own behaviour is proven in
 * settlement-crank.test.ts). These tests assert the two HTTP entry points invoke
 * the crank with the right (escrow, idx, {evidenceBundleHash, easUid}) and react to
 * its outcome — resume reconciles the job to 'settled' only when the crank reports a
 * real on-chain release.
 *
 * The V2 chain path activates only for a REAL escrow with write enabled, so the job
 * is created via submit-from-discovery with write DISABLED (mock escrow, no live
 * network), then the session is pointed at a real 0x escrow and write is flipped on
 * before the settle call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// Controllable mocks must be hoisted (vi.mock factories are hoisted above imports).
const h = vi.hoisted(() => ({
  isWriteEnabled: vi.fn().mockReturnValue(false),
  driveSettlement: vi.fn(),
  easUid: ("0x" + "ea".repeat(32)) as `0x${string}`,
}));

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafywire", metadataCid: "bafymeta" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc", metadataCid: "bafyencmeta" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xev", status: "submitted" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xrel", status: "submitted" }),
  isWriteEnabled: h.isWriteEnabled,
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
  resolveMockUSDCAddress: vi.fn().mockReturnValue("0x18bef3dee9f4f97f7cec16db0c4a0a930f478470"),
}));

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "e", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

vi.mock("../services/oracle-client.js", () => ({
  verifyWithOracle: vi.fn().mockResolvedValue({
    result: { verified: true, reason: "mock", checks: [] },
    attestation: { signature: "0xsig", nonce: "1", timestamp: 1 },
    easAttestation: { easUid: h.easUid, schemaUid: "0x" + "5a".repeat(32) },
  }),
  buildEasAttestationMetadata: vi.fn().mockReturnValue({
    schema: "pcc.evidence.v1",
    schemaUid: "0x" + "5a".repeat(32),
    recipient: "0x" + "ab".repeat(20),
    encoded: "0x",
  }),
}));

vi.mock("../services/settlement-crank.js", () => ({
  driveSettlement: h.driveSettlement,
}));

import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";

const KERNEL = "kernel-biolab-01";
const CAP = "liquid-handler";
const REAL_ESCROW = ("0x" + "ab".repeat(20)) as `0x${string}`;

const ORIG = { v2: process.env.PCC_USE_EAS_V2, mock: process.env.MOCK_SETTLEMENT };

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  delete process.env.PCC_USE_EAS_V2; // job creation stays on the mock/no-chain path
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.ready();
  return app;
}

/** A fast-track job (mock escrow, write disabled) with a session pointing at a REAL escrow. */
async function makeJobWithRealEscrow(agent: string): Promise<{ jobId: string }> {
  const ft = await app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    payload: { kernelId: KERNEL, capabilityType: CAP, userAgentId: agent },
  });
  expect(ft.statusCode).toBe(201);
  const jobId = ft.json().jobId as string;

  const { db } = getStore();
  const cwmId = `cwm-${agent}`;
  // submit-from-discovery already inserted a session row (escrowAddress: null) for
  // this jobId; point THAT row at a real 0x escrow so hasRealEscrow is true (a second
  // insert would be shadowed by the route's .where(jobId).get()).
  db.update(schema.negotiationSessions)
    .set({ escrowAddress: REAL_ESCROW, cwmId, contractTerms: { assuranceTier: 0 } })
    .where(eq(schema.negotiationSessions.jobId, jobId))
    .run();
  getRepos().escrows.insert({
    id: `esc-${agent}`,
    cwmId,
    contractAddress: REAL_ESCROW,
    payer: agent,
    totalAmount: "10.00",
    currency: "USDC",
    status: "funded",
    createdAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 86_400_000).toISOString(),
  } as any);
  return { jobId };
}

/** Force the durable state a mid-completion failure leaves: evidence bundle + evidence_submitted. */
function trap(jobId: string, agent: string): void {
  const repos = getRepos();
  const job = repos.jobs.findById(jobId)!;
  repos.evidence.insert({
    id: `bundle-${agent}`,
    jobId,
    stepId: job.stepId,
    kernelId: job.kernelId,
    assuranceTier: 0,
    bundleHash: ("0x" + "cd".repeat(32)),
    kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "ed25519", value: "t" },
    createdAt: new Date().toISOString(),
  } as any);
  repos.jobs.update(jobId, { evidenceBundleId: `bundle-${agent}`, status: "evidence_submitted" });
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  h.isWriteEnabled.mockReturnValue(false);
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  closeStore();
  if (ORIG.v2 === undefined) delete process.env.PCC_USE_EAS_V2;
  else process.env.PCC_USE_EAS_V2 = ORIG.v2;
  if (ORIG.mock === undefined) delete process.env.MOCK_SETTLEMENT;
  else process.env.MOCK_SETTLEMENT = ORIG.mock;
});

describe("resume-settlement routes the chain re-drive through driveSettlement", () => {
  it("calls driveSettlement twice (evidence then attest) and reconciles to settled on release", async () => {
    const { jobId } = await makeJobWithRealEscrow("wire-resume");
    trap(jobId, "wire-resume");

    // Turn on the V2 chain path for the resume call only.
    h.isWriteEnabled.mockReturnValue(true);
    process.env.PCC_USE_EAS_V2 = "true";
    process.env.MOCK_SETTLEMENT = "false"; // real-settlement branch → chain owns the verdict

    // First pass advances to Evidenced and needs the UID; second pass releases.
    h.driveSettlement
      .mockResolvedValueOnce({
        escrowAddress: REAL_ESCROW, milestoneIdx: 0, finalStatus: "Evidenced",
        outcome: "needs_input", needs: "eas_uid", settled: false,
        steps: [{ action: "submitEvidence", result: "landed", txHash: "0xev" }],
        stepId: "0x" + "11".repeat(32),
      })
      .mockResolvedValueOnce({
        escrowAddress: REAL_ESCROW, milestoneIdx: 0, finalStatus: "Released",
        outcome: "released", settled: true,
        steps: [
          { action: "submitAttestation", result: "landed", txHash: "0xat" },
          { action: "release", result: "landed", txHash: "0xrel" },
        ],
      });

    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement`, payload: {} });

    expect(res.statusCode).toBe(200);
    expect(h.driveSettlement).toHaveBeenCalledTimes(2);
    // First pass: evidence hash, no UID yet.
    expect(h.driveSettlement.mock.calls[0][0]).toBe(REAL_ESCROW);
    expect(h.driveSettlement.mock.calls[0][1]).toBe(0);
    expect(h.driveSettlement.mock.calls[0][2].easUid).toBeUndefined();
    expect(h.driveSettlement.mock.calls[0][2].evidenceBundleHash).toBeDefined();
    // Second pass: evidence hash + the freshly-minted UID.
    expect(h.driveSettlement.mock.calls[1][2].easUid).toBe(h.easUid);
    // Reconciled to settled BECAUSE the crank released on-chain.
    expect(res.json().status).toBe("settled");
    expect(res.json().chainSettled).toBe(true);
    expect(getRepos().jobs.findById(jobId)!.status).toBe("settled");
  });

  it("stays evidence_submitted (resumable) when the crank stops at awaiting_challenge_window", async () => {
    const { jobId } = await makeJobWithRealEscrow("wire-resume-wait");
    trap(jobId, "wire-resume-wait");

    h.isWriteEnabled.mockReturnValue(true);
    process.env.PCC_USE_EAS_V2 = "true";
    process.env.MOCK_SETTLEMENT = "false";

    h.driveSettlement
      .mockResolvedValueOnce({
        escrowAddress: REAL_ESCROW, milestoneIdx: 0, finalStatus: "Evidenced",
        outcome: "needs_input", needs: "eas_uid", settled: false, steps: [], stepId: "0x" + "11".repeat(32),
      })
      .mockResolvedValueOnce({
        escrowAddress: REAL_ESCROW, milestoneIdx: 0, finalStatus: "Attested",
        outcome: "awaiting_challenge_window", settled: false, challengeWindowEnd: 9_999_999_999,
        steps: [{ action: "submitAttestation", result: "landed", txHash: "0xat" }],
      });

    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement`, payload: {} });

    expect(res.statusCode).toBe(200);
    expect(h.driveSettlement).toHaveBeenCalledTimes(2);
    expect(res.json().chainSettled).toBe(false);
    expect(res.json().status).toBe("evidence_submitted");
    // Still resumable — not prematurely marked settled.
    expect(getRepos().jobs.findById(jobId)!.status).toBe("evidence_submitted");
  });
});

describe("/complete routes the on-chain settle through driveSettlement", () => {
  it("calls driveSettlement for the evidence leg then the attestation leg", async () => {
    const { jobId } = await makeJobWithRealEscrow("wire-complete");

    h.isWriteEnabled.mockReturnValue(true);
    process.env.PCC_USE_EAS_V2 = "true";
    process.env.MOCK_SETTLEMENT = "true"; // 4a/4c run regardless; keep settle simple

    // 4a evidence leg → Evidenced+stepId; 4c attest leg → Attested.
    h.driveSettlement
      .mockResolvedValueOnce({
        escrowAddress: REAL_ESCROW, milestoneIdx: 0, finalStatus: "Evidenced",
        outcome: "needs_input", needs: "eas_uid", settled: false,
        steps: [{ action: "submitEvidence", result: "landed", txHash: "0xev" }],
        stepId: "0x" + "11".repeat(32),
      })
      .mockResolvedValueOnce({
        escrowAddress: REAL_ESCROW, milestoneIdx: 0, finalStatus: "Attested",
        outcome: "awaiting_challenge_window", settled: false, challengeWindowEnd: 9_999_999_999,
        steps: [{ action: "submitAttestation", result: "landed", txHash: "0xat" }],
      });

    const res = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });

    expect(res.statusCode).toBe(200);
    expect(h.driveSettlement).toHaveBeenCalledTimes(2);
    // Evidence leg: hash, no UID.
    expect(h.driveSettlement.mock.calls[0][0]).toBe(REAL_ESCROW);
    expect(h.driveSettlement.mock.calls[0][2].easUid).toBeUndefined();
    // Attestation leg: hash + minted UID (self-healing drive carries the hash too).
    expect(h.driveSettlement.mock.calls[1][2].evidenceBundleHash).toBeDefined();
    expect(h.driveSettlement.mock.calls[1][2].easUid).toBe(h.easUid);
  });
});
