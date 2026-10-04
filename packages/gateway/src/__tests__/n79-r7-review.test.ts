/**
 * N79 round 7 (astra pack 126g, verdict DO-NOT-SHIP on 2488ce19).
 *
 * PHASE 1: one test per finding, under "N79 round 7: Phase 1". Each asserts the CORRECT behaviour, so each fails
 * at 2488ce19 on the finding's own assertion:
 *
 *   R7-H1: processEvidence does not bind the supplied milestoneIndex to the job's own step — two jobs sharing one
 *          escrow, evidence correctly bound for job A's step but with job B's index, must make no chain call.
 *   R7-H2: the escrow-target check only runs `if (jobOwnEscrow)` — a job with NO escrow row lets an unrelated
 *          contractAddress straight through to the chain.
 *   R7-H3a: "exact re-delivery" omits kernelSignature and createdAt from the header comparison.
 *   R7-H3b: the event comparison is `length + every(...some(...))`, not a bijection — [A,A] can pass against [A,B].
 *   R7-M1: checkChainMapping never requires statuses.length === stepIds.length.
 *
 * PHASE 2 property tests (P2/P3/P4) follow under "N79 round 7: Phase 2 properties", added once the fix lands.
 * T1/T2/T3 (126h addendum 1 test-hardening) live in n79-r6-review.test.ts, beside the tests they harden.
 *
 * The real in-memory store throughout. Only the chain, and the settlement crank, are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getAddress, keccak256, toBytes, type Hex } from "viem";
import type { EvidenceBundle } from "@pcc/spec";

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_r7", metadataCid: "bafymeta_n79_r7" }),
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
import {
  beginSettlement,
  checkChainMapping,
  escrowForJob,
  recordChainSettlement,
  type SettlementClaim,
} from "../services/escrow-refund.js";
import { getSettlementService } from "../services/settlement-service.js";
import { driveSettlement } from "../services/settlement-crank.js";
import * as chain from "../contracts/escrow-client.js";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
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

/** Point job B's negotiation session at job A's cwm, so both resolve to the SAME escrow row (escrowForJob), then
 *  add a second local milestone row for B's own step — the shared escrow now has 2 rows: index 0 = A's step
 *  (whatever submitPaidJob gave it), index 1 = B's step. */
function shareEscrowAcrossJobs(jobAId: string, jobBId: string): void {
  const sessA = getStore().db.select().from(schema.negotiationSessions).where(eq(schema.negotiationSessions.jobId, jobAId)).get()!;
  const escrow = getRepos().escrows.findByCwm(sessA.cwmId)!;
  getStore().db.update(schema.negotiationSessions).set({ cwmId: sessA.cwmId }).where(eq(schema.negotiationSessions.jobId, jobBId)).run();
  const jobB = getRepos().jobs.findById(jobBId)!;
  getRepos().escrows.insertMilestone({ id: `ms-r7-shared-${jobBId}`, escrowId: escrow.id, stepId: jobB.stepId, amount: "5.00", status: "funded", bondAmount: "0" });
}

/** A job row with NO negotiation session and so NO escrow (escrowForJob returns undefined) — R7-H2's setup. */
let seq = 0;
function seedBareJob(): { jobId: string; stepId: string; kernelId: string } {
  const repos = getRepos();
  const n = ++seq;
  const jobId = `job-r7-bare-${n}`;
  const stepId = `step-r7-bare-${n}`;
  const capability = repos.capabilities.findAll()[0]!;
  repos.jobs.insert({
    id: jobId,
    stepId,
    cwmId: `cwm-r7-bare-${n}`,
    capabilityId: capability.id,
    kernelId: capability.kernelId,
    status: "in_progress",
    assignedDevices: [],
  });
  return { jobId, stepId, kernelId: capability.kernelId };
}

/** A job + negotiation session + escrow (+ milestones), linked the way the settlement read links them. Mirrors
 *  r4/r5/r6's `seed()` helper (same shape) under an `r7` prefix so fixtures never collide across suites. */
function seed(opts: { status?: string; jobStatus?: string; milestones?: string[]; address?: string } = {}) {
  const repos = getRepos();
  const n = ++seq;
  const jobId = `job-r7-${n}`;
  const cwmId = `cwm-r7-${n}`;
  const capability = repos.capabilities.findAll()[0]!;
  const now = new Date().toISOString();
  const status = opts.status ?? "funded";
  const address = opts.address ?? addr(0xe7000 + n);
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
      id: `sess-r7-${n}`,
      status: "committed",
      userAgentId: "user-r7",
      kernelId: capability.kernelId,
      capabilityType: capability.type,
      operatorConstraints: {},
      jobId,
      cwmId,
      createdAt: now,
      expiresAt: now,
    })
    .run();
  const escrowId = `esc-r7-${n}`;
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
    repos.escrows.insertMilestone({ id: `ms-r7-${n}-${i}`, escrowId, stepId: `step-${i + 1}`, amount: "5.00", status: ms, bondAmount: "0" });
  });
  return { jobId, escrowId, address, cwmId };
}

/** A minimal V1-shaped chain read whose milestone at `index` carries `jobStepId`'s on-chain identity — what
 *  `verifyDerivedMilestoneOnChain` (settlement-service.ts, N79 round 7 P2) reads right before Step 3's submit
 *  and before any auto-release, for the no-row env-default path (always v1-style) and for an escrow row whose
 *  OWN version is "v1", null, or undefined. NOT for a "v2" row — see {@link v2ChainStateFor} (lead round-7
 *  addendum: read with the reader the escrow's OWN version names, not the one the eventual write call uses). */
