/**
 * Tests for ReputationService — decay math, cold-start bonuses, floor, and tier gating.
 *
 * All time-based tests pass an explicit `now` parameter so they are deterministic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ReputationService, resetReputationService } from "../services/reputation-service.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Build an ISO timestamp that is `daysAgo` days in the past relative to `now`. */
function daysAgo(days: number, now: number): string {
  return new Date(now - days * DAY_MS).toISOString();
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetReputationService();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ReputationService", () => {
  let svc: ReputationService;
  let now: number;

  beforeEach(() => {
    svc = new ReputationService();
    // Fixed point in time so all delta calculations are stable.
    now = new Date("2026-04-02T00:00:00.000Z").getTime();
  });

  // ── computeEffectiveReputation ─────────────────────────────────────────────

  describe("computeEffectiveReputation()", () => {
    describe("grace period (≤ 7 days of inactivity)", () => {
      it("returns base score unchanged at exactly 0 days", () => {
        const updatedAt = daysAgo(0, now);
        expect(svc.computeEffectiveReputation(800, updatedAt, 30, now)).toBe(800);
      });

      it("returns base score unchanged at 1 day", () => {
        const updatedAt = daysAgo(1, now);
        expect(svc.computeEffectiveReputation(800, updatedAt, 30, now)).toBe(800);
      });

      it("returns base score unchanged at exactly 7 days (boundary)", () => {
        const updatedAt = daysAgo(7, now);
        expect(svc.computeEffectiveReputation(800, updatedAt, 30, now)).toBe(800);
      });
    });

    describe("exponential decay beyond grace period", () => {
      it("decays to ~50% at 30 days (one half-life)", () => {
        const updatedAt = daysAgo(30, now);
        const result = svc.computeEffectiveReputation(1000, updatedAt, 30, now);
        // 1000 × 2^(-30/30) = 1000 × 0.5 = 500
        expect(result).toBe(500);
      });

      it("decays to ~25% at 60 days (two half-lives)", () => {
        const updatedAt = daysAgo(60, now);
        const result = svc.computeEffectiveReputation(1000, updatedAt, 30, now);
        // 1000 × 2^(-60/30) = 1000 × 0.25 = 250
        expect(result).toBe(250);
      });

      it("decays to ~12.5% at 90 days (three half-lives)", () => {
        const updatedAt = daysAgo(90, now);
        const result = svc.computeEffectiveReputation(1000, updatedAt, 30, now);
        // 1000 × 2^(-90/30) = 1000 × 0.125 = 125
        expect(result).toBe(125);
      });

      it("returns 50 (floor) when deeply decayed at 180 days", () => {
        const updatedAt = daysAgo(180, now);
        const result = svc.computeEffectiveReputation(1000, updatedAt, 30, now);
        // 1000 × 2^(-180/30) = 1000 × ~0.0156 ≈ 16 → floored to 50
        expect(result).toBe(50);
      });

      it("does not go below floor even for very large base scores", () => {
        const updatedAt = daysAgo(365, now);
        const result = svc.computeEffectiveReputation(1000, updatedAt, 30, now);
        expect(result).toBe(50);
      });
    });

    describe("floor", () => {
      it("returns floor (50) when decay would push below floor", () => {
        const updatedAt = daysAgo(100, now);
        const result = svc.computeEffectiveReputation(100, updatedAt, 30, now);
        // 100 × 2^(-100/30) ≈ 100 × 0.098 ≈ 10 → floored to 50
        expect(result).toBe(50);
      });

      it("returns floor when base score is already at floor", () => {
        const updatedAt = daysAgo(180, now);
        const result = svc.computeEffectiveReputation(50, updatedAt, 30, now);
        expect(result).toBe(50);
      });
    });

    describe("legacy rows (no reputationUpdatedAt)", () => {
      it("returns base score unchanged when updatedAt is null", () => {
        expect(svc.computeEffectiveReputation(720, null, 100, now)).toBe(720);
      });

      it("returns base score unchanged when updatedAt is undefined", () => {
        expect(svc.computeEffectiveReputation(720, undefined, 100, now)).toBe(720);
      });

      it("returns base score unchanged when updatedAt is empty string", () => {
        // Empty string parses to NaN — treated as missing.
        expect(svc.computeEffectiveReputation(720, "", 100, now)).toBe(720);
      });
    });

    describe("cold-start bonus (< 20 jobs) — T1.5 capped at +50", () => {
      it("adds +30 bonus for the first job", () => {
        const updatedAt = daysAgo(0, now);
        // 1 job × 30 = 30 bonus → 0 + 30 = 30
        const result = svc.computeEffectiveReputation(0, updatedAt, 1, now);
        expect(result).toBe(30);
      });

      it("T1.5 — caps cold-start bonus at +50 (not +600) once cumulative ≥ 50", () => {
        const updatedAt = daysAgo(0, now);
        // 2 jobs would give 60 raw, clamped to 50.
        const result = svc.computeEffectiveReputation(0, updatedAt, 2, now);
        expect(result).toBe(50);
      });

      it("T1.5 — caps at +50 even at 19 jobs (was +570)", () => {
        const updatedAt = daysAgo(0, now);
        const result = svc.computeEffectiveReputation(0, updatedAt, 19, now);
        expect(result).toBe(50);
      });

      it("returns 0 once jobs ≥ 20 (cold-start exit threshold unchanged)", () => {
        const updatedAt = daysAgo(0, now);
        const result = svc.computeEffectiveReputation(0, updatedAt, 20, now);
        expect(result).toBe(0);
      });

      it("cold-start bonus combined with existing base score", () => {
        const updatedAt = daysAgo(0, now);
        // base 200 + min(10 × 30, 50) = 250
        const result = svc.computeEffectiveReputation(200, updatedAt, 10, now);
        expect(result).toBe(250);
      });

      it("cold-start bonus is capped at 1000 total (still respects ceiling)", () => {
        const updatedAt = daysAgo(0, now);
        // base 980 + min(15 × 30, 50) = 1030 → capped at 1000
        const result = svc.computeEffectiveReputation(980, updatedAt, 15, now);
        expect(result).toBe(1000);
      });
    });
  });

  // ── coldStartBonus ─────────────────────────────────────────────────────────

  describe("coldStartBonus() — T1.5 capped at +50", () => {
    it("returns 0 for 0 completed jobs", () => {
      expect(svc.coldStartBonus(0)).toBe(0);
    });

    it("returns 30 for 1 completed job", () => {
      expect(svc.coldStartBonus(1)).toBe(30);
    });

    it("T1.5 — clamps at +50 from 2 jobs onwards (was 60, 90, … 570)", () => {
      expect(svc.coldStartBonus(2)).toBe(50);
      expect(svc.coldStartBonus(10)).toBe(50);
      expect(svc.coldStartBonus(19)).toBe(50);
    });

    it("returns 0 for exactly 20 completed jobs (threshold unchanged)", () => {
      expect(svc.coldStartBonus(20)).toBe(0);
    });

    it("returns 0 for 100 completed jobs", () => {
      expect(svc.coldStartBonus(100)).toBe(0);
    });
  });

  // ── getMaxAllowedTier ──────────────────────────────────────────────────────

  describe("getMaxAllowedTier()", () => {
    describe("Tier 0/1 — always allowed", () => {
      it("returns tier 1 for a brand-new operator with 0 jobs and 0 rep", () => {
        expect(svc.getMaxAllowedTier(0, 0)).toBe(1);
      });

      it("returns tier 1 for 4 jobs and high reputation (not enough jobs for tier 2)", () => {
        expect(svc.getMaxAllowedTier(900, 4)).toBe(1);
      });

      it("returns tier 1 for 5 jobs but rep below 300", () => {
        expect(svc.getMaxAllowedTier(299, 5)).toBe(1);
      });
    });

    describe("Tier 2 — requires ≥ 5 jobs AND rep ≥ 300", () => {
      it("returns tier 2 at exactly the threshold (5 jobs, rep 300)", () => {
        expect(svc.getMaxAllowedTier(300, 5)).toBe(2);
      });

      it("returns tier 2 for 10 jobs and rep 500", () => {
        expect(svc.getMaxAllowedTier(500, 10)).toBe(2);
      });

      it("returns tier 2 for 19 jobs and rep 599 (just below tier 3 rep)", () => {
        expect(svc.getMaxAllowedTier(599, 19)).toBe(2);
      });
    });

    describe("Tier 3 — requires ≥ 20 jobs AND rep ≥ 600", () => {
      it("returns tier 3 at exactly the threshold (20 jobs, rep 600)", () => {
        expect(svc.getMaxAllowedTier(600, 20)).toBe(3);
      });

      it("returns tier 3 for 100 jobs and rep 1000", () => {
        expect(svc.getMaxAllowedTier(1000, 100)).toBe(3);
      });

      it("does not return tier 3 for 20 jobs but rep 599", () => {
        expect(svc.getMaxAllowedTier(599, 20)).toBe(2);
      });

      it("does not return tier 3 for rep 600 but only 19 jobs", () => {
        expect(svc.getMaxAllowedTier(600, 19)).toBe(2);
      });
    });
  });

  // ── computeReputationGain ──────────────────────────────────────────────────

  describe("computeReputationGain()", () => {
    it("grants +5 for tier 0 success", () => {
      expect(svc.computeReputationGain(true, 0)).toBe(5);
    });

    it("grants +10 for tier 1 success", () => {
      expect(svc.computeReputationGain(true, 1)).toBe(10);
    });

    it("grants +20 for tier 2 success", () => {
      expect(svc.computeReputationGain(true, 2)).toBe(20);
    });

    it("grants +40 for tier 3 success", () => {
      expect(svc.computeReputationGain(true, 3)).toBe(40);
    });

    it("deducts -10 for tier 0/1 failure", () => {
      expect(svc.computeReputationGain(false, 0)).toBe(-10);
      expect(svc.computeReputationGain(false, 1)).toBe(-10);
    });

    it("deducts -50 for tier 2 failure", () => {
      expect(svc.computeReputationGain(false, 2)).toBe(-50);
    });

    it("deducts -100 for tier 3 failure", () => {
      expect(svc.computeReputationGain(false, 3)).toBe(-100);
    });
  });

  // ── Integration scenarios ──────────────────────────────────────────────────

  describe("integration scenarios", () => {
    it("a veteran operator (high rep, recent activity) can access tier 3", () => {
      const updatedAt = daysAgo(3, now); // within grace period, no decay
      const effective = svc.computeEffectiveReputation(900, updatedAt, 50, now);
      const tier = svc.getMaxAllowedTier(effective, 50);
      expect(effective).toBe(900);
      expect(tier).toBe(3);
    });

    it("a veteran operator with 6 months of inactivity loses tier 3 access", () => {
      const updatedAt = daysAgo(180, now);
      const effective = svc.computeEffectiveReputation(900, updatedAt, 50, now);
      // 900 × 2^(-180/30) ≈ 900 × 0.0156 ≈ 14 → floor 50
      const tier = svc.getMaxAllowedTier(effective, 50);
      expect(effective).toBe(50);
      expect(tier).toBe(1); // 50 < 300, so only tier 1
    });

    it("a new operator progresses from tier 1 to tier 2 after 5 jobs", () => {
      const updatedAt = daysAgo(1, now);
      // 0 base rep + 5 × 30 = 150 bonus → effective 150 → tier 1
      const effectiveBefore = svc.computeEffectiveReputation(0, updatedAt, 4, now);
      const tierBefore = svc.getMaxAllowedTier(effectiveBefore, 4);

      // After 5 jobs: base 0 + 5 × 30 = 150 bonus → effective 150 → tier 1 (rep still < 300)
      // Need base rep too — simulate a rep update after 5 jobs
      const effectiveAfterRepUpdate = svc.computeEffectiveReputation(300, updatedAt, 5, now);
      const tierAfter = svc.getMaxAllowedTier(effectiveAfterRepUpdate, 5);

      expect(tierBefore).toBe(1);
      expect(tierAfter).toBe(2);
    });

    it("decay is read-time: same DB row returns different scores at different times", () => {
      const baseScore = 1000;
      const storedUpdatedAt = new Date("2026-01-01T00:00:00.000Z").toISOString();

      // Reading in early January: within grace period
      const earlyJan = new Date("2026-01-07T00:00:00.000Z").getTime();
      const scoreEarlyJan = svc.computeEffectiveReputation(baseScore, storedUpdatedAt, 50, earlyJan);

      // Reading 3 months later (April)
      const lateApril = new Date("2026-04-01T00:00:00.000Z").getTime();
      const scoreLateApril = svc.computeEffectiveReputation(baseScore, storedUpdatedAt, 50, lateApril);

      expect(scoreEarlyJan).toBe(1000); // within grace period
      expect(scoreLateApril).toBeLessThan(200); // ~90 days → 125
    });
  });
});
