/**
 * N79 round 3: the ownership lease itself (escrow-refund.ts), and everything that takes or refuses it. The reproductions
 * of astra's six findings are n79-r3-ownership.test.ts; this file pins the design they are fixed by, so a regression in
 * ANY part of it fails here rather than only in a finding's interleaving:
 *
 *   - beginSettlement's dispositions (acquired / adopted / leased / busy / blocked / no_escrow), including a lost
 *     compare-and-set and the keeper's lease-only claim;
 *   - the hand-back and the release record act only for the claim that holds the lease;
 *   - a refund is skipped while a lease is live, even when the row no longer reads `completing`;
 *   - the keeper, against the real store: a busy escrow is skipped, one given back since the snapshot is not driven or
 *     overwritten, an escrow it does not settle is handed back (and refunded if its job ended), the lease never leaks;
 *   - the callers refuse an escrow they cannot own (409) and give back what they took: PUT /complete, resume-settlement,
 *     the raw release route, SettlementService.releaseMilestone, and the releaseByJob retry policy;
 *   - a chain escrow's row reads `created` through its whole life, and it must still settle.
 *
 * The real in-memory store throughout; the chain, the oracle and the evidence archive are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getAddress, keccak256, toBytes } from "viem";
import { isNonRetryable } from "@pcc/workflow";

const gates = vi.hoisted(() => ({
  oracleThrows: false,
  oracle: null as null | Promise<void>,
  onOracle: null as null | (() => void),
}));

vi.mock("../services/oracle-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/oracle-client.js")>();
  return {
    ...actual,
    verifyWithOracle: vi.fn(async (...args: Parameters<typeof actual.verifyWithOracle>) => {
      gates.onOracle?.();
      if (gates.oracle) await gates.oracle;
      if (gates.oracleThrows) throw new Error("oracle unreachable");
      return actual.verifyWithOracle(...args);
    }),
  };
});

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_r3_lease", metadataCid: "bafymeta_n79_r3_lease" }),
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
    releaseMilestone: vi.fn(),
    releaseMilestoneV2: vi.fn(),
    getEscrowState: vi.fn(),
    getEscrowStateV2: vi.fn(),
  };
});

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
import {
  beginSettlement,
  endSettlement,
  escrowForJob,
  recordChainSettlement,
  refundEscrowForTerminalJob,
  releaseEscrowFromSettlement,
  setJobStatusWithRefund,
  type SettlementClaim,
  type SettlementClaimResult,
} from "../services/escrow-refund.js";
import { getSettlementService } from "../services/settlement-service.js";
import { runKeeperSweep } from "../services/settlement-keeper.js";
import { driveSettlement } from "../services/settlement-crank.js";
import { releaseMilestoneByJobActivity } from "../activities/escrow.js";
import * as chain from "../contracts/escrow-client.js";

const dangling: Array<() => void> = [];
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
let seq = 0;

/** A job + negotiation session + escrow (+ milestones), linked the way the settlement read links them. */
function seed(opts: { status?: string; jobStatus?: string; milestones?: string[]; address?: string; version?: "v2" | "v3" } = {}) {
  const repos = getRepos();
  const n = ++seq;
  const jobId = `job-r3-${n}`;
  const cwmId = `cwm-r3-${n}`;
  const capability = repos.capabilities.findAll()[0]!;
  const now = new Date().toISOString();
  const status = opts.status ?? "funded";
  const address = opts.address ?? addr(0xa0000 + n);
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
      id: `sess-r3-${n}`,
      status: "committed",
      userAgentId: "user-r3",
      kernelId: capability.kernelId,
      capabilityType: capability.type,
      operatorConstraints: {},
      jobId,
      cwmId,
      createdAt: now,
      expiresAt: now,
    })
    .run();
  const escrowId = `esc-r3-${n}`;
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
    version: opts.version ?? "v2",
  });
  const milestoneStatuses = opts.milestones ?? [status === "created" ? "pending" : "funded"];
  milestoneStatuses.forEach((ms, i) => {
    repos.escrows.insertMilestone({ id: `ms-r3-${n}-${i}`, escrowId, stepId: `step-${i + 1}`, amount: "5.00", status: ms, bondAmount: "0" });
  });
  return { jobId, escrowId, address, cwmId };
}

function escrowRow(escrowId: string) {
  return {
    escrow: getRepos().escrows.findById(escrowId)!.status,
    milestones: getRepos().escrows.findMilestonesByEscrow(escrowId).map((m) => m.status),
  };
}

/** The claim of a result that must have one. */
function claimOf(result: SettlementClaimResult): SettlementClaim {
  if (!("claim" in result)) throw new Error(`expected a claim, got ${result.disposition}`);
  return result.claim;
}

// Fixture correction (round 5, the R5-H2b identity check): index i's chain stepId mirrors
// `seed()`'s own `step-${i+1}` convention via the same hash production writes on-chain
// (`keccak256(toBytes(ms.stepId))`, paid-job-flow.ts). Fixture-only — no assertion in this file changed.
/** The chain's view of a V2 escrow with one milestone per status given, each with its challenge window `windowEnd`. */
function chainState(address: string, statuses: number[], windowEnd = NOW - 1_000) {
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
      stepId: keccak256(toBytes(`step-${i + 1}`)),
      operator: addr(0),
      amount: "10",
      operatorBond: "0",
      status,
      statusName: "",
      evidenceBundleHash: `0x${"00".repeat(32)}`,
      verifierAttestationHash: `0x${"00".repeat(32)}`,
      challengeWindowEnd: windowEnd,
      challengeWindowSeconds: 0,
      requiredTier: 0,
      jobIdHash: `0x${"00".repeat(32)}`,
      verifierAttestationUid: `0x${"00".repeat(32)}`,
    })),
  } as never;
}

/** A one-milestone escrow in the given status (default Attested), window closed. */
const attested = (address: string, status: number = chain.MilestoneStatusV2.Attested, windowEnd = NOW - 1_000) =>
  chainState(address, [status], windowEnd);

const driveResult = (over: Record<string, unknown>) =>
  ({ escrowAddress: addr(1), milestoneIdx: 0, finalStatus: "Released", outcome: "released", settled: true, steps: [], ...over }) as never;

beforeEach(() => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  delete process.env.PCC_USE_EAS_V2;
  gates.oracleThrows = false;
  gates.oracle = null;
  gates.onOracle = null;
  vi.mocked(chain.isWriteEnabled).mockReset().mockReturnValue(false);
  vi.mocked(chain.releaseMilestone).mockReset();
  vi.mocked(chain.releaseMilestoneV2).mockReset();
  vi.mocked(chain.getEscrowState).mockReset();
  vi.mocked(chain.getEscrowStateV2).mockReset();
  vi.mocked(driveSettlement).mockReset();
  initStore({ seed: true });
});

afterEach(async () => {
  for (const flush of dangling.splice(0)) flush();
  await Promise.allSettled(inflight.splice(0));
  closeStore();
  delete process.env.PCC_USE_EAS_V2;
  process.env.MOCK_SETTLEMENT = "true";
});

