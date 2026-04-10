import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SafetyGateway,
  getSafetyGateway,
  initSafetyGateway,
  resetSafetyGateway,
} from "../safety/gateway.js";
import type { PhysicalCommand } from "../safety/governor.js";

// ── Fixture factories ──────────────────────────────────────────────────────

let cmdCounter = 0;

function makeCmd(overrides: Partial<PhysicalCommand> = {}): PhysicalCommand {
  return {
    commandId: `cmd-${++cmdCounter}`,
    deviceId: "dev-001",
    class: "read",
    type: "get_status",
    params: {},
    agentDid: "did:key:agent-001",
    ...overrides,
  };
}

const noopExecute = async (): Promise<unknown> => ({ ok: true });
const throwingExecute = async (): Promise<unknown> => {
  throw new Error("hardware failure");
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SafetyGateway", () => {
  beforeEach(() => {
    cmdCounter = 0;
    resetSafetyGateway();
  });

  afterEach(() => {
    resetSafetyGateway();
    vi.useRealTimers();
  });

  // ── Constructor / singleton ────────────────────────────────────────────

  describe("singleton lifecycle", () => {
    it("getSafetyGateway() throws before init", () => {
      expect(() => getSafetyGateway()).toThrow("[safety-gateway]");
    });

    it("initSafetyGateway() returns a SafetyGateway instance", () => {
      const gw = initSafetyGateway();
      expect(gw).toBeInstanceOf(SafetyGateway);
    });

    it("initSafetyGateway() is idempotent — returns the same instance on second call", () => {
      const gw1 = initSafetyGateway();
      const gw2 = initSafetyGateway();
      expect(gw1).toBe(gw2);
    });

    it("getSafetyGateway() returns the initialized instance", () => {
      const gw = initSafetyGateway();
      expect(getSafetyGateway()).toBe(gw);
    });

    it("resetSafetyGateway() clears the singleton so getSafetyGateway() throws again", () => {
      initSafetyGateway();
      resetSafetyGateway();
      expect(() => getSafetyGateway()).toThrow("[safety-gateway]");
    });

    it("can reinitialize after reset", () => {
      initSafetyGateway();
      resetSafetyGateway();
      const gw = initSafetyGateway();
      expect(gw).toBeInstanceOf(SafetyGateway);
    });

    it("direct construction (new SafetyGateway()) is independent of singleton", () => {
      const direct = new SafetyGateway();
      expect(() => getSafetyGateway()).toThrow(); // singleton still uninitialized
      expect(direct).toBeInstanceOf(SafetyGateway);
    });
  });

  // ── validateAndRelay — happy path ──────────────────────────────────────

  describe("validateAndRelay() — allowed path", () => {
    it("returns { allowed: true, executed: true, result } on clean command", async () => {
      const gw = new SafetyGateway();
      const res = await gw.validateAndRelay(makeCmd({ class: "read" }), noopExecute);

      expect(res.allowed).toBe(true);
      expect(res.executed).toBe(true);
      expect(res.result).toEqual({ ok: true });
      expect(res.error).toBeUndefined();
    });

    it("verdict is present on success", async () => {
      const gw = new SafetyGateway();
      const res = await gw.validateAndRelay(makeCmd(), noopExecute);
      expect(res.verdict).toBeDefined();
      expect(res.verdict?.allowed).toBe(true);
    });

    it("passes execute() return value as result", async () => {
      const gw = new SafetyGateway();
      const payload = { deviceData: [1, 2, 3] };
      const res = await gw.validateAndRelay(makeCmd(), async () => payload);
      expect(res.result).toEqual(payload);
    });

    it("scoped command with scopeId passes governor class check", async () => {
      const gw = new SafetyGateway();
      const cmd = makeCmd({ class: "scoped", scopeId: "scope-abc", type: "run_protocol" });
      const res = await gw.validateAndRelay(cmd, noopExecute);
      expect(res.allowed).toBe(true);
      expect(res.executed).toBe(true);
    });

    it("safe command class passes without scopeId", async () => {
      const gw = new SafetyGateway();
      const cmd = makeCmd({ class: "safe", type: "home" });
      const res = await gw.validateAndRelay(cmd, noopExecute);
      expect(res.allowed).toBe(true);
      expect(res.executed).toBe(true);
    });
  });

  // ── validateAndRelay — e-stop blocks ──────────────────────────────────

  describe("validateAndRelay() — e-stop engaged", () => {
    it("blocks ALL commands when e-stop is engaged", async () => {
      const gw = new SafetyGateway({
        initialHardwareState: { isEStopEngaged: true },
      });
      const res = await gw.validateAndRelay(makeCmd({ class: "read" }), noopExecute);

      expect(res.allowed).toBe(false);
      expect(res.executed).toBe(false);
    });

    it("e-stop verdict includes the e_stop check", async () => {
      const gw = new SafetyGateway({
        initialHardwareState: { isEStopEngaged: true },
      });
      const res = await gw.validateAndRelay(makeCmd(), noopExecute);

      const eStopCheck = res.verdict?.checks.find((c) => c.name === "e_stop");
      expect(eStopCheck?.passed).toBe(false);
    });

    it("does NOT call execute() when e-stop is engaged", async () => {
      const gw = new SafetyGateway({
        initialHardwareState: { isEStopEngaged: true },
      });
      const execSpy = vi.fn(noopExecute);
      await gw.validateAndRelay(makeCmd(), execSpy);

      expect(execSpy).not.toHaveBeenCalled();
    });

    it("e-stop denial does NOT trip the circuit breaker", async () => {
      const gw = new SafetyGateway({
        initialHardwareState: { isEStopEngaged: true },
        circuitBreaker: { failureThreshold: 1 },
      });

      // Multiple denied commands due to e-stop
      for (let i = 0; i < 5; i++) {
        await gw.validateAndRelay(makeCmd(), noopExecute);
      }

      // Circuit should still be closed (not tripped by governor rejections)
      const status = gw.getStatus();
      const devState = status.circuits.get("dev-001");
      // Either undefined (never recorded) or closed
      expect(devState?.state ?? "closed").toBe("closed");
    });

    it("commands pass again after e-stop is cleared", async () => {
      const gw = new SafetyGateway({
        initialHardwareState: { isEStopEngaged: true },
      });

      const blocked = await gw.validateAndRelay(makeCmd(), noopExecute);
      expect(blocked.allowed).toBe(false);

      gw.updateHardwareState({ isEStopEngaged: false });

      const allowed = await gw.validateAndRelay(makeCmd(), noopExecute);
      expect(allowed.allowed).toBe(true);
    });
  });

  // ── validateAndRelay — maintenance mode ───────────────────────────────

  describe("validateAndRelay() — maintenance mode", () => {
    it("blocks commands when maintenance mode is active", async () => {
      const gw = new SafetyGateway({
        initialHardwareState: { isMaintenanceMode: true },
      });
      const res = await gw.validateAndRelay(makeCmd(), noopExecute);
      expect(res.allowed).toBe(false);
      expect(res.verdict?.checks.find((c) => c.name === "maintenance_mode")?.passed).toBe(false);
    });
  });

  // ── validateAndRelay — circuit breaker ────────────────────────────────

  describe("validateAndRelay() — circuit breaker", () => {
    it("returns { allowed: false, reason: 'circuit_open' } when circuit is open", async () => {
      vi.useFakeTimers();
      const gw = new SafetyGateway({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, successThreshold: 2 },
      });

      // Trip the circuit by recording a failure via a throwing execute
      await gw.validateAndRelay(makeCmd(), throwingExecute);
      expect(gw.getStatus().circuits.get("dev-001")?.state).toBe("open");

      // Next command should be blocked by circuit breaker
      const res = await gw.validateAndRelay(makeCmd(), noopExecute);

      expect(res.allowed).toBe(false);
      expect(res.executed).toBe(false);
      expect(res.reason).toBe("circuit_open");
    });

    it("circuit_open verdict includes circuit_breaker check", async () => {
      vi.useFakeTimers();
      const gw = new SafetyGateway({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, successThreshold: 2 },
      });

      await gw.validateAndRelay(makeCmd(), throwingExecute);

      const res = await gw.validateAndRelay(makeCmd(), noopExecute);
      const cbCheck = res.verdict?.checks.find((c) => c.name === "circuit_breaker");
      expect(cbCheck?.passed).toBe(false);
    });

    it("does NOT call execute() when circuit is open", async () => {
      vi.useFakeTimers();
      const gw = new SafetyGateway({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, successThreshold: 2 },
      });
      await gw.validateAndRelay(makeCmd(), throwingExecute);

      const execSpy = vi.fn(noopExecute);
      await gw.validateAndRelay(makeCmd(), execSpy);

      expect(execSpy).not.toHaveBeenCalled();
    });

    it("recordsSuccess on successful execute and keeps circuit closed", async () => {
      const gw = new SafetyGateway({
        circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000, successThreshold: 2 },
      });

      await gw.validateAndRelay(makeCmd(), noopExecute);
      await gw.validateAndRelay(makeCmd(), noopExecute);

      const state = gw.getStatus().circuits.get("dev-001");
      expect(state?.state ?? "closed").toBe("closed");
      expect(state?.failures ?? 0).toBe(0);
    });

    it("records execute failure to circuit breaker", async () => {
      const gw = new SafetyGateway({
        circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000, successThreshold: 2 },
      });

      await gw.validateAndRelay(makeCmd(), throwingExecute);

      const state = gw.getStatus().circuits.get("dev-001");
      expect(state?.failures).toBe(1);
    });

    it("returns { allowed: true, executed: false, error } when execute throws", async () => {
      const gw = new SafetyGateway();
      const res = await gw.validateAndRelay(makeCmd(), throwingExecute);

      expect(res.allowed).toBe(true);
      expect(res.executed).toBe(false);
      expect(res.error).toBe("hardware failure");
    });

    it("trips circuit after failureThreshold failures", async () => {
      vi.useFakeTimers();
      const gw = new SafetyGateway({
        circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000, successThreshold: 2 },
      });

      await gw.validateAndRelay(makeCmd(), throwingExecute);
      expect(gw.getStatus().circuits.get("dev-001")?.state).toBe("closed"); // 1 failure, not yet

      await gw.validateAndRelay(makeCmd(), throwingExecute);
      expect(gw.getStatus().circuits.get("dev-001")?.state).toBe("open"); // threshold hit
    });

    it("resetCircuit() closes a tripped circuit", async () => {
      vi.useFakeTimers();
      const gw = new SafetyGateway({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, successThreshold: 2 },
      });

      await gw.validateAndRelay(makeCmd(), throwingExecute);
      expect(gw.getStatus().circuits.get("dev-001")?.state).toBe("open");

      gw.resetCircuit("dev-001");
      expect(gw.getStatus().circuits.get("dev-001")?.state).toBe("closed");

      // Commands should be allowed again
      const res = await gw.validateAndRelay(makeCmd(), noopExecute);
      expect(res.allowed).toBe(true);
      expect(res.executed).toBe(true);
    });

    it("circuit recovers via cooldown: half_open → closed after successes", async () => {
      vi.useFakeTimers();
      const gw = new SafetyGateway({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000, successThreshold: 2 },
      });

      // Trip it
      await gw.validateAndRelay(makeCmd(), throwingExecute);
      expect(gw.getStatus().circuits.get("dev-001")?.state).toBe("open");

      // Advance past cooldown
      vi.advanceTimersByTime(11_000);

      // First success in half_open
      const half1 = await gw.validateAndRelay(makeCmd(), noopExecute);
      expect(half1.allowed).toBe(true);
      expect(gw.getStatus().circuits.get("dev-001")?.state).toBe("half_open");

      // Second success closes the circuit
      await gw.validateAndRelay(makeCmd(), noopExecute);
      expect(gw.getStatus().circuits.get("dev-001")?.state).toBe("closed");
    });
  });

  // ── validateAndRelay — governor command class checks ──────────────────

  describe("validateAndRelay() — governor command class checks", () => {
    it("denies 'scoped' command without scopeId", async () => {
      const gw = new SafetyGateway();
      const cmd = makeCmd({ class: "scoped", scopeId: undefined });
      const res = await gw.validateAndRelay(cmd, noopExecute);
      expect(res.allowed).toBe(false);
      expect(res.executed).toBe(false);
    });

    it("denies 'privileged' command unconditionally", async () => {
      const gw = new SafetyGateway();
      const cmd = makeCmd({ class: "privileged" });
      const res = await gw.validateAndRelay(cmd, noopExecute);
      expect(res.allowed).toBe(false);
      expect(res.executed).toBe(false);
    });

    it("governor denial does NOT trip circuit breaker", async () => {
      const gw = new SafetyGateway({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, successThreshold: 2 },
      });
      // Privileged command — always denied by governor
      for (let i = 0; i < 5; i++) {
        await gw.validateAndRelay(makeCmd({ class: "privileged" }), noopExecute);
      }
      const state = gw.getStatus().circuits.get("dev-001");
      expect(state?.state ?? "closed").toBe("closed");
    });
  });

  // ── validateAndRelay — envelope checks ────────────────────────────────

  describe("validateAndRelay() — operational envelope", () => {
    it("denies command that exceeds velocity envelope", async () => {
      const gw = new SafetyGateway({ envelope: { maxVelocity: 100, maxCommandRate: 60, maxScopeDuration: 120 } });
      const cmd = makeCmd({ class: "safe", params: { velocity: 200 } });
      const res = await gw.validateAndRelay(cmd, noopExecute);

      expect(res.allowed).toBe(false);
      expect(res.verdict?.checks.find((c) => c.name === "velocity_envelope")?.passed).toBe(false);
    });

    it("allows command within velocity envelope", async () => {
      const gw = new SafetyGateway({ envelope: { maxVelocity: 500, maxCommandRate: 60, maxScopeDuration: 120 } });
      const cmd = makeCmd({ class: "safe", params: { velocity: 200 } });
      const res = await gw.validateAndRelay(cmd, noopExecute);
      expect(res.allowed).toBe(true);
    });
  });

  // ── updateHardwareState and getHardwareState ───────────────────────────

  describe("updateHardwareState() / getHardwareState()", () => {
    it("returns initial hardware state", () => {
      const gw = new SafetyGateway();
      const state = gw.getHardwareState();
      expect(state.isEStopEngaged).toBe(false);
      expect(state.isMaintenanceMode).toBe(false);
      expect(state.isLotoActive).toBe(false);
    });

    it("updateHardwareState() applies partial updates", () => {
      const gw = new SafetyGateway();
      gw.updateHardwareState({ isEStopEngaged: true });
      expect(gw.getHardwareState().isEStopEngaged).toBe(true);
      expect(gw.getHardwareState().isMaintenanceMode).toBe(false);
    });

    it("getHardwareState() returns a snapshot (not a live reference)", () => {
      const gw = new SafetyGateway();
      const snap1 = gw.getHardwareState();
      gw.updateHardwareState({ isEStopEngaged: true });
      // snap1 should NOT reflect the mutation
      expect(snap1.isEStopEngaged).toBe(false);
    });
  });

  // ── getStatus() ────────────────────────────────────────────────────────

  describe("getStatus()", () => {
    it("returns hardwareState and circuits", () => {
      const gw = new SafetyGateway();
      const status = gw.getStatus();
      expect(status).toHaveProperty("hardwareState");
      expect(status).toHaveProperty("circuits");
    });

    it("circuits is a Map", () => {
      const gw = new SafetyGateway();
      const { circuits } = gw.getStatus();
      expect(circuits).toBeInstanceOf(Map);
    });
  });

  // ── multi-device isolation ─────────────────────────────────────────────

  describe("multi-device isolation", () => {
    it("circuit trip on device A does not affect device B", async () => {
      vi.useFakeTimers();
      const gw = new SafetyGateway({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, successThreshold: 2 },
      });

      // Trip device A
      await gw.validateAndRelay(
        makeCmd({ deviceId: "dev-A" }),
        throwingExecute,
      );
      expect(gw.getStatus().circuits.get("dev-A")?.state).toBe("open");

      // Device B should still be allowed
      const res = await gw.validateAndRelay(
        makeCmd({ deviceId: "dev-B" }),
        noopExecute,
      );
      expect(res.allowed).toBe(true);
      expect(res.executed).toBe(true);
    });

    it("rate limiting is per-agent, not per-device", async () => {
      // Two different agents should each have their own rate window
      const gw = new SafetyGateway({ envelope: { maxCommandRate: 2, maxScopeDuration: 120 } });

      // Agent 1 exhausts its rate limit
      await gw.validateAndRelay(makeCmd({ agentDid: "did:key:agent-1" }), noopExecute);
      await gw.validateAndRelay(makeCmd({ agentDid: "did:key:agent-1" }), noopExecute);
      const denied = await gw.validateAndRelay(makeCmd({ agentDid: "did:key:agent-1" }), noopExecute);
      expect(denied.allowed).toBe(false);

      // Agent 2 should still pass (different rate window)
      const allowed = await gw.validateAndRelay(makeCmd({ agentDid: "did:key:agent-2" }), noopExecute);
      expect(allowed.allowed).toBe(true);
    });
  });

  // ── config acceptance ─────────────────────────────────────────────────

  describe("SafetyGatewayConfig", () => {
    it("accepts envelope config", () => {
      expect(() => new SafetyGateway({ envelope: { maxCommandRate: 10, maxScopeDuration: 30 } })).not.toThrow();
    });

    it("accepts circuitBreaker config", () => {
      expect(() => new SafetyGateway({ circuitBreaker: { failureThreshold: 5, cooldownMs: 5000, successThreshold: 1 } })).not.toThrow();
    });

    it("accepts initialHardwareState config", () => {
      expect(() => new SafetyGateway({ initialHardwareState: { isLotoActive: true } })).not.toThrow();
    });

    it("initSafetyGateway() passes config to the singleton", async () => {
      const gw = initSafetyGateway({ initialHardwareState: { isEStopEngaged: true } });
      const res = await gw.validateAndRelay(makeCmd(), noopExecute);
      expect(res.allowed).toBe(false);
    });
  });
});
