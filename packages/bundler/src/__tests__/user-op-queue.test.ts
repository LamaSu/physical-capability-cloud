import { describe, it, expect, vi, beforeEach } from "vitest";
import { UserOpQueue } from "../user-op-queue.js";
import { SmartAccountClient } from "../smart-account.js";
import type { Address, Hex } from "viem";

// Mock SmartAccountClient
vi.mock("../smart-account.js", () => {
  return {
    SmartAccountClient: vi.fn().mockImplementation(() => ({
      smartAccountAddress: "0x1234567890abcdef1234567890abcdef12345678" as Address,
      signerAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address,
      encodeOperation: vi.fn().mockReturnValue({
        target: "0x1111111111111111111111111111111111111111" as Address,
        value: 0n,
        data: "0xdeadbeef" as Hex,
      }),
      encodeExecute: vi.fn().mockReturnValue("0xexecute" as Hex),
      encodeBatch: vi.fn().mockReturnValue("0xbatch" as Hex),
      sendUserOp: vi.fn().mockResolvedValue("0xuserophash" as Hex),
    })),
  };
});

describe("UserOpQueue", () => {
  let queue: UserOpQueue;
  let mockAccount: any;

  beforeEach(() => {
    mockAccount = new SmartAccountClient({} as any);
    queue = new UserOpQueue(mockAccount, { autoFlush: false });
  });

  it("enqueues operations and returns an ID", () => {
    const id = queue.enqueueCall(
      "0x1111111111111111111111111111111111111111" as Address,
      [{ name: "release", type: "function", inputs: [{ name: "idx", type: "uint256" }], outputs: [], stateMutability: "nonpayable" }],
      "release",
      [0n],
    );

    expect(id).toMatch(/^op-/);
    expect(queue.getStatus().pending).toBe(1);
  });

  it("tracks queue status correctly", () => {
    queue.enqueueCall(
      "0x1111111111111111111111111111111111111111" as Address,
      [],
      "fund",
      [],
      { usdcValue: 500_000_000n }, // $500
    );
    queue.enqueueCall(
      "0x1111111111111111111111111111111111111111" as Address,
      [],
      "fund",
      [],
      { usdcValue: 300_000_000n }, // $300
    );

    const status = queue.getStatus();
    expect(status.pending).toBe(2);
    expect(status.totalValue).toBe(800_000_000n);
    expect(status.oldestAge).toBeGreaterThanOrEqual(0);
  });

  it("flushes single operation with encodeExecute", async () => {
    queue.enqueueCall(
      "0x1111111111111111111111111111111111111111" as Address,
      [],
      "release",
      [0n],
    );

    const result = await queue.flush();

    expect(result).not.toBeNull();
    expect(result!.operationCount).toBe(1);
    expect(result!.userOpHash).toBe("0xuserophash");
    expect(result!.trigger).toBe("manual");
    expect(mockAccount.encodeExecute).toHaveBeenCalled();
    expect(mockAccount.sendUserOp).toHaveBeenCalledWith("0xexecute");
  });

  it("flushes multiple operations with encodeBatch", async () => {
    queue.enqueueCall("0x1111111111111111111111111111111111111111" as Address, [], "release", [0n]);
    queue.enqueueCall("0x1111111111111111111111111111111111111111" as Address, [], "release", [1n]);
    queue.enqueueCall("0x1111111111111111111111111111111111111111" as Address, [], "release", [2n]);

    const result = await queue.flush();

    expect(result).not.toBeNull();
    expect(result!.operationCount).toBe(3);
    expect(mockAccount.encodeBatch).toHaveBeenCalled();
    expect(mockAccount.sendUserOp).toHaveBeenCalledWith("0xbatch");
  });

  it("returns null when flushing empty queue", async () => {
    const result = await queue.flush();
    expect(result).toBeNull();
  });

  it("cancels operations by ID", () => {
    const id = queue.enqueueCall(
      "0x1111111111111111111111111111111111111111" as Address,
      [],
      "release",
      [0n],
    );

    expect(queue.cancel(id)).toBe(true);
    expect(queue.getStatus().pending).toBe(0);
    expect(queue.cancel("nonexistent")).toBe(false);
  });

  it("records flush history", async () => {
    queue.enqueueCall("0x1111111111111111111111111111111111111111" as Address, [], "release", [0n]);
    await queue.flush();

    queue.enqueueCall("0x1111111111111111111111111111111111111111" as Address, [], "fund", []);
    await queue.flush();

    const history = queue.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].operationCount).toBe(1);
    expect(history[1].operationCount).toBe(1);
  });

  it("respects maxBatchSize", async () => {
    const smallQueue = new UserOpQueue(mockAccount, {
      maxBatchSize: 2,
      autoFlush: false,
    });

    smallQueue.enqueueCall("0x1111111111111111111111111111111111111111" as Address, [], "release", [0n]);
    smallQueue.enqueueCall("0x1111111111111111111111111111111111111111" as Address, [], "release", [1n]);

    // Flush first batch (should take exactly 2)
    const result = await smallQueue.flush();
    expect(result!.operationCount).toBe(2);
    expect(smallQueue.getStatus().pending).toBe(0);

    // Enqueue one more — should be alone in next batch
    smallQueue.enqueueCall("0x1111111111111111111111111111111111111111" as Address, [], "release", [2n]);
    const result2 = await smallQueue.flush();
    expect(result2!.operationCount).toBe(1);
  });

  it("cleans up on stop", () => {
    const autoQueue = new UserOpQueue(mockAccount, { autoFlush: true });
    autoQueue.stop(); // Should not throw
  });
});
