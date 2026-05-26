/**
 * Pure helpers for PLR backend manifests — canonical bytes, ipId derivation,
 * sum-bps validation, EIP-712 typed-data preparation.
 *
 * Heavyweight signing / RPC lives in `@pcc/plr-registry-client`; this file
 * stays @noble-only so @pcc/spec keeps its zero-viem footprint.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { canonicalize } from "./canonical.js";
import type {
  BackendManifest,
  BackendManifestAuthor,
} from "../types/plr-backend-registry.js";
import { PLR_BACKEND_IP_ID_PREFIX } from "../types/plr-backend-registry.js";

// ── Canonical bytes ────────────────────────────────────────────────────

/**
 * Canonicalize a BackendManifest payload for signing or hashing. Sorted
 * keys, no whitespace. The output is the EXACT bytes any verifier
 * (on-chain or off-chain) will hash to recover the signed digest.
 */
export function canonicalizeBackendManifest(
  manifest: BackendManifest,
): string {
  return canonicalize(manifest);
}

// ── ipId derivation (Q10) ──────────────────────────────────────────────

/**
 * Compute the deterministic ipId for a PLR backend, mirroring the on-chain
 * `PLRBackendRegistry.deriveIpId(modulePath, majorVersion)` exactly.
 *
 * @param modulePath    Fully-qualified PLR module path.
 * @param majorVersion  Semver major (0..255). uint8 per the on-chain
 *                      function signature; throws if out of range.
 * @returns             0x-prefixed bytes32 of keccak256("pylabrobot:" + modulePath + ":" + majorVersion).
 */
export function deriveBackendIpId(
  modulePath: string,
  majorVersion: number,
): `0x${string}` {
  if (!Number.isInteger(majorVersion) || majorVersion < 0 || majorVersion > 255) {
    throw new Error(
      `deriveBackendIpId: majorVersion must be a uint8 (0..255), got ${majorVersion}`,
    );
  }

  // abi.encodePacked equivalent: concatenated raw bytes of each argument
  // with no length prefixes. Strings are UTF-8; uint8 is one byte.
  const enc = new TextEncoder();
  const prefixBytes = enc.encode(PLR_BACKEND_IP_ID_PREFIX); // "pylabrobot:"
  const pathBytes = enc.encode(modulePath);
  const colonBytes = enc.encode(":");
  const versionByte = new Uint8Array([majorVersion]);

  const total = new Uint8Array(
    prefixBytes.length + pathBytes.length + colonBytes.length + versionByte.length,
  );
  let offset = 0;
  total.set(prefixBytes, offset);
  offset += prefixBytes.length;
  total.set(pathBytes, offset);
  offset += pathBytes.length;
  total.set(colonBytes, offset);
  offset += colonBytes.length;
  total.set(versionByte, offset);

  const hash = keccak_256(total);
  const hex = Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}` as `0x${string}`;
}

// ── Manifest CID stub ──────────────────────────────────────────────────

/**
 * Compute the bytes32 CIDv1-raw-multihash for an off-chain signed manifest
 * payload. This is the value the registry's `manifestCid` field will hold.
 *
 * IMPLEMENTATION NOTE (Phase 1): we use sha256(canonical bytes) directly as
 * the CID payload. A full CIDv1 implementation requires multibase + codec
 * + multihash prefixes; the registry treats the field as opaque bytes32
 * and never decodes it, so a raw sha256 of the canonical payload is
 * sufficient for the on-chain anchor. The actual IPFS upload (which
 * produces the real CIDv1 string) happens off-chain in the dashboard / CLI;
 * the caller can either:
 *
 *   (a) accept the sha256 here as their pin key (recommended for Phase 1
 *       because every off-chain consumer can recompute it deterministically)
 *   (b) overwrite with the real IPFS CID multihash bytes32 if their pinning
 *       provider exposes it
 *
 * Phase 2 will swap to proper CIDv1 once we ship the dashboard.
 *
 * @param manifest  The signed manifest (signature included in canonical bytes).
 * @returns         0x-prefixed bytes32.
 */
export async function manifestCid(payload: object): Promise<`0x${string}`> {
  const canon = canonicalize(payload);

  // Use Web Crypto (Node 20+ / browsers) for sha256.
  const enc = new TextEncoder();
  const data = enc.encode(canon);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hashBuf);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}` as `0x${string}`;
}

// ── Validation ─────────────────────────────────────────────────────────

/**
 * Sum of `authors[*].groupBps`. MUST equal 10000 for a valid manifest.
 * Returned as a plain number for callers to compare.
 */
export function sumAuthorBps(authors: BackendManifestAuthor[]): number {
  return authors.reduce((acc, a) => acc + a.groupBps, 0);
}

/**
 * Validate that `authors[].groupBps` sums to exactly 10000. Returns an
 * error string explaining the mismatch, or null on success.
 */
export function validateAuthorGroupBps(
  authors: BackendManifestAuthor[],
): string | null {
  const total = sumAuthorBps(authors);
  if (total !== 10000) {
    return `authors[].groupBps must sum to 10000; got ${total}`;
  }
  return null;
}

/**
 * Returns true iff a manifest passes ALL invariant checks beyond what Zod
 * already enforces — currently just the sum-bps constraint.
 */
export function isStructurallyValidBackendManifest(
  manifest: BackendManifest,
): boolean {
  return validateAuthorGroupBps(manifest.authors) === null;
}

// ── Address as bytes32 (Phase 1 delegated agent encoding) ──────────────

/**
 * Convert an EVM address to the bytes32 representation stored in
 * `delegatedAgentId` for Phase 1. The on-chain contract recovers the
 * address with `address(uint160(uint256(bytes32)))` — this helper is the
 * matching off-chain encoder.
 */
export function addressToDelegatedAgentBytes32(
  address: `0x${string}`,
): `0x${string}` {
  const hex = address.toLowerCase().replace(/^0x/, "");
  if (hex.length !== 40) {
    throw new Error(`addressToDelegatedAgentBytes32: invalid EVM address ${address}`);
  }
  // Left-pad to 32 bytes (64 hex chars).
  return `0x${hex.padStart(64, "0")}` as `0x${string}`;
}

/**
 * Inverse of addressToDelegatedAgentBytes32. Reverts to address(0) for
 * the zero bytes32.
 */
export function delegatedAgentBytes32ToAddress(
  b: `0x${string}`,
): `0x${string}` {
  const hex = b.toLowerCase().replace(/^0x/, "");
  if (hex.length !== 64) {
    throw new Error(`delegatedAgentBytes32ToAddress: invalid bytes32 ${b}`);
  }
  return `0x${hex.slice(-40)}` as `0x${string}`;
}
