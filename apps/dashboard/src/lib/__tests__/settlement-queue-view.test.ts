/**
 * The Settlement page's queue view (PX-3): the gateway's answers or a stated reason, never
 * the invented numbers the page used to start from and keep on failure.
 */
import { describe, it, expect } from "vitest";
import {
  UNREACHABLE,
  epochsFromResponse,
  flushOutcome,
  formatUsdcBaseUnits,
  statusFromResponse,
} from "../settlement-queue-view.js";

const STATUS = { batchEnabled: true, pending: 2, totalValue: "1500000", oldestAge: 1200, autoFlush: false, smartAccountAddress: null };
const EPOCH = {
  epochId: 1,
  batches: [{ userOpHash: "0xab", operationCount: 2, trigger: "manual" }],
  totalIntents: 2,
  byAgent: { a: 2 },
  byOperation: { release: 2 },
  startedAt: 1000,
  completedAt: 1500,
};

describe("statusFromResponse", () => {
  it("reads the gateway's queue status", () => {
    expect(statusFromResponse(200, STATUS)).toEqual({ state: "read", value: STATUS });
  });

  it("reads a gateway with batch settlement off as a real answer", () => {
    const off = { ...STATUS, batchEnabled: false, pending: 0, totalValue: "0" };
    expect(statusFromResponse(200, off)).toEqual({ state: "read", value: off });
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
});

describe("epochsFromResponse", () => {
  it("reads epochs, and an EMPTY history as empty (not as a failure, not as examples)", () => {
    expect(epochsFromResponse(200, { epochs: [EPOCH] })).toEqual({ state: "read", value: [EPOCH] });
    expect(epochsFromResponse(200, { epochs: [] })).toEqual({ state: "read", value: [] });
  });

  it("NEGATIVE: a refusal or a malformed epoch is unavailable", () => {
    expect(epochsFromResponse(401, { message: "Unauthorized" })).toEqual({ state: "unavailable", reason: "Unauthorized" });
    expect(epochsFromResponse(200, { epochs: [{ ...EPOCH, totalIntents: "2" }] }).state).toBe("unavailable");
    expect(epochsFromResponse(200, {}).state).toBe("unavailable");
  });

  it("an unreachable gateway has its own reason", () => {
    expect(UNREACHABLE).toEqual({ state: "unavailable", reason: "The gateway could not be reached." });
  });
});

describe("flushOutcome", () => {
  it("reports the settled epoch, or the gateway's refusal", () => {
    expect(flushOutcome(200, { epoch: 3, totalIntents: 5, batches: 1 })).toEqual({ ok: true, message: "Settled epoch 3: 5 operations in 1 batch(es)." });
    expect(flushOutcome(503, { error: "batch_disabled", message: "Batch settlement is not configured. Set PCC_BUNDLER_URL to enable." })).toEqual({
      ok: false,
      message: "Batch settlement is not configured. Set PCC_BUNDLER_URL to enable.",
    });
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
    expect(statusFromResponse(200, status)).toEqual({ state: "read", value: status });
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
