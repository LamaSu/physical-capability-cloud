import { describe, it, expect } from "vitest";
import {
  evaluatePolicy,
  applyPricingRules,
  sanitizeText,
  scanGcode,
  type PolicyContext,
} from "../policy-engine.js";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import type { OperatorPolicy, PricingRule } from "@pcc/spec";

// ── Helpers ────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    agentId: "agent-test-001",
    // Wednesday 10am LA time = 18:00 UTC (within default 09:00-17:00 LA operating hours)
    currentTime: new Date("2026-03-25T18:00:00Z"),
    rateCounts: { jobsThisHour: 0, jobsToday: 0, costToday: 0 },
    ...overrides,
  };
}

/** Default test policy: open 24/7 all days to avoid timezone issues in CI */
const TEST_POLICY: OperatorPolicy = {
  ...DEFAULT_OPERATOR_POLICY,
  operatingHours: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
};

function makePolicy(overrides: Partial<OperatorPolicy> = {}): OperatorPolicy {
  return { ...TEST_POLICY, ...overrides };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Policy Engine — evaluatePolicy", () => {
  describe("Emergency Stop", () => {
    it("blocks all jobs when emergency stop is active", () => {
      const result = evaluatePolicy(
        makePolicy({ emergencyStop: true }),
        makeCtx(),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.violations[0].rule).toBe("emergency_stop");
    });
  });

  describe("Blocked Agents", () => {
    it("blocks agents on the blocklist", () => {
      const result = evaluatePolicy(
        makePolicy({ blockedAgents: ["agent-test-001", "agent-bad"] }),
        makeCtx({ agentId: "agent-test-001" }),
      );
      expect(result.allowed).toBe(false);
      expect(result.violations[0].rule).toBe("blocked_agent");
    });

    it("allows agents not on the blocklist", () => {
      const result = evaluatePolicy(
        makePolicy({ blockedAgents: ["agent-bad"], approvalMode: "auto" }),
        makeCtx({ agentId: "agent-good" }),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("Reputation Check", () => {
    it("blocks agents below minimum reputation", () => {
      const result = evaluatePolicy(
        makePolicy({ minReputationScore: 500 }),
        makeCtx({ agentReputation: 200 }),
      );
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "min_reputation")).toBe(true);
    });

    it("allows agents above minimum reputation", () => {
      const result = evaluatePolicy(
        makePolicy({ minReputationScore: 500, approvalMode: "auto" }),
        makeCtx({ agentReputation: 700 }),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("Operating Hours", () => {
    it("blocks jobs on closed days (Sunday)", () => {
      const sunday = new Date("2026-03-22T14:00:00Z"); // Sunday
      const result = evaluatePolicy(
        makePolicy({
          operatingHours: {
            0: null, // Sunday: closed
            1: [{ start: "00:00", end: "23:59" }],
            2: [{ start: "00:00", end: "23:59" }],
            3: [{ start: "00:00", end: "23:59" }],
            4: [{ start: "00:00", end: "23:59" }],
            5: [{ start: "00:00", end: "23:59" }],
            6: [{ start: "00:00", end: "23:59" }],
          },
        }),
        makeCtx({ currentTime: sunday }),
      );
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "outside_operating_hours")).toBe(true);
    });

    it("blocks jobs outside operating hours", () => {
      const lateNight = new Date("2026-03-25T04:00:00Z"); // Wed 4am UTC
      const result = evaluatePolicy(
        makePolicy({
          operatingHours: {
            0: null, 1: null, // block Mon
            2: [{ start: "09:00", end: "10:00" }], // Tue only 9-10am
            3: [{ start: "09:00", end: "10:00" }], // Wed only 9-10am
            4: null, 5: null, 6: null,
          },
        }),
        makeCtx({ currentTime: lateNight }),
      );
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "outside_operating_hours")).toBe(true);
    });

    it("allows jobs during operating hours", () => {
      const midday = new Date("2026-03-25T14:00:00Z"); // Wed 2pm
      const result = evaluatePolicy(
        makePolicy({ approvalMode: "auto" }),
        makeCtx({ currentTime: midday }),
      );
      expect(result.allowed).toBe(true);
    });

    it("allows all day when hours are empty array", () => {
      const result = evaluatePolicy(
        makePolicy({
          operatingHours: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
          approvalMode: "auto",
        }),
        makeCtx({ currentTime: new Date("2026-03-22T03:00:00Z") }), // Sunday 3am
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("Maintenance Windows", () => {
    it("blocks jobs during maintenance", () => {
      const result = evaluatePolicy(
        makePolicy({
          maintenanceWindows: [{
            start: "2026-03-25T10:00:00Z",
            end: "2026-03-25T18:00:00Z",
            reason: "Nozzle replacement",
          }],
        }),
        makeCtx({ currentTime: new Date("2026-03-25T14:00:00Z") }),
      );
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "maintenance_window")).toBe(true);
    });

    it("allows jobs outside maintenance windows", () => {
      const result = evaluatePolicy(
        makePolicy({
          maintenanceWindows: [{
            start: "2026-03-25T10:00:00Z",
            end: "2026-03-25T12:00:00Z",
            reason: "Quick fix",
          }],
          approvalMode: "auto",
        }),
        makeCtx({ currentTime: new Date("2026-03-25T14:00:00Z") }),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("Rate Limits", () => {
    it("blocks when hourly rate limit exceeded", () => {
      const result = evaluatePolicy(
        makePolicy({ maxJobsPerHour: 3 }),
        makeCtx({ rateCounts: { jobsThisHour: 3, jobsToday: 3, costToday: 0 } }),
      );
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "rate_limit_hour")).toBe(true);
    });

    it("blocks when daily rate limit exceeded", () => {
      const result = evaluatePolicy(
        makePolicy({ maxJobsPerDay: 10 }),
        makeCtx({ rateCounts: { jobsThisHour: 1, jobsToday: 10, costToday: 0 } }),
      );
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "rate_limit_day")).toBe(true);
    });

    it("blocks when daily cost limit would be exceeded", () => {
      const result = evaluatePolicy(
        makePolicy({ maxCostPerDay: "50.00" }),
        makeCtx({
          estimatedCost: "30.00",
          rateCounts: { jobsThisHour: 1, jobsToday: 2, costToday: 25 },
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "rate_limit_cost")).toBe(true);
    });

    it("allows when under all rate limits", () => {
      const result = evaluatePolicy(
        makePolicy({ approvalMode: "auto", maxJobsPerHour: 5 }),
        makeCtx({ rateCounts: { jobsThisHour: 2, jobsToday: 5, costToday: 30 } }),
      );
      expect(result.allowed).toBe(true);
    });

    it("skips rate limit check when limit is 0 (unlimited)", () => {
      const result = evaluatePolicy(
        makePolicy({ maxJobsPerHour: 0, maxJobsPerDay: 0, maxCostPerDay: "0", approvalMode: "auto" }),
        makeCtx({ rateCounts: { jobsThisHour: 999, jobsToday: 999, costToday: 99999 } }),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("Material Allowlist", () => {
    it("blocks disallowed materials", () => {
      const result = evaluatePolicy(
        makePolicy({ allowedMaterials: ["PLA", "PETG"] }),
        makeCtx({ material: "ABS" }),
      );
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "material_not_allowed")).toBe(true);
    });

    it("allows materials in the allowlist (case-insensitive)", () => {
      const result = evaluatePolicy(
        makePolicy({ allowedMaterials: ["PLA", "PETG"], approvalMode: "auto" }),
        makeCtx({ material: "pla" }),
      );
      expect(result.allowed).toBe(true);
    });

    it("allows all materials when allowlist is empty", () => {
      const result = evaluatePolicy(
        makePolicy({ allowedMaterials: [], approvalMode: "auto" }),
        makeCtx({ material: "anything" }),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("Duration Limit", () => {
    it("blocks jobs exceeding max duration", () => {
      const result = evaluatePolicy(
        makePolicy({ maxDurationMs: 60 * 60_000 }), // 1 hour
        makeCtx({ estimatedDurationMs: 2 * 60 * 60_000 }), // 2 hours
      );
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "duration_exceeded")).toBe(true);
    });
  });

  describe("Escrow Requirement", () => {
    it("blocks when escrow required but not funded", () => {
      const result = evaluatePolicy(
        makePolicy({ requireEscrow: true }),
        makeCtx({ escrowFunded: false }),
      );
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "escrow_required")).toBe(true);
    });

    it("allows when escrow funded", () => {
      const result = evaluatePolicy(
        makePolicy({ requireEscrow: true, approvalMode: "auto" }),
        makeCtx({ escrowFunded: true }),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("Approval Modes", () => {
    it("auto mode: allows all agents", () => {
      const result = evaluatePolicy(
        makePolicy({ approvalMode: "auto" }),
        makeCtx(),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it("manual mode: requires approval for all", () => {
      const result = evaluatePolicy(
        makePolicy({ approvalMode: "manual" }),
        makeCtx(),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });

    it("policy mode: auto-approves trusted agents", () => {
      const result = evaluatePolicy(
        makePolicy({
          approvalMode: "policy",
          trustedAgents: ["agent-test-001"],
        }),
        makeCtx({ agentId: "agent-test-001" }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it("policy mode: requires approval for untrusted agents", () => {
      const result = evaluatePolicy(
        makePolicy({
          approvalMode: "policy",
          trustedAgents: ["agent-vip"],
        }),
        makeCtx({ agentId: "agent-unknown" }),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });
  });

  describe("Pricing Rules", () => {
    it("applies volume discount pricing rules", () => {
      const result = evaluatePolicy(
        makePolicy({ approvalMode: "auto" }),
        makeCtx({ quantity: 15 }),
      );
      expect(result.appliedPricingRules).toBeDefined();
      expect(result.appliedPricingRules!.some((r) => r.type === "volume_discount")).toBe(true);
    });

    it("applies loyalty discount for repeat agents", () => {
      const result = evaluatePolicy(
        makePolicy({ approvalMode: "auto" }),
        makeCtx({ agentCompletedJobs: 10 }),
      );
      expect(result.appliedPricingRules!.some((r) => r.type === "loyalty_discount")).toBe(true);
    });

    it("applies rush surcharge for urgent jobs", () => {
      const result = evaluatePolicy(
        makePolicy({ approvalMode: "auto" }),
        makeCtx({ leadTimeMs: 10 * 60_000 }), // 10 min lead time
      );
      expect(result.appliedPricingRules!.some((r) => r.type === "rush_surcharge")).toBe(true);
    });

    it("does not apply disabled rules", () => {
      const policy = makePolicy({
        approvalMode: "auto",
        pricingRules: [{
          id: "disabled-rule",
          type: "volume_discount",
          label: "Disabled",
          enabled: false,
          condition: { minQuantity: 1 },
          impact: { mode: "percent", value: "-50" },
        }],
      });
      const result = evaluatePolicy(policy, makeCtx({ quantity: 100 }));
      expect(result.appliedPricingRules).toHaveLength(0);
    });
  });
});

describe("applyPricingRules", () => {
  it("applies percent discount", () => {
    const rules: PricingRule[] = [{
      id: "test",
      type: "volume_discount",
      label: "10% off",
      enabled: true,
      condition: {},
      impact: { mode: "percent", value: "-10" },
    }];
    const { adjustedPrice, adjustments } = applyPricingRules(100, rules);
    expect(adjustedPrice).toBe(90);
    expect(adjustments[0].amount).toBe(-10);
  });

  it("applies flat surcharge", () => {
    const rules: PricingRule[] = [{
      id: "test",
      type: "rush_surcharge",
      label: "+$5",
      enabled: true,
      condition: {},
      impact: { mode: "flat", value: "5" },
    }];
    const { adjustedPrice } = applyPricingRules(100, rules);
    expect(adjustedPrice).toBe(105);
  });

  it("stacks multiple rules", () => {
    const rules: PricingRule[] = [
      { id: "a", type: "volume_discount", label: "10% off", enabled: true, condition: {}, impact: { mode: "percent", value: "-10" } },
      { id: "b", type: "rush_surcharge", label: "+25%", enabled: true, condition: {}, impact: { mode: "percent", value: "25" } },
    ];
    const { adjustedPrice } = applyPricingRules(100, rules);
    expect(adjustedPrice).toBe(115); // -10 + 25 = +15
  });

  it("floors at zero", () => {
    const rules: PricingRule[] = [{
      id: "test",
      type: "volume_discount",
      label: "200% off",
      enabled: true,
      condition: {},
      impact: { mode: "percent", value: "-200" },
    }];
    const { adjustedPrice } = applyPricingRules(100, rules);
    expect(adjustedPrice).toBe(0);
  });
});

describe("sanitizeText", () => {
  it("strips control characters", () => {
    expect(sanitizeText("hello\x00world\x07test")).toBe("helloworldtest");
  });

  it("preserves newlines and tabs", () => {
    expect(sanitizeText("hello\nworld\ttab")).toBe("hello\nworld\ttab");
  });

  it("limits length", () => {
    expect(sanitizeText("a".repeat(2000), 100)).toHaveLength(100);
  });

  it("handles empty string", () => {
    expect(sanitizeText("")).toBe("");
  });
});

describe("scanGcode", () => {
  it("detects dangerous commands", () => {
    const violations = scanGcode("G28\nM112\nG1 X10", 300);
    expect(violations.some((v) => v.rule === "gcode_dangerous_command")).toBe(true);
  });

  it("detects G28 homing as dangerous (added in 351433c — can crash extruder mid-print)", () => {
    const violations = scanGcode("G1 X10\nG28\nG1 X20", 300);
    const g28Violation = violations.find(
      (v) => v.rule === "gcode_dangerous_command" && /G28/.test(v.message),
    );
    expect(g28Violation).toBeDefined();
    expect(g28Violation!.severity).toBe("block");
  });

  it("does not flag G28.1 / G28.2 variants (not a bare auto-home)", () => {
    const violations = scanGcode("G28.1\nG1 X10 Y20 Z0.2\nM104 S200", 260);
    const dangerous = violations.filter((v) => v.rule === "gcode_dangerous_command");
    expect(dangerous).toHaveLength(0);
  });

  it("detects temperature violations", () => {
    const violations = scanGcode("M104 S300\nG1 X10", 260);
    expect(violations.some((v) => v.rule === "gcode_temperature_exceeded")).toBe(true);
  });

  it("allows safe gcode (no homing, no e-stop, temps within cap)", () => {
    // NOTE: G28 was removed from this fixture after 351433c added it to the
    // dangerous list. A pure print sequence (move, extrude, heat) is safe.
    const violations = scanGcode("G1 X10 Y20 Z0.2\nM104 S200\nM109 S200", 260);
    expect(violations).toHaveLength(0);
  });

  it("allows temps when maxTemp is 0 (unlimited)", () => {
    const violations = scanGcode("M104 S999", 0);
    expect(violations.filter((v) => v.rule === "gcode_temperature_exceeded")).toHaveLength(0);
  });
});
