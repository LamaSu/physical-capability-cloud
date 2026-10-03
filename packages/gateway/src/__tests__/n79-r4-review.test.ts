/**
 * N79 round 4 (astra packs 126b / 126c, verdict DO-NOT-SHIP on 9d18a378; reproduced at 6e3ed257).
 *
 * One test per finding. Each asserts the CORRECT behaviour, so each fails at 6e3ed257 on the finding's own assertion:
 *
 *   R4-H1: SettlementService.releaseMilestone leased the escrow of `jobId` and released the escrow at `contractAddress`.
 *   R4-H2: resume settled on the LATEST evidence row of a job whose `evidenceBundleId` was null (processEvidence never
 *          stores it), so a relay row appended later became the hash sent to the oracle and the crank.
 *   R4-M1: the keeper read the chain BEFORE it owned the escrow, so a refund decision landed during the read.
 *   R4-M2: beginSettlement installed the lease before the fallible part of building its claim, so a throw leaked it.
 *   R4-M3: processEvidence's auto-release dropped `recorded: false` / `reconcile: "required"`.
 *   R4-H3: a keeper release confirmed on-chain whose milestone-row write failed handed the escrow back to `funded`,
 *          reopening a partly paid escrow to a refund.
 *   R4-M4: pins refund_pending's presentation independently of the ui-kit mirror-equality test (test-only: it passes at
 *          6e3ed257 by design; the rendered-pill half lives next to the kit harness, in @pcc/spec).
 *
 * The real in-memory store throughout. Only the chain, the oracle's verdict path and the evidence archive are mocked, and
 * the pauses are test-controlled deferreds, as in n79-r3-ownership.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getAddress } from "viem";
import type { EvidenceBundle } from "@pcc/spec";
import { classifyMoneyStatus } from "@pcc/spec";

vi.mock("../services/oracle-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/oracle-client.js")>();
  return {
    ...actual,
    // Every call is recorded (vi.mocked(...).mock.calls) and then answered by the real offline oracle path.
    verifyWithOracle: vi.fn(async (...args: Parameters<typeof actual.verifyWithOracle>) => actual.verifyWithOracle(...args)),
  };
});

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_r4", metadataCid: "bafymeta_n79_r4" }),
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

// The keeper and the resume route hand their chain work to the crank; the tests hold or answer it.
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
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { beginSettlement, endSettlement, escrowForJob, setJobStatusWithRefund } from "../services/escrow-refund.js";
import { getSettlementService } from "../services/settlement-service.js";
import { runKeeperSweep } from "../services/settlement-keeper.js";
import { driveSettlement } from "../services/settlement-crank.js";
import { verifyWithOracle } from "../services/oracle-client.js";
import { pipelineTelemetry } from "../telemetry.js";
import { auditService } from "../services/audit-service.js";
import * as chain from "../contracts/escrow-client.js";

/** Every deferred a test makes is flushed in afterEach, so no handler is left hanging on a pause. */
const dangling: Array<() => void> = [];
/** Every request or call a test starts is awaited in afterEach, before the store closes. */
const inflight: Array<PromiseLike<unknown>> = [];

function deferred<T = void>(onCleanup: { value?: T } = {}) {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  dangling.push(() => resolve(onCleanup.value as T));
  return { promise, resolve };
}

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const NOW = Math.floor(Date.now() / 1000);
const HASH_A = `sha256:${"a1".repeat(32)}`;
const HASH_B = `sha256:${"b2".repeat(32)}`;
const ATTESTATION = (escrowAddress: string) => ({ escrowAddress, evidenceHash: `0x${"cd".repeat(32)}` }) as never;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
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

