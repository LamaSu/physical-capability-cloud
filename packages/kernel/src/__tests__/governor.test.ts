import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SafetyGovernor, type PhysicalCommand } from "../safety/governor.js";

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

// ── Tests ─────────────────────────────────────────────────────────────────

describe("SafetyGovernor", () => {
  beforeEach(() => {
    cmdCounter = 0;
  });

  describe("constructor", () => {
    it("uses DEFAULT_ENVELOPE when no envelope provided", async () => {
      const gov = new SafetyGovernor();
      // maxVelocity=500 is default — 499 should pass
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { velocity: 499 } }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it("merges partial envelope with defaults", async () => {
      const gov = new SafetyGovernor({ maxVelocity: 100 });
      // velocity=101 should fail because override brings it to 100
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { velocity: 101 } }),
      );
      expect(verdict.allowed).toBe(false);
    });

    it("initializes with e-stop NOT engaged by default", async () => {
      const gov = new SafetyGovernor();
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      expect(verdict.allowed).toBe(true);
    });

    it("accepts initialHardwareState overrides", async () => {
      const gov = new SafetyGovernor(undefined, { isEStopEngaged: true });
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      expect(verdict.allowed).toBe(false);
    });
  });

  describe("validateCommand() — hardware interlocks (highest priority)", () => {
    it("e_stop: denies ALL command classes when isEStopEngaged=true", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isEStopEngaged: true });

      for (const cls of ["read", "safe", "scoped", "privileged"] as const) {
        const verdict = await gov.validateCommand(
          makeCmd({ class: cls, scopeId: "scope-1" }),
        );
        expect(verdict.allowed).toBe(false);
      }
    });

    it("e_stop: denies read commands when e-stop engaged", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isEStopEngaged: true });
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      expect(verdict.allowed).toBe(false);
    });

    it("e_stop: denies scoped commands when e-stop engaged", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isEStopEngaged: true });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "scoped", scopeId: "sc-1" }),
      );
      expect(verdict.allowed).toBe(false);
    });

    it("maintenance_mode: denies when isMaintenanceMode=true", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isMaintenanceMode: true });
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      expect(verdict.allowed).toBe(false);
    });

    it("loto_active: denies when isLotoActive=true", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isLotoActive: true });
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      expect(verdict.allowed).toBe(false);
    });

    it("hardware interlock check appears first in checks array", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isEStopEngaged: true });
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      expect(verdict.checks[0].name).toBe("e_stop");
    });

    it("allowed=false when any hardware interlock fails", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isLotoActive: true });
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      expect(verdict.allowed).toBe(false);
    });
  });

  describe("validateCommand() — command class check", () => {
    it("class=read: allowed=true always", async () => {
      const gov = new SafetyGovernor();
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      expect(verdict.allowed).toBe(true);
    });

    it("class=safe: allowed=true", async () => {
      const gov = new SafetyGovernor();
      const verdict = await gov.validateCommand(makeCmd({ class: "safe" }));
      expect(verdict.allowed).toBe(true);
    });

    it("class=scoped with scopeId: allowed=true", async () => {
      const gov = new SafetyGovernor();
      const verdict = await gov.validateCommand(
        makeCmd({ class: "scoped", scopeId: "scope-abc" }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it("class=scoped without scopeId: command_class check fails", async () => {
      const gov = new SafetyGovernor();
      const verdict = await gov.validateCommand(
        makeCmd({ class: "scoped", scopeId: undefined }),
      );
      expect(verdict.allowed).toBe(false);
      const classCheck = verdict.checks.find((c) => c.name === "command_class");
      expect(classCheck?.passed).toBe(false);
    });

    it("class=privileged: always denied regardless of scopeId", async () => {
      const gov = new SafetyGovernor();
      const verdict = await gov.validateCommand(
        makeCmd({ class: "privileged", scopeId: "scope-x" }),
      );
      expect(verdict.allowed).toBe(false);
      const classCheck = verdict.checks.find((c) => c.name === "command_class");
      expect(classCheck?.passed).toBe(false);
    });
  });

  describe("validateCommand() — rate limiting", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("allows commands below maxCommandRate per minute", async () => {
      const gov = new SafetyGovernor({ maxCommandRate: 5 });
      // Send 4 commands — should all pass
      for (let i = 0; i < 4; i++) {
        const verdict = await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-A" }));
        expect(verdict.allowed).toBe(true);
      }
    });

    it("denies when agent exceeds maxCommandRate in 1-minute window", async () => {
      const gov = new SafetyGovernor({ maxCommandRate: 3 });
      // Send 3 successful commands (fills the limit)
      for (let i = 0; i < 3; i++) {
        await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-B" }));
      }
      // 4th should be denied
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", agentDid: "agent-B" }),
      );
      expect(verdict.allowed).toBe(false);
      const rateCheck = verdict.checks.find((c) => c.name === "rate_limit");
      expect(rateCheck?.passed).toBe(false);
    });

    it("rate limit is per device (a different agentDid on the same device shares the count; N86 G6)", async () => {
      const gov = new SafetyGovernor({ maxCommandRate: 2 });
      // Exhaust dev-001 from agent-A
      await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-A" }));
      await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-A" }));
      // agent-B on the same device gets no second budget
      const sameDevice = await gov.validateCommand(
        makeCmd({ class: "read", agentDid: "agent-B" }),
      );
      expect(sameDevice.allowed).toBe(false);
      // another device has its own count
      const otherDevice = await gov.validateCommand(
        makeCmd({ class: "read", agentDid: "agent-A", deviceId: "dev-002" }),
      );
      expect(otherDevice.allowed).toBe(true);
    });

    it("rate limit window is 60 seconds (commands older than 60s don't count)", async () => {
      const gov = new SafetyGovernor({ maxCommandRate: 2 });
      // Send 2 commands
      await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-C" }));
      await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-C" }));
      // Advance past window
      vi.advanceTimersByTime(60_001);
      // Now should be allowed again
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", agentDid: "agent-C" }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it("denied commands are NOT recorded to commandLog", async () => {
      const gov = new SafetyGovernor({ maxCommandRate: 1 });
      // First: allowed (recorded)
      await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-D" }));
      // Second: denied (NOT recorded)
      await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-D" }));
      // Advance just past window
      vi.advanceTimersByTime(60_001);
      // Only 1 entry should have been recorded, so after window it's clear
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", agentDid: "agent-D" }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it("allowed commands ARE recorded to commandLog", async () => {
      const gov = new SafetyGovernor({ maxCommandRate: 2 });
      await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-E" }));
      await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-E" }));
      // 3rd within window → denied (proves first 2 were recorded)
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", agentDid: "agent-E" }),
      );
      expect(verdict.allowed).toBe(false);
    });
  });

  describe("validateCommand() — envelope validation", () => {
    it("velocity check: passes when params.velocity <= maxVelocity", async () => {
      const gov = new SafetyGovernor({ maxVelocity: 200 });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { velocity: 200 } }),
      );
      expect(verdict.allowed).toBe(true);
      const check = verdict.checks.find((c) => c.name === "velocity_envelope");
      expect(check?.passed).toBe(true);
    });

    it("velocity check: fails when params.velocity > maxVelocity", async () => {
      const gov = new SafetyGovernor({ maxVelocity: 100 });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { velocity: 101 } }),
      );
      expect(verdict.allowed).toBe(false);
      const check = verdict.checks.find((c) => c.name === "velocity_envelope");
      expect(check?.passed).toBe(false);
    });

    it("velocity check: refused when params.velocity is present but not a number (N86 G4)", async () => {
      const gov = new SafetyGovernor({ maxVelocity: 100 });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { velocity: "fast" } }),
      );
      // Never skipped: an unchecked value would reach the device
      expect(verdict.allowed).toBe(false);
      const check = verdict.checks.find((c) => c.name === "velocity_envelope");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toBe('Velocity must be a finite number (got "fast")');
    });

    it("velocity check: not added when the command does not set velocity", async () => {
      const gov = new SafetyGovernor({ maxVelocity: 100 });
      const verdict = await gov.validateCommand(makeCmd({ class: "read", params: {} }));
      expect(verdict.allowed).toBe(true);
      expect(verdict.checks.find((c) => c.name === "velocity_envelope")).toBeUndefined();
    });

    it("temperature check: passes when params.temperature <= maxTemperature", async () => {
      const gov = new SafetyGovernor({ maxTemperature: 250 });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { temperature: 250 } }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it("temperature check: fails when params.temperature > maxTemperature", async () => {
      const gov = new SafetyGovernor({ maxTemperature: 200 });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { temperature: 201 } }),
      );
      expect(verdict.allowed).toBe(false);
      const check = verdict.checks.find((c) => c.name === "temperature_envelope");
      expect(check?.passed).toBe(false);
    });

    it("force check: passes when params.force <= maxForce", async () => {
      const gov = new SafetyGovernor({ maxForce: 50 });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { force: 50 } }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it("force check: fails when params.force > maxForce", async () => {
      const gov = new SafetyGovernor({ maxForce: 50 });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { force: 51 } }),
      );
      expect(verdict.allowed).toBe(false);
      const check = verdict.checks.find((c) => c.name === "force_envelope");
      expect(check?.passed).toBe(false);
    });

    it("multiple envelope violations: all appear in checks[]", async () => {
      const gov = new SafetyGovernor({ maxVelocity: 10, maxTemperature: 10, maxForce: 10 });
      const verdict = await gov.validateCommand(
        makeCmd({
          class: "read",
          params: { velocity: 100, temperature: 100, force: 100 },
        }),
      );
      expect(verdict.allowed).toBe(false);
      const failingChecks = verdict.checks.filter(
        (c) =>
          c.name === "velocity_envelope" ||
          c.name === "temperature_envelope" ||
          c.name === "force_envelope",
      );
      expect(failingChecks.length).toBe(3);
      expect(failingChecks.every((c) => !c.passed)).toBe(true);
    });
  });

  describe("validateCommand() — forbidden patterns", () => {
    it("passes when no forbiddenPatterns configured", async () => {
      const gov = new SafetyGovernor({ forbiddenPatterns: [] });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { dangerous: "rm -rf /" } }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it("fails when params JSON matches a forbidden pattern", async () => {
      const gov = new SafetyGovernor({
        forbiddenPatterns: [/shell_exec/],
      });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { cmd: "shell_exec" } }),
      );
      expect(verdict.allowed).toBe(false);
      const check = verdict.checks.find((c) => c.name === "forbidden_patterns");
      expect(check?.passed).toBe(false);
    });

    it("passes when params JSON does not match any forbidden pattern", async () => {
      const gov = new SafetyGovernor({
        forbiddenPatterns: [/shell_exec/],
      });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { cmd: "get_status" } }),
      );
      expect(verdict.allowed).toBe(true);
    });

    it("detail message includes the pattern source", async () => {
      const gov = new SafetyGovernor({
        forbiddenPatterns: [/DANGER/],
      });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { x: "DANGER" } }),
      );
      const check = verdict.checks.find((c) => c.name === "forbidden_patterns");
      expect(check?.detail).toContain("DANGER");
    });
  });

  describe("validateCommand() — verdict shape", () => {
    it("GovernorVerdict has: allowed, reason, checks[], timestamp", async () => {
      const gov = new SafetyGovernor();
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      expect(typeof verdict.allowed).toBe("boolean");
      expect(Array.isArray(verdict.checks)).toBe(true);
      expect(typeof verdict.timestamp).toBe("number");
    });

    it("reason is undefined when allowed=true", async () => {
      const gov = new SafetyGovernor();
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toBeUndefined();
    });

    it("reason is the first failing check's detail when allowed=false", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isEStopEngaged: true });
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      expect(verdict.allowed).toBe(false);
      expect(typeof verdict.reason).toBe("string");
      expect(verdict.reason!.length).toBeGreaterThan(0);
    });

    it("timestamp is Date.now() (within 100ms)", async () => {
      const gov = new SafetyGovernor();
      const before = Date.now();
      const verdict = await gov.validateCommand(makeCmd({ class: "read" }));
      const after = Date.now();
      expect(verdict.timestamp).toBeGreaterThanOrEqual(before);
      expect(verdict.timestamp).toBeLessThanOrEqual(after + 100);
    });

    it("checks array contains all performed safety check names", async () => {
      const gov = new SafetyGovernor({ maxVelocity: 100 });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { velocity: 50 } }),
      );
      const names = verdict.checks.map((c) => c.name);
      expect(names).toContain("e_stop");
      expect(names).toContain("maintenance_mode");
      expect(names).toContain("loto_active");
      expect(names).toContain("command_class");
      expect(names).toContain("rate_limit");
      expect(names).toContain("velocity_envelope");
      expect(names).toContain("forbidden_patterns");
    });
  });

  describe("updateHardwareState()", () => {
    it("updates isEStopEngaged", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isEStopEngaged: true });
      const state = gov.getHardwareState();
      expect(state.isEStopEngaged).toBe(true);
    });

    it("updates isMaintenanceMode", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isMaintenanceMode: true });
      expect(gov.getHardwareState().isMaintenanceMode).toBe(true);
    });

    it("updates isLotoActive", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isLotoActive: true });
      expect(gov.getHardwareState().isLotoActive).toBe(true);
    });

    it("partial update preserves other fields", async () => {
      const gov = new SafetyGovernor();
      gov.updateHardwareState({ isEStopEngaged: true });
      gov.updateHardwareState({ isMaintenanceMode: true });
      const state = gov.getHardwareState();
      expect(state.isEStopEngaged).toBe(true);
      expect(state.isMaintenanceMode).toBe(true);
      expect(state.isLotoActive).toBe(false);
    });
  });

  describe("getHardwareState()", () => {
    it("returns a copy of the hardware state (not a reference)", () => {
      const gov = new SafetyGovernor();
      const state1 = gov.getHardwareState();
      const state2 = gov.getHardwareState();
      expect(state1).not.toBe(state2); // different object references
    });

    it("mutating the returned object does not affect internal state", () => {
      const gov = new SafetyGovernor();
      const state = gov.getHardwareState() as any;
      state.isEStopEngaged = true;
      // Internal state should be unchanged
      expect(gov.getHardwareState().isEStopEngaged).toBe(false);
    });
  });
});