describe("beginSettlement: the dispositions", () => {
  it("no_escrow: nothing known by that id, job or address (and an empty ref)", () => {
    expect(beginSettlement({ escrowId: "esc-nope" })).toEqual({ disposition: "no_escrow" });
    expect(beginSettlement({ jobId: "job-nope" })).toEqual({ disposition: "no_escrow" });
    expect(beginSettlement({ contractAddress: addr(0xdead) })).toEqual({ disposition: "no_escrow" });
    expect(beginSettlement({})).toEqual({ disposition: "no_escrow" });
  });

  it.each(["funded", "active"])("acquired: a %s row is taken to completing, remembering where it came from", (status) => {
    const { jobId, escrowId } = seed({ status });
    const begun = beginSettlement({ jobId });
    expect(begun.disposition).toBe("acquired");
    const claim = claimOf(begun);
    expect(claim).toEqual(expect.objectContaining({ escrowId, prior: status, leasedStatus: "completing", jobId }));
    expect(typeof claim.token).toBe("symbol");
    expect(escrowRow(escrowId).escrow).toBe("completing");
    endSettlement(claim);
  });

  it("finds the escrow by id, by job and by address (any letter case), and names the escrow's job", () => {
    const { jobId, escrowId, address } = seed();
    for (const ref of [{ escrowId }, { jobId }, { contractAddress: address }, { contractAddress: address.toLowerCase() }]) {
      const begun = beginSettlement(ref);
      expect(begun.disposition).toBe("acquired");
      const claim = claimOf(begun);
      expect(claim.escrowId).toBe(escrowId);
      expect(claim.jobId).toBe(jobId);
      releaseEscrowFromSettlement(claim); // hand it back, so the next ref starts from funded again
      expect(escrowRow(escrowId).escrow).toBe("funded");
    }
  });

  it("busy: a live lease answers every later claim on that escrow, however it is named, until the holder ends it", () => {
    const { jobId, escrowId, address } = seed();
    const first = claimOf(beginSettlement({ jobId }));
    for (const ref of [{ escrowId }, { jobId }, { contractAddress: address }]) {
      expect(beginSettlement(ref)).toEqual({ disposition: "busy", escrowId, escrowStatus: "completing" });
      expect(beginSettlement(ref, { leaseOnly: true })).toEqual({ disposition: "busy", escrowId, escrowStatus: "completing" });
    }
    endSettlement(first);
    expect(beginSettlement({ jobId }).disposition).toBe("adopted"); // the durable mark survived the lease
  });

  it("adopted: a row that already reads completing (no live lease) is taken over, unchanged and with nothing to restore", () => {
    const { jobId, escrowId } = seed({ status: "completing" });
    const begun = beginSettlement({ jobId });
    expect(begun.disposition).toBe("adopted");
    const claim = claimOf(begun);
    expect(claim.prior).toBeUndefined();
    expect(claim.leasedStatus).toBe("completing");
    expect(escrowRow(escrowId).escrow).toBe("completing");
    endSettlement(claim);
  });

  it("blocked: a given-back or completed escrow is never claimed, not even by the keeper, and is left untouched", () => {
    for (const status of ["refund_pending", "refunded", "completed"]) {
      const { escrowId } = seed({ status });
      expect(beginSettlement({ escrowId })).toEqual({ disposition: "blocked", escrowId, escrowStatus: status });
      expect(beginSettlement({ escrowId }, { leaseOnly: true })).toEqual({ disposition: "blocked", escrowId, escrowStatus: status });
      expect(escrowRow(escrowId).escrow).toBe(status);
    }
  });

  it("leased: a `created` row (a live chain escrow's normal state) takes the lease and is left as it is", () => {
    const { jobId, escrowId } = seed({ status: "created" });
    const begun = beginSettlement({ jobId });
    expect(begun.disposition).toBe("leased");
    const claim = claimOf(begun);
    expect(claim).toEqual(expect.objectContaining({ prior: undefined, leasedStatus: "created" }));
    expect(escrowRow(escrowId).escrow).toBe("created");
    expect(beginSettlement({ jobId }).disposition).toBe("busy");
    endSettlement(claim);
  });

  it("any other status is blocked for a release, but leased for the keeper (its row can lag the chain)", () => {
    const { escrowId } = seed({ status: "disputed" });
    expect(beginSettlement({ escrowId })).toEqual({ disposition: "blocked", escrowId, escrowStatus: "disputed" });
    const begun = beginSettlement({ escrowId }, { leaseOnly: true });
    expect(begun.disposition).toBe("leased");
    expect(claimOf(begun).leasedStatus).toBe("disputed");
    expect(escrowRow(escrowId).escrow).toBe("disputed");
  });

  it("a lost compare-and-set is blocked with the status re-read, takes no lease, and changes nothing", () => {
    const { escrowId } = seed({ status: "refund_pending" });
    const escrows = getRepos().escrows;
    const real = escrows.findById.bind(escrows);
    // The row the claim first reads is stale: it says funded, while the database already says refund_pending.
    const stale = vi.spyOn(escrows, "findById").mockImplementationOnce((id: string) => ({ ...real(id)!, status: "funded" }));
    try {
      expect(beginSettlement({ escrowId })).toEqual({ disposition: "blocked", escrowId, escrowStatus: "refund_pending" });
    } finally {
      stale.mockRestore();
    }
    expect(escrowRow(escrowId).escrow).toBe("refund_pending");
    // No lease was left behind: a later claim is `blocked` (the row), not `busy` (a leaked lease).
    expect(beginSettlement({ escrowId }).disposition).toBe("blocked");
  });

  it("endSettlement drops only its own lease, and is idempotent", () => {
    const { escrowId } = seed();
    const claim = claimOf(beginSettlement({ escrowId }));
    const stranger: SettlementClaim = { ...claim, token: Symbol("someone else") };
    endSettlement(stranger);
    expect(beginSettlement({ escrowId }).disposition).toBe("busy");
    endSettlement(claim);
    endSettlement(claim);
    endSettlement(undefined);
    expect(beginSettlement({ escrowId }).disposition).toBe("adopted");
  });
});

