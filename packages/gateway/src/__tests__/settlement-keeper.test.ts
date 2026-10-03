/**
 * Unit tests for the settlement keeper (runKeeperSweep) — the permissionless
 * release-past-window closer (settlement pivot Step 2).
 *
 * All pure / mocked: no live chain. `getEscrowStateV2` + `isWriteEnabled` (the
 * keeper's on-chain reads) and `driveSettlement` (the crank it routes to) are
 * spied; the REAL MilestoneStatusV2 enum + name map are kept (importOriginal) so
 * status comparisons run against the true Solidity values.
 *
 * The keeper's own behaviour under proof here:
 *   • it routes ONLY Attested-past-window milestones to the crank (skipFund, no
 *     evidence/uid) — never funds, never drives below Attested,
 *   • it SURFACES terminal-other (Disputed/Slashed/Refunded), never settles it,
 *   • it reconciles an escrow to "completed" ONLY when every milestone is Released,
 *   • one unreadable escrow is soft-failed (sweep continues),
 *   • V3 rows + terminal DB statuses are skipped,
 *   • write-disabled short-circuits with no reads.
 *
 * The crank's own on-chain correctness (revert-mapping, F1/F2/F3 confirming
 * reads) is proven in settlement-crank.test.ts and, on a real chain, in
 * settlement-keeper.fork.test.ts — this file mocks the crank and asserts wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../contracts/escrow-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contracts/escrow-client.js")>();
  return {
    ...actual, // keep the REAL MilestoneStatusV2 + milestoneStatusV2Name
    isWriteEnabled: vi.fn().mockReturnValue(true),
    getEscrowStateV2: vi.fn(),
  };
});

vi.mock("../services/settlement-crank.js", () => ({
  driveSettlement: vi.fn(),
}));

// N79 round 3: the keeper claims each escrow through the ownership module (escrow-refund.ts), which works on the gateway's
// GLOBAL store, while runKeeperSweep takes its repos by injection (production passes getRepos(), the same store). These
// tests inject fake repos, so the ownership module is faked here with simple fakes: every escrow can be claimed, nothing is
// handed back on its own, and the mapping check always reports no drift (a test that needs drift overrides it). The
// real-store proof of the keeper's ownership (a refund during the drive, a busy escrow, a hand-back, the lease never
// leaking) is n79-r3-ownership.test.ts (F1) and n79-r3-lease.test.ts; the real-store proof of the mapping check and the
// guarded writer themselves (drift quarantine, partial hand-back, full completion) is n79-r5-review.test.ts and
// n79-r3-lease.test.ts.
//
// N79 round 6 (addendum 1, P1, "whichever leaves fewer doors"): `recordEscrowReleased` / `recordMilestoneRowReleased`
// are REMOVED from escrow-refund.ts (the keeper no longer calls them — see settlement-keeper.ts). Faked here instead:
// `checkChainMapping` (the P4 compare) and `recordChainSettlement` (the ONE guarded writer, P1), which the keeper now
// calls UNCONDITIONALLY once per escrow whenever the mapping is clean — not only when every milestone turns out
// Released. The fake mirrors just enough of the real logic (no DB, no drift unless a test asks for it) to keep
// `result.reconciledCompleted` meaningful: completed iff every status in the chain set equals `releasedStatus`.
vi.mock("../services/escrow-refund.js", () => ({
  beginSettlement: vi.fn(), // its default implementation (claim everything) is set in beforeEach below
  endSettlement: vi.fn(),
  releaseEscrowFromSettlement: vi.fn(),
  checkChainMapping: vi.fn(() => ({ ok: true, chainCount: 0, localCount: 0 })),
  recordChainSettlement: vi.fn((_claim: unknown, chain: { statuses: number[]; releasedStatus: number }) => ({
    ok: true,
    completed: chain.statuses.length > 0 && chain.statuses.every((s) => s === chain.releasedStatus),
  })),
}));

import {
  getEscrowStateV2,
  isWriteEnabled,
  MilestoneStatusV2,
  type OnChainMilestoneV2,
  type OnChainEscrowStateV2,
} from "../contracts/escrow-client.js";
import { driveSettlement } from "../services/settlement-crank.js";
import { beginSettlement, releaseEscrowFromSettlement, recordChainSettlement } from "../services/escrow-refund.js";
import { runKeeperSweep } from "../services/settlement-keeper.js";
import type { IRepositories } from "@pcc/store";

const mState = vi.mocked(getEscrowStateV2);
const mWriteEnabled = vi.mocked(isWriteEnabled);
const mDrive = vi.mocked(driveSettlement);
const mBegin = vi.mocked(beginSettlement);
const mRecord = vi.mocked(recordChainSettlement); // was recordEscrowReleased (round 6, P1: one guarded writer)
const mHandBack = vi.mocked(releaseEscrowFromSettlement);

const NOW = 5_000_000_000;
const PAST = NOW - 1_000; // window already closed
const FUTURE = NOW + 1_000_000; // window still open
const ADDR = (n: string) => ("0x" + n.repeat(20)) as `0x${string}`;

/** A fake escrow row as findAll() returns it (only the fields the keeper reads). */
interface FakeEscrow {
  id: string;
  contractAddress: string;
  status: string;
  version?: string | null;
}

