/**
 * BatchBoardPage pure helpers (status board row N49).
 * The page must never send an identity, and must render the server's claim
 * array as a count. Before this fix, rendering the array as a React child
 * crashed the page once a batch had a claim.
 */

import { describe, it, expect } from "vitest";
import {
  claimRequestBody,
  formatSlotPrice,
  toSharedBatchView,
  toSharedBatchViews,
  type ServerSharedBatch,
} from "../batch-board-logic.js";

function serverBatch(overrides: Partial<ServerSharedBatch> = {}): ServerSharedBatch {
  return {
    id: "sbatch-1",
    kernelId: "kernel-lab",
    capabilityType: "liquid-handling",
    protocolType: "dilution",
    totalSlots: 8,
    claimedSlots: [],
    pricePerSlot: "1.50",
    status: "open",
    ...overrides,
  };
}

describe("claimRequestBody", () => {
  it("carries only the slot count, never a claimant identity", () => {
    const body = claimRequestBody(3);
    expect(body).toEqual({ slotCount: 3 });
    expect(body).not.toHaveProperty("agentId");
    expect(JSON.stringify(body)).not.toContain("demo-user");
  });
});

describe("toSharedBatchView", () => {
  it("counts claimed slots from the server's claim array", () => {
    const view = toSharedBatchView(
      serverBatch({
        claimedSlots: [
          { agentId: null, own: false, slotIndices: [0, 1] },
          { agentId: "me@example.com", own: true, slotIndices: [2] },
        ],
      }),
    );
    expect(view.claimedSlots).toBe(3);
    expect(typeof view.claimedSlots).toBe("number");
    expect(view.claims).toEqual([
      { agentId: null, own: false, slotCount: 2 },
      { agentId: "me@example.com", own: true, slotCount: 1 },
    ]);
  });

  it("never turns a redacted or malformed claimant into an identity", () => {
    const view = toSharedBatchView(serverBatch({ claimedSlots: [{ agentId: 42, own: "yes", slotIndices: "0,1" }] }));
    expect(view.claims).toEqual([{ agentId: null, own: false, slotCount: 0 }]);
  });

  it("parses a string or number price, and leaves an unknown price as NaN, never 0", () => {
    expect(toSharedBatchView(serverBatch({ pricePerSlot: "1.50" })).pricePerSlot).toBe(1.5);
    expect(toSharedBatchView(serverBatch({ pricePerSlot: 2 })).pricePerSlot).toBe(2);
    for (const bad of [undefined, "", "abc", null, {}]) {
      expect(Number.isNaN(toSharedBatchView(serverBatch({ pricePerSlot: bad })).pricePerSlot)).toBe(true);
    }
  });
});

describe("toSharedBatchViews", () => {
  it("accepts { batches } or a bare array, and anything else is empty", () => {
    expect(toSharedBatchViews({ batches: [serverBatch()] })).toHaveLength(1);
    expect(toSharedBatchViews([serverBatch(), serverBatch({ id: "b2" })])).toHaveLength(2);
    expect(toSharedBatchViews({ error: "x" })).toEqual([]);
    expect(toSharedBatchViews(null)).toEqual([]);
  });
});

describe("formatSlotPrice", () => {
  it("formats a known price and shows a dash for an unknown one", () => {
    expect(formatSlotPrice(1.5)).toBe("$1.50");
    expect(formatSlotPrice(0)).toBe("$0.00");
    expect(formatSlotPrice(Number.NaN)).toBe("—");
  });
});
