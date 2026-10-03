/**
 * N79 round 3 (astra, pack 126, verdict DO-NOT-SHIP on fa935e5f): the escrow status `completing` was not EXCLUSIVE
 * ownership, so a refund could still land underneath a release, and a settlement could strand its own escrow.
 *
 * One test per finding. Each asserts the CORRECT behaviour, so each failed at fa935e5f, on the finding's own
 * assertion (a chain call made, a status overwritten, a refund landing, a 409 that should have been a 200):
 *
 *   F1: the settlement keeper drove a release without owning the escrow, so a refund landed during its drive.
 *   F2: a second release (raw route, job-level service) proceeded on an escrow another settlement already owned, and
 *       recordMilestoneReleased wrote `released`/`completed` over a refund.
 *   F3: a job rewritten to `failed` after its evidence was recorded could no longer be resumed.
 *   F4: resume-settlement's "no evidence bundle" refusal stranded the escrow it had just taken.
 *   F5: a release confirmed on-chain whose bookkeeping failed was reported as plain success.
 *   F6: the shared-escrow check looked at `jobs.cwmId`, not at the sessions escrowForJob() resolves through.
 *
 * Added after the lead's review of the first pass (each also fails at fa935e5f):
 *   F1 (partial payout): a keeper drive that settled one of several milestones left that milestone's row unrecorded, so a
 *       later failure refunded an escrow that was already partly paid.
 *   F3 (created): the recovery route needed the escrow to read `completing`; a V1/V2 chain escrow reads `created`.
 *   F5 (end to end): POST /api/settlement/release answered a fixed shape and dropped `recorded: false`.
 *
 * The real in-memory store throughout. Only the chain, the oracle and the evidence archive are mocked, and the
 * pauses are test-controlled deferreds, as in n79-refund-vs-settlement.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getAddress, keccak256, toBytes } from "viem";

// Test-controlled pauses inside /complete, so another write can land mid-flight.
const gates = vi.hoisted(() => ({
  evidence: null as null | Promise<void>,
  onEvidence: null as null | (() => void),
  oracleThrows: false,
}));

vi.mock("../services/oracle-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/oracle-client.js")>();
  return {
    ...actual,
    verifyWithOracle: vi.fn(async (...args: Parameters<typeof actual.verifyWithOracle>) => {
      if (gates.oracleThrows) throw new Error("oracle unreachable");
      return actual.verifyWithOracle(...args);
    }),
  };
});

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_r3", metadataCid: "bafymeta_n79_r3" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc", metadataCid: "bafyencmeta" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../services/device-evidence-settlement.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/device-evidence-settlement.js")>();
  return {
    ...actual,
    resolveSettlementEvidence: vi.fn(async (...args: Parameters<typeof actual.resolveSettlementEvidence>) => {
      gates.onEvidence?.();
      if (gates.evidence) await gates.evidence;
      return actual.resolveSettlementEvidence(...args);
    }),
  };
});

vi.mock("../contracts/escrow-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../contracts/escrow-client.js")>();
  return {
    ...actual,
    isWriteEnabled: vi.fn(() => false),
    releaseMilestone: vi.fn(),
    releaseMilestoneV2: vi.fn(),
    getEscrowStateV2: vi.fn(),
  };
});

// The keeper hands its release to the crank; the test holds the crank open.
vi.mock("../services/settlement-crank.js", () => ({
  driveSettlement: vi.fn(),
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

// A production control-plane gateway has no local kernel: jobs dispatch to a remote operator node.
vi.mock("../services/kernel-service.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/kernel-service.js")>();
  return {
    ...actual,
    getKernelService: vi.fn(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    }),
  };
});

import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { jobRoutes } from "../routes/jobs.js";
import { escrowRoutes } from "../routes/escrow.js";
import { settlementRoutes } from "../routes/settlement.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { escrowForJob, recordChainSettlement, setJobStatusWithRefund } from "../services/escrow-refund.js";
import { getSettlementService } from "../services/settlement-service.js";
import { runKeeperSweep } from "../services/settlement-keeper.js";
import { driveSettlement } from "../services/settlement-crank.js";
import * as chain from "../contracts/escrow-client.js";

/** Every deferred a test makes is flushed in afterEach, so no handler is left hanging on a pause. */
const dangling: Array<() => void> = [];
/** Every request or call a test starts is awaited in afterEach, before the store closes. */
const inflight: Array<PromiseLike<unknown>> = [];