describe("the hand-back and the release record act only for the claim that holds the lease", () => {
  it("hand-back restores the status the claim took the escrow from, and drops the lease", () => {
    const { jobId, escrowId } = seed({ status: "active" });
    const claim = claimOf(beginSettlement({ jobId }));
    expect(releaseEscrowFromSettlement(claim, jobId)).toBeUndefined();
    expect(escrowRow(escrowId).escrow).toBe("active");
    expect(beginSettlement({ jobId }).disposition).toBe("acquired"); // not busy: the lease is gone
  });

  it("hand-back gives the escrow to the payer when its job ended while the settlement owned it", () => {
    const { jobId, escrowId } = seed();
    const claim = claimOf(beginSettlement({ jobId }));
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }));
    expect(releaseEscrowFromSettlement(claim, jobId)).toEqual(expect.objectContaining({ outcome: "refund_pending", escrowId }));
    expect(escrowRow(escrowId)).toEqual({ escrow: "refund_pending", milestones: ["refund_pending"] });
  });

  it("a hand-back by an adopted claim leaves the durable mark: an adopted settlement is not abandoned", () => {
    const { jobId, escrowId } = seed({ status: "completing" });
    const claim = claimOf(beginSettlement({ jobId }));
    releaseEscrowFromSettlement(claim, jobId);
    expect(escrowRow(escrowId).escrow).toBe("completing");
    expect(beginSettlement({ jobId }).disposition).toBe("adopted");
  });

  it("a claim that no longer holds the lease cannot hand back another operation's ownership", () => {
    const { jobId, escrowId } = seed();
    const first = claimOf(beginSettlement({ jobId })); // acquired: funded -> completing, prior funded
    endSettlement(first); // its lease ends; the durable mark stays
    const second = claimOf(beginSettlement({ jobId })); // another operation adopts the escrow
    expect(second.token).not.toBe(first.token);

    // The first operation, late, tries to hand the escrow back. It must change nothing.
    expect(releaseEscrowFromSettlement(first, jobId)).toBeUndefined();
    expect(escrowRow(escrowId).escrow).toBe("completing");
    expect(beginSettlement({ jobId }).disposition).toBe("busy"); // the second operation still holds it
    endSettlement(second);
  });

  // N79 round 6 (addendum 1, P1, "whichever leaves fewer doors"): the tests below called the now-REMOVED
  // per-index/per-row writers (`recordMilestoneReleased`, `recordMilestoneRowReleased`, `recordEscrowReleased`)
  // directly. Converted to `recordChainSettlement` (chain mapping REQUIRED), preserving each test's original
  // intent: a valid full set stamps + completes; a partial set stamps + hands back; a claim with no live lease
  // still stamps (chain truth) but never moves the escrow; a stale/foreign claim never writes "completed" over
  // a refund. The single local milestone's stepId is always `step-1` (seed()'s convention); two milestones are
  // `step-1`/`step-2`.
  const REL = () => chain.MilestoneStatusV2.Released;
  const stepHash = (n: number) => keccak256(toBytes(`step-${n}`));

  it("recordChainSettlement: once every milestone is released the holder completes the escrow, from what it held it as (was: recordMilestoneReleased)", () => {
    for (const status of ["funded", "completing", "created"]) {
      const { jobId, escrowId } = seed({ status });
      const claim = claimOf(beginSettlement({ jobId }));
      recordChainSettlement(claim, { stepIds: [stepHash(1)], statuses: [REL()], releasedStatus: REL() });
      expect(escrowRow(escrowId)).toEqual({ escrow: "completed", milestones: ["released"] });
      endSettlement(claim);
    }
  });

  it("recordChainSettlement: one of several milestones is recorded and an acquired claim hands the escrow back; the last completes it (was: recordMilestoneReleased)", () => {
    const { jobId, escrowId } = seed({ milestones: ["funded", "funded"] });
    const first = claimOf(beginSettlement({ jobId }));
    recordChainSettlement(first, { stepIds: [stepHash(1), stepHash(2)], statuses: [REL(), chain.MilestoneStatusV2.Funded], releasedStatus: REL() });
    endSettlement(first);
    expect(escrowRow(escrowId)).toEqual({ escrow: "funded", milestones: ["released", "funded"] });
    const second = claimOf(beginSettlement({ jobId }));
    recordChainSettlement(second, { stepIds: [stepHash(1), stepHash(2)], statuses: [REL(), REL()], releasedStatus: REL() });
    endSettlement(second);
    expect(escrowRow(escrowId)).toEqual({ escrow: "completed", milestones: ["released", "released"] });
  });

  it("recordChainSettlement: a claim without the lease records the milestone (the chain's truth) but never moves the escrow (was: recordMilestoneReleased)", () => {
    const { jobId, escrowId } = seed();
    const claim = claimOf(beginSettlement({ jobId }));
    endSettlement(claim); // the lease is gone; the escrow reads completing
    recordChainSettlement(claim, { stepIds: [stepHash(1)], statuses: [REL()], releasedStatus: REL() });
    expect(escrowRow(escrowId)).toEqual({ escrow: "completing", milestones: ["released"] });
  });

  it.each(["refund_pending", "refunded"])("recordChainSettlement never writes over %s (was: recordMilestoneReleased and recordEscrowReleased)", (status) => {
    const { escrowId } = seed({ status });
    const stale: SettlementClaim = { escrowId, token: Symbol("stale"), leasedStatus: "completing" };
    const outcome = recordChainSettlement(stale, { stepIds: [stepHash(1)], statuses: [REL()], releasedStatus: REL() });
    expect(outcome.completed).toBeFalsy();
    expect(escrowRow(escrowId).escrow).toBe(status);
  });

  it("a claim that holds the lease still only moves a row that reads what it holds it as: a refund decided out of band stands (was: recordMilestoneReleased and recordEscrowReleased)", () => {
    const { jobId, escrowId } = seed({ milestones: ["funded", "funded"] });
    const claim = claimOf(beginSettlement({ jobId }));
    getRepos().escrows.updateStatus(escrowId, "refund_pending"); // decided outside the protocol, beneath a live lease
    // Not every milestone released: the hand-back branch.
    recordChainSettlement(claim, { stepIds: [stepHash(1), stepHash(2)], statuses: [REL(), chain.MilestoneStatusV2.Funded], releasedStatus: REL() });
    expect(escrowRow(escrowId).escrow).toBe("refund_pending");
    // Every milestone released: the completion branch.
    const completion = recordChainSettlement(claim, { stepIds: [stepHash(1), stepHash(2)], statuses: [REL(), REL()], releasedStatus: REL() });
    expect(completion.completed).toBeFalsy();
    expect(escrowRow(escrowId).escrow).toBe("refund_pending");
    endSettlement(claim);
  });

  it("the hand-back is a compare-and-set from completing: it never restores a prior status over a row that moved on", () => {
    const { jobId, escrowId } = seed();
    const claim = claimOf(beginSettlement({ jobId }));
    getRepos().escrows.updateStatus(escrowId, "refund_pending");
    releaseEscrowFromSettlement(claim, jobId);
    expect(escrowRow(escrowId).escrow).toBe("refund_pending");
  });

  it("recordChainSettlement stamps a partial release's row and hands the claim back; idempotent; the final milestone then completes it (was: recordMilestoneRowReleased)", () => {
    const { jobId, escrowId } = seed({ milestones: ["funded", "funded"] });
    const claim = claimOf(beginSettlement({ jobId })); // acquired: funded -> completing, prior funded
    const partial = { stepIds: [stepHash(1), stepHash(2)], statuses: [REL(), chain.MilestoneStatusV2.Funded], releasedStatus: REL() };
    recordChainSettlement(claim, partial);
    recordChainSettlement(claim, partial); // idempotent: row0 already released, hand-back already landed
    expect(escrowRow(escrowId)).toEqual({ escrow: "funded", milestones: ["released", "funded"] });
    // The last milestone, under a fresh claim, then completes it — proving the earlier hand-back dropped the
    // lease too (a live lease would make THIS claim `busy`, not `acquired`).
    const second = claimOf(beginSettlement({ jobId }));
    recordChainSettlement(second, { ...partial, statuses: [REL(), REL()] });
    expect(escrowRow(escrowId)).toEqual({ escrow: "completed", milestones: ["released", "released"] });
    endSettlement(second);
  });

  it("recordChainSettlement: every milestone row reads released and the holder completes the escrow (was: recordEscrowReleased)", () => {
    const { escrowId } = seed({ status: "disputed", milestones: ["funded", "locked"] });
    const claim = claimOf(beginSettlement({ escrowId }, { leaseOnly: true }));
    const outcome = recordChainSettlement(claim, { stepIds: [stepHash(1), stepHash(2)], statuses: [REL(), REL()], releasedStatus: REL() });
    expect(outcome.completed).toBe(true);
    expect(escrowRow(escrowId)).toEqual({ escrow: "completed", milestones: ["released", "released"] });
    endSettlement(claim);
  });
});

describe("a refund is skipped while a lease is live, whatever the row reads", () => {
  it("a settlement's lease blocks the refund even if the row has been rewritten to funded underneath it", () => {
    const { jobId, escrowId } = seed();
    const claim = claimOf(beginSettlement({ jobId }));
    getRepos().escrows.updateStatus(escrowId, "funded"); // something rewrote the row beneath the operation that holds it
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress", escrowId }),
    );
    expect(escrowRow(escrowId)).toEqual({ escrow: "funded", milestones: ["funded"] });
    endSettlement(claim);
    // With the lease gone, the same refund goes through.
    expect(refundEscrowForTerminalJob(jobId).outcome).toBe("refund_pending");
  });
});

