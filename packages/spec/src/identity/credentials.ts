/**
 * Verifiable Credential crypto operations — signing and verification.
 *
 * WARNING: This file uses node:crypto and must NOT be imported from browser code.
 * Import types and structural validation from './types.js' instead.
 */

import { createHash, sign as cryptoSign, verify as cryptoVerify, createPrivateKey, createPublicKey } from "node:crypto";
import type { DIDString, CapabilityCredential, CredentialProof, IssueCredentialOptions } from "./types.js";
import { canonicalize } from "../util/canonical.js";

// ---------------------------------------------------------------------------
// Credential Issuance (Node.js only)
// ---------------------------------------------------------------------------

/**
 * Issue a Verifiable Credential asserting a capability.
 *
 * If an issuer private key is provided, the credential is signed.
 * Otherwise, the credential is returned unsigned (useful for testing).
 *
 * Requires Node.js runtime (uses node:crypto for signing).
 */
export function issueCapabilityCredential(options: IssueCredentialOptions): CapabilityCredential {
  const {
    issuerDid,
    subjectDid,
    capability,
    assuranceTier,
    parameters,
    calibrationDate,
    calibrationProof,
    expirationDate,
    issuerPrivateKeyHex,
  } = options;

  // Generate a deterministic credential ID from content
  const credId = `urn:uuid:${generateCredentialId(issuerDid, subjectDid, capability)}`;

  const credential: CapabilityCredential = {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://pcc.network/credentials/v1",
    ],
    type: ["VerifiableCredential", "CapabilityCredential"],
    id: credId,
    issuer: issuerDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: {
      id: subjectDid,
      capability,
      assuranceTier,
      ...(parameters && { parameters }),
      ...(calibrationDate && { calibrationDate }),
      ...(calibrationProof && { calibrationProof }),
    },
    ...(expirationDate && { expirationDate }),
  };

  // Sign if private key provided
  if (issuerPrivateKeyHex) {
    credential.proof = signCredential(credential, issuerDid, issuerPrivateKeyHex);
  }

  return credential;
}

// ---------------------------------------------------------------------------
// Signing (Node.js only)
// ---------------------------------------------------------------------------

/**
 * Sign a credential with an Ed25519 private key.
 * Signs the canonical JSON of the credential (excluding any existing proof).
 */
export function signCredential(
  credential: CapabilityCredential,
  issuerDid: DIDString,
  privateKeyHex: string,
): CredentialProof {
  const { proof: _existingProof, ...credentialBody } = credential;
  const message = canonicalize(credentialBody);

  const privKeyDer = buildEd25519PrivateKeyDer(privateKeyHex);
  const privateKey = createPrivateKey({
    key: Buffer.from(privKeyDer),
    format: "der",
    type: "pkcs8",
  });

  // Ed25519 uses crypto.sign() with null algorithm (EdDSA has no separate digest step)
  const signature = cryptoSign(null, Buffer.from(message), privateKey);

  return {
    type: "Ed25519Signature2020",
    created: new Date().toISOString(),
    verificationMethod: `${issuerDid}#key-1`,
    proofPurpose: "assertionMethod",
    proofValue: Buffer.from(signature).toString("hex"),
  };
}

// ---------------------------------------------------------------------------
// Verification (Node.js only)
// ---------------------------------------------------------------------------

/**
 * Verify a credential's proof using the issuer's public key.
 *
 * Returns true if:
 * 1. The credential has a proof
 * 2. The proof signature is valid for the credential body
 * 3. The credential has not expired
 */
export function verifyCredential(
  credential: CapabilityCredential,
  issuerPublicKeyHex: string,
): boolean {
  // Must have a proof
  if (!credential.proof) {
    return false;
  }

  // Check expiration
  if (credential.expirationDate) {
    const expiry = new Date(credential.expirationDate);
    if (expiry < new Date()) {
      return false;
    }
  }

  try {
    const { proof, ...credentialBody } = credential;
    const message = canonicalize(credentialBody);

    const pubKeyDer = buildEd25519PublicKeyDer(issuerPublicKeyHex);
    const publicKey = createPublicKey({
      key: Buffer.from(pubKeyDer),
      format: "der",
      type: "spki",
    });

    const signatureBytes = Buffer.from(proof.proofValue, "hex");
    // Ed25519 uses crypto.verify() with null algorithm
    return cryptoVerify(null, Buffer.from(message), publicKey, signatureBytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// DER Helpers
// ---------------------------------------------------------------------------

/**
 * Build a PKCS8 DER-encoded Ed25519 private key from raw 32-byte hex.
 */
function buildEd25519PrivateKeyDer(privateKeyHex: string): number[] {
  const rawKey = Buffer.from(privateKeyHex, "hex");
  if (rawKey.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 private key, got ${rawKey.length} bytes`);
  }

  // Pre-built DER header for Ed25519 PKCS8 private key
  const header = [
    0x30, 0x2e,                         // SEQUENCE, length 46
    0x02, 0x01, 0x00,                   // INTEGER 0 (version)
    0x30, 0x05,                         // SEQUENCE, length 5
    0x06, 0x03, 0x2b, 0x65, 0x70,      // OID 1.3.101.112 (Ed25519)
    0x04, 0x22,                         // OCTET STRING, length 34
    0x04, 0x20,                         // OCTET STRING, length 32 (the actual key)
  ];

  return [...header, ...rawKey];
}

/**
 * Build a SPKI DER-encoded Ed25519 public key from raw 32-byte hex.
 */
function buildEd25519PublicKeyDer(publicKeyHex: string): number[] {
  const rawKey = Buffer.from(publicKeyHex, "hex");
  if (rawKey.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 public key, got ${rawKey.length} bytes`);
  }

  // Pre-built DER header for Ed25519 SPKI public key
  const header = [
    0x30, 0x2a,                         // SEQUENCE, length 42
    0x30, 0x05,                         // SEQUENCE, length 5
    0x06, 0x03, 0x2b, 0x65, 0x70,      // OID 1.3.101.112 (Ed25519)
    0x03, 0x21,                         // BIT STRING, length 33
    0x00,                               // no unused bits
  ];

  return [...header, ...rawKey];
}

/**
 * Generate a deterministic credential ID from issuer, subject, and capability.
 * Returns a UUID-like hex string.
 */
function generateCredentialId(issuer: string, subject: string, capability: string): string {
  const input = `${issuer}:${subject}:${capability}:${Date.now()}`;
  const hash = createHash("sha256").update(input).digest("hex");
  // Format as UUID v4 shape: 8-4-4-4-12
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    hash.substring(12, 16),
    hash.substring(16, 20),
    hash.substring(20, 32),
  ].join("-");
}
