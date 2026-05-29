/**
 * W3C DID Core + Verifiable Credentials type definitions.
 *
 * Refs:
 *   https://www.w3.org/TR/did-core/
 *   https://www.w3.org/TR/vc-data-model/
 */

/**
 * A verification method in a DID document.
 * Describes a public key (or other proof) controllers can use to authenticate.
 *
 * Ref: https://www.w3.org/TR/did-core/#verification-methods
 */
export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  /** Hex-encoded EC public key (uncompressed or compressed). */
  publicKeyHex?: string;
  /** Base58btc-encoded public key (multibase format). */
  publicKeyMultibase?: string;
  /** JSON Web Key representation. */
  publicKeyJwk?: Record<string, unknown>;
  /** EIP-1271 / EIP-55 — Ethereum-flavored verification methods carry an address. */
  blockchainAccountId?: string;
}

/**
 * A service endpoint in a DID document.
 *
 * Ref: https://www.w3.org/TR/did-core/#services
 */
export interface ServiceEndpoint {
  id: string;
  type: string | string[];
  serviceEndpoint: string | Record<string, unknown> | (string | Record<string, unknown>)[];
}

/**
 * A W3C DID Document.
 *
 * Ref: https://www.w3.org/TR/did-core/#did-documents
 */
export interface DIDDocument {
  "@context": string | string[];
  id: string;
  controller?: string | string[];
  alsoKnownAs?: string[];
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
  keyAgreement?: (string | VerificationMethod)[];
  capabilityInvocation?: (string | VerificationMethod)[];
  capabilityDelegation?: (string | VerificationMethod)[];
  service?: ServiceEndpoint[];
}

/**
 * Options for the multi-method DIDResolver.
 */
export interface ResolverOptions {
  /** Inject a custom fetch (e.g. for testing did:web). */
  fetchImpl?: typeof fetch;
  /** Override RPC URL for ENS resolution (mainnet). */
  ensRpcUrl?: string;
  /** Override RPC URL for Base resolution (Base ENS, etc). */
  baseRpcUrl?: string;
  /** Override request timeout in ms. Default 10s. */
  timeoutMs?: number;
}

/**
 * Result of parsing a DID URI.
 */
export interface ParsedDID {
  method: string;
  methodSpecificId: string;
  /** The full DID string with no fragment / query. */
  did: string;
  /** Path component after methodSpecificId, if any. */
  path?: string;
  /** Query string after `?`, if any. */
  query?: string;
  /** Fragment after `#`, if any. */
  fragment?: string;
}

/**
 * Standard error class for DID resolution failures.
 */
export class DIDResolutionError extends Error {
  constructor(
    message: string,
    public readonly did: string,
    public readonly code:
      | "invalidDid"
      | "methodNotSupported"
      | "notFound"
      | "representationNotSupported"
      | "invalidDidDocument"
      | "networkError" = "invalidDid",
  ) {
    super(message);
    this.name = "DIDResolutionError";
  }
}

/**
 * A W3C Verifiable Credential (data-integrity proof form).
 *
 * Ref: https://www.w3.org/TR/vc-data-model/
 */
export interface VerifiableCredential {
  "@context": string | string[];
  type: string | string[];
  issuer: string | { id: string; [k: string]: unknown };
  issuanceDate: string;
  expirationDate?: string;
  credentialSubject: Record<string, unknown> | Record<string, unknown>[];
  proof: VCProof | VCProof[];
  id?: string;
  credentialStatus?: Record<string, unknown>;
  credentialSchema?: Record<string, unknown>;
}

/**
 * Proof block on a Verifiable Credential.
 * Supports JWS proofs (Ed25519Signature2018 / EcdsaSecp256k1Signature2019)
 * and JSON Web Token / VC-JWT enveloped form.
 */
export interface VCProof {
  type: string;
  created: string;
  verificationMethod: string;
  proofPurpose?: string;
  /** Detached JWS (RFC 7515 §4.1.11 unencoded payload). */
  jws?: string;
  /** Multibase signature (alternate to jws). */
  proofValue?: string;
  /** Domain string for replay-protection. */
  domain?: string;
  /** Challenge string for replay-protection. */
  challenge?: string;
  [k: string]: unknown;
}

/**
 * VC verification result.
 */
export interface VCVerificationResult {
  valid: boolean;
  errors: string[];
  /** Warnings — e.g. expiringSoon, deprecated proof type. */
  warnings?: string[];
}
