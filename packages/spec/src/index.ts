export * from "./types/index.js";
export * from "./schemas/index.js";
export { canonicalize, sha256, hashBundle, hashEvent, verifyBundleHash, verifyEventHash } from "./util/canonical.js";
export { ids, generateId } from "./util/ids.js";
// Identity types and browser-safe functions (no node:crypto)
export * from "./identity/types.js";
// ERC-8004 types (browser-safe)
export * from "./identity/erc8004.js";
// Ephemeral identity types (browser-safe — sessionKey / principalKey)
export * from "./identity/ephemeral.js";
// CSD (Capability StructureDefinition) — schema, types, and registry
export * from "./csd/index.js";
// Test fixtures (Week 9 D) — re-exported under a sub-path namespace.
// Importing from the root `@pcc/spec` does NOT pull these in; consumers
// must use the explicit subpath `@pcc/spec/test-fixtures/capability` so
// production builds don't ship test boilerplate.
export type {
  SettleableSessionFixture as TestSettleableSessionFixture,
  BuildTestSessionInput as TestBuildSessionInput,
} from "./test-fixtures/capability.js";
