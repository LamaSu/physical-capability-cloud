/**
 * Constitutional Constraints — ASI01 Goal Hijack Mitigation
 *
 * Hard rules that no agent role may violate, regardless of instruction content
 * (including prompt injection, malicious job descriptions, or tool output manipulation).
 *
 * Applied BEFORE tool dispatch (pre-screen) and BEFORE SafetyGovernor.validateCommand().
 * Integration point: call applyConstitution() inside SafetyGateway.execute() as the
 * outermost check, before SafetyGovernor.validateCommand().
 *
 * Design principles:
 *   - Rules are expressed in natural language (principle) AND as a programmatic check.
 *   - "block" severity: execution is denied immediately, violations list is returned.
 *   - "warn" severity: execution continues but the violation is logged.
 *   - No DSL, no dynamic rule loading. Hard-coded for auditability.
 *   - Role-specific rules layer on top of universal rules (UNIVERSAL_CONSTITUTION applies
 *     to all roles; ROLE_CONSTITUTION adds per-role restrictions).
 *
 * OWASP ASI01: Goal Hijack mitigation — constitutional constraints per agent role.
 * Inspired by Anthropic Constitutional AI (CAI).
 *
 * Integration with RATS RFC 9334:
 *   - Only the Attester (execution role / Shop Kernel) may issue physical commands.
 *   - The Verifier role is read-only with respect to hardware.
 *   - The Relying Party (settlement role) must not issue equipment commands.
 */

import type { PhysicalCommand } from "./governor.js";

// ── Role union (mirrors facade AgentRole for cross-package use) ───────────────
// Kept local to avoid circular imports with @pcc/gateway. Keep in sync with
// packages/gateway/src/facades/types.ts AgentRole.
export type AgentRole =
  | "discovery"
  | "negotiation"
  | "escrow"
  | "execution"
  | "verification"
  | "settlement"
  | "operator"
  | "admin";

// ── ConstitutionalConstraint ──────────────────────────────────────────────────

/**
 * A single constitutional rule.
 *
 * `check` returns true when the rule is SATISFIED (execution allowed).
 * Returns false when the rule is VIOLATED (execution denied or warned).
 */
export interface ConstitutionalConstraint {
  /** Unique rule identifier for audit trail and logging */
  id: string;
  /** Natural language statement of the rule (for operators and auditors) */
  principle: string;
  /**
   * Programmatic check. Returns true when execution is allowed.
   * Receives the tool/command name, its parameters, and the calling role.
   */
  check: (toolName: string, params: unknown, role: AgentRole) => boolean;
  /** "block" = deny immediately; "warn" = allow but log */
  severity: "block" | "warn";
}

// ── Universal Constitution (applies to ALL roles) ─────────────────────────────

/**
 * Universal rules that apply to every agent role without exception.
 * These are the highest-priority constitutional constraints.
 */
export const UNIVERSAL_CONSTITUTION: ConstitutionalConstraint[] = [
  {
    id: "no-emergency-stop-bypass",
    principle:
      "No agent may suppress, delay, or bypass an emergency-stop signal under any circumstance",
    check: (tool, params: any) =>
      !(tool === "emergencyStop" && params?.suppress === true),
    severity: "block",
  },
  {
    id: "no-scope-escalation",
    principle:
      "An agent may not request permissions or roles beyond its registered role",
    check: (_tool, params: any, role) =>
      !(params?.requestRole !== undefined && params.requestRole !== role),
    severity: "block",
  },
  {
    id: "no-self-modification",
    principle:
      "An agent may not modify its own configuration, permissions, or constitutional rules",
    check: (tool) =>
      !["updateRolePermissions", "patchConstitution", "modifyAgentConfig"].includes(tool),
    severity: "block",
  },
  {
    id: "no-privileged-command-without-operator",
    principle:
      "No agent may issue Class 4 (privileged) commands except operator or admin roles",
    check: (tool, params: any, role) => {
      const cmd = params as Partial<PhysicalCommand>;
      if (cmd?.class === "privileged") {
        return role === "operator" || role === "admin";
      }
      return true;
    },
    severity: "block",
  },
  {
    id: "no-velocity-override",
    principle:
      "No agent may override the operational envelope velocity limit via raw parameter injection",
    check: (_tool, params: any) => {
      // Block explicit attempts to override safety parameters in command params
      const dangerousKeys = ["bypass_safety", "override_envelope", "disable_governor"];
      if (params && typeof params === "object") {
        return !dangerousKeys.some((k) => k in (params as object));
      }
      return true;
    },
    severity: "block",
  },
];

// ── Role Constitution (per-role additional rules) ─────────────────────────────

/**
 * Per-role additional constitutional rules.
 *
 * These layer on top of UNIVERSAL_CONSTITUTION and add role-specific restrictions
 * that reflect the RATS role separation and PCC SoD constraints.
 */
