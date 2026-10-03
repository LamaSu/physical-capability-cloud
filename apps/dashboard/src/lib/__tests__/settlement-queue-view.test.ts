/**
 * The Settlement page's queue view (PX-3): the gateway's answers or a stated reason, never
 * the invented numbers the page used to start from and keep on failure.
 */
import { describe, it, expect } from "vitest";
import {
  averageOpsPerBatch,
  LOADING,
  UNREACHABLE,
  createFlushController,
  epochDetailNote,
  epochsFromResponse,
  flushConfirmation,
  flushOutcome,
  formatUsdcBaseUnits,
  statusFromResponse,
  triggerBadge,
  type EpochRecord,
} from "../settlement-queue-view.js";

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

describe("statusFromResponse", () => {
  it("reads the gateway's queue status", () => {
    expect(statusFromResponse(200, STATUS)).toEqual({ state: "read", value: { ...STATUS, clockAdjusted: false } });
  });

  it("reads a gateway with batch settlement off as a real answer", () => {
    const off = { ...STATUS, batchEnabled: false, pending: 0, totalValue: "0" };
    expect(statusFromResponse(200, off)).toEqual({ state: "read", value: { ...off, clockAdjusted: false } });
  });

  it("NEGATIVE: a refusal is unavailable with the gateway's message, or the HTTP status", () => {
    expect(statusFromResponse(503, { error: "x", message: "Batch settlement is not configured." })).toEqual({
      state: "unavailable",
      reason: "Batch settlement is not configured.",
    });
    expect(statusFromResponse(500, null)).toEqual({ state: "unavailable", reason: "The gateway answered HTTP 500." });
  });

  it("NEGATIVE: a body of the wrong shape is unavailable, never partly shown", () => {
    for (const bad of [{}, { ...STATUS, pending: -1 }, { ...STATUS, totalValue: "1.5" }, { ...STATUS, totalValue: 1500000 }, { ...STATUS, batchEnabled: "yes" }, []]) {
      expect(statusFromResponse(200, bad).state, JSON.stringify(bad)).toBe("unavailable");
    }
  });

  it("NEGATIVE (M4): smartAccountAddress must be null or a real 0x + 40-hex address, not any string", () => {
    expect(statusFromResponse(200, { ...STATUS, smartAccountAddress: "not-an-address" }).state).toBe("unavailable");
    expect(statusFromResponse(200, { ...STATUS, smartAccountAddress: "0xshort" }).state).toBe("unavailable");
  });

  it("a real 0x + 40-hex smartAccountAddress still reads", () => {
    const addr = "0x" + "1".repeat(40);
    expect(statusFromResponse(200, { ...STATUS, smartAccountAddress: addr })).toEqual({
      state: "read",
      value: { ...STATUS, smartAccountAddress: addr, clockAdjusted: false },
    });
  });
});

