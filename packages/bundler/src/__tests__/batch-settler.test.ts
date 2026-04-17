import { describe, it, expect, vi, beforeEach } from "vitest";
import { BatchSettler } from "../batch-settler.js";
import { UserOpQueue } from "../user-op-queue.js";
import type { Address, Hex } from "viem";
import type { SettlementIntent } from "../batch-settler.js";
import type { OracleAttestation } from "@pcc/contracts";

/** Deterministic test attestation bound to a given escrow. */
function mkAttestation(escrowAddress: Address, evidenceHash: Hex = "0xdead" as Hex): OracleAttestation {
  return {
    escrowAddress,
    jobId: "job-test",
    evidenceHash: ("0x" + evidenceHash.replace(/^0x/, "").padStart(64, "0")) as Hex,
    tier: 1,
    verified: true,
    timestamp: 1700000000n,
    nonce: ("0x" + "a".repeat(64)) as Hex,
    signature: "0x" as Hex,
  };
}

// Mock UserOpQueue
const mockFlush = vi.fn();
const mockEnqueueCall = vi.fn().mockReturnValue("op-1");
const mockGetStatus = vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestAge: 0, autoFlush: false });

vi.mock("../user-op-queue.js", () => ({
  UserOpQueue: vi.fn().mockImplementation(() => ({
    enqueueCall: mockEnqueueCall,
    flush: mockFlush,
    getStatus: mockGetStatus,
    stop: vi.fn(),
  })),
}));

const MOCK_ABI = [
  { name: "release", type: "function", stateMutability: "nonpayable", inputs: [{ name: "idx", type: "uint256" }], outputs: [] },
  { name: "submitEvidence", type: "function", stateMutability: "nonpayable", inputs: [{ name: "idx", type: "uint256" }, { name: "hash", type: "bytes32" }], outputs: [] },
  { name: "fund", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

describe("BatchSettler", () => {
  let settler: BatchSettler;
  let mockQueue: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFlush.mockResolvedValue(null); // Default: empty queue after first flush
    mockQueue = new UserOpQueue({} as any);
    settler = new BatchSettler(mockQueue, MOCK_ABI);
  });

  it("submits settlement intents to the queue", () => {
    const escrow = "0x1111111111111111111111111111111111111111" as Address;
    const attestation = mkAttestation(escrow);
    const intent: SettlementIntent = {
      intentId: "intent-1",
      agentId: "agent-user-1",
      escrowAddress: escrow,
      operation: { type: "release", milestoneIndex: 0, attestation },
      usdcValue: 100_000_000n,
    };

    settler.submit(intent);

    expect(mockEnqueueCall).toHaveBeenCalledWith(
      "0x1111111111111111111111111111111111111111",
      MOCK_ABI,
      "release",
      [
        0n,
        [
          attestation.escrowAddress,
          attestation.jobId,
          attestation.evidenceHash,
          attestation.tier,
          attestation.verified,
          attestation.timestamp,
          attestation.nonce,
          attestation.signature,
        ],
      ],
      { usdcValue: 100_000_000n },
    );
    expect(settler.pendingCount).toBe(1);
  });

  it("settles all intents in an epoch", async () => {
    mockFlush.mockResolvedValueOnce({
      userOpHash: "0xhash1" as Hex,
      operationCount: 3,
      operationIds: ["op-1", "op-2", "op-3"],
      flushedAt: Date.now(),
      trigger: "manual",
    });

    const escrowA = "0x1111111111111111111111111111111111111111" as Address;
    const escrowB = "0x2222222222222222222222222222222222222222" as Address;

    settler.submit({
      intentId: "i1",
      agentId: "agent-user",
      escrowAddress: escrowA,
      operation: { type: "release", milestoneIndex: 0, attestation: mkAttestation(escrowA) },
    });
    settler.submit({
      intentId: "i2",
      agentId: "agent-user",
      escrowAddress: escrowA,
      operation: { type: "release", milestoneIndex: 1, attestation: mkAttestation(escrowA) },
    });
    settler.submit({
      intentId: "i3",
      agentId: "agent-kernel",
      escrowAddress: escrowB,
      operation: { type: "submitEvidence", milestoneIndex: 0, evidenceHash: "0xabc" as Hex },
    });

    const epoch = await settler.settle();

    expect(epoch.epochId).toBe(1);
    expect(epoch.totalIntents).toBe(3);
    expect(epoch.byAgent["agent-user"]).toBe(2);
    expect(epoch.byAgent["agent-kernel"]).toBe(1);
    expect(epoch.byOperation["release"]).toBe(2);
    expect(epoch.byOperation["submitEvidence"]).toBe(1);
    expect(epoch.batches).toHaveLength(1);
    expect(settler.pendingCount).toBe(0);
  });

  it("handles fund operations", () => {
    settler.submit({
      intentId: "i1",
      agentId: "agent-user",
      escrowAddress: "0x1111111111111111111111111111111111111111" as Address,
      operation: { type: "fund" },
    });

    expect(mockEnqueueCall).toHaveBeenCalledWith(
      "0x1111111111111111111111111111111111111111",
      MOCK_ABI,
      "fund",
      [],
      { usdcValue: undefined },
    );
  });

  it("handles submitEvidence operations", () => {
    settler.submit({
      intentId: "i1",
      agentId: "agent-kernel",
      escrowAddress: "0x1111111111111111111111111111111111111111" as Address,
      operation: {
        type: "submitEvidence",
        milestoneIndex: 2,
        evidenceHash: "0xdeadbeef" as Hex,
      },
    });

    expect(mockEnqueueCall).toHaveBeenCalledWith(
      "0x1111111111111111111111111111111111111111",
      MOCK_ABI,
      "submitEvidence",
      [2n, "0xdeadbeef"],
      { usdcValue: undefined },
    );
  });

  it("tracks epoch history", async () => {
    mockFlush.mockResolvedValue(null);

    await settler.settle();
    await settler.settle();
    await settler.settle();

    const history = settler.getEpochHistory();
    expect(history).toHaveLength(3);
    expect(history[0].epochId).toBe(1);
    expect(history[2].epochId).toBe(3);
  });

  it("reports queue status", () => {
    const status = settler.getQueueStatus();
    expect(status).toEqual({ pending: 0, totalValue: 0n, oldestAge: 0, autoFlush: false });
  });
});