function deferred<T = void>(onCleanup: { value?: T; reject?: unknown } = {}) {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  dangling.push(() => ("reject" in onCleanup ? reject(onCleanup.reject) : resolve(onCleanup.value as T)));
  return { promise, resolve, reject };
}

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const NOW = Math.floor(Date.now() / 1000);

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(jobRoutes);
  await app.register(escrowRoutes);
  await app.register(settlementRoutes);
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

function escrowState(jobId: string) {
  const escrow = escrowForJob(jobId)!;
  return {
    escrow: getRepos().escrows.findById(escrow.id)!.status,
    milestones: getRepos().escrows.findMilestonesByEscrow(escrow.id).map((m) => m.status),
  };
}

/** Make the job's mock escrow a chain escrow: a checksummed 0x address, as paid-job-flow writes it. */
function pointEscrowAtChain(jobId: string, address: string, version: "v2" | "v3" = "v2"): string {
  const escrow = escrowForJob(jobId)!;
  getStore().db.update(schema.escrows).set({ contractAddress: address, version }).where(eq(schema.escrows.id, escrow.id)).run();
  return address;
}

// Fixture correction (round 5, the R5-H2b identity check): index i's chain stepId mirrors the
// REAL local milestone row's `stepId` at that index via the same hash production writes on-chain
// (`keccak256(toBytes(ms.stepId))`, paid-job-flow.ts) — read from the store rather than assumed, because this
// file's jobs come from the REAL route (`submitPaidJob`), whose stepId is `step-${randomUUID}`, not a fixed
// `step-N` convention. Falls back to the `step-${i+1}` convention only when no escrow is found at `address` yet
// (none of this file's current tests hit that fallback). Fixture-only — no assertion in this file changed.
/** The chain's view of a V2 escrow with one milestone per status given, each with its challenge window closed. */
function chainState(address: string, statuses: number[]) {
  const escrowRow = getRepos().escrows.findByContractAddress(address) ?? getRepos().escrows.findByContractAddress(address.toLowerCase());
  const localStepIds = escrowRow ? getRepos().escrows.findMilestonesByEscrow(escrowRow.id).map((m) => m.stepId) : [];
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
      stepId: keccak256(toBytes(localStepIds[i] ?? `step-${i + 1}`)),
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

/** The chain's view of a one-milestone V2 escrow: Attested, challenge window closed. */
const attestedPastWindow = (address: string) => chainState(address, [chain.MilestoneStatusV2.Attested]);

/** What the crank answers for a release it did not land. */
const NOT_SETTLED = { escrowAddress: addr(1), milestoneIdx: 0, finalStatus: "Attested", outcome: "blocked", settled: false, steps: [], reason: "test flush" };
const SETTLED = { escrowAddress: addr(1), milestoneIdx: 0, finalStatus: "Released", outcome: "released", settled: true, steps: [] };

describe("N79 round 3: settlement ownership is exclusive, and a settlement never strands its escrow", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    gates.evidence = null;
    gates.onEvidence = null;
    gates.oracleThrows = false;
    vi.mocked(chain.isWriteEnabled).mockReset().mockReturnValue(false);
    vi.mocked(chain.releaseMilestone).mockReset();
    vi.mocked(chain.releaseMilestoneV2).mockReset();
    vi.mocked(chain.getEscrowStateV2).mockReset();
    vi.mocked(driveSettlement).mockReset();
    delete process.env.PCC_USE_EAS_V2;
    app = await buildApp();
  });

  afterEach(async () => {
    for (const flush of dangling.splice(0)) flush();
    await Promise.allSettled(inflight.splice(0));
    await app.close();
    closeStore();
    delete process.env.PCC_USE_EAS_V2;
  });

  it("F1: the keeper owns the escrow across its drive: a refund during the drive is skipped, and the release then completes it", async () => {
    const jobId = await submitPaidJob(app, "user-n79r3-f1");
    const address = pointEscrowAtChain(jobId, addr(0xe5c101), "v2");
    getRepos().jobs.updateStatus(jobId, "in_progress");

    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.getEscrowStateV2).mockImplementation(async (a) => {
      if (a !== address) throw new Error(`unexpected escrow read: ${String(a)}`);
      return attestedPastWindow(address);
    });
    const drive = deferred({ value: NOT_SETTLED as never });
    vi.mocked(driveSettlement).mockReturnValue(drive.promise);

    const sweep = runKeeperSweep(getRepos(), { nowSeconds: NOW });
    inflight.push(sweep);
    await vi.waitFor(() => expect(driveSettlement).toHaveBeenCalled());

    // The keeper is inside its awaited drive. The job fails now: the refund must be skipped, not decided.
    const failed = setJobStatusWithRefund(jobId, "failed");
    expect(failed.escrowRefund).toEqual(expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }));
    expect(["refund_pending", "refunded"]).not.toContain(escrowState(jobId).escrow);

    drive.resolve(SETTLED as never);
    const result = await sweep;
    expect(result.released).toBe(1);
    expect(escrowState(jobId)).toEqual({ escrow: "completed", milestones: ["released"] });
  });

  it("F1 (partial payout): a drive that settles one of two milestones marks that row released at once, so a later refund stops", async () => {
    const jobId = await submitPaidJob(app, "user-n79r3-f1-partial");
    const address = pointEscrowAtChain(jobId, addr(0xe5c107), "v2");
    const escrow = escrowForJob(jobId)!;
    getRepos().escrows.insertMilestone({ id: `${escrow.id}-ms-2`, escrowId: escrow.id, stepId: "step-2", amount: "5.00", status: "funded", bondAmount: "0" });
    getRepos().jobs.updateStatus(jobId, "in_progress");

    // m0 is Attested past its window and its drive settles; m1 is only Evidenced, so it is not the keeper's yet.
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.getEscrowStateV2).mockImplementation(async (a) => {
      if (a !== address) throw new Error(`unexpected escrow read: ${String(a)}`);
      return chainState(address, [chain.MilestoneStatusV2.Attested, chain.MilestoneStatusV2.Evidenced]);
    });
    vi.mocked(driveSettlement).mockResolvedValue(SETTLED as never);

    const result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
    expect(result.released).toBe(1);
    expect(vi.mocked(driveSettlement).mock.calls.map((c) => c[1])).toEqual([0]);

    // m0 is paid, so its row says so at once; the escrow, which is not fully paid, goes back to funded.
    expect(escrowState(jobId)).toEqual({ escrow: "funded", milestones: ["released", "funded"] });

    // A later failure therefore cannot give back money that moved.
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "milestone_past_funding" }),
    );
    expect(escrowState(jobId)).toEqual({ escrow: "funded", milestones: ["released", "funded"] });
  });

  // The reviewer's five steps for F2. /complete owns the escrow; a second release arrives; /complete gives up and hands
  // the escrow back; the job ends and the escrow is given back; the second release lands. It must never get that far.
  async function completeHeldAtEvidenceGate(jobId: string) {
    const entered = deferred();
    const hold = deferred<void>({ reject: new Error("flushed by afterEach") });
    gates.onEvidence = () => entered.resolve();
    gates.evidence = hold.promise;
    const completing = app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    inflight.push(completing);
    await entered.promise; // suspended before any evidence is recorded: the escrow reads `completing`
    expect(escrowState(jobId).escrow).toBe("completing");
    return { completing, hold };
  }

  it("F2: while /complete owns the escrow, a raw release is refused at once with 409 and never reaches the chain; the later refund stands", async () => {
    const jobId = await submitPaidJob(app, "user-n79r3-f2-raw");
    const address = pointEscrowAtChain(jobId, addr(0xe5c102), "v2");
    const { completing, hold } = await completeHeldAtEvidenceGate(jobId);

    // 2. A raw release arrives (EAS path, writes on). The chain call is held open, so a release that gets through shows up as a call.
    process.env.PCC_USE_EAS_V2 = "true";
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    const chainCalled = deferred();
    const released = deferred({ value: { transactionHash: "0xrawrelease", status: "submitted" } });
    vi.mocked(chain.releaseMilestoneV2).mockImplementation(() => {
      chainCalled.resolve();
      return released.promise as never;
    });
    const releasing = app.inject({ method: "POST", url: `/api/escrow/chain/${address}/release/0`, payload: {} });
    inflight.push(releasing);
    await Promise.race([releasing, chainCalled.promise]); // settles the moment the route answers or reaches the chain
    expect(chain.releaseMilestoneV2).not.toHaveBeenCalled();
    const refused = await releasing;
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual(expect.objectContaining({ error: "settlement_in_progress" }));

    // 3. /complete's evidence gate fails: it answers 500 and hands the escrow back.
    hold.reject(new Error("evidence resolver down"));
    expect((await completing).statusCode).toBe(500);
    expect(escrowState(jobId).escrow).toBe("funded");

    // 4. The job ends, so the escrow is given back.
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund?.outcome).toBe("refund_pending");

    // 5. Whatever the refused release held cannot land now: the escrow ends refund_pending, never completed.
    released.resolve({ transactionHash: "0xrawrelease", status: "submitted" });
    await Promise.resolve();
    expect(chain.releaseMilestoneV2).not.toHaveBeenCalled();
    expect(escrowState(jobId)).toEqual({ escrow: "refund_pending", milestones: ["refund_pending"] });
  });

  it("F2: the same interleaving through SettlementService.releaseMilestone: failed with settlement_in_progress, and the chain is never called", async () => {
    const jobId = await submitPaidJob(app, "user-n79r3-f2-svc");
    const address = pointEscrowAtChain(jobId, addr(0xe5c103), "v2");
    const { completing, hold } = await completeHeldAtEvidenceGate(jobId);

    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    const chainCalled = deferred();
    const released = deferred({ value: { transactionHash: "0xsvcrelease", status: "submitted" } });
    vi.mocked(chain.releaseMilestone).mockImplementation(() => {
      chainCalled.resolve();
      return released.promise as never;
    });
    const releasing = getSettlementService().releaseMilestone(jobId, 0, { escrowAddress: address, evidenceHash: `0x${"cd".repeat(32)}` } as never, address);
    inflight.push(releasing);
    await Promise.race([releasing, chainCalled.promise]);
    expect(chain.releaseMilestone).not.toHaveBeenCalled();
    expect(await releasing).toEqual(expect.objectContaining({ status: "failed", error: "settlement_in_progress" }));

    hold.reject(new Error("evidence resolver down"));
    expect((await completing).statusCode).toBe(500);
    expect(escrowState(jobId).escrow).toBe("funded");
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund?.outcome).toBe("refund_pending");

    released.resolve({ transactionHash: "0xsvcrelease", status: "submitted" });
    await Promise.resolve();
    expect(chain.releaseMilestone).not.toHaveBeenCalled();
    expect(escrowState(jobId)).toEqual({ escrow: "refund_pending", milestones: ["refund_pending"] });
  });

  it("F2: recordChainSettlement never turns a refund_pending escrow into completed (was: recordMilestoneReleased)", async () => {
    const jobId = await submitPaidJob(app, "user-n79r3-f2-unit");
    pointEscrowAtChain(jobId, addr(0xe5c104), "v2");
    const escrow = escrowForJob(jobId)!;
    const stepId = getRepos().jobs.findById(jobId)!.stepId;
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund?.outcome).toBe("refund_pending");

    // A release that was confirmed on-chain reports in late, holding a claim the refund long outlived. The
    // chain mapping matches (no drift) — the point of this case is that the escrow is already given back.
    recordChainSettlement(
      { escrowId: escrow.id, token: Symbol("late-release"), leasedStatus: "completing" } as never,
      { stepIds: [keccak256(toBytes(stepId))], statuses: [chain.MilestoneStatusV2.Released], releasedStatus: chain.MilestoneStatusV2.Released },
    );

    expect(getRepos().escrows.findById(escrow.id)!.status).toBe("refund_pending");
  });

  it("F3: a job rewritten to failed after its evidence was recorded can still be resumed, and settles", async () => {
    const jobId = await submitPaidJob(app, "user-n79r3-f3");
    gates.oracleThrows = true;
    const completed = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    expect(completed.statusCode).toBe(500);
    expect(getRepos().jobs.findById(jobId)?.status).toBe("evidence_submitted");
    expect(escrowState(jobId).escrow).toBe("completing");

    // Another writer reports the job failed. The refund is skipped (the settlement owns the escrow), but the job now reads failed.
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );
    expect(getRepos().jobs.findById(jobId)?.status).toBe("failed");
    expect(escrowState(jobId).escrow).toBe("completing");

    gates.oracleThrows = false;
    const resumed = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });
    expect(resumed.statusCode).toBe(200);
    expect(escrowState(jobId)).toEqual({ escrow: "completed", milestones: ["released"] });
    expect(getRepos().jobs.findById(jobId)?.status).toBe("settled");
  });

  it("F3 (created): a job rewritten to failed after its evidence was recorded is resumed even when its escrow reads created, and settles", async () => {
    const jobId = await submitPaidJob(app, "user-n79r3-f3-created");
    // A V1/V2 chain escrow reads `created` from the day it is made until its settlement completes it (nothing writes funded).
    const escrow = escrowForJob(jobId)!;
    getRepos().escrows.updateStatus(escrow.id, "created");
    for (const m of getRepos().escrows.findMilestonesByEscrow(escrow.id)) getRepos().escrows.updateMilestoneStatus(m.id, "pending");

    gates.oracleThrows = true;
    expect((await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} })).statusCode).toBe(500);
    expect(getRepos().jobs.findById(jobId)?.status).toBe("evidence_submitted");
    expect(getRepos().evidence.findByJob(jobId)).toHaveLength(1);
    expect(escrowState(jobId).escrow).toBe("created");

    setJobStatusWithRefund(jobId, "failed");
    expect(getRepos().jobs.findById(jobId)?.status).toBe("failed");

    gates.oracleThrows = false;
    const resumed = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });
    expect(resumed.statusCode).toBe(200);
    expect(escrowState(jobId)).toEqual({ escrow: "completed", milestones: ["released"] });
    expect(getRepos().jobs.findById(jobId)?.status).toBe("settled");
  });

  it("F4: resume-settlement on a job with no evidence bundle refuses with 409 and gives the escrow back", async () => {
    const jobId = await submitPaidJob(app, "user-n79r3-f4");
    // A legacy or inconsistent row: the job says evidence_submitted, but no /complete ever ran, so there is no bundle.
    getRepos().jobs.updateStatus(jobId, "evidence_submitted");
    expect(getRepos().evidence.findByJob(jobId)).toHaveLength(0);
    expect(escrowState(jobId).escrow).toBe("funded");

    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });
    expect(res.statusCode).toBe(409);
    expect(escrowState(jobId)).toEqual({ escrow: "funded", milestones: ["funded"] });
    expect(getRepos().jobs.findById(jobId)?.status).toBe("evidence_submitted");
  });

  it("F5: a raw release confirmed on-chain whose bookkeeping fails says so (recorded:false, reconcile:required) and keeps the escrow owned", async () => {
    const jobId = await submitPaidJob(app, "user-n79r3-f5");
    const address = pointEscrowAtChain(jobId, addr(0xe5c105), "v2");
    const escrow = escrowForJob(jobId)!;
    getRepos().jobs.updateStatus(jobId, "in_progress");
    process.env.PCC_USE_EAS_V2 = "true";
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.releaseMilestoneV2).mockResolvedValue({ transactionHash: "0xf5release", status: "submitted" } as never);

    // getRepos() hands out one stable object per store, so the spy sits on the repository the module under test uses.
    const writes = vi.spyOn(getRepos().escrows, "updateMilestoneStatus").mockImplementation(() => {
      throw new Error("disk full");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.inject({ method: "POST", url: `/api/escrow/chain/${address}/release/0`, payload: {} });

      // The money moved on-chain, so the route does not fail; but it does not pretend the bookkeeping happened either.
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(expect.objectContaining({ transactionHash: "0xf5release", recorded: false, reconcile: "required" }));
      expect(errors).toHaveBeenCalledWith(
        "[escrow] settlement_record_failed",
        expect.objectContaining({ escrowId: escrow.id, milestoneIndex: 0, txHash: "0xf5release" }),
      );
    } finally {
      writes.mockRestore();
      errors.mockRestore();
    }
    // Never handed back after a confirmed release: the escrow stays owned (completing), so no refund can land on funds that moved.
    expect(escrowState(jobId)).toEqual({ escrow: "completing", milestones: ["funded"] });
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );
  });

  it("F5 (end to end): POST /api/settlement/release forwards recorded:false and reconcile:required, and keeps the escrow owned", async () => {
    const jobId = await submitPaidJob(app, "user-n79r3-f5-route");
    const address = pointEscrowAtChain(jobId, addr(0xe5c108), "v2");
    getRepos().jobs.updateStatus(jobId, "in_progress");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.releaseMilestone).mockResolvedValue({ transactionHash: "0xf5route", status: "submitted" } as never);

    const writes = vi.spyOn(getRepos().escrows, "updateMilestoneStatus").mockImplementation(() => {
      throw new Error("disk full");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/settlement/release",
        payload: { jobId, milestoneIndex: 0, contractAddress: address, attestation: { escrowAddress: address, evidenceHash: `0x${"cd".repeat(32)}` } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        txHash: "0xf5route",
        status: "released",
        jobId,
        milestoneIndex: 0,
        recorded: false,
        reconcile: "required",
      });
    } finally {
      writes.mockRestore();
      errors.mockRestore();
    }
    expect(escrowState(jobId)).toEqual({ escrow: "completing", milestones: ["funded"] });
  });

  // Evidence, not a fix: the keeper heals only V2 (the crank is V2-only), so an escrow stranded `completing` on V3 stays.
  // F5's fix surfaces the failure to the caller; a V1/V3 chain reconciler is a separate follow-up.
  it("F5 (evidence): the keeper counts a V3 escrow as skippedV3 and never touches it, so nothing heals a V3 escrow left completing", async () => {
    const jobId = await submitPaidJob(app, "user-n79r3-f5-v3");
    pointEscrowAtChain(jobId, addr(0xe5c106), "v3");
    getStore().db.update(schema.escrows).set({ status: "completing" }).where(eq(schema.escrows.id, escrowForJob(jobId)!.id)).run();
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);

    const result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });

    expect(result.skippedV3).toBe(1);
    expect(chain.getEscrowStateV2).not.toHaveBeenCalled();
    expect(driveSettlement).not.toHaveBeenCalled();
    expect(escrowState(jobId).escrow).toBe("completing");
  });

  it("F6: a job that shares the escrow only through its negotiation session blocks the refund (escrow_shared)", async () => {
    const a = await submitPaidJob(app, "user-n79r3-f6");
    const escrow = escrowForJob(a)!;
    const { db } = getStore();
    const sessionA = db.select().from(schema.negotiationSessions).where(eq(schema.negotiationSessions.jobId, a)).get()!;
    expect(sessionA.cwmId).toBe(escrow.cwmId);

    // Job B reaches the escrow through its session (cwmId = the escrow's), while its own jobs.cwmId holds some other value.
    const jobA = getRepos().jobs.findById(a)!;
    const b = `${a}-b`;
    getRepos().jobs.insert({ ...jobA, id: b, cwmId: `${escrow.cwmId}-stale`, status: "in_progress" });
    db.insert(schema.negotiationSessions).values({ ...sessionA, id: `${sessionA.id}-b`, jobId: b }).run();
    expect(escrowForJob(b)?.id).toBe(escrow.id); // the escrow lookup finds the shared escrow for B

    const out = setJobStatusWithRefund(a, "cancelled").escrowRefund;
    expect(out).toEqual(expect.objectContaining({ outcome: "skipped", reason: "escrow_shared", sharedWith: expect.arrayContaining([b]) }));
    expect(escrowState(a)).toEqual({ escrow: "funded", milestones: ["funded"] });
  });
});
