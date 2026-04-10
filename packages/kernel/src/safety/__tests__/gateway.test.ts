/**
 * SafetyGateway unit tests.
 *
 * All tests construct SafetyGateway directly (not via singleton) for isolation.
 * The singleton helpers (getSafetyGateway / initSafetyGateway / resetSafetyGateway)
 * are tested separately to verify lifecycle behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SafetyGateway,
  getSafetyGateway,
  initSafetyGateway,
  resetSafetyGateway,
} from "../gateway.js";
import type { PhysicalCommand } from "../governor.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let cmdCounter = 0;

function makeCmd(overrides: Partial<PhysicalCommand> = {}): PhysicalCommand {
  return {
    commandId: `cmd-${++cmdCounter}`,
    deviceId: "dev-001",
    class: "safe",
    type: "get_status",
    params: {},
    agentDid: "did:key:agent-test",
    ...overrides,
  };
}

const noop = async (): Promise<unknown> => undefined;

// ── Governor allows + circuit closed → executes ───────────────────────────────

describe("SafetyGateway — governor allows + circuit closed → executes", () => {
  it("returns allowed=true and executed=true on a clean safe command", async () => {
    const gw = new SafetyGateway();
    const result = await gw.validateAndRelay(makeCmd({ class: "safe" }), noop);

    expect(result.allowed).toBe(true);
    expect(result.executed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns allowed=true and executed=true on a read command", async () => {
    const gw = new SafetyGateway();
    const result = await gw.validateAndRelay(makeCmd({ class: "read" }), noop);

    expect(result.allowed).toBe(true);
    expect(result.executed).toBe(true);
  });

  it("passes execute() return value through as result", async () => {
    const gw = new SafetyGateway();
    const payload = { machines: 3 };
    const result = await gw.validateAndRelay(makeCmd({ class: "read" }), async () => payload);

    expect(result.result).toEqual(payload);
  });

  it("includes a governor verdict on success", async () => {
    const gw = new SafetyGateway();
    const result = await gw.validateAndRelay(makeCmd({ class: "safe" }), noop);

    expect(result.verdict).toBeDefined();
    expect(result.verdict!.allowed).toBe(true);
    expect(Array.isArray(result.verdict!.checks)).toBe(true);
  });
});

// ── Governor denies → does not execute ───────────────────────────────────────

describe("SafetyGateway — governor denies → does not execute", () => {
  it("denies a privileged command and never calls execute()", async () => {
    const gw = new SafetyGateway();
    let called = false;
    const result = await gw.validateAndRelay(
      makeCmd({ class: "privileged" }),
      async () => {
        called = true;
        return undefined;
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.executed).toBe(false);
    expect(called).toBe(false);
  });

  it("denies a scoped command without scopeId and never calls execute()", async () => {
    const gw = new SafetyGateway();
    let called = false;
    const result = await gw.validateAndRelay(
      makeCmd({ class: "scoped", scopeId: undefined }),
      async () => {
        called = true;
        return undefined;
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.executed).toBe(false);
    expect(called).toBe(false);
  });

  it("includes the verdict with allowed=false and a non-empty checks array", async () => {
    const gw = new SafetyGateway();
    const result = await gw.validateAndRelay(
      makeCmd({ class: "privileged" }),
      noop,
    );

    expect(result.verdict).toBeDefined();
    expect(result.verdict!.allowed).toBe(false);
    expect(result.verdict!.checks.length).toBeGreaterThan(0);
  });

  it("velocity envelope violation denies and does not execute", async () => {
    const gw = new SafetyGateway({ envelope: { maxVelocity: 100 } });
    let called = false;
    const result = await gw.validateAndRelay(
      makeCmd({ class: "safe", params: { velocity: 999 } }),
      async () => {
        called = true;
        return undefined;
      },
    );

    expect(result.allowed).toBe(false);
    expect(called).toBe(false);
  });
});

// ── Circuit open → does not execute ──────────────────────────────────────────

describe("SafetyGateway — circuit open → does not execute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns allowed=false with reason=circuit_open when circuit is tripped", async () => {
    // failureThreshold=1 means one failure trips it immediately
    const gw = new SafetyGateway({ circuitBreaker: { failureThreshold: 1, cooldownMs: 30_000 } });
    const cmd = makeCmd({ deviceId: "dev-tripped" });

    // Trip the circuit by running a command that throws
    await gw.validateAndRelay(cmd, async () => {
      throw new Error("hardware failure");
    });

    // Circuit is now open — next call should be denied immediately
    let executeCalled = false;
    const result = await gw.validateAndRelay(makeCmd({ deviceId: "dev-tripped" }), async () => {
      executeCalled = true;
      return undefined;
    });

    expect(result.allowed).toBe(false);
    expect(result.executed).toBe(false);
    expect(result.reason).toBe("circuit_open");
    expect(executeCalled).toBe(false);
  });

  it("circuit verdict contains circuit_breaker check when open", async () => {
    const gw = new SafetyGateway({ circuitBreaker: { failureThreshold: 1, cooldownMs: 30_000 } });
    const cmd = makeCmd({ deviceId: "dev-trip2" });

    await gw.validateAndRelay(cmd, async () => {
      throw new Error("boom");
    });

    const result = await gw.validateAndRelay(makeCmd({ deviceId: "dev-trip2" }), noop);
    expect(result.verdict?.checks.some((c) => c.name === "circuit_breaker")).toBe(true);
  });
});

// ── Execution failure → circuit records failure ───────────────────────────────

describe("SafetyGateway — execution failure → circuit records failure", () => {
  it("returns allowed=true, executed=false, error set when execute throws", async () => {
    const gw = new SafetyGateway();
    const result = await gw.validateAndRelay(makeCmd({ class: "safe" }), async () => {
      throw new Error("adapter error");
    });

    expect(result.allowed).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.error).toBe("adapter error");
  });

  it("trips circuit after repeated failures (failureThreshold=3)", async () => {
    const gw = new SafetyGateway({ circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 } });
    const cmd = () => makeCmd({ deviceId: "dev-repeated-fail" });
    const alwaysThrows = async () => {
      throw new Error("repeated failure");
    };

    await gw.validateAndRelay(cmd(), alwaysThrows);
    await gw.validateAndRelay(cmd(), alwaysThrows);
    await gw.validateAndRelay(cmd(), alwaysThrows);

    // Now circuit should be open
    const result = await gw.validateAndRelay(cmd(), noop);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("circuit_open");
  });
});

// ── Execution success → circuit records success ───────────────────────────────

describe("SafetyGateway — execution success → circuit records success", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes circuit after successThreshold successes in half_open", async () => {
    const gw = new SafetyGateway({
      circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000, successThreshold: 2 },
    });
    const cmd = () => makeCmd({ deviceId: "dev-recovery" });

    // Trip circuit
    await gw.validateAndRelay(cmd(), async () => { throw new Error("x"); });

    // Advance past cooldown → transitions to half_open
    vi.advanceTimersByTime(2_000);

    // Two successes should close it
    await gw.validateAndRelay(cmd(), noop);
    await gw.validateAndRelay(cmd(), noop);

    // Circuit closed — third call should be allowed normally
    const result = await gw.validateAndRelay(cmd(), noop);
    expect(result.allowed).toBe(true);
    expect(result.executed).toBe(true);
  });
});

// ── E-stop engaged → nothing executes ────────────────────────────────────────

describe("SafetyGateway — e-stop engaged → nothing executes", () => {
  it("denies all command classes when e-stop is engaged", async () => {
    const gw = new SafetyGateway({ initialHardwareState: { isEStopEngaged: true } });
    const classes: PhysicalCommand["class"][] = ["read", "safe", "scoped", "privileged"];

    for (const cls of classes) {
      let called = false;
      const result = await gw.validateAndRelay(
        makeCmd({ class: cls, scopeId: cls === "scoped" ? "scope-123" : undefined }),
        async () => {
          called = true;
          return undefined;
        },
      );

      expect(result.allowed).toBe(false);
      expect(called).toBe(false);
    }
  });

  it("engages e-stop via updateHardwareState and blocks subsequent commands", async () => {
    const gw = new SafetyGateway();

    // First command succeeds
    const r1 = await gw.validateAndRelay(makeCmd({ class: "safe" }), noop);
    expect(r1.allowed).toBe(true);

    // Engage e-stop
    gw.updateHardwareState({ isEStopEngaged: true });

    // Next command blocked
    let called = false;
    const r2 = await gw.validateAndRelay(makeCmd({ class: "safe" }), async () => {
      called = true;
      return undefined;
    });
    expect(r2.allowed).toBe(false);
    expect(called).toBe(false);
  });

  it("allows commands again after e-stop is cleared", async () => {
    const gw = new SafetyGateway({ initialHardwareState: { isEStopEngaged: true } });

    // Blocked while engaged
    const r1 = await gw.validateAndRelay(makeCmd({ class: "safe" }), noop);
    expect(r1.allowed).toBe(false);

    // Clear e-stop
    gw.updateHardwareState({ isEStopEngaged: false });

    // Allowed again
    const r2 = await gw.validateAndRelay(makeCmd({ class: "safe" }), noop);
    expect(r2.allowed).toBe(true);
  });
});

// ── Singleton lifecycle ───────────────────────────────────────────────────────

describe("SafetyGateway singleton", () => {
  beforeEach(() => {
    resetSafetyGateway();
  });

  afterEach(() => {
    resetSafetyGateway();
  });

  it("getSafetyGateway() throws before initSafetyGateway()", () => {
    expect(() => getSafetyGateway()).toThrow("[safety-gateway]");
  });

  it("initSafetyGateway() returns a SafetyGateway instance", () => {
    const gw = initSafetyGateway();
    expect(gw).toBeInstanceOf(SafetyGateway);
  });

  it("getSafetyGateway() returns the same instance as initSafetyGateway()", () => {
    const gw1 = initSafetyGateway();
    const gw2 = getSafetyGateway();
    expect(gw1).toBe(gw2);
  });

  it("initSafetyGateway() is idempotent — repeated calls return same instance", () => {
    const gw1 = initSafetyGateway();
    const gw2 = initSafetyGateway({ envelope: { maxVelocity: 1 } }); // different config, ignored
    expect(gw1).toBe(gw2);
  });

  it("resetSafetyGateway() clears singleton so getSafetyGateway() throws again", () => {
    initSafetyGateway();
    resetSafetyGateway();
    expect(() => getSafetyGateway()).toThrow("[safety-gateway]");
  });
});

// ── getStatus() ───────────────────────────────────────────────────────────────

describe("SafetyGateway.getStatus()", () => {
  it("returns hardware state and circuit map", () => {
    const gw = new SafetyGateway();
    const status = gw.getStatus();

    expect(status.hardwareState).toBeDefined();
    expect(status.hardwareState.isEStopEngaged).toBe(false);
    expect(status.circuits).toBeDefined();
  });
});

// ── resetCircuit() ────────────────────────────────────────────────────────────

describe("SafetyGateway.resetCircuit()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("operator reset closes a tripped circuit immediately", async () => {
    const gw = new SafetyGateway({ circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } });
    const cmd = () => makeCmd({ deviceId: "dev-reset" });

    await gw.validateAndRelay(cmd(), async () => { throw new Error("trip"); });

    // Should be open
    const blocked = await gw.validateAndRelay(cmd(), noop);
    expect(blocked.allowed).toBe(false);

    // Operator resets
    gw.resetCircuit("dev-reset");

    // Should be closed again
    const allowed = await gw.validateAndRelay(cmd(), noop);
    expect(allowed.allowed).toBe(true);
  });
});
