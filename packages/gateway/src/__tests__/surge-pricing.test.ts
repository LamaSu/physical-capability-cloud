/**
 * Tests for SurgePricingService — queue-depth-driven additive surge pricing.
 *
 * Covers:
 *   - Threshold-based surge levels (additive, not multiplicative)
 *   - Max cap enforcement
 *   - Cooldown window (returns cached multiplier while active)
 *   - applyToPrice (base * surge → formatted string)
 *   - getSurgeLevels map
 *   - Config validation
 *   - Edge cases: zero queue depth, boundary conditions
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  SurgePricingService,
  DEFAULT_SURGE_CONFIG,
  type SurgeConfig,
} from "../services/surge-pricing.js";

// ---------------------------------------------------------------------------
// Test config: thresholds [3, 5, 8], increments [0.10, 0.25, 0.50]
// base=1.0, max=2.0, cooldown=5min
// ---------------------------------------------------------------------------

const TEST_CONFIG: SurgeConfig = {
  baseMultiplier: 1.0,
  queueThresholds: [3, 5, 8],
  surgeIncrements: [0.1, 0.25, 0.5],
  maxSurge: 2.0,
  cooldownMinutes: 5,
};

describe("SurgePricingService", () => {
  let service: SurgePricingService;

  beforeEach(() => {
    // Use fake timers to control cooldown
    vi.useFakeTimers();
    service = new SurgePricingService(TEST_CONFIG);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── calculateSurge() — threshold levels ───────────────────────────────────

  describe("calculateSurge() — threshold levels", () => {
    it("returns baseMultiplier (1.0) when queue depth is below all thresholds", () => {
      expect(service.calculateSurge("cap-1", 0)).toBe(1.0);
      expect(service.calculateSurge("cap-1", 1)).toBe(1.0);
      // need to expire cooldown between calls
      service.invalidateCooldown("cap-1");
      expect(service.calculateSurge("cap-1", 2)).toBe(1.0);
    });

    it("adds +0.10 when queue depth equals the first threshold (3)", () => {
      const multiplier = service.calculateSurge("cap-1", 3);
      expect(multiplier).toBeCloseTo(1.1, 5);
    });

    it("adds +0.10 when queue depth is between threshold 1 and 2 (depth=4)", () => {
      const multiplier = service.calculateSurge("cap-1", 4);
      expect(multiplier).toBeCloseTo(1.1, 5);
    });

    it("adds +0.10+0.25=0.35 when queue depth equals threshold 2 (depth=5)", () => {
      const multiplier = service.calculateSurge("cap-1", 5);
      expect(multiplier).toBeCloseTo(1.35, 5);
    });

    it("adds +0.10+0.25=0.35 when queue depth is between threshold 2 and 3 (depth=7)", () => {
      const multiplier = service.calculateSurge("cap-1", 7);
      expect(multiplier).toBeCloseTo(1.35, 5);
    });

    it("adds +0.10+0.25+0.50=0.85 when queue depth equals threshold 3 (depth=8)", () => {
      const multiplier = service.calculateSurge("cap-1", 8);
      expect(multiplier).toBeCloseTo(1.85, 5);
    });

    it("surge is additive, NOT multiplicative", () => {
      // Additive: 1.0 + 0.10 + 0.25 + 0.50 = 1.85
      // Multiplicative would be: 1.0 * 1.10 * 1.25 * 1.50 = 2.0625
      const multiplier = service.calculateSurge("cap-1", 10);
      expect(multiplier).toBeCloseTo(1.85, 5);
      expect(multiplier).not.toBeCloseTo(2.0625, 2);
    });
  });

  // ── calculateSurge() — max cap ────────────────────────────────────────────

  describe("calculateSurge() — max surge cap", () => {
    it("caps at maxSurge (2.0) regardless of queue depth", () => {
      // Config max is 2.0, but 1.85 is the highest reachable with our increments
      // Test with a custom config where increments would push above max
      const cappedService = new SurgePricingService({
        baseMultiplier: 1.0,
        queueThresholds: [1, 2, 3],
        surgeIncrements: [0.5, 0.5, 0.5],
        maxSurge: 1.5,
        cooldownMinutes: 0,
      });

      // Without cap: 1.0 + 0.5 + 0.5 + 0.5 = 2.5 — but cap is 1.5
      const multiplier = cappedService.calculateSurge("cap-1", 10);
      expect(multiplier).toBe(1.5);
    });

    it("respects maxSurge=2.0 with very deep queue", () => {
      const multiplier = service.calculateSurge("cap-1", 10000);
      expect(multiplier).toBeLessThanOrEqual(2.0);
    });
  });

  // ── calculateSurge() — cooldown ───────────────────────────────────────────

  describe("calculateSurge() — cooldown window", () => {
    it("returns cached multiplier while within cooldown window", () => {
      // First call at queue=8 → 1.85
      const first = service.calculateSurge("cap-1", 8);
      expect(first).toBeCloseTo(1.85, 5);

      // Advance 2 minutes (less than 5-minute cooldown)
      vi.advanceTimersByTime(2 * 60 * 1000);

      // Even though queue is now 0, should still return 1.85 (cached)
      const second = service.calculateSurge("cap-1", 0);
      expect(second).toBeCloseTo(1.85, 5);
    });

    it("recomputes after cooldown expires", () => {
      // First call at queue=8 → 1.85
      service.calculateSurge("cap-1", 8);

      // Advance past 5-minute cooldown
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Now queue depth is 0 → 1.0
      const recomputed = service.calculateSurge("cap-1", 0);
      expect(recomputed).toBeCloseTo(1.0, 5);
    });

    it("cooldown is per-capability — other capabilities compute fresh", () => {
      service.calculateSurge("cap-1", 8); // sets cooldown on cap-1

      // cap-2 has no cooldown — should compute fresh
      const cap2 = service.calculateSurge("cap-2", 0);
      expect(cap2).toBeCloseTo(1.0, 5);
    });

    it("invalidateCooldown() forces recomputation on next call", () => {
      service.calculateSurge("cap-1", 8);

      service.invalidateCooldown("cap-1");

      // Now within what would be the cooldown window, but forcibly expired
      const fresh = service.calculateSurge("cap-1", 0);
      expect(fresh).toBeCloseTo(1.0, 5);
    });

    it("cooldownMinutes=0 means every call recomputes", () => {
      const noCooldown = new SurgePricingService({
        ...TEST_CONFIG,
        cooldownMinutes: 0,
      });

      noCooldown.calculateSurge("cap-1", 8);
      const fresh = noCooldown.calculateSurge("cap-1", 0);
      expect(fresh).toBeCloseTo(1.0, 5);
    });
  });

  // ── applyToPrice() ────────────────────────────────────────────────────────

  describe("applyToPrice()", () => {
    it("returns basePrice when surge is 1.0", () => {
      expect(service.applyToPrice("10.00", 1.0)).toBe("10.00");
    });

    it("applies 10% surge to $10.00 → $11.00", () => {
      expect(service.applyToPrice("10.00", 1.1)).toBe("11.00");
    });

    it("applies 35% surge to $20.00 → $27.00", () => {
      expect(service.applyToPrice("20.00", 1.35)).toBe("27.00");
    });

    it("applies 85% surge to $12.00 → $22.20", () => {
      expect(service.applyToPrice("12.00", 1.85)).toBe("22.20");
    });

    it("rounds to 2 decimal places", () => {
      // $3.33 * 1.1 = $3.663 → rounds to $3.66
      const result = service.applyToPrice("3.33", 1.1);
      expect(result).toBe("3.66");
    });

    it("throws on invalid price string", () => {
      expect(() => service.applyToPrice("abc", 1.1)).toThrow("Invalid price string");
    });

    it("throws on negative price string", () => {
      expect(() => service.applyToPrice("-5.00", 1.1)).toThrow("Invalid price string");
    });
  });

  // ── getSurgeLevels() ──────────────────────────────────────────────────────

  describe("getSurgeLevels()", () => {
    it("returns empty map when no capabilities have been observed", () => {
      expect(service.getSurgeLevels().size).toBe(0);
    });

    it("returns current multipliers for all observed capabilities", () => {
      service.calculateSurge("cap-a", 3); // 1.1
      service.calculateSurge("cap-b", 8); // 1.85

      const levels = service.getSurgeLevels();
      expect(levels.size).toBe(2);
      expect(levels.get("cap-a")).toBeCloseTo(1.1, 5);
      expect(levels.get("cap-b")).toBeCloseTo(1.85, 5);
    });

    it("returns a snapshot — mutations to returned map don't affect service state", () => {
      service.calculateSurge("cap-1", 3);
      const levels = service.getSurgeLevels();
      levels.set("cap-1", 99);

      // Service should still report the original value (via cooldown)
      const levels2 = service.getSurgeLevels();
      expect(levels2.get("cap-1")).toBeCloseTo(1.1, 5);
    });
  });

  // ── reset() ───────────────────────────────────────────────────────────────

  describe("reset()", () => {
    it("clears all cached surge state", () => {
      service.calculateSurge("cap-1", 8);
      service.reset();
      expect(service.getSurgeLevels().size).toBe(0);
    });

    it("allows fresh computation after reset", () => {
      service.calculateSurge("cap-1", 8); // 1.85
      service.reset();
      const fresh = service.calculateSurge("cap-1", 0); // 1.0
      expect(fresh).toBeCloseTo(1.0, 5);
    });
  });

  // ── Config validation ─────────────────────────────────────────────────────

  describe("config validation", () => {
    it("throws when queueThresholds and surgeIncrements have different lengths", () => {
      expect(
        () =>
          new SurgePricingService({
            queueThresholds: [3, 5],
            surgeIncrements: [0.1], // length mismatch
          })
      ).toThrow("same length");
    });

    it("throws when queueThresholds are not strictly increasing", () => {
      expect(
        () =>
          new SurgePricingService({
            queueThresholds: [5, 3, 8], // 5 > 3 — not increasing
            surgeIncrements: [0.1, 0.2, 0.3],
          })
      ).toThrow("strictly increasing");
    });

    it("throws when maxSurge < baseMultiplier", () => {
      expect(
        () =>
          new SurgePricingService({
            baseMultiplier: 2.0,
            maxSurge: 1.0,
          })
      ).toThrow("maxSurge must be >=");
    });

    it("throws on non-positive baseMultiplier", () => {
      expect(
        () =>
          new SurgePricingService({
            baseMultiplier: 0,
          })
      ).toThrow("baseMultiplier must be positive");
    });

    it("throws on negative cooldownMinutes", () => {
      expect(
        () =>
          new SurgePricingService({
            cooldownMinutes: -1,
          })
      ).toThrow("cooldownMinutes must be non-negative");
    });

    it("throws on negative queue depth", () => {
      const svc = new SurgePricingService();
      expect(() => svc.calculateSurge("cap-1", -1)).toThrow("non-negative");
    });
  });

  // ── DEFAULT_SURGE_CONFIG ──────────────────────────────────────────────────

  describe("DEFAULT_SURGE_CONFIG", () => {
    it("has the expected default values", () => {
      expect(DEFAULT_SURGE_CONFIG.baseMultiplier).toBe(1.0);
      expect(DEFAULT_SURGE_CONFIG.queueThresholds).toEqual([3, 5, 8]);
      expect(DEFAULT_SURGE_CONFIG.surgeIncrements).toEqual([0.1, 0.25, 0.5]);
      expect(DEFAULT_SURGE_CONFIG.maxSurge).toBe(2.0);
      expect(DEFAULT_SURGE_CONFIG.cooldownMinutes).toBe(5);
    });

    it("is valid (new SurgePricingService() without args does not throw)", () => {
      expect(() => new SurgePricingService()).not.toThrow();
    });
  });

  // ── getConfig() ───────────────────────────────────────────────────────────

  describe("getConfig()", () => {
    it("returns the active configuration", () => {
      const cfg = service.getConfig();
      expect(cfg.baseMultiplier).toBe(TEST_CONFIG.baseMultiplier);
      expect(cfg.maxSurge).toBe(TEST_CONFIG.maxSurge);
    });
  });
});
