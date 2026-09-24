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
// signingPreimage / sessionKeyDelegationPreimage — the ONE LO-EV-1 signing byte
// contract every Ed25519 producer and consumer of evidence builds its message from.
export * from "./signing-preimage.js";
// verifyEvidenceSubjectBinding — LO-EV-9: a signed bundle digest must open to
// events that commit the job, the accepting kernel and (when known) the output.
export * from "./subject-binding.js";
// evidenceLevelOf / evidenceLevelOfBundle — submitted / device_reported /
// inspected_output, the one classification of how strongly evidence shows the
// work was done (must-close 5).
export * from "./evidence-level.js";
export * from "./eligibility.js";
export * from "./measurement-profile.js";
// profileAdmitsBundle — does authenticated, bound evidence satisfy the committed
// MeasurementProfile (level, device, version, window, samples, simulation)?
export * from "./profile-admission.js";
export * from "./verifier-interface.js";
export * from "./verifiers/index.js";
export * from "./emitter-manifest.js";
export * from "./adapter-manifests.js";
