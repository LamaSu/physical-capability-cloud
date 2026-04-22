# CVP → ALCOA+ Integration

**Status:** Wired at Wave 1 (AssuranceScore), deferred full ALCOA+ report wiring.
**Branch:** `capture-verification-protocol`

## What's already wired

`@pcc/verifier/workflow/assurance-score.ts` takes `captureClass` as an input and
boosts the scalar rollup when CC1+ is present. This happens on every bundle
verification call and propagates to `AssuranceScoreInput.captureClass` on any
caller that passes it.

See `packages/verifier/src/workflow/assurance-score.ts:55` for the
`captureClass` multiplier.

## What's deferred

Cross-facade wiring from `captureVerdicts` table → `ComplianceReportDTO` fields.
When a job has an associated PASS capture verdict with `verifiedClass >= CC1`,
three ALCOA+ flags should tighten:

| ALCOA+ field | Current | With CVP integration |
|---|---|---|
| **accurate** | `tierCompliance.compliant` | AND (no CC0 captures for tier 2+) |
| **credible** | `true` (assumed) | verifier confidence ≥ 90 AND PASS verdict rate ≥ 0.9 |
| **original** | `kernelSignature.signer != 0x0` | AND (`anchorCandidate = true` when tier ≥ 2) |

## Integration sketch

```typescript
// packages/gateway/src/facades/compliance.facade.ts

import { schema, eq } from "@pcc/store";
const { captureVerdicts } = schema;

private async loadCaptureVerdictsForJob(jobId: string) {
  return this.store.db.select()
    .from(captureVerdicts)
    .where(eq(captureVerdicts.jobId, jobId))
    .all();
}

private computeAlcoaWithCapture(bundles: BundleWithEvents[]): ALCOAStatus {
  const base = this.computeAlcoa(bundles);
  const allVerdicts = bundles.flatMap(b =>
    b.raw.jobId ? this.loadCaptureVerdictsForJob(b.raw.jobId) : []);

  if (allVerdicts.length === 0) return base;

  const passRate = allVerdicts.filter(v => v.verdict === "PASS").length
                   / allVerdicts.length;
  const allAnchorCandidates = allVerdicts.every(v => v.anchorCandidate === 1);
  const noCC0ForTier2 = bundles.every(b =>
    (b.raw.assuranceTier ?? 0) < 2 ||
    !allVerdicts.some(v => v.jobId === b.raw.jobId && v.verifiedClass === 0),
  );

  return {
    ...base,
    accurate: base.accurate && noCC0ForTier2,
    credible: base.credible && passRate >= 0.9,
    original: base.original && allAnchorCandidates,
  };
}
```

## Why deferred

- `ComplianceFacade` doesn't currently access the `store` object directly —
  it goes through `repos.*` which doesn't expose `captureVerdicts`.
- Adding a new repo method (`repos.evidence.findCaptureVerdictsByJob()`) +
  refactoring the ALCOA+ helper is a ~1-day task that's bigger than the rest
  of Wave 5.
- The underlying data IS captured on every `/api/capture/upload` — the table
  is populated, just not yet joined in the compliance report.

## Unblocking work

1. Add `findCaptureVerdictsByJob(jobId: string)` to the evidence repo.
2. Extend `BundleWithEvents` → `BundleWithCaptureContext` to include verdicts.
3. Switch `computeAlcoa` call-site to `computeAlcoaWithCapture`.
4. Add a `captureVerification` field to `ComplianceReportDTO` exposing
   verdict counts + PASS rate for the dashboard.
5. Test: `describe("ALCOA+ with capture verdicts")` in
   `compliance-facade.test.ts` with fixtures for PASS / FAIL / mixed /
   missing-verdicts.

Estimated: 4h implementation + 2h tests. Tracked as Wave 6 follow-up.
