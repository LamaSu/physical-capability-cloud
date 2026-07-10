/**
 * Drift Detector — gateway entry point.
 *
 * The implementation was EXTRACTED into `@pcc/spec` (evidence/verifiers/
 * drift-predicates) so the oracle settlement lane can call the exact same code
 * (evidence-vocab primitives #53 telemetry.envelope_conformance, #54
 * telemetry.coverage_gate). This file is now a thin adapter that re-exports the
 * shared predicate and preserves the gateway's `DriftAlertDTO[]` contract.
 *
 * Behavior is byte-identical to the pre-extraction implementation — the full
 * `__tests__/drift-detector.test.ts` suite continues to pass against this
 * re-export, and `@pcc/spec`'s `verifier-parity.test.ts` pins the extraction
 * with golden fixtures. `DriftAlert` (spec) and `DriftAlertDTO` (below) are
 * structurally identical, so the shared `detectDrifts` result satisfies the
 * DTO contract with no mapping.
 */

import { detectDrifts as detectDriftsShared, type DriftDetectionContext } from "@pcc/spec";
import type { DriftAlertDTO } from "./types.js";

export type { DriftDetectionContext } from "@pcc/spec";

/**
 * Run all drift checks against the provided context. Returns an array of
 * DriftAlertDTOs (empty = no drift detected). Never throws — errors are silently
 * skipped to keep compliance checks non-fatal.
 *
 * Delegates to the shared `@pcc/spec` predicate; the returned `DriftAlert[]` is
 * structurally the gateway's `DriftAlertDTO[]`.
 */
export function detectDrifts(ctx: DriftDetectionContext): DriftAlertDTO[] {
  return detectDriftsShared(ctx);
}