describe("F6: the shared-escrow check", () => {
  it("sees a job that reaches the escrow only through its row (jobs.cwmId), and one only through its session, once each", () => {
    const a = seed();
    const sessionA = getStore().db.select().from(schema.negotiationSessions).where(eq(schema.negotiationSessions.jobId, a.jobId)).get()!;
    const jobA = getRepos().jobs.findById(a.jobId)!;
    // B: its own row names the escrow's CWM, its session names another.
    getRepos().jobs.insert({ ...jobA, id: "job-r3-b", status: "in_progress" });
    getStore().db.insert(schema.negotiationSessions).values({ ...sessionA, id: "sess-r3-b", jobId: "job-r3-b", cwmId: "cwm-elsewhere" }).run();
    // C: its row names another CWM, its session names the escrow's.
    getRepos().jobs.insert({ ...jobA, id: "job-r3-c", cwmId: "cwm-elsewhere-2", status: "in_progress" });
    getStore().db.insert(schema.negotiationSessions).values({ ...sessionA, id: "sess-r3-c", jobId: "job-r3-c" }).run();
    // D: both name the escrow's CWM: counted once.
    getRepos().jobs.insert({ ...jobA, id: "job-r3-d", status: "in_progress" });
    getStore().db.insert(schema.negotiationSessions).values({ ...sessionA, id: "sess-r3-d", jobId: "job-r3-d" }).run();

    const out = setJobStatusWithRefund(a.jobId, "cancelled").escrowRefund;
    expect(out).toEqual(expect.objectContaining({ outcome: "skipped", reason: "escrow_shared" }));
    const sharedWith = (out as { sharedWith: string[] }).sharedWith;
    expect([...sharedWith].sort()).toEqual(["job-r3-b", "job-r3-c", "job-r3-d"]);
    expect(escrowRow(a.escrowId).escrow).toBe("funded");
  });
});

