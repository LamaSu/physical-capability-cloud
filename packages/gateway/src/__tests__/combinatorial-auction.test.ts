/**
 * Tests for CombinatorialAuction — greedy set-cover approximation.
 *
 * Covers:
 *   - Bid submission (valid + error paths)
 *   - Greedy winner determination
 *   - CWM-to-auction creation (static fromCWM)
 *   - Unallocated step tracking
 *   - Allocation efficiency calculation
 *   - Idempotent resolve
 *   - Expired bid handling
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  CombinatorialAuction,
  type AuctionBid,
} from "../services/combinatorial-auction.js";
import type { CWM } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBid(
  bidderId: string,
  bundle: string[],
  totalPrice: string,
  validUntil = Date.now() + 60_000
): AuctionBid {
  // Distribute totalPrice evenly across bundle for perCapabilityPrices
  const perCap = (parseFloat(totalPrice) / bundle.length).toFixed(2);
  // Re-sum to ensure exact match (last element absorbs rounding)
  const perCapabilityPrices: Record<string, string> = {};
  let remaining = parseFloat(totalPrice);
  for (let i = 0; i < bundle.length; i++) {
    if (i === bundle.length - 1) {
      perCapabilityPrices[bundle[i]] = remaining.toFixed(2);
    } else {
      const share = parseFloat(perCap);
      perCapabilityPrices[bundle[i]] = share.toFixed(2);
      remaining -= share;
    }
  }
  return { bidderId, bundle, totalPrice, perCapabilityPrices, validUntil };
}

/** Build a minimal CWM with the given step IDs */
function makeCWM(stepIds: string[]): CWM {
  return {
    version: "1.0",
    id: "cwm-test",
    name: "Test Workflow",
    steps: stepIds.map((id) => ({
      id,
      capability: "cnc-3axis",
      params: {},
      assuranceTier: 1,
      dependsOn: [],
    })),
    settlement: {
      currency: "USDC",
      maxBudget: "1000.00",
      payer: "0xdeadbeef",
    },
    createdAt: new Date().toISOString(),
    submitter: "0xdeadbeef",
  } as unknown as CWM;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CombinatorialAuction", () => {
  let auction: CombinatorialAuction;

  beforeEach(() => {
    auction = new CombinatorialAuction();
  });

  // ── createAuction / submitBid ─────────────────────────────────────────────

  describe("createAuction()", () => {
    it("creates an auction with the specified required steps", () => {
      const id = auction.createAuction(["step-1", "step-2", "step-3"]);
      expect(auction.getRequiredSteps(id)).toEqual(["step-1", "step-2", "step-3"]);
    });

    it("returns a unique ID each time", () => {
      const id1 = auction.createAuction(["step-1"]);
      const id2 = auction.createAuction(["step-1"]);
      expect(id1).not.toBe(id2);
    });
  });

  describe("submitBid()", () => {
    it("accepts a valid bid", () => {
      const id = auction.createAuction(["step-1", "step-2"]);
      const bid = makeBid("bidder-A", ["step-1", "step-2"], "20.00");
      expect(() => auction.submitBid(id, bid)).not.toThrow();
      expect(auction.getBids(id)).toHaveLength(1);
    });

    it("throws on unknown auction ID", () => {
      expect(() =>
        auction.submitBid("no-such-auction", makeBid("b", ["step-1"], "5.00"))
      ).toThrow("Auction not found");
    });

    it("throws when bid references a step not in the auction", () => {
      const id = auction.createAuction(["step-1"]);
      expect(() =>
        auction.submitBid(id, makeBid("b", ["step-999"], "5.00"))
      ).toThrow("step IDs not in auction");
    });

    it("throws on empty bundle", () => {
      const id = auction.createAuction(["step-1"]);
      const bid: AuctionBid = {
        bidderId: "b",
        bundle: [],
        totalPrice: "0.00",
        perCapabilityPrices: {},
        validUntil: Date.now() + 60_000,
      };
      expect(() => auction.submitBid(id, bid)).toThrow("at least one capability");
    });

    it("throws when perCapabilityPrices is missing a bundle entry", () => {
      const id = auction.createAuction(["step-1", "step-2"]);
      const bid: AuctionBid = {
        bidderId: "b",
        bundle: ["step-1", "step-2"],
        totalPrice: "10.00",
        perCapabilityPrices: { "step-1": "10.00" }, // step-2 missing
        validUntil: Date.now() + 60_000,
      };
      expect(() => auction.submitBid(id, bid)).toThrow("missing entries");
    });

    it("throws when totalPrice doesn't reconcile with per-capability sum", () => {
      const id = auction.createAuction(["step-1", "step-2"]);
      const bid: AuctionBid = {
        bidderId: "b",
        bundle: ["step-1", "step-2"],
        totalPrice: "100.00", // wrong — sum is 10
        perCapabilityPrices: { "step-1": "5.00", "step-2": "5.00" },
        validUntil: Date.now() + 60_000,
      };
      expect(() => auction.submitBid(id, bid)).toThrow("does not match sum");
    });

    it("throws after auction is resolved", () => {
      const id = auction.createAuction(["step-1"]);
      auction.submitBid(id, makeBid("b", ["step-1"], "5.00"));
      auction.resolve(id);
      expect(() =>
        auction.submitBid(id, makeBid("b2", ["step-1"], "4.00"))
      ).toThrow("already been resolved");
    });
  });

  // ── resolve() — greedy winner determination ───────────────────────────────

  describe("resolve()", () => {
    it("picks the single bid when there is only one", () => {
      const id = auction.createAuction(["step-1", "step-2"]);
      auction.submitBid(id, makeBid("A", ["step-1", "step-2"], "20.00"));

      const result = auction.resolve(id);

      expect(result.winningBids).toHaveLength(1);
      expect(result.winningBids[0].bidderId).toBe("A");
      expect(result.totalCost).toBe("20.00");
      expect(result.allocationEfficiency).toBe(1);
      expect(result.unallocatedSteps).toEqual([]);
    });

    it("selects complementary bids that together cover all steps", () => {
      const id = auction.createAuction(["step-1", "step-2", "step-3"]);
      // A covers step-1 at $5/step density
      auction.submitBid(id, makeBid("A", ["step-1"], "5.00"));
      // B covers step-2 + step-3 at $4/step density — cheaper per step
      auction.submitBid(id, makeBid("B", ["step-2", "step-3"], "8.00"));

      const result = auction.resolve(id);

      // Greedy picks lowest density first: B ($4/step), then A ($5/step)
      expect(result.winningBids.map((b) => b.bidderId).sort()).toEqual(["A", "B"]);
      expect(result.allocationEfficiency).toBe(1);
      expect(result.totalCost).toBe("13.00");
      expect(result.unallocatedSteps).toEqual([]);
    });

    it("prefers lower density bundle over higher density single bid", () => {
      const id = auction.createAuction(["step-1", "step-2"]);
      // Bundle bid: $6 for 2 steps = $3/step density
      auction.submitBid(id, makeBid("cheap-bundle", ["step-1", "step-2"], "6.00"));
      // Two single bids at $4 each = $4/step density each
      auction.submitBid(id, makeBid("expensive-1", ["step-1"], "4.00"));
      auction.submitBid(id, makeBid("expensive-2", ["step-2"], "4.00"));

      const result = auction.resolve(id);

      // Bundle wins (density 3 < 4)
      expect(result.winningBids).toHaveLength(1);
      expect(result.winningBids[0].bidderId).toBe("cheap-bundle");
      expect(result.totalCost).toBe("6.00");
    });

    it("reports unallocated steps when no bid covers them", () => {
      const id = auction.createAuction(["step-1", "step-2", "step-3"]);
      // Only covers step-1 and step-2
      auction.submitBid(id, makeBid("A", ["step-1", "step-2"], "10.00"));

      const result = auction.resolve(id);

      expect(result.unallocatedSteps).toContain("step-3");
      expect(result.allocationEfficiency).toBeCloseTo(2 / 3, 5);
    });

    it("returns 0% efficiency and all steps unallocated when no bids submitted", () => {
      const id = auction.createAuction(["step-1", "step-2"]);
      const result = auction.resolve(id);

      expect(result.winningBids).toEqual([]);
      expect(result.totalCost).toBe("0.00");
      expect(result.allocationEfficiency).toBe(0);
      expect(result.unallocatedSteps).toEqual(["step-1", "step-2"]);
    });

    it("returns 100% efficiency and no unallocated steps for empty CWM", () => {
      const id = auction.createAuction([]);
      const result = auction.resolve(id);

      expect(result.allocationEfficiency).toBe(1);
      expect(result.unallocatedSteps).toEqual([]);
      expect(result.totalCost).toBe("0.00");
    });

    it("ignores expired bids", () => {
      const id = auction.createAuction(["step-1"]);
      const expired = makeBid("expired-bidder", ["step-1"], "5.00", Date.now() - 1);
      auction.submitBid(id, expired);

      const result = auction.resolve(id);

      expect(result.winningBids).toHaveLength(0);
      expect(result.unallocatedSteps).toContain("step-1");
      expect(result.allocationEfficiency).toBe(0);
    });

    it("is idempotent — subsequent calls return same result", () => {
      const id = auction.createAuction(["step-1"]);
      auction.submitBid(id, makeBid("A", ["step-1"], "7.00"));

      const first = auction.resolve(id);
      const second = auction.resolve(id);

      expect(second).toEqual(first);
    });

    it("does not double-allocate the same step from two overlapping bids", () => {
      const id = auction.createAuction(["step-1", "step-2"]);
      // Both bids have the same density ($5/step), first one added wins step-1
      auction.submitBid(id, makeBid("A", ["step-1"], "5.00"));
      auction.submitBid(id, makeBid("B", ["step-1", "step-2"], "10.00"));

      const result = auction.resolve(id);

      // A wins step-1, B still needed for step-2 (A doesn't cover it)
      // B's bundle overlaps with A on step-1 but should still win step-2
      const winners = result.winningBids.map((b) => b.bidderId);
      expect(winners).toContain("A");
      // step-2 must be covered
      expect(result.unallocatedSteps).not.toContain("step-2");
    });
  });

  // ── static fromCWM ────────────────────────────────────────────────────────

  describe("static fromCWM()", () => {
    it("creates an auction with step IDs derived from the CWM", () => {
      const cwm = makeCWM(["cwm-step-1", "cwm-step-2", "cwm-step-3"]);
      const auctionId = CombinatorialAuction.fromCWM(cwm);

      // The default instance should know about this auction
      const steps = CombinatorialAuction._defaultInstance.getRequiredSteps(auctionId);
      expect(steps).toEqual(["cwm-step-1", "cwm-step-2", "cwm-step-3"]);
    });

    it("returns a different auction ID for each CWM", () => {
      const cwm1 = makeCWM(["s1"]);
      const cwm2 = makeCWM(["s1"]);
      expect(CombinatorialAuction.fromCWM(cwm1)).not.toBe(CombinatorialAuction.fromCWM(cwm2));
    });

    it("creates an auction with no required steps for an empty CWM", () => {
      const cwm = makeCWM([]);
      const auctionId = CombinatorialAuction.fromCWM(cwm);
      const steps = CombinatorialAuction._defaultInstance.getRequiredSteps(auctionId);
      expect(steps).toEqual([]);
    });
  });
});
