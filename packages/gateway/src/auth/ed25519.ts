/**
 * Ed25519 keypair helpers for agent provisioning.
 *
 * Server-side, agents get an Ed25519 verify key issued at provision time
 * (or bring their own). Public key (32 raw bytes, hex-encoded) is stored
 * on the api_keys row; the matching private key is shown ONCE in the
 * provision response body and then forgotten — same convention as AWS
 * access keys, Stripe restricted keys, GitHub PATs.
 *
 * Verification is a separate POST route. The verify endpoint takes a
 * raw message + signature, recomputes the verification against the
 * stored public key, and returns { valid: true|false }.
 *
 * Implementation note: uses node:crypto's built-in Ed25519. No native
 * deps, no curves library — already part of the runtime. The DER-encoded
 * SPKI form that node returns is 44 bytes; we strip the 12-byte ASN.1
 * prefix to get the raw 32-byte public key so the on-disk format is the
 * same one the @noble/curves verifier (used elsewhere in PCC) expects.
 */

import { generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";

/** A freshly minted keypair. Both halves are hex-encoded raw bytes. */
export interface Ed25519Keypair {
  /** Raw 32-byte public key, hex-encoded (64 chars), no 0x prefix. */
  publicKeyHex: string;
  /** Raw 32-byte private seed, hex-encoded (64 chars), no 0x prefix. */
  privateKeyHex: string;
  /** PKCS#8-DER private key, base64-encoded. Convenient for node:crypto import. */
  privateKeyPkcs8B64: string;
}

const RAW_PUBLIC_KEY_LENGTH = 32;
const SPKI_DER_LENGTH = 44; // Ed25519 SPKI DER is always 44 bytes
const SPKI_DER_PREFIX_LENGTH = 12; // first 12 bytes are the ASN.1 algorithm OID
const RAW_PRIVATE_KEY_LENGTH = 32;
const PKCS8_DER_LENGTH = 48; // Ed25519 PKCS8 DER is always 48 bytes
const PKCS8_DER_PREFIX_LENGTH = 16; // first 16 bytes are ASN.1 prefix

/**
 * Generate a fresh Ed25519 keypair.
 *
 * Returns hex-encoded raw bytes for storage and the PKCS8 base64 form
 * for the convenience of clients who want to round-trip it back into
 * node:crypto without parsing hex.
 */
export function generateEd25519Keypair(): Ed25519Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const pkcs8Der = privateKey.export({ type: "pkcs8", format: "der" });

  // Strip the 12-byte ASN.1 prefix to get the raw 32-byte public key.
  if (spkiDer.length !== SPKI_DER_LENGTH) {
    throw new Error(`unexpected Ed25519 SPKI DER length ${spkiDer.length}`);
  }
  const rawPublicKey = spkiDer.subarray(SPKI_DER_PREFIX_LENGTH);
  if (rawPublicKey.length !== RAW_PUBLIC_KEY_LENGTH) {
    throw new Error(`unexpected raw public key length ${rawPublicKey.length}`);
  }

  // Same for the private key (PKCS8 prefix is 16 bytes for Ed25519).
  if (pkcs8Der.length !== PKCS8_DER_LENGTH) {
    throw new Error(`unexpected Ed25519 PKCS8 DER length ${pkcs8Der.length}`);
  }
  const rawPrivateKey = pkcs8Der.subarray(PKCS8_DER_PREFIX_LENGTH);
  if (rawPrivateKey.length !== RAW_PRIVATE_KEY_LENGTH) {
    throw new Error(`unexpected raw private key length ${rawPrivateKey.length}`);
  }

  return {
    publicKeyHex: rawPublicKey.toString("hex"),
    privateKeyHex: rawPrivateKey.toString("hex"),
    privateKeyPkcs8B64: pkcs8Der.toString("base64"),
  };
}

/**
 * Validate that a string is a valid hex-encoded Ed25519 public key
 * (64 hex chars = 32 bytes). Does NOT check that the bytes form a valid
 * curve point — Node's verifier will reject malformed keys on first use.
 * Accepts optional 0x prefix; returns the normalized lowercase hex without it.
 */
export function normalizePublicKeyHex(input: string): string | null {
  if (typeof input !== "string") return null;
  const clean = input.startsWith("0x") || input.startsWith("0X") ? input.slice(2) : input;
  if (clean.length !== 64) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) return null;
  return clean.toLowerCase();
}

/** Validate hex-encoded signatures (Ed25519 signatures are always 64 bytes = 128 hex). */
export function normalizeSignatureHex(input: string): string | null {
  if (typeof input !== "string") return null;
  const clean = input.startsWith("0x") || input.startsWith("0X") ? input.slice(2) : input;
  if (clean.length !== 128) return null;
  if (!/^[0-9a-fA-F]{128}$/.test(clean)) return null;
  return clean.toLowerCase();
}

/**
 * Verify an Ed25519 signature against a stored public key.
 *
 * @param publicKeyHex 64-char hex of the raw 32-byte public key (no 0x prefix).
 * @param message      Raw bytes of the message that was signed.
 * @param signatureHex 128-char hex of the 64-byte signature (no 0x prefix).
 *
 * Returns false on ANY input issue (malformed key, malformed signature,
 * key not on curve, signature doesn't match). Never throws — the route
 * layer just needs a yes/no.
 */
export function verifyEd25519Signature(
  publicKeyHex: string,
  message: Buffer | Uint8Array,
  signatureHex: string,
): boolean {
  const cleanPub = normalizePublicKeyHex(publicKeyHex);
  if (cleanPub === null) return false;
  const cleanSig = normalizeSignatureHex(signatureHex);
  if (cleanSig === null) return false;

  try {
    // Rebuild the SPKI DER form node:crypto wants by prepending the 12-byte
    // Ed25519 algorithm identifier.
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spkiDer = Buffer.concat([spkiPrefix, Buffer.from(cleanPub, "hex")]);
    const keyObject = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    const signature = Buffer.from(cleanSig, "hex");
    const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
    return verify(null, msg, keyObject, signature);
  } catch {
    return false;
  }
}

/**
 * Sign a message with a raw 32-byte private seed. Test/CLI helper only —
 * the gateway itself never holds long-lived agent private keys.
 *
 * @param privateKeyHex 64-char hex of the raw 32-byte private seed (no 0x prefix).
 * @returns 128-char hex of the 64-byte signature, or null on input issue.
 */
export function signWithPrivateKeyHex(
  privateKeyHex: string,
  message: Buffer | Uint8Array,
): string | null {
  if (typeof privateKeyHex !== "string") return null;
  const clean = privateKeyHex.startsWith("0x") || privateKeyHex.startsWith("0X")
    ? privateKeyHex.slice(2)
    : privateKeyHex;
  if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) return null;

  try {
    // Reconstruct PKCS8 DER from the raw private seed.
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const pkcs8Der = Buffer.concat([pkcs8Prefix, Buffer.from(clean, "hex")]);
    const { createPrivateKey } = require("node:crypto") as typeof import("node:crypto");
    const keyObject = createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
    const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
    return sign(null, msg, keyObject).toString("hex");
  } catch {
    return null;
  }
}
