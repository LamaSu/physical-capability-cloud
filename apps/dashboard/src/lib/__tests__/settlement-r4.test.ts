/**
 * Cross-family review r3 of #425 (rm-px3-425-r3-5716e01f, SHIP-WITH-FIXES): two MEDIUM findings,
 * reproduced at 5716e01f and pinned. M1: the successful-flush banner called intents "operations
 * in batches," conflating the intent count with the operations the epoch's batches actually
 * carried (an empty-batch epoch is valid: batch-settler.ts settle() can flush zero batches). M2:
 * flushOutcome never checked that byAgent and byOperation — counted from the same intent snapshot
 * as totalIntents, batch-settler.ts settle() — each sum to it, so a contract-inconsistent 2xx
 * body was still promoted to success.
 */
import { describe, it, expect } from "vitest";
import { flushOutcome } from "../settlement-queue-view.js";

const SHAPE = "The gateway's answer did not have the expected shape.";

describe("M1 (review r3 of #425): the flush banner keeps intents and batch-carried operations apart", () => {
  it("the verdict's cheapest reproduction: totalIntents 10, batches 0, batchDetails [] never reads as '10 operations in 0 batch'", () => {
    const result = flushOutcome(200, {
      epoch: 3,
      totalIntents: 10,
      batches: 0,
      batchDetails: [],
      byAgent: { a: 10 },
      byOperation: { release: 10 },
      duration: 12,
    });
    expect(result.message).not.toContain("10 operations in 0 batch");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("10 intents");
    expect(result.message).toContain("0 operations carried in 0 batches");
  });

  it("a flush with batches still states the intent count and the batch-carried operation count separately", () => {
    const result = flushOutcome(200, {
      epoch: 7,
      totalIntents: 5,
      batches: 1,
      batchDetails: [{ userOpHash: "0x" + "ab".repeat(32), operationCount: 5, trigger: "manual" }],
      byAgent: { a: 5 },
      byOperation: { release: 5 },
      duration: 9,
    });
    expect(result).toEqual({
      ok: true,
      message: "The gateway reports epoch 7 flushed: 5 intents, 5 operations carried in 1 batch.",
    });
  });
});

describe("M2 (review r3 of #425): a contract-inconsistent 2xx body is never promoted to success", () => {
  it("the verdict's cheapest reproduction: byAgent {a:4} with totalIntents 5 gives ok === false", () => {
    const result = flushOutcome(200, {
      epoch: 3,
      totalIntents: 5,
      batches: 1,
      batchDetails: [{ userOpHash: "0x" + "ab".repeat(32), operationCount: 5, trigger: "manual" }],
      byAgent: { a: 4 },
      byOperation: { release: 5 },
      duration: 12,
    });
    expect(result).toEqual({ ok: false, message: SHAPE });
  });

  it("NEGATIVE: byOperation not summing to totalIntents fails closed too", () => {
    const result = flushOutcome(200, {
      epoch: 3,
      totalIntents: 5,
      batches: 1,
      batchDetails: [{ userOpHash: "0x" + "ab".repeat(32), operationCount: 5, trigger: "manual" }],
      byAgent: { a: 5 },
      byOperation: { release: 3, hold: 1 },
      duration: 12,
    });
    expect(result).toEqual({ ok: false, message: SHAPE });
  });

  it("a consistent body — byAgent and byOperation each summing exactly to totalIntents — is still ok", () => {
    const result = flushOutcome(200, {
      epoch: 9,
      totalIntents: 7,
      batches: 2,
      batchDetails: [
        { userOpHash: "0x" + "ab".repeat(32), operationCount: 4, trigger: "manual" },
        { userOpHash: "0x" + "cd".repeat(32), operationCount: 3, trigger: "size" },
      ],
      byAgent: { a: 3, b: 4 },
      byOperation: { release: 7 },
      duration: 20,
    });
    expect(result.ok).toBe(true);
  });
});
