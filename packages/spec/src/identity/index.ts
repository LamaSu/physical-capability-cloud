/**
 * Identity module — W3C DIDs and Verifiable Credentials for PCC.
 *
 * This barrel exports EVERYTHING (types + Node.js crypto functions).
 * For browser-safe imports, use the types from the main @pcc/spec barrel
 * which only re-exports types and validation functions.
 */

// Browser-safe types and validation functions
export {
  // Types
  type DIDString,
  type DIDDocument,
  type VerificationMethod,
  type ServiceEndpoint,
  type DIDKeyPair,
  type PCCEntityType,
  type CapabilityCredential,
  type CapabilitySubject,
  type CredentialProof,
  type IssueCredentialOptions,
  // Browser-safe functions (no node:crypto)
  isValidDID,
  isValidKeyDID,
  isValidPCCDID,
  createPCCDID,
  parsePCCDID,
  buildDIDDocument,
  isValidCredentialStructure,
} from "./types.js";

// Node.js-only crypto functions
export {
  createKeyDID,
  deriveKeyDID,
} from "./did.js";

export {
  issueCapabilityCredential,
  signCredential,
  verifyCredential,
} from "./credentials.js";

// ERC-8004 types (browser-safe)
export * from "./erc8004.js";

// Ephemeral identity types (browser-safe — sessionKey / principalKey)
export * from "./ephemeral.js";