export const ROLE_CONSTITUTION: Partial<Record<AgentRole, ConstitutionalConstraint[]>> = {
  execution: [
    {
      id: "execution-no-verify",
      principle:
        "The execution agent (RATS: Attester) may not invoke verification or attestation tools",
      check: (tool) =>
        !["verify", "attest", "submitAttestation", "createVerification"].includes(tool),
      severity: "block",
    },
    {
      id: "execution-no-escrow-modification",
      principle:
        "The execution agent may not modify, release, or dispute escrow funds",
      check: (tool) =>
        !["releaseFunds", "disputeEscrow", "modifyEscrow", "settleEscrow", "fundEscrow"].includes(
          tool,
        ),
      severity: "block",
    },
    {
      id: "execution-no-settlement",
      principle:
        "The execution agent (RATS: Attester) may not trigger settlement actions",
      check: (tool) => !["settle", "approveSettlement", "rejectSettlement"].includes(tool),
      severity: "block",
    },
  ],

  verification: [
    {
      id: "verification-no-physical-commands",
      principle:
        "The verification agent (RATS: Verifier) may not send physical equipment commands",
      check: (_tool, params: any) => {
        const cmd = params as Partial<PhysicalCommand>;
        // Deny any command with a scoped or privileged class (Class 3+)
        return cmd?.class !== "scoped" && cmd?.class !== "privileged";
      },
      severity: "block",
    },
    {
      id: "verification-no-settle",
      principle:
        "The verification agent (RATS: Verifier) may not trigger or approve settlement",
      check: (tool) =>
        !["releaseFunds", "settleEscrow", "approveSettlement"].includes(tool),
      severity: "block",
    },
    {
      id: "verification-no-evidence-submission",
      principle:
        "The verification agent may not submit evidence bundles — only the Attester (execution agent) produces Evidence",
      check: (tool) => !["submitEvidence", "finalizeBundle", "emitEvidenceEvent"].includes(tool),
      severity: "block",
    },
  ],

  escrow: [
    {
      id: "escrow-no-physical-commands",
      principle:
        "The escrow agent (RATS: Relying Party proxy) may not issue physical equipment commands",
      check: (_tool, params: any) => {
        const cmd = params as Partial<PhysicalCommand>;
        return cmd?.class !== "scoped" && cmd?.class !== "privileged";
      },
      severity: "block",
    },
    {
      id: "escrow-no-verify",
      principle:
        "The escrow agent may not invoke verification or attestation tools",
      check: (tool) =>
        !["verify", "attest", "submitAttestation", "createVerification"].includes(tool),
      severity: "block",
    },
  ],

  settlement: [
    {
      id: "settlement-no-physical-commands",
      principle:
        "The settlement agent (RATS: Relying Party) may not issue physical equipment commands",
      check: (_tool, params: any) => {
        const cmd = params as Partial<PhysicalCommand>;
        return cmd?.class !== "scoped" && cmd?.class !== "privileged";
      },
      severity: "block",
    },
    {
      id: "settlement-no-evidence-submission",
      principle:
        "The settlement agent may not submit or modify evidence bundles",
      check: (tool) => !["submitEvidence", "finalizeBundle", "emitEvidenceEvent"].includes(tool),
      severity: "block",
    },
  ],

  discovery: [
    {
      id: "discovery-read-only",
      principle:
        "The discovery agent may only perform read operations — no writes to any resource",
      check: (tool) => {
        const writingTools = [
          "submitEvidence",
          "releaseFunds",
          "settleEscrow",
          "verify",
          "attest",
          "fundEscrow",
          "updateJob",
          "emitEvidenceEvent",
        ];
        return !writingTools.includes(tool);
      },
      severity: "warn",
    },
  ],

  negotiation: [
    {
      id: "negotiation-no-physical-commands",
      principle:
        "The negotiation agent may not issue physical equipment commands",
      check: (_tool, params: any) => {
        const cmd = params as Partial<PhysicalCommand>;
        return cmd?.class !== "scoped" && cmd?.class !== "privileged";
      },
      severity: "block",
    },
  ],
};

// ── ConstitutionResult ────────────────────────────────────────────────────────

export interface ConstitutionResult {
  /** true if execution is allowed (no blocking violations) */
  allowed: boolean;
  /** List of rule IDs + principles that were violated */
  violations: Array<{ id: string; principle: string; severity: "block" | "warn" }>;
}

// ── applyConstitution ─────────────────────────────────────────────────────────

/**
 * Apply constitutional constraints for a given agent role.
 *
 * Evaluates UNIVERSAL_CONSTITUTION followed by role-specific ROLE_CONSTITUTION.
 * Returns on the first "block" violation (fail-fast). "warn" violations are
 * collected and returned even when allowed=true.
 *
 * @param toolName  The tool or command type being invoked
 * @param params    The tool/command parameters (may include a PhysicalCommand)
 * @param role      The agent role making the request
 * @returns         ConstitutionResult with allowed flag and violation list
 */
export function applyConstitution(
  toolName: string,
  params: unknown,
  role: AgentRole,
): ConstitutionResult {
  const violations: ConstitutionResult["violations"] = [];

  const rules: ConstitutionalConstraint[] = [
    ...UNIVERSAL_CONSTITUTION,
    ...(ROLE_CONSTITUTION[role] ?? []),
  ];

  for (const rule of rules) {
    const satisfied = rule.check(toolName, params, role);
    if (!satisfied) {
      violations.push({ id: rule.id, principle: rule.principle, severity: rule.severity });
      if (rule.severity === "block") {
        // Fail fast on first blocking violation
        return { allowed: false, violations };
      }
      // "warn" — continue checking but accumulate the violation
    }
  }

  // All block-level rules passed. Warn-level violations may be present.
  return { allowed: true, violations };
}

/**
 * Strict variant: returns false immediately on any violation (block OR warn).
 * Use in high-assurance (Tier 3) job contexts.
 */
export function applyConstitutionStrict(
  toolName: string,
  params: unknown,
  role: AgentRole,
): ConstitutionResult {
  const result = applyConstitution(toolName, params, role);
  if (result.violations.length > 0) {
    return { allowed: false, violations: result.violations };
  }
  return result;
}
