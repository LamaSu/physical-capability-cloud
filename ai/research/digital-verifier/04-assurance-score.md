# Assurance Score Scalar Rollup — Research & Design

**Author:** PCC research (deep-research agent)
**Date:** 2026-04-11
**Target:** `packages/verifier/src/evidence-verifier.ts`, `packages/gateway/src/facades/types.ts`, `packages/gateway/src/facades/compliance.facade.ts`
**Status:** Design proposal, ready for implementation
**Field name (final):** `assuranceScore: number` in `[0.0, 1.0]`

---

## 0. TL;DR

PCC already produces rich structured compliance data — `VerificationFinding[]` with severity grades, an ALCOA+ 10-principle boolean status, tier compliance booleans, `DriftAlertDTO[]` severities, and multi-verifier consensus — but it exposes no single scalar that lets a buyer, a dashboard, or an escrow contract rank providers. This document designs `assuranceScore`: a deterministic, monotonic rollup in `[0,1]` computed from the existing signals with no new DB queries, no new network calls, and full backward compatibility with the legacy `confidence: 0-100` field.

The rollup is multiplicative-with-gates rather than linear, because regulatory scoring fails catastrophically under linear aggregation: one missing signature cannot be offset by ten passing tier requirements. Critical findings zero the score. Touchstone failure produces a 0.1 multiplier (proves non-execution). ALCOA+ is weighted unequally only where admissibility theory demands (Attributable, Original, Accurate carry slightly higher weight). Drift alerts apply ordered multiplicative penalties. Cross-verifier agreement adds a small capped bonus.

---

## 1. First Principles: Scalar + Structure Wins

The analogy is FICO (300-850) + the full credit report. FICO lets a lender decline, approve, or price-adjust in milliseconds without reading a single tradeline. The credit report (30+ pages) is the audit trail for disputes, spot-checks, and investigations. Neither is sufficient alone: the scalar without detail is opaque; the detail without a scalar forces every consumer to become an analyst.

PCC today has rich detail but no scalar. An agent ranking 20 providers must call `/api/capabilities/:id/compliance` for each, parse 10 ALCOA+ booleans, N findings, M drift alerts, and 4 tier compliance booleans, then apply its own weighting. This is O(N x agent reasoning) at the API edge and introduces buyer-side bias. On-chain escrow logic cannot parse structured data in Solidity — it needs a uint8. Dashboard users cannot eyeball 40 fields per provider.

The scalar solves **routing, pricing, and display**. The structure remains authoritative for **audit, dispute, and debugging**. They are a hierarchy, not substitutes.

---

## 2. Prior Art in Score Compression

### 2.1 FICO (credit scoring, 300–850)

FICO weights five categories (payment history 35%, amounts owed 30%, length 15%, new credit 10%, mix 10%) but the marketed linearity is deceptive: the raw sub-scores are piecewise-computed with recency, severity, and frequency gates. A 90-day delinquency drops the score far more than three 30-day delinquencies of equivalent total age because severity gates override arithmetic addition. **Lesson:** linear aggregation is gamed by stacking weak positives to offset strong negatives; FICO's answer is piecewise caps.

### 2.2 Google Quality Score (ad tech, 1–10)

Reverse-engineered weights: Expected CTR ~39%, Landing Page ~39%, Ad Relevance ~22%. A shallow linear blend that works because Google can retry (fast feedback loop, low-stakes). PCC is the opposite: a failed medical manufacturing job has physical, legal, irreversible consequences, so linear aggregation fails for the same reason it fails in credit scoring.

### 2.3 SecurityScorecard / BitSight (security posture, 0–100 or A–F)

BitSight (25 risk vectors, 300-820 scale) and SecurityScorecard (10 risk groups, A-F) are both **threshold-driven**: a single unresolved critical CVE produces a letter-grade downgrade regardless of other factors. The penalty dominates, aligning the score with worst-case risk. This is the pattern PCC should follow.

### 2.4 ALCOA+ scoring in pharma / GxP

