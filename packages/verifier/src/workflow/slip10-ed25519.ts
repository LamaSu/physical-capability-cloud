/**
 * SLIP-0010 hardened Ed25519 derivation.
 *
 * Spec: https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 *
 * Only HARDENED paths (e.g. "m/44'/0'/0'") are supported — Ed25519 has no
 * public-only derivation (the mathematical reason: the clamping step makes
 * the private key a hash-derived multiplier, which breaks the linearity
 * assumption secp256k1 relies on for non-hardened child derivation).
 *
 * The hardened-only constraint is a feature for the sessionKey use case:
 * it forces explicit parent consent (the parent must hold the private key
 * at derivation time) which aligns with the "explicit delegation" design
 * in R06 section 5.
 *
 * Algorithm (from the SLIP-0010 spec, section "Master key generation"):
 *   Master: I = HMAC-SHA512(Key = "ed25519 seed", Data = seed)
 *           I_L (32B) = private key, I_R (32B) = chain code
 *
 * Algorithm (from the spec, "Private parent key → private child key"):
 *   Child:  I = HMAC-SHA512(Key = c_par, Data = 0x00 || ser256(k_par) || ser32(i))
 *           where i must be >= 2^31 (hardened)
 *           I_L (32B) = child private key, I_R (32B) = child chain code
 *
 * Notes on `privateKey`:
 *   The 32-byte `privateKey` is the Ed25519 SEED, not the 64-byte
 *   `secretKey` used by tweetnacl. To sign with tweetnacl, pass the seed
 *   to `nacl.sign.keyPair.fromSeed(seed)` which expands it into the full
 *   64-byte secret key.
 */

import { createHmac } from "node:crypto";
import nacl from "tweetnacl";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SLIP-0010 uses this fixed ASCII string as the HMAC key for master derivation. */
const ED25519_MASTER_SECRET = new TextEncoder().encode("ed25519 seed");

/** Any index >= 2^31 is "hardened". We OR every path component with this. */
const HARDENED_OFFSET = 0x80000000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A derived node in the SLIP-0010 tree.
 *
 * The 32-byte `privateKey` is the Ed25519 SEED. To produce signatures,
 * expand it into a full tweetnacl keypair:
 *   const kp = nacl.sign.keyPair.fromSeed(derived.privateKey);
 *   const sig = nacl.sign.detached(msg, kp.secretKey);
 *
 * The `publicKey` is precomputed at derivation time via
 * nacl.sign.keyPair.fromSeed for convenience.
 */
export interface DerivedKey {
  /** 32-byte Ed25519 seed (feed to nacl.sign.keyPair.fromSeed to get a signing key). */
  privateKey: Uint8Array;
  /** 32-byte chain code — required for further child derivation. */
  chainCode: Uint8Array;
  /** 32-byte Ed25519 public key derived from privateKey. */
  publicKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// HMAC helper
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA512(key, data) → 64-byte Uint8Array.
 *
 * Uses node:crypto which is available in every Node environment we target.
 * We convert the Node Buffer to a Uint8Array so callers never see Buffer.
 */
function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  const h = createHmac("sha512", key);
  h.update(data);
  const out = h.digest();
  // Copy into a fresh Uint8Array so the buffer isn't aliased into a Node Buffer.
  const result = new Uint8Array(out.length);
  result.set(out);
  return result;
}

// ---------------------------------------------------------------------------
// Path parsing and validation
// ---------------------------------------------------------------------------

/**
 * Parse a BIP32-style path string into an array of hardened indices.
 *
 * Accepted formats:
 *   ""       → [] (master / empty path)
 *   "m"      → [] (master, explicit marker)
 *   "m/0'"   → [0 | HARDENED_OFFSET]
 *   "m/44'/60'/0'/0'/0'" → five hardened indices
 *
 * Every index MUST be suffixed with `'` or `h` (hardened marker). An
 * unmarked index throws — Ed25519 has no non-hardened derivation.
 */
