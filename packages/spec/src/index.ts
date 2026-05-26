export * from "./types/index.js";
export * from "./schemas/index.js";
export { canonicalize, sha256, hashBundle, hashEvent, verifyBundleHash, verifyEventHash } from "./util/canonical.js";
export { ids, generateId } from "./util/ids.js";
// PLR backend-author registry helpers (ADR-PLR-1)
export {
  canonicalizeBackendManifest,
  deriveBackendIpId,
  manifestCid,
  sumAuthorBps,
  validateAuthorGroupBps,
  isStructurallyValidBackendManifest,
  addressToDelegatedAgentBytes32,
  delegatedAgentBytes32ToAddress,
} from "./util/plr-backend-manifest.js";
// Identity types and browser-safe functions (no node:crypto)
export * from "./identity/types.js";
// ERC-8004 types (browser-safe)
export * from "./identity/erc8004.js";
// Ephemeral identity types (browser-safe — sessionKey / principalKey)
export * from "./identity/ephemeral.js";
// CSD (Capability StructureDefinition) — schema, types, and registry
export * from "./csd/index.js";
// ROLE_TAGS — single-source-of-truth keccak256 hashes for ContributorRole
// (off-chain TS side; on-chain Solidity side codegen'd into RoleTags.sol)
export * from "./payouts.js";