describe("epochsFromResponse", () => {
  it("reads epochs, and an EMPTY history as empty (not as a failure, not as examples)", () => {
    expect(epochsFromResponse(200, { epochs: [EPOCH] })).toEqual({ state: "read", value: [{ ...EPOCH, durationMs: 500, clockAdjusted: false }] });
    expect(epochsFromResponse(200, { epochs: [] })).toEqual({ state: "read", value: [] });
  });

  it("NEGATIVE: a refusal or a malformed epoch is unavailable", () => {
    expect(epochsFromResponse(401, { message: "Unauthorized" })).toEqual({ state: "unavailable", reason: "Unauthorized" });
    expect(epochsFromResponse(200, { epochs: [{ ...EPOCH, totalIntents: "2" }] }).state).toBe("unavailable");
    expect(epochsFromResponse(200, {}).state).toBe("unavailable");
  });

  it("NEGATIVE (M4): byAgent/byOperation values, hashes and the trigger enum are validated, not just presence", () => {
    // Reviewer's cheapest reproduction: currently returns `read` at 58a888b4.
    const bad = {
      epochs: [
        {
          ...EPOCH,
          byAgent: { a: { bad: true } },
          batches: [{ userOpHash: "", operationCount: 2, trigger: "settled" }],
        },
      ],
    };
    expect(epochsFromResponse(200, bad).state).toBe("unavailable");
  });

  it("NEGATIVE (M4): byOperation values must themselves be safe non-negative integers", () => {
    const bad = { epochs: [{ ...EPOCH, byOperation: { release: -1 } }] };
    expect(epochsFromResponse(200, bad).state).toBe("unavailable");
  });

  it("NEGATIVE (M4): a batch's userOpHash must be a real 0x + 64-hex UserOp hash", () => {
    const bad = { epochs: [{ ...EPOCH, batches: [{ userOpHash: "0xnotahash", operationCount: 2, trigger: "manual" }] }] };
    expect(epochsFromResponse(200, bad).state).toBe("unavailable");
  });

  it("NEGATIVE (M4): a batch's trigger must be one of manual|size|age|value", () => {
    const bad = {
      epochs: [{ ...EPOCH, batches: [{ userOpHash: "0x" + "ab".repeat(32), operationCount: 2, trigger: "settled" }] }],
    };
    expect(epochsFromResponse(200, bad).state).toBe("unavailable");
  });

  it("counts outside Number.isSafeInteger were already rejected by the isCount shared with flushOutcome (H1)", () => {
    // Not a fresh M4 reproduction: isCount became Number.isSafeInteger project-wide in H1.
    // Kept here as a regression guard for the epoch path specifically.
    expect(epochsFromResponse(200, { epochs: [{ ...EPOCH, epochId: 2 ** 53 }] }).state).toBe("unavailable");
  });

  it("NEGATIVE (M4): an epoch's times are the bundler's Date.now() stamps: non-negative safe-integer ms, ending no earlier than they start", () => {
    for (const times of [
      { startedAt: 1000.5 },
      { startedAt: -1 },
      { completedAt: 2 ** 53 },
      { completedAt: Number.POSITIVE_INFINITY },
      { startedAt: "1000" },
    ]) {
      expect(epochsFromResponse(200, { epochs: [{ ...EPOCH, ...times }] }).state, JSON.stringify(times)).toBe("unavailable");
    }
    expect(epochsFromResponse(200, { epochs: [{ ...EPOCH, startedAt: 1500, completedAt: 1500 }] }).state).toBe("read");
    // An end before the start is a clock that moved back: still read, flagged (review r2 of #425, M4).
    const back = epochsFromResponse(200, { epochs: [{ ...EPOCH, startedAt: 1500, completedAt: 1000 }] });
    expect(back.state === "read" && [back.value[0]!.clockAdjusted, back.value[0]!.durationMs]).toEqual([true, null]);
  });

  it("NEGATIVE (M4): a time beyond what a Date can hold (8.64e15 ms) is refused too", () => {
    expect(epochsFromResponse(200, { epochs: [{ ...EPOCH, completedAt: 8.64e15 + 1 }] }).state).toBe("unavailable");
    expect(epochsFromResponse(200, { epochs: [{ ...EPOCH, startedAt: 8.64e15, completedAt: 8.64e15 }] }).state).toBe("read");
  });

  it("NEGATIVE (M4): the queue's oldestAge is an age in ms: a safe integer (negative only when the clock moved back)", () => {
    for (const oldestAge of [1.5, 2 ** 53, Number.NaN]) {
      expect(statusFromResponse(200, { ...STATUS, oldestAge }).state, String(oldestAge)).toBe("unavailable");
    }
    expect(statusFromResponse(200, { ...STATUS, oldestAge: 0 }).state).toBe("read");
    // A negative age reads with the age unknown and the clock flagged (review r2 of #425, M4).
    const back = statusFromResponse(200, { ...STATUS, oldestAge: -5 });
    expect(back.state === "read" && [back.value.oldestAge, back.value.clockAdjusted]).toEqual([null, true]);
  });

  it("an unreachable gateway has its own reason", () => {
    expect(UNREACHABLE).toEqual({ state: "unavailable", reason: "The gateway could not be reached." });
  });
});

