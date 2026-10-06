/**
 * N79 x N85(a) merge-up composition (#462 master merge-up, job.facade.ts's `updateStatus` conflict).
 *
 * `writeJobStatusGuardedWithRefund` (escrow-refund.ts) composes N85(a)'s `writeJobStatusGuarded`
 * (settlement-owned-status.ts) with N79's refund-on-terminal-failure, in ONE `db.transaction`: the guard
 * decides whether a GENERIC writer may touch the job at all; only once it already says "written" does this
 * function decide whether the now-terminal status also gives the escrow back.
 *
 * Unreachable through the real guard today: `hasSettlementRecord` already treats a job's own negotiation
 * session (or an escrow reachable through its cwmId) as a settlement record, so `writeJobStatusGuarded`
 * refuses every terminal write on a job N79 could refund, before this function's refund branch is ever
 * reached (escrow-refund.ts's module doc, "WHO MAY TRIGGER IT"). This test mocks `writeJobStatusGuarded`
 * directly to exercise the composition's own three properties, forward-compatible with N85(a) ever being
 * relaxed (gateway was asked in #6374 about a pre-execution cancel of a paid job).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema } from "@pcc/store";

vi.mock("../services/settlement-owned-status.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/settlement-owned-status.js")>();
  return { ...actual, writeJobStatusGuarded: vi.fn() };
});

import { writeJobStatusGuarded } from "../services/settlement-owned-status.js";
import { writeJobStatusGuardedWithRefund } from "../services/escrow-refund.js";

const BUYER = "0x00000000000000000000000000000000000b0b01";

/** A job with a negotiation session + a funded mock escrow (one milestone) -- a settlement record, so the
 *  REAL guard would already refuse a terminal write on it (hence the mock above). Same shape as
 *  n79-refund-authority.test.ts's seedPaidJob. */
function seedPaidJob(jobId: string, status: string): { escrowId: string } {
  const repos = getRepos();
  const capability = repos.capabilities.findAll()[0];
  if (!capability) throw new Error("the seeded store has no capability");
  const cwmId = `cwm-${jobId}`;
  const now = new Date().toISOString();
  repos.jobs.insert({
    id: jobId,
    stepId: "step-1",
    cwmId,
    capabilityId: capability.id,
    kernelId: capability.kernelId,
    status,
    assignedDevices: [],
  });
  getStore()
    .db.insert(schema.negotiationSessions)
    .values({
      id: `sess-${jobId}`,
      status: "committed",
      userAgentId: BUYER,
      kernelId: capability.kernelId,
      capabilityType: capability.type,
      operatorConstraints: {},
      jobId,
      cwmId,
      createdAt: now,
      expiresAt: now,
    })
    .run();
  const escrow = repos.escrows.insert({
    id: `esc-${jobId}`,
    cwmId,
    contractAddress: `mock-escrow-${jobId}`,
    payer: BUYER,
    totalAmount: "10.00",
    currency: "USDC",
    status: "funded",
    createdAt: now,
    deadline: now,
  });
  repos.escrows.insertMilestone({
    id: `ms-${jobId}`,
    escrowId: escrow!.id,
    stepId: "step-1",
    amount: "10.00",
    status: "funded",
    bondAmount: "0",
  });
  return { escrowId: escrow!.id };
}

/** The guard says "written" and ACTUALLY performs the status write (the same primitive the real guard uses),
 *  so there is something real for the refund branch -- and the rollback test below -- to act alongside. A
 *  forward-compatible stand-in for N85(a) ever allowing this write through for real. */
function allowAndWrite() {
  vi.mocked(writeJobStatusGuarded).mockImplementation((id: string, status: string, progress?: number) => {
    const job = getRepos().jobs.updateStatus(id, status, progress);
    return job ? { kind: "written" as const, job } : { kind: "not_found" as const };
  });
}

describe("N79 x N85(a) merge-up: writeJobStatusGuardedWithRefund composes the guard with the refund", () => {
  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.MOCK_SETTLEMENT = "true";
    initStore({ seed: true });
    vi.mocked(writeJobStatusGuarded).mockReset();
  });

  afterEach(() => {
    closeStore();
  });

  it("written + a terminal status: the escrow is given back in the SAME transaction", () => {
    const jobId = "job-compose-written";
    const { escrowId } = seedPaidJob(jobId, "in_progress");
    allowAndWrite();

    const result = writeJobStatusGuardedWithRefund(jobId, "cancelled");

    expect(result.outcome.kind).toBe("written");
    expect(result.escrowRefund).toEqual(expect.objectContaining({ outcome: "refunded", escrowId }));
    expect(getRepos().jobs.findById(jobId)?.status).toBe("cancelled");
    const escrow = getRepos().escrows.findById(escrowId)!;
    expect(escrow.status).toBe("refunded");
    expect(getRepos().escrows.findMilestonesByEscrow(escrowId).every((m) => m.status === "refunded")).toBe(true);
  });

  it("refused: nothing changes -- no escrowRefund key at all, the escrow untouched", () => {
    const jobId = "job-compose-refused";
    const { escrowId } = seedPaidJob(jobId, "in_progress");
    vi.mocked(writeJobStatusGuarded).mockReturnValue({ kind: "refused", currentStatus: "in_progress" });

    const result = writeJobStatusGuardedWithRefund(jobId, "cancelled");

    expect(result.outcome).toEqual({ kind: "refused", currentStatus: "in_progress" });
    expect("escrowRefund" in result).toBe(false);
    expect(getRepos().jobs.findById(jobId)?.status).toBe("in_progress");
    const escrow = getRepos().escrows.findById(escrowId)!;
    expect(escrow.status).toBe("funded");
  });

  it("when the refund throws, the status write rolls back too -- one transaction, not two", () => {
    const jobId = "job-compose-rollback";
    seedPaidJob(jobId, "in_progress");
    allowAndWrite();
    const repos = getRepos();
    const spy = vi.spyOn(repos.escrows, "updateMilestoneStatus").mockImplementation(() => {
      throw new Error("disk full");
    });

    try {
      expect(() => writeJobStatusGuardedWithRefund(jobId, "cancelled")).toThrow("disk full");
    } finally {
      spy.mockRestore();
    }
    // The guard's OWN status write ran first, inside the SAME transaction as the refund that then threw -- the
    // whole transaction rolls back, so the job is never left "cancelled" with its escrow still "funded" (the
    // exact strand this composition exists to prevent).
    expect(repos.jobs.findById(jobId)?.status).not.toBe("cancelled");
    expect(repos.jobs.findById(jobId)?.status).toBe("in_progress");
  });
});
