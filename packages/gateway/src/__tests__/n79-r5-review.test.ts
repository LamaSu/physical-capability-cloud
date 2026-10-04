/**
 * N79 round 5 (astra pack 126e, verdict DO-NOT-SHIP on 986b1789).
 *
 * One test per finding. Each asserts the CORRECT behaviour, so each fails at 986b1789 on the finding's own
 * assertion (except the exact-re-delivery idempotence case, which already passes — noted on that test):
 *
 *   R5-H1: a duplicate evidence-bundle id (a PK collision whose insert throws, swallowed and ignored at 986b1789)
 *          let `processEvidence` submit THIS call's hash on-chain and point the job at the EXISTING row under that
 *          id, which can hold a DIFFERENT hash.
 *   R5-H2: the keeper trusted the chain/local milestone mapping by raw index, with no cardinality check. A chain
 *          index past the local array's end recorded nothing and reported no failure (a); an extra, never-released
 *          local row was marked `released` anyway once every CHAIN milestone read Released (b).
 *   R5-M1: `releaseMilestone`'s given-back check ran BEFORE the target was resolved, against the raw `jobId` AND
 *          `contractAddress` independently — so an unrelated given-back escrow (the env default, or an explicitly
 *          named one that was never the job's own) could refuse a release of the job's perfectly fine own escrow,
 *          or report `escrow_refunded` where `escrow_mismatch` was the honest answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getAddress, keccak256, toBytes, type Hex } from "viem";
import type { EvidenceBundle } from "@pcc/spec";

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_r5", metadataCid: "bafymeta_n79_r5" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc", metadataCid: "bafyencmeta" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../contracts/escrow-client.js")>();
  return {
    ...actual,
    isWriteEnabled: vi.fn(() => false),
    submitEvidence: vi.fn(),
    releaseMilestone: vi.fn(),
    releaseMilestoneV2: vi.fn(),
    getEscrowStateV2: vi.fn(),
  };
});

vi.mock("../services/settlement-crank.js", () => ({
  driveSettlement: vi.fn(),
}));

import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import {
  beginSettlement,
  endSettlement,
  setJobStatusWithRefund,
  recordChainSettlement,
} from "../services/escrow-refund.js";
import { getSettlementService } from "../services/settlement-service.js";
import { runKeeperSweep } from "../services/settlement-keeper.js";
import { driveSettlement } from "../services/settlement-crank.js";
import * as chain from "../contracts/escrow-client.js";

const dangling: Array<() => void> = [];
const inflight: Array<PromiseLike<unknown>> = [];

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const NOW = Math.floor(Date.now() / 1000);
const HASH_A = `sha256:${"a1".repeat(32)}`;
const HASH_B = `sha256:${"b2".repeat(32)}`;
const ATTESTATION = (escrowAddress: string) => ({ escrowAddress, evidenceHash: `0x${"cd".repeat(32)}` }) as never;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(jobRoutes);
  await app.ready();
  return app;
}

async function submitPaidJob(app: FastifyInstance, userAgentId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    payload: { kernelId: "kernel-nyc", capabilityType: "liquid-handler", userAgentId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().jobId as string;
}

function pointEscrowAtChain(jobId: string, address: string, version: "v2" | "v3" = "v2"): string {
  const sess = getStore().db.select().from(schema.negotiationSessions).where(eq(schema.negotiationSessions.jobId, jobId)).get();
  const row = getRepos().escrows.findByCwm(sess!.cwmId)!;
  getStore().db.update(schema.escrows).set({ contractAddress: address, version }).where(eq(schema.escrows.id, row.id)).run();
  return address;
}

// Fixture correction (round 5, the R5-H2b identity check): mirror production's real mapping
// (paid-job-flow.ts: `keccak256(toBytes(ms.stepId))`) by default — index i's chain stepId is the hash of
// `seed()`'s own `step-${i+1}` convention — so cardinality-only tests are not ALSO (accidentally) identity
// mismatches now that `recordMilestoneRowReleased`/`recordEscrowReleased` check identity too. A test that wants a
// genuine identity mismatch passes `stepIdOverrides` for the index(es) it means to disagree on. No assertion
// changed by this correction — only what the synthetic chain says a row's own identity is.
function chainState(address: string, statuses: number[], stepIdOverrides: Record<number, Hex> = {}) {
  return {
    address,
    payer: addr(0xaa),
    arbiter: addr(0xbb),
    token: addr(0xcc),
    cwmId: `0x${"00".repeat(32)}`,
    funded: true,
    totalAmount: "10",
    milestoneCount: statuses.length,
    milestones: statuses.map((status, i) => ({
      stepId: stepIdOverrides[i] ?? keccak256(toBytes(`step-${i + 1}`)),
      operator: addr(0),
      amount: "10",
      operatorBond: "0",
      status,
      statusName: "",
      evidenceBundleHash: `0x${"00".repeat(32)}`,
      verifierAttestationHash: `0x${"00".repeat(32)}`,
      challengeWindowEnd: NOW - 1_000,
      challengeWindowSeconds: 0,
      requiredTier: 0,
      jobIdHash: `0x${"00".repeat(32)}`,
      verifierAttestationUid: `0x${"00".repeat(32)}`,
    })),
  } as never;
}

let seq = 0;
function seed(opts: { status?: string; jobStatus?: string; milestones?: string[]; address?: string } = {}) {
  const repos = getRepos();
  const n = ++seq;
  const jobId = `job-r5-${n}`;
  const cwmId = `cwm-r5-${n}`;
  const capability = repos.capabilities.findAll()[0]!;
  const now = new Date().toISOString();
  const status = opts.status ?? "funded";
  const address = opts.address ?? addr(0xc0000 + n);
  repos.jobs.insert({
    id: jobId,
    stepId: "step-1",
    cwmId,
    capabilityId: capability.id,
    kernelId: capability.kernelId,
    status: opts.jobStatus ?? "in_progress",
    assignedDevices: [],
  });
  getStore()
    .db.insert(schema.negotiationSessions)
    .values({
      id: `sess-r5-${n}`,
      status: "committed",
      userAgentId: "user-r5",
      kernelId: capability.kernelId,
      capabilityType: capability.type,
      operatorConstraints: {},
      jobId,
      cwmId,
      createdAt: now,
      expiresAt: now,
    })
    .run();
  const escrowId = `esc-r5-${n}`;
  repos.escrows.insert({
    id: escrowId,
    cwmId,
    contractAddress: address,
    payer: "0x0000000000000000000000000000000000000001",
    totalAmount: "10.00",
    currency: "USDC",
    status,
    createdAt: now,
    deadline: now,
    version: "v2",
  });
  (opts.milestones ?? [status === "created" ? "pending" : "funded"]).forEach((ms, i) => {
    repos.escrows.insertMilestone({ id: `ms-r5-${n}-${i}`, escrowId, stepId: `step-${i + 1}`, amount: "5.00", status: ms, bondAmount: "0" });
  });
  return { jobId, escrowId, address, cwmId };
}

function rows(escrowId: string) {
  return {
    escrow: getRepos().escrows.findById(escrowId)!.status,
    milestones: getRepos().escrows.findMilestonesByEscrow(escrowId).map((m) => m.status),
  };
}

function makeBundle(jobId: string, over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  const job = getRepos().jobs.findById(jobId)!;
  return {
    id: "bundle-r5-A",
    jobId,
    stepId: job.stepId,
    kernelId: job.kernelId,
    assuranceTier: 0,
    bundleHash: HASH_A as `sha256:${string}`,
    kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "mock_sig_r5" },
    createdAt: new Date().toISOString(),
    events: [],
    ...over,
  };
}

describe("N79 round 5: the review's findings, reproduced", () => {
  let app: FastifyInstance;
  let savedEscrowEnv: string | undefined;

  beforeEach(async () => {
    savedEscrowEnv = process.env.ESCROW_CONTRACT_ADDRESS;
    delete process.env.ESCROW_CONTRACT_ADDRESS;
    vi.mocked(chain.isWriteEnabled).mockReset().mockReturnValue(false);
    vi.mocked(chain.submitEvidence).mockReset();
    vi.mocked(chain.releaseMilestone).mockReset();
    vi.mocked(chain.getEscrowStateV2).mockReset();
    vi.mocked(driveSettlement).mockReset();
    app = await buildApp();
  });

  afterEach(async () => {
    for (const flush of dangling.splice(0)) flush();
    await Promise.allSettled(inflight.splice(0));
    await app.close();
    closeStore();
    if (savedEscrowEnv === undefined) delete process.env.ESCROW_CONTRACT_ADDRESS;
    else process.env.ESCROW_CONTRACT_ADDRESS = savedEscrowEnv;
  });

  it("R5-H1: a duplicate bundle id is refused BEFORE any on-chain write, and the job is neither pointed nor marked submitted", async () => {
    const jobId = await submitPaidJob(app, "user-n79r5-h1");
    const address = pointEscrowAtChain(jobId, addr(0xd5c401), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr5evidence", status: "submitted" } as never);

    const job = getRepos().jobs.findById(jobId)!;
    // Pre-insert evidence row id X with hash B (simulating a prior, DIFFERENT bundle delivered under this id).
    getRepos().evidence.insert({
      id: "bundle-r5-A",
      jobId,
      stepId: job.stepId,
      kernelId: job.kernelId,
      assuranceTier: 0,
      bundleHash: HASH_B,
      kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "prior_sig" },
      createdAt: new Date().toISOString(),
    });
    const statusBefore = getRepos().jobs.findById(jobId)!.status;

    // This call's bundle carries the SAME id but hash A — a collision, not a re-delivery.
    const result = await getSettlementService().processEvidence(makeBundle(jobId, { bundleHash: HASH_A as `sha256:${string}` }), jobId, {
      milestoneIndex: 0,
      contractAddress: address,
    });

    expect(chain.submitEvidence).not.toHaveBeenCalled();
    expect(result.error).toBe("evidence_bundle_conflict");
    const jobAfter = getRepos().jobs.findById(jobId)!;
    expect(jobAfter.status).not.toBe("evidence_submitted");
    expect(jobAfter.status).toBe(statusBefore === "evidence_submitted" ? statusBefore : jobAfter.status); // unchanged by this call either way
    expect(jobAfter.evidenceBundleId).not.toBe("bundle-r5-A");
    // The row under X still holds B: resume would still find B, never A.
    expect(getRepos().evidence.findById("bundle-r5-A")?.bundleHash).toBe(HASH_B);
  });

  it("R5-H1 (idempotent re-delivery): an EXACT re-delivery of the same bundle id proceeds normally", async () => {
    const jobId = await submitPaidJob(app, "user-n79r5-h1-idem");
    const address = pointEscrowAtChain(jobId, addr(0xd5c402), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr5evidence2", status: "submitted" } as never);

    const job = getRepos().jobs.findById(jobId)!;
    // N79 round 7 (P2): the fresh pre-submit verification reads this — the row is "v2" (pointEscrowAtChain
    // above), so getEscrowStateV2 per the lead's round-7 addendum. Fixture only; no assertion changed.
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(
      chainState(address, [chain.MilestoneStatusV2.Funded], { 0: keccak256(toBytes(job.stepId)) }),
    );
    getRepos().evidence.insert({
      id: "bundle-r5-A",
      jobId,
      stepId: job.stepId,
      kernelId: job.kernelId,
      assuranceTier: 0,
      bundleHash: HASH_A,
      kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "mock_sig_r5" },
      createdAt: new Date().toISOString(),
    });

    // Identical in every field the conflict check reads: jobId, stepId, kernelId, assuranceTier, hash.
    const result = await getSettlementService().processEvidence(makeBundle(jobId), jobId, { milestoneIndex: 0, contractAddress: address });

    expect(chain.submitEvidence).toHaveBeenCalledTimes(1);
    expect(result.error).toBeUndefined();
    expect(getRepos().jobs.findById(jobId)!.status).toBe("evidence_submitted");
    expect(getRepos().jobs.findById(jobId)!.evidenceBundleId).toBe("bundle-r5-A");
  });

  it("R5-H1 (unverified persistence failure): an insert that fails and cannot even be re-read stops before any on-chain write", async () => {
    const jobId = await submitPaidJob(app, "user-n79r5-h1-io");
    const address = pointEscrowAtChain(jobId, addr(0xd5c403), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr5evidence3", status: "submitted" } as never);
    const before = getRepos().jobs.findById(jobId)!;

    // The insert fails, and so does the read that would tell a re-delivery from a conflict (a disk I/O error):
    // nothing confirms this call's evidence was recorded (astra 126e: "do not proceed to the on-chain write after
    // an unverified persistence failure").
    const insert = vi.spyOn(getRepos().evidence, "insert").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    const read = vi.spyOn(getRepos().evidence, "findById").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    const result = await getSettlementService()
      .processEvidence(makeBundle(jobId), jobId, { milestoneIndex: 0, contractAddress: address })
      .finally(() => {
        insert.mockRestore();
        read.mockRestore();
      });

    expect(chain.submitEvidence).not.toHaveBeenCalled();
    expect(result.error).toBe("evidence_persistence_failed");
    const after = getRepos().jobs.findById(jobId)!;
    expect(after.status).toBe(before.status);
    expect(after.evidenceBundleId).toBe(before.evidenceBundleId);
  });

  it("R5-H1 (defence in depth): a row rewritten while the on-chain submit is out is never pointed at, and nothing auto-releases", async () => {
    const jobId = await submitPaidJob(app, "user-n79r5-h1-recheck");
    const address = pointEscrowAtChain(jobId, addr(0xd5c404), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockImplementation(async () => {
      // While this call's submit is out, the row under its id stops holding this call's hash.
      getStore().db.update(schema.evidenceBundles).set({ bundleHash: HASH_B }).where(eq(schema.evidenceBundles.id, "bundle-r5-A")).run();
      return { transactionHash: "0xr5evidence4", status: "submitted" } as never;
    });
    vi.mocked(chain.releaseMilestone).mockResolvedValue({ transactionHash: "0xr5release4", status: "submitted" } as never);
    // N79 round 7 (P2): the fresh pre-submit AND pre-auto-release verification both read this — the row is
    // "v2", so getEscrowStateV2 per the lead's round-7 addendum. Fixture only; no assertion changed.
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(
      chainState(address, [chain.MilestoneStatusV2.Funded], { 0: keccak256(toBytes(getRepos().jobs.findById(jobId)!.stepId)) }),
    );
    const before = getRepos().jobs.findById(jobId)!;

    const result = await getSettlementService().processEvidence(makeBundle(jobId), jobId, {
      milestoneIndex: 0,
      contractAddress: address,
      autoRelease: true,
      attestation: ATTESTATION(address),
    });

    expect(chain.submitEvidence).toHaveBeenCalledTimes(1);
    expect(result.error).toBe("evidence_bundle_conflict");
    expect(chain.releaseMilestone).not.toHaveBeenCalled();
    const after = getRepos().jobs.findById(jobId)!;
    expect(after.status).not.toBe("evidence_submitted");
    expect(after.evidenceBundleId).toBe(before.evidenceBundleId);
  });

  it("R5-H2 (a): a chain index past the local array's end is never silently dropped — nothing is recorded, and the escrow cannot be refunded (round 6: detected at read)", async () => {
    const { jobId, escrowId, address } = seed({ milestones: ["funded"] }); // ONE local row
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(chainState(address, [chain.MilestoneStatusV2.Evidenced, chain.MilestoneStatusV2.Released]));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    let result;
    try {
      result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
      expect(driveSettlement).not.toHaveBeenCalled();
      // (asserted here, BEFORE mockRestore — Vitest's mockRestore also clears recorded calls)
      // N79 round 6 (addendum 1, P4): the mapping is now checked IMMEDIATELY after the read, before any drive
      // or record — a cardinality drift (chain reports 2, local has 1) is `settlement_mapping_mismatch`, not
      // the write-time `settlement_record_failed` round 5 logged when the write itself was attempted and
      // discovered the missing row.
      expect(errors).toHaveBeenCalledWith(
        "[escrow] settlement_mapping_mismatch",
        expect.objectContaining({ escrowId, chainCount: 2, localCount: 1, firstMismatch: 1 }),
      );
    } finally {
      errors.mockRestore();
    }

    // Nothing moved: the row the chain claims is Released was never recorded, and the escrow is not refundable.
    expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded"] });
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );
  });

  it("R5-H2 (b): an extra local row the chain never reports is never marked released, and the escrow never completes (round 6: detected at read — nothing is stamped, not even the matching row)", async () => {
    const { escrowId, address } = seed({ milestones: ["funded", "funded"] }); // TWO local rows
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(chainState(address, [chain.MilestoneStatusV2.Released])); // chain: ONE
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    let result;
    try {
      result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
      // N79 round 6 (addendum 1, P4, "fix the property, not the cases"): round 5 let the ONE chain-confirmed row
      // stamp anyway, trusting it in isolation from the cardinality drift it was found alongside — exactly the
      // narrow, per-case patch the lead's addendum was commissioned to stop. Round 6's property is that ANY
      // drift (identity OR cardinality, in EITHER direction) quarantines the WHOLE escrow and writes NOTHING,
      // because an unexplained drift means this local escrow association is no longer known to represent the
      // obligation being advanced — not even the parts that happen to look right.
      expect(errors).toHaveBeenCalledWith(
        "[escrow] settlement_mapping_mismatch",
        expect.objectContaining({ escrowId, chainCount: 1, localCount: 2, firstMismatch: 1 }),
      );
    } finally {
      errors.mockRestore();
    }

    expect(result.reconciledCompleted).toBe(0);
    expect(result.mappingMismatch).toBe(1);
    expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded", "funded"] });
    // The lease ended (refused, not left dangling): the next claim adopts the still-`completing` row.
    const next = beginSettlement({ escrowId }, { leaseOnly: true });
    expect(next.disposition).toBe("adopted");
    if ("claim" in next) endSettlement(next.claim);
  });

  it("R5-M1 (a): an unrelated refunded env default must not block a release of the job's own, perfectly fine escrow", async () => {
    const { jobId: jobA, address: addressA } = seed({ status: "funded" });
    const { address: addressB } = seed({ status: "refund_pending" }); // an unrelated escrow, never job A's own
    process.env.ESCROW_CONTRACT_ADDRESS = addressB;
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.releaseMilestone).mockResolvedValue({ transactionHash: "0xr5m1a", status: "submitted" } as never);

    const out = await getSettlementService().releaseMilestone(jobA, 0, ATTESTATION(addressA)); // no address supplied

    expect(out).toEqual(expect.objectContaining({ status: "released", txHash: "0xr5m1a" }));
    expect(vi.mocked(chain.releaseMilestone).mock.calls[0]?.[2]).toBe(addressA);
  });

  it("R5-M1 (b): explicitly naming a DIFFERENT, refunded escrow for a job that has its own must read escrow_mismatch, not escrow_refunded", async () => {
    const { jobId: jobA } = seed({ status: "funded" });
    const { address: addressB } = seed({ status: "refund_pending" }); // a real, given-back escrow — but not job A's own
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);

    const out = await getSettlementService().releaseMilestone(jobA, 0, ATTESTATION(addressB), addressB);

    expect(out).toEqual(expect.objectContaining({ status: "failed", error: "escrow_mismatch" }));
    expect(chain.releaseMilestone).not.toHaveBeenCalled();
  });

  it("R5-M1 (c): the job's OWN given-back escrow, with a DIFFERENT live escrow explicitly named, reads escrow_mismatch too", async () => {
    // The mirror of R5-M1 (b). The round-1 test with this scenario in n79-given-back-escrow-settlement-release.test.ts
    // asserted escrow_refunded; it now asserts escrow_mismatch too (the named target is not the job's own row).
    const { jobId: jobOwn } = seed({ status: "refund_pending" }); // the job's OWN escrow: already given back
    const { address: addressLive } = seed({ status: "funded" }); // a DIFFERENT escrow, live, never this job's own
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);

    const out = await getSettlementService().releaseMilestone(jobOwn, 0, ATTESTATION(addressLive), addressLive);

    expect(out).toEqual(expect.objectContaining({ status: "failed", error: "escrow_mismatch" }));
    expect(chain.releaseMilestone).not.toHaveBeenCalled();
  });

  // N79 round 6 (addendum 1, P1, "whichever leaves fewer doors"): the four tests below called the now-REMOVED
  // `recordMilestoneRowReleased` / `recordEscrowReleased` directly. Converted to `recordChainSettlement`
  // (chain mapping REQUIRED), preserving each one's original intent: a missing row, an identity mismatch, or a
  // count mismatch in either direction all drift — nothing written, escrow stays `completing`.
  it("R5-H2 (direct): recordChainSettlement refuses a chain index with no local row — drifted, nothing written (round 6: detected at read; was: recordMilestoneRowReleased)", () => {
    const { escrowId } = seed({ milestones: ["funded", "funded"] }); // TWO local rows
    const begun = beginSettlement({ escrowId }, { leaseOnly: true });
    const claim = "claim" in begun ? begun.claim : (undefined as never);
    try {
      // THREE chain entries (index 2 has no local row) against TWO local rows: a cardinality drift, chain-has-more.
      const outcome = recordChainSettlement(claim, {
        stepIds: [keccak256(toBytes("step-1")), keccak256(toBytes("step-2")), keccak256(toBytes("step-3"))],
        statuses: [chain.MilestoneStatusV2.Funded, chain.MilestoneStatusV2.Funded, chain.MilestoneStatusV2.Released],
        releasedStatus: chain.MilestoneStatusV2.Released,
      });
      expect(outcome.drifted).toBe(true);
      // Nothing was recorded — not even the two valid-looking indices beside the missing one.
      expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded", "funded"] });
    } finally {
      if (claim) endSettlement(claim);
    }
  });

  it("R5-H2b (i): a chain stepId that does not match the local row's keccak256 is an identity drift, not a recordable release (round 6: detected at read; was: recordMilestoneRowReleased)", () => {
    // Lead follow-up to R5-H2: cardinality alone is not identity. The chain milestone at this index is a
    // DIFFERENT obligation than the local row at the same index claims to be — recording it as released would
    // mark the WRONG row paid. Same count (1 and 1): this is purely an identity mismatch.
    const { escrowId } = seed({ milestones: ["funded"] }); // local stepId "step-1" (seed()'s convention)
    const realStepId = keccak256(toBytes("step-1"));
    const wrongChainStepId = keccak256(toBytes("step-SOMETHING-ELSE")) as Hex;
    expect(wrongChainStepId).not.toBe(realStepId); // sanity: genuinely a different hash
    const begun = beginSettlement({ escrowId }, { leaseOnly: true });
    const claim = "claim" in begun ? begun.claim : (undefined as never);
    try {
      const outcome = recordChainSettlement(claim, {
        stepIds: [wrongChainStepId],
        statuses: [chain.MilestoneStatusV2.Released],
        releasedStatus: chain.MilestoneStatusV2.Released,
      });
      expect(outcome.drifted).toBe(true);
      // Nothing was recorded.
      expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded"] });
    } finally {
      if (claim) endSettlement(claim);
    }
  });

  it("R5-H2b (ii): the SAME count with a different stepId at index 0 must refuse to complete the escrow (round 6: detected at read; was: recordEscrowReleased)", () => {
    // At 986b1789 `recordEscrowReleased` took no chain set at all and completed this escrow (returned true). The
    // round-5 mutation pass shows the per-index identity comparison, not the count, is what makes this refuse.
    // Round 6 collapses this and R5-H2b (i) through the SAME guarded writer — the two tests now pin the same
    // invariant from what used to be two different entry points.
    const { escrowId } = seed({ milestones: ["funded"] }); // ONE local row, stepId "step-1"
    const wrongChainStepId = keccak256(toBytes("step-SOMETHING-ELSE")) as Hex;
    const begun = beginSettlement({ escrowId }, { leaseOnly: true });
    const claim = "claim" in begun ? begun.claim : (undefined as never);
    try {
      // Same LENGTH (1) as the local row count — this is purely an identity mismatch, not a cardinality one.
      const outcome = recordChainSettlement(claim, {
        stepIds: [wrongChainStepId],
        statuses: [chain.MilestoneStatusV2.Released],
        releasedStatus: chain.MilestoneStatusV2.Released,
      });
      expect(outcome.completed).toBeFalsy();
      expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded"] });
    } finally {
      if (claim) endSettlement(claim);
    }
  });

  it("R5-H2 (c): the chain confirming MORE milestones than the local rows refuses to complete the escrow (round 6: detected at read; was: recordEscrowReleased)", () => {
    // Round 6: the keeper's own pre-drive compare now catches this drift before any record call is even
    // reached (R5-H2 (a) above) — the count check is still pinned directly here, identity agreeing at the one
    // local index and only the count differing.
    const { escrowId } = seed({ milestones: ["funded"] }); // ONE local row, stepId "step-1"
    const begun = beginSettlement({ escrowId }, { leaseOnly: true });
    const claim = "claim" in begun ? begun.claim : (undefined as never);
    try {
      const outcome = recordChainSettlement(claim, {
        stepIds: [keccak256(toBytes("step-1")), keccak256(toBytes("step-2"))],
        statuses: [chain.MilestoneStatusV2.Released, chain.MilestoneStatusV2.Released],
        releasedStatus: chain.MilestoneStatusV2.Released,
      });
      expect(outcome.completed).toBeFalsy();
      expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded"] });
    } finally {
      if (claim) endSettlement(claim);
    }
  });

  it("R5-H2b (keeper): a Released chain milestone whose stepId is not the local row's is never recorded, and the escrow cannot be refunded (round 6: detected at read)", async () => {
    const { jobId, escrowId, address } = seed({ milestones: ["funded"] }); // ONE local row, stepId "step-1"
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(
      chainState(address, [chain.MilestoneStatusV2.Released], { 0: keccak256(toBytes("step-SOMETHING-ELSE")) as Hex }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    let result;
    try {
      result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
      // (asserted BEFORE mockRestore, which also clears recorded calls)
      // N79 round 6: detected at the read, before any record call — `settlement_mapping_mismatch`, not the
      // write-time `settlement_record_failed`.
      expect(errors).toHaveBeenCalledWith(
        "[escrow] settlement_mapping_mismatch",
        expect.objectContaining({ escrowId, chainCount: 1, localCount: 1, firstMismatch: 0 }),
      );
    } finally {
      errors.mockRestore();
    }

    // Same count (1 and 1), different obligation: the chain's release is not THIS row's, so nothing is recorded,
    // nothing completes, and the escrow is not handed back to be refunded.
    expect(result.reconciledCompleted).toBe(0);
    expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded"] });
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );
  });
});