/** Build a fake repos whose escrows.findAll returns `rows`; updateStatus is spied. */
function makeRepos(rows: FakeEscrow[]): {
  repos: IRepositories;
  updateStatus: ReturnType<typeof vi.fn>;
} {
  const updateStatus = vi.fn((id: string, status: string) => {
    const row = rows.find((r) => r.id === id);
    if (row) row.status = status;
    return row;
  });
  const repos = {
    escrows: {
      findAll: () => rows,
      findById: (id: string) => rows.find((r) => r.id === id),
      updateStatus,
    },
  } as unknown as IRepositories;
  return { repos, updateStatus };
}

/** On-chain milestone view for a given status. */
function milestone(status: number, over: Partial<OnChainMilestoneV2> = {}): OnChainMilestoneV2 {
  return {
    stepId: "0x" + "11".repeat(32),
    operator: ("0x" + "00".repeat(20)) as `0x${string}`,
    amount: "10",
    operatorBond: "0",
    status,
    statusName: "",
    evidenceBundleHash: "0x" + "00".repeat(32),
    verifierAttestationHash: "0x" + "00".repeat(32),
    challengeWindowEnd: PAST,
    challengeWindowSeconds: 0,
    requiredTier: 0,
    jobIdHash: "0x" + "00".repeat(32),
    verifierAttestationUid: "0x" + "00".repeat(32),
    ...over,
  } as OnChainMilestoneV2;
}

/** Wrap milestones into an escrow-state read. */
function escrowState(address: string, milestones: OnChainMilestoneV2[]): OnChainEscrowStateV2 {
  return {
    address: address as `0x${string}`,
    payer: ADDR("aa"),
    arbiter: ADDR("bb"),
    token: ADDR("cc"),
    cwmId: "0x" + "00".repeat(32),
    funded: true,
    totalAmount: "10",
    milestoneCount: milestones.length,
    milestones,
  } as OnChainEscrowStateV2;
}

/** A crank result the driveSettlement mock returns. */
function driveResult(over: Partial<Awaited<ReturnType<typeof driveSettlement>>>) {
  return {
    escrowAddress: ADDR("ab"),
    milestoneIdx: 0,
    finalStatus: "Released" as const,
    outcome: "released" as const,
    settled: true,
    steps: [],
    ...over,
  };
}

