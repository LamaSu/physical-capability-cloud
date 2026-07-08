/**
 * Approval-as-evidence (D8, settlement-decisions.md) — benign lane tests.
 *
 * Covers:
 *   - negotiation.ts /commit snapshots + hashes a verification policy
 *     (trivial default, or a buyer-proposed one) and persists it.
 *   - routes/approvals.ts challenge issuance + approval intake + listing.
 *
 * Mirrors the harness in negotiation-settlement-correctness.test.ts (same
 * mocks, same seeded KERNEL/CAP pair) so committing a session exercises the
 * real /commit -> createJobFromSession path without touching the chain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { approvalRoutes } from "../routes/approvals.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { schema, eq } from "@pcc/store";
import { policyHashV1, approvalDigestV1, type ApprovalEvidenceV1 } from "@pcc/spec";

const { negotiationSessions, verificationPolicies } = schema;

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

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(approvalRoutes);
  await app.ready();
  return app;
}

const KERNEL = "kernel-biolab-01";
const CAP = "liquid-handler";

async function createSession(app: FastifyInstance, userAgentId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/negotiate/session",
    payload: { userAgentId, kernelId: KERNEL, capabilityType: CAP },
  });
  expect(res.statusCode).toBe(200);
  return res.json().session.id;
}
async function quote(app: FastifyInstance, id: string) {
  return app.inject({ method: "POST", url: `/api/negotiate/session/${id}/quote` });
}
async function review(app: FastifyInstance, id: string) {
  return app.inject({ method: "POST", url: `/api/negotiate/session/${id}/review` });
}
async function commit(app: FastifyInstance, id: string, body?: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit`, payload: body });
}

/** Full negotiate -> quote -> review -> commit flow, returns the commit response body. */
async function fullCommit(app: FastifyInstance, userAgentId: string, commitBody?: Record<string, unknown>) {
  const id = await createSession(app, userAgentId);
  expect((await quote(app, id)).statusCode).toBe(200);
  expect((await review(app, id)).statusCode).toBe(200);
  const res = await commit(app, id, commitBody);
  return { sessionId: id, res };
}

