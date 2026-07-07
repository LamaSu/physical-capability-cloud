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

// ── validateOnly — admission without executing or recording ───────────────────

describe("SafetyGateway.validateOnly — admits without recording an outcome", () => {
  it("admits a clean command (allowed=true, executed=false)", async () => {
    const gw = new SafetyGateway();
    const result = await gw.validateOnly(makeCmd({ class: "safe" }));

    expect(result.allowed).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.verdict?.allowed).toBe(true);
  });

  it("denies a governor violation (privileged) without executing", async () => {
    const gw = new SafetyGateway();
    const result = await gw.validateOnly(makeCmd({ class: "privileged" }));

    expect(result.allowed).toBe(false);
    expect(result.executed).toBe(false);
  });

  it("blocks admission when the device breaker is already open", async () => {
    const gw = new SafetyGateway({ circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } });
    // Trip via a real out-of-band failure report.
    gw.recordDeviceFailure("dev-vo-open");

    const result = await gw.validateOnly(makeCmd({ deviceId: "dev-vo-open" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("circuit_open");
  });

  it("records NOTHING — repeated admissions never reset an accruing failure count", async () => {
    // Core regression guard. The removed pre-flight passed a no-op execute to
    // validateAndRelay, recording a phantom SUCCESS that reset consecutiveFailures
    // to 0 on every job — so the breaker could never trip from real failures.
    const gw = new SafetyGateway({ circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 } });
    const dev = "dev-vo-noreset";

    gw.recordDeviceFailure(dev); // 1
    gw.recordDeviceFailure(dev); // 2
    // Interleave admissions the way a busy gateway would between jobs.
    await gw.validateOnly(makeCmd({ deviceId: dev }));
    await gw.validateOnly(makeCmd({ deviceId: dev }));
    // Still 2 consecutive failures — admissions did not reset the count.
    expect(gw.getStatus().circuits.get(dev)?.state).toBe("closed");

    gw.recordDeviceFailure(dev); // 3 → threshold
    expect(gw.getStatus().circuits.get(dev)?.state).toBe("open");
  });
});

// ── recordDeviceFailure / recordDeviceSuccess — out-of-band outcome reporting ──

describe("SafetyGateway.recordDevice{Failure,Success} — real outcomes trip/reset", () => {
  it("recordDeviceFailure trips after threshold; validateOnly then blocks the next job", async () => {
    const gw = new SafetyGateway({ circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 } });
    const dev = "dev-oob-fail";

    // Next job admitted while healthy.
    expect((await gw.validateOnly(makeCmd({ deviceId: dev }))).allowed).toBe(true);

    gw.recordDeviceFailure(dev);
    gw.recordDeviceFailure(dev);
    expect(gw.getStatus().circuits.get(dev)?.state).toBe("closed"); // 2 of 3
    gw.recordDeviceFailure(dev); // threshold → open
    expect(gw.getStatus().circuits.get(dev)?.state).toBe("open");

    // The next job is blocked by the tripped breaker.
    const blocked = await gw.validateOnly(makeCmd({ deviceId: dev }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("circuit_open");
  });

  it("recordDeviceSuccess resets an accruing failure count (device recovered)", async () => {
    const gw = new SafetyGateway({ circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 } });
    const dev = "dev-oob-recover";

    gw.recordDeviceFailure(dev);
    gw.recordDeviceFailure(dev);
    gw.recordDeviceSuccess(dev); // reset consecutive count
    gw.recordDeviceFailure(dev);
    gw.recordDeviceFailure(dev);
    // Only 2 consecutive failures since the reset — not tripped.
    expect(gw.getStatus().circuits.get(dev)?.state).toBe("closed");
  });

  it("recordDeviceSuccess in half_open closes a previously tripped breaker", async () => {
    vi.useFakeTimers();
    try {
      const gw = new SafetyGateway({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000, successThreshold: 2 },
      });
      const dev = "dev-oob-halfopen";

      gw.recordDeviceFailure(dev); // open
      expect(gw.getStatus().circuits.get(dev)?.state).toBe("open");

      vi.advanceTimersByTime(2_000); // cooldown elapsed
      // Admission transitions open → half_open and allows a test command.
      expect((await gw.validateOnly(makeCmd({ deviceId: dev }))).allowed).toBe(true);

      gw.recordDeviceSuccess(dev);
      gw.recordDeviceSuccess(dev); // successThreshold → closed
      expect(gw.getStatus().circuits.get(dev)?.state).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });
});