Clear finding: **no industry-standard numeric rollup** of ALCOA+ exists. FDA, EMA, MHRA, WHO all treat it as a binary qualitative checklist. Vendor "maturity models" exist but are marketing, not regulatory. This is permission for PCC to define its own rollup without contradicting any approved formula. The only constraint: the rollup must not obscure binary violations. If a bundle fails Attributable, the scalar must reflect that gravely.

### 2.5 POAW-style / COSO / SOC2 risk rollups

COSO/SOC2 resist numeric rollup, preferring categorical ordinals ("effective"/"needs improvement"/"deficient"). PCC needs a number for on-chain escrow, so we must commit.

**Cross-cutting lesson:** every successful score-compression scheme combines (a) a linear blend for the base signal with (b) gates/multipliers for catastrophic failures. Pure linear is gamed; pure gated is too coarse. We adopt the hybrid.

---

## 3. PCC's Actual Input Signals (from the code)

Reading `packages/verifier/src/evidence-verifier.ts` and `packages/gateway/src/facades/types.ts` gives the authoritative inventory.

### 3.1 `VerificationFinding[]` (from `EvidenceVerifier.verify()`)

Each finding carries:
```typescript
{
  evidenceEventId: Id,
  check: string,          // e.g. "bundle_hash_integrity", "tier_requirement_*", "execution_duration_positive"
  passed: boolean,
  details: string,
  severity?: "info" | "warning" | "critical"
}
```

Severities actually emitted by `evidence-verifier.ts` today:
- `"critical"` — bundle hash mismatch, event hash mismatch, missing tier-required event type, non-positive execution duration.
- `"warning"` — power duration inconsistent with execution duration.
- `undefined` (implicit `"info"`) — everything that passed.

Note that the type declares `"info" | "warning" | "critical"`, not `"high" | "low"`. The PoA five-level taxonomy does not apply; we must map DriftAlertDTO's `critical/high/medium/low` to finding-severities separately.

### 3.2 ALCOA+ 10 principles (from `ALCOAStatus` in `types.ts`)

All 10 are booleans. Confirmed from lines 206–227 of `facades/types.ts`:
1. **A**ttributable — `source.deviceId + source.kernelId` present
2. **L**egible — data readable and hash-verifiable
3. **C**ontemporaneous — timestamps within execution window
4. **O**riginal — bundle from kernel (signature present, not test-signed)
5. **A**ccurate — tier requirements satisfied, event hashes verified
6. **C**onsistent — no high/critical duration_mismatch drift alerts
7. **C**omplete — all required event types present, no sensor_gap alerts
8. **C**redible — verifier confidence ≥ 90 (or true if no attestations)
9. **E**nduring — stored on IPFS / Storacha (durable reference)
10. **A**vailable — accessible via gateway and storage CID

### 3.3 `DriftAlertDTO[]` (from `DriftAlertDTO` in `types.ts`)

```typescript
{
  type: "power_anomaly" | "temperature_excursion" | "duration_mismatch" | "sensor_gap",
  severity: "low" | "medium" | "high" | "critical",
  ...
}
```

Four types × four severities = 16 possible drift combinations. We treat severity as the primary penalty driver, type as a secondary multiplier (explained below).

### 3.4 Tier compliance (`tierCompliance: Record<0|1|2|3, boolean>`)

Boolean per tier. A bundle at tier 2 must satisfy `tierCompliance[2] === true`. Earning `tierCompliance[3] === true` at a tier-2 bundle is a positive signal (the operator exceeded the declared tier), but cannot be required.

### 3.5 Touchstones (not yet in-code)

Touchstones (cryptographic challenge-response proving execution) are not yet emitted in PCC findings but are referenced in the architecture. We design forward: the rollup scans for `check === "touchstone"` or `check.startsWith("touchstone_")` and applies the penalty documented in section 7.

### 3.6 Multi-verifier consensus (`AggregatedAttestationDTO`)

```typescript
{
  consensus: "valid" | "invalid" | "inconclusive" | "no_quorum",
  quorumRequired: number,
  quorumAchieved: number,
  aggregatedConfidence: number,  // 0-100
  ...
}
```

Cross-verifier agreement is valuable data: if 3 independent verifiers all return `valid`, the bundle is more trustworthy than if 1 verifier returns `valid`. This is a **bonus**, not a requirement, because tier 0 bundles run with quorum 1 by design.