describe("the keeper owns what it drives (real store)", () => {
  function keeperSees(address: string, state: unknown = attested(address)) {
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.getEscrowStateV2).mockImplementation(async (a) => {
      if (a !== address) throw new Error(`unexpected escrow read ${String(a)}`);
      return state as never;
    });
  }

  it("skips an escrow another operation holds (skippedBusy), records why, and drives nothing", async () => {
    const { jobId, escrowId, address } = seed();
    keeperSees(address);
    const held = claimOf(beginSettlement({ jobId })); // /complete, a release or a resume is acting on it
    const result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
    expect(result.skippedBusy).toBe(1);
    expect(result.released).toBe(0);
    expect(driveSettlement).not.toHaveBeenCalled();
    expect(result.milestones).toEqual([expect.objectContaining({ escrowId, disposition: "busy" })]);
    expect(escrowRow(escrowId).escrow).toBe("completing"); // untouched
    expect(beginSettlement({ jobId }).disposition).toBe("busy"); // the holder still holds it
    endSettlement(held);
  });

  it("does not drive an escrow that was given back after the sweep's snapshot, and never overwrites the refund", async () => {
    // N79 round 4 (R4-M1): the keeper takes each escrow's claim right BEFORE its chain read, so no refund lands on the
    // escrow it is reading (n79-r4-review.test.ts pins that). A refund can still land on an escrow the sweep has not
    // reached yet: B is given back while the keeper is busy with A, after the snapshot. B's claim must see the refund.
    const a = seed();
    const b = seed();
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    const readA = deferred();
    vi.mocked(chain.getEscrowStateV2).mockImplementation(async (address) => {
      if (address === a.address) {
        await readA.promise;
        return attested(a.address) as never;
      }
      return attested(b.address) as never;
    });
    vi.mocked(driveSettlement).mockResolvedValue(driveResult({}));
    const sweep = runKeeperSweep(getRepos(), { nowSeconds: NOW });
    inflight.push(sweep);
    await vi.waitFor(() => expect(chain.getEscrowStateV2).toHaveBeenCalledWith(a.address));
    expect(setJobStatusWithRefund(a.jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }), // A is the keeper's
    );
    expect(setJobStatusWithRefund(b.jobId, "failed").escrowRefund?.outcome).toBe("refund_pending"); // B is not yet
    readA.resolve();
    const result = await sweep;
    expect(result.skippedTerminal).toBe(1);
    expect(chain.getEscrowStateV2).not.toHaveBeenCalledWith(b.address); // refused at the claim, before any read
    expect(vi.mocked(driveSettlement).mock.calls.map((c) => c[0])).toEqual([a.address]);
    expect(result.milestones).toEqual(
      expect.arrayContaining([expect.objectContaining({ escrowId: b.escrowId, disposition: "terminal_other" })]),
    );
    expect(escrowRow(b.escrowId)).toEqual({ escrow: "refund_pending", milestones: ["refund_pending"] });
    expect(escrowRow(a.escrowId)).toEqual({ escrow: "completed", milestones: ["released"] });
  });

  it("an escrow the chain already reads fully Released completes under a claim: the escrow and every milestone row", async () => {
    const { escrowId, address } = seed({ milestones: ["funded"] });
    keeperSees(address, attested(address, chain.MilestoneStatusV2.Released));
    const result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
    expect(driveSettlement).not.toHaveBeenCalled();
    expect(result.reconciledCompleted).toBe(1);
    expect(escrowRow(escrowId)).toEqual({ escrow: "completed", milestones: ["released"] });
  });

  // N79 round 4 (R4-M1; the lead's one authorized edit of this test). Round 3 asserted the UNSAFE outcome of the pre-read
  // race: it let a refund land while the keeper's chain read was in flight and accepted `refund_pending` even when the read
  // then returned a fully Released escrow (a false refund decision on money that had moved). The keeper now owns the escrow
  // BEFORE the read, so the refund is skipped and the Released escrow completes.
  it("a fully-Released escrow cannot be refunded while the keeper's read is in flight: the refund is skipped, and the escrow completes once the read returns", async () => {
    const { jobId, escrowId, address } = seed();
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    const read = deferred();
    vi.mocked(chain.getEscrowStateV2).mockImplementation(async () => {
      await read.promise;
      return attested(address, chain.MilestoneStatusV2.Released);
    });
    const sweep = runKeeperSweep(getRepos(), { nowSeconds: NOW });
    inflight.push(sweep);
    await vi.waitFor(() => expect(chain.getEscrowStateV2).toHaveBeenCalled());
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );
    read.resolve();
    const result = await sweep;
    expect(result.reconciledCompleted).toBe(1);
    expect(result.skippedTerminal).toBe(0);
    expect(escrowRow(escrowId)).toEqual({ escrow: "completed", milestones: ["released"] });
  });

  it("marks the row of a milestone the chain already reads Released at once, even when nothing is driven; a later refund stops", async () => {
    const { jobId, escrowId, address } = seed({ milestones: ["funded", "funded"] });
    keeperSees(address, chainState(address, [chain.MilestoneStatusV2.Released, chain.MilestoneStatusV2.Evidenced]));
    const result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
    expect(driveSettlement).not.toHaveBeenCalled();
    expect(result.milestones.map((m) => m.disposition)).toEqual(["already_released", "not_ready"]);
    expect(escrowRow(escrowId)).toEqual({ escrow: "funded", milestones: ["released", "funded"] });
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "milestone_past_funding" }),
    );
  });

  it("marks a settled drive's row at once even when the escrow is then handed back (a later drive of the same escrow throws)", async () => {
    const { escrowId, address } = seed({ milestones: ["funded", "funded"] });
    keeperSees(address, chainState(address, [chain.MilestoneStatusV2.Attested, chain.MilestoneStatusV2.Attested]));
    vi.mocked(driveSettlement).mockResolvedValueOnce(driveResult({})).mockRejectedValueOnce(new Error("rpc down"));
    const result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
    expect(result.released).toBe(1);
    expect(result.blocked).toBe(1);
    expect(escrowRow(escrowId)).toEqual({ escrow: "funded", milestones: ["released", "funded"] });
  });

  // N79 round 4 (R4-H3; the lead's one authorized edit of this test). Round 3 asserted the UNSAFE hand-back: after a drive
  // settled milestone 0 on-chain but its row write failed, the escrow went back to `funded` with both rows `funded`, so a
  // later failure refunded a partly paid escrow. A paid milestone whose row is missing keeps the escrow durably `completing`.
  it("a failed row record is logged and does not stop the sweep: the escrow is NOT handed back (a paid milestone has no row), so no refund can land, and the lease ends (round 6: one guarded writer, no per-row logger.warn)", async () => {
    const { jobId, escrowId, address } = seed({ milestones: ["funded", "funded"] });
    keeperSees(address, chainState(address, [chain.MilestoneStatusV2.Attested, chain.MilestoneStatusV2.Evidenced]));
    vi.mocked(driveSettlement).mockResolvedValue(driveResult({}));
    const writes = vi.spyOn(getRepos().escrows, "updateMilestoneStatus").mockImplementation(() => {
      throw new Error("disk full");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.fn();
    try {
      const result = await runKeeperSweep(getRepos(), { nowSeconds: NOW, logger: { info: vi.fn(), warn } });
      expect(result.released).toBe(1); // the money moved; the failed bookkeeping does not undo or hide that
      // N79 round 6 (P1, one guarded writer): the per-row record now happens inside `recordChainSettlement`
      // (escrow-refund.ts), which has no access to the keeper's own injected `logger` — only `console.error`
      // is reachable from there, so the `logger.warn("could not record...")` this test used to see is gone.
      // The money-safety assertions below (what matters) are unchanged: the row is not stamped, the escrow is
      // not handed back, no refund can land.
      expect(warn).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledWith("[escrow] settlement_record_failed", expect.objectContaining({ escrowId, milestoneIndex: 0 }));
    } finally {
      writes.mockRestore();
      errors.mockRestore();
    }
    expect(escrowRow(escrowId)).toEqual({ escrow: "completing", milestones: ["funded", "funded"] });
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );
    expect(beginSettlement({ escrowId }).disposition).toBe("adopted"); // the lease ended; the durable mark is adopted by the next claim
  });

  it("hands an escrow back when the drive does not settle it, restoring the status it took it from", async () => {
    const { escrowId, address } = seed({ status: "active" });
    keeperSees(address);
    vi.mocked(driveSettlement).mockResolvedValue(driveResult({ settled: false, outcome: "awaiting_challenge_window", finalStatus: "Attested" }));
    const result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
    expect(result.released).toBe(0);
    expect(escrowRow(escrowId)).toEqual({ escrow: "active", milestones: ["funded"] });
    expect(beginSettlement({ escrowId }).disposition).toBe("acquired"); // the lease is gone too
  });

  it("gives the escrow to the payer when its job ended during a drive that did not settle", async () => {
    const { jobId, escrowId, address } = seed();
    keeperSees(address);
    const drive = deferred({ value: driveResult({ settled: false, outcome: "blocked" }) });
    vi.mocked(driveSettlement).mockReturnValue(drive.promise);
    const sweep = runKeeperSweep(getRepos(), { nowSeconds: NOW });
    inflight.push(sweep);
    await vi.waitFor(() => expect(driveSettlement).toHaveBeenCalled());
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }));
    drive.resolve(driveResult({ settled: false, outcome: "awaiting_challenge_window", finalStatus: "Attested" }));
    await sweep;
    expect(escrowRow(escrowId)).toEqual({ escrow: "refund_pending", milestones: ["refund_pending"] });
  });

  it("a drive that throws hands the escrow back and ends the lease", async () => {
    const { escrowId, address } = seed();
    keeperSees(address);
    vi.mocked(driveSettlement).mockRejectedValue(new Error("rpc down"));
    const result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
    expect(result.blocked).toBe(1);
    expect(escrowRow(escrowId).escrow).toBe("funded");
    expect(beginSettlement({ escrowId }).disposition).toBe("acquired");
  });

  it("settles an escrow whose row lags the chain: `created`, `completing` (adopted), and a status only the keeper may lease", async () => {
    for (const status of ["created", "completing", "disputed"]) {
      const { escrowId, address } = seed({ status });
      keeperSees(address);
      vi.mocked(driveSettlement).mockResolvedValue(driveResult({}));
      const result = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
      expect(result.released).toBe(1);
      expect(result.reconciledCompleted).toBe(1);
      expect(escrowRow(escrowId).escrow).toBe("completed");
      vi.mocked(driveSettlement).mockReset();
    }
  });

  it("two overlapping sweeps never drive the same escrow twice: the second finds it busy", async () => {
    const { escrowId, address } = seed();
    keeperSees(address);
    const drive = deferred({ value: driveResult({ settled: false, outcome: "blocked" }) });
    vi.mocked(driveSettlement).mockReturnValue(drive.promise);
    const first = runKeeperSweep(getRepos(), { nowSeconds: NOW });
    inflight.push(first);
    await vi.waitFor(() => expect(driveSettlement).toHaveBeenCalledTimes(1));

    const second = await runKeeperSweep(getRepos(), { nowSeconds: NOW });
    expect(second.skippedBusy).toBe(1);
    expect(driveSettlement).toHaveBeenCalledTimes(1);

    drive.resolve(driveResult({}));
    expect((await first).released).toBe(1);
    expect(escrowRow(escrowId)).toEqual({ escrow: "completed", milestones: ["released"] });
  });

  it("never leaks a lease: after a sweep every escrow can be claimed again", async () => {
    const one = seed();
    const two = seed();
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.getEscrowStateV2).mockImplementation(async (a) => attested(a as string));
    vi.mocked(driveSettlement).mockResolvedValueOnce(driveResult({})).mockResolvedValueOnce(driveResult({ settled: false, outcome: "blocked" }));
    await runKeeperSweep(getRepos(), { nowSeconds: NOW });
    for (const s of [one, two]) {
      const d = beginSettlement({ escrowId: s.escrowId }, { leaseOnly: true }).disposition;
      expect(["acquired", "blocked"]).toContain(d); // blocked = completed by the keeper; never busy
    }
  });
});

