/**
 * DID crypto operations — key generation and derivation.
 *
 * WARNING: This file uses node:crypto and must NOT be imported from browser code.
 * Import types and validation functions from './types.js' instead.
 */

import { generateKeyPairSync } from "node:crypto";
import type { DIDString, DIDKeyPair } from "./types.js";
import { buildDIDDocument } from "./types.js";

// ---------------------------------------------------------------------------
// Multibase / Multicodec helpers for did:key
// ---------------------------------------------------------------------------

// Multicodec prefix for Ed25519 public key: 0xed01
const ED25519_MULTICODEC_PREFIX = Buffer.from([0xed, 0x01]);

/**
 * Encode bytes as multibase base58btc (z-prefix).
 * Simplified base58btc encoder -- no external dependency.
 */
function base58btcEncode(bytes: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt("0x" + bytes.toString("hex"));
  if (num === 0n) return ALPHABET[0];

  const chars: string[] = [];
  while (num > 0n) {
    const remainder = Number(num % 58n);
    chars.unshift(ALPHABET[remainder]);
    num = num / 58n;
  }

  // Preserve leading zeros
  for (const byte of bytes) {
    if (byte === 0) {
      chars.unshift(ALPHABET[0]);
    } else {
      break;
    }
  }

  return chars.join("");
}

// ---------------------------------------------------------------------------
// DID Creation (Node.js only)
// ---------------------------------------------------------------------------

/**
 * Generate a new Ed25519 keypair and derive a did:key identifier.
 *
 * did:key follows the W3C specification:
 *   did:key:z<base58btc(multicodec-prefix + public-key-bytes)>
 *
 * Requires Node.js runtime (uses node:crypto).
 */
export function createKeyDID(): DIDKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  // Extract raw 32-byte Ed25519 public key from DER/SPKI
  // SPKI for Ed25519 is: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes>
  const pubKeyRaw = Buffer.from(publicKey.subarray(publicKey.length - 32));
  const pubKeyHex = pubKeyRaw.toString("hex");

  // Extract raw 32-byte Ed25519 private key from DER/PKCS8
  // PKCS8 for Ed25519 is: ...04 20 <32 bytes> at the end
  const privKeyRaw = Buffer.from(privateKey.subarray(privateKey.length - 32));
  const privKeyHex = privKeyRaw.toString("hex");

  // Multicodec-encode: ed25519-pub prefix (0xed01) + raw public key
  const multicodecKey = Buffer.concat([ED25519_MULTICODEC_PREFIX, pubKeyRaw]);
  const multibaseEncoded = "z" + base58btcEncode(multicodecKey);

  const did = `did:key:${multibaseEncoded}` as DIDString;

  const didDocument = buildDIDDocument(did, pubKeyHex);

  return {
    did,
    publicKeyHex: pubKeyHex,
    privateKeyHex: privKeyHex,
    didDocument,
  };
}

/**
 * Derive a did:key from an existing Ed25519 public key (hex-encoded).
 *
 * Requires Node.js runtime (uses Buffer).
 */
export function deriveKeyDID(publicKeyHex: string): DIDString {
  const pubKeyRaw = Buffer.from(publicKeyHex, "hex");
  if (pubKeyRaw.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 public key, got ${pubKeyRaw.length} bytes`);
  }
  const multicodecKey = Buffer.concat([ED25519_MULTICODEC_PREFIX, pubKeyRaw]);
  const multibaseEncoded = "z" + base58btcEncode(multicodecKey);
  return `did:key:${multibaseEncoded}` as DIDString;
}
