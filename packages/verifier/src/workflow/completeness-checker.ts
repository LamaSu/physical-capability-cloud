/**
 * Step Completeness Checker — verifies that all declared workflow steps have
 * corresponding evidence traces.
 *
 * Three levels of check (cumulative):
 *   Level 0: Set membership — every declared step has a trace.
 *   Level 1: Non-trivial content — each trace has non-empty outputHash and
 *            outputSummary (>10 chars). Detects stub traces.
 *   Level 2: Flow integrity — sequential steps' inputHash/outputHash chain
 *            correctly (step B's inputHash matches step A's outputHash when
 *            B depends on A).
 *
 * Pure function with zero I/O. Deterministic.
 *
 * Design: ai/research/digital-verifier/03-step-completeness.md
 */

import type { DigitalWorkflowStep } from '@pcc/spec';
import type { VerificationFinding } from '@pcc/spec';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal evidence trace entry for completeness checking. */
export interface StepTrace {
  stepId: string;
  outputHash?: string;
  outputSummary?: string;
  durationMs?: number;
  inputHash?: string;
}

/** Contract-like input for completeness checking. */
export interface CompletenessContract {
  workflowSteps: DigitalWorkflowStep[];
  /** Steps expected to be skipped (e.g., downstream of a failed step). */
  expectedSkips?: string[];
}

/** Result of a completeness check. */
export interface CompletenessCheckResult {
  findings: VerificationFinding[];
  coveredSteps: string[];
  missingSteps: string[];
  extraSteps: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finding(
  check: string,
  passed: boolean,
  details: string,
  severity?: 'critical' | 'warning',
): VerificationFinding {
  return {
    evidenceEventId: '',
    check,
    passed,
    details,
    severity: passed ? undefined : severity,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Check whether all declared workflow steps have corresponding evidence traces.
 *
 * @param contract  The contract with declared workflowSteps.
 * @param traces    The evidence traces produced during execution.
 * @param options   Optional config. `level` defaults to 0.
 * @returns         Findings, covered/missing/extra step lists.
 */
export function checkStepCompleteness(
  contract: CompletenessContract,
  traces: StepTrace[],
  options?: { level?: 0 | 1 | 2 },
): CompletenessCheckResult {
  const level = options?.level ?? 0;
  const findings: VerificationFinding[] = [];

  const declaredIds = new Set(contract.workflowSteps.map((s) => s.stepId));
  const skipIds = new Set(contract.expectedSkips ?? []);

  // Build a map from stepId -> traces (for duplicate detection and lookup)
  const traceMap = new Map<string, StepTrace[]>();
  for (const trace of traces) {
    const existing = traceMap.get(trace.stepId);
    if (existing) {
      existing.push(trace);
    } else {
      traceMap.set(trace.stepId, [trace]);
    }
  }

  const traceIds = new Set(traceMap.keys());

  // ── Duplicate detection ──────────────────────────────────────────
  for (const [stepId, entries] of traceMap) {
    if (entries.length > 1) {
      findings.push(
        finding(
          'step_duplicate',
          false,
          `Step "${stepId}" has ${entries.length} trace entries (expected 1)`,
          'warning',
        ),
      );
    }
  }

  // ── Level 0: Set membership ──────────────────────────────────────
  const coveredSteps: string[] = [];
  const missingSteps: string[] = [];

  for (const stepId of declaredIds) {
    if (traceIds.has(stepId)) {
      coveredSteps.push(stepId);
    } else if (!skipIds.has(stepId)) {
      missingSteps.push(stepId);
      findings.push(
        finding(
          'step_completeness',
          false,
          `Declared step "${stepId}" has no corresponding trace`,
          'critical',
        ),
      );
    }
    // If stepId is in skipIds and not in traces, that's expected — no finding.
  }

  // ── Extra traces (in traces but not in contract) ─────────────────
  const extraSteps: string[] = [];
  for (const stepId of traceIds) {
    if (!declaredIds.has(stepId)) {
      extraSteps.push(stepId);
      findings.push(
        finding(
          'step_extra',
          false,
          `Trace for step "${stepId}" has no corresponding declaration in the contract`,
          'warning',
        ),
      );
    }
  }

  // ── Level 1: Non-trivial content (stub detection) ────────────────
  if (level >= 1) {
    for (const stepId of coveredSteps) {
      const entries = traceMap.get(stepId)!;
      // Check the first trace entry for this step
      const trace = entries[0];
      const hasOutputHash = typeof trace.outputHash === 'string' && trace.outputHash.length > 0;
      const hasOutputSummary =
        typeof trace.outputSummary === 'string' && trace.outputSummary.length > 10;

      if (!hasOutputHash || !hasOutputSummary) {
        const reasons: string[] = [];
        if (!hasOutputHash) reasons.push('empty or missing outputHash');
        if (!hasOutputSummary) reasons.push('outputSummary missing or <= 10 chars');
        findings.push(
          finding(
            'step_stub_detected',
            false,
            `Step "${stepId}" appears to be a stub: ${reasons.join(', ')}`,
            'critical',
          ),
        );
      }
    }
  }

  // ── Level 2: Flow integrity (input/output hash chaining) ────────
  if (level >= 2) {
    // Build a dependency lookup from declared steps
    const stepLookup = new Map<string, DigitalWorkflowStep>();
    for (const step of contract.workflowSteps) {
      stepLookup.set(step.stepId, step);
    }

    for (const stepId of coveredSteps) {
      const step = stepLookup.get(stepId);
      if (!step || step.dependsOn.length === 0) {
        // First step or no dependencies — no flow check needed
        continue;
      }

      // Check against the first dependency
      const depId = step.dependsOn[0];
      const depTraces = traceMap.get(depId);
      const currentTraces = traceMap.get(stepId);

      if (!depTraces || !currentTraces) {
        // Dependency trace missing — already flagged by Level 0
        continue;
      }

      const depTrace = depTraces[0];
      const currentTrace = currentTraces[0];

      // Only check if both hashes are present
      if (depTrace.outputHash && currentTrace.inputHash) {
        if (currentTrace.inputHash !== depTrace.outputHash) {
          findings.push(
            finding(
              'step_flow_integrity',
              false,
              `Step "${stepId}" inputHash ("${currentTrace.inputHash}") does not match dependency "${depId}" outputHash ("${depTrace.outputHash}")`,
              'critical',
            ),
          );
        }
      }
    }
  }

  return { findings, coveredSteps, missingSteps, extraSteps };
}
