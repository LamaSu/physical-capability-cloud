/**
 * N79 round 6 (astra pack 126f, verdict DO-NOT-SHIP on de712589).
 *
 * PHASE 1: one test per finding, below, under "N79 round 6: Phase 1". Each asserts the CORRECT behaviour, so each
 * fails at de712589 on the finding's own assertion:
 *
 *   R6-H1A: a bundle-row insert followed by an event-persistence failure still settles (the header and its events
 *           are two writes, not one; `bundlePersisted` survives the second write's failure) — (a) a fresh bundle,
 *           (b) a legacy partial row (header without events) healed by re-delivery instead of refused.
 *   R6-H1B: `processEvidence` binds nothing to the method's own job before persisting or touching the chain — (a)
 *           a different job entirely, (b) a mismatched step/kernel on the right job, (c) the right bundle but the
 *           wrong escrow target.
 *   R6-H2A: `recordMilestoneReleased`/`recordEscrowReleased` complete an escrow from LOCAL rows alone, with no
 *           chain cardinality or identity check — (a) resume's unguarded `completeClaimedEscrow`, (b)
 *           `SettlementService.releaseMilestone`, (c) the raw escrow release route.
 *   R6-H2B: mapping validation runs only when a row is WRITTEN (a Released milestone, or whole-escrow completion);
 *           drift below Released is invisible and the escrow is hand-back-able toward a refund — (a) the keeper,
 *           cardinality drift with every milestone below Released, (b) the same, identity drift, (c) resume never
 *           reads the mapping before driving at all.
 *
 * PHASE 2 property tests (ADDENDUM 1) follow under "N79 round 6: Phase 2 properties", added once the fix lands.
 *
 * The real in-memory store throughout. Only the chain, and the settlement crank, are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getAddress, keccak256, toBytes, type Hex } from "viem";
import type { EvidenceBundle } from "@pcc/spec";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_r6", metadataCid: "bafymeta_n79_r6" }),
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
    getEscrowState: vi.fn(),
    getEscrowStateV2: vi.fn(),
  };
});

vi.mock("../services/settlement-crank.js", () => ({
  driveSettlement: vi.fn(),
}));

import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { jobRoutes } from "../routes/jobs.js";
import { escrowRoutes } from "../routes/escrow.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { beginSettlement, endSettlement, escrowForJob, setJobStatusWithRefund } from "../services/escrow-refund.js";
import { getSettlementService } from "../services/settlement-service.js";
import { runKeeperSweep } from "../services/settlement-keeper.js";
import { driveSettlement } from "../services/settlement-crank.js";
import * as chain from "../contracts/escrow-client.js";

const dangling: Array<() => void> = [];
const inflight: Array<PromiseLike<unknown>> = [];

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const NOW = Math.floor(Date.now() / 1000);
const HASH_A = `sha256:${"a1".repeat(32)}`;
const ATTESTATION = (escrowAddress: string) => ({ escrowAddress, evidenceHash: `0x${"cd".repeat(32)}` }) as never;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(jobRoutes);
  await app.register(escrowRoutes);
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

function escrowState(jobId: string) {
  const escrow = escrowForJob(jobId)!;
  return {
    escrow: getRepos().escrows.findById(escrow.id)!.status,
    milestones: getRepos().escrows.findMilestonesByEscrow(escrow.id).map((m) => m.status),
  };
}

/** The chain's view of a V2 escrow. `stepIdOverrides` forces an identity mismatch at an index; `windowOpenIndices`
 *  forces an Attested milestone's challenge window to still be open (default: every window closed). */
function chainState(
  address: string,
  statuses: number[],
  opts: { stepIdOverrides?: Record<number, Hex>; windowOpenIndices?: number[] } = {},
) {
  const { stepIdOverrides = {}, windowOpenIndices = [] } = opts;
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
      challengeWindowEnd: windowOpenIndices.includes(i) ? NOW + 1_000_000 : NOW - 1_000,
      challengeWindowSeconds: 0,
      requiredTier: 0,
      jobIdHash: `0x${"00".repeat(32)}`,
      verifierAttestationUid: `0x${"00".repeat(32)}`,
    })),
  } as never;
}

const SETTLED = { escrowAddress: addr(1), milestoneIdx: 0, finalStatus: "Released", outcome: "released", settled: true, steps: [] } as never;
const NOT_SETTLED = { escrowAddress: addr(1), milestoneIdx: 0, finalStatus: "Attested", outcome: "awaiting_challenge_window", settled: false, steps: [] } as never;

/** A job + negotiation session + escrow (+ milestones), linked the way the settlement read links them. Mirrors the
 *  r4/r5 `seed()` helper (same shape) under an `r6` prefix so fixtures never collide across suites. */