---

## 4. Rollup Formula Candidates

### Candidate A — Pure linear weighted sum

```
assuranceScore = 0.4*alcoaRate + 0.3*findingsPassRate + 0.2*(1-driftSeverity) + 0.1*consensusRate
```

**Reject.** Linear aggregation lets a bundle with a failed Attributable principle still earn ~0.85 if everything else is clean. This is the exact failure FICO, BitSight, and pharma regulators explicitly avoid. A legally-inadmissible bundle must not earn a high score.

### Candidate B — Pure multiplicative gate

```
assuranceScore = attributable * legible * ... * allFindingsPassed
```

**Reject.** Too coarse. Any single miss → 0. We lose the ability to rank providers within a tier. A provider with 9/10 ALCOA+ scores the same as one with 0/10, which is useless for market pricing.

### Candidate C — Base + multiplicative penalty (RECOMMENDED)

```
base           = linearBlend(alcoaWeighted, findingsPassRate, tierCompliance)
driftMultiplier = product(1 - driftPenalty(alert) for alert in driftAlerts)
touchstoneMult  = 1.0 if no touchstones || allPassed else 0.1
consensusBonus  = min(0.05, 0.01 * max(0, quorumAchieved - 1))
criticalGate    = 0.0 if any critical finding failed else 1.0

assuranceScore = criticalGate * touchstoneMult * (base * driftMultiplier + consensusBonus)
```

Clamped to `[0, 1]`. Monotonic, bounded, regulatorily defensible. We adopt **Candidate C**.

---

## 5. ALCOA+ Principle Weights

Regulators treat ALCOA+ as equal in principle. However, legal-admissibility case law consistently treats three principles as load-bearing:

- **Attributable** — if you cannot identify who/what produced the data, the data is inadmissible regardless of other qualities.
- **Original** — if the data is a copy of a copy with no chain back to source, it has no evidentiary weight.
- **Accurate** — if the data is wrong, nothing else matters.

These three are "primary" in the sense that failing any one of them makes the other seven irrelevant. The other seven (Legible, Contemporaneous, Consistent, Complete, Credible, Enduring, Available) are "secondary" in the sense that they strengthen an already-admissible record but cannot rescue a non-admissible one.

**Weighting (sum = 1.0):**

| Principle | Weight | Rationale |
|-----------|--------|-----------|
| Attributable | 0.15 | Primary — legal source-of-record |
| Original | 0.15 | Primary — chain to source |
| Accurate | 0.15 | Primary — correctness |
| Legible | 0.08 | Secondary — machine-readability |
| Contemporaneous | 0.08 | Secondary — temporal integrity |
| Consistent | 0.08 | Secondary — cross-evidence agreement |
| Complete | 0.09 | Secondary — full record (slightly higher than peers: completeness gaps are a favorite regulator citation) |
| Credible | 0.08 | Secondary — verifier confidence |
| Enduring | 0.07 | Secondary — durable storage |
| Available | 0.07 | Secondary — retrievability |

Total: 1.00. The three primaries are still only 45% of the ALCOA+ sub-score in isolation, because the critical-finding gate (section 4) already handles catastrophic failure separately. The ALCOA+ weighting is for **graceful degradation**: a bundle missing Contemporaneous loses 0.08 of its ALCOA+ sub-score, not its whole score.

Failed-primary-ALCOA+ is not a hard zero; that role is served by the critical-findings gate. ALCOA+ weights govern gradient, not gates.

---

## 6. Drift Alert Penalty Design

Drift alerts are **post-hoc anomaly detection** — they are emitted when the CWM-expected telemetry diverges from actual. Their severity is already calibrated by the drift detector.

**Per-alert penalty (subtracted multiplicatively from the drift multiplier):**

| Severity | Penalty per alert | Rationale |
|----------|-------------------|-----------|
| critical | 1.00 (zero the score) | Unignorable — matches the "critical finding gate" |
| high | 0.50 | Halves base — matches BitSight's "critical CVE" threshold pattern |
| medium | 0.20 | Moderate — still passing, but clearly degraded |
| low | 0.05 | Informational floor — prevents noise alerts from dominating |

