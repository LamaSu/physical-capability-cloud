/**
 * Hash primitives — thin wrappers around node:crypto for sha256
 * plus a keccak256 implementation that lives here so the whole package
 * is dependency-free for hashing.
 *
 * sha256 is used for:
 *   - content-addressable activity idempotency keys
 *   - event payload hashes
 *   - event hash-chain links
 *   - run_args_hash for find-or-create deduplication
 *
 * keccak256 is used only for:
 *   - on-chain semantic idempotency keys (matches EVM hashing — design §6.2)
 */

import { createHash } from 'node:crypto';
import { keccak_256 } from './keccak.js';

/** SHA-256 hex digest of a string. */
export function sha256Hex(input: string | Uint8Array): string {
  const h = createHash('sha256');
  h.update(input);
  return h.digest('hex');
}

/** SHA-256 of canonical JSON of a value. */
export function sha256OfCanonical(canonical: string): string {
  return sha256Hex(canonical);
}

/**
 * Keccak-256 hex digest (EVM-compatible, 0x-prefixed).
 * Implementation pulled in from the sibling `keccak.ts` module — zero deps.
 */
export function keccak256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = keccak_256(bytes);
  return (
    '0x' +
    Array.from(digest)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

/** 64-char all-zeros hex (used as the prev_hash sentinel for first event in a stream). */
export const ZERO_HASH = '0'.repeat(64);
