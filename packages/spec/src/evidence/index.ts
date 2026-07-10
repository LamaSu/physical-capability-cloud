/**
 * Evidence-primitive vocabulary (evidence-vocabulary v1).
 *
 * - primitives.ts        — the 16 v1 primitive defs + manifest hash + lookups.
 * - eligibility.ts       — the tier-eligibility lint (spec §5), report-only.
 * - verifier-interface.ts — the oracle-side PrimitiveVerifier contract (§5.4).
 * - verifiers/           — shared, extracted verifier predicates (drift/envelope
 *                          + log-chain) consumed by BOTH the gateway compliance
 *                          facade and the oracle settlement lane.
 *
 * - emitter-manifest.ts  — the SUPPLY-side declaration (which primitives an
 *                          adapter/device/process EMITS) + the manifest→CSD
 *                          evidence bridge.
 * - adapter-manifests.ts — default emitter manifests per adapter type + role.
 *
 * See ai/research/pcc-evidence-vocabulary-v1.md (v1),
 * ai/research/pcc-evidence-vocab-sensor-machinelog.md (v1.5-industrial), and
 * ai/research/pcc-evidence-onboarding-pattern.md (supply-side onboarding) for
 * the full design.
 */
export * from "./primitives.js";
// isFabricated / bundleHasFabricatedEvents — the ONE canonical fabricated-evidence
// predicate, read by every detector site (ALCOA, settlement, tier gate, oracle).
export * from "./is-fabricated.js";
export * from "./eligibility.js";
export * from "./verifier-interface.js";
export * from "./verifiers/index.js";
export * from "./emitter-manifest.js";
export * from "./adapter-manifests.js";
