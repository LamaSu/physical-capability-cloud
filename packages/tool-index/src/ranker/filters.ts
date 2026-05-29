/**
 * Hard-gate filter evaluator.
 *
 * Hard gates are strict ON/OFF — any failure excludes the tool entirely
 * from the result set. Applied:
 *   - BEFORE phase 1 retrieval (eliminates ineligible candidates cheaply)
 *   - AFTER phase 2 scoring (defense-in-depth, also gives us `passedGates`
 *     for the explain output)
 *
 * Per ai/scoping/vespa-hybrid-ranking-2026-05-23.md §4.3:
 *
 *   - trust floor (trustTier ≥ filter.minTrustTier)
 *   - DCC ceiling (assuranceCeiling ≥ filter.requestedDccClass)
 *   - CVE gate (no CRITICAL knownVulns)
 *   - drift gate (no `critical` severity driftAlerts)
 *   - action-class gate (actionClass ∈ caller allowlist)
 *
 * Note on QUARANTINED: minTrustTier default is UNTRUSTED, which excludes
 * QUARANTINED (rank -1). Callers cannot opt back in to QUARANTINED — even
 * setting minTrustTier=QUARANTINED leaves a separate dedicated check.
 */

import type { IndexedTool } from "@pcc/spec";
import { TRUST_TIER_NUMERIC, TrustTier } from "@pcc/spec";
import { DigitalCaptureClass } from "@pcc/spec";
import type { HardFilter } from "./types.js";

/** Numeric ordering for DCC enum DCC0..DCC5. */
const DCC_NUMERIC: Record<DigitalCaptureClass, number> = {
  [DigitalCaptureClass.DCC0]: 0,
  [DigitalCaptureClass.DCC1]: 1,
  [DigitalCaptureClass.DCC2]: 2,
  [DigitalCaptureClass.DCC3]: 3,
  [DigitalCaptureClass.DCC4]: 4,
  [DigitalCaptureClass.DCC5]: 5,
};

/** Result of evaluating all hard gates against one tool. */
export interface GateResult {
  /** True iff every applicable gate passed. */
  passed: boolean;
  /** Names of gates that passed (for explain output). */
  passedGates: string[];
  /** Name of the FIRST gate that failed (for telemetry / debug). */
  failedGate?: string;
  /** Free-form reason for failure (logged in shadow telemetry). */
  reason?: string;
}

/**
 * Always-on gates that don't depend on caller input:
 *   - QUARANTINED is never callable
 *   - any CRITICAL CVE excludes
 *   - any `critical` severity drift alert excludes
 */
function evaluateAlwaysOn(tool: IndexedTool, passed: string[]): GateResult | null {
  if (tool.trustTier === TrustTier.QUARANTINED) {
    return {
      passed: false,
      passedGates: passed,
      failedGate: "no-quarantined",
      reason: "tool is QUARANTINED",
    };
  }
  passed.push("no-quarantined");

  const cves = tool.knownVulns ?? [];
  if (cves.some((v) => /critical/i.test(v))) {
    return {
      passed: false,
      passedGates: passed,
      failedGate: "no-critical-cve",
      reason: `tool has critical CVE: ${cves.find((v) => /critical/i.test(v))}`,
    };
  }
  passed.push("no-critical-cve");

  const drifts = tool.driftAlerts ?? [];
  if (drifts.some((d) => d.severity === "critical")) {
    return {
      passed: false,
      passedGates: passed,
      failedGate: "no-critical-drift",
      reason: "tool has critical drift alert",
    };
  }
  passed.push("no-critical-drift");

  return null;
}

/**
 * Evaluate every hard gate for a single tool, given the caller's filter.
 * Returns a structured GateResult.
 *
 * Pass order matters for explain output (gates listed in the order they
 * are checked). The function short-circuits on the first failure.
 */
export function evaluateHardGates(
  tool: IndexedTool,
  filter: HardFilter = {},
): GateResult {
  const passed: string[] = [];

  // 1-3. Always-on gates.
  const fail = evaluateAlwaysOn(tool, passed);
  if (fail) return fail;

  // 4. Trust floor.
  const minTier = filter.minTrustTier ?? TrustTier.UNTRUSTED;
  if (TRUST_TIER_NUMERIC[tool.trustTier] < TRUST_TIER_NUMERIC[minTier]) {
    return {
      passed: false,
      passedGates: passed,
      failedGate: "trust-floor",
      reason: `${tool.trustTier} < ${minTier}`,
    };
  }
  passed.push("trust-floor");

  // 5. DCC ceiling — caller can't ask for higher than the tool's ceiling.
  if (filter.requestedDccClass !== undefined) {
    const toolCeiling = DCC_NUMERIC[tool.assuranceCeiling] ?? 0;
    const requested = DCC_NUMERIC[filter.requestedDccClass] ?? 0;
    if (toolCeiling < requested) {
      return {
        passed: false,
        passedGates: passed,
        failedGate: "dcc-ceiling",
        reason: `${tool.assuranceCeiling} < ${filter.requestedDccClass}`,
      };
    }
    passed.push("dcc-ceiling");
  }

  // 6. Action-class allowlist.
  if (filter.actionClassAllowlist && filter.actionClassAllowlist.length > 0) {
    if (!filter.actionClassAllowlist.includes(tool.actionClass)) {
      return {
        passed: false,
        passedGates: passed,
        failedGate: "action-class",
        reason: `${tool.actionClass} not in [${filter.actionClassAllowlist.join(", ")}]`,
      };
    }
    passed.push("action-class");
  }

  // 7. Skill match.
  if (filter.skill) {
    if (!(tool.skills ?? []).includes(filter.skill)) {
      return {
        passed: false,
        passedGates: passed,
        failedGate: "skill-match",
        reason: `skill ${filter.skill} not in tool.skills`,
      };
    }
    passed.push("skill-match");
  }

  // 8. Domain match.
  if (filter.domain) {
    if (!(tool.domains ?? []).includes(filter.domain)) {
      return {
        passed: false,
        passedGates: passed,
        failedGate: "domain-match",
        reason: `domain ${filter.domain} not in tool.domains`,
      };
    }
    passed.push("domain-match");
  }

  return { passed: true, passedGates: passed };
}

/**
 * Bulk-filter a list of tools by hard gates. Returns only tools that
 * passed every gate. Lighter-weight than evaluateHardGates per-tool when
 * the caller doesn't need explain output.
 */
export function applyHardFilters(
  tools: IndexedTool[],
  filter: HardFilter = {},
): IndexedTool[] {
  return tools.filter((t) => evaluateHardGates(t, filter).passed);
}
