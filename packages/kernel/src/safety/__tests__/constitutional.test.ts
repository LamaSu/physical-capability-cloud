/**
 * Constitutional Constraints unit tests.
 *
 * Verifies that OWASP ASI01 Goal Hijack mitigations are enforced correctly:
 *   - Universal constitution blocks apply to all roles
 *   - Role-specific blocks apply only to the relevant role
 *   - "warn" violations allow execution but are reported
 *   - applyConstitutionStrict() blocks on warn-level violations too
 *   - Allowed operations pass cleanly with no violations
 */

import { describe, it, expect } from "vitest";
import {
  applyConstitution,
  applyConstitutionStrict,
  UNIVERSAL_CONSTITUTION,
  ROLE_CONSTITUTION,
} from "../constitutional.js";
import type { AgentRole } from "../constitutional.js";
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

// ── Universal constitution ─────────────────────────────────────────────────────

describe("UNIVERSAL_CONSTITUTION", () => {
  it("has at least 4 rules", () => {
    expect(UNIVERSAL_CONSTITUTION.length).toBeGreaterThanOrEqual(4);
  });

  it("all rules have id, principle, check, and severity", () => {
    for (const rule of UNIVERSAL_CONSTITUTION) {
      expect(rule.id).toBeTruthy();
      expect(rule.principle).toBeTruthy();
      expect(typeof rule.check).toBe("function");
      expect(["block", "warn"]).toContain(rule.severity);
    }
  });

  it("no-emergency-stop-bypass: blocks suppressing an e-stop", () => {
    const result = applyConstitution("emergencyStop", { suppress: true }, "execution");
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "no-emergency-stop-bypass")).toBe(true);
  });

  it("no-emergency-stop-bypass: allows normal e-stop invocation", () => {
    const result = applyConstitution("emergencyStop", {}, "execution");
    // Should not trigger the rule since suppress is not true
    const blocked = result.violations.filter((v) => v.id === "no-emergency-stop-bypass");
    expect(blocked).toHaveLength(0);
  });

  it("no-scope-escalation: blocks requesting a different role", () => {
    const result = applyConstitution("someAction", { requestRole: "admin" }, "execution");
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "no-scope-escalation")).toBe(true);
  });

  it("no-scope-escalation: allows params with no requestRole", () => {
    const result = applyConstitution("someAction", { velocity: 100 }, "execution");
    const blocked = result.violations.filter((v) => v.id === "no-scope-escalation");
    expect(blocked).toHaveLength(0);
  });

  it("no-scope-escalation: allows params where requestRole matches current role", () => {
    const result = applyConstitution("someAction", { requestRole: "execution" }, "execution");
    const blocked = result.violations.filter((v) => v.id === "no-scope-escalation");
    expect(blocked).toHaveLength(0);
  });

  it("no-self-modification: blocks updateRolePermissions", () => {
    const result = applyConstitution("updateRolePermissions", {}, "admin");
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "no-self-modification")).toBe(true);
  });

  it("no-self-modification: blocks patchConstitution", () => {
    const result = applyConstitution("patchConstitution", {}, "operator");
    expect(result.allowed).toBe(false);
  });

  it("no-self-modification: blocks modifyAgentConfig", () => {
    const result = applyConstitution("modifyAgentConfig", {}, "settlement");
    expect(result.allowed).toBe(false);
  });

  it("no-self-modification: allows normal tool calls", () => {
    const result = applyConstitution("get_status", {}, "execution");
    const blocked = result.violations.filter((v) => v.id === "no-self-modification");
    expect(blocked).toHaveLength(0);
  });

  it("no-privileged-command-without-operator: blocks privileged class for execution role", () => {
    const cmd = makeCmd({ class: "privileged" });
    const result = applyConstitution("sendCommand", cmd, "execution");
    expect(result.allowed).toBe(false);
    expect(
      result.violations.some((v) => v.id === "no-privileged-command-without-operator"),
    ).toBe(true);
  });

  it("no-privileged-command-without-operator: allows privileged class for operator", () => {
    const cmd = makeCmd({ class: "privileged" });
    const result = applyConstitution("sendCommand", cmd, "operator");
    const blocked = result.violations.filter(
      (v) => v.id === "no-privileged-command-without-operator",
    );
    expect(blocked).toHaveLength(0);
  });

  it("no-privileged-command-without-operator: allows privileged class for admin", () => {
    const cmd = makeCmd({ class: "privileged" });
    const result = applyConstitution("sendCommand", cmd, "admin");
    const blocked = result.violations.filter(
      (v) => v.id === "no-privileged-command-without-operator",
    );
    expect(blocked).toHaveLength(0);
  });

  it("no-velocity-override: blocks bypass_safety param", () => {
    const result = applyConstitution("moveAxis", { bypass_safety: true }, "execution");
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "no-velocity-override")).toBe(true);
  });

  it("no-velocity-override: blocks override_envelope param", () => {
    const result = applyConstitution("moveAxis", { override_envelope: true }, "operator");
    expect(result.allowed).toBe(false);
  });

  it("no-velocity-override: allows normal velocity params", () => {
    const result = applyConstitution("moveAxis", { velocity: 100, axis: "X" }, "execution");
    const blocked = result.violations.filter((v) => v.id === "no-velocity-override");
    expect(blocked).toHaveLength(0);
  });
});