/** The chain's view of a V2 escrow with one milestone per status given, each with its challenge window closed. */
function chainState(address: string, statuses: number[]) {
  return {
    address,
    payer: addr(0xaa),
    arbiter: addr(0xbb),
    token: addr(0xcc),
    cwmId: `0x${"00".repeat(32)}`,
    funded: true,
    totalAmount: "10",
    milestoneCount: statuses.length,
    milestones: statuses.map((status) => ({
      stepId: `0x${"11".repeat(32)}`,
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

const SETTLED = { escrowAddress: addr(1), milestoneIdx: 0, finalStatus: "Released", outcome: "released", settled: true, steps: [] } as never;
const NOT_SETTLED = { escrowAddress: addr(1), milestoneIdx: 0, finalStatus: "Attested", outcome: "awaiting_challenge_window", settled: false, steps: [] } as never;

/** A job + negotiation session + escrow (+ milestones), linked the way the settlement read links them. */
let seq = 0;
function seed(opts: { status?: string; jobStatus?: string; milestones?: string[]; address?: string } = {}) {
  const repos = getRepos();
  const n = ++seq;
  const jobId = `job-r4-${n}`;
  const cwmId = `cwm-r4-${n}`;
  const capability = repos.capabilities.findAll()[0]!;
  const now = new Date().toISOString();
  const status = opts.status ?? "funded";
  const address = opts.address ?? addr(0xb0000 + n);
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
      id: `sess-r4-${n}`,
      status: "committed",
      userAgentId: "user-r4",
      kernelId: capability.kernelId,
      capabilityType: capability.type,
      operatorConstraints: {},
      jobId,
      cwmId,
      createdAt: now,
      expiresAt: now,
    })
    .run();
  const escrowId = `esc-r4-${n}`;
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
    repos.escrows.insertMilestone({ id: `ms-r4-${n}-${i}`, escrowId, stepId: `step-${i + 1}`, amount: "5.00", status: ms, bondAmount: "0" });
  });
  return { jobId, escrowId, address, cwmId };
}

function rows(escrowId: string) {
  return {
    escrow: getRepos().escrows.findById(escrowId)!.status,
    milestones: getRepos().escrows.findMilestonesByEscrow(escrowId).map((m) => m.status),
  };
}

/**
 * Make the NEXT negotiation-session lookup (the one jobOfEscrow does while a claim is built) throw once, then behave.
 * Returns the restore function.
 */
function failNextSessionLookup(): () => void {
  const db = getStore().db;
  const realSelect = db.select.bind(db) as (...a: unknown[]) => any;
  let armed = true;
  const spy = vi.spyOn(db, "select").mockImplementation(((...args: unknown[]) => {
    const builder = realSelect(...args);
    const realFrom = builder.from.bind(builder);
    builder.from = (table: unknown) => {
      if (armed && table === schema.negotiationSessions) {
        armed = false;
        throw new Error("negotiation_sessions lookup failed");
      }
      return realFrom(table);
    };
    return builder;
  }) as never);
  return () => spy.mockRestore();
}

function makeBundle(jobId: string, over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  const job = getRepos().jobs.findById(jobId)!;
  return {
    id: "bundle-r4-kernel-A",
    jobId,
    stepId: job.stepId,
    kernelId: job.kernelId,
    assuranceTier: 0,
    bundleHash: HASH_A as `sha256:${string}`,
    kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "mock_sig_r4" },
    createdAt: new Date().toISOString(),
    events: [
      {
        id: `ev-r4-${jobId}`,
        type: "execution_started",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev-r4", deviceType: "controller", kernelId: job.kernelId },
        payload: { message: "Job started" },
        hash: `sha256:${"c3".repeat(32)}` as `sha256:${string}`,
      },
    ],
    ...over,
  };
}