describe("epochDetailNote: the detail panel's placeholder when nothing is selected (M2)", () => {
  it("NEGATIVE: a loading or unavailable epoch read is never presented as an empty state", () => {
    expect(epochDetailNote(LOADING)).toBe("Loading…");
    expect(epochDetailNote({ state: "unavailable", reason: "The gateway answered HTTP 500." })).toBe(
      "The gateway answered HTTP 500.",
    );
  });

  it("'no epoch' only for a real, empty answer; otherwise a prompt to pick one", () => {
    expect(epochDetailNote({ state: "read", value: [] })).toBe("No epoch to show");
    expect(epochDetailNote({ state: "read", value: [EPOCH] })).toBe("Click an epoch to see breakdown");
  });
});

describe("triggerBadge: the epoch-list badge (M3)", () => {
  it("colors size teal, value gold, manual/age gray", () => {
    expect(triggerBadge({ batches: [{ ...EPOCH.batches[0], trigger: "size" }] })).toEqual({ label: "size", color: "teal" });
    expect(triggerBadge({ batches: [{ ...EPOCH.batches[0], trigger: "value" }] })).toEqual({ label: "value", color: "gold" });
    expect(triggerBadge({ batches: [{ ...EPOCH.batches[0], trigger: "manual" }] })).toEqual({ label: "manual", color: "gray" });
    expect(triggerBadge({ batches: [{ ...EPOCH.batches[0], trigger: "age" }] })).toEqual({ label: "age", color: "gray" });
  });

  it("NEGATIVE: an empty batch list is 'no batches', never an invented trigger", () => {
    expect(triggerBadge({ batches: [] })).toEqual({ label: "no batches", color: "gray" });
  });
});

describe("flushOutcome", () => {
  it("reports what the gateway says it flushed, or its refusal", () => {
    expect(flushOutcome(200, {
      epoch: 3,
      totalIntents: 5,
      batches: 1,
      batchDetails: [{ userOpHash: "0x" + "ab".repeat(32), operationCount: 5, trigger: "manual" }],
      byAgent: { a: 5 },
      byOperation: { release: 5 },
      duration: 12,
    })).toEqual({
      ok: true,
      message: "The gateway reports epoch 3 flushed: 5 operations in 1 batch(es).",
    });
    // The counts alone are not the route's answer (review r2 of #425, H1).
    expect(flushOutcome(200, { epoch: 3, totalIntents: 5, batches: 1 }).ok).toBe(false);
    expect(flushOutcome(503, { error: "batch_disabled", message: "Batch settlement is not configured. Set PCC_BUNDLER_URL to enable." })).toEqual({
      ok: false,
      message: "Batch settlement is not configured. Set PCC_BUNDLER_URL to enable.",
    });
  });
});

describe("NEGATIVE (#313: accepted is not settled): a flush never reads as settled", () => {
  it("the flush answer carries bundler UserOperation hashes, not an on-chain receipt", () => {
    const body = {
      epoch: 3,
      totalIntents: 5,
      batches: 1,
      batchDetails: [{ userOpHash: "0x" + "ab".repeat(32), operationCount: 5, trigger: "manual" }],
      byAgent: { a: 5 },
      byOperation: { release: 5 },
      duration: 12,
    };
    expect(flushOutcome(200, body).ok).toBe(true);
    for (const b of [body, {}, null]) expect(flushOutcome(200, b).message, JSON.stringify(b)).not.toMatch(/settle/i);
  });
});

