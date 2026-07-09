/**
 * Evidence-primitive vocabulary (evidence-vocabulary v1).
 *
 * - primitives.ts        — the 16 v1 primitive defs + manifest hash + lookups.
 * - eligibility.ts       — the tier-eligibility lint (spec §5), report-only.
 * - verifier-interface.ts — the oracle-side PrimitiveVerifier contract (§5.4).
 *
 * See ai/research/pcc-evidence-vocabulary-v1.md for the full design.
 */
export * from "./primitives.js";
export * from "./eligibility.js";
export * from "./verifier-interface.js";
