/**
 * Cross-family review r2 of #425 (rm-px3-425-r2-5d2615cd, DO-NOT-SHIP): H1 and M4, reproduced at
 * 5d2615cd and pinned. H1: a partial 2xx flush answer was promoted to a success. M4: a real gateway
 * answer under a clock that moved back (a negative age, an epoch ending "before" it started) made
 * the whole read unavailable; it is now read, and the anomaly is said, not hidden.
 */
import { describe, it, expect } from "vitest";
import { createFlushController, epochsFromResponse, flushOutcome, statusFromResponse, type EpochRecord } from "../settlement-queue-view.js";

const STATUS = { batchEnabled: true, pending: 2, totalValue: "1500000", oldestAge: 1200, autoFlush: false, smartAccountAddress: null };
const EPOCH: EpochRecord = {
  epochId: 1,
  batches: [{ userOpHash: "0x" + "ab".repeat(32), operationCount: 2, trigger: "manual" }],
  totalIntents: 2,
  byAgent: { a: 2 },
  byOperation: { release: 2 },
  startedAt: 1000,
  completedAt: 1500,
};
/** POST /api/settlement/flush's whole answer (gateway routes/settlement.ts). */
const FLUSH = {
  epoch: 3,
  totalIntents: 5,
  batches: 1,
  batchDetails: [{ userOpHash: "0x" + "cd".repeat(32), operationCount: 5, trigger: "manual" }],
  byAgent: { "agent-1": 5 },
  byOperation: { release: 5 },
  duration: 12,
};
const SHAPE = "The gateway's answer did not have the expected shape.";

describe("H1 (review r2 of #425): a 2xx flush answer outside the route's contract is never a success", () => {
  it("the cheapest reproduction: { epoch, totalIntents, batches } alone fails closed", () => {
    expect(flushOutcome(200, { epoch: 3, totalIntents: 5, batches: 1 })).toEqual({ ok: false, message: SHAPE });
  });

  it("each member the route always sends is required: batchDetails, byAgent, byOperation and duration", () => {
    for (const key of ["batchDetails", "byAgent", "byOperation", "duration"]) {
      const partial: Record<string, unknown> = { ...FLUSH };
      delete partial[key];
      expect(flushOutcome(200, partial), key).toEqual({ ok: false, message: SHAPE });
    }
    expect(flushOutcome(200, { ...FLUSH, byAgent: { "agent-1": -1 } }).ok).toBe(false);
    expect(flushOutcome(200, { ...FLUSH, duration: 1.5 }).ok).toBe(false);
  });

  it("the route's whole answer is a success, and says what the gateway reports, not that anything settled", () => {
    expect(flushOutcome(200, FLUSH)).toEqual({ ok: true, message: "The gateway reports epoch 3 flushed: 5 operations in 1 batch(es)." });
  });
});

describe("M4 (review r2 of #425): a gateway clock that moved back is said, never a failed read", () => {
  it("a negative oldestAge (the clock moved back after an intent was queued) reads, with the age unknown", () => {
    const r = statusFromResponse(200, { ...STATUS, oldestAge: -5 });
    expect(r.state).toBe("read");
    if (r.state !== "read") return;
    expect(r.value.oldestAge).toBeNull();
    expect(r.value.clockAdjusted).toBe(true);
  });

  it("an epoch that completed 'before' it started reads, flagged clockAdjusted, with no duration", () => {
    const r = epochsFromResponse(200, { epochs: [{ ...EPOCH, startedAt: 1500, completedAt: 1000 }] });
    expect(r.state).toBe("read");
    if (r.state !== "read") return;
    expect(r.value[0]!.clockAdjusted).toBe(true);
    expect(r.value[0]!.durationMs).toBeNull();
  });

  it("an ordinary status and epoch keep their age and duration, unflagged", () => {
    const s = statusFromResponse(200, STATUS);
    expect(s.state === "read" && [s.value.oldestAge, s.value.clockAdjusted]).toEqual([1200, false]);
    const e = epochsFromResponse(200, { epochs: [EPOCH] });
    expect(e.state === "read" && [e.value[0]!.durationMs, e.value[0]!.clockAdjusted]).toEqual([500, false]);
  });

  it("NEGATIVE: values that are not times at all are still refused", () => {
    for (const oldestAge of [1.5, 2 ** 53, -(2 ** 53), Number.NaN, "5"]) {
      expect(statusFromResponse(200, { ...STATUS, oldestAge }).state, String(oldestAge)).toBe("unavailable");
    }
    for (const times of [{ startedAt: -1 }, { startedAt: 1000.5 }, { completedAt: 8.64e15 + 1 }, { startedAt: "1000" }]) {
      expect(epochsFromResponse(200, { epochs: [{ ...EPOCH, ...times }] }).state, JSON.stringify(times)).toBe("unavailable");
    }
  });
});

describe("M5 (review r2 of #425): a reload that fails after a flush is handled, never an unhandled rejection", () => {
  it("confirmFlush resolves, the guard clears, and the failed reload is reported", async () => {
    let flushing = true;
    const reloadErrors: unknown[] = [];
    const controller = createFlushController<string>({
      post: async () => "flushed",
      reload: async () => {
        throw new Error("gateway unreachable");
      },
      onResult: () => {},
      onError: () => {},
      onFlushingChange: (f: boolean) => (flushing = f),
      onReloadError: (error: unknown) => reloadErrors.push(error),
    } as never);
    await expect(controller.confirmFlush()).resolves.toBe(true);
    expect(flushing).toBe(false);
    expect(controller.isFlushing()).toBe(false);
    expect(reloadErrors).toHaveLength(1);
  });
});
