/**
 * Pedersen hash utility — wraps BarretenbergSync for BN254-compatible Pedersen hashing.
 *
 * Uses the same generator points as Noir's `std::hash::pedersen_hash`,
 * so TypeScript-side Merkle trees match circuit-side trees exactly.
 *
 * The BarretenbergSync instance is initialized lazily on first call (WASM init is async).
 * After init, all hash operations are synchronous.
 */

import type { PedersenHash } from "@pcc/spec";

/** BN254 scalar field modulus */
const BN254_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Lazy singleton — initialized on first use
let bbInstance: any | null = null;
let FrClass: any | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Ensure the BarretenbergSync singleton is initialized.
 * Safe to call multiple times — only initializes once.
 */
async function ensureInit(): Promise<void> {
  if (bbInstance) return;
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    const bb = await import("@aztec/bb.js");
    FrClass = bb.Fr;
    bbInstance = await bb.BarretenbergSync.new();
  })();

  await initPromise;
}

/**
 * Compute Pedersen hash of one or more bigint field elements.
 * Returns a prefixed string: "pedersen:<64 hex chars>"
 *
 * @param inputs - Array of bigint values (must be < BN254 modulus)
 * @param hashIndex - Domain separator (default 0)
 */
export async function pedersenHash(
  inputs: bigint[],
  hashIndex = 0,
): Promise<PedersenHash> {
  await ensureInit();

  const frInputs = inputs.map((v) => new FrClass!(v));
  const result = bbInstance!.pedersenHash(frInputs, hashIndex);
  const hex = result.toString().replace("0x", "").toLowerCase();

  return `pedersen:${hex}` as PedersenHash;
}

/**
 * Compute Pedersen hash of two hash-digest strings (for Merkle tree node combining).
 * Accepts any "pedersen:<hex>" or "sha256:<hex>" prefixed string.
 * Converts the hex to a field element (mod BN254) before hashing.
 *
 * @param a - Left child hash string
 * @param b - Right child hash string
 */
export async function pedersenHashPair(
  a: string,
  b: string,
): Promise<PedersenHash> {
  const aField = hashToField(a);
  const bField = hashToField(b);
  return pedersenHash([aField, bField]);
}

/**
 * Convert a SHA256 hex string to a BN254 field element.
 * Reduces modulo the BN254 scalar field to guarantee the value is in range.
 */
export function sha256ToField(hash: string): bigint {
  const hex = hash.replace("sha256:", "");
  const value = BigInt("0x" + hex);
  return value % BN254_MODULUS;
}

/**
 * Convert any prefixed hash string to a BN254 field element.
 * Supports "sha256:..." and "pedersen:..." prefixes.
 * Pedersen hashes are already BN254 field elements so no reduction needed,
 * but we apply mod for safety.
 */
export function hashToField(hash: string): bigint {
  let hex: string;
  if (hash.startsWith("pedersen:")) {
    hex = hash.replace("pedersen:", "");
  } else if (hash.startsWith("sha256:")) {
    hex = hash.replace("sha256:", "");
  } else {
    hex = hash.replace(/^0x/, "");
  }
  const value = BigInt("0x" + hex);
  return value % BN254_MODULUS;
}

/** The zero hash for tree padding (Pedersen hash of [0]) */
let zeroHashCache: PedersenHash | null = null;

/**
 * Get the canonical zero hash for Merkle tree padding.
 * This is pedersenHash([0n, 0n]) — the "empty leaf" sentinel.
 */
export async function pedersenZeroHash(): Promise<PedersenHash> {
  if (zeroHashCache) return zeroHashCache;
  zeroHashCache = await pedersenHash([0n, 0n]);
  return zeroHashCache;
}