// ── N86 (Gate A, P0 physical safety): envelope gaps reproduced on master ac86a404 ──
// Repro: /mnt/sparkbulk/tmp/sensors/r8/governor-repro-2.mts. Each test failed on master before the fix.

describe("SafetyGovernor: N86 envelope gaps", () => {
  const move = (params: Record<string, unknown>, overrides: Partial<PhysicalCommand> = {}) =>
    makeCmd({ class: "safe", type: "move", params, ...overrides });

  it("G1: a limit of 0 is a bound, not 'no limit'", async () => {
    expect((await new SafetyGovernor({ maxVelocity: 0 }).validateCommand(move({ velocity: 1000 }))).allowed).toBe(false);
    expect((await new SafetyGovernor({ maxVelocity: 0 }).validateCommand(move({ velocity: 0 }))).allowed).toBe(true);
    expect((await new SafetyGovernor({ maxTemperature: 0 }).validateCommand(move({ temperature: 900 }))).allowed).toBe(false);
    expect((await new SafetyGovernor({ maxForce: 0 }).validateCommand(move({ force: 5 }))).allowed).toBe(false);
  });

  it("G1: an explicit undefined does not remove a limit; the default still applies", async () => {
    const gov = new SafetyGovernor({ maxVelocity: undefined, maxTemperature: undefined, maxForce: undefined });
    const fast = await gov.validateCommand(move({ velocity: 600 }));
    expect(fast.allowed).toBe(false);
    expect(fast.reason).toBe("Velocity 600 exceeds max 500");
    expect((await gov.validateCommand(move({ velocity: 100 }))).allowed).toBe(true);
    expect((await gov.validateCommand(move({ temperature: 900 }))).allowed).toBe(false);
    expect((await gov.validateCommand(move({ force: 900 }))).allowed).toBe(false);
  });

  it("G4: a checked parameter that is present but not a finite number is refused", async () => {
    const gov = new SafetyGovernor({ maxVelocity: 100, maxTemperature: 60, maxForce: 10 });
    for (const params of [{ temperature: "900" }, { velocity: { value: 1000 } }, { force: null }, { velocity: Number.NaN }, { temperature: [900] }]) {
      const verdict = await gov.validateCommand(move(params));
      expect(verdict.allowed, JSON.stringify(params)).toBe(false);
      expect(verdict.reason, JSON.stringify(params)).toMatch(/must be a finite number/);
    }
    expect((await gov.validateCommand(move({ other: "x" }))).allowed).toBe(true);
  });

  it("G5: velocity and force are bounded by magnitude; temperature stays signed", async () => {
    const gov = new SafetyGovernor({ maxVelocity: 500, maxForce: 100, maxTemperature: 300 });
    expect((await gov.validateCommand(move({ velocity: -1000 }))).allowed).toBe(false);
    expect((await gov.validateCommand(move({ velocity: -400 }))).allowed).toBe(true);
    expect((await gov.validateCommand(move({ force: -1000 }))).allowed).toBe(false);
    expect((await gov.validateCommand(move({ temperature: -20 }))).allowed).toBe(true);
  });

  it("G6: the rate limit is per device, whichever agent sends", async () => {
    const gov = new SafetyGovernor({ maxCommandRate: 1 });
    expect((await gov.validateCommand(move({}, { agentDid: "did:a", deviceId: "dev-1" }))).allowed).toBe(true);
    const second = await gov.validateCommand(move({}, { agentDid: "did:b", deviceId: "dev-1" }));
    expect(second.allowed).toBe(false);
    expect(second.checks.find((c) => c.name === "rate_limit")?.passed).toBe(false);
    expect((await gov.validateCommand(move({}, { agentDid: "did:a", deviceId: "dev-2" }))).allowed).toBe(true);
  });

  it("G7: a forbidden pattern with the g or y flag refuses every matching command", async () => {
    for (const pattern of [/"mode":"unsafe"/g, /"mode":"unsafe"/y, /"mode":"unsafe"/gi]) {
      const gov = new SafetyGovernor({ forbiddenPatterns: [pattern], maxCommandRate: 100 });
      const verdicts: boolean[] = [];
      for (let i = 0; i < 4; i++) verdicts.push((await gov.validateCommand(move({ mode: "unsafe" }))).allowed);
      expect(verdicts, String(pattern)).toEqual([false, false, false, false]);
    }
  });

  it("G8: a declared allowedGcodes list is refused at construction, since nothing here enforces it", () => {
    expect(() => new SafetyGovernor({ allowedGcodes: ["G28"] })).toThrow(/allowedGcodes is not enforced/);
    // Round 2 (astra pack 113): an empty list is refused too; see the round-2 block.
    expect(() => new SafetyGovernor({ allowedGcodes: undefined })).not.toThrow();
  });
});