function v1ChainStateFor(jobStepId: string, address: string, index = 0, count = 1) {
  return {
    address,
    payer: addr(0xaa),
    arbiter: addr(0xbb),
    token: addr(0xcc),
    cwmId: `0x${"00".repeat(32)}`,
    funded: true,
    totalAmount: "10",
    milestoneCount: count,
    milestones: Array.from({ length: count }, (_, i) => ({
      stepId: i === index ? keccak256(toBytes(jobStepId)) : keccak256(toBytes(`unrelated-${i}`)),
      operator: addr(0),
      amount: "10",
      operatorBond: "0",
      status: 1,
      statusName: "",
      evidenceBundleHash: `0x${"00".repeat(32)}`,
      verifierAttestationHash: `0x${"00".repeat(32)}`,
      challengeWindowEnd: 0,
      challengeWindowSeconds: 0,
    })),
  } as never;
}

/** The V2 counterpart of {@link v1ChainStateFor} — for an escrow row whose OWN version is "v2", read through
 *  `getEscrowStateV2` per the lead's round-7 addendum (decoding a V2 clone through the V1 ABI's shorter tuple
 *  is plausible but unproven live; a wrong decode would fail closed every V2 job's evidence submit). */
function v2ChainStateFor(jobStepId: string, address: string, index = 0, count = 1) {
  return {
    address,
    payer: addr(0xaa),
    arbiter: addr(0xbb),
    token: addr(0xcc),
    cwmId: `0x${"00".repeat(32)}`,
    funded: true,
    totalAmount: "10",
    milestoneCount: count,
    milestones: Array.from({ length: count }, (_, i) => ({
      stepId: i === index ? keccak256(toBytes(jobStepId)) : keccak256(toBytes(`unrelated-${i}`)),
      operator: addr(0),
      amount: "10",
      operatorBond: "0",
      status: 1,
      statusName: "",
      evidenceBundleHash: `0x${"00".repeat(32)}`,
      verifierAttestationHash: `0x${"00".repeat(32)}`,
      challengeWindowEnd: 0,
      challengeWindowSeconds: 0,
      requiredTier: 0,
      jobIdHash: `0x${"00".repeat(32)}`,
      verifierAttestationUid: `0x${"00".repeat(32)}`,
    })),
  } as never;
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
    id: "bundle-r7-A",
    jobId,
    stepId: job.stepId,
    kernelId: job.kernelId,
    assuranceTier: 0,
    bundleHash: HASH_A as `sha256:${string}`,
    kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "mock_sig_r7" },
    createdAt: new Date().toISOString(),
    events: [
      {
        id: `ev-r7-${jobId}`,
        type: "execution_started",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev-r7", deviceType: "controller", kernelId: job.kernelId },
        payload: { message: "Job started" },
        hash: `sha256:${"c3".repeat(32)}` as `sha256:${string}`,
      },
    ],
    ...over,
  };
}

