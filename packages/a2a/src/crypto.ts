/**
 * Crypto utilities for the distributed PCC agent network.
 *
 * Uses tweetnacl (NaCl) for:
 * - Ed25519 signing/verification (capability announcements, identity)
 * - X25519 authenticated encryption (NaCl box — agent-to-agent encrypted messages)
 *
 * All keys are hex-encoded strings. Ciphertext and nonces are base64-encoded.
 */

import nacl from "tweetnacl";
import type { EncryptedEnvelope, CapabilityAnnouncement } from "@pcc/spec";
// Canonicalization unification (RTP-absorption doc 02, open Q1).
// a2a previously signed over `JSON.stringify(obj, Object.keys(obj).sort())`, which does
// NOT recursively sort nested keys and silently DROPS nested-only keys (the array-replacer
// footgun — the key list is applied at every depth). @pcc/spec signs over recursive
// RFC-8785-style `canonicalize()` (JCS). The two disagreed, breaking cross-transport
// signature verification. a2a now uses the SAME canonicalization as the spec, so a
// signature produced on either path verifies on the other.
import { canonicalize } from "@pcc/spec";

// ── Key Generation ─────────────────────────────────────────────────

/** Generate an Ed25519 key pair for signing */
export function generateSigningKeyPair(): { publicKey: string; secretKey: string } {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: Buffer.from(kp.publicKey).toString("hex"),
    secretKey: Buffer.from(kp.secretKey).toString("hex"),
  };
}

/** Generate an X25519 key pair for encryption */
export function generateEncryptionKeyPair(): { publicKey: string; secretKey: string } {
  const kp = nacl.box.keyPair();
  return {
    publicKey: Buffer.from(kp.publicKey).toString("hex"),
    secretKey: Buffer.from(kp.secretKey).toString("hex"),
  };
}

// ── Encryption / Decryption ────────────────────────────────────────

/** Encrypt a message with NaCl box (authenticated encryption) */
export function encryptMessage(
  plaintext: string,
  recipientPublicKey: string,
  senderSecretKey: string,
): EncryptedEnvelope {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = new TextEncoder().encode(plaintext);
  const recipientPk = Buffer.from(recipientPublicKey, "hex");
  const senderSk = Buffer.from(senderSecretKey, "hex");

  const ciphertext = nacl.box(messageBytes, nonce, recipientPk, senderSk);
  if (!ciphertext) throw new Error("Encryption failed");

  return {
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    ephemeralPublicKey: Buffer.from(
      nacl.box.keyPair.fromSecretKey(senderSk).publicKey,
    ).toString("hex"),
    nonce: Buffer.from(nonce).toString("base64"),
  };
}

/** Decrypt a NaCl box message */
export function decryptMessage(
  envelope: EncryptedEnvelope,
  senderPublicKey: string,
  recipientSecretKey: string,
): string | null {
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const nonce = Buffer.from(envelope.nonce, "base64");
  const senderPk = Buffer.from(senderPublicKey, "hex");
  const recipientSk = Buffer.from(recipientSecretKey, "hex");

  const plaintext = nacl.box.open(ciphertext, nonce, senderPk, recipientSk);
  if (!plaintext) return null;
  return new TextDecoder().decode(plaintext);
}

// ── Signing / Verification ─────────────────────────────────────────

/** Sign data with Ed25519 */
export function sign(data: string, secretKey: string): string {
  const messageBytes = new TextEncoder().encode(data);
  const sk = Buffer.from(secretKey, "hex");
  const signature = nacl.sign.detached(messageBytes, sk);
  return Buffer.from(signature).toString("base64");
}

/** Verify an Ed25519 signature */
export function verify(data: string, signature: string, publicKey: string): boolean {
  const messageBytes = new TextEncoder().encode(data);
  const sig = Buffer.from(signature, "base64");
  const pk = Buffer.from(publicKey, "hex");
  return nacl.sign.detached.verify(messageBytes, sig, pk);
}

// ── Capability Announcements ───────────────────────────────────────

/**
 * Sign a capability announcement. Signs the spec's canonical JSON (JCS) of the
 * announcement without the signature field. Uses the SAME `canonicalize` as
 * @pcc/spec evidence/job-spec hashing so signatures interoperate across transports.
 */
export function signAnnouncement(
  announcement: Omit<CapabilityAnnouncement, "signature">,
  secretKey: string,
): string {
  const canonical = canonicalize(announcement);
  return sign(canonical, secretKey);
}

/** Verify a capability announcement's signature */
export function verifyAnnouncement(
  announcement: CapabilityAnnouncement,
  publicKey: string,
): boolean {
  const { signature, ...rest } = announcement;
  const canonical = canonicalize(rest);
  return verify(canonical, signature, publicKey);
}