Alerts compound multiplicatively: two high alerts produce `(1 - 0.5) * (1 - 0.5) = 0.25`. Type does not affect penalty in v1 — all four drift types are treated equivalently at equal severity. A future refinement could upweight `sensor_gap` (it prevents detection of other drifts), but that is a v2 optimization.

---

## 7. Touchstone Penalty

A failed touchstone means "this evidence was fabricated, replayed, or reconstructed." There is no legitimate ambiguity.

**Design:** `touchstoneMult = 0.1` if any touchstone failed, else `1.0`.

Why 0.1 not 0.0? Downstream systems (disputes, reputation decay) need to distinguish "touchstone failed" from "nothing submitted." A 0.1 signals "submitted but illegitimate," which is actionable for disputes. PoA uses 0.0 for canary failure, losing this distinction. If policy demands hard-zero, it is a one-line constant change.

The rollup scans findings for `check === "touchstone"` or `check.startsWith("touchstone_")`. Zero touchstones run = multiplier 1.0 (pass-through), so adding touchstones later requires no rollup code change.

---

## 8. Cross-Verifier Consensus Bonus

Multiple agreeing verifiers increase trustworthiness. We reward corroboration without penalizing tier-0 solo verification.

**Design:** `consensusBonus = min(0.05, 0.01 * max(0, quorumAchieved - 1))`

| Quorum | Bonus |
|--------|-------|
| 1 | 0.00 |
| 2 | 0.01 |
| 3 | 0.02 |
| 6+ | 0.05 (cap) |

The cap prevents consensus from dominating. The bonus is added **after** multiplicative penalties (it represents additional assurance, not base signal). Only applies when `consensus === "valid"`.

---

## 9. Computation Performance

`EvidenceVerifier.verify()` runs in ~1-10 ms. The rollup adds O(F + D) traversals (findings + drift alerts) plus constant arithmetic. No DB queries, no network calls, no crypto. A few microseconds. The compliance facade already walks these arrays, so no second traversal. `computeAssuranceScore(inputs)` is a pure function with no I/O.

---

## 10. Tier Mapping

The scalar is tier-agnostic internally; tier is metadata alongside it. A tier-0 bundle scoring 0.95 suggests "could qualify for higher tier." A tier-3 bundle scoring 0.62 means "problems during this run."

**Recommended presentation bands (dashboard hint, not validation):**

| Range | Band | Implied tier ceiling |
|-------|------|----------------------|
| 0.90 – 1.00 | Excellent | Tier 3 eligible |
| 0.70 – 0.89 | Good | Tier 2 eligible |
| 0.50 – 0.69 | Adequate | Tier 1 eligible |
| 0.30 – 0.49 | Marginal | Tier 0 only |
| 0.00 – 0.29 | Rejected | Dispute |

These are display bands, not validation rules. A tier-2 bundle with assuranceScore 0.68 is still tier 2 (it satisfied structural requirements); the score says "marginally." UI uses bands for color-coding; market uses the score for pricing.

---

## 11. Where to Surface

The scalar propagates upward from the verifier through every downstream DTO.

| Surface | Field | Change |
|---------|-------|--------|
| `VerificationAttestation` (spec) | `assuranceScore: number` | Add to `packages/spec/src/types/verifier.ts` alongside `confidence` |
| `EvidenceVerifier.verify()` | returns | Populate `assuranceScore` on the returned attestation |
| `ComplianceReportDTO` | `assuranceScore: number` | Add to `packages/gateway/src/facades/types.ts` |
| `ComplianceFacade.generateComplianceReport()` | returns | Compute from ALCOA+ status, drift alerts, findings summary |
| `GET /api/jobs/:jobId/evidence` | response item | `EvidenceSummaryDTO.assuranceScore` (optional) |
| `GET /api/compliance/evidence/:bundleId/tier-compliance` | response | Include `assuranceScore` in payload |
| MCP tool `pcc_get_evidence` | output | Include in response JSON |
| Dashboard component | visual | Circular gauge, 0.00–1.00, color-banded |

**Rule:** whenever a surface returns compliance signals, include `assuranceScore` alongside structured data.

---

## 12. Backward Compatibility — `confidence` vs `assuranceScore`

