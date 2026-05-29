/**
 * Short-lived in-process cache of seen EIP-3009 nonces.
 *
 * Used by the x402 gate to detect and short-circuit replays of a
 * signed payment payload. Without this, a caller who retries an invoke
 * with the same PAYMENT-SIGNATURE header (e.g. because the first reply
 * timed out client-side) might trigger a duplicate facilitator settle
 * AND a duplicate upstream call.
 *
 * The cache keys on `nonce + from` because EIP-3009 nonces are unique
 * only per payer address.
 *
 * Phase 1: in-process Map with TTL eviction. Sufficient for a single-
 * gateway-instance deployment.
 *
 * Phase 1.5 nicety: Redis (or DB index on `paymentTxHash`) so multiple
 * gateway instances share a view.
 *
 * Default TTL is 10 minutes, slightly longer than the protocol's typical
 * `maxTimeoutSeconds` (300s) — by the time a cache entry expires the
 * signed authorization's `validBefore` has also expired and re-use is
 * impossible at the chain level.
 */

/** Cached entry — receipt CID is what the gate hands the second-attempt caller. */
export interface NonceCacheEntry {
  /** The InvocationReceipt CID issued to the FIRST attempt. */
  receiptCID: string;
  /** ms-since-epoch when this entry was recorded (for TTL eviction). */
  recordedAt: number;
}

export interface NonceCacheOptions {
  /** TTL for entries, ms. Default 600_000 (10 minutes). */
  ttlMs?: number;
  /** Optional clock for tests (returns ms since epoch). Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 600_000;

/**
 * Simple in-process cache. Not concurrent-safe across instances (single Node
 * event loop is OK). Eviction runs lazily on read/write — no background timer.
 */
export class NonceCache {
  private readonly entries = new Map<string, NonceCacheEntry>();
  private readonly ttlMs: number;
  private readonly nowFn: () => number;

  constructor(opts: NonceCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.nowFn = opts.now ?? Date.now;
  }

  /** Return the cached entry for (nonce, from), or undefined if missing/expired. */
  get(nonce: string, from: string): NonceCacheEntry | undefined {
    const k = key(nonce, from);
    const entry = this.entries.get(k);
    if (!entry) return undefined;
    if (this.nowFn() - entry.recordedAt > this.ttlMs) {
      this.entries.delete(k);
      return undefined;
    }
    return entry;
  }

  /** Record a (nonce, from, receiptCID) tuple. Overwrites if already present. */
  set(nonce: string, from: string, receiptCID: string): void {
    this.entries.set(key(nonce, from), {
      receiptCID,
      recordedAt: this.nowFn(),
    });
  }

  /** Number of live (non-expired) entries. Useful for tests / metrics. */
  size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  /** Forget everything (tests). */
  clear(): void {
    this.entries.clear();
  }

  /** Drop every entry past its TTL. Called lazily; safe to call manually. */
  evictExpired(): void {
    const cutoff = this.nowFn() - this.ttlMs;
    for (const [k, entry] of this.entries) {
      if (entry.recordedAt < cutoff) this.entries.delete(k);
    }
  }
}

function key(nonce: string, from: string): string {
  // Lowercase both — EIP-3009 nonces are typically hex; payer addresses are
  // checksummed but logically case-insensitive. Avoid cache misses caused by
  // capitalization drift between gateway logs and caller signatures.
  return `${nonce.toLowerCase()}:${from.toLowerCase()}`;
}
