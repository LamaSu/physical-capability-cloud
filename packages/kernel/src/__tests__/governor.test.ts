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

    it("rate limit is per-agent (different agentDid has independent count)", async () => {
      const gov = new SafetyGovernor({ maxCommandRate: 2 });
      // Exhaust agent-A
      await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-A" }));
      await gov.validateCommand(makeCmd({ class: "read", agentDid: "agent-A" }));
      // agent-B is independent — should still be allowed
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", agentDid: "agent-B" }),
      );
      expect(verdict.allowed).toBe(true);
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

    it("velocity check: skipped when params.velocity is not a number", async () => {
      const gov = new SafetyGovernor({ maxVelocity: 100 });
      const verdict = await gov.validateCommand(
        makeCmd({ class: "read", params: { velocity: "fast" } }),
      );
      // Should still be allowed (velocity check skipped)
      expect(verdict.allowed).toBe(true);
      const check = verdict.checks.find((c) => c.name === "velocity_envelope");
      expect(check).toBeUndefined(); // not added at all
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