describe("N79 round 4: the review's findings, reproduced", () => {
  let app: FastifyInstance;
  let savedEscrowEnv: string | undefined;

  beforeEach(async () => {
    savedEscrowEnv = process.env.ESCROW_CONTRACT_ADDRESS;
    delete process.env.ESCROW_CONTRACT_ADDRESS;
    delete process.env.PCC_USE_EAS_V2;
    vi.mocked(chain.isWriteEnabled).mockReset().mockReturnValue(false);
    vi.mocked(chain.submitEvidence).mockReset();
    vi.mocked(chain.releaseMilestone).mockReset();
    vi.mocked(chain.releaseMilestoneV2).mockReset();
    vi.mocked(chain.getEscrowStateV2).mockReset();
    vi.mocked(driveSettlement).mockReset();
    vi.mocked(verifyWithOracle).mockClear();
    app = await buildApp();
  });

  afterEach(async () => {
    for (const flush of dangling.splice(0)) flush();
    await Promise.allSettled(inflight.splice(0));
    await app.close();
    closeStore();
    delete process.env.PCC_USE_EAS_V2;
    if (savedEscrowEnv === undefined) delete process.env.ESCROW_CONTRACT_ADDRESS;
    else process.env.ESCROW_CONTRACT_ADDRESS = savedEscrowEnv;
  });

  it("R4-H1: the job-level release is bound to ONE escrow: job A naming escrow B's address is refused before the chain, and B's refund is unaffected", async () => {
    const jobA = await submitPaidJob(app, "user-n79r4-h1-a");
    const jobB = await submitPaidJob(app, "user-n79r4-h1-b");
    pointEscrowAtChain(jobA, addr(0xe5c401), "v2");
    const addressB = pointEscrowAtChain(jobB, addr(0xe5c402), "v2");
    getRepos().jobs.updateStatus(jobA, "in_progress");
    getRepos().jobs.updateStatus(jobB, "in_progress");

    // The chain release is held open, so a release that gets through shows up as a call.
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    const chainCalled = deferred();
    const released = deferred({ value: { transactionHash: "0xr4h1", status: "submitted" } });
    vi.mocked(chain.releaseMilestone).mockImplementation(() => {
      chainCalled.resolve();
      return released.promise as never;
    });
    const releasing = getSettlementService().releaseMilestone(jobA, 0, ATTESTATION(addressB), addressB);
    inflight.push(releasing);
    await Promise.race([releasing, chainCalled.promise]); // settles the moment the call answers or reaches the chain

    // Correct: refused BEFORE the chain.
    expect(chain.releaseMilestone).not.toHaveBeenCalled();
    expect(await releasing).toEqual(expect.objectContaining({ status: "failed", error: "escrow_mismatch" }));

    // Nothing moved: A is untouched, and B (never leased) is still refundable on its own terms.
    expect(escrowState(jobA)).toEqual({ escrow: "funded", milestones: ["funded"] });
    expect(escrowState(jobB)).toEqual({ escrow: "funded", milestones: ["funded"] });
    expect(setJobStatusWithRefund(jobB, "failed").escrowRefund).toEqual(expect.objectContaining({ outcome: "refund_pending" }));
    released.resolve({ transactionHash: "0xr4h1", status: "submitted" });
    await Promise.resolve();
    expect(chain.releaseMilestone).not.toHaveBeenCalled();
  });

  it("R4-H1 (default target): with no address named, the release goes to the JOB's own escrow, never to the env default", async () => {
    const jobA = await submitPaidJob(app, "user-n79r4-h1-default");
    const addressA = pointEscrowAtChain(jobA, addr(0xe5c403), "v2");
    getRepos().jobs.updateStatus(jobA, "in_progress");
    process.env.ESCROW_CONTRACT_ADDRESS = addr(0xe5c4ff); // some other, global escrow
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.releaseMilestone).mockResolvedValue({ transactionHash: "0xr4default", status: "submitted" } as never);

    const out = await getSettlementService().releaseMilestone(jobA, 0, ATTESTATION(addressA));

    expect(chain.releaseMilestone).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chain.releaseMilestone).mock.calls[0]![2]).toBe(addressA);
    expect(out).toEqual(expect.objectContaining({ status: "released", txHash: "0xr4default" }));
    expect(escrowState(jobA)).toEqual({ escrow: "completed", milestones: ["released"] });
  });

  it("R4-H1 (kernel caller): the local kernel's auto-release names the JOB's own escrow, so H1's binding never refuses it", async () => {
    const { autoReleaseContractAddress } = await import("../services/kernel-service.js");
    const jobA = await submitPaidJob(app, "user-n79r4-h1-kernel");
    const addressA = pointEscrowAtChain(jobA, addr(0xe5c405), "v2");
    process.env.ESCROW_CONTRACT_ADDRESS = addr(0xe5c4fe); // the global default, which is NOT job A's escrow
    expect(autoReleaseContractAddress(jobA)).toBe(addressA);
    // A job with no escrow of its own keeps the configured default (legacy single-contract deployments).
    expect(autoReleaseContractAddress("job-without-any-escrow")).toBe(addr(0xe5c4fe));
  });

  it("R4-H2: processEvidence records the exact bundle id, and resume settles on THAT bundle, never on a row another path appended later", async () => {
    const jobId = await submitPaidJob(app, "user-n79r4-h2");
    const address = pointEscrowAtChain(jobId, addr(0xe5c404), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr4evidence", status: "submitted" } as never);

    // Bundle A: the kernel path stores it and submits its hash on-chain; the job reads evidence_submitted.
    const bundleA = makeBundle(jobId);
    await getSettlementService().processEvidence(bundleA, jobId, { milestoneIndex: 0, contractAddress: address });
    expect(getRepos().jobs.findById(jobId)?.status).toBe("evidence_submitted");

    // Bundle B: the unowned operator relay appends another row for the same job.
    const job = getRepos().jobs.findById(jobId)!;
    getRepos().evidence.insert({
      id: "ev-relay-B",
      jobId,
      stepId: job.stepId,
      kernelId: job.kernelId,
      assuranceTier: 0,
      bundleHash: HASH_B,
      kernelSignature: { signer: "kernel-nyc", algorithm: "sha256", value: "operator-relay-auto" },
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });

    process.env.PCC_USE_EAS_V2 = "true";
    vi.mocked(driveSettlement).mockResolvedValue(NOT_SETTLED);
    const resumed = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });

    // The hash the oracle verifies and the hash the crank settles is A's, on every pass.
    expect(vi.mocked(verifyWithOracle).mock.calls.map((c) => c[0].evidenceHash)).toEqual([HASH_A]);
    const crankHashes = vi.mocked(driveSettlement).mock.calls.map((c) => c[2]?.evidenceBundleHash);
    expect(crankHashes.length).toBeGreaterThan(0);
    expect(crankHashes.every((h) => h === HASH_A)).toBe(true);
    expect(resumed.json().evidenceBundleId).toBe(bundleA.id);
    expect(resumed.statusCode).toBe(200);
    // ...because processEvidence recorded A's id on the job, in the write that said evidence_submitted.
    expect(getRepos().jobs.findById(jobId)?.evidenceBundleId).toBe(bundleA.id);
  });

  it("R4-H2 (no id): an evidence_submitted job with no recorded bundle id is refused with 409 no_recorded_evidence_bundle, never settled on the latest row", async () => {
    const jobId = await submitPaidJob(app, "user-n79r4-h2-null");
    const job = getRepos().jobs.findById(jobId)!;
    // As processEvidence left it before the fix: evidence_submitted, the bundle stored, the scalar id null.
    getRepos().evidence.insert({
      id: "bundle-r4-kernel-A",
      jobId,
      stepId: job.stepId,
      kernelId: job.kernelId,
      assuranceTier: 0,
      bundleHash: HASH_A,
      kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "mock_sig_r4" },
      createdAt: new Date().toISOString(),
    });
    getRepos().evidence.insert({
      id: "ev-relay-B",
      jobId,
      stepId: job.stepId,
      kernelId: job.kernelId,
      assuranceTier: 0,
      bundleHash: HASH_B,
      kernelSignature: { signer: "kernel-nyc", algorithm: "sha256", value: "operator-relay-auto" },
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });
    getRepos().jobs.updateStatus(jobId, "evidence_submitted");
    expect(getRepos().jobs.findById(jobId)?.evidenceBundleId).toBeNull();

    const resumed = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });

    expect(resumed.statusCode).toBe(409);
    expect(resumed.json()).toEqual(expect.objectContaining({ error: "no_recorded_evidence_bundle" }));
    expect(vi.mocked(verifyWithOracle)).not.toHaveBeenCalled(); // never settles on B (or on anything else)
    // The job and its escrow are put back exactly as they were (F4's hand-back).
    expect(getRepos().jobs.findById(jobId)?.status).toBe("evidence_submitted");
    expect(escrowState(jobId)).toEqual({ escrow: "funded", milestones: ["funded"] });
  });

  it("R4-M1: the keeper owns the escrow BEFORE its chain read: a failure during the read records no refund, and the Released milestone completes the escrow", async () => {
    const { jobId, escrowId, address } = seed();
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    const read = deferred();
    vi.mocked(chain.getEscrowStateV2).mockImplementation(async () => {
      await read.promise;
      return chainState(address, [chain.MilestoneStatusV2.Released]); // already paid out on-chain
    });

    const sweep = runKeeperSweep(getRepos(), { nowSeconds: NOW });
    inflight.push(sweep);
    await vi.waitFor(() => expect(chain.getEscrowStateV2).toHaveBeenCalled()); // the read is in flight

    // The job fails while the read awaits: the refund must be skipped, not decided.
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );

    read.resolve();
    const result = await sweep;
    expect(result.reconciledCompleted).toBe(1);
    expect(rows(escrowId)).toEqual({ escrow: "completed", milestones: ["released"] });
  });

  it("R4-M2: beginSettlement leaks no lease, and leaves no row completing, when building its claim throws", () => {
    for (const status of ["funded", "created"]) {
      const { escrowId } = seed({ status });
      const restore = failNextSessionLookup();
      try {
        expect(() => beginSettlement({ escrowId }), `${status}: the first claim`).toThrow("negotiation_sessions lookup failed");
      } finally {
        restore();
      }

      // The caller never got a claim, so it could not end one: the next claim must not be `busy`.
      const again = beginSettlement({ escrowId });
      expect(again.disposition, `${status}: the second claim`).not.toBe("busy");
      expect(again.disposition, `${status}: the second claim`).toBe(status === "funded" ? "acquired" : "leased");
      if ("claim" in again) endSettlement(again.claim);
    }

    // ...and the failed claim did not leave the row completing with nothing holding it.
    const { escrowId } = seed({ status: "funded" });
    const restore = failNextSessionLookup();
    try {
      expect(() => beginSettlement({ escrowId })).toThrow();
    } finally {
      restore();
    }
    expect(rows(escrowId).escrow).toBe("funded");
  });

  it("R4-M3: processEvidence's auto-release exposes recorded:false and reconcile:required in its result, its telemetry and its audit record", async () => {
    const jobId = await submitPaidJob(app, "user-n79r4-m3");
    const address = pointEscrowAtChain(jobId, addr(0xe5c405), "v2");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.submitEvidence).mockResolvedValue({ transactionHash: "0xr4evidence", status: "submitted" } as never);
    const service = getSettlementService();
    // The release landed on-chain but its bookkeeping failed (F5): the service says so.
    vi.spyOn(service, "releaseMilestone").mockResolvedValue({
      jobId,
      txHash: "0xr4m3",
      status: "released",
      recorded: false,
      reconcile: "required",
    });
    const emit = vi.spyOn(pipelineTelemetry, "emit");
    const audit = vi.spyOn(auditService, "log");
    try {
      const result = await service.processEvidence(makeBundle(jobId), jobId, {
        milestoneIndex: 0,
        contractAddress: address,
        autoRelease: true,
        attestation: ATTESTATION(address),
      });

      // `settled` stays chain truth; the reconciliation requirement is not hidden behind it.
      expect(result).toEqual(expect.objectContaining({ settled: true, releaseTxHash: "0xr4m3", recorded: false, reconcile: "required" }));
      expect(emit).toHaveBeenCalledWith(
        jobId,
        "settlement_complete",
        "completed",
        expect.objectContaining({ metadata: expect.objectContaining({ released: true, txHash: "0xr4m3", recorded: false, reconcile: "required" }) }),
      );
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "settlement.completed",
          metadata: expect.objectContaining({ txHash: "0xr4m3", recorded: false, reconcile: "required" }),
        }),
      );
    } finally {
      emit.mockRestore();
      audit.mockRestore();
    }
  });

  it("R4-H3: a keeper release confirmed on-chain whose row write fails leaves the escrow completing, so a later failure cannot refund a partly paid escrow", async () => {
    const { jobId, escrowId, address } = seed({ milestones: ["funded", "funded"] });
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    // m0 is Attested past its window and its drive settles; m1 is only Evidenced, so it is not the keeper's yet.
    vi.mocked(chain.getEscrowStateV2).mockImplementation(async () =>
      chainState(address, [chain.MilestoneStatusV2.Attested, chain.MilestoneStatusV2.Evidenced]),
    );
    vi.mocked(driveSettlement).mockResolvedValue(SETTLED);

    const writes = vi.spyOn(getRepos().escrows, "updateMilestoneStatus").mockImplementation(() => {
      throw new Error("disk full");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.fn();
    try {
      const result = await runKeeperSweep(getRepos(), { nowSeconds: NOW, logger: { info: vi.fn(), warn } });
      expect(result.released).toBe(1); // the money moved; the failed bookkeeping does not undo or hide that
    } finally {
      writes.mockRestore();
    }

    // The escrow must NOT have been handed back to funded with both rows funded: that reopens it to a refund.
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );
    expect(rows(escrowId)).toEqual({ escrow: "completing", milestones: ["funded", "funded"] });
    // It says so, with what a later sweep needs to reconcile it from chain truth.
    expect(errors).toHaveBeenCalledWith("[escrow] settlement_record_failed", expect.objectContaining({ escrowId, milestoneIndex: 0 }));
    errors.mockRestore();
    // The lease ended with the sweep, and the next claim adopts the durable mark.
    const next = beginSettlement({ escrowId }, { leaseOnly: true });
    expect(next.disposition).toBe("adopted");
    if ("claim" in next) endSettlement(next.claim);
  });

  it("R4-M4: refund_pending reads waiting - 'refund decided - payer not yet refunded' - and is neither settled nor refunded", () => {
    for (const word of ["refund_pending", "REFUND_PENDING", "Refund-Pending", " refund pending "]) {
      expect(classifyMoneyStatus(word), word).toMatchObject({
        known: true,
        tone: "waiting",
        label: "refund decided - payer not yet refunded",
      });
    }
    const c = classifyMoneyStatus("refund_pending");
    expect(c.tone).not.toBe("settled");
    expect(c.tone).not.toBe("refunded");
    expect(c.label).toMatch(/not yet refunded/);
    // The completed refund is a different reading: it is the one that says the payer WAS refunded.
    expect(classifyMoneyStatus("refunded").tone).toBe("refunded");
  });

  it("R4-M1 (STOP replacement): the same pre-read race, but the read returns Attested (not yet Released) — the keeper now owns the escrow, so the refund is skipped and the drive proceeds normally", async () => {
    // Stands in for n79-r3-lease.test.ts's "does not drive an escrow that was given back after the sweep's
    // snapshot..." (line ~553), which this round's M1 fix makes FAIL on its own premise: it asserts that nobody
    // owns the escrow while the read is in flight, which was exactly the bug. I did not edit that test (it is not
    // one of the two the lead authorized) — see the round-4 report for the STOP and the unapplied patch.
    const { jobId, escrowId, address } = seed();
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    const read = deferred();
    vi.mocked(chain.getEscrowStateV2).mockImplementation(async () => {
      await read.promise;
      return chainState(address, [chain.MilestoneStatusV2.Attested]);
    });
    vi.mocked(driveSettlement).mockResolvedValue(SETTLED);

    const sweep = runKeeperSweep(getRepos(), { nowSeconds: NOW });
    inflight.push(sweep);
    await vi.waitFor(() => expect(chain.getEscrowStateV2).toHaveBeenCalled());

    // Correct: the keeper already owns the escrow by the time the job fails, so the refund is skipped, not landed.
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );

    read.resolve();
    const result = await sweep;

    // The race resolved in the keeper's favor, so its normal job proceeds: the Attested milestone drives and settles.
    expect(result.skippedTerminal).toBe(0);
    expect(result.released).toBe(1);
    expect(driveSettlement).toHaveBeenCalledTimes(1);
    expect(escrowState(jobId)).toEqual({ escrow: "completed", milestones: ["released"] });
    expect(rows(escrowId)).toEqual({ escrow: "completed", milestones: ["released"] });
  });
});