let seq = 0;
function seed(opts: { status?: string; jobStatus?: string; milestones?: string[]; address?: string } = {}) {
  const repos = getRepos();
  const n = ++seq;
  const jobId = `job-r6-${n}`;
  const cwmId = `cwm-r6-${n}`;
  const capability = repos.capabilities.findAll()[0]!;
  const now = new Date().toISOString();
  const status = opts.status ?? "funded";
  const address = opts.address ?? addr(0xe6000 + n);
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
      id: `sess-r6-${n}`,
      status: "committed",
      userAgentId: "user-r6",
      kernelId: capability.kernelId,
      capabilityType: capability.type,
      operatorConstraints: {},
      jobId,
      cwmId,
      createdAt: now,
      expiresAt: now,
    })
    .run();
  const escrowId = `esc-r6-${n}`;
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
    repos.escrows.insertMilestone({ id: `ms-r6-${n}-${i}`, escrowId, stepId: `step-${i + 1}`, amount: "5.00", status: ms, bondAmount: "0" });
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
    id: "bundle-r6-A",
    jobId,
    stepId: job.stepId,
    kernelId: job.kernelId,
    assuranceTier: 0,
    bundleHash: HASH_A as `sha256:${string}`,
    kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "mock_sig_r6" },
    createdAt: new Date().toISOString(),
    events: [
      {
        id: `ev-r6-${jobId}`,
        type: "execution_started",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev-r6", deviceType: "controller", kernelId: job.kernelId },
        payload: { message: "Job started" },
        hash: `sha256:${"c3".repeat(32)}` as `sha256:${string}`,
      },
    ],
    ...over,
  };
}