describe("N79 round 7: Phase 1 — the review's findings, reproduced", () => {
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
    await app.close();
    closeStore();
    if (savedEscrowEnv === undefined) delete process.env.ESCROW_CONTRACT_ADDRESS;
    else process.env.ESCROW_CONTRACT_ADDRESS = savedEscrowEnv;
    if (savedEasV2Env === undefined) delete process.env.PCC_USE_EAS_V2;
    else process.env.PCC_USE_EAS_V2 = savedEasV2Env;
  });

  it("R7-H1: a bundle correctly bound to job A's step, but milestoneIndex pointing at job B's index, must make no chain call", async () => {
    const jobA = await submitPaidJob(app, "user-n79r7-h1-A");
    const jobB = await submitPaidJob(app, "user-n79r7-h1-B");
    shareEscrowAcrossJobs(jobA, jobB); // shared escrow: index 0 = A's step, index 1 = B's step
    const address = pointEscrowAtChain(jobA, addr(0xf7a001), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr7h1-ev", status: "submitted" } as never);
    vi.mocked(chain.releaseMilestone).mockResolvedValue({ transactionHash: "0xr7h1-rel", status: "submitted" } as never);

    const bundleForA = makeBundle(jobA, { id: "bundle-r7-h1" });
    const result = await getSettlementService().processEvidence(bundleForA, jobA, {
      milestoneIndex: 1, // job B's index — NOT job A's own derived index (0)
      contractAddress: address,
      autoRelease: true,
      attestation: ATTESTATION(address),
    });

    // Correct: NO chain call; the job is not pointed; no auto-release.
    expect(chain.submitEvidence).not.toHaveBeenCalled();
    expect(chain.releaseMilestone).not.toHaveBeenCalled();
    const jobARow = getRepos().jobs.findById(jobA)!;
    expect(jobARow.evidenceBundleId).not.toBe(bundleForA.id);
    expect(jobARow.status).not.toBe("evidence_submitted");
    void result;
  });

  it("R7-H2: a job with NO escrow row must refuse an unrelated contractAddress with zero persistence and zero chain activity", async () => {
    const { jobId } = seedBareJob(); // no negotiation session, no escrow row at all
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr7h2", status: "submitted" } as never);

    const bundle = makeBundle(jobId, { id: "bundle-r7-h2" });
    const result = await getSettlementService().processEvidence(bundle, jobId, {
      milestoneIndex: 0,
      contractAddress: addr(0xf7b002), // unrelated — not the (unset) env default
    });

    expect(chain.submitEvidence).not.toHaveBeenCalled();
    expect(getRepos().evidence.findById(bundle.id)).toBeUndefined();
    const jobRow = getRepos().jobs.findById(jobId)!;
    expect(jobRow.evidenceBundleId).not.toBe(bundle.id);
    void result;
  });

  it("R7-H3a (kernelSignature): re-delivery with a different kernelSignature must conflict, never re-touch the chain", async () => {
    const jobId = await submitPaidJob(app, "user-n79r7-h3a-sig");
    const address = pointEscrowAtChain(jobId, addr(0xf7c001), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr7h3a-sig", status: "submitted" } as never);
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(v2ChainStateFor(getRepos().jobs.findById(jobId)!.stepId, address));

    // N79 round 8, lead review iteration 2, item 5(iv) (determinism sweep): createdAt pinned identically on
    // BOTH calls — makeBundle()'s own default is `new Date().toISOString()`, which would otherwise ALSO differ
    // between these two calls (real time elapses between them) and mask whether kernelSignature's own check
    // does any work at all. The event is ALSO pinned to the SAME object (reused, not independently
    // reconstructed): makeBundle()'s default event timestamp is `new Date().toISOString()` too, and this test
    // previously left it unpinned — under full-suite load the two independent `new Date()` reads could land on
    // the same millisecond (masking whether kernelSignature was the actual reason for the conflict) or, if the
    // SUITE were ever slow enough to straddle a millisecond there AS WELL, the event mismatch alone would still
    // produce "conflict" and this test would falsely read as passing for the wrong reason either way — it
    // never actually isolated kernelSignature. Reusing one event object makes the ONLY difference between the
    // two deliveries the one this test names.
    const pinnedCreatedAt = "2026-01-01T00:00:00.000Z";
    const pinnedEvent = {
      id: `ev-r7-${jobId}`,
      type: "execution_started" as const,
      timestamp: "2026-01-01T00:00:00.000Z",
      source: { deviceId: "dev-r7", deviceType: "controller" as const, kernelId: getRepos().jobs.findById(jobId)!.kernelId },
      payload: { message: "Job started" },
      hash: `sha256:${"c3".repeat(32)}` as `sha256:${string}`,
    };
    const bundleX = makeBundle(jobId, { id: "bundle-r7-h3a-sig", createdAt: pinnedCreatedAt, events: [pinnedEvent] });
    const first = await getSettlementService().processEvidence(bundleX, jobId, { milestoneIndex: 0, contractAddress: address });
    expect(first.error).toBeUndefined();
    expect(chain.submitEvidence).toHaveBeenCalledTimes(1);

    const redelivered = makeBundle(jobId, {
      id: "bundle-r7-h3a-sig",
      createdAt: pinnedCreatedAt,
      events: [pinnedEvent],
      kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "DIFFERENT_SIG" },
    });
    const second = await getSettlementService().processEvidence(redelivered, jobId, { milestoneIndex: 0, contractAddress: address });

    expect(second.error).toBe("evidence_bundle_conflict");
    expect(chain.submitEvidence).toHaveBeenCalledTimes(1); // no SECOND chain call
  });

  it("R7-H3a (createdAt): re-delivery with a different createdAt must conflict, never re-touch the chain", async () => {
    const jobId = await submitPaidJob(app, "user-n79r7-h3a-created");
    const address = pointEscrowAtChain(jobId, addr(0xf7c002), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr7h3a-created", status: "submitted" } as never);
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(v2ChainStateFor(getRepos().jobs.findById(jobId)!.stepId, address));

    // N79 round 8, lead review iteration 2, item 5(iv) (determinism sweep): the event is pinned to the SAME
    // object on both deliveries, same reasoning as R7-H3a (kernelSignature) above — this test's own createdAt
    // mismatch already guarantees "conflict" regardless (so it was never flaky), but it did not actually
    // isolate createdAt as cleanly as its name claims while the event timestamp was free to vary too.
    const pinnedEvent = {
      id: `ev-r7-${jobId}`,
      type: "execution_started" as const,
      timestamp: "2026-01-01T00:00:00.000Z",
      source: { deviceId: "dev-r7", deviceType: "controller" as const, kernelId: getRepos().jobs.findById(jobId)!.kernelId },
      payload: { message: "Job started" },
      hash: `sha256:${"c3".repeat(32)}` as `sha256:${string}`,
    };
    const bundleX = makeBundle(jobId, { id: "bundle-r7-h3a-created", createdAt: "2026-01-01T00:00:00.000Z", events: [pinnedEvent] });
    const first = await getSettlementService().processEvidence(bundleX, jobId, { milestoneIndex: 0, contractAddress: address });
    expect(first.error).toBeUndefined();
    expect(chain.submitEvidence).toHaveBeenCalledTimes(1);

    const redelivered = makeBundle(jobId, { id: "bundle-r7-h3a-created", createdAt: "2026-06-06T00:00:00.000Z", events: [pinnedEvent] });
    const second = await getSettlementService().processEvidence(redelivered, jobId, { milestoneIndex: 0, contractAddress: address });

    expect(second.error).toBe("evidence_bundle_conflict");
    expect(chain.submitEvidence).toHaveBeenCalledTimes(1);
  });

  it("R7-H3b: re-delivery with events [A,A] against a stored [A,B] must conflict, never re-touch the chain", async () => {
    const jobId = await submitPaidJob(app, "user-n79r7-h3b");
    const address = pointEscrowAtChain(jobId, addr(0xf7c003), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr7h3b", status: "submitted" } as never);
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(v2ChainStateFor(getRepos().jobs.findById(jobId)!.stepId, address));

    const eventA = { id: "ev-r7-h3b-A", type: "execution_started", timestamp: new Date().toISOString(), source: { deviceId: "d1", deviceType: "controller", kernelId: "kernel-nyc" }, payload: {}, hash: `sha256:${"aa".repeat(32)}` as `sha256:${string}` };
    const eventB = { id: "ev-r7-h3b-B", type: "execution_completed", timestamp: new Date().toISOString(), source: { deviceId: "d1", deviceType: "controller", kernelId: "kernel-nyc" }, payload: {}, hash: `sha256:${"bb".repeat(32)}` as `sha256:${string}` };

    // createdAt pinned identically on both calls — see R7-H3a (kernelSignature)'s comment above for why.
    const pinnedCreatedAt = "2026-01-01T00:00:00.000Z";
    const bundleX = makeBundle(jobId, { id: "bundle-r7-h3b", createdAt: pinnedCreatedAt, events: [eventA, eventB] });
    const first = await getSettlementService().processEvidence(bundleX, jobId, { milestoneIndex: 0, contractAddress: address });
    expect(first.error).toBeUndefined();
    expect(chain.submitEvidence).toHaveBeenCalledTimes(1);

    const redelivered = makeBundle(jobId, { id: "bundle-r7-h3b", createdAt: pinnedCreatedAt, events: [eventA, { ...eventA }] }); // [A, A] — two copies of A
    const second = await getSettlementService().processEvidence(redelivered, jobId, { milestoneIndex: 0, contractAddress: address });

    expect(second.error).toBe("evidence_bundle_conflict");
    expect(chain.submitEvidence).toHaveBeenCalledTimes(1);
  });

  it("R7-M1: recordChainSettlement with statuses:[] against a one-row escrow must drift, write nothing, never hand back", () => {
    const { escrowId } = seed({ milestones: ["funded"] }); // one local row, stepId "step-1"
    const begun = beginSettlement({ escrowId });
    if (!("claim" in begun)) throw new Error(`expected an acquired claim, got disposition=${begun.disposition}`);
    expect(begun.disposition).toBe("acquired");
    const claim: SettlementClaim = begun.claim;
    const matchingStepId = keccak256(toBytes("step-1")) as Hex; // the one local row's stepId, hashed as production does on-chain

    const outcome = recordChainSettlement(claim, { stepIds: [matchingStepId], statuses: [], abiVersion: "v2" }); // N79 round 8, rule (a): was releasedStatus: 5; seed()'s escrow version is "v2"

    // Correct: drifted, nothing written, no hand-back — a cardinality mismatch between stepIds and statuses is
    // drift exactly like a cardinality mismatch between the chain and the local rows.
    expect(outcome).toEqual(expect.objectContaining({ ok: false, drifted: true }));
    expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded"] });
  });
});

describe("N79 round 7: Phase 2 — properties (P2 / P3 / P4)", () => {
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
    await app.close();
    closeStore();
    if (savedEscrowEnv === undefined) delete process.env.ESCROW_CONTRACT_ADDRESS;
    else process.env.ESCROW_CONTRACT_ADDRESS = savedEscrowEnv;
    if (savedEasV2Env === undefined) delete process.env.PCC_USE_EAS_V2;
    else process.env.PCC_USE_EAS_V2 = savedEasV2Env;
  });

  it("P2: escrow-target and milestone-index refusals, each with zero persistence/chain calls where its case requires", async () => {
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);

    // ── Escrow target ──────────────────────────────────────────────────────
    {
      // row + matching address: allowed (not a binding refusal).
      const jobId = await submitPaidJob(app, "user-p2-target-row-match");
      const address = pointEscrowAtChain(jobId, addr(0xfe1001), "v2");
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp2-t1", status: "submitted" } as never);
      const r = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-t1" }), jobId, { milestoneIndex: 0, contractAddress: address });
      expect(r.error, "row+matching").not.toBe("escrow_mismatch");
    }
    {
      // row + mismatching address: refused, zero chain calls.
      const jobA = await submitPaidJob(app, "user-p2-target-row-mismatch-A");
      const jobB = await submitPaidJob(app, "user-p2-target-row-mismatch-B");
      const addressA = pointEscrowAtChain(jobA, addr(0xfe1002), "v2");
      pointEscrowAtChain(jobB, addr(0xfe1003), "v2");
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp2-t2", status: "submitted" } as never);
      const r = await getSettlementService().processEvidence(makeBundle(jobB, { id: "bundle-p2-t2" }), jobB, { milestoneIndex: 0, contractAddress: addressA });
      expect(r.error, "row+mismatching").toBe("escrow_mismatch");
      expect(chain.submitEvidence, "row+mismatching").not.toHaveBeenCalled();
      void jobA;
    }
    {
      // row + no address supplied: allowed (today's behaviour — Step 3 just never fires).
      const jobId = await submitPaidJob(app, "user-p2-target-row-none");
      pointEscrowAtChain(jobId, addr(0xfe1004), "v2");
      const r = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-t3" }), jobId, { milestoneIndex: 0 });
      expect(r.error, "row+no-address").not.toBe("escrow_mismatch");
    }
    {
      // no row + env default + matching address: allowed.
      const { jobId } = seedBareJob();
      process.env.ESCROW_CONTRACT_ADDRESS = addr(0xfe1005);
      process.env.ESCROW_CONTRACT_VERSION = "v1"; // N79 round 8, lead review iteration 2, item 5(ii)
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp2-t4", status: "submitted" } as never);
      const r = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-t4" }), jobId, { contractAddress: addr(0xfe1005) });
      expect(r.error, "no-row+env-match").not.toBe("escrow_mismatch");
      delete process.env.ESCROW_CONTRACT_ADDRESS;
      delete process.env.ESCROW_CONTRACT_VERSION;
    }
    {
      // no row + env default + mismatching address: refused.
      const { jobId } = seedBareJob();
      process.env.ESCROW_CONTRACT_ADDRESS = addr(0xfe1006);
      vi.mocked(chain.submitEvidence).mockClear();
      const r = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-t5" }), jobId, { contractAddress: addr(0xfe1007) });
      expect(r.error, "no-row+env-mismatch").toBe("escrow_mismatch");
      expect(chain.submitEvidence, "no-row+env-mismatch").not.toHaveBeenCalled();
      delete process.env.ESCROW_CONTRACT_ADDRESS;
    }
    {
      // no row + NO env default + address supplied: refused (R7-H2's own case, re-asserted as a property).
      const { jobId } = seedBareJob();
      vi.mocked(chain.submitEvidence).mockClear();
      const r = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-t6" }), jobId, { contractAddress: addr(0xfe1008) });
      expect(r.error, "no-row+no-env+address").toBe("escrow_mismatch");
      expect(chain.submitEvidence, "no-row+no-env+address").not.toHaveBeenCalled();
    }
    {
      // no row + no env default + no address supplied: allowed (nothing to check against).
      const { jobId } = seedBareJob();
      const r = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-t7" }), jobId, {});
      expect(r.error, "no-row+no-env+no-address").not.toBe("escrow_mismatch");
    }

    // ── Milestone index ──────────────────────────────────────────────────────
    {
      // the wrong supplied index: refused before Step 1 (local derivation), zero chain calls.
      const jobA = await submitPaidJob(app, "user-p2-index-wrong-A");
      const jobB = await submitPaidJob(app, "user-p2-index-wrong-B");
      shareEscrowAcrossJobs(jobA, jobB);
      const address = pointEscrowAtChain(jobA, addr(0xfe2001), "v2");
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp2-idx1", status: "submitted" } as never);
      const r = await getSettlementService().processEvidence(makeBundle(jobA, { id: "bundle-p2-idx1" }), jobA, { milestoneIndex: 1, contractAddress: address });
      expect(r.error, "wrong-supplied-index").toBe("evidence_milestone_mismatch");
      expect(chain.submitEvidence, "wrong-supplied-index").not.toHaveBeenCalled();
    }
    {
      // an ambiguous local stepId: TWO local rows both matching job.stepId -> evidence_milestone_unbound.
      const jobId = await submitPaidJob(app, "user-p2-index-ambiguous");
      const address = pointEscrowAtChain(jobId, addr(0xfe2002), "v2");
      const job = getRepos().jobs.findById(jobId)!;
      const escrow = escrowForJob(jobId)!;
      getRepos().escrows.insertMilestone({ id: `ms-p2-ambiguous-${jobId}`, escrowId: escrow.id, stepId: job.stepId, amount: "5.00", status: "funded", bondAmount: "0" });
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp2-idx2", status: "submitted" } as never);
      const r = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-idx2" }), jobId, { contractAddress: address });
      expect(r.error, "ambiguous-local-stepId").toBe("evidence_milestone_unbound");
      expect(chain.submitEvidence, "ambiguous-local-stepId").not.toHaveBeenCalled();
    }
    {
      // a chain stepId mismatch AT THE DERIVED INDEX (local derivation succeeds; the fresh pre-submit chain
      // read disagrees): refused, no submit.
      const jobId = await submitPaidJob(app, "user-p2-index-chain-mismatch");
      const address = pointEscrowAtChain(jobId, addr(0xfe2003), "v2");
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp2-idx3", status: "submitted" } as never);
      vi.mocked(chain.getEscrowStateV2).mockResolvedValue(v2ChainStateFor("some-other-step-entirely", address));
      const r = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-idx3" }), jobId, { contractAddress: address });
      expect(r.error, "chain-stepId-mismatch-at-derived-index").toBe("evidence_milestone_unbound");
      expect(chain.submitEvidence, "chain-stepId-mismatch-at-derived-index").not.toHaveBeenCalled();
    }
    {
      // env-default chain scan finding NONE: refused, no submit.
      const { jobId, stepId } = seedBareJob();
      process.env.ESCROW_CONTRACT_ADDRESS = addr(0xfe2004);
      process.env.ESCROW_CONTRACT_VERSION = "v1"; // N79 round 8, lead review iteration 2, item 5(ii)
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp2-idx4", status: "submitted" } as never);
      vi.mocked(chain.getEscrowState).mockResolvedValue(v1ChainStateFor("not-this-jobs-step-at-all", addr(0xfe2004)));
      const r = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-idx4" }), jobId, { contractAddress: addr(0xfe2004) });
      expect(r.error, "env-default-scan-finds-none").toBe("evidence_milestone_unbound");
      expect(chain.submitEvidence, "env-default-scan-finds-none").not.toHaveBeenCalled();
      delete process.env.ESCROW_CONTRACT_ADDRESS;
      delete process.env.ESCROW_CONTRACT_VERSION;
      void stepId;
    }
    {
      // env-default chain scan finding SEVERAL (two milestones both matching): refused, no submit.
      const { jobId, stepId } = seedBareJob();
      process.env.ESCROW_CONTRACT_ADDRESS = addr(0xfe2005);
      process.env.ESCROW_CONTRACT_VERSION = "v1"; // N79 round 8, lead review iteration 2, item 5(ii)
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp2-idx5", status: "submitted" } as never);
      // Two on-chain milestones, BOTH carrying this job's own stepId identity — an ambiguous chain scan.
      const dupMatch = v1ChainStateFor(stepId, addr(0xfe2005), 0, 2) as { milestones: Array<{ stepId: string }> };
      dupMatch.milestones[1]!.stepId = dupMatch.milestones[0]!.stepId;
      vi.mocked(chain.getEscrowState).mockResolvedValue(dupMatch as never);
      const r = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-idx5" }), jobId, { contractAddress: addr(0xfe2005) });
      expect(r.error, "env-default-scan-finds-several").toBe("evidence_milestone_unbound");
      expect(chain.submitEvidence, "env-default-scan-finds-several").not.toHaveBeenCalled();
      delete process.env.ESCROW_CONTRACT_ADDRESS;
      delete process.env.ESCROW_CONTRACT_VERSION;
    }
  });

  it("P2 (version-matched reader): a v2-version escrow row is verified through getEscrowStateV2, never getEscrowState (V1), and a stepId mismatch there refuses", async () => {
    // Lead addendum (round 7): decoding a V2 clone's milestone struct through the V1 ABI's shorter tuple is
    // plausible but unproven live — read with the reader the escrow row's OWN version names, not the one the
    // eventual write call happens to use. V1 must never be touched for a "v2" row.
    const jobId = await submitPaidJob(app, "user-p2-v2-reader");
    const address = pointEscrowAtChain(jobId, addr(0xfe3001), "v2");
    const job = getRepos().jobs.findById(jobId)!;
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);

    // A correctly-matching V2 read lets the submit through. events: [] — this test is about the chain-reader
    // dispatch, not persistence; makeBundle()'s default event id is derived from jobId alone, so reusing the
    // SAME job for both sub-cases below would otherwise collide on the events table's own id across the two
    // calls.
    vi.mocked(chain.getEscrowStateV2).mockResolvedValue(v2ChainStateFor(job.stepId, address));
    vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp2-v2reader-ok", status: "submitted" } as never);
    const ok = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-v2reader-ok", events: [] }), jobId, { contractAddress: address });
    expect(ok.error, "v2-correct").toBeUndefined();
    expect(chain.getEscrowStateV2, "v2-correct").toHaveBeenCalledTimes(1);
    expect(chain.getEscrowState, "v2-correct").not.toHaveBeenCalled();
    expect(chain.submitEvidence, "v2-correct").toHaveBeenCalledTimes(1);

    // A mismatching V2 read refuses — and V1 is STILL never called (not a fallback, not a double-check).
    vi.mocked(chain.getEscrowStateV2).mockReset().mockResolvedValue(v2ChainStateFor("a-totally-different-step", address));
    vi.mocked(chain.submitEvidence).mockClear();
    const mismatch = await getSettlementService().processEvidence(makeBundle(jobId, { id: "bundle-p2-v2reader-mismatch", events: [] }), jobId, { contractAddress: address });
    expect(mismatch.error, "v2-mismatch").toBe("evidence_milestone_unbound");
    expect(chain.getEscrowState, "v2-mismatch").not.toHaveBeenCalled();
    expect(chain.submitEvidence, "v2-mismatch").not.toHaveBeenCalled();
  });

  it("P3: exact re-delivery, varied per header column, per event field, duplicate ids, missing/extra events, and a permuted order", async () => {
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);

    // A fresh job/escrow per header-column case: directly insert the EXISTING row + 2 events [A,B] (bypassing
    // processEvidence so the stored row's OTHER fields — stepId/kernelId/assuranceTier — can differ from a
    // value bind-first itself would reject outright; bind-first checks the INCOMING bundle against the job,
    // never the previously-stored row). The INCOMING bundle always matches the job (passes bind-first); only
    // ONE field differs from the EXISTING stored row.
    let p3n = 0;
    async function setupExisting(jobId: string, over: Partial<{ stepId: string; kernelId: string; assuranceTier: number; bundleHash: string; kernelSignature: unknown; createdAt: string }> = {}) {
      p3n += 1;
      const bundleId = `bundle-p3-existing-${p3n}`;
      const job = getRepos().jobs.findById(jobId)!;
      getRepos().evidence.insert({
        id: bundleId,
        jobId,
        stepId: over.stepId ?? job.stepId,
        kernelId: over.kernelId ?? job.kernelId,
        assuranceTier: over.assuranceTier ?? 0,
        bundleHash: (over.bundleHash ?? HASH_A) as `sha256:${string}`,
        // Matches makeBundle()'s own default exactly, so "no override" truly means "identical to what the
        // incoming bundle will carry" (needed for the permuted-order case below, which expects a TRUE match).
        kernelSignature: (over.kernelSignature ?? { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "mock_sig_r7" }) as never,
        createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
      });
      getRepos().evidence.insertEvents([
        { id: `ev-p3-A-${p3n}`, bundleId, type: "execution_started", timestamp: "2026-01-01T00:00:01.000Z", source: { deviceId: "d1", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { n: 1 }, hash: `sha256:${"aa".repeat(32)}` },
        { id: `ev-p3-B-${p3n}`, bundleId, type: "execution_completed", timestamp: "2026-01-01T00:00:02.000Z", source: { deviceId: "d1", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { n: 2 }, hash: `sha256:${"bb".repeat(32)}` },
      ]);
      return bundleId;
    }
    const incomingEvents = () => [
      { id: `ev-p3-A-${p3n}`, type: "execution_started", timestamp: "2026-01-01T00:00:01.000Z", source: { deviceId: "d1", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { n: 1 }, hash: `sha256:${"aa".repeat(32)}` as `sha256:${string}` },
      { id: `ev-p3-B-${p3n}`, type: "execution_completed", timestamp: "2026-01-01T00:00:02.000Z", source: { deviceId: "d1", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { n: 2 }, hash: `sha256:${"bb".repeat(32)}` as `sha256:${string}` },
    ];

    const headerCases: Array<{ name: string; existingOver: Parameters<typeof setupExisting>[1] }> = [
      { name: "stepId", existingOver: { stepId: "a-totally-different-step" } },
      { name: "kernelId", existingOver: { kernelId: "a-totally-different-kernel" } },
      { name: "assuranceTier", existingOver: { assuranceTier: 2 } },
      { name: "bundleHash", existingOver: { bundleHash: `sha256:${"cc".repeat(32)}` } },
      { name: "kernelSignature", existingOver: { kernelSignature: { signer: "0x0", algorithm: "secp256k1", value: "DIFFERENT" } } },
      { name: "createdAt", existingOver: { createdAt: "2026-06-06T00:00:00.000Z" } },
    ];
    let addrCounter = 0;
    for (const { name, existingOver } of headerCases) {
      const jobId = await submitPaidJob(app, `user-p3-header-${name}`);
      const address = pointEscrowAtChain(jobId, addr(0xff1000 + ++addrCounter), "v2");
      const bundleId = await setupExisting(jobId, existingOver);
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: `0xp3-${name}`, status: "submitted" } as never);

      const result = await getSettlementService().processEvidence(
        makeBundle(jobId, { id: bundleId, createdAt: "2026-01-01T00:00:00.000Z", events: incomingEvents() }),
        jobId,
        { milestoneIndex: 0, contractAddress: address },
      );
      expect(result.error, name).toBe("evidence_bundle_conflict");
      expect(chain.submitEvidence, name).not.toHaveBeenCalled();
    }

    // ── Event-field cases: existing [A,B] (as above); incoming [A',B] where A' varies ONE field ──────────────
    const eventFieldCases: Array<{ name: string; mutate: (ev: ReturnType<typeof incomingEvents>[0]) => void }> = [
      { name: "event.type", mutate: (ev) => { ev.type = "execution_failed" as never; } },
      { name: "event.timestamp", mutate: (ev) => { ev.timestamp = "2099-01-01T00:00:00.000Z"; } },
      { name: "event.source", mutate: (ev) => { ev.source = { deviceId: "DIFFERENT", deviceType: "controller", kernelId: "kernel-nyc" }; } },
      { name: "event.payload", mutate: (ev) => { ev.payload = { n: 999 }; } },
      { name: "event.hash", mutate: (ev) => { ev.hash = `sha256:${"ee".repeat(32)}` as `sha256:${string}`; } },
    ];
    for (const { name, mutate } of eventFieldCases) {
      const jobId = await submitPaidJob(app, `user-p3-eventfield-${name.replace(".", "-")}`);
      const address = pointEscrowAtChain(jobId, addr(0xff2000 + ++addrCounter), "v2");
      const bundleId = await setupExisting(jobId);
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: `0xp3-ev-${name}`, status: "submitted" } as never);

      const events = incomingEvents();
      mutate(events[0]!);
      const result = await getSettlementService().processEvidence(
        makeBundle(jobId, { id: bundleId, createdAt: "2026-01-01T00:00:00.000Z", events }),
        jobId,
        { milestoneIndex: 0, contractAddress: address },
      );
      expect(result.error, name).toBe("evidence_bundle_conflict");
      expect(chain.submitEvidence, name).not.toHaveBeenCalled();
    }

    // ── Missing events: existing [A,B], incoming [A] only ───────────────────────────────────────────────────
    {
      const jobId = await submitPaidJob(app, "user-p3-missing-events");
      const address = pointEscrowAtChain(jobId, addr(0xff3001), "v2");
      const bundleId = await setupExisting(jobId);
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp3-missing", status: "submitted" } as never);
      const result = await getSettlementService().processEvidence(
        makeBundle(jobId, { id: bundleId, createdAt: "2026-01-01T00:00:00.000Z", events: [incomingEvents()[0]!] }),
        jobId,
        { milestoneIndex: 0, contractAddress: address },
      );
      expect(result.error, "missing-events").toBe("evidence_bundle_conflict");
      expect(chain.submitEvidence, "missing-events").not.toHaveBeenCalled();
    }

    // ── Extra events: existing [A,B], incoming [A,B,C] ──────────────────────────────────────────────────────
    {
      const jobId = await submitPaidJob(app, "user-p3-extra-events");
      const address = pointEscrowAtChain(jobId, addr(0xff3002), "v2");
      const bundleId = await setupExisting(jobId);
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp3-extra", status: "submitted" } as never);
      const extraEvent = { id: `ev-p3-C-${p3n}`, type: "execution_completed", timestamp: "2026-01-01T00:00:03.000Z", source: { deviceId: "d1", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { n: 3 }, hash: `sha256:${"ff".repeat(32)}` as `sha256:${string}` };
      const result = await getSettlementService().processEvidence(
        makeBundle(jobId, { id: bundleId, createdAt: "2026-01-01T00:00:00.000Z", events: [...incomingEvents(), extraEvent] }),
        jobId,
        { milestoneIndex: 0, contractAddress: address },
      );
      expect(result.error, "extra-events").toBe("evidence_bundle_conflict");
      expect(chain.submitEvidence, "extra-events").not.toHaveBeenCalled();
    }

    // ── Duplicate incoming ids on a FRESH bundle (never persisted before): evidence_bundle_invalid ──────────
    {
      const jobId = await submitPaidJob(app, "user-p3-duplicate-fresh");
      const address = pointEscrowAtChain(jobId, addr(0xff4001), "v2");
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp3-dup", status: "submitted" } as never);
      const eventA = { id: "ev-p3-dup-A", type: "execution_started", timestamp: "2026-01-01T00:00:01.000Z", source: { deviceId: "d1", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { n: 1 }, hash: `sha256:${"aa".repeat(32)}` as `sha256:${string}` };
      const result = await getSettlementService().processEvidence(
        makeBundle(jobId, { id: "bundle-p3-fresh-dup", events: [eventA, { ...eventA }] }),
        jobId,
        { milestoneIndex: 0, contractAddress: address },
      );
      expect(result.error, "duplicate-ids-fresh").toBe("evidence_bundle_invalid");
      expect(chain.submitEvidence, "duplicate-ids-fresh").not.toHaveBeenCalled();
      expect(getRepos().evidence.findById("bundle-p3-fresh-dup"), "duplicate-ids-fresh").toBeUndefined();
    }

    // ── Permuted order: existing [A,B], incoming [B,A] — STILL exact (order-insensitive) ────────────────────
    {
      const jobId = await submitPaidJob(app, "user-p3-permuted-order");
      const address = pointEscrowAtChain(jobId, addr(0xff5001), "v2");
      const bundleId = await setupExisting(jobId);
      vi.mocked(chain.submitEvidence).mockClear().mockResolvedValue({ transactionHash: "0xp3-permuted", status: "submitted" } as never);
      vi.mocked(chain.getEscrowStateV2).mockResolvedValue(v2ChainStateFor(getRepos().jobs.findById(jobId)!.stepId, address));
      const [a, b] = incomingEvents();
      const result = await getSettlementService().processEvidence(
        // createdAt pinned to match setupExisting()'s own default exactly (makeBundle()'s own default is
        // `new Date().toISOString()`, which would otherwise never equal the stored row's fixed timestamp).
        makeBundle(jobId, { id: bundleId, events: [b!, a!], createdAt: "2026-01-01T00:00:00.000Z" }), // reversed order
        jobId,
        { milestoneIndex: 0, contractAddress: address },
      );
      expect(result.error, "permuted-order").toBeUndefined();
      expect(chain.submitEvidence, "permuted-order").toHaveBeenCalledTimes(1);
    }
  });

  it("P4: a statuses-length mismatch in EITHER direction is drift, independent of stepIds/localCount agreement", () => {
    const { escrowId } = seed({ milestones: ["funded"] }); // one local row, stepId "step-1"
    const matchingStepId = keccak256(toBytes("step-1")) as Hex;

    // SHORTER: stepIds count matches the local row count; statuses does not.
    expect(checkChainMapping(escrowId, { stepIds: [matchingStepId], statuses: [] }).ok).toBe(false);
    // LONGER: the other direction of the same cardinality mismatch.
    expect(checkChainMapping(escrowId, { stepIds: [matchingStepId], statuses: [5, 6] }).ok).toBe(false);

    // recordChainSettlement must refuse and write nothing for the LONGER case too, via a live claim.
    const begun = beginSettlement({ escrowId });
    if (!("claim" in begun)) throw new Error(`expected an acquired claim, got ${begun.disposition}`);
    const outcome = recordChainSettlement(begun.claim, { stepIds: [matchingStepId], statuses: [5, 6], abiVersion: "v2" }); // N79 round 8, rule (a): was releasedStatus: 5; seed()'s escrow version is "v2"
    expect(outcome).toEqual(expect.objectContaining({ ok: false, drifted: true }));
    expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded"] });
  });
});
