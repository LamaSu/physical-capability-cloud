/**
 * Oracle-binding SEAM for the industrial primitives (#52–#55).
 *
 * This is the "interface + stub" seam ONLY (evidence-vocab §8 stub policy). The
 * REAL PrimitiveVerifier binding — wrapping the extracted predicates into oracle
 * verifiers — is the settlement lane's work (Opus lane; coordinate via bulletins
 * #291/#293). It is deliberately NOT implemented here.
 *
 * Until the settlement lane binds them, each industrial primitive resolves to a
 * fail-CLOSED stub (`makeStubVerifier`): `met:false`, never a silent pass. This
 * matches `verifierStatus:"stub"` on the four defs in `primitives.ts` and the
 * `requireImplementedVerifier` cap in `eligibility.ts` — a sensor/machine-log CSD
 * is tier-eligible in the REPORT-ONLY lint, but capped under oracle enforcement
 * until the real verifier ships.
 *
 * When the settlement lane implements the real binding, it replaces each stub
 * with a verifier that calls:
 *   - #52 machine.execution_log       → `verifyLogChain` (+ #47 registered-key
 *                                        check as the injected signature verifier,
 *                                        + logKind-specific bindings)
 *   - #53 telemetry.envelope_conformance → `detectDrifts` (power/temp/duration
 *                                        envelope, parameterized) → met ⇔ zero
 *                                        alerts ≥ severityFloor
 *   - #54 telemetry.coverage_gate      → `detectDrifts` (sensor_gap leg) as a
 *                                        negative gate
 *   - #55 process.batch_record         → composition glue over #52/#53/#54 + the
 *                                        existing event-sequence rule
 */

import { makeStubVerifier, type PrimitiveVerifier } from "../verifier-interface.js";

/** The ids of the four industrial primitives added in the v1.5-industrial cut. */
export const INDUSTRIAL_PRIMITIVE_IDS = [
  "machine.execution_log", // #52
  "telemetry.envelope_conformance", // #53
  "telemetry.coverage_gate", // #54
  "process.batch_record", // #55
] as const;

export type IndustrialPrimitiveId = (typeof INDUSTRIAL_PRIMITIVE_IDS)[number];

/**
 * Fail-closed stub verifiers for the industrial primitives, keyed by id. The
 * settlement lane replaces entries here with real PrimitiveVerifiers. Consuming
 * this map (rather than a silent absence) guarantees an unbound industrial
 * primitive resolves to `met:false`, never an accidental pass (§8).
 */
export function industrialVerifierStubs(): Record<IndustrialPrimitiveId, PrimitiveVerifier> {
  return {
    "machine.execution_log": makeStubVerifier("machine.execution_log"),
    "telemetry.envelope_conformance": makeStubVerifier("telemetry.envelope_conformance"),
    "telemetry.coverage_gate": makeStubVerifier("telemetry.coverage_gate"),
    "process.batch_record": makeStubVerifier("process.batch_record"),
  };
}