describe("N79 round 6: Phase 1 — the review's findings, reproduced", () => {
  let app: FastifyInstance;
  let savedEscrowEnv: string | undefined;
  let savedEasV2Env: string | undefined;

  beforeEach(async () => {
    savedEscrowEnv = process.env.ESCROW_CONTRACT_ADDRESS;
    savedEasV2Env = process.env.PCC_USE_EAS_V2;
    delete process.env.ESCROW_CONTRACT_ADDRESS;
    delete process.env.PCC_USE_EAS_V2;
    vi.mocked(chain.isWriteEnabled).mockReset().mockReturnValue(false);
    vi.mocked(chain.submitEvidence).mockReset();
    vi.mocked(chain.releaseMilestone).mockReset();
    vi.mocked(chain.releaseMilestoneV2).mockReset();
    vi.mocked(chain.getEscrowState).mockReset();
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
    if (savedEasV2Env === undefined) delete process.env.PCC_USE_EAS_V2;
    else process.env.PCC_USE_EAS_V2 = savedEasV2Env;
  });

  // ── R6-H1A: partial persistence still settles ──────────────────────────

  it("R6-H1A (a): insertEvents throwing AFTER the header insert must leave nothing persisted and nothing submitted", async () => {
    const jobId = await submitPaidJob(app, "user-n79r6-h1a-a");
    const address = pointEscrowAtChain(jobId, addr(0xf1a001), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr6h1aa-ev", status: "submitted" } as never);
    vi.mocked(chain.releaseMilestone).mockResolvedValue({ transactionHash: "0xr6h1aa-rel", status: "submitted" } as never);

    const insertEvents = vi.spyOn(getRepos().evidence, "insertEvents").mockImplementation(() => {
      throw new Error("insertEvents failed (simulated)");
    });
    let result;
    try {
      result = await getSettlementService().processEvidence(makeBundle(jobId), jobId, {
        milestoneIndex: 0,
        contractAddress: address,
        autoRelease: true,
        attestation: ATTESTATION(address),
      });
    } finally {
      insertEvents.mockRestore();
    }

    // Correct: nothing persisted means nothing submitted, nothing released, and no pointer.
    expect(chain.submitEvidence).not.toHaveBeenCalled();
    expect(chain.releaseMilestone).not.toHaveBeenCalled();
    expect(result.error).toBe("evidence_persistence_failed");
    const job = getRepos().jobs.findById(jobId)!;
    expect(job.evidenceBundleId).not.toBe("bundle-r6-A");
    expect(job.status).not.toBe("evidence_submitted");
    // Correct: the header and its events are one transaction — a failed events write must leave no header row.
    expect(getRepos().evidence.findById("bundle-r6-A")).toBeUndefined();
  });

  it("R6-H1A (b): a legacy header-without-events row must refuse re-delivery, never heal it and submit", async () => {
    const jobId = await submitPaidJob(app, "user-n79r6-h1a-b");
    const address = pointEscrowAtChain(jobId, addr(0xf1a002), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr6h1ab", status: "submitted" } as never);

    const job = getRepos().jobs.findById(jobId)!;
    // The legacy partial row: header matches exactly what makeBundle(jobId) will submit, but NO events exist for it.
    getRepos().evidence.insert({
      id: "bundle-r6-A",
      jobId,
      stepId: job.stepId,
      kernelId: job.kernelId,
      assuranceTier: 0,
      bundleHash: HASH_A,
      kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "mock_sig_r6" },
      createdAt: new Date().toISOString(),
    });
    expect(getRepos().evidence.findEventsByBundle("bundle-r6-A")).toHaveLength(0);

    const result = await getSettlementService().processEvidence(makeBundle(jobId), jobId, { milestoneIndex: 0, contractAddress: address });

    // Correct: refused, nothing submitted — a header without its events is NOT an exact re-delivery.
    expect(chain.submitEvidence).not.toHaveBeenCalled();
    expect(["evidence_bundle_conflict", "evidence_persistence_failed"]).toContain(result.error);
  });

  // ── R6-H1B: evidence and escrow not bound to the method's job ───────────

  it("R6-H1B (a): a bundle for job A, submitted under job B, must be refused before persistence or chain activity", async () => {
    const jobA = await submitPaidJob(app, "user-n79r6-h1b-a-A");
    const jobB = await submitPaidJob(app, "user-n79r6-h1b-a-B");
    pointEscrowAtChain(jobA, addr(0xf1b001), "v2");
    const addressB = pointEscrowAtChain(jobB, addr(0xf1b002), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr6h1ba", status: "submitted" } as never);
    vi.mocked(chain.releaseMilestone).mockResolvedValue({ transactionHash: "0xr6h1ba-rel", status: "submitted" } as never);

    const bundleForA = makeBundle(jobA);
    const result = await getSettlementService().processEvidence(bundleForA, jobB, {
      milestoneIndex: 0,
      contractAddress: addressB,
      autoRelease: true,
      attestation: ATTESTATION(addressB),
    });

    expect(result.error).toBe("evidence_job_mismatch");
    expect(getRepos().evidence.findById(bundleForA.id)).toBeUndefined();
    expect(chain.submitEvidence).not.toHaveBeenCalled();
    const jobBRow = getRepos().jobs.findById(jobB)!;
    expect(jobBRow.evidenceBundleId).not.toBe(bundleForA.id);
    expect(jobBRow.status).not.toBe("evidence_submitted");
  });

  it("R6-H1B (b): the right job but a mismatched stepId must be refused the same way", async () => {
    const jobId = await submitPaidJob(app, "user-n79r6-h1b-b");
    const address = pointEscrowAtChain(jobId, addr(0xf1b003), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr6h1bb", status: "submitted" } as never);

    const wrongStepBundle = makeBundle(jobId, { stepId: "not-this-jobs-step" });
    const result = await getSettlementService().processEvidence(wrongStepBundle, jobId, { milestoneIndex: 0, contractAddress: address });

    expect(result.error).toBe("evidence_job_mismatch");
    expect(chain.submitEvidence).not.toHaveBeenCalled();
  });

  it("R6-H1B (c): the right bundle for the job, but a DIFFERENT escrow's address, must read escrow_mismatch before anything", async () => {
    const jobA = await submitPaidJob(app, "user-n79r6-h1b-c-A");
    const jobB = await submitPaidJob(app, "user-n79r6-h1b-c-B");
    const addressA = pointEscrowAtChain(jobA, addr(0xf1b004), "v2");
    pointEscrowAtChain(jobB, addr(0xf1b005), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr6h1bc", status: "submitted" } as never);

    // The bundle is exactly right for job B — only the named escrow (A's) is wrong.
    const result = await getSettlementService().processEvidence(makeBundle(jobB), jobB, { milestoneIndex: 0, contractAddress: addressA });

    expect(result.error).toBe("escrow_mismatch");
    expect(chain.submitEvidence).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), addressA);
  });

  // ── R6-H2A: the older writers bypass the mapping checks ─────────────────

  it("R6-H2A (a): resume's completeClaimedEscrow must not complete a 2-local-row escrow off a single chain-Released read", async () => {
    const { jobId } = seed({ milestones: ["funded", "funded"] });
    const address = pointEscrowAtChain(jobId, addr(0xf2a001), "v2");
    // A recorded evidence bundle, as /complete would have left it, so resume can reclaim the job.
    const repos = getRepos();
    repos.evidence.insert({
      id: "bundle-r6-h2a-a",
      jobId,
      stepId: repos.jobs.findById(jobId)!.stepId,
      kernelId: repos.jobs.findById(jobId)!.kernelId,
      assuranceTier: 0,
      bundleHash: HASH_A,
      kernelSignature: { signer: "0x0", algorithm: "secp256k1", value: "sig" },
      createdAt: new Date().toISOString(),
    });
    repos.jobs.update(jobId, { evidenceBundleId: "bundle-r6-h2a-a", status: "evidence_submitted" });

    process.env.PCC_USE_EAS_V2 = "true";
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    // The chain shows ONLY ONE milestone, Released — the keeper would refuse (2 local rows, 1 on chain), but
    // de712589's resume never checks this: driveSettlement reporting settled is enough to complete the WHOLE escrow.
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(chainState(address, [chain.MilestoneStatusV2.Released]));
    vi.mocked(driveSettlement).mockResolvedValue(SETTLED);

    const resumed = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });

    // Correct: the escrow is NOT completed, NEITHER row is stamped, and the escrow stays `completing`. At
    // de712589, resume never reads the mapping at all (driveSettlement is reached, "settled" is returned, and
    // completeClaimedEscrow stamps both local rows and completes the escrow from only ONE chain-confirmed one).
    expect(resumed.statusCode).not.toBe(200);
    expect(escrowState(jobId)).toEqual({ escrow: "completing", milestones: ["funded", "funded"] });
  });

  it("R6-H2A (b): SettlementService.releaseMilestone must not complete the escrow from one local row alone", async () => {
    const { jobId, escrowId, address } = seed({ milestones: ["funded"] }); // ONE local row (the chain, in truth, has two)
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.releaseMilestone).mockResolvedValue({ transactionHash: "0xr6h2ab", status: "submitted" } as never);
    // The post-release V1 read: TWO milestones on chain, index 0 now Released by this call's own write.
    vi.mocked(chain.getEscrowState).mockResolvedValue(chainState(address, [chain.MilestoneStatusV2.Released, chain.MilestoneStatusV2.Attested]) as never);

    const out = await getSettlementService().releaseMilestone(jobId, 0, ATTESTATION(address), address);

    // Correct: the release landed (chain truth), but with only one local row to compare against an UNKNOWN chain
    // count, completion must not be claimed — recorded:false, reconcile:required, escrow stays `completing`.
    expect(out).toEqual(expect.objectContaining({ status: "released", recorded: false, reconcile: "required" }));
    expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded"] });
  });

  it("R6-H2A (c): the raw escrow release route has the same drift as (b), and must refuse completion the same way", async () => {
    const { jobId, escrowId, address } = seed({ milestones: ["funded"] });
    process.env.PCC_USE_EAS_V2 = "true";
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.releaseMilestoneV2).mockResolvedValue({ transactionHash: "0xr6h2ac", status: "submitted" } as never);
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(chainState(address, [chain.MilestoneStatusV2.Released, chain.MilestoneStatusV2.Attested]));

    const res = await app.inject({ method: "POST", url: `/api/escrow/chain/${address}/release/0`, payload: {} });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({ recorded: false, reconcile: "required" }));
    expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded"] });
    void jobId;
  });

  // ── R6-H2B: drift below Released is handed back ─────────────────────────

  it("R6-H2B (a): the keeper must quarantine a cardinality drift that has NO Released milestone, never hand it back", async () => {
    const { jobId, escrowId, address } = seed({ milestones: ["funded"] }); // ONE local row
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    // TWO chain milestones, neither Released: index 0 Attested with its window OPEN, index 1 Funded.
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(
      chainState(address, [chain.MilestoneStatusV2.Attested, chain.MilestoneStatusV2.Funded], { windowOpenIndices: [0] }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    let result;
    try {
      result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
    } finally {
      // asserted before mockRestore (which also clears recorded calls)
      expect(errors).toHaveBeenCalledWith(
        "[escrow] settlement_mapping_mismatch",
        expect.objectContaining({ escrowId, chainCount: 2, localCount: 1 }),
      );
      errors.mockRestore();
    }

    expect(driveSettlement).not.toHaveBeenCalled();
    expect((result as unknown as { mappingMismatch?: number }).mappingMismatch).toBe(1);
    // Correct: quarantined in `completing`, never handed back toward a refund.
    expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded"] });
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );
  });

  it("R6-H2B (b): the keeper must quarantine an identity drift (same count, wrong stepId) the same way", async () => {
    const { jobId, escrowId, address } = seed({ milestones: ["funded"] }); // ONE local row, stepId "step-1"
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    // SAME count (1), but index 0's stepId is not this row's — Attested, window open.
    const wrongStepId = keccak256(toBytes("step-SOMETHING-ELSE")) as Hex;
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(
      chainState(address, [chain.MilestoneStatusV2.Attested], { stepIdOverrides: { 0: wrongStepId }, windowOpenIndices: [0] }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    let result;
    try {
      result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
    } finally {
      expect(errors).toHaveBeenCalledWith(
        "[escrow] settlement_mapping_mismatch",
        expect.objectContaining({ escrowId, chainCount: 1, localCount: 1 }),
      );
      errors.mockRestore();
    }

    expect(driveSettlement).not.toHaveBeenCalled();
    expect((result as unknown as { mappingMismatch?: number }).mappingMismatch).toBe(1);
    expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded"] });
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );
  });

  it("R6-H2B (c): resume must read the mapping and refuse to drive at all when it drifts", async () => {
    const jobId = await submitPaidJob(app, "user-n79r6-h2b-c"); // ONE local row
    const address = pointEscrowAtChain(jobId, addr(0xf2b003), "v2");
    const repos = getRepos();
    repos.evidence.insert({
      id: "bundle-r6-h2b-c",
      jobId,
      stepId: repos.jobs.findById(jobId)!.stepId,
      kernelId: repos.jobs.findById(jobId)!.kernelId,
      assuranceTier: 0,
      bundleHash: HASH_A,
      kernelSignature: { signer: "0x0", algorithm: "secp256k1", value: "sig" },
      createdAt: new Date().toISOString(),
    });
    repos.jobs.update(jobId, { evidenceBundleId: "bundle-r6-h2b-c", status: "evidence_submitted" });

    process.env.PCC_USE_EAS_V2 = "true";
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    // The chain, in truth, has TWO milestones (this job's local row count is one) — a cardinality drift resume
    // never looks for at de712589, since it never reads the mapping before driving at all.
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(chainState(address, [chain.MilestoneStatusV2.Attested, chain.MilestoneStatusV2.Funded]));
    vi.mocked(driveSettlement).mockResolvedValue(SETTLED);

    const resumed = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });

    // Correct: driveSettlement is never called; the response names the drift (409).
    expect(driveSettlement).not.toHaveBeenCalled();
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json()).toEqual(expect.objectContaining({ error: "escrow_mapping_drift" }));
  });
});