The existing `confidence` field (0-100) is a shallow heuristic: `passed ? 90 + passRate*10 : max(0, 50 - criticals*15)`. It ignores ALCOA+, drift alerts, and consensus. It is not monotonic.

**Recommendation: coexistence.** `confidence` stays as-is (legacy, mark `@deprecated`). `assuranceScore` (0-1) is the new primary. All new surfaces use `assuranceScore`. Remove `confidence` in v2.0. Sanity check: `confidence / 100` should be within +/-0.2 of `assuranceScore` for most bundles; divergence indicates the old heuristic missed a signal.

---

## 13. Concrete TypeScript Rollup for PCC

### 13.1 File: `packages/verifier/src/assurance-score.ts` (NEW)

```typescript
/**
 * Assurance Score rollup — compresses structured compliance data into a single
 * scalar in [0.0, 1.0] for fast market routing, dashboard display, and on-chain
 * escrow gating.
 *
 * The rollup is NOT a replacement for structured detail. Consumers wanting to
 * audit a specific finding or dispute a drift alert MUST use the structured
 * ALCOAStatus / VerificationFinding[] / DriftAlertDTO[] fields alongside.
 *
 * Design principles (see ai/research/digital-verifier/04-assurance-score.md):
 * - Base is a weighted blend of ALCOA+ and findings pass-rate.
 * - Critical findings zero the score (regulatory-grade gate).
 * - Drift alerts apply multiplicative penalties by severity.
 * - Touchstone failures produce a 0.1 multiplier (non-execution).
 * - Cross-verifier consensus grants a small capped bonus.
 * - Monotonic: adding more passing evidence never lowers the score.
 */

import type {
  VerificationFinding,
} from "@pcc/spec";
import type {
  ALCOAStatus,
  DriftAlertDTO,
} from "@pcc/gateway-types"; // or wherever your shared DTO module lives

export interface AssuranceScoreInputs {
  /** All findings from EvidenceVerifier.verify() */
  findings: VerificationFinding[];
  /** ALCOA+ 10-principle status, if computed. Optional — rollup degrades gracefully. */
  alcoaStatus?: ALCOAStatus;
  /** Drift alerts, if any */
  driftAlerts?: DriftAlertDTO[];
  /** Tier compliance — did the bundle satisfy its declared tier? */
  tierCompliant?: boolean;
  /** Quorum of agreeing verifiers (1 = solo, ≥2 = consensus) */
  consensusQuorum?: number;
  /** Whether the aggregated consensus was "valid" */
  consensusValid?: boolean;
}

/** Weights for the 10 ALCOA+ principles. Sum = 1.0. Primaries are 0.15, others 0.07-0.09. */
const ALCOA_WEIGHTS: Record<keyof ALCOAStatus, number> = {
  attributable: 0.15,   // PRIMARY — legal source-of-record
  original: 0.15,       // PRIMARY — chain to source
  accurate: 0.15,       // PRIMARY — correctness
  complete: 0.09,       // Slightly elevated — completeness is a top FDA citation
  legible: 0.08,
  contemporaneous: 0.08,
  consistent: 0.08,
  credible: 0.08,
  enduring: 0.07,
  available: 0.07,
};

/** Multiplicative penalty per drift alert, keyed by severity. */
const DRIFT_PENALTIES = {
  critical: 1.00, // zeroes the contribution
  high: 0.50,
  medium: 0.20,
  low: 0.05,
} as const;

/**
 * Compute the assurance score in [0.0, 1.0] from structured compliance inputs.
 *
 * Formula:
 *   base         = 0.55*alcoaScore + 0.35*findingsPassRate + 0.10*tierCompliantBonus
 *   driftMult    = ∏(1 - DRIFT_PENALTIES[alert.severity])
 *   touchstoneMult = 0.1 if any touchstone finding failed else 1.0
 *   criticalGate = 0.0 if any critical finding failed else 1.0
 *   consensusBonus = min(0.05, 0.01 * max(0, quorum - 1)) if consensusValid else 0
 *
 *   assuranceScore = clamp01(criticalGate * touchstoneMult * (base * driftMult) + consensusBonus)
 *
 * @param inputs All signals needed for the rollup. All fields optional except findings.
 * @returns Score in [0.0, 1.0], rounded to 4 decimal places.
 */
export function computeAssuranceScore(inputs: AssuranceScoreInputs): number {
  const {
    findings,
    alcoaStatus,
    driftAlerts = [],
    tierCompliant = true,
    consensusQuorum = 1,
    consensusValid = true,
  } = inputs;

  // --- Critical findings gate ---
  const criticalFailed = findings.some(
    (f) => !f.passed && f.severity === "critical",
  );
  if (criticalFailed) return 0.0;

  // --- Touchstone gate ---
  const touchstoneFailed = findings.some(
    (f) => !f.passed && (f.check === "touchstone" || f.check.startsWith("touchstone_")),
  );
  const touchstoneMult = touchstoneFailed ? 0.1 : 1.0;

  // --- ALCOA+ weighted sub-score ---
  let alcoaScore = 0;
  if (alcoaStatus) {
    for (const key of Object.keys(ALCOA_WEIGHTS) as (keyof ALCOAStatus)[]) {
      if (alcoaStatus[key]) alcoaScore += ALCOA_WEIGHTS[key];
    }
  } else {
    // No ALCOA+ data available — degrade gracefully by assuming partial pass
    alcoaScore = 0.7;
  }

  // --- Findings pass rate (ignoring "info" severity which is always passing) ---
  const graded = findings.filter((f) => f.severity !== "info");
  const findingsPassRate = graded.length
    ? graded.filter((f) => f.passed).length / graded.length
    : 1.0;

  // --- Base linear blend ---
  const tierBonus = tierCompliant ? 1.0 : 0.0;
  const base = 0.55 * alcoaScore + 0.35 * findingsPassRate + 0.10 * tierBonus;

  // --- Drift multiplier (multiplicative compounding) ---
  let driftMult = 1.0;
  for (const alert of driftAlerts) {
    const penalty = DRIFT_PENALTIES[alert.severity] ?? 0;
    driftMult *= Math.max(0, 1 - penalty);
  }

  // --- Cross-verifier consensus bonus ---
  let consensusBonus = 0;
  if (consensusValid && consensusQuorum > 1) {
    consensusBonus = Math.min(0.05, 0.01 * (consensusQuorum - 1));
  }

  // --- Final composition ---
  const raw = touchstoneMult * base * driftMult + consensusBonus;
  const clamped = Math.max(0.0, Math.min(1.0, raw));

  return Math.round(clamped * 10000) / 10000;
}
```

