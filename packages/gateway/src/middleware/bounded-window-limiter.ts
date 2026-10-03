/**
 * A per-key sliding-window limiter whose memory is bounded in BOTH dimensions
 * (WP-A round 7, wpa-326-admingates-r2-astra AG-20/AG-24 and new defect 1):
 *   - at most `maxKeys` keys, the least recently seen evicted first;
 *   - at most `limit` timestamps per key.
 * A refused request is NOT recorded, so a flood of refused requests allocates
 * nothing and cannot hold a key's window open. The limiters it replaces in
 * feedback.ts and waitlist.ts bounded the number of keys but pushed a timestamp
 * for every request, refused ones included, so one key's list grew without limit.
 *
 * Semantics: at most `limit` ALLOWED requests per key in any `windowMs`.
 */
export class BoundedWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(limit: number, windowMs: number, maxKeys = 50_000) {
    // A NaN or non-positive setting must not disable the limiter (fail closed).
    this.limit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
    this.windowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000;
    this.maxKeys = Number.isFinite(maxKeys) && maxKeys >= 1 ? Math.floor(maxKeys) : 50_000;
  }

  /** True when this request must be refused. Only an allowed request is recorded. */
  limited(key: string, now = Date.now()): boolean {
    const prev = this.hits.get(key);
    const live = prev ? prev.filter((t) => now - t < this.windowMs) : [];
    const refused = live.length >= this.limit;
    if (!refused) live.push(now);
    this.remember(key, live);
    return refused;
  }

  /** Whether `key` is tracked (e.g. a lead this process issued a token to). */
  has(key: string): boolean {
    return this.hits.has(key);
  }

  /** Start tracking `key` with one recorded request; a tracked key is left as is. */
  track(key: string, now = Date.now()): void {
    if (!this.hits.has(key)) this.remember(key, [now]);
  }

  get size(): number {
    return this.hits.size;
  }

  /** The longest per-key timestamp list. Test observability. */
  maxPerKey(): number {
    let m = 0;
    for (const a of this.hits.values()) if (a.length > m) m = a.length;
    return m;
  }

  clear(): void {
    this.hits.clear();
  }

  private remember(key: string, arr: number[]): void {
    this.hits.delete(key); // re-insert: Map order is insertion order, least recently seen first
    this.hits.set(key, arr);
    if (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
  }
}
