/**
 * Evidence-primitive vocabulary (evidence-vocabulary v1).
 *
 * - primitives.ts        — the primitive defs + manifest hash + lookups.
 * - eligibility.ts       — the tier-eligibility lint (spec §5), report-only.
 * - verifier-interface.ts — the oracle-side PrimitiveVerifier contract (§5.4).
 * - verifiers/           — shared, extracted verifier predicates (drift/envelope
 *                          + log-chain) consumed by BOTH the gateway compliance
 *                          facade and the oracle settlement lane.
 *
 * See ai/research/pcc-evidence-vocabulary-v1.md (v1) and
 * ai/research/pcc-evidence-vocab-sensor-machinelog.md (v1.5-industrial) for the
 * full design.
 */
export * from "./primitives.js";
export * from "./eligibility.js";
export * from "./verifier-interface.js";
export * from "./verifiers/index.js";