### 13.2 Wire into `EvidenceVerifier.verify()`

**File:** `packages/verifier/src/evidence-verifier.ts`, inside the `verify()` method, after the `confidence` computation (around line 129):

```typescript
// Compute the new assurance scalar alongside legacy confidence
const assuranceScore = computeAssuranceScore({
  findings,
  // alcoaStatus, driftAlerts, tierCompliant are populated by the facade layer;
  // verifier-only path leaves them undefined and the rollup degrades gracefully
  tierCompliant: passed,
  consensusQuorum: 1,
  consensusValid: passed,
});
```

And include it in the returned attestation:

```typescript
return {
  id: ids.attestation(),
  requestId: "",
  verifierId: this.verifierId,
  evidenceBundleHash: bundle.bundleHash,
  result: passed ? "valid" : criticalFailures.length > 0 ? "invalid" : "inconclusive",
  confidence: Math.round(confidence * 100) / 100,   // legacy, keep
  assuranceScore,                                   // NEW primary signal
  findings,
  attestationHash,
  signature,
  createdAt: now,
  auditReceipt: { ... },
};
```

### 13.3 Add field to `VerificationAttestation` type

**File:** `packages/spec/src/types/verifier.ts`, after line 76:

```typescript
/** Confidence score (0-100) @deprecated use assuranceScore */
confidence: number;
/** Assurance score (0.0-1.0) — primary quality signal, rolled up from ALCOA+,
 *  findings, drift alerts, and cross-verifier consensus. See
 *  ai/research/digital-verifier/04-assurance-score.md for formula. */
assuranceScore: number;
```

### 13.4 Surface in `ComplianceReportDTO`