/** The default fake claim: every escrow can be claimed, leased as it is. */
const claimEverything = (ref: { escrowId?: string }) => ({
  disposition: "leased",
  claim: { escrowId: ref.escrowId ?? "esc-fake", token: Symbol("fake-lease"), leasedStatus: "funded" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mWriteEnabled.mockReturnValue(true);
  mBegin.mockImplementation(claimEverything as never); // a test that fakes another answer must not leak it into the next
});

describe("runKeeperSweep — release-past-window (the core self-heal)", () => {
  it("routes an Attested-past-window milestone to the crank and counts the release", async () => {
    const { repos, updateStatus } = makeRepos([
      { id: "esc-1", contractAddress: ADDR("ab"), status: "funded", version: "v2" },
    ]);
    mState.mockResolvedValue(escrowState(ADDR("ab"), [milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST })]));
    mDrive.mockResolvedValue(driveResult({ settled: true, outcome: "released", finalStatus: "Released" }));

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(mDrive).toHaveBeenCalledTimes(1);
    // The keeper is a pure release-leg closer: skipFund, no evidence hash, no uid.
    expect(mDrive.mock.calls[0][0]).toBe(ADDR("ab"));
    expect(mDrive.mock.calls[0][1]).toBe(0);
    expect(mDrive.mock.calls[0][2]).toMatchObject({ skipFund: true, nowSeconds: NOW });
    expect(mDrive.mock.calls[0][2]).not.toHaveProperty("evidenceBundleHash");
    expect(mDrive.mock.calls[0][2]).not.toHaveProperty("easUid");

    expect(r.released).toBe(1);
    expect(r.milestones[0].disposition).toBe("released");
    // Sole milestone released → escrow reconciled to completed (monotonic, chain-confirmed), recorded under the keeper's claim.
    expect(mRecord).toHaveBeenCalledTimes(1);
    expect(mRecord.mock.calls[0][0]).toMatchObject({ escrowId: "esc-1" });
    expect(r.reconciledCompleted).toBe(1);
  });

  it("does NOT drive an Attested milestone whose window is still open", async () => {
    const { repos, updateStatus } = makeRepos([
      { id: "esc-1", contractAddress: ADDR("ab"), status: "funded", version: "v2" },
    ]);
    mState.mockResolvedValue(
      escrowState(ADDR("ab"), [milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: FUTURE })]),
    );

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(mDrive).not.toHaveBeenCalled();
    expect(r.milestones[0].disposition).toBe("pending_window");
    expect(r.released).toBe(0);
    // N79 round 6 (P1): the keeper now calls recordChainSettlement UNCONDITIONALLY once per (mapping-clean)
    // escrow — it decides completion/hand-back internally, rather than the keeper gating the call on
    // `allReleased` first (old: recordEscrowReleased was never called for anything but a full release; the
    // hand-back went through the separate releaseEscrowFromSettlement instead). Not released → not completed.
    expect(mRecord).toHaveBeenCalledTimes(1);
    expect(r.reconciledCompleted).toBe(0);
    expect(mHandBack).not.toHaveBeenCalled(); // the hand-back is recordChainSettlement's own job now
  });

  it("leaves a below-Attested milestone untouched (fund/evidence/attest are not the keeper's job)", async () => {
    const { repos } = makeRepos([{ id: "esc-1", contractAddress: ADDR("ab"), status: "funded", version: "v2" }]);
    mState.mockResolvedValue(escrowState(ADDR("ab"), [milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST })]));

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(mDrive).not.toHaveBeenCalled();
    expect(r.milestones[0].disposition).toBe("not_ready");
  });
});

