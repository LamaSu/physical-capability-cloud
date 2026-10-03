/**
 * N79: the V3 deadline-reclaim primitive (services/escrow-reclaim.ts). All or nothing: it sends nothing unless every
 * milestone is Refunded already or reclaimable now. It is idempotent, sends one receipted transaction per remaining
 * milestone, and holds the signer lock throughout.
 *
 * The chain client is mocked here. escrow-reclaim.fork.test.ts runs the same code against the real MilestoneEscrowV3
 * on anvil.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Address } from "viem";

vi.mock("../contracts/escrow-client.js", () => ({
  getReclaimStateV3: vi.fn(),
  getSignerAddress: vi.fn(),
  isWriteEnabled: vi.fn(),
  signReclaimAfterDeadlineV3: vi.fn(),
  broadcastSignedTransaction: vi.fn(),
  waitForReceipt: vi.fn(),
}));
vi.mock("../contracts/signer-lock.js", () => ({
  withSignerLock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import * as chain from "../contracts/escrow-client.js";
import { withSignerLock } from "../contracts/signer-lock.js";
import { planReclaimV3, reclaimEscrowV3, V3_MILESTONE_STATUS as S } from "../services/escrow-reclaim.js";
import type { ReclaimStateV3 } from "../contracts/escrow-client.js";

const ESCROW = "0x00000000000000000000000000000000000e5c01" as Address;
const SIGNER = "0x000000000000000000000000000000000000a11c" as Address;
const FUNDED_AT = 1_000_000n;
const WINDOW = 30n * 24n * 3600n;
const DUE = FUNDED_AT + WINDOW;

function state(over: Partial<ReclaimStateV3> & { statuses?: number[] } = {}): ReclaimStateV3 {
  const { statuses = [S.Funded, S.Funded], ...rest } = over;
  return {
    address: ESCROW,
    blockNumber: 42n,
    blockTimestamp: DUE,
    payer: SIGNER,
    funded: true,
    fundedAt: FUNDED_AT,
    windowSeconds: WINDOW,
    milestones: statuses.map((status, index) => ({ index, status, amount: 10_000_000n })),
    ...rest,
  };
}

describe("planReclaimV3: all or nothing", () => {
  it("sends every reclaimable milestone once the deadline is reached (due exactly AT fundedAt + window)", () => {
    expect(planReclaimV3(state({ statuses: [S.Funded, S.Locked, S.Evidenced] }), SIGNER)).toEqual({
      action: "send",
      toReclaim: [0, 1, 2],
      alreadyRefunded: [],
      dueAt: DUE,
    });
  });

  it("refuses one second early, with the time it is due", () => {
    expect(planReclaimV3(state({ blockTimestamp: DUE - 1n }), SIGNER)).toEqual({
      action: "refuse",
      reason: "not_due",
      dueAt: DUE,
      blockTimestamp: DUE - 1n,
    });
  });

  it.each([
    ["Unfunded", S.Unfunded],
    ["Attested (the operator holds an oracle verdict: the dispute path's)", S.Attested],
    ["Released", S.Released],
    ["Disputed", S.Disputed],
    ["Slashed", S.Slashed],
  ])("ONE milestone %s blocks the whole escrow: nothing is sent", (_name, blocker) => {
    expect(planReclaimV3(state({ statuses: [S.Funded, blocker, S.Funded] }), SIGNER)).toEqual({
      action: "refuse",
      reason: "not_reclaimable",
      milestones: [{ index: 1, status: blocker }],
    });
  });

  it("sends only what is left when some milestones are Refunded already (idempotent)", () => {
    expect(planReclaimV3(state({ statuses: [S.Refunded, S.Funded] }), SIGNER)).toEqual({
      action: "send",
      toReclaim: [1],
      alreadyRefunded: [0],
      dueAt: DUE,
    });
  });

  it("is done, sending nothing, when every milestone is Refunded, even before the deadline", () => {
    expect(planReclaimV3(state({ statuses: [S.Refunded, S.Refunded], blockTimestamp: 0n }), SIGNER)).toEqual({
      action: "done",
      alreadyRefunded: [0, 1],
    });
  });

  it("refuses an unfunded escrow, and an escrow with no milestones", () => {
    expect(planReclaimV3(state({ funded: false }), SIGNER)).toEqual({ action: "refuse", reason: "not_funded" });
    expect(planReclaimV3(state({ statuses: [] }), SIGNER)).toEqual({ action: "refuse", reason: "no_milestones" });
  });

  it("refuses when the gateway signer is not the payer (a buyer-paid escrow: the payer's own wallet must reclaim)", () => {
    const buyer = "0x00000000000000000000000000000000000b0b01" as Address;
    expect(planReclaimV3(state({ payer: buyer }), SIGNER)).toEqual({ action: "refuse", reason: "not_payer", payer: buyer });
  });

  it("matches the payer in any letter case", () => {
    const mixed = "0x000000000000000000000000000000000000A11C" as Address;
    expect(planReclaimV3(state({ payer: mixed }), SIGNER).action).toBe("send");
  });
});

describe("reclaimEscrowV3: the executor", () => {
  beforeEach(() => {
    vi.mocked(chain.isWriteEnabled).mockReset().mockReturnValue(true);
    vi.mocked(chain.getSignerAddress).mockReset().mockReturnValue(SIGNER);
    vi.mocked(chain.getReclaimStateV3).mockReset();
    vi.mocked(chain.signReclaimAfterDeadlineV3)
      .mockReset()
      .mockImplementation(async (index: number) => ({
        transactionHash: `0xtx${index}` as `0x${string}`,
        serializedTransaction: `0x5169${index}` as `0x${string}`,
      }));
    vi.mocked(chain.broadcastSignedTransaction).mockReset().mockResolvedValue(undefined);
    vi.mocked(chain.waitForReceipt).mockReset().mockResolvedValue({ status: "success", blockNumber: 43 });
    vi.mocked(withSignerLock).mockClear();
  });

  it("without a gateway signer it refuses and reads nothing", async () => {
    vi.mocked(chain.isWriteEnabled).mockReturnValue(false);
    expect(await reclaimEscrowV3(ESCROW)).toEqual({ outcome: "refused", escrow: ESCROW, reason: "write_disabled" });
    expect(chain.getReclaimStateV3).not.toHaveBeenCalled();
    expect(chain.signReclaimAfterDeadlineV3).not.toHaveBeenCalled();
  });

  it("sends one reclaim per remaining milestone, waits for each receipt, all under the signer lock", async () => {
    vi.mocked(chain.getReclaimStateV3).mockResolvedValue(state({ statuses: [S.Refunded, S.Funded, S.Evidenced] }));
    expect(await reclaimEscrowV3(ESCROW)).toEqual({
      outcome: "reclaimed",
      escrow: ESCROW,
      reclaimed: [
        { index: 1, transactionHash: "0xtx1" },
        { index: 2, transactionHash: "0xtx2" },
      ],
      alreadyRefunded: [0],
    });
    expect(vi.mocked(chain.signReclaimAfterDeadlineV3).mock.calls).toEqual([
      [1, ESCROW],
      [2, ESCROW],
    ]);
    expect(vi.mocked(chain.broadcastSignedTransaction).mock.calls).toEqual([["0x51691"], ["0x51692"]]);
    expect(chain.waitForReceipt).toHaveBeenCalledTimes(2);
    expect(withSignerLock).toHaveBeenCalledTimes(1);
  });

  it("a refusal sends nothing", async () => {
    vi.mocked(chain.getReclaimStateV3).mockResolvedValue(state({ statuses: [S.Funded, S.Attested] }));
    expect(await reclaimEscrowV3(ESCROW)).toEqual({
      outcome: "refused",
      escrow: ESCROW,
      reason: "not_reclaimable",
      milestones: [{ index: 1, status: S.Attested }],
    });
    expect(chain.signReclaimAfterDeadlineV3).not.toHaveBeenCalled();
  });

  it("already refunded: sends nothing and says so", async () => {
    vi.mocked(chain.getReclaimStateV3).mockResolvedValue(state({ statuses: [S.Refunded] }));
    expect(await reclaimEscrowV3(ESCROW)).toEqual({ outcome: "already_refunded", escrow: ESCROW, alreadyRefunded: [0] });
    expect(chain.signReclaimAfterDeadlineV3).not.toHaveBeenCalled();
  });

  it("an RPC error reading a receipt (not a revert) after one success still returns what was sent (astra, #472 F1)", async () => {
    vi.mocked(chain.getReclaimStateV3).mockResolvedValue(state({ statuses: [S.Funded, S.Funded, S.Funded] }));
    vi.mocked(chain.waitForReceipt)
      .mockResolvedValueOnce({ status: "success", blockNumber: 43 })
      .mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(reclaimEscrowV3(ESCROW)).resolves.toEqual({
      outcome: "incomplete",
      escrow: ESCROW,
      reclaimed: [{ index: 0, transactionHash: "0xtx0" }],
      stoppedAt: { index: 1, transactionHash: "0xtx1", receipt: "unknown", error: "RPC unavailable" },
    });
  });

  it("a PREPARE/SIGN failure after one success is proven unsent: not_sent, with no hash (astra, #472 F1)", async () => {
    vi.mocked(chain.getReclaimStateV3).mockResolvedValue(state({ statuses: [S.Funded, S.Funded] }));
    vi.mocked(chain.signReclaimAfterDeadlineV3)
      .mockResolvedValueOnce({ transactionHash: "0xtx0", serializedTransaction: "0x51690" })
      .mockRejectedValueOnce(new Error("gas estimation failed"));
    await expect(reclaimEscrowV3(ESCROW)).resolves.toEqual({
      outcome: "incomplete",
      escrow: ESCROW,
      reclaimed: [{ index: 0, transactionHash: "0xtx0" }],
      stoppedAt: { index: 1, receipt: "not_sent", error: "gas estimation failed" },
    });
    expect(chain.broadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });

  it("an error value that cannot even be printed still never loses the record (astra, #477 F1b)", async () => {
    vi.mocked(chain.getReclaimStateV3).mockResolvedValue(state({ statuses: [S.Funded, S.Funded] }));
    vi.mocked(chain.waitForReceipt)
      .mockResolvedValueOnce({ status: "success", blockNumber: 43 })
      .mockRejectedValueOnce(Object.create(null));
    await expect(reclaimEscrowV3(ESCROW)).resolves.toEqual({
      outcome: "incomplete",
      escrow: ESCROW,
      reclaimed: [{ index: 0, transactionHash: "0xtx0" }],
      stoppedAt: { index: 1, transactionHash: "0xtx1", receipt: "unknown", error: "unprintable error" },
    });
  });

  it("a broadcast whose response was lost is NOT reported as unsent: it may have reached the node (astra, #477 F1a)", async () => {
    vi.mocked(chain.getReclaimStateV3).mockResolvedValue(state({ statuses: [S.Funded, S.Funded] }));
    vi.mocked(chain.broadcastSignedTransaction)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { name: "HttpRequestError" }));
    await expect(reclaimEscrowV3(ESCROW)).resolves.toEqual({
      outcome: "incomplete",
      escrow: ESCROW,
      reclaimed: [{ index: 0, transactionHash: "0xtx0" }],
      // indeterminate, WITH the hash signed before the broadcast, so the caller can look it up
      stoppedAt: { index: 1, transactionHash: "0xtx1", receipt: "unknown", error: "socket hang up" },
    });
  });

  it("a reverted reclaim stops the sequence and reports exactly what was sent", async () => {
    vi.mocked(chain.getReclaimStateV3).mockResolvedValue(state({ statuses: [S.Funded, S.Funded, S.Funded] }));
    vi.mocked(chain.waitForReceipt)
      .mockResolvedValueOnce({ status: "success", blockNumber: 43 })
      .mockResolvedValueOnce({ status: "reverted", blockNumber: 44 });
    expect(await reclaimEscrowV3(ESCROW)).toEqual({
      outcome: "incomplete",
      escrow: ESCROW,
      reclaimed: [{ index: 0, transactionHash: "0xtx0" }],
      stoppedAt: { index: 1, transactionHash: "0xtx1", receipt: "reverted" },
    });
    expect(chain.signReclaimAfterDeadlineV3).toHaveBeenCalledTimes(2);
  });
});