// ── N86 round 2 (astra pack 113, gpt-5.6-sol): what the checks read is what the executor reads ──
describe("SafetyGovernor: N86 round 2, params are plain data", () => {
  const move = (params: Record<string, unknown>) => makeCmd({ class: "safe", type: "move", params });

  it("G4: a bounded parameter present with the value undefined is refused, not skipped", async () => {
    const verdict = await new SafetyGovernor({ maxVelocity: 100 }).validateCommand(move({ velocity: undefined }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/Velocity must be a finite number \(got undefined\)/);
  });

  it("a getter cannot show one value to the checks and another to the executor", async () => {
    let reads = 0;
    const params: Record<string, unknown> = {};
    Object.defineProperty(params, "velocity", { enumerable: true, get: () => (++reads === 1 ? 1 : 1000) });
    const verdict = await new SafetyGovernor({ maxVelocity: 100 }).validateCommand(move(params));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/getter/);
  });

  it("a getter on an unbounded parameter cannot slip past a forbidden pattern", async () => {
    let reads = 0;
    const params: Record<string, unknown> = {};
    Object.defineProperty(params, "mode", { enumerable: true, get: () => (++reads === 1 ? "safe" : "unsafe") });
    const verdict = await new SafetyGovernor({ forbiddenPatterns: [/unsafe/] }).validateCommand(move(params));
    expect(verdict.allowed).toBe(false);
  });

  it("a bigint anywhere in params is a structured denial, not a thrown error", async () => {
    const gov = new SafetyGovernor({ forbiddenPatterns: [/x/] });
    const verdict = await gov.validateCommand(move({ count: 10n }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.checks.find((c) => c.name === "params_plain_data")?.passed).toBe(false);
  });

  it("G8: a declared allowedGcodes is refused even when empty (an empty list must not read as deny-all)", () => {
    expect(() => new SafetyGovernor({ allowedGcodes: [] })).toThrow(/allowedGcodes is not enforced/);
  });

  it("a bounded value inherited from a polluted prototype is refused, never read through inheritance", async () => {
    Object.defineProperty(Object.prototype, "velocity", { value: 50, configurable: true, writable: true, enumerable: false });
    try {
      const verdict = await new SafetyGovernor({ maxVelocity: 100 }).validateCommand(move({}));
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/inherited/);
    } finally {
      delete (Object.prototype as Record<string, unknown>).velocity;
    }
  });

  it("plain JSON params still pass (nested objects, arrays, null)", async () => {
    const verdict = await new SafetyGovernor().validateCommand(move({ velocity: 10, path: [{ x: 1, y: 2 }], note: null, tool: { id: "t1" } }));
    expect(verdict.allowed).toBe(true);
  });
});