describe("flushOutcome: a malformed 2xx is never assumed accepted (H1)", () => {
  const SHAPE_MESSAGE = "The gateway's answer did not have the expected shape.";

  it("NEGATIVE: a 2xx body missing the flush contract's fields fails closed, not a bare acceptance", () => {
    expect(flushOutcome(200, {})).toEqual({ ok: false, message: SHAPE_MESSAGE });
    expect(flushOutcome(200, null)).toEqual({ ok: false, message: SHAPE_MESSAGE });
    expect(flushOutcome(200, { epoch: 3, totalIntents: 5 })).toEqual({ ok: false, message: SHAPE_MESSAGE });
  });

  it("NEGATIVE: batchDetails must be present and match the flush contract, or the whole read fails closed", () => {
    const hash = "0x" + "ab".repeat(32);
    // Not a real UserOp hash.
    expect(
      flushOutcome(200, { epoch: 3, totalIntents: 5, batches: 1, batchDetails: [{ userOpHash: "0xab", operationCount: 5, trigger: "manual" }] })
        .ok,
    ).toBe(false);
    // batches says 2 batches, batchDetails lists only 1 — an inconsistent body.
    expect(
      flushOutcome(200, { epoch: 3, totalIntents: 5, batches: 2, batchDetails: [{ userOpHash: hash, operationCount: 5, trigger: "manual" }] })
        .ok,
    ).toBe(false);
  });

  it("the route's whole answer, with a well-formed batchDetails, is a success", () => {
    expect(flushOutcome(200, {
      epoch: 3,
      totalIntents: 5,
      batches: 1,
      batchDetails: [{ userOpHash: "0x" + "ab".repeat(32), operationCount: 5, trigger: "manual" }],
      byAgent: { a: 5 },
      byOperation: { release: 5 },
      duration: 12,
    })).toEqual({ ok: true, message: "The gateway reports epoch 3 flushed: 5 operations in 1 batch(es)." });
  });
});

describe("flushConfirmation", () => {
  it("names the pending count, what a flush does, and that it cannot be recalled", () => {
    const text = flushConfirmation({ ...STATUS, pending: 7 });
    expect(text).toContain("Flush 7 pending operations now?");
    expect(text).toContain("to the bundler as batched ERC-4337 UserOperations that act on escrow");
    expect(text).toContain("A flush cannot be recalled once sent.");
    expect(flushConfirmation({ ...STATUS, pending: 1 })).toContain("Flush 1 pending operation now?");
  });
});

describe("formatUsdcBaseUnits", () => {
  it("formats exactly, with at least 2 decimals", () => {
    expect(formatUsdcBaseUnits("342000000")).toBe("342.00");
    expect(formatUsdcBaseUnits("1500000")).toBe("1.50");
    expect(formatUsdcBaseUnits("1234500")).toBe("1.2345");
    expect(formatUsdcBaseUnits("1")).toBe("0.000001");
    expect(formatUsdcBaseUnits("0")).toBe("0.00");
    expect(formatUsdcBaseUnits("123456789012345678901")).toBe("123456789012345.678901");
  });

  it("NEGATIVE: anything but an integer string is null, never a guess", () => {
    for (const bad of ["", "1.5", "-1", "abc", " 1"]) expect(formatUsdcBaseUnits(bad), bad).toBeNull();
  });
});

// Bodies captured from a real gateway (NODE_ENV=production, fresh DB, an operator key), 2026-09-24.
describe("the gateway's real answers", () => {
  it("a gateway with batch settlement off: status reads, and the empty history is empty", () => {
    const status = { batchEnabled: false, pending: 0, totalValue: "0", oldestAge: 0, autoFlush: false, smartAccountAddress: null };
    expect(statusFromResponse(200, status)).toEqual({ state: "read", value: { ...status, clockAdjusted: false } });
    expect(epochsFromResponse(200, { epochs: [] })).toEqual({ state: "read", value: [] });
  });

  it("a flush refused for scope shows the gateway's own message", () => {
    const body = {
      error: "insufficient_scope",
      message: "Funds movement requires one of the following explicit scopes: settlement, admin.",
      required_scopes: ["settlement", "admin"],
      caller_scopes: ["operator"],
    };
    expect(flushOutcome(403, body)).toEqual({ ok: false, message: body.message });
  });
});