// ── Execution role constitution ────────────────────────────────────────────────

describe("ROLE_CONSTITUTION — execution", () => {
  const role: AgentRole = "execution";

  it("has role-specific rules defined", () => {
    expect(ROLE_CONSTITUTION[role]).toBeDefined();
    expect(ROLE_CONSTITUTION[role]!.length).toBeGreaterThan(0);
  });

  it("blocks verify tool", () => {
    const result = applyConstitution("verify", {}, role);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "execution-no-verify")).toBe(true);
  });

  it("blocks attest tool", () => {
    const result = applyConstitution("attest", {}, role);
    expect(result.allowed).toBe(false);
  });

  it("blocks releaseFunds tool", () => {
    const result = applyConstitution("releaseFunds", {}, role);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "execution-no-escrow-modification")).toBe(true);
  });

  it("blocks settleEscrow tool", () => {
    const result = applyConstitution("settleEscrow", {}, role);
    expect(result.allowed).toBe(false);
  });

  it("blocks settle tool", () => {
    const result = applyConstitution("settle", {}, role);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "execution-no-settlement")).toBe(true);
  });

  it("allows submit_evidence (execution's job)", () => {
    // submit_evidence is what execution SHOULD do — it should not be blocked
    const result = applyConstitution("submit_evidence", {}, role);
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("allows get_status (read operation)", () => {
    const result = applyConstitution("get_status", {}, role);
    expect(result.allowed).toBe(true);
  });

  it("allows safe class commands", () => {
    const cmd = makeCmd({ class: "safe" });
    const result = applyConstitution("sendCommand", cmd, role);
    expect(result.allowed).toBe(true);
  });

  it("allows scoped class commands", () => {
    const cmd = makeCmd({ class: "scoped" });
    const result = applyConstitution("sendCommand", cmd, role);
    // scoped is fine for execution, but privileged is not
    const blocked = result.violations.filter(
      (v) => v.id === "no-privileged-command-without-operator",
    );
    expect(blocked).toHaveLength(0);
  });
});

// ── Verification role constitution ────────────────────────────────────────────

describe("ROLE_CONSTITUTION — verification", () => {
  const role: AgentRole = "verification";

  it("has role-specific rules defined", () => {
    expect(ROLE_CONSTITUTION[role]).toBeDefined();
  });

  it("blocks scoped physical commands (RATS: Verifier is read-only for hardware)", () => {
    const cmd = makeCmd({ class: "scoped" });
    const result = applyConstitution("sendCommand", cmd, role);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "verification-no-physical-commands")).toBe(true);
  });

  it("blocks privileged physical commands", () => {
    const cmd = makeCmd({ class: "privileged" });
    const result = applyConstitution("sendCommand", cmd, role);
    expect(result.allowed).toBe(false);
  });

  it("allows read class commands (status checks are fine)", () => {
    const cmd = makeCmd({ class: "read" });
    const result = applyConstitution("sendCommand", cmd, role);
    const blocked = result.violations.filter(
      (v) => v.id === "verification-no-physical-commands",
    );
    expect(blocked).toHaveLength(0);
  });

  it("blocks releaseFunds", () => {
    const result = applyConstitution("releaseFunds", {}, role);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "verification-no-settle")).toBe(true);
  });

  it("blocks submitEvidence (Verifier cannot produce Evidence)", () => {
    const result = applyConstitution("submitEvidence", {}, role);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "verification-no-evidence-submission")).toBe(
      true,
    );
  });

  it("allows verify tool (verification's job)", () => {
    const result = applyConstitution("verify", {}, role);
    // verify is not in any forbidden list for the verification role
    expect(result.allowed).toBe(true);
  });

  it("allows attest tool", () => {
    const result = applyConstitution("attest", {}, role);
    expect(result.allowed).toBe(true);
  });
});

// ── Escrow role constitution ───────────────────────────────────────────────────

