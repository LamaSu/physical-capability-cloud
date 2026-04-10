/**
 * SurgePricingService — queue-depth-driven additive surge pricing.
 *
 * Surge is ADDITIVE, not multiplicative:
 *
 *   effectiveMultiplier = baseMultiplier + sum(active increments)
 *
 * This is more incentive-compatible than multiplicative surge because each
 * threshold increment is transparent and predictable. Operators can quote
 * the exact dollar impact of queue depth. Multiplicative compounding
 * creates non-linear price spikes that erode trust.
 *
 * Example with config { base: 1.0, thresholds: [3, 5, 8], increments: [0.1, 0.25, 0.5] }:
 *   queue=2  → 1.0   (no thresholds breached)
 *   queue=4  → 1.10  (threshold[0]=3 breached: +0.10)
 *   queue=6  → 1.35  (thresholds[0,1] breached: +0.10+0.25)
 *   queue=9  → 1.85  (all 3 breached: +0.10+0.25+0.50)
 *   queue=99 → capped at maxSurge (2.0 default)
 *
 * Cooldown: the multiplier for a capability is not updated more than once
 * per cooldownMinutes window. This prevents rapid oscillation when queue
 * depth fluctuates around a threshold boundary.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SurgeConfig {
  /** Starting multiplier with no queue pressure. Typically 1.0. */
  baseMultiplier: number;
  /**
   * Queue depths (in number of pending jobs) that trigger each surge level.
   * Must be strictly increasing. e.g. [3, 5, 8]
   */
  queueThresholds: number[];
  /**
   * Additive price increment per threshold level. Must have same length as
   * queueThresholds. e.g. [0.10, 0.25, 0.50]
   */
  surgeIncrements: number[];
  /** Hard ceiling on the surge multiplier. e.g. 2.0 */
  maxSurge: number;
  /** Minimum minutes between multiplier updates for the same capability. */
  cooldownMinutes: number;
}

// ---------------------------------------------------------------------------
// Internal per-capability state
// ---------------------------------------------------------------------------

interface CapabilitySurgeState {
  /** The currently active surge multiplier (may be stale if within cooldown) */
  currentMultiplier: number;
  /** Timestamp (ms) when the multiplier was last updated */
  lastUpdatedAt: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SURGE_CONFIG: SurgeConfig = {
  baseMultiplier: 1.0,
  queueThresholds: [3, 5, 8],
  surgeIncrements: [0.1, 0.25, 0.5],
  maxSurge: 2.0,
  cooldownMinutes: 5,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a decimal price string to a float. */
function parsePrice(price: string): number {
  const v = parseFloat(price);
  if (!isFinite(v) || v < 0) throw new Error(`Invalid price string: "${price}"`);
  return v;
}

/** Format a float to a 2-decimal price string. */
function formatPrice(value: number): string {
  return value.toFixed(2);
}

/**
 * Compute the raw (un-capped, un-cooled) surge multiplier for a given queue depth.
 *
 * Each threshold that the queue depth equals or exceeds adds its corresponding
 * increment to the base multiplier.
 */
function computeRawSurge(queueDepth: number, config: SurgeConfig): number {
  let multiplier = config.baseMultiplier;

  for (let i = 0; i < config.queueThresholds.length; i++) {
    if (queueDepth >= config.queueThresholds[i]) {
      multiplier += config.surgeIncrements[i];
    }
  }

  return Math.min(multiplier, config.maxSurge);
}

// ---------------------------------------------------------------------------
// SurgePricingService
// ---------------------------------------------------------------------------

export class SurgePricingService {
  private readonly config: SurgeConfig;
  private readonly state = new Map<string, CapabilitySurgeState>();

  constructor(config: Partial<SurgeConfig> = {}) {
    const merged: SurgeConfig = { ...DEFAULT_SURGE_CONFIG, ...config };

    // Validate config
    if (merged.queueThresholds.length !== merged.surgeIncrements.length) {
      throw new Error(
        "queueThresholds and surgeIncrements must have the same length"
      );
    }
    if (merged.baseMultiplier <= 0) {
      throw new Error("baseMultiplier must be positive");
    }
    if (merged.maxSurge < merged.baseMultiplier) {
      throw new Error("maxSurge must be >= baseMultiplier");
    }
    if (merged.cooldownMinutes < 0) {
      throw new Error("cooldownMinutes must be non-negative");
    }

    // Validate thresholds are strictly increasing
    for (let i = 1; i < merged.queueThresholds.length; i++) {
      if (merged.queueThresholds[i] <= merged.queueThresholds[i - 1]) {
        throw new Error("queueThresholds must be strictly increasing");
      }
    }

    this.config = merged;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Calculate (and update) the surge multiplier for a capability.
   *
   * If the capability has an active cooldown, returns the cached multiplier
   * rather than computing a new one from the live queue depth.
   *
   * @param capabilityId - the capability being priced
   * @param queueDepth   - current number of pending jobs for this capability
   * @returns surge multiplier in range [baseMultiplier, maxSurge]
   */
  calculateSurge(capabilityId: string, queueDepth: number): number {
    if (queueDepth < 0) {
      throw new Error(`queueDepth must be non-negative, got ${queueDepth}`);
    }

    const now = Date.now();
    const existing = this.state.get(capabilityId);
    const cooldownMs = this.config.cooldownMinutes * 60 * 1000;

    // If within cooldown window, return the cached multiplier unchanged
    if (existing && now - existing.lastUpdatedAt < cooldownMs) {
      return existing.currentMultiplier;
    }

    // Compute fresh multiplier
    const newMultiplier = computeRawSurge(queueDepth, this.config);

    this.state.set(capabilityId, {
      currentMultiplier: newMultiplier,
      lastUpdatedAt: now,
    });

    return newMultiplier;
  }

  /**
   * Apply a surge multiplier to a base price string.
   *
   * Multiplies basePrice by surge and returns a formatted price string
   * rounded to 2 decimal places.
   *
   * @param basePrice - price string e.g. "10.00"
   * @param surge     - multiplier from calculateSurge()
   * @returns surged price string e.g. "13.50"
   */
  applyToPrice(basePrice: string, surge: number): string {
    const base = parsePrice(basePrice);
    const result = base * surge;
    return formatPrice(result);
  }

  /**
   * Get the current cached surge multiplier for every capability that has
   * been observed. Capabilities with no history are not included.
   *
   * Useful for dashboards / monitoring.
   */
  getSurgeLevels(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [capId, s] of this.state) {
      out.set(capId, s.currentMultiplier);
    }
    return out;
  }

  /**
   * Force-expire the cooldown for a capability so the next call to
   * calculateSurge() always recomputes. Useful in tests and for
   * administrative overrides.
   */
  invalidateCooldown(capabilityId: string): void {
    const existing = this.state.get(capabilityId);
    if (existing) {
      this.state.set(capabilityId, {
        ...existing,
        lastUpdatedAt: 0, // epoch 0 is always expired
      });
    }
  }

  /**
   * Reset all cached surge state. Useful for testing.
   */
  reset(): void {
    this.state.clear();
  }

  /**
   * Expose the active config for inspection.
   */
  getConfig(): Readonly<SurgeConfig> {
    return this.config;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton with default config
// ---------------------------------------------------------------------------

export const surgePricingService = new SurgePricingService();
