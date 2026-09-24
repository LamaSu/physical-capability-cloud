/**
 * @pcc/spec economics — economic agreements v1 (docs/ECONOMIC_AGREEMENTS.md).
 *
 * One deterministic compiler from plain economic terms and pinned licenses to exact V-next per-unit
 * payouts. Rights and payments are separate facts with separate hashes. It reuses PCC's existing
 * primitives (rate schedules, CompositionManifest, TrainingManifest, contributor roles) as inputs and
 * produces only what the V-next escrow already funds; it is not a second settlement system.
 */

export * from "./types.js";
export * from "./exact.js";
export * from "./refusals.js";
export {
  AGREEMENT_DOMAIN,
  ECONOMIC_TERMS_DOMAIN,
  RIGHTS_TERMS_DOMAIN,
  domainHash,
  hashNormalizedAgreement,
  normalizeAgreement,
  type AgreementHashes,
} from "./hash.js";
export * from "./compile.js";
export * from "./verify.js";
export * from "./simulate.js";
export * from "./bind.js";
export * from "./adapters.js";
export * from "./examples.js";
