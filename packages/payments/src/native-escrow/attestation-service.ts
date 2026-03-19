/**
 * AttestationService — lightweight Ed25519-based attestation system.
 *
 * Replaces Ethereum Attestation Service (EAS) for the native escrow flow.
 * Creates signed attestation records for demands and fulfillments,
 * providing a verifiable audit trail without on-chain dependencies.
 *
 * Lock creates a "demand" attestation. Fulfill creates a "result" attestation.
 * Each attestation is signed with Ed25519 and stored in an in-memory registry.
 *
 * Production path: attestations could be anchored on-chain via a simple
 * registry contract that stores (id, hash, signer, timestamp).
 */

import {
  sign,
  verify,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import type { Attestation } from "./types.js";

/**
 * Canonicalize a data object for signing — deterministic JSON serialization.
 * Keys are sorted to ensure consistent ordering.
 */
function canonicalizeData(data: Record<string, unknown>): string {
  return JSON.stringify(data, Object.keys(data).sort());
}

/**
 * Build the signing payload: schema + canonical data + timestamp.
 */
function buildSigningPayload(
  schema: string,
  data: Record<string, unknown>,
  timestamp: string,
): Buffer {
  const message = `${schema}|${canonicalizeData(data)}|${timestamp}`;
  return Buffer.from(message, "utf-8");
}

/**
 * Import an Ed25519 private key from hex-encoded PKCS8 DER.
 */
function importPrivateKey(hexDer: string) {
  return createPrivateKey({
    key: Buffer.from(hexDer, "hex"),
    format: "der",
    type: "pkcs8",
  });
}

/**
 * Import an Ed25519 public key from hex-encoded SPKI DER.
 */
function importPublicKey(hexDer: string) {
  return createPublicKey({
    key: Buffer.from(hexDer, "hex"),
    format: "der",
    type: "spki",
  });
}

export class AttestationService {
  /** In-memory attestation registry */
  private attestations = new Map<string, Attestation>();
  private nextId = 1;

  /**
   * Generate a fresh Ed25519 keypair for testing/demo purposes.
   * Returns { publicKey, privateKey } as hex-encoded DER strings.
   */
  static generateKeyPair(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");

    const pubDer = publicKey.export({ type: "spki", format: "der" });
    const privDer = privateKey.export({ type: "pkcs8", format: "der" });

    return {
      publicKey: (pubDer as Buffer).toString("hex"),
      privateKey: (privDer as Buffer).toString("hex"),
    };
  }

  /**
   * Create a signed attestation record.
   *
   * @param schema - Schema identifier (e.g. "pcc.demand.v1", "pcc.result.v1")
   * @param data - Attestation data payload
   * @param signerPrivateKey - Hex-encoded Ed25519 private key (PKCS8 DER)
   * @param signerPublicKey - Hex-encoded Ed25519 public key (SPKI DER)
   * @returns The created attestation with signature
   */
  createAttestation(
    schema: string,
    data: Record<string, unknown>,
    signerPrivateKey: string,
    signerPublicKey: string,
  ): Attestation {
    const id = `att_${(this.nextId++).toString(16).padStart(8, "0")}`;
    const timestamp = new Date().toISOString();

    // Build deterministic payload
    const payload = buildSigningPayload(schema, data, timestamp);

    // Sign with Ed25519
    const keyObject = importPrivateKey(signerPrivateKey);
    const sig = sign(null, payload, keyObject);

    const attestation: Attestation = {
      id,
      schema,
      data,
      signer: signerPublicKey,
      signature: sig.toString("hex"),
      timestamp,
      revoked: false,
    };

    this.attestations.set(id, attestation);
    return attestation;
  }

  /**
   * Verify an attestation's signature against the expected signer.
   *
   * @param attestation - The attestation to verify
   * @param expectedSigner - Hex-encoded Ed25519 public key that should have signed
   * @returns true if the signature is valid and signer matches
   */
  verifyAttestation(attestation: Attestation, expectedSigner: string): boolean {
    // Signer must match
    if (attestation.signer !== expectedSigner) {
      return false;
    }

    // Revoked attestations fail verification
    if (attestation.revoked) {
      return false;
    }

    // Reconstruct payload and verify signature
    const payload = buildSigningPayload(
      attestation.schema,
      attestation.data,
      attestation.timestamp,
    );
    const signatureBuffer = Buffer.from(attestation.signature, "hex");

    try {
      const keyObject = importPublicKey(expectedSigner);
      return verify(null, payload, keyObject, signatureBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Revoke an attestation by ID.
   */
  revokeAttestation(id: string): boolean {
    const attestation = this.attestations.get(id);
    if (!attestation) return false;
    attestation.revoked = true;
    return true;
  }

  /**
   * Get an attestation by ID.
   */
  getAttestation(id: string): Attestation | undefined {
    return this.attestations.get(id);
  }

  /**
   * Get all attestations for a given schema.
   */
  getAttestationsBySchema(schema: string): Attestation[] {
    return [...this.attestations.values()].filter(
      (a) => a.schema === schema,
    );
  }

  /**
   * Get all attestations by a given signer.
   */
  getAttestationsBySigner(signer: string): Attestation[] {
    return [...this.attestations.values()].filter(
      (a) => a.signer === signer,
    );
  }
}