describe("runKeeperSweep — terminal-other is surfaced, never settled", () => {
  it("surfaces an on-chain Disputed milestone without driving it", async () => {
    const { repos, updateStatus } = makeRepos([
      { id: "esc-1", contractAddress: ADDR("ab"), status: "active", version: "v2" },
    ]);
    mState.mockResolvedValue(escrowState(ADDR("ab"), [milestone(MilestoneStatusV2.Disputed)]));

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(mDrive).not.toHaveBeenCalled();
    expect(r.terminalOther).toBe(1);
    expect(r.released).toBe(0);
    expect(r.milestones[0].disposition).toBe("terminal_other");
    expect(r.milestones[0].reason).toBe("disputed");
    // Money frozen → NOT reconciled to completed. N79 round 6 (P1): recordChainSettlement is still called (it
    // now runs unconditionally once per mapping-clean escrow) but reports no completion.
    expect(mRecord).toHaveBeenCalledTimes(1);
    expect(r.reconciledCompleted).toBe(0);
    expect(mHandBack).not.toHaveBeenCalled();
  });

  it("counts terminal_other (not released) when a dispute lands mid-drive (crank confirming read)", async () => {
    const { repos, updateStatus } = makeRepos([
      { id: "esc-1", contractAddress: ADDR("ab"), status: "active", version: "v2" },
    ]);
    // Pre-read says Attested-past-window, so the keeper hands it to the crank …
    mState.mockResolvedValue(escrowState(ADDR("ab"), [milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST })]));
    // … but the crank's own confirming read finds a dispute landed → terminal_other, settled:false.
    mDrive.mockResolvedValue(
      driveResult({ settled: false, outcome: "terminal_other", finalStatus: "Disputed", reason: "disputed" }),
    );

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(mDrive).toHaveBeenCalledTimes(1);
    expect(r.terminalOther).toBe(1);
    expect(r.released).toBe(0);
    expect(r.milestones[0].disposition).toBe("terminal_other");
    // N79 round 6 (P1): called, but reports no completion (the dispute means NOT every status is Released).
    expect(mRecord).toHaveBeenCalledTimes(1);
    expect(r.reconciledCompleted).toBe(0);
    expect(mHandBack).not.toHaveBeenCalled();
  });

  it("counts awaiting (not released) when the crank defers on a chain-clock lag", async () => {
    const { repos } = makeRepos([{ id: "esc-1", contractAddress: ADDR("ab"), status: "active", version: "v2" }]);
    mState.mockResolvedValue(escrowState(ADDR("ab"), [milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST })]));
    mDrive.mockResolvedValue(
      driveResult({ settled: false, outcome: "awaiting_challenge_window", finalStatus: "Attested" }),
    );

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(r.released).toBe(0);
    expect(r.milestones[0].disposition).toBe("awaiting");
  });
});

describe("runKeeperSweep — idempotency & multi-milestone reconciliation", () => {
  it("treats an already-Released milestone as done (no drive)", async () => {
    const { repos, updateStatus } = makeRepos([
      { id: "esc-1", contractAddress: ADDR("ab"), status: "completing", version: "v2" },
    ]);
    mState.mockResolvedValue(escrowState(ADDR("ab"), [milestone(MilestoneStatusV2.Released)]));

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(mDrive).not.toHaveBeenCalled();
    expect(r.milestones[0].disposition).toBe("already_released");
    // Sole milestone already Released → reconcile the lagging DB row to completed, under a claim.
    expect(mRecord).toHaveBeenCalledTimes(1);
    expect(mRecord.mock.calls[0][0]).toMatchObject({ escrowId: "esc-1" });
  });

  it("reconciles to completed only when EVERY milestone is Released", async () => {
    const { repos, updateStatus } = makeRepos([
      { id: "esc-1", contractAddress: ADDR("ab"), status: "active", version: "v2" },
    ]);
    // Two milestones: idx0 already Released, idx1 Attested-past-window → keeper releases it.
    mState.mockResolvedValue(
      escrowState(ADDR("ab"), [
        milestone(MilestoneStatusV2.Released),
        milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST }),
      ]),
    );
    mDrive.mockResolvedValue(driveResult({ settled: true, outcome: "released" }));

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(mDrive).toHaveBeenCalledTimes(1);
    expect(mDrive.mock.calls[0][1]).toBe(1); // only the un-released index was driven
    expect(r.released).toBe(1);
    expect(mRecord).toHaveBeenCalledTimes(1);
    expect(mRecord.mock.calls[0][0]).toMatchObject({ escrowId: "esc-1" });
  });

  it("does NOT reconcile when a sibling milestone is still not released", async () => {
    const { repos, updateStatus } = makeRepos([
      { id: "esc-1", contractAddress: ADDR("ab"), status: "active", version: "v2" },
    ]);
    // idx0 releases; idx1 is only Evidenced (not the keeper's job) → escrow NOT complete.
    mState.mockResolvedValue(
      escrowState(ADDR("ab"), [
        milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST }),
        milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST }),
      ]),
    );
    mDrive.mockResolvedValue(driveResult({ settled: true, outcome: "released" }));

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(r.released).toBe(1);
    // N79 round 6 (P1): called once (idx1 is still Evidenced, so not every status is Released — no completion).
    expect(mRecord).toHaveBeenCalledTimes(1);
    expect(mHandBack).not.toHaveBeenCalled();
    expect(r.reconciledCompleted).toBe(0);
  });
});