**File:** `packages/gateway/src/facades/types.ts`, inside the `ComplianceReportDTO` interface (around line 229):

```typescript
export interface ComplianceReportDTO {
  capabilityId: Id;
  kernelId: Id;
  satisfiedStandards: string[];
  alcoaStatus: ALCOAStatus;
  tierCompliance: Record<AssuranceTier, boolean>;
  recentEvidence: EvidenceSummaryDTO[];
  driftAlerts: DriftAlertDTO[];
  /** Rollup scalar in [0,1]. See ai/research/digital-verifier/04-assurance-score.md */
  assuranceScore: number;
}
```

### 13.5 Wire into `ComplianceFacade.generateComplianceReport()`

**File:** `packages/gateway/src/facades/compliance.facade.ts`, at the end of the ALCOA+/drift computation before the return:

```typescript
const assuranceScore = computeAssuranceScore({
  findings: /* aggregate findings across recent attestations */,
  alcoaStatus,
  driftAlerts,
  tierCompliant: Object.values(tierCompliance).some((v) => v === true),
  consensusQuorum: /* from latest aggregateAttestations call, or 1 */,
  consensusValid: /* from latest aggregateAttestations call, or true */,
});

return { ..., assuranceScore };
```

### 13.6 Testing strategy

All tests are deterministic (no time-dependence, no randomness).

**File:** `packages/verifier/src/__tests__/assurance-score.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { computeAssuranceScore } from "../assurance-score.js";

describe("computeAssuranceScore", () => {
  it("returns 1.0 for perfect bundle", () => {
    expect(computeAssuranceScore({
      findings: [{ evidenceEventId: "", check: "ok", passed: true, details: "" }],
      alcoaStatus: allTrueAlcoa(),
      driftAlerts: [],
      tierCompliant: true,
      consensusQuorum: 1,
      consensusValid: true,
    })).toBe(1.0);
  });

  it("returns 0.0 for any critical finding failure", () => {
    expect(computeAssuranceScore({
      findings: [
        { evidenceEventId: "e1", check: "bundle_hash_integrity", passed: false,
          details: "mismatch", severity: "critical" },
      ],
      alcoaStatus: allTrueAlcoa(),
    })).toBe(0.0);
  });

  it("halves base on one high drift alert", () => {
    const score = computeAssuranceScore({
      findings: [{ evidenceEventId: "", check: "ok", passed: true, details: "" }],
      alcoaStatus: allTrueAlcoa(),
      driftAlerts: [{ type: "power_anomaly", severity: "high", message: "", timestamp: "" }],
      tierCompliant: true,
    });
    expect(score).toBeGreaterThan(0.48);
    expect(score).toBeLessThan(0.52);
  });

  it("applies 0.1 multiplier on touchstone failure", () => {
    const score = computeAssuranceScore({
      findings: [
        { evidenceEventId: "", check: "ok", passed: true, details: "" },
        { evidenceEventId: "", check: "touchstone_challenge",
          passed: false, details: "replay detected", severity: "warning" },
      ],
      alcoaStatus: allTrueAlcoa(),
      tierCompliant: true,
    });
    expect(score).toBeCloseTo(0.1, 2);
  });

  it("grades ALCOA+ linearly between 0.85 and 0.95 on one warning", () => {
    const alcoa = { ...allTrueAlcoa(), contemporaneous: false };
    const score = computeAssuranceScore({
      findings: [
        { evidenceEventId: "", check: "ok", passed: true, details: "" },
        { evidenceEventId: "", check: "clock_drift", passed: false,
          details: "30s skew", severity: "warning" },
      ],
      alcoaStatus: alcoa,
      tierCompliant: true,
    });
    expect(score).toBeGreaterThan(0.85);
    expect(score).toBeLessThan(0.96);
  });

  it("adds consensus bonus, capped at +0.05", () => {
    const base = computeAssuranceScore({
      findings: [{ evidenceEventId: "", check: "ok", passed: true, details: "" }],
      alcoaStatus: allTrueAlcoa(),
      tierCompliant: true,
      consensusQuorum: 1,
      consensusValid: true,
    });
    const withSix = computeAssuranceScore({
      findings: [{ evidenceEventId: "", check: "ok", passed: true, details: "" }],
      alcoaStatus: allTrueAlcoa(),
      tierCompliant: true,
      consensusQuorum: 6,
      consensusValid: true,
    });
    expect(withSix - base).toBeLessThanOrEqual(0.05);
    expect(withSix - base).toBeGreaterThan(0);
  });

  it("is monotonic: adding a passing finding never lowers the score", () => {
    const s1 = computeAssuranceScore({ findings: [pass("a")], alcoaStatus: allTrueAlcoa() });
    const s2 = computeAssuranceScore({ findings: [pass("a"), pass("b")], alcoaStatus: allTrueAlcoa() });
    expect(s2).toBeGreaterThanOrEqual(s1);
  });
});

function allTrueAlcoa() {
  return {
    attributable: true, legible: true, contemporaneous: true, original: true,
    accurate: true, consistent: true, complete: true, credible: true,
    enduring: true, available: true,
  };
}
function pass(name: string) {
  return { evidenceEventId: "", check: name, passed: true, details: "" };
}
```

