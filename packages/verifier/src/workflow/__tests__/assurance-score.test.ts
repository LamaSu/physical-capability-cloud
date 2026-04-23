import { describe, it, expect } from 'vitest';
import {
  computeAssuranceScore,
  type AssuranceScoreInput,
  type VerificationFinding,
  type DriftAlert,
} from '../assurance-score.js';
import { CaptureClass } from '@pcc/spec';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All 10 ALCOA+ principles passing. */
function allTrueAlcoa(): Record<string, boolean> {
  return {
    attributable: true,
    legible: true,
    contemporaneous: true,
    original: true,
    accurate: true,
    consistent: true,
    complete: true,
    credible: true,
    enduring: true,
    available: true,
  };
}

/** Shorthand for a passing finding. */
function pass(check: string): VerificationFinding {
  return { check, passed: true, details: 'ok' };
}

/** Shorthand for a failing finding with optional severity. */
function fail(
  check: string,
  severity?: 'critical' | 'warning',
): VerificationFinding {
  return { check, passed: false, details: 'failed', severity };
}

/** Shorthand for a drift alert. */
function drift(severity: DriftAlert['severity'], type = 'power_anomaly'): DriftAlert {
  return { severity, type };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeAssuranceScore', () => {
  // 1. All findings pass, no drift -> 1.0
  it('returns 1.0 for a perfect bundle (all findings pass, full ALCOA, no drift)', () => {
    const score = computeAssuranceScore({
      findings: [pass('bundle_hash_integrity'), pass('event_hash_integrity')],
      alcoaPrinciples: allTrueAlcoa(),
    });
    expect(score).toBe(1.0);
  });

  // 2. All findings pass, one critical drift -> 0.0
  it('returns 0.0 when a critical drift alert is present', () => {
    const score = computeAssuranceScore({
      findings: [pass('bundle_hash_integrity')],
      alcoaPrinciples: allTrueAlcoa(),
      driftAlerts: [drift('critical')],
    });
    expect(score).toBe(0.0);
  });

  // 3. One critical finding fails -> 0.0
  it('returns 0.0 when any critical finding fails', () => {
    const score = computeAssuranceScore({
      findings: [
        pass('event_hash_integrity'),
        fail('bundle_hash_integrity', 'critical'),
      ],
      alcoaPrinciples: allTrueAlcoa(),
    });
    expect(score).toBe(0.0);
  });

  // 4. All pass, one high drift -> approximately 0.5
  it('approximately halves the score on one high drift alert', () => {
    const score = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      driftAlerts: [drift('high')],
    });
    // base = 1.0 * 1.0 = 1.0, driftMult = 0.5 -> score = 0.5
    expect(score).toBe(0.5);
  });

  // 5. All pass, two high drifts -> approximately 0.25
  it('compounds two high drift alerts multiplicatively (~0.25)', () => {
    const score = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      driftAlerts: [drift('high'), drift('high')],
    });
    // driftMult = 0.5 * 0.5 = 0.25
    expect(score).toBe(0.25);
  });

  // 6. All pass, touchstone fail -> approximately 0.1
  it('applies 0.1 multiplier when touchstone fails', () => {
    const score = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      touchstoneResult: { passed: false },
    });
    // base = 1.0, touchstoneMult = 0.1 -> 0.1
    expect(score).toBe(0.1);
  });

  // 7. Mixed findings (70% pass) -> proportional score
  it('produces a proportional score for mixed findings (70% pass rate)', () => {
    const findings: VerificationFinding[] = [
      pass('a'), pass('b'), pass('c'), pass('d'), pass('e'),
      pass('f'), pass('g'),
      fail('h', 'warning'), fail('i', 'warning'), fail('j', 'warning'),
    ];
    const score = computeAssuranceScore({
      findings,
      alcoaPrinciples: allTrueAlcoa(),
    });
    // passRate = 0.7, alcoaScore = 1.0, base = 0.7 * 1.0 = 0.7
    expect(score).toBe(0.7);
  });

  // 8. No ALCOA data -> uses findings only
  it('degrades gracefully when no ALCOA data is provided', () => {
    const score = computeAssuranceScore({
      findings: [pass('a'), pass('b')],
    });
    // passRate = 1.0, alcoaScore = passRate = 1.0, base = 1.0
    expect(score).toBe(1.0);
  });

  // 9. Consensus bonus: agreement of 0.4 -> +0.02
  it('adds consensus bonus proportional to agreement fraction', () => {
    // Use a high drift to reduce base below 1.0 so the bonus is visible
    const baseScore = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      driftAlerts: [drift('high')],
    });
    // base = 1.0, driftMult = 0.5 -> baseScore = 0.5
    expect(baseScore).toBe(0.5);

    // consensusAgreement = 0.4 -> bonus = 0.4 * 0.05 = 0.02
    const withConsensus = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      driftAlerts: [drift('high')],
      consensusAgreement: 0.4,
    });
    // 0.5 + 0.02 = 0.52
    expect(withConsensus).toBe(0.52);
    expect(withConsensus - baseScore).toBeCloseTo(0.02, 4);
  });

  // 10. Empty input -> 1.0 (nothing to fail)
  it('returns 1.0 for empty findings (nothing to fail)', () => {
    const score = computeAssuranceScore({ findings: [] });
    expect(score).toBe(1.0);
  });

  // 11. ALCOA: 8/10 principles pass -> proportional reduction
  it('reduces score proportionally when 2 ALCOA principles fail', () => {
    const alcoa = { ...allTrueAlcoa(), enduring: false, available: false };
    // Lost: enduring (0.07) + available (0.07) = 0.14
    // alcoaScore = 1.0 - 0.14 = 0.86
    const score = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: alcoa,
    });
    // base = 1.0 * 0.86 = 0.86
    expect(score).toBe(0.86);
  });

  // 12. Combined: findings 90%, one medium drift, touchstone pass -> ~0.72
  it('combines findings pass rate with medium drift correctly', () => {
    // 9 pass, 1 warning fail -> passRate = 0.9
    const findings: VerificationFinding[] = [
      pass('a'), pass('b'), pass('c'), pass('d'), pass('e'),
      pass('f'), pass('g'), pass('h'), pass('i'),
      fail('j', 'warning'),
    ];
    const score = computeAssuranceScore({
      findings,
      alcoaPrinciples: allTrueAlcoa(),
      driftAlerts: [drift('medium')],
      touchstoneResult: { passed: true },
    });
    // passRate = 0.9, alcoaScore = 1.0, base = 0.9
    // driftMult = 1 - 0.2 = 0.8
    // touchstoneMult = 1.0
    // raw = 0.9 * 0.8 * 1.0 = 0.72
    expect(score).toBe(0.72);
  });

  // 13. Consensus bonus capped at +0.05
  it('caps consensus bonus at +0.05 regardless of agreement level', () => {
    const baseScore = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
    });
    const withMaxConsensus = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      consensusAgreement: 1.0,
    });
    // max bonus = 0.05, but base is already 1.0 so clamped to 1.0
    // The bonus is min(0.05, 1.0 * 0.05) = 0.05
    // raw = 1.0 + 0.05 = 1.05, clamped to 1.0
    expect(withMaxConsensus).toBe(1.0);
    expect(withMaxConsensus).toBeLessThanOrEqual(1.0);

    // Test with a reduced base to see the bonus
    const reduced = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      driftAlerts: [drift('high')],
    });
    const reducedWithConsensus = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      driftAlerts: [drift('high')],
      consensusAgreement: 1.0,
    });
    // reduced base = 0.5, + bonus 0.05 = 0.55
    expect(reducedWithConsensus - reduced).toBeCloseTo(0.05, 4);
  });

  // 14. Score is deterministic: same input -> same output
  it('is deterministic (same input always produces the same output)', () => {
    const input: AssuranceScoreInput = {
      findings: [pass('a'), fail('b', 'warning'), pass('c')],
      alcoaPrinciples: { ...allTrueAlcoa(), legible: false },
      driftAlerts: [drift('low')],
      touchstoneResult: { passed: true },
      consensusAgreement: 0.2,
    };
    const score1 = computeAssuranceScore(input);
    const score2 = computeAssuranceScore(input);
    const score3 = computeAssuranceScore(input);
    expect(score1).toBe(score2);
    expect(score2).toBe(score3);
  });

  // 15. Score is always in [0.0, 1.0]
  it('always returns a value in [0.0, 1.0]', () => {
    const scenarios: AssuranceScoreInput[] = [
      { findings: [] },
      { findings: [pass('ok')] },
      { findings: [fail('bad', 'critical')] },
      { findings: [pass('ok')], consensusAgreement: 1.0 },
      {
        findings: [pass('ok')],
        alcoaPrinciples: allTrueAlcoa(),
        driftAlerts: [drift('high'), drift('high'), drift('medium')],
        touchstoneResult: { passed: false },
        consensusAgreement: 1.0,
      },
    ];
    for (const input of scenarios) {
      const score = computeAssuranceScore(input);
      expect(score).toBeGreaterThanOrEqual(0.0);
      expect(score).toBeLessThanOrEqual(1.0);
    }
  });

  // 16. Touchstone pass has no penalty
  it('does not penalize when touchstone passes', () => {
    const withoutTouchstone = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
    });
    const withTouchstonePass = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      touchstoneResult: { passed: true },
    });
    expect(withTouchstonePass).toBe(withoutTouchstone);
  });

  // 17. Low drift alert has minimal impact
  it('applies a small penalty for low-severity drift alerts', () => {
    const clean = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
    });
    const withLowDrift = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      driftAlerts: [drift('low')],
    });
    // driftMult = 1 - 0.05 = 0.95
    expect(withLowDrift).toBe(0.95);
    expect(clean - withLowDrift).toBeCloseTo(0.05, 4);
  });

  // 18. ALCOA primary principle failure has larger impact than secondary
  it('weights primary ALCOA principles higher than secondary', () => {
    const missingPrimary = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: { ...allTrueAlcoa(), attributable: false },
    });
    const missingSecondary = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: { ...allTrueAlcoa(), available: false },
    });
    // attributable weight = 0.15, available weight = 0.07
    // missingPrimary: alcoaScore = 0.85, base = 0.85
    // missingSecondary: alcoaScore = 0.93, base = 0.93
    expect(missingPrimary).toBeLessThan(missingSecondary);
    expect(missingPrimary).toBe(0.85);
    expect(missingSecondary).toBe(0.93);
  });

  // ------------------------------------------------------------------
  // Capture Verification Protocol (CVP) — captureClass multiplier
  // ------------------------------------------------------------------

  // 19. Back-compat: omitting captureClass behaves exactly as before.
  it('is back-compat: omitting captureClass yields identical score to pre-CVP callers', () => {
    const without = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
    });
    // Sanity: still a perfect score when nothing is wrong.
    expect(without).toBe(1.0);
  });

  // 20. CC1 applies a ~0.92 multiplier to the base score.
  it('applies ~0.92 multiplier when captureClass is CC1', () => {
    const score = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      captureClass: CaptureClass.CC1,
    });
    // base = 1.0, multiplier = 0.92 -> 0.92
    expect(score).toBeCloseTo(0.92, 4);
  });

  // 21. CC3 is neutral (1.0 multiplier).
  it('applies 1.0 multiplier when captureClass is CC3 (no effect)', () => {
    const score = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      captureClass: CaptureClass.CC3,
    });
    expect(score).toBe(1.0);
  });

  // 22. CC0 applies the steepest penalty (0.70).
  it('applies 0.70 multiplier when captureClass is CC0', () => {
    const score = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      captureClass: CaptureClass.CC0,
    });
    expect(score).toBeCloseTo(0.70, 4);
  });

  // 23. Critical-finding gate still zeroes the score regardless of class.
  it('critical-finding gate still returns 0.0 even with captureClass set', () => {
    const score = computeAssuranceScore({
      findings: [fail('bundle_hash_integrity', 'critical')],
      alcoaPrinciples: allTrueAlcoa(),
      captureClass: CaptureClass.CC5,
    });
    expect(score).toBe(0.0);
  });

  // 24. Critical-finding gate short-circuits even for CC0 (hard zero wins).
  it('critical-finding gate zeroes the score regardless of a CC0 penalty', () => {
    const score = computeAssuranceScore({
      findings: [fail('bundle_hash_integrity', 'critical')],
      alcoaPrinciples: allTrueAlcoa(),
      captureClass: CaptureClass.CC0,
    });
    expect(score).toBe(0.0);
  });

  // 25. captureClass multiplies alongside drift/touchstone.
  it('composes multiplicatively with drift and touchstone multipliers', () => {
    const score = computeAssuranceScore({
      findings: [pass('ok')],
      alcoaPrinciples: allTrueAlcoa(),
      driftAlerts: [drift('medium')],
      captureClass: CaptureClass.CC2,
    });
    // base = 1.0, driftMult = 0.8, touchstoneMult = 1.0, classMult = 0.96
    // raw = 1.0 * 0.8 * 1.0 * 0.96 = 0.768
    expect(score).toBe(0.768);
  });
});