export function parsePath(path: string): number[] {
  if (path === "" || path === "m" || path === "M") {
    return [];
  }

  // Detect trailing slash ("m/", "m/0'/") — this is malformed because
  // it implies an empty segment on the right. We surface that as an error
  // rather than silently treating it as the master node.
  if (path.endsWith("/")) {
    throw new Error(
      `Invalid SLIP-0010 path "${path}": empty segment (path must not end with "/")`,
    );
  }

  // Strip leading "m/" if present, otherwise use as-is (must still be "/-ok").
  let rest = path;
  if (rest.startsWith("m/") || rest.startsWith("M/")) {
    rest = rest.slice(2);
  } else if (rest.startsWith("/")) {
    // "/0'/1'" → also tolerated, strip the leading slash
    rest = rest.slice(1);
  } else {
    // path doesn't start with "m/" or "/" and isn't empty → must be
    // a bare segment like "0'" (uncommon but accept it for robustness).
    // No-op.
  }

  if (rest.length === 0) {
    // After stripping, we have nothing — this happened because the
    // input was literally "m/" or similar. Already handled above but
    // this is a safety net.
    throw new Error(
      `Invalid SLIP-0010 path "${path}": no segments after prefix`,
    );
  }

  const segments = rest.split("/");
  const indices: number[] = [];

  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error(`Invalid SLIP-0010 path "${path}": empty segment`);
    }

    // Accept both `'` (BIP32 convention) and `h` (alt notation) as
    // hardened markers. Require one.
    const lastChar = segment[segment.length - 1];
    if (lastChar !== "'" && lastChar !== "h") {
      throw new Error(
        `Invalid SLIP-0010 path "${path}": segment "${segment}" is not hardened ` +
          `(Ed25519 only supports hardened derivation — append ' or h)`,
      );
    }

    const numericPart = segment.slice(0, -1);
    if (numericPart.length === 0 || !/^\d+$/.test(numericPart)) {
      throw new Error(
        `Invalid SLIP-0010 path "${path}": segment "${segment}" is not a valid non-negative integer`,
      );
    }

    // Parse as integer. A hardened index is the user's integer PLUS
    // the hardened offset. Guard against input already exceeding 2^31
    // which would indicate the user double-hardened it.
    const raw = Number.parseInt(numericPart, 10);
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error(
        `Invalid SLIP-0010 path "${path}": segment "${segment}" produced non-finite or negative index`,
      );
    }
    if (raw >= HARDENED_OFFSET) {
      throw new Error(
        `Invalid SLIP-0010 path "${path}": segment "${segment}" exceeds 2^31 before hardening`,
      );
    }

    indices.push((raw | 0) + HARDENED_OFFSET);
  }

  return indices;
}

/**
 * Validate that a path is hardened-only.
 *
 * Throws with a clear message on:
 *   - Any non-hardened segment (Ed25519 limitation)
 *   - Malformed segments (non-numeric, empty)
 *   - Indices outside the valid range
 *
 * Returns nothing on success. Idempotent — also used internally by derivePath.
 */