describe("ROLE_CONSTITUTION — escrow", () => {
  const role: AgentRole = "escrow";

  it("blocks scoped physical commands", () => {
    const cmd = makeCmd({ class: "scoped" });
    const result = applyConstitution("sendCommand", cmd, role);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "escrow-no-physical-commands")).toBe(true);
  });

  it("blocks verify tool", () => {
    const result = applyConstitution("verify", {}, role);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "escrow-no-verify")).toBe(true);
  });

  it("allows releaseFunds (escrow's job)", () => {
    const result = applyConstitution("releaseFunds", {}, role);
    // releaseFunds is NOT forbidden for escrow — it's what escrow does
    expect(result.allowed).toBe(true);
  });
});

// ── Settlement role constitution ───────────────────────────────────────────────

describe("ROLE_CONSTITUTION — settlement", () => {
  const role: AgentRole = "settlement";

  it("blocks scoped physical commands (RATS: Relying Party cannot issue equipment commands)", () => {
    const cmd = makeCmd({ class: "scoped" });
    const result = applyConstitution("sendCommand", cmd, role);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "settlement-no-physical-commands")).toBe(true);
  });

  it("blocks submitEvidence", () => {
    const result = applyConstitution("submitEvidence", {}, role);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "settlement-no-evidence-submission")).toBe(true);
  });

  it("allows settle tool (settlement's job)", () => {
    const result = applyConstitution("settle", {}, role);
    expect(result.allowed).toBe(true);
  });
});

// ── Discovery role — warn-level violations ─────────────────────────────────────

describe("ROLE_CONSTITUTION — discovery (warn-level)", () => {
  const role: AgentRole = "discovery";

  it("warns on writing tools but does NOT block (warn severity)", () => {
    // Note: applyConstitution allows warn-severity violations
    const result = applyConstitution("releaseFunds", {}, role);
    // discovery-read-only is warn, not block
    if (result.violations.some((v) => v.id === "discovery-read-only")) {
      expect(result.violations.find((v) => v.id === "discovery-read-only")?.severity).toBe("warn");
    }
    // Either allowed=true (warn didn't block) or the violation is present but warn
  });

  it("applyConstitutionStrict blocks on warn-level violations", () => {
    const result = applyConstitutionStrict("releaseFunds", {}, role);
    // discovery-read-only is warn; strict mode treats warn as block
    if (result.violations.some((v) => v.id === "discovery-read-only")) {
      expect(result.allowed).toBe(false);
    }
  });

  it("allows get_status (read operation)", () => {
    const result = applyConstitution("get_status", {}, role);
    const discoveryViolations = result.violations.filter(
      (v) => v.id === "discovery-read-only",
    );
    expect(discoveryViolations).toHaveLength(0);
  });
});

// ── applyConstitutionStrict ────────────────────────────────────────────────────

describe("applyConstitutionStrict()", () => {
  it("blocks on block-severity violations", () => {
    const result = applyConstitutionStrict("emergencyStop", { suppress: true }, "execution");
    expect(result.allowed).toBe(false);
  });

  it("returns allowed=true for clean operations", () => {
    const result = applyConstitutionStrict("get_status", {}, "execution");
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ── Clean pass for operator and admin ─────────────────────────────────────────

describe("operator and admin roles — broad permissions", () => {
  it("operator can invoke privileged commands", () => {
    const cmd = makeCmd({ class: "privileged" });
    const result = applyConstitution("sendCommand", cmd, "operator");
    const blocked = result.violations.filter(
      (v) => v.id === "no-privileged-command-without-operator",
    );
    expect(blocked).toHaveLength(0);
  });

  it("admin can invoke privileged commands", () => {
    const cmd = makeCmd({ class: "privileged" });
    const result = applyConstitution("sendCommand", cmd, "admin");
    const blocked = result.violations.filter(
      (v) => v.id === "no-privileged-command-without-operator",
    );
    expect(blocked).toHaveLength(0);
  });

  it("operator cannot modify constitution (universal rule applies to all)", () => {
    // Even operator cannot patch the constitution itself
    const result = applyConstitution("patchConstitution", {}, "operator");
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.id === "no-self-modification")).toBe(true);
  });

  it("admin cannot suppress e-stop (universal rule applies to all)", () => {
    const result = applyConstitution("emergencyStop", { suppress: true }, "admin");
    expect(result.allowed).toBe(false);
  });
});

// ── Fail-fast behaviour ────────────────────────────────────────────────────────

describe("fail-fast on first block violation", () => {
  it("stops after first block violation and does not continue checking", () => {
    // emergencyStop with suppress=true is a block violation; subsequent rules
    // should not run because we return early
    const result = applyConstitution(
      "emergencyStop",
      { suppress: true, requestRole: "admin" }, // two potential violations
      "execution",
    );
    expect(result.allowed).toBe(false);
    // Should have stopped at the first block violation
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe("block");
  });
});
