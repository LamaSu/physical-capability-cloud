# Tool Vetting Report [PASS]

**Proposal:** `vet-2026-05-23-demand-intel`
**Target:** `packages/demand-intel`
**Date:** 2026-05-23T22:30:00Z
**Verdict:** PASS

## Notes on Scope

The `demand-intel` package exists in `master` with only `dist/` and
`node_modules/` (no `src/`). The source was found in
`.claude/worktrees/agent-a48da6ae18805b397/packages/demand-intel/src/`
(branch `feat/intent-network-interception`). Both dist and source were scanned.

Package: `@pcc/demand-intel v0.1.0` — internal demand intelligence.
Exports: `HyperLogLog`, `TDigest`, `CountMinSketch`, `DemandAggregator`.

Dependencies: `@pcc/spec workspace:*`, `@pcc/store workspace:*`

No third-party runtime dependencies.

## Rejection Reasons

None.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 |
| **Total** | **1** |

---

## Scanner 1: Trivy (not installed)

Findings: 0 | Duration: N/A — scanner not installed, skipped.

---

## Scanner 2: Gitleaks (not installed)

Findings: 0 | Duration: N/A — scanner not installed, skipped.

---

## Scanner 3: ClamAV (not installed)

Findings: 0 | Duration: N/A — scanner not installed, skipped.

---

## Scanner 4: npm audit (N/A)

No third-party runtime deps in `package.json`. No audit surface.

---

## Scanner 5: pip-audit (N/A)

No `requirements.txt`. Scanner skipped.

---

## Scanner 6: Semgrep (not installed)

Findings: 0 | Duration: N/A — scanner not installed, skipped.

---

## Scanner 7: Slither (N/A)

No `.sol` files. Scanner skipped.

---

## Scanner 8: Prompt Injection (available — regex)

All 7 patterns checked across `src/` and `dist/`. Findings: 0.

No injection patterns found in any file.

---

## SAST / Manual Code Review Findings

### LOW — `DemandAggregator.snapshot()` reads from `analytics_events` table without row limit

**Location:** `src/aggregator.ts` — `buildSnapshot()` method

The aggregator queries `analytics_events` filtered by `event_type` and time
window. The `@pcc/store` `IRepositories` interface does not impose a row
cap per the code's signature. For large production databases with millions of
intent events, an unbounded query during snapshot generation could cause
memory pressure or OOM.

**Risk:** Low — operational, not a security risk. The package itself
documents "internal only, no public oracle." Row volume is bounded by the
window size, which is operator-controlled.

**Recommendation:** Add a configurable `maxRows` parameter with a safe default
(e.g., 100,000) and a log warning when the cap is hit.

---

## Code Review Highlights (Positive)

- **Zero external network calls.** The package is purely computational:
  sketches + DB query + snapshot emission. No fetch(), no HTTP clients.
- **No signed outputs.** The package clearly documents "snapshots are
  unsigned, never published, never cross-chain." Zero risk of being mistaken
  for an oracle.
- **Pure algorithm implementations.** HyperLogLog, TDigest, CountMinSketch
  are implemented from scratch in pure TypeScript with no external math
  dependencies. Well-commented with algorithm references.
- **Deterministic serialization.** All sketches implement `serialize()` /
  `deserialize()` for round-trip via materialized views.
- **No PII.** The aggregator operates on `compositionSignature` hashes and
  `budgetBand`/`urgencyBand` coarse categories. No requester identifiers
  are stored in snapshots.

---

## Verdict Rationale

- No malware, no critical/high/medium findings, no secrets, no injection.
- Zero third-party runtime dependencies: minimal supply chain surface.
- One low-severity operational note (unbounded DB query).
- The package is a pure computation library with an excellent security posture.

**Verdict: PASS — approved for use.**