export function validateHardenedPath(path: string): void {
  // Leverage parsePath — it already throws on every illegal form.
  parsePath(path);
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a 32-bit unsigned index in big-endian byte order (ser32 in SLIP-0010).
 */
function ser32(i: number): Uint8Array {
  const buf = new Uint8Array(4);
  // Use DataView so the behavior is explicit about endianness.
  new DataView(buf.buffer).setUint32(0, i >>> 0, false);
  return buf;
}

/**
 * ser256(k) for SLIP-0010 purposes: the 32-byte Ed25519 seed is already
 * in its canonical big-endian-ish form for the HMAC input. We just verify
 * the length and pass through.
 */
function ser256(key: Uint8Array): Uint8Array {
  if (key.length !== 32) {
    throw new Error(`ser256: expected 32-byte key, got ${key.length}`);
  }
  return key;
}

/**
 * Concat multiple Uint8Arrays into one.
 * (No Buffer dependency — browser-friendly if we ever cross-compile.)
 */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Master key
// ---------------------------------------------------------------------------

/**
 * Derive the master (root) node from a seed.
 *
 * SLIP-0010 section "Master key generation":
 *   I = HMAC-SHA512(Key = "ed25519 seed", Data = seed)
 *   I_L (first 32B)  = master private key (Ed25519 seed for the root)
 *   I_R (second 32B) = master chain code
 *
 * Unlike secp256k1, there is NO rejection step for Ed25519 — every
 * 32-byte value is a valid Ed25519 seed, so we don't iterate.
 *
 * Accepts seeds of any length >= 16 bytes and <= 64 bytes (per BIP32 /
 * SLIP-0010 guidance). Throws on anything outside that range.
 */
export function masterKeyFromSeed(seed: Uint8Array): DerivedKey {
  if (!(seed instanceof Uint8Array)) {
    throw new Error("masterKeyFromSeed: seed must be a Uint8Array");
  }
  if (seed.length < 16 || seed.length > 64) {
    throw new Error(
      `masterKeyFromSeed: seed length must be 16..64 bytes, got ${seed.length}`,
    );
  }

  const I = hmacSha512(ED25519_MASTER_SECRET, seed);
  const privateKey = I.slice(0, 32);
  const chainCode = I.slice(32, 64);

  // Expand the seed into an Ed25519 keypair to get the public key.
  const keyPair = nacl.sign.keyPair.fromSeed(privateKey);
  const publicKey = new Uint8Array(keyPair.publicKey);

  return { privateKey, chainCode, publicKey };
}

// ---------------------------------------------------------------------------
// Child derivation (one step)
// ---------------------------------------------------------------------------

/**
 * Derive a single child node from a parent node + hardened index.
 *
 * SLIP-0010 "Private parent key → private child key" (hardened):
 *   I = HMAC-SHA512(Key = c_par, Data = 0x00 || ser256(k_par) || ser32(i))
 *   I_L (32B) = child private key
 *   I_R (32B) = child chain code
 *
 * The `index` parameter is the RAW HARDENED index (already OR'd with 2^31).
 * Callers who want the "0'" syntax should go through derivePath() or build
 * the hardened index explicitly: `(userIndex | HARDENED_OFFSET) >>> 0`.
 *
 * Throws if index < 2^31 — Ed25519 has no non-hardened derivation.
 */
export function deriveChild(parent: DerivedKey, index: number): DerivedKey {
  if (!Number.isInteger(index)) {
    throw new Error(`deriveChild: index must be an integer, got ${index}`);
  }
  // `index >>> 0` normalizes negative/overflow into unsigned 32-bit.
  const u32Index = index >>> 0;
  if (u32Index < HARDENED_OFFSET) {
    throw new Error(
      `deriveChild: index ${u32Index} is not hardened (must be >= 2^31 = ${HARDENED_OFFSET}). ` +
        `Ed25519 only supports hardened derivation.`,
    );
  }
  if (parent.privateKey.length !== 32) {
    throw new Error(
      `deriveChild: parent.privateKey must be 32 bytes, got ${parent.privateKey.length}`,
    );
  }
  if (parent.chainCode.length !== 32) {
    throw new Error(
      `deriveChild: parent.chainCode must be 32 bytes, got ${parent.chainCode.length}`,
    );
  }

  // Data = 0x00 || ser256(k_par) || ser32(i)
  // The leading 0x00 byte is a hardened-derivation marker required by
  // SLIP-0010 for ed25519.
  const data = concatBytes(
    new Uint8Array([0x00]),
    ser256(parent.privateKey),
    ser32(u32Index),
  );

  const I = hmacSha512(parent.chainCode, data);
  const privateKey = I.slice(0, 32);
  const chainCode = I.slice(32, 64);

  const keyPair = nacl.sign.keyPair.fromSeed(privateKey);
  const publicKey = new Uint8Array(keyPair.publicKey);

  return { privateKey, chainCode, publicKey };
}

// ---------------------------------------------------------------------------
// Full-path derivation
// ---------------------------------------------------------------------------

/**
 * Derive a node at an arbitrary hardened path from a seed.
 *
 * Examples:
 *   derivePath(seed, "m")                     → master node
 *   derivePath(seed, "m/0'")                  → first child
 *   derivePath(seed, "m/44'/0'/0'/0'/0'")     → standard wallet path
 *   derivePath(seed, "m/8004'/84532'/42'/0'") → PCC sessionKey path
 *
 * Throws if the path contains any non-hardened segment.
 */
export function derivePath(seed: Uint8Array, path: string): DerivedKey {
  // Validate before doing any work — cheap and gives callers clear errors.
  const indices = parsePath(path);

  let node = masterKeyFromSeed(seed);
  for (const index of indices) {
    node = deriveChild(node, index);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Public constant re-exports (so callers can build hardened indices)
// ---------------------------------------------------------------------------

/** The hardened-index offset (2^31). OR a user index with this to harden it. */
export const HARDENED = HARDENED_OFFSET;
