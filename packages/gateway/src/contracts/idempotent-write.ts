/**
 * Idempotent paid-write broadcast (security review PR #157 point 1).
 *
 * viem's `fallback` transport re-broadcasts the *byte-identical* signed tx on
 * `eth_sendRawTransaction` failover, so a rotated retry is the SAME tx hash — the
 * network dedupes it (`already known`), it is not a second spend. The gap the review
 * flagged is in *handling*: the nonce manager rethrows on any nonce-shaped error, so a
 * benign `already known` (the tx already reached the mempool via the primary) surfaces
 * to the caller as a settlement failure — which then either retries with a fresh nonce
 * (the real double-send) or marks the milestone failed (the "silently vanishes" case).
 *
 * The fix, per the review:
 *   - `already known` → SUCCESS: resolve with the tx hash (computed from the signed tx
 *     BEFORE broadcast), advance the cursor, don't rethrow.
 *   - `nonce too low` → AMBIGUOUS: look up our pre-computed hash on-chain first — if it
 *     is mined/pending it is idempotent success; only if a DIFFERENT tx took the nonce
 *     is it a real failure (re-seed + surface). Never assume success without confirming.
 *   - Only ever re-broadcast the byte-identical signed tx; never re-sign / rebuild.
 *
 * This module is pure and dependency-injected (sign / send / confirmOnChain), so the
 * decision logic is unit-testable without a chain or a viem client. The escrow-client
 * wrapper wires the viem primitives into these callbacks on the managed write path.
 */

import type { Hex } from "viem";
import { isNonceError, isAlreadyKnownError } from "./nonce-manager.js";

/**
 * How to treat a broadcast error:
 *   - "idempotent": the identical tx is already known — resolve with the known hash.
 *   - "confirm":    ambiguous nonce error — confirm the hash on-chain before deciding.
 *   - "rethrow":    a genuine failure (revert, funds, transport) — propagate as-is.
 */
export type BroadcastDisposition = "idempotent" | "confirm" | "rethrow";

/**
 * Classify a broadcast error. `already known` is checked FIRST because it is also a
 * member of the (broader) nonce-error set, but it is unambiguously idempotent.
 */
export function classifyBroadcastError(err: unknown): BroadcastDisposition {
  if (isAlreadyKnownError(err)) return "idempotent";
  if (isNonceError(err)) return "confirm";
  return "rethrow";
}

/**
 * Decide the outcome of a failed broadcast for which we hold the pre-computed tx hash.
 * `confirmOnChain(hash)` must return true iff that exact tx is pending or mined.
 */
export async function resolveBroadcastOutcome(
  err: unknown,
  hash: Hex,
  confirmOnChain: (hash: Hex) => Promise<boolean>,
): Promise<Hex> {
  switch (classifyBroadcastError(err)) {
    case "idempotent":
      // The byte-identical tx is already in the mempool and will mine.
      return hash;
    case "confirm":
      // "nonce too low": did OUR tx take the nonce, or a different one? Confirm before
      // claiming success — a different tx on the nonce is a real failure that must
      // re-seed the cursor and surface.
      if (await confirmOnChain(hash)) return hash;
      throw err;
    default:
      throw err;
  }
}

/** Injected primitives for one idempotent broadcast. */
export interface IdempotentBroadcast {
  /**
   * Sign the tx for `nonce` LOCALLY. Returns the byte-identical serialized tx and its
   * deterministic hash. Called exactly once — the same bytes are re-broadcast on
   * failover; the tx is never re-signed / rebuilt.
   */
  sign: (nonce: number) => Promise<{ serialized: Hex; hash: Hex }>;
  /** Broadcast the exact serialized bytes (`eth_sendRawTransaction`). */
  send: (serialized: Hex) => Promise<void>;
  /** True iff the given tx hash is pending or mined on-chain. Only used to disambiguate a nonce error. */
  confirmOnChain: (hash: Hex) => Promise<boolean>;
}

/**
 * Broadcast a paid write idempotently under RPC failover. Signs once (so we hold the
 * hash before broadcast), sends the bytes, and on failure resolves benign
 * already-known / confirmed-nonce cases to the known hash instead of a false failure.
 *
 * Returns the tx hash; the caller (the nonce manager's `submit`) advances the cursor on
 * resolve, or re-seeds on a genuine nonce throw.
 */
export async function broadcastIdempotent(nonce: number, deps: IdempotentBroadcast): Promise<Hex> {
  const { serialized, hash } = await deps.sign(nonce);
  try {
    await deps.send(serialized);
    return hash;
  } catch (err) {
    return resolveBroadcastOutcome(err, hash, deps.confirmOnChain);
  }
}
