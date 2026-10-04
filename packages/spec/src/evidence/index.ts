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
// kernelPullCaptureIssue / KERNEL_PULL_CAPTURE_TYPES — the closed LO-SE-1 contract a
// camera event must meet to count toward an assurance tier (astra pack 155 HIGH 1).
export * from "./kernel-pull-capture.js";
// signingPreimage / sessionKeyDelegationPreimage — the ONE LO-EV-1 signing byte
// contract every Ed25519 producer and consumer of evidence builds its message from.
export * from "./signing-preimage.js";
// verifyEvidenceSubjectBinding — LO-EV-9: a signed bundle digest must open to
// events that commit the job, the accepting kernel and (when known) the output.
export * from "./subject-binding.js";
// evidenceLevelOfBundles / evidenceLevelsOfEvents / deriveContradictions /
// inspectionVerdict — submitted / device_reported / inspected_output, the one
// classification of how strongly evidence shows the work was done (must-close 5).
// Takes authenticated bundles of ONE settlement unit and judges independence
// between authenticated trust domains, never declared device ids.
// evidenceLevelsOfEvents is the per-event level (bundle index, event index,
// level); evidenceLevelOfBundles is the maximum over it.
export * from "./evidence-level.js";
export * from "./delegation-rules.js";
export * from "./eligibility.js";
export * from "./measurement-profile.js";
// Principal ids for FinalMilestonePackageV2: operator = CAIP-10 (D1 signer),
// device = ed25519:0x<key> (D2 signer, registry-held, never a compromised key).
export * from "./principal-id.js";
export * from "./verifier-interface.js";
export * from "./verifiers/index.js";
export * from "./emitter-manifest.js";
export * from "./adapter-manifests.js";
// acceptedPolicyDigest — the PUBLIC producer the V-next escrow's CREATE2 policy salt needs
// (composition's accept route #391, escrow's encoder #367); byte-exact with the #270 mirror.
export * from "./accepted-policy.js";