describe("the callers refuse an escrow they cannot own, and give back what they took", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(paidJobFlowRoutes);
    await app.register(negotiationRoutes);
    await app.register(jobRoutes);
    await app.register(escrowRoutes);
    await app.register(settlementRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function submitPaidJob(userAgentId: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: { kernelId: "kernel-nyc", capabilityType: "liquid-handler", userAgentId },
    });
    expect(res.statusCode).toBe(201);
    return res.json().jobId as string;
  }

  const complete = (jobId: string) => app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
  const resume = (jobId: string) => app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });
  const jobStatus = (jobId: string) => getRepos().jobs.findById(jobId)?.status;

  describe("PUT /complete", () => {
    it("answers 409 settlement_in_progress when another operation holds the escrow, and gives the job its status back", async () => {
      const jobId = await submitPaidJob("user-r3-complete-busy");
      const before = jobStatus(jobId);
      const held = claimOf(beginSettlement({ jobId }));
      const res = await complete(jobId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(expect.objectContaining({ error: "settlement_in_progress", escrowStatus: "completing" }));
      expect(jobStatus(jobId)).toBe(before);
      expect(beginSettlement({ jobId }).disposition).toBe("busy"); // the holder's lease is untouched
      endSettlement(held);
    });

    it("answers 409 escrow_not_releasable for an escrow that is not releasable, and gives the job its status back", async () => {
      const jobId = await submitPaidJob("user-r3-complete-blocked");
      const before = jobStatus(jobId);
      const escrow = escrowForJob(jobId)!;
      getRepos().escrows.updateStatus(escrow.id, "disputed");
      const res = await complete(jobId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(expect.objectContaining({ error: "escrow_not_releasable", escrowStatus: "disputed" }));
      expect(jobStatus(jobId)).toBe(before);
      expect(escrowRow(escrow.id).escrow).toBe("disputed");
    });

    it("ends its lease on every exit: success, a failure before evidence (handed back), and a failure after it (kept completing)", async () => {
      const ok = await submitPaidJob("user-r3-complete-ok");
      expect((await complete(ok)).statusCode).toBe(200);
      const okEscrow = escrowForJob(ok)!;
      expect(escrowRow(okEscrow.id)).toEqual({ escrow: "completed", milestones: ["released"] });
      expect(beginSettlement({ escrowId: okEscrow.id }).disposition).toBe("blocked"); // completed, and not busy: no lease left

      const early = await submitPaidJob("user-r3-complete-early");
      const insert = vi.spyOn(getRepos().evidence, "insert").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      try {
        expect((await complete(early)).statusCode).toBe(500);
      } finally {
        insert.mockRestore();
      }
      const earlyEscrow = escrowForJob(early)!;
      expect(escrowRow(earlyEscrow.id).escrow).toBe("funded"); // handed back: no evidence, no settlement
      expect(beginSettlement({ escrowId: earlyEscrow.id }).disposition).toBe("acquired"); // and no lease left

      const late = await submitPaidJob("user-r3-complete-late");
      gates.oracleThrows = true;
      expect((await complete(late)).statusCode).toBe(500);
      const lateEscrow = escrowForJob(late)!;
      expect(escrowRow(lateEscrow.id).escrow).toBe("completing");
      expect(beginSettlement({ escrowId: lateEscrow.id }).disposition).toBe("adopted"); // kept, owned by no one right now
    });

    it("its completion is a compare-and-set under the lease: a row that moved on beneath it is never overwritten, and it says so", async () => {
      const jobId = await submitPaidJob("user-r3-complete-cas");
      const escrow = escrowForJob(jobId)!;
      const entered = deferred();
      const hold = deferred();
      gates.onOracle = () => entered.resolve();
      gates.oracle = hold.promise;
      const completing = complete(jobId);
      inflight.push(completing);
      await entered.promise; // evidence is recorded; the settlement holds the escrow (completing) and waits at the oracle
      getRepos().escrows.updateStatus(escrow.id, "refund_pending"); // outside the protocol, beneath the live lease
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        hold.resolve();
        expect((await completing).statusCode).toBe(200);
        expect(errors).toHaveBeenCalledWith("[escrow] settlement_record_failed", expect.objectContaining({ escrowId: escrow.id, jobId }));
      } finally {
        errors.mockRestore();
      }
      expect(escrowRow(escrow.id).escrow).toBe("refund_pending"); // not overwritten with completed
    });

    it("a chain escrow whose row reads `created` (the live normal state) still completes", async () => {
      const jobId = await submitPaidJob("user-r3-complete-created");
      const escrow = escrowForJob(jobId)!;
      getRepos().escrows.updateStatus(escrow.id, "created");
      for (const m of getRepos().escrows.findMilestonesByEscrow(escrow.id)) getRepos().escrows.updateMilestoneStatus(m.id, "pending");
      const res = await complete(jobId);
      expect(res.statusCode).toBe(200);
      expect(escrowRow(escrow.id)).toEqual({ escrow: "completed", milestones: ["released"] });
      expect(jobStatus(jobId)).toBe("settled");
    });
  });

  describe("POST /resume-settlement", () => {
    /** The durable state a failed /complete leaves after its evidence: evidence recorded, job evidence_submitted, escrow completing. */
    async function stuckAfterEvidence(agent: string): Promise<string> {
      const jobId = await submitPaidJob(agent);
      gates.oracleThrows = true;
      expect((await complete(jobId)).statusCode).toBe(500);
      gates.oracleThrows = false;
      expect(jobStatus(jobId)).toBe("evidence_submitted");
      expect(escrowRow(escrowForJob(jobId)!.id).escrow).toBe("completing");
      return jobId;
    }

    it("answers 409 settlement_in_progress when another operation holds the escrow, and puts the job back as it was", async () => {
      const jobId = await stuckAfterEvidence("user-r3-resume-busy");
      const held = claimOf(beginSettlement({ jobId })); // adopted
      const res = await resume(jobId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(expect.objectContaining({ error: "settlement_in_progress" }));
      expect(jobStatus(jobId)).toBe("evidence_submitted");
      endSettlement(held);
      expect((await resume(jobId)).statusCode).toBe(200); // once the holder is done, it resumes
      expect(jobStatus(jobId)).toBe("settled");
    });

    it("its completion is a compare-and-set under the lease: a row that moved on beneath it is never overwritten, and it says so", async () => {
      const jobId = await stuckAfterEvidence("user-r3-resume-cas");
      const escrow = escrowForJob(jobId)!;
      const entered = deferred();
      const hold = deferred();
      gates.onOracle = () => entered.resolve();
      gates.oracle = hold.promise;
      const resuming = resume(jobId);
      inflight.push(resuming);
      await entered.promise; // the resume holds the escrow (adopted) and waits at the oracle gate
      getRepos().escrows.updateStatus(escrow.id, "refund_pending"); // outside the protocol, beneath the live lease
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        hold.resolve();
        expect((await resuming).statusCode).toBe(200);
        expect(errors).toHaveBeenCalledWith("[escrow] settlement_record_failed", expect.objectContaining({ escrowId: escrow.id, jobId }));
      } finally {
        errors.mockRestore();
      }
      expect(escrowRow(escrow.id).escrow).toBe("refund_pending"); // not overwritten with completed
    });

    it("answers 409 escrow_not_releasable for an escrow that is not releasable, and puts the job back as it was", async () => {
      const jobId = await submitPaidJob("user-r3-resume-blocked");
      getRepos().jobs.updateStatus(jobId, "evidence_submitted");
      getRepos().escrows.updateStatus(escrowForJob(jobId)!.id, "disputed");
      const res = await resume(jobId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(expect.objectContaining({ error: "escrow_not_releasable", escrowStatus: "disputed" }));
      expect(jobStatus(jobId)).toBe("evidence_submitted");
    });

    it.each(["failed", "cancelled", "timed_out"])("recovers a job rewritten to %s after its evidence was recorded", async (terminal) => {
      const jobId = await stuckAfterEvidence(`user-r3-resume-${terminal}`);
      getRepos().jobs.updateStatus(jobId, terminal);
      const res = await resume(jobId);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("settled");
      expect(jobStatus(jobId)).toBe("settled");
      expect(escrowRow(escrowForJob(jobId)!.id)).toEqual({ escrow: "completed", milestones: ["released"] });
    });

    it("a recovered job that does not settle is put back as the status it had, and its escrow stays owned", async () => {
      const jobId = await stuckAfterEvidence("user-r3-resume-restore");
      setJobStatusWithRefund(jobId, "failed");
      process.env.MOCK_SETTLEMENT = "false"; // real settlement: it waits for the window instead of settling at once
      const res = await resume(jobId);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("failed");
      expect(jobStatus(jobId)).toBe("failed");
      const escrow = escrowForJob(jobId)!;
      expect(escrowRow(escrow.id).escrow).toBe("completing");
      expect(beginSettlement({ escrowId: escrow.id }).disposition).toBe("adopted"); // lease ended
      process.env.MOCK_SETTLEMENT = "true";
    });

    it.each(["completing", "created", "funded", "active"])(
      "recovers a failed job whose escrow row reads %s (evidence recorded): beginSettlement decides, the resume settles it",
      async (status) => {
        const jobId = await stuckAfterEvidence(`user-r3-resume-row-${status}`);
        const escrow = escrowForJob(jobId)!;
        getRepos().escrows.updateStatus(escrow.id, status);
        getRepos().jobs.updateStatus(jobId, "failed");
        const res = await resume(jobId);
        expect(res.statusCode).toBe(200);
        expect(jobStatus(jobId)).toBe("settled");
        expect(escrowRow(escrow.id)).toEqual({ escrow: "completed", milestones: ["released"] });
        expect(beginSettlement({ escrowId: escrow.id }).disposition).toBe("blocked"); // completed, and no lease left behind
      },
    );

    it("does not resume a failed job without an evidence bundle, without an escrow, or whose escrow cannot be released", async () => {
      // The escrow reads completing, but there is no evidence bundle.
      const noEvidence = await submitPaidJob("user-r3-resume-noevidence");
      getRepos().escrows.updateStatus(escrowForJob(noEvidence)!.id, "completing");
      getRepos().jobs.updateStatus(noEvidence, "failed");
      const first = await resume(noEvidence);
      expect(first.statusCode).toBe(409);
      expect(first.json().error).toMatch(/resumable/i);
      expect(jobStatus(noEvidence)).toBe("failed");
      expect(escrowRow(escrowForJob(noEvidence)!.id).escrow).toBe("completing");

      // Evidence recorded, but the job has no escrow (its session names a CWM nothing escrows).
      const noEscrow = await stuckAfterEvidence("user-r3-resume-noescrow");
      getStore().db.update(schema.negotiationSessions).set({ cwmId: "cwm-nothing-escrows-this" }).where(eq(schema.negotiationSessions.jobId, noEscrow)).run();
      expect(escrowForJob(noEscrow)).toBeUndefined();
      getRepos().jobs.updateStatus(noEscrow, "failed");
      const second = await resume(noEscrow);
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toMatch(/resumable/i);
      expect(jobStatus(noEscrow)).toBe("failed");

      // Evidence recorded, but the escrow is in a state no release starts from: refused, and the job is put back as it was.
      const disputed = await stuckAfterEvidence("user-r3-resume-failed-disputed");
      getRepos().escrows.updateStatus(escrowForJob(disputed)!.id, "disputed");
      getRepos().jobs.updateStatus(disputed, "failed");
      const third = await resume(disputed);
      expect(third.statusCode).toBe(409);
      expect(third.json()).toEqual(expect.objectContaining({ error: "escrow_not_releasable", escrowStatus: "disputed" }));
      expect(jobStatus(disputed)).toBe("failed");
      expect(escrowRow(escrowForJob(disputed)!.id).escrow).toBe("disputed");

      // Evidence recorded, but the escrow was given back: never released.
      const givenBack = await stuckAfterEvidence("user-r3-resume-failed-refunded");
      getRepos().escrows.updateStatus(escrowForJob(givenBack)!.id, "refund_pending");
      getRepos().jobs.updateStatus(givenBack, "failed");
      const fourth = await resume(givenBack);
      expect(fourth.statusCode).toBe(409);
      expect(fourth.json().error).toBe("escrow_refunded");
      expect(jobStatus(givenBack)).toBe("failed");
    });

    it("does not resume a failed job whose only evidence is a row some other path inserted (the relay's): /complete never recorded it", async () => {
      // As the operator relay does for any existing job (it has no owner check, N85): an evidence row, but no
      // jobs.evidenceBundleId, which only /complete writes. A bare row does not prove that settlement began.
      const jobId = await submitPaidJob("user-r3-resume-relay-row");
      const escrow = escrowForJob(jobId)!;
      getRepos().evidence.insert({
        id: `bundle-relay-${jobId}`,
        jobId,
        stepId: "operator-relay",
        kernelId: "kernel-nyc",
        assuranceTier: 0,
        bundleHash: `sha256-bundle-relay-${jobId}`,
        kernelSignature: { signer: "kernel-nyc", algorithm: "sha256", value: "operator-relay-auto" },
        sessionKeyAuthorization: null,
        createdAt: new Date().toISOString(),
      } as never);
      getRepos().jobs.updateStatus(jobId, "failed");
      expect(getRepos().jobs.findById(jobId)?.evidenceBundleId ?? null).toBeNull();

      const res = await resume(jobId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/resumable/i);
      expect(jobStatus(jobId)).toBe("failed");
      expect(escrowRow(escrow.id).escrow).toBe("funded");
      expect(beginSettlement({ escrowId: escrow.id }).disposition).toBe("acquired"); // no lease left behind, row untouched
    });

    it("settles on the evidence its own /complete recorded, never on a later row some other path appended for the job", async () => {
      const jobId = await stuckAfterEvidence("user-r3-resume-own-bundle");
      const recorded = getRepos().jobs.findById(jobId)?.evidenceBundleId;
      expect(recorded).toBeTruthy();
      // A later row for the same job, as the operator relay inserts for any existing job (no owner check, N85).
      getRepos().evidence.insert({
        id: `bundle-appended-${jobId}`,
        jobId,
        stepId: "operator-relay",
        kernelId: "kernel-nyc",
        assuranceTier: 0,
        bundleHash: `sha256-bundle-appended-${jobId}`,
        kernelSignature: { signer: "kernel-nyc", algorithm: "sha256", value: "operator-relay-auto" },
        sessionKeyAuthorization: null,
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      } as never);
      const res = await resume(jobId);
      expect(res.statusCode).toBe(200);
      expect(res.json().evidenceBundleId).toBe(recorded);
    });

    it("a settled job is not resumed; an escrow that already completed reconciles the job without a claim", async () => {
      const jobId = await stuckAfterEvidence("user-r3-resume-completed");
      getRepos().escrows.updateStatus(escrowForJob(jobId)!.id, "completed");
      const res = await resume(jobId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(expect.objectContaining({ alreadySettled: true, status: "settled" }));
      expect(jobStatus(jobId)).toBe("settled");
      expect((await resume(jobId)).statusCode).toBe(409);
    });

    it("hands back the escrow it took when there is no evidence, even for a legacy `active` row", async () => {
      const jobId = await submitPaidJob("user-r3-resume-active");
      const escrow = escrowForJob(jobId)!;
      getRepos().escrows.updateStatus(escrow.id, "active");
      getRepos().jobs.updateStatus(jobId, "evidence_submitted");
      expect((await resume(jobId)).statusCode).toBe(409);
      expect(escrowRow(escrow.id).escrow).toBe("active");
      expect(beginSettlement({ escrowId: escrow.id }).disposition).toBe("acquired");
    });
  });

  describe("POST /api/escrow/chain/:address/release/:index", () => {
    const release = (address: string) => app.inject({ method: "POST", url: `/api/escrow/chain/${address}/release/0`, payload: {} });

    beforeEach(() => {
      process.env.PCC_USE_EAS_V2 = "true";
      vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
      vi.mocked(chain.releaseMilestoneV2).mockResolvedValue({ transactionHash: "0xraw", status: "submitted" } as never);
    });

    it("answers 409 settlement_in_progress while another operation holds the escrow, and sends nothing", async () => {
      const { escrowId, address } = seed();
      const held = claimOf(beginSettlement({ escrowId }));
      const res = await release(address);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(expect.objectContaining({ error: "settlement_in_progress", escrowStatus: "completing" }));
      expect(chain.releaseMilestoneV2).not.toHaveBeenCalled();
      expect(beginSettlement({ escrowId }).disposition).toBe("busy");
      endSettlement(held);
    });

    it.each(["disputed", "completed"])("answers 409 escrow_not_releasable for a %s escrow, and sends nothing", async (status) => {
      const { escrowId, address } = seed({ status });
      const res = await release(address);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(expect.objectContaining({ error: "escrow_not_releasable", escrowStatus: status }));
      expect(chain.releaseMilestoneV2).not.toHaveBeenCalled();
      expect(escrowRow(escrowId).escrow).toBe(status);
    });

    it("releases an address the gateway does not know (nothing to protect)", async () => {
      const res = await release(addr(0xfeed));
      expect(res.statusCode).toBe(200);
      expect(chain.releaseMilestoneV2).toHaveBeenCalledTimes(1);
    });

    it("a `created` row still releases and completes (a live chain escrow's normal state)", async () => {
      const { escrowId, address } = seed({ status: "created" });
      // N79 round 6: the post-release mapping read (H2-A) — the chain confirms the SAME single milestone this
      // call just released. Fixture only; no assertion below changed.
      vi.mocked(chain.getEscrowStateV2).mockResolvedValue(chainState(address, [chain.MilestoneStatusV2.Released]));
      const res = await release(address);
      expect(res.statusCode).toBe(200);
      expect(res.json().recorded).toBeUndefined();
      expect(escrowRow(escrowId)).toEqual({ escrow: "completed", milestones: ["released"] });
    });

    it("a release that fails hands the escrow back and ends the lease: the next release is not busy", async () => {
      const { escrowId, address } = seed();
      // N79 round 6: the SECOND release's post-release mapping read (H2-A) — fixture only.
      vi.mocked(chain.getEscrowStateV2).mockResolvedValue(chainState(address, [chain.MilestoneStatusV2.Released]));
      vi.mocked(chain.releaseMilestoneV2).mockRejectedValueOnce(new Error("execution reverted"));
      expect((await release(address)).statusCode).toBe(502);
      expect(escrowRow(escrowId).escrow).toBe("funded");
      expect((await release(address)).statusCode).toBe(200);
      expect(escrowRow(escrowId)).toEqual({ escrow: "completed", milestones: ["released"] });
    });

    it("a confirmed release whose bookkeeping failed still ends the lease and leaves the escrow owned (completing)", async () => {
      const { escrowId, address } = seed();
      const writes = vi.spyOn(getRepos().escrows, "updateMilestoneStatus").mockImplementation(() => {
        throw new Error("disk full");
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect((await release(address)).json()).toEqual(expect.objectContaining({ recorded: false, reconcile: "required" }));
      } finally {
        writes.mockRestore();
        errors.mockRestore();
      }
      expect(escrowRow(escrowId).escrow).toBe("completing");
      expect(beginSettlement({ escrowId }).disposition).toBe("adopted"); // not busy: the lease ended; the mark stays
    });
  });

  describe("SettlementService.releaseMilestone", () => {
    const attestation = (address: string) => ({ escrowAddress: address, evidenceHash: `0x${"cd".repeat(32)}` }) as never;

    beforeEach(() => {
      vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
      vi.mocked(chain.releaseMilestone).mockResolvedValue({ transactionHash: "0xsvc", status: "submitted" } as never);
    });

    it("fails settlement_in_progress while another operation holds the job's escrow, and never calls the chain", async () => {
      const { jobId, escrowId, address } = seed();
      const held = claimOf(beginSettlement({ escrowId }));
      expect(await getSettlementService().releaseMilestone(jobId, 0, attestation(address), address)).toEqual(
        expect.objectContaining({ status: "failed", error: "settlement_in_progress" }),
      );
      expect(chain.releaseMilestone).not.toHaveBeenCalled();
      endSettlement(held);
    });

    it("fails escrow_not_releasable:<status> for an escrow that is not releasable, and never calls the chain", async () => {
      const { jobId, address } = seed({ status: "disputed" });
      expect(await getSettlementService().releaseMilestone(jobId, 0, attestation(address), address)).toEqual(
        expect.objectContaining({ status: "failed", error: "escrow_not_releasable:disputed" }),
      );
      expect(chain.releaseMilestone).not.toHaveBeenCalled();
    });

    it("claims the escrow at the named address when the job has none of its own", async () => {
      const { escrowId, address } = seed();
      // N79 round 6: the post-release mapping read (H2-A), V1 ABI (SettlementService.releaseMilestone) — fixture only.
      vi.mocked(chain.getEscrowState).mockResolvedValue(chainState(address, [chain.MilestoneStatusV2.Released]) as never);
      const held = claimOf(beginSettlement({ escrowId }));
      expect(await getSettlementService().releaseMilestone("job-without-an-escrow", 0, attestation(address), address)).toEqual(
        expect.objectContaining({ status: "failed", error: "settlement_in_progress" }),
      );
      endSettlement(held);
      expect(await getSettlementService().releaseMilestone("job-without-an-escrow", 0, attestation(address), address)).toEqual(
        expect.objectContaining({ status: "released" }),
      );
      expect(escrowRow(escrowId)).toEqual({ escrow: "completed", milestones: ["released"] });
    });

    it("a confirmed release whose bookkeeping failed is still released, says recorded:false, and keeps the escrow owned", async () => {
      const { jobId, escrowId, address } = seed();
      const writes = vi.spyOn(getRepos().escrows, "updateMilestoneStatus").mockImplementation(() => {
        throw new Error("disk full");
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      let result;
      try {
        result = await getSettlementService().releaseMilestone(jobId, 0, attestation(address), address);
        expect(errors).toHaveBeenCalledWith(
          "[escrow] settlement_record_failed",
          expect.objectContaining({ escrowId, milestoneIndex: 0, txHash: "0xsvc" }),
        );
      } finally {
        writes.mockRestore();
        errors.mockRestore();
      }
      expect(result).toEqual(expect.objectContaining({ status: "released", txHash: "0xsvc", recorded: false, reconcile: "required" }));
      expect(escrowRow(escrowId).escrow).toBe("completing");
      expect(beginSettlement({ escrowId }).disposition).toBe("adopted");
    });

    it("POST /api/settlement/release keeps its shape on a normal release: no recorded flag", async () => {
      const { jobId, escrowId, address } = seed();
      // N79 round 6: the post-release mapping read (H2-A), V1 ABI — fixture only.
      vi.mocked(chain.getEscrowState).mockResolvedValue(chainState(address, [chain.MilestoneStatusV2.Released]) as never);
      const res = await app.inject({
        method: "POST",
        url: "/api/settlement/release",
        payload: { jobId, milestoneIndex: 0, contractAddress: address, attestation: attestation(address) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ txHash: "0xsvc", status: "released", jobId, milestoneIndex: 0 });
      expect(escrowRow(escrowId)).toEqual({ escrow: "completed", milestones: ["released"] });
    });

    it("a release that fails hands the escrow back and ends the lease", async () => {
      const { jobId, escrowId, address } = seed();
      vi.mocked(chain.releaseMilestone).mockRejectedValueOnce(new Error("execution reverted"));
      expect(await getSettlementService().releaseMilestone(jobId, 0, attestation(address), address)).toEqual(expect.objectContaining({ status: "failed" }));
      expect(escrowRow(escrowId).escrow).toBe("funded");
      expect(beginSettlement({ escrowId }).disposition).toBe("acquired");
    });
  });

  describe("the releaseByJob retry policy", () => {
    const policy = releaseMilestoneByJobActivity.retryPolicy;

    it("an escrow no release can start from is not retried; one another settlement holds is", () => {
      expect(isNonRetryable(policy, new Error("escrow_not_releasable:disputed"))).toBe(true);
      expect(isNonRetryable(policy, new Error("escrow_refunded"))).toBe(true);
      expect(isNonRetryable(policy, new Error("settlement_in_progress"))).toBe(false);
    });
  });
});
