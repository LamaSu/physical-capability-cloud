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
// evidenceLevelOf / evidenceLevelOfBundle — submitted / device_reported /
// inspected_output, the one classification of how strongly evidence shows the
// work was done (must-close 5).
export * from "./evidence-level.js";
// Committed programs per (CSD, tier) + the pre-funding gate: non-zero assurance
// binds the exact program for its tier, and the program must release on what
// the tier promises (must-close 6).
// An explicit list, not `export *`: `assertAcceptedProgramForTierWith` (the
// test-only form that takes a registry and a primitive index) and its options
// type must stay off the package's public surface, and `export *` would
// re-export them. committed-program.test.ts asserts that every other export of
// the module is re-exported here, so a new public export cannot be forgotten.
export {
  COMMITTED_PROGRAM_REGISTRY,
  COMMITTED_STAGE_PREDICATES,
  PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM,
  PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM_HASH,
  PRINT_AND_MAIL_INDEPENDENCE_PROGRAM,
  PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH,
  REGISTRY_BACKED_PRIMITIVES,
  assertAcceptedProgramForTier,
  checkCommittedProgramForTier,
  computeCommittedProgramHash,
  requiredRegistryPins,
  resolveAcceptedProgram,
  tierNumber,
} from "./committed-program.js";
export type {
  AcceptedProgramGateInput,
  AcceptedProgramGateResult,
  CommittedProgram,
  CommittedProgramEntry,
  CommittedStage,
  CommittedStagePredicate,
  RequiredRegistryPin,
  ResolvedProgram,
  TierAssuranceCheck,
  TierAssuranceViolation,
} from "./committed-program.js";
export * from "./eligibility.js";
export * from "./verifier-interface.js";
export * from "./verifiers/index.js";
export * from "./emitter-manifest.js";
export * from "./adapter-manifests.js";