describe("runKeeperSweep — filtering & resilience", () => {
  it("short-circuits with no reads when writes are disabled", async () => {
    mWriteEnabled.mockReturnValue(false);
    const { repos } = makeRepos([{ id: "esc-1", contractAddress: ADDR("ab"), status: "funded", version: "v2" }]);

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(r.writeDisabled).toBe(true);
    expect(mState).not.toHaveBeenCalled();
    expect(mDrive).not.toHaveBeenCalled();
  });

  it("skips V3 escrows (no crank for the Mode-B path)", async () => {
    const { repos } = makeRepos([{ id: "esc-v3", contractAddress: ADDR("ab"), status: "funded", version: "v3" }]);

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(r.skippedV3).toBe(1);
    expect(mState).not.toHaveBeenCalled();
    expect(mDrive).not.toHaveBeenCalled();
  });

  it("treats a null/absent version as v2 (default)", async () => {
    const { repos } = makeRepos([{ id: "esc-legacy", contractAddress: ADDR("ab"), status: "funded", version: null }]);
    mState.mockResolvedValue(escrowState(ADDR("ab"), [milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST })]));
    mDrive.mockResolvedValue(driveResult({ settled: true, outcome: "released" }));

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(r.skippedV3).toBe(0);
    expect(mDrive).toHaveBeenCalledTimes(1);
  });

  it("skips escrows whose DB status is terminal (completed/refunded)", async () => {
    const { repos } = makeRepos([
      { id: "esc-done", contractAddress: ADDR("ab"), status: "completed", version: "v2" },
      { id: "esc-ref", contractAddress: ADDR("cd"), status: "refunded", version: "v2" },
    ]);

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(r.skippedTerminal).toBe(2);
    expect(mState).not.toHaveBeenCalled();
  });

  it("never releases an escrow whose refund is pending (N79: its job failed or was cancelled)", async () => {
    const { repos } = makeRepos([
      { id: "esc-refund-pending", contractAddress: ADDR("ef"), status: "refund_pending", version: "v2" },
    ]);

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(r.skippedTerminal).toBe(1);
    expect(mState).not.toHaveBeenCalled();
    expect(mDrive).not.toHaveBeenCalled();
  });

  it("N79: an escrow given back WHILE the sweep awaits another escrow is not driven (it re-reads, not the snapshot)", async () => {
    // A real repository's findAll() returns a snapshot; findById() reads the row as it is now.
    const table = new Map<string, FakeEscrow>([
      ["esc-a", { id: "esc-a", contractAddress: ADDR("ab"), status: "funded", version: "v2" }],
      ["esc-b", { id: "esc-b", contractAddress: ADDR("cd"), status: "funded", version: "v2" }],
    ]);
    const repos = {
      escrows: {
        findAll: () => [...table.values()].map((r) => ({ ...r })),
        findById: (id: string) => {
          const r = table.get(id);
          return r ? { ...r } : undefined;
        },
        updateStatus: vi.fn((id: string, status: string) => {
          const r = table.get(id);
          if (r) r.status = status;
          return r;
        }),
      },
    } as unknown as IRepositories;
    // The keeper's claim is the atomic re-read now (the ownership module, faked here; real in n79-r3-lease.test.ts). The
    // fake reads the CURRENT table row, as the real claim reads the store: given back or completed is `blocked`.
    mBegin.mockImplementation(((ref: { escrowId?: string }) => {
      const row = ref.escrowId ? table.get(ref.escrowId) : undefined;
      if (!row) return { disposition: "no_escrow" };
      return ["refund_pending", "refunded", "completed"].includes(row.status)
        ? { disposition: "blocked", escrowId: row.id, escrowStatus: row.status }
        : { disposition: "leased", claim: { escrowId: row.id, token: Symbol("fake-lease"), leasedStatus: row.status } };
    }) as never);

    let releaseA!: () => void;
    const aRead = new Promise<void>((r) => (releaseA = r));
    const attestedPastWindow = [milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST })];
    mState.mockImplementation(async (address) => {
      if (address === ADDR("ab")) await aRead;
      return escrowState(address as string, attestedPastWindow);
    });
    mDrive.mockResolvedValue(driveResult({ settled: true, outcome: "released", finalStatus: "Released" }));

    const sweep = runKeeperSweep(repos, { nowSeconds: NOW });
    await vi.waitFor(() => expect(mState).toHaveBeenCalledWith(ADDR("ab")));
    table.get("esc-b")!.status = "refund_pending"; // its job failed while the sweep was busy with A
    releaseA();
    const r = await sweep;

    expect(mDrive.mock.calls.map((c) => c[0])).toEqual([ADDR("ab")]);
    expect(r.skippedTerminal).toBe(1);
    expect(r.milestones.find((m) => m.escrowId === "esc-b")).toMatchObject({
      disposition: "terminal_other",
      reason: "escrow refund_pending since the sweep began",
    });
  });

  it("skips a mock / non-hex escrow address (never a live release target)", async () => {
    const { repos } = makeRepos([{ id: "esc-mock", contractAddress: "mock-escrow-123", status: "funded", version: "v2" }]);

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(r.scannedEscrows).toBe(0);
    expect(mState).not.toHaveBeenCalled();
  });

  it("soft-fails one unreadable escrow and continues to the next", async () => {
    const { repos } = makeRepos([
      { id: "esc-bad", contractAddress: ADDR("ab"), status: "funded", version: "v2" },
      { id: "esc-good", contractAddress: ADDR("cd"), status: "funded", version: "v2" },
    ]);
    mState
      .mockRejectedValueOnce(new Error("RPC connection reset"))
      .mockResolvedValueOnce(escrowState(ADDR("cd"), [milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST })]));
    mDrive.mockResolvedValue(driveResult({ settled: true, outcome: "released" }));

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(r.readErrors).toBe(1);
    expect(r.released).toBe(1); // the good escrow still got processed
    expect(mDrive).toHaveBeenCalledTimes(1);
  });

  it("soft-fails an unexpected crank throw (marks blocked, sweep continues)", async () => {
    const { repos, updateStatus } = makeRepos([
      { id: "esc-1", contractAddress: ADDR("ab"), status: "funded", version: "v2" },
    ]);
    mState.mockResolvedValue(escrowState(ADDR("ab"), [milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST })]));
    mDrive.mockRejectedValue(new Error("HTTP request failed: 503"));

    const r = await runKeeperSweep(repos, { nowSeconds: NOW });

    expect(r.blocked).toBe(1);
    expect(r.released).toBe(0);
    expect(r.milestones[0].disposition).toBe("blocked");
    // N79 round 6 (P1): called (mapping is still clean — only the drive itself failed), but reports no
    // completion (the chain-throw-blocked milestone's status never advanced to Released).
    expect(mRecord).toHaveBeenCalledTimes(1);
    expect(r.reconciledCompleted).toBe(0);
    expect(mHandBack).not.toHaveBeenCalled();
  });
});
