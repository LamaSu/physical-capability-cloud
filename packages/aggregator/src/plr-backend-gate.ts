/**
 * PLR backend kill-switch gate. Wraps a `PLRRegistryClient.assertEnabled()`
 * call with:
 *   - Per-(chain, modulePath) TTL cache (5 min default per scoping doc §5.2)
 *   - Feature-flag short-circuit via PCC_PLR_BACKEND_REGISTRY_ENABLED env var
 *   - BackendDisabledError surface (from @pcc/spec) on revert
 *
 * Phase 1 scope (per intake §D):
 *   - TTL cache only (no event-driven invalidation yet)
 *   - Phase 2 will subscribe to BackendEnabledChanged via a subgraph and
 *     bust cache entries proactively
 *
 * Usage:
 *   const gate = new PLRBackendGate({ registry, ttlMs: 5 * 60 * 1000 });
 *   try {
 *     await gate.assertEnabled("pylabrobot.liquid_handling.backends.hamilton.STAR");
 *     // ... forward to PLR sidecar
 *   } catch (err) {
 *     if (err instanceof BackendDisabledError) {
 *       return { error: "backend_disabled", details: { ... } };
 *     }
 *     throw err;
 *   }
 */

import { BackendDisabledError } from "@pcc/spec";

/**
 * Minimal interface for the underlying client. We don't import
 * @pcc/plr-registry-client directly to keep the aggregator package's
 * dependency surface narrow — the caller injects a client instance.
 */
export interface PLRRegistryReader {
  /** Returns true iff the backend is registered AND enabled. */
  isEnabled(modulePath: string): Promise<boolean>;
  /** Returns the on-chain record or null if not registered. */
  getRecord(modulePath: string): Promise<{
    enabled: boolean;
    lastEnabledChange: number;
    manifestCid: string;
  } | null>;
  /** Returns the current author address resolved via ContributorNFT.ownerOf. */
  authorOf(modulePath: string): Promise<string>;
}

export interface PLRBackendGateOptions {
  /** Read-only registry client (injected). */
  registry: PLRRegistryReader;
  /**
   * Cache TTL in milliseconds. Default: 5 minutes per scoping doc §5.2.
   * Pass 0 to disable caching (every assertEnabled hits the RPC).
   */
  ttlMs?: number;
  /**
   * Override the feature-flag env var read. Defaults to reading
   * PCC_PLR_BACKEND_REGISTRY_ENABLED at construction time.
   */
  enabledOverride?: boolean;
  /** Wall-clock source — injected for tests. */
  now?: () => number;
}

interface CacheEntry {
  enabled: boolean;
  fetchedAtMs: number;
  lastEnabledChange?: number;
  manifestCid?: string;
  author?: string;
}

/**
 * Short-circuits to `true` when PCC_PLR_BACKEND_REGISTRY_ENABLED is not
 * exactly "1" / "true" — this is the rollout safety hatch per intake
 * "Feature flag" section: until the registry is populated and we're ready
 * to enforce, every backend is treated as allowed.
 */
function readFeatureFlag(): boolean {
  const v = process.env.PCC_PLR_BACKEND_REGISTRY_ENABLED;
  return v === "1" || v?.toLowerCase() === "true";
}

export class PLRBackendGate {
  private readonly registry: PLRRegistryReader;
  private readonly ttlMs: number;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: PLRBackendGateOptions) {
    this.registry = opts.registry;
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.enabled =
      opts.enabledOverride !== undefined
        ? opts.enabledOverride
        : readFeatureFlag();
    this.now = opts.now ?? Date.now;
  }

  /**
   * Throws `BackendDisabledError` if the backend is registered AND
   * `enabled` is false. Pass-through (no throw) for unregistered
   * backends OR when the feature flag is off.
   */
  async assertEnabled(modulePath: string): Promise<void> {
    if (!this.enabled) {
      return; // Feature flag off — preserve legacy behavior.
    }

    const entry = await this._lookup(modulePath);

    // Unregistered backends pass through (the on-chain assertEnabled does
    // the same — registered=false means no record, no opinion).
    if (entry === null) {
      return;
    }

    if (!entry.enabled) {
      throw new BackendDisabledError({
        modulePath,
        lastEnabledChange: entry.lastEnabledChange,
        author: entry.author,
        manifestCid: entry.manifestCid,
      });
    }
  }

  /**
   * Like assertEnabled but returns a boolean instead of throwing.
   * Useful for quoting flows that want to silently exclude disabled
   * backends from search results.
   */
  async isEnabled(modulePath: string): Promise<boolean> {
    if (!this.enabled) return true;
    const entry = await this._lookup(modulePath);
    return entry === null || entry.enabled;
  }

  /**
   * Drop a single cache entry. The aggregator's event-subscriber (Phase 2)
   * will call this on BackendEnabledChanged events.
   */
  invalidate(modulePath: string): void {
    this.cache.delete(modulePath);
  }

  /** Drop all cache entries. Used by tests + cache-warmup helpers. */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async _lookup(modulePath: string): Promise<CacheEntry | null> {
    const cached = this.cache.get(modulePath);
    if (cached && this.now() - cached.fetchedAtMs < this.ttlMs) {
      return cached;
    }

    const record = await this.registry.getRecord(modulePath);
    if (record === null) {
      // Cache the "not registered" verdict too — don't hammer the chain
      // for every job against an unregistered backend.
      const entry: CacheEntry = {
        enabled: true, // Unregistered = allowed
        fetchedAtMs: this.now(),
      };
      this.cache.set(modulePath, entry);
      return null;
    }

    // Resolve author best-effort; the registry's authorOf can revert if
    // the ContributorNFT was burned. Don't fail the gate over that.
    let author: string | undefined;
    try {
      author = await this.registry.authorOf(modulePath);
    } catch {
      author = undefined;
    }

    const entry: CacheEntry = {
      enabled: record.enabled,
      fetchedAtMs: this.now(),
      lastEnabledChange: record.lastEnabledChange,
      manifestCid: record.manifestCid,
      author,
    };
    this.cache.set(modulePath, entry);
    return entry;
  }
}