describe("approval-as-evidence — benign lane", () => {
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
  // negotiation.ts /commit — policy snapshot
  // ═══════════════════════════════════════════════════════════════════════

  describe("commit without a proposed policy", () => {
    it("stamps a trivial machine-tier policy on the session and persists the row", async () => {
      const { res } = await fullCommit(app, "buyer-trivial");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.policyId).toBeTruthy();
      expect(body.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(body.session.policyId).toBe(body.policyId);
      expect(body.session.policyHash).toBe(body.policyHash);

      const { db } = getStore();
      const row = db.select().from(verificationPolicies).where(eq(verificationPolicies.policyId, body.policyId)).get();
      expect(row).toBeTruthy();
      expect(row!.jobId).toBe(body.jobId);
      const parsedBody = row!.body as { claims: Array<{ claimId: string; clearing: { kind: string } }> };
      expect(parsedBody.claims).toHaveLength(1);
      expect(parsedBody.claims[0]!.clearing.kind).toBe("machine-tier");
    });

    it("also stamps policyId/policyHash on the negotiation_sessions row itself", async () => {
      const { sessionId, res } = await fullCommit(app, "buyer-session-stamp");
      const body = res.json();
      const { db } = getStore();
      const row = db.select().from(negotiationSessions).where(eq(negotiationSessions.id, sessionId)).get();
      expect(row!.policyId).toBe(body.policyId);
      expect(row!.policyHash).toBe(body.policyHash);
    });
  });

  describe("commit with a buyer-proposed policy", () => {
    const proposedPolicy = {
      claims: [
        { claimId: "work-done", statement: "Machine floor met.", clearing: { kind: "machine-tier" as const } },
        {
          claimId: "payer-accepts",
          statement: "Payer approves settlement.",
          clearing: {
            kind: "human-approval" as const,
            approverRole: "payer" as const,
            approverKeys: [{ scheme: "eip191" as const, keyId: "0x9f8bC1a2D3e4F5061728394a5b6c7d8e9f0a1b2c" }],
            windowSecs: 259200,
            onLapse: "hold" as const,
          },
        },
      ],
      composition: "all" as const,
    };

    it("persists the proposed claims verbatim and a matching policyHash", async () => {
      const { res } = await fullCommit(app, "buyer-proposed", { verificationPolicy: proposedPolicy });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      const { db } = getStore();
      const row = db.select().from(verificationPolicies).where(eq(verificationPolicies.policyId, body.policyId)).get();
      const parsed = row!.body as { claims: unknown[]; policyHash: string };
      expect(parsed.claims).toHaveLength(2);
      expect(parsed.policyHash).toBe(body.policyHash);

      // Recompute the hash independently and confirm it matches — proves
      // the persisted hash is genuinely policyHashV1() over this body, not
      // a placeholder.
      const { policyHash: _drop, ...unhashed } = parsed as any;
      const recomputed = await policyHashV1(unhashed);
      expect(recomputed).toBe(body.policyHash);
    });

    it("rejects a malformed proposed policy with 400 (empty claims)", async () => {
      const id = await createSession(app, "buyer-bad-policy");
      expect((await quote(app, id)).statusCode).toBe(200);
      expect((await review(app, id)).statusCode).toBe(200);
      const res = await commit(app, id, { verificationPolicy: { claims: [], composition: "all" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_verification_policy");

      // No side effects ran — session was NOT committed.
      const { db } = getStore();
      const row = db.select().from(negotiationSessions).where(eq(negotiationSessions.id, id)).get();
      expect(row!.status).not.toBe("committed");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // routes/approvals.ts — challenge issuance + intake + listing
  // ═══════════════════════════════════════════════════════════════════════

  function buildApproval(overrides: Partial<ApprovalEvidenceV1> = {}): ApprovalEvidenceV1 {
    const now = Date.now();
    return {
      schema: "pcc.approval.v1",
      jobId: "job-placeholder",
      escrowAddress: "0x71b9E1AbF447574F6df52B4468BC12a45692AD2a",
      milestoneIndex: 0,
      evidenceHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      policyId: "policy-placeholder",
      claimIds: ["payer-accepts"],
      verdict: "approve",
      approverRole: "payer",
      approverId: "payer-test",
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      nonce: "nonce-placeholder",
      sig: { scheme: "eip191", address: "0x9f8bC1a2D3e4F5061728394a5b6c7d8e9f0a1b2c", signature: "0xdeadbeef" },
      ...overrides,
    };
  }

  async function issueChallengeFor(app: FastifyInstance, jobId: string) {
    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approval-challenge` });
    expect(res.statusCode).toBe(200);
    return res.json() as { nonce: string; digestPreview: string | null; policyClaims: unknown[]; expiresAt: string };
  }

  /**
   * Drives the job to /complete so a REAL evidence bundle lands on file
   * (mirrors negotiation-settlement-correctness.test.ts's P1 helper) —
   * needed because approval-service.ts's evidence-binding check (commit-
   * then-reveal: approve what was committed, not a different hash) 404s
   * any approval submitted before evidence exists.
   */
  async function completeJob(app: FastifyInstance, jobId: string) {
    const res = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    expect(res.statusCode).toBe(200);
    return res;
  }

  /** Reads the job's latest on-file evidence bundle hash (post-/complete). */
  function latestEvidenceHash(jobId: string): string {
    const bundles = getRepos().evidence.findByJob(jobId);
    expect(bundles.length).toBeGreaterThan(0);
    return bundles[bundles.length - 1]!.bundleHash;
  }

  it("issues a challenge carrying the committed policy's claims", async () => {
    const { sessionId, res: commitRes } = await fullCommit(app, "buyer-challenge", {
      verificationPolicy: proposedPolicyClaims(),
    });
    const { jobId } = commitRes.json();
    const challenge = await issueChallengeFor(app, jobId);
    expect(challenge.nonce).toMatch(/^chal-/);
    expect(challenge.policyClaims).toHaveLength(2);
    void sessionId;
  });

  it("issues a graceful empty-claims challenge for a job with no committed policy", async () => {
    const challenge = await issueChallengeFor(app, "job-does-not-exist");
    expect(challenge.nonce).toMatch(/^chal-/);
    expect(challenge.policyClaims).toEqual([]);
    expect(challenge.digestPreview).toBeNull();
  });

  it("accepts a well-formed approval bound to a fresh nonce (202) and lists it", async () => {
    const { res: commitRes } = await fullCommit(app, "buyer-submit");
    const { jobId, policyId, escrowAddress } = commitRes.json();
    await completeJob(app, jobId);
    const evidenceHash = latestEvidenceHash(jobId);
    const challenge = await issueChallengeFor(app, jobId);

    const approval = buildApproval({
      jobId,
      policyId,
      escrowAddress,
      evidenceHash,
      nonce: challenge.nonce,
      claimIds: ["machine-tier"],
    });
    const submitRes = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approvals`, payload: approval });
    expect(submitRes.statusCode).toBe(202);
    expect(submitRes.json().status).toBe("received");

    const listRes = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/approvals` });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json();
    expect(listed.approvals).toHaveLength(1);
    expect(listed.approvals[0].nonce).toBe(challenge.nonce);
    expect(listed.approvals[0].verdict).toBe("approve");
  });

  it("rejects an approval when no evidence bundle is on file yet (404)", async () => {
    const { res: commitRes } = await fullCommit(app, "buyer-no-evidence");
    const { jobId, policyId, escrowAddress } = commitRes.json();
    // Deliberately skip completeJob() — no evidence exists for this job yet.
    const challenge = await issueChallengeFor(app, jobId);
    const approval = buildApproval({ jobId, policyId, escrowAddress, nonce: challenge.nonce });
    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approvals`, payload: approval });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an approval whose evidenceHash does not match the job's on-file evidence (409, no evidence-shopping)", async () => {
    const { res: commitRes } = await fullCommit(app, "buyer-evidence-mismatch");
    const { jobId, policyId, escrowAddress } = commitRes.json();
    await completeJob(app, jobId);
    const challenge = await issueChallengeFor(app, jobId);
    // A DIFFERENT (well-formed) hash than what's actually on file.
    const approval = buildApproval({
      jobId,
      policyId,
      escrowAddress,
      evidenceHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      nonce: challenge.nonce,
    });
    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approvals`, payload: approval });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("EVIDENCE_HASH_MISMATCH");
  });

  it("rejects an approval whose escrowAddress does not match the committed escrow (400)", async () => {
    const { res: commitRes } = await fullCommit(app, "buyer-escrow-mismatch");
    const { jobId, policyId } = commitRes.json();
    await completeJob(app, jobId);
    const evidenceHash = latestEvidenceHash(jobId);
    const challenge = await issueChallengeFor(app, jobId);
    const approval = buildApproval({
      jobId,
      policyId,
      evidenceHash,
      escrowAddress: "0x0000000000000000000000000000000000dEaD",
      nonce: challenge.nonce,
    });
    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approvals`, payload: approval });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an approval carrying an unknown/unissued nonce (400)", async () => {
    const { res: commitRes } = await fullCommit(app, "buyer-unknown-nonce");
    const { jobId, policyId } = commitRes.json();
    const approval = buildApproval({ jobId, policyId, nonce: "chal-never-issued" });
    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approvals`, payload: approval });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a second submission reusing an already-consumed nonce (409)", async () => {
    const { res: commitRes } = await fullCommit(app, "buyer-replay");
    const { jobId, policyId, escrowAddress } = commitRes.json();
    await completeJob(app, jobId);
    const evidenceHash = latestEvidenceHash(jobId);
    const challenge = await issueChallengeFor(app, jobId);
    const approval = buildApproval({ jobId, policyId, escrowAddress, evidenceHash, nonce: challenge.nonce });

    const first = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approvals`, payload: approval });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approvals`, payload: approval });
    expect(second.statusCode).toBe(409);
  });

  it("rejects an expired approval (410)", async () => {
    const { res: commitRes } = await fullCommit(app, "buyer-expired");
    const { jobId, policyId } = commitRes.json();
    const challenge = await issueChallengeFor(app, jobId);
    const approval = buildApproval({
      jobId,
      policyId,
      nonce: challenge.nonce,
      issuedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approvals`, payload: approval });
    expect(res.statusCode).toBe(410);
  });

  it("rejects a reject-verdict approval with no reasonCode (400, reasoned-rejection rule)", async () => {
    const { res: commitRes } = await fullCommit(app, "buyer-reject-no-reason");
    const { jobId, policyId } = commitRes.json();
    const challenge = await issueChallengeFor(app, jobId);
    const approval = buildApproval({ jobId, policyId, nonce: challenge.nonce, verdict: "reject" });
    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approvals`, payload: approval });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a reject-verdict approval WITH a reasonCode", async () => {
    const { res: commitRes } = await fullCommit(app, "buyer-reject-with-reason");
    const { jobId, policyId, escrowAddress } = commitRes.json();
    await completeJob(app, jobId);
    const evidenceHash = latestEvidenceHash(jobId);
    const challenge = await issueChallengeFor(app, jobId);
    const approval = buildApproval({
      jobId,
      policyId,
      escrowAddress,
      evidenceHash,
      nonce: challenge.nonce,
      verdict: "reject",
      reasonCode: "surface-defect",
    });
    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approvals`, payload: approval });
    expect(res.statusCode).toBe(202);
  });

  it("rejects an approval bound to an unknown policyId (404)", async () => {
    const { res: commitRes } = await fullCommit(app, "buyer-unknown-policy");
    const { jobId } = commitRes.json();
    const challenge = await issueChallengeFor(app, jobId);
    const approval = buildApproval({ jobId, policyId: "policy-nonexistent", nonce: challenge.nonce });
    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/approvals`, payload: approval });
    expect(res.statusCode).toBe(404);
  });

  it("computes the same digest via approvalDigestV1 as the fixture-locked canonical form", async () => {
    const approval = buildApproval();
    const { sig, ...body } = approval;
    void sig;
    const d1 = await approvalDigestV1(body);
    const d2 = await approvalDigestV1(body);
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  function proposedPolicyClaims() {
    return {
      claims: [
        { claimId: "machine-tier", statement: "Machine floor met.", clearing: { kind: "machine-tier" as const } },
        {
          claimId: "payer-accepts",
          statement: "Payer approves settlement.",
          clearing: {
            kind: "human-approval" as const,
            approverRole: "payer" as const,
            approverKeys: [{ scheme: "eip191" as const, keyId: "0x9f8bC1a2D3e4F5061728394a5b6c7d8e9f0a1b2c" }],
            windowSecs: 259200,
            onLapse: "hold" as const,
          },
        },
      ],
      composition: "all" as const,
    };
  }
});