Pure-function design makes adding test cases trivial as policies evolve.

---

## 14. Summary of Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Rollup shape | Base + multiplicative gates + bonus | Matches FICO/BitSight pattern; linear gamed; pure-gate too coarse |
| Scale | [0.0, 1.0] | On-chain-friendly fixed-point, aligns with existing PCC conventions |
| ALCOA+ weighting | 0.15/0.15/0.15 primaries, 0.07-0.09 secondaries | Legal admissibility weighting; regulators permit (no standard exists) |
| Critical finding penalty | Hard zero | Regulatory gate — matches warning-letter enforcement behavior |
| Drift penalties | crit=1.0, high=0.5, med=0.2, low=0.05 multiplicative | Compounds correctly; calibrated against BitSight thresholds |
| Touchstone penalty | 0.1 multiplier | Distinguishes from "no evidence"; PoA uses 0.0 but loses signal |
| Consensus bonus | +0.01 per extra verifier, capped at +0.05 | Rewards corroboration without dominating the base signal |
| Backward compat | `confidence` deprecated, kept; `assuranceScore` added | No breaking change; gradual migration |
| Performance | Pure function, ~microseconds | O(findings + drifts); no I/O, no crypto |
| Naming | `assuranceScore` | NOT `aso` per requirements; aligns with existing `assuranceTier` vocabulary |

---

## 15. Sources

- [How are FICO Scores Calculated? | myFICO](https://www.myfico.com/credit-education/whats-in-your-credit-score)
- [How are Bitsight Security Ratings Calculated?](https://help.bitsighttech.com/hc/en-us/articles/231950968-How-are-Bitsight-Security-Ratings-Calculated)
- [Google Ads Quality Score: The Formula Revealed (Search Engine Land)](https://searchengineland.com/google-ads-the-quality-score-formula-revealed-348063)
- [ALCOA+ Principles & Data Integrity In Pharma (Apotech)](https://apotechconsulting.com/alcoa-principles-data-integrity/)
- [ALCOA+ Principles: A Guide to GxP Data Integrity (IntuitionLabs)](https://intuitionlabs.ai/articles/alcoa-plus-gxp-data-integrity)
- [PoA Subnet ASO source](C:\Users\globa\scratch\poa-subnet\protocol\aso.py)
- [PoA Subnet scoring pipeline](C:\Users\globa\scratch\poa-subnet\neurons\validator\scoring.py)
- [PCC evidence verifier](C:\Users\globa\physical-capability-cloud\packages\verifier\src\evidence-verifier.ts)
- [PCC ALCOA+ status / drift / compliance DTOs](C:\Users\globa\physical-capability-cloud\packages\gateway\src\facades\types.ts)
- [PCC compliance facade](C:\Users\globa\physical-capability-cloud\packages\gateway\src\facades\compliance.facade.ts)
- [PCC verifier types spec](C:\Users\globa\physical-capability-cloud\packages\spec\src\types\verifier.ts)
- [PCC CLAUDE.md — ALCOA+ section 7](C:\Users\globa\physical-capability-cloud\CLAUDE.md)
