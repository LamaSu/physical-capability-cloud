/**
 * RegisteredSigner — the algorithm-tagged signing key the gateway registry
 * proves at registration and serves on `KernelDTO.signingKey`, and that the
 * oracle's #52 `machine.execution_log` verifier matches each log entry's
 * `kernelSignature` against before releasing escrow (Option C).
 *
 * PCC is already a two-family system, cleanly split (see
 * ai/research/pcc-machinelog-keymodel.md):
 *   - ed25519   → the device / evidence plane (kernel-sdk + pcc-node native key)
 *   - secp256k1 → the money plane (EVM address; #230's existing lane)
 *
 * Encoding conventions are LOAD-BEARING and pinned by the wire contract
 * (optionc-wire-contract.md, WIRE SHAPE 1):
 *   - ed25519.publicKey = "0x" + 64 lowercase hex (raw 32-byte pubkey)
 *   - secp256k1.address = EIP-55 checksummed 0x + 40 hex (20-byte EVM address)
 *
 * FAIL CLOSED — this is a money path: `normalizeRegisteredSigner` returns
 * `null` for anything it cannot validate to one of these exact shapes. A wrong
 * "registered" signer could clear settlement for a forged machine log, so the
 * default on any ambiguity is "no signer", never a best-guess.
 */

import { keccak_256 } from "@noble/hashes/sha3";

/**
 * The algorithm-tagged signing key a kernel proved possession of at
 * registration. `secp256k1` carries an EVM `address`; `ed25519` carries the raw
 * `publicKey` (there is no address-recovery for Ed25519, so verification is
 * always against this exact key — structurally "registered key or nothing").
 */
export type RegisteredSigner =
  | { algorithm: "ed25519"; publicKey: string }
  | { algorithm: "secp256k1"; address: string };

// ── internal validators (all fail closed to null) ───────────────────────────

/** Strip an optional 0x/0X prefix. Returns the remainder unchanged otherwise. */
function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/**
 * EIP-55 checksum a 40-char lowercase hex address body (no 0x). Uses
 * `@noble/hashes` keccak256 (already a spec dep; browser-safe, no node:crypto)
 * — the same primitive `payouts.ts` uses for role tags. Returns the
 * checksummed `0x…` address.
 */
function toEip55Checksum(lowerHex40: string): string {
  const hash = keccak_256(new TextEncoder().encode(lowerHex40));
  let out = "";
  for (let i = 0; i < 40; i++) {
    const ch = lowerHex40[i];
    // Nibble i of the hash: byte (i >> 1), high nibble on even i, low on odd.
    const byte = hash[i >> 1];
    const nibble = (i & 1) === 0 ? byte >> 4 : byte & 0x0f;
    // Letters a-f uppercase when their hash nibble ≥ 8; digits are unchanged.
    out += nibble >= 8 ? ch.toUpperCase() : ch;
  }
  return `0x${out}`;
}

/**
 * Validate a candidate secp256k1 EVM address and return the tagged signer with
 * the address EIP-55 checksummed, or `null`. Accepts any hex case on input
 * (checksums it), but the input must be exactly 0x + 40 hex.
 */
function normalizeSecp256k1(address: unknown): RegisteredSigner | null {
  if (typeof address !== "string") return null;
  const clean = strip0x(address);
  if (clean.length !== 40 || !/^[0-9a-fA-F]{40}$/.test(clean)) return null;
  return { algorithm: "secp256k1", address: toEip55Checksum(clean.toLowerCase()) };
}

/**
 * Validate a candidate Ed25519 raw public key and return the normalized
 * `"0x" + 64 lowercase hex` form, or `null`. Accepts an optional 0x prefix and
 * any hex case on input; emits the pinned lowercase-with-0x convention.
 */
function normalizeEd25519PublicKey(publicKey: unknown): string | null {
  if (typeof publicKey !== "string") return null;
  const clean = strip0x(publicKey);
  if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) return null;
  return `0x${clean.toLowerCase()}`;
}

/**
 * Parse untrusted input into a canonical `RegisteredSigner`, or `null` (fail
 * closed). Accepts:
 *   - a tagged object `{ algorithm: "ed25519",   publicKey }`
 *   - a tagged object `{ algorithm: "secp256k1", address }`
 *   - a bare `0x…` address string → treated as secp256k1 (compat with callers
 *     that pass a plain address, e.g. the oracle's registered-signer ctx)
 *
 * Anything else — untagged objects, unknown algorithms, malformed hex, wrong
 * lengths, non-strings — returns `null`. Output encodings are normalized:
 * secp256k1 address is EIP-55 checksummed; ed25519 publicKey is `0x`+lowercase.
 */
export function normalizeRegisteredSigner(input: unknown): RegisteredSigner | null {
  // Bare string → secp256k1 address.
  if (typeof input === "string") return normalizeSecp256k1(input);

  if (input === null || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;

  if (obj.algorithm === "ed25519") {
    const publicKey = normalizeEd25519PublicKey(obj.publicKey);
    return publicKey ? { algorithm: "ed25519", publicKey } : null;
  }
  if (obj.algorithm === "secp256k1") {
    return normalizeSecp256k1(obj.address);
  }
  // Untagged / unknown algorithm → fail closed.
  return null;
}