describe("createFlushController: no double-flush, disabled through the reload (M5)", () => {
  it("a second confirm while one flush (post + reload) is in flight sends no second POST", async () => {
    let postCalls = 0;
    let resolvePost!: (v: { ok: boolean; message: string }) => void;
    const postPromise = new Promise<{ ok: boolean; message: string }>((res) => {
      resolvePost = res;
    });
    let resolveReload!: () => void;
    const reloadPromise = new Promise<void>((res) => {
      resolveReload = res;
    });

    const results: Array<{ ok: boolean; message: string }> = [];
    const flushingStates: boolean[] = [];

    const controller = createFlushController<{ ok: boolean; message: string }>({
      post: () => {
        postCalls += 1;
        return postPromise;
      },
      reload: () => reloadPromise,
      onResult: (r) => results.push(r),
      onError: () => {},
      onReloadError: () => {},
      onFlushingChange: (f) => flushingStates.push(f),
    });

    const first = controller.confirmFlush();
    expect(controller.isFlushing()).toBe(true);

    // A second confirm while the POST is still in flight: no second POST.
    expect(await controller.confirmFlush()).toBe(false);
    expect(postCalls).toBe(1);

    resolvePost({ ok: true, message: "flushed" });
    // Let the post's continuation (onResult, then reaching `await reload()`) run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The POST resolved, but the authoritative reload has not — still disabled.
    expect(controller.isFlushing()).toBe(true);
    expect(await controller.confirmFlush()).toBe(false);
    expect(postCalls).toBe(1); // still just the one POST, ever

    resolveReload();
    expect(await first).toBe(true);

    expect(controller.isFlushing()).toBe(false);
    expect(results).toEqual([{ ok: true, message: "flushed" }]);
    expect(postCalls).toBe(1);
    expect(flushingStates).toEqual([true, false]);
  });

  it("a normal flush: flushing is true until the reload settles, then false", async () => {
    const states: boolean[] = [];
    const controller = createFlushController<{ ok: boolean; message: string }>({
      post: async () => ({ ok: true, message: "ok" }),
      reload: async () => {},
      onResult: () => {},
      onError: () => {},
      onReloadError: () => {},
      onFlushingChange: (f) => states.push(f),
    });
    expect(await controller.confirmFlush()).toBe(true);
    expect(states).toEqual([true, false]);
    expect(controller.isFlushing()).toBe(false);
  });

  it("NEGATIVE: a POST failure still runs the authoritative reload and clears the in-flight guard", async () => {
    let reloaded = false;
    let caught: unknown;
    const controller = createFlushController<{ ok: boolean; message: string }>({
      post: async () => {
        throw new Error("network");
      },
      reload: async () => {
        reloaded = true;
      },
      onResult: () => {},
      onError: (e) => {
        caught = e;
      },
      onReloadError: () => {},
      onFlushingChange: () => {},
    });
    await controller.confirmFlush();
    expect(reloaded).toBe(true);
    expect((caught as Error).message).toBe("network");
    expect(controller.isFlushing()).toBe(false);
  });
});

describe("averageOpsPerBatch: operations per UserOperation, from the batches themselves", () => {
  const batch = (operationCount: number) => ({ userOpHash: "0x" + "cd".repeat(32), operationCount, trigger: "size" as const });
  it("averages the batches' own operation counts", () => {
    expect(averageOpsPerBatch([{ ...EPOCH, batches: [batch(2), batch(4)] }])).toBe(3);
  });
  it("NEGATIVE: an epoch with no batch adds no operations to the average (it used to add its totalIntents)", () => {
    const empty = { ...EPOCH, totalIntents: 10, batches: [] };
    expect(averageOpsPerBatch([{ ...EPOCH, batches: [batch(2), batch(4)] }, empty])).toBe(3);
  });
  it("no batch at all is no average, never zero", () => {
    expect(averageOpsPerBatch([])).toBeNull();
    expect(averageOpsPerBatch([{ ...EPOCH, totalIntents: 5, batches: [] }])).toBeNull();
  });
});