describe("N79 round 6: Phase 2 — addendum 1 properties", () => {
  let app: FastifyInstance;
  let savedEscrowEnv: string | undefined;
  let savedEasV2Env: string | undefined;

  beforeEach(async () => {
    savedEscrowEnv = process.env.ESCROW_CONTRACT_ADDRESS;
    savedEasV2Env = process.env.PCC_USE_EAS_V2;
    delete process.env.ESCROW_CONTRACT_ADDRESS;
    delete process.env.PCC_USE_EAS_V2;
    vi.mocked(chain.isWriteEnabled).mockReset().mockReturnValue(false);
    vi.mocked(chain.submitEvidence).mockReset();
    vi.mocked(chain.releaseMilestone).mockReset();
    vi.mocked(chain.releaseMilestoneV2).mockReset();
    vi.mocked(chain.getEscrowState).mockReset();
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
    if (savedEasV2Env === undefined) delete process.env.PCC_USE_EAS_V2;
    else process.env.PCC_USE_EAS_V2 = savedEasV2Env;
  });

  it("P1 (structural): every chain-backed call site uses ONLY recordChainSettlement / recordMockEscrowReleased", () => {
    const here = dirname(fileURLToPath(import.meta.url)); // .../src/__tests__
    const srcDir = resolve(here, "..");
    const callSites = [
      "services/settlement-service.ts",
      "services/settlement-keeper.ts",
      "routes/paid-job-flow.ts",
      "routes/escrow.ts",
    ];
    const forbidden: Array<[string, RegExp]> = [
      ["recordMilestoneReleased(", /\brecordMilestoneReleased\s*\(/],
      ["recordMilestoneRowReleased(", /\brecordMilestoneRowReleased\s*\(/],
      ["recordEscrowReleased(", /\brecordEscrowReleased\s*\(/],
    ];
    const required = [/\brecordChainSettlement\s*\(/, /\brecordMockEscrowReleased\s*\(/];
    // Strip comments before matching: a doc comment may legitimately NAME the old function (explaining why it
    // was superseded) without that being a call site. Naive (good enough for this codebase's style) — block
    // comments, then line comments.
    const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    for (const rel of callSites) {
      const text = stripComments(readFileSync(join(srcDir, rel), "utf8"));
      for (const [label, pattern] of forbidden) {
        expect(pattern.test(text), `${rel} must not call the unguarded legacy writer ${label}`).toBe(false);
      }
      expect(
        required.some((p) => p.test(text)),
        `${rel} must call recordChainSettlement or recordMockEscrowReleased`,
      ).toBe(true);
    }

    // The guarded writers themselves are the only place left that sets a milestone row to "released" or
    // compare-and-sets an escrow row to "completed" that these four call sites could ever reach — verified by
    // extracting each function's own body (brace-matched) and requiring the write inside it.
    const refundText = readFileSync(join(srcDir, "services/escrow-refund.ts"), "utf8");
    function functionBody(fnName: string): string {
      const marker = `export function ${fnName}(`;
      const start = refundText.indexOf(marker);
      expect(start, `${fnName} must be defined in escrow-refund.ts`).toBeGreaterThan(-1);
      let depth = 0;
      let i = refundText.indexOf("{", start);
      const bodyStart = i;
      for (; i < refundText.length; i++) {
        if (refundText[i] === "{") depth++;
        else if (refundText[i] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      return refundText.slice(bodyStart, i + 1);
    }
    expect(functionBody("recordChainSettlement")).toMatch(/updateMilestoneStatus\([^)]*"released"\)/);
    expect(functionBody("recordChainSettlement")).toMatch(/casEscrowStatus\([^)]*"completed"/);
    expect(functionBody("recordMockEscrowReleased")).toMatch(/updateMilestoneStatus\([^)]*"released"\)/);
    expect(functionBody("recordMockEscrowReleased")).toMatch(/casEscrowStatus\([^)]*"completed"/);

    // Lead addendum (P1 hardening, steward #5849): a GENERAL sweep, not just the four named call sites — NO
    // exported function anywhere in escrow-refund.ts, other than these two, may write a milestone row to
    // "released" or compare-and-set an escrow row to "completed". `releaseEscrowFromSettlement` (restore-to-
    // prior from `claim.prior`, never the literal "completed"; no chain read) is explicitly allowed through —
    // confirmed below by name, not just by omission, so a future rename of a NEW unguarded writer can't dodge
    // this sweep by avoiding the two allow-listed names.
    const allowedWriters = new Set(["recordChainSettlement", "recordMockEscrowReleased"]);
    const exportedFnNames = [...refundText.matchAll(/^export function (\w+)\(/gm)].map((m) => m[1]!);
    expect(exportedFnNames, "the scan must actually find escrow-refund.ts's exported functions").toContain("releaseEscrowFromSettlement");
    expect(exportedFnNames.length).toBeGreaterThan(8);
    for (const fnName of exportedFnNames) {
      if (allowedWriters.has(fnName)) continue;
      const body = functionBody(fnName);
      expect(body, `${fnName} must not write a milestone row to "released" — only recordChainSettlement/recordMockEscrowReleased may`).not.toMatch(
        /updateMilestoneStatus\([^)]*"released"\)/,
      );
      expect(body, `${fnName} must not compare-and-set an escrow row to "completed" — only recordChainSettlement/recordMockEscrowReleased may`).not.toMatch(
        /casEscrowStatus\([^)]*"completed"/,
      );
    }
  });

  it("P2: a mismatch on ANY bound field (job, step, kernel, tier, escrow target) gives zero DB writes and zero chain calls", async () => {
    let n = 0;
    const cases: Array<{ name: string; setup: () => Promise<{ bundle: EvidenceBundle; targetJobId: string; contractAddress: string }> }> = [
      {
        name: "job",
        setup: async () => {
          n += 1;
          const jobA = await submitPaidJob(app, `user-p2-job-A-${n}`);
          const jobB = await submitPaidJob(app, `user-p2-job-B-${n}`);
          pointEscrowAtChain(jobA, addr(0xfa0000 + n * 2), "v2");
          const addressB = pointEscrowAtChain(jobB, addr(0xfa0000 + n * 2 + 1), "v2");
          return { bundle: makeBundle(jobA, { id: `bundle-p2-job-${n}` }), targetJobId: jobB, contractAddress: addressB };
        },
      },
      {
        name: "step",
        setup: async () => {
          n += 1;
          const jobId = await submitPaidJob(app, `user-p2-step-${n}`);
          const address = pointEscrowAtChain(jobId, addr(0xfa0000 + n * 2), "v2");
          return { bundle: makeBundle(jobId, { id: `bundle-p2-step-${n}`, stepId: "not-this-jobs-step" }), targetJobId: jobId, contractAddress: address };
        },
      },
      {
        name: "kernel",
        setup: async () => {
          n += 1;
          const jobId = await submitPaidJob(app, `user-p2-kernel-${n}`);
          const address = pointEscrowAtChain(jobId, addr(0xfa0000 + n * 2), "v2");
          return { bundle: makeBundle(jobId, { id: `bundle-p2-kernel-${n}`, kernelId: "not-this-jobs-kernel" }), targetJobId: jobId, contractAddress: address };
        },
      },
      {
        name: "tier",
        setup: async () => {
          n += 1;
          const jobId = await submitPaidJob(app, `user-p2-tier-${n}`);
          const address = pointEscrowAtChain(jobId, addr(0xfa0000 + n * 2), "v2");
          return { bundle: makeBundle(jobId, { id: `bundle-p2-tier-${n}`, assuranceTier: 2 }), targetJobId: jobId, contractAddress: address };
        },
      },
      {
        name: "escrow",
        setup: async () => {
          n += 1;
          const jobA = await submitPaidJob(app, `user-p2-escrow-A-${n}`);
          const jobB = await submitPaidJob(app, `user-p2-escrow-B-${n}`);
          const addressA = pointEscrowAtChain(jobA, addr(0xfa0000 + n * 2), "v2");
          pointEscrowAtChain(jobB, addr(0xfa0000 + n * 2 + 1), "v2");
          return { bundle: makeBundle(jobB, { id: `bundle-p2-escrow-${n}` }), targetJobId: jobB, contractAddress: addressA };
        },
      },
    ];

    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    for (const { name, setup } of cases) {
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: `0xp2-${name}`, status: "submitted" } as never);
      const { bundle, targetJobId, contractAddress } = await setup();

      const result = await getSettlementService().processEvidence(bundle, targetJobId, { milestoneIndex: 0, contractAddress });

      expect(["evidence_job_mismatch", "escrow_mismatch"], name).toContain(result.error);
      expect(chain.submitEvidence, name).not.toHaveBeenCalled();
      expect(getRepos().evidence.findById(bundle.id), name).toBeUndefined();
    }
  });

  it("P3: a failure at the header write, or at the (batched) events write, leaves no row and no chain call", async () => {
    // The implementation writes the header then ALL events in ONE batched insert — so "the first event" and
    // "the last event" collapse to the SAME injection point here (one statement, atomic): both are exercised
    // as "events" below. A bundle with two events pins that the whole batch is one unit.
    const points: Array<{ name: string; makeSpy: () => ReturnType<typeof vi.spyOn> }> = [
      { name: "header", makeSpy: () => vi.spyOn(getRepos().evidence, "insert").mockImplementation(() => { throw new Error("disk full (header)"); }) },
      { name: "events", makeSpy: () => vi.spyOn(getRepos().evidence, "insertEvents").mockImplementation(() => { throw new Error("disk full (events)"); }) },
    ];

    let n = 0;
    for (const { name, makeSpy } of points) {
      n += 1;
      const jobId = await submitPaidJob(app, `user-p3-${name}`);
      const address = pointEscrowAtChain(jobId, addr(0xfc0000 + n), "v2");
      vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: `0xp3-${name}`, status: "submitted" } as never);

      const bundleId = `bundle-p3-${name}`;
      const twoEventBundle = makeBundle(jobId, {
        id: bundleId,
        events: [
          { id: `ev-p3-${name}-1`, type: "execution_started", timestamp: new Date().toISOString(), source: { deviceId: "d1", deviceType: "controller", kernelId: "kernel-nyc" }, payload: {}, hash: `sha256:${"11".repeat(32)}` as `sha256:${string}` },
          { id: `ev-p3-${name}-2`, type: "execution_completed", timestamp: new Date().toISOString(), source: { deviceId: "d1", deviceType: "controller", kernelId: "kernel-nyc" }, payload: {}, hash: `sha256:${"22".repeat(32)}` as `sha256:${string}` },
        ],
      });

      const spy = makeSpy();
      let result;
      try {
        result = await getSettlementService().processEvidence(twoEventBundle, jobId, { milestoneIndex: 0, contractAddress: address });
      } finally {
        spy.mockRestore();
      }

      expect(result.error, name).toBe("evidence_persistence_failed");
      expect(chain.submitEvidence, name).not.toHaveBeenCalled();
      expect(getRepos().evidence.findById(bundleId), name).toBeUndefined();
      expect(getRepos().evidence.findEventsByBundle(bundleId), name).toHaveLength(0);
    }
  });

  it("P4: every drift kind (chain has more, local has more, identity, reorder), at any status mix, quarantines — never a hand-back", async () => {
    const REL = chain.MilestoneStatusV2.Released;
    const FUN = chain.MilestoneStatusV2.Funded;
    const EVD = chain.MilestoneStatusV2.Evidenced;
    const ATT = chain.MilestoneStatusV2.Attested;

    const cases: Array<{
      name: string;
      localMilestones: string[];
      chainStatuses: number[];
      opts?: Parameters<typeof chainState>[2];
    }> = [
      { name: "chain has more, all below Released", localMilestones: ["funded"], chainStatuses: [ATT, FUN], opts: { windowOpenIndices: [0] } },
      { name: "chain has more, one Released", localMilestones: ["funded"], chainStatuses: [REL, FUN] },
      { name: "local has more", localMilestones: ["funded", "funded"], chainStatuses: [REL] },
      { name: "identity mismatch, same count", localMilestones: ["funded"], chainStatuses: [EVD], opts: { stepIdOverrides: { 0: keccak256(toBytes("step-SOMETHING-ELSE")) as Hex } } },
      {
        name: "reorder (same identity set, swapped per-index)",
        localMilestones: ["funded", "funded"],
        chainStatuses: [FUN, FUN],
        opts: { stepIdOverrides: { 0: keccak256(toBytes("step-2")) as Hex, 1: keccak256(toBytes("step-1")) as Hex } },
      },
    ];

    // A fresh store per case: a quarantined escrow stays `completing` (not terminal), so it would otherwise be
    // re-swept by every later case too (the mock's chain state is not address-specific) and inflate the counts.
    for (const c of cases) {
      closeStore();
      process.env.PCC_DB_PATH = ":memory:";
      initStore({ seed: true });

      const { jobId, escrowId, address } = seed({ milestones: c.localMilestones });
      vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
      vi.mocked(chain.getEscrowStateV2).mockResolvedValue(chainState(address, c.chainStatuses, c.opts));
      vi.mocked(driveSettlement).mockClear();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      let result;
      try {
        result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
        expect(errors, c.name).toHaveBeenCalledWith("[escrow] settlement_mapping_mismatch", expect.objectContaining({ escrowId }));
      } finally {
        errors.mockRestore();
      }

      expect(driveSettlement, c.name).not.toHaveBeenCalled();
      expect(result.mappingMismatch, c.name).toBe(1);
      expect(rows(escrowId), c.name).toEqual({ escrow: "completing", milestones: c.localMilestones });
      expect(setJobStatusWithRefund(jobId, "failed").escrowRefund, c.name).toEqual(
        expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
      );
    }
  });

  it("P4 (resume, a second read site): an identity drift is quarantined before the first drive too", async () => {
    const jobId = await submitPaidJob(app, "user-p4-resume-identity");
    const address = pointEscrowAtChain(jobId, addr(0xfd0001), "v2");
    const repos = getRepos();
    repos.evidence.insert({
      id: "bundle-p4-resume-identity",
      jobId,
      stepId: repos.jobs.findById(jobId)!.stepId,
      kernelId: repos.jobs.findById(jobId)!.kernelId,
      assuranceTier: 0,
      bundleHash: HASH_A,
      kernelSignature: { signer: "0x0", algorithm: "secp256k1", value: "sig" },
      createdAt: new Date().toISOString(),
    });
    repos.jobs.update(jobId, { evidenceBundleId: "bundle-p4-resume-identity", status: "evidence_submitted" });

    process.env.PCC_USE_EAS_V2 = "true";
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    // ONE chain milestone (matching cardinality), but the WRONG stepId — identity drift, not cardinality.
    const wrongStepId = keccak256(toBytes("step-SOMETHING-ELSE")) as Hex;
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(
      chainState(address, [chain.MilestoneStatusV2.Attested], { stepIdOverrides: { 0: wrongStepId } }),
    );
    vi.mocked(driveSettlement).mockResolvedValue(SETTLED);

    const resumed = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });

    expect(driveSettlement).not.toHaveBeenCalled();
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json()).toEqual(expect.objectContaining({ error: "escrow_mapping_drift" }));
  });

  // ── Lead addendum 2 (review of the source diff): two fail-closed gaps ───

  it("addendum 2 (1): resume's pre-drive read failing is UNVERIFIED, not 'no drift' — never drives, 503s", async () => {
    const jobId = await submitPaidJob(app, "user-addendum2-resume-unverified");
    pointEscrowAtChain(jobId, addr(0xfe0001), "v2");
    const repos = getRepos();
    repos.evidence.insert({
      id: "bundle-addendum2-resume",
      jobId,
      stepId: repos.jobs.findById(jobId)!.stepId,
      kernelId: repos.jobs.findById(jobId)!.kernelId,
      assuranceTier: 0,
      bundleHash: HASH_A,
      kernelSignature: { signer: "0x0", algorithm: "secp256k1", value: "sig" },
      createdAt: new Date().toISOString(),
    });
    repos.jobs.update(jobId, { evidenceBundleId: "bundle-addendum2-resume", status: "evidence_submitted" });

    process.env.PCC_USE_EAS_V2 = "true";
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.getEscrowStateV2).mockRejectedValue(new Error("rpc down"));

    const resumed = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });

    expect(driveSettlement).not.toHaveBeenCalled();
    expect(resumed.statusCode).toBe(503);
    expect(resumed.json()).toEqual(expect.objectContaining({ error: "escrow_mapping_unverified" }));
  });

  it("addendum 2 (2): processEvidence's bind-first lookup failing returns evidence_job_unverifiable, never throws, touches nothing", async () => {
    const jobId = await submitPaidJob(app, "user-addendum2-bind-unverifiable");
    const address = pointEscrowAtChain(jobId, addr(0xfe0002), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xaddendum2", status: "submitted" } as never);
    const bundle = makeBundle(jobId, { id: "bundle-addendum2-bind" }); // built BEFORE the spy — makeBundle itself reads the job

    const findById = vi.spyOn(getRepos().jobs, "findById").mockImplementation(() => {
      throw new Error("store unavailable");
    });
    let result;
    try {
      result = await getSettlementService().processEvidence(bundle, jobId, {
        milestoneIndex: 0,
        contractAddress: address,
      });
    } finally {
      findById.mockRestore();
    }

    expect(result.error).toBe("evidence_job_unverifiable");
    expect(chain.submitEvidence).not.toHaveBeenCalled();
    expect(getRepos().evidence.findById("bundle-addendum2-bind")).toBeUndefined();
  });
});
