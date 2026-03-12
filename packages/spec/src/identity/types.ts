/**
 * Identity types — W3C DID and Verifiable Credential types for PCC.
 *
 * This file contains ONLY types (no runtime code, no node:crypto imports)
 * so it is safe to import from browser code.
 */

// ---------------------------------------------------------------------------
// DID Types
// ---------------------------------------------------------------------------

/** A W3C DID string (did:method:specific-id) */
export type DIDString = `did:${string}`;

/** W3C DID Document (simplified for PCC use) */
export interface DIDDocument {
  "@context": string[];
  id: DIDString;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod?: string[];
  capabilityDelegation?: string[];
  service?: ServiceEndpoint[];
}

/** A verification method within a DID Document */
export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyHex: string;
}

/** A service endpoint within a DID Document */
export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string;
}

/** Result of creating a new DID key pair */
export interface DIDKeyPair {
  did: DIDString;
  publicKeyHex: string;
  privateKeyHex: string;
  didDocument: DIDDocument;
}

/** Entity types that can have a PCC DID */
export type PCCEntityType = "kernel" | "device" | "operator" | "agent";

// ---------------------------------------------------------------------------
// Verifiable Credential Types
// ---------------------------------------------------------------------------

/** W3C Verifiable Credential for a physical capability */
export interface CapabilityCredential {
  "@context": string[];
  type: string[];
  id: string;
  issuer: DIDString;
  issuanceDate: string;
  expirationDate?: string;
  credentialSubject: CapabilitySubject;
  proof?: CredentialProof;
}

/** The subject of a capability credential */
export interface CapabilitySubject {
  /** DID of the device or entity */
  id: DIDString;
  /** Capability type (e.g. "fdm_printing", "cnc_milling") */
  capability: string;
  /** Capability parameters (materials, tolerances, etc.) */
  parameters?: Record<string, unknown>;
  /** Assurance tier (0-3) */
  assuranceTier: number;
  /** ISO date of last calibration */
  calibrationDate?: string;
  /** IPFS CID or hash of calibration proof data */
  calibrationProof?: string;
}

/** Proof attached to a credential (Ed25519Signature2020) */
export interface CredentialProof {
  type: "Ed25519Signature2020";
  created: string;
  verificationMethod: string;
  proofPurpose: "assertionMethod";
  /** Hex-encoded Ed25519 signature over canonical credential body */
  proofValue: string;
}

/** Options for issuing a credential */
export interface IssueCredentialOptions {
  issuerDid: DIDString;
  subjectDid: DIDString;
  capability: string;
  assuranceTier: number;
  parameters?: Record<string, unknown>;
  calibrationDate?: string;
  calibrationProof?: string;
  expirationDate?: string;
  /** Hex-encoded Ed25519 private key for signing (32 bytes) */
  issuerPrivateKeyHex?: string;
}

// ---------------------------------------------------------------------------
// Validation (pure functions, no crypto — browser-safe)
// ---------------------------------------------------------------------------

/** Check if a string is a valid DID format */
export function isValidDID(did: string): did is DIDString {
  return /^did:[a-z0-9]+:.+$/.test(did);
}

/** Check if a string is a valid did:key */
export function isValidKeyDID(did: string): boolean {
  return /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(did);
}

/** Check if a string is a valid did:pcc */
export function isValidPCCDID(did: string): boolean {
  return /^did:pcc:(kernel|device|operator|agent):.+$/.test(did);
}

/**
 * Create a PCC-namespaced DID for a known entity.
 *
 * Format: did:pcc:<type>:<id>
 * Used for human-readable identifiers that map to on-chain or off-chain registry entries.
 */
export function createPCCDID(type: PCCEntityType, id: string): DIDString {
  if (!id || id.length === 0) {
    throw new Error("ID must not be empty");
  }
  return `did:pcc:${type}:${id}` as DIDString;
}

/**
 * Parse a PCC DID back into its components.
 * Returns null if the DID is not a valid did:pcc.
 */
export function parsePCCDID(did: string): { type: PCCEntityType; id: string } | null {
  const match = did.match(/^did:pcc:(kernel|device|operator|agent):(.+)$/);
  if (!match) return null;
  return { type: match[1] as PCCEntityType, id: match[2] };
}

/**
 * Build a minimal DID Document for a did:key.
 */
export function buildDIDDocument(did: DIDString, publicKeyHex: string): DIDDocument {
  const keyId = `${did}#key-1`;
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1",
    ],
    id: did,
    verificationMethod: [
      {
        id: keyId,
        type: "Ed25519VerificationKey2020",
        controller: did,
        publicKeyHex,
      },
    ],
    authentication: [keyId],
    assertionMethod: [keyId],
    capabilityDelegation: [keyId],
  };
}

/**
 * Check basic structural validity of a credential (no crypto verification).
 */
export function isValidCredentialStructure(credential: unknown): credential is CapabilityCredential {
  if (!credential || typeof credential !== "object") return false;
  const c = credential as Record<string, unknown>;

  return (
    Array.isArray(c["@context"]) &&
    Array.isArray(c.type) &&
    (c.type as string[]).includes("VerifiableCredential") &&
    typeof c.issuer === "string" &&
    typeof c.issuanceDate === "string" &&
    typeof c.credentialSubject === "object" &&
    c.credentialSubject !== null &&
    typeof (c.credentialSubject as Record<string, unknown>).id === "string" &&
    typeof (c.credentialSubject as Record<string, unknown>).capability === "string" &&
    typeof (c.credentialSubject as Record<string, unknown>).assuranceTier === "number"
  );
}
