/**
 * Shared, importable verifier predicates for the evidence-primitive vocabulary.
 *
 * These are the EXTRACTED, behavior-identical homes of machinery that was
 * already built and tested elsewhere in the monorepo — relocated here so BOTH
 * the gateway compliance facade AND the oracle settlement lane call the same
 * code (design §8 rollout #3). No new verification logic is introduced.
 *
 *   - drift-predicates.ts — detectDrifts + envelope/coverage sub-checks
 *                           (from packages/gateway/src/facades/drift-detector.ts).
 *                           Powers #53 telemetry.envelope_conformance,
 *                           #54 telemetry.coverage_gate.
 *   - log-chain.ts        — verifyLogChain + computeLogEntryHash
 *                           (from packages/kernel/src/log-capture-service.ts).
 *                           Powers #52 machine.execution_log.
 *   - oracle-binding.ts   — the fail-closed STUB seam for #52–#55; the real
 *                           PrimitiveVerifier binding is the settlement lane.
 *   - registered-signer.ts — the algorithm-tagged RegisteredSigner (Option C):
 *                           the signing key the gateway registry proves + serves
 *                           on KernelDTO.signingKey and the #52 verifier matches
 *                           each log entry's kernelSignature against.
 */
export * from "./drift-predicates.js";
export * from "./log-chain.js";
export * from "./oracle-binding.js";
export * from "./registered-signer.js";
