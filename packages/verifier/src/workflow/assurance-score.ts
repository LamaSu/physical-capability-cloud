/**
 * Assurance Score rollup -- compresses structured compliance data into a single
 * scalar in [0.0, 1.0] for fast market routing, dashboard display, and on-chain
 * escrow gating.
 *
 * The rollup is NOT a replacement for structured detail. Consumers wanting to
 * audit a specific finding or dispute a drift alert MUST use the structured
 * VerificationFinding[] / DriftAlert[] fields alongside.
 *
 * Design principles (see ai/research/digital-verifier/04-assurance-score.md):
 * - Base is a multiplicative blend of ALCOA+ score and findings pass-rate.
 * - Critical findings zero the score (regulatory-grade gate).
 * - Drift alerts apply multiplicative penalties by severity.
 * - Touchstone failures produce a 0.1 multiplier (proves non-execution).
 * - Cross-verifier consensus grants a small capped bonus.
 * - Monotonic: adding more passing evidence never lowers the score.
 *
 * Pure function with zero I/O. Deterministic: same input always produces the
 * same output.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single finding from verification. Compatible with @pcc/spec VerificationFinding. */
export interface VerificationFinding {
  check: string;
  passed: boolean;
  severity?: 'critical' | 'warning';
  details: string;
}

/** A drift alert emitted by the CWM when telemetry diverges from expected. */
export interface DriftAlert {
  severity: 'low' | 'medium' | 'high' | 'critical';
  type: string;
}

/** All inputs the assurance score rollup can consume. Every field is optional
 *  except `findings`. The rollup degrades gracefully when fields are absent. */
export interface AssuranceScoreInput {
  /** Verification findings from EvidenceVerifier.verify(). */
  findings: VerificationFinding[];

  /** ALCOA+ 10-principle status. Keys are the 10 principle names, values are
   *  booleans indicating whether each principle is satisfied. */
  alcoaPrinciples?: Record<string, boolean>;

  /** Drift alerts from the compliance monitoring layer. */
  driftAlerts?: DriftAlert[];

  /** Touchstone challenge-response result. */
  touchstoneResult?: { passed: boolean };

  /** Fraction of verifiers that agree on the result (0-1).
   *  0 = solo verifier (no bonus), 1.0 = maximum agreement (bonus capped at +0.05).
   *  Maps linearly: bonus = min(0.05, consensusAgreement * 0.05). */
  consensusAgreement?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Weights for the 10 ALCOA+ principles. Sum = 1.0.
 * Three primaries (Attributable, Original, Accurate) at 0.15 each.
 * Seven secondaries at 0.07-0.09 each.
 */
const ALCOA_WEIGHTS: Record<string, number> = {
  attributable:    0.15,
  original:        0.15,
  accurate:        0.15,
  complete:        0.09,
  legible:         0.08,
  contemporaneous: 0.08,
  consistent:      0.08,
  credible:        0.08,
  enduring:        0.07,
  available:       0.07,
};

/** Multiplicative penalty per drift alert, keyed by severity.
 *  Applied as: driftMultiplier *= (1 - penalty). */
const DRIFT_PENALTIES: Record<string, number> = {
  critical: 1.00,
  high:     0.50,
  medium:   0.20,
  low:      0.05,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the assurance score in [0.0, 1.0] from structured compliance inputs.
 *
 * Formula:
 *   1. passRate = (passed findings) / (total findings)
 *   2. alcoaScore = sum of (passed principle * weight) across 10 ALCOA+ principles.
 *      If alcoaPrinciples not provided, alcoaScore = passRate (degrade gracefully).
 *   3. Critical gate: ANY critical finding with passed === false -> return 0.0
 *   4. base = passRate * alcoaScore
 *   5. driftMultiplier = product of (1 - penalty) for each drift alert.
 *      Penalties: critical=1.0, high=0.5, medium=0.2, low=0.05.
 *   6. touchstoneMultiplier = 0.1 if touchstoneResult.passed === false, else 1.0.
 *   7. consensusBonus = min(0.05, consensusAgreement * 0.05). Capped at +0.05.
 *   8. final = clamp(0, 1, base * driftMultiplier * touchstoneMultiplier + consensusBonus)
 *   9. Round to 4 decimal places.
 *
 * Empty findings -> 1.0 (nothing to fail = perfect).
 *
 * @param input - All signals for the rollup. Only `findings` is required.
 * @returns Score in [0.0, 1.0], rounded to 4 decimal places.
 */
export function computeAssuranceScore(input: AssuranceScoreInput): number {
  const {
    findings,
    alcoaPrinciples,
    driftAlerts,
    touchstoneResult,
    consensusAgreement,
  } = input;

  // Empty input: no findings = nothing to fail = perfect score
  if (findings.length === 0) {
    return 1.0;
  }

  // Critical gate: ANY critical finding failed -> hard zero
  const hasCriticalFailure = findings.some(
    (f) => !f.passed && f.severity === 'critical',
  );
  if (hasCriticalFailure) {
    return 0.0;
  }

  // Findings pass rate
  const passedCount = findings.filter((f) => f.passed).length;
  const passRate = passedCount / findings.length;

  // ALCOA+ weighted score
  let alcoaScore: number;
  if (alcoaPrinciples) {
    alcoaScore = 0;
    for (const [principle, weight] of Object.entries(ALCOA_WEIGHTS)) {
      if (alcoaPrinciples[principle]) {
        alcoaScore += weight;
      }
    }
  } else {
    // No ALCOA data: use pass rate as proxy
    alcoaScore = passRate;
  }

  // Base: multiplicative blend of findings and ALCOA
  const base = passRate * alcoaScore;

  // Drift penalty: multiplicative compounding
  let driftMultiplier = 1.0;
  if (driftAlerts && driftAlerts.length > 0) {
    for (const alert of driftAlerts) {
      const penalty = DRIFT_PENALTIES[alert.severity] ?? 0;
      driftMultiplier *= (1 - penalty);
    }
  }

  // Touchstone penalty
  let touchstoneMultiplier = 1.0;
  if (touchstoneResult && !touchstoneResult.passed) {
    touchstoneMultiplier = 0.1;
  }

  // Consensus bonus: linear mapping from 0-1 fraction to 0-0.05 bonus
  let consensusBonus = 0;
  if (consensusAgreement !== undefined && consensusAgreement > 0) {
    consensusBonus = Math.min(0.05, consensusAgreement * 0.05);
  }

  // Final composition
  const raw = (base * driftMultiplier * touchstoneMultiplier) + consensusBonus;
  const clamped = Math.max(0.0, Math.min(1.0, raw));

  // Round to 4 decimal places
  return Math.round(clamped * 10000) / 10000;
}
