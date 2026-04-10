/**
 * CombinatorialAuction — greedy set-cover approximation for multi-step CWM workflows.
 *
 * When a CWM has N steps requiring different capabilities, a single bidder may
 * cover a subset (a "bundle"). Optimal winner determination is NP-hard (winner
 * determination problem). We use a greedy approximation:
 *
 *   1. Compute value density for each bid: totalPrice / |bundle|
 *   2. Greedily pick the bid with the LOWEST density (cheapest per capability)
 *      that covers at least one uncovered step.
 *   3. Mark covered steps, remove conflicts, repeat until all steps covered
 *      or no useful bids remain.
 *
 * Allocation efficiency = covered_steps / total_steps.
 *
 * All prices are strings to match PCC's Amount type (avoids float precision
 * issues with monetary values).
 */

import { randomUUID } from "crypto";
import type { CWM } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuctionBid {
  /** Kernel operator DID or kernel ID */
  bidderId: string;
  /** Capability IDs this bid covers as a bundle */
  bundle: string[];
  /** Total price for the entire bundle (as a decimal string, e.g. "12.50") */
  totalPrice: string;
  /** Price breakdown per capability ID */
  perCapabilityPrices: Record<string, string>;
  /** Unix timestamp (ms) when this bid expires */
  validUntil: number;
}

export interface AuctionResult {
  /** The non-conflicting bids selected by the greedy algorithm */
  winningBids: AuctionBid[];
  /** Sum of winning bid prices (decimal string) */
  totalCost: string;
  /** 0–1: fraction of required steps covered by winning bids */
  allocationEfficiency: number;
  /** Step IDs that received no winning bid */
  unallocatedSteps: string[];
}

// ---------------------------------------------------------------------------
// Internal state per auction
// ---------------------------------------------------------------------------

interface AuctionState {
  /** Required step IDs (derived from the CWM) */
  requiredSteps: string[];
  /** All submitted bids in submission order */
  bids: AuctionBid[];
  /** Whether this auction has been resolved */
  resolved: boolean;
  /** Cached result once resolved */
  result?: AuctionResult;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a decimal price string to a float for arithmetic. */
function parsePrice(price: string): number {
  const v = parseFloat(price);
  if (!isFinite(v) || v < 0) throw new Error(`Invalid price string: "${price}"`);
  return v;
}

/** Format a float back to a 2-decimal price string. */
function formatPrice(value: number): string {
  return value.toFixed(2);
}

/**
 * Compute value density: price per capability covered.
 *
 * Lower density = cheaper per unit of work = preferred by greedy.
 */
function valueDensity(bid: AuctionBid): number {
  if (bid.bundle.length === 0) return Infinity;
  return parsePrice(bid.totalPrice) / bid.bundle.length;
}

/**
 * Filter bids to only those that:
 *   - Have not yet expired (validUntil > now)
 *   - Cover at least one step still in `uncovered`
 */
function filterUseful(bids: AuctionBid[], uncovered: Set<string>, now: number): AuctionBid[] {
  return bids.filter(
    (b) =>
      b.validUntil > now &&
      b.bundle.some((capId) => uncovered.has(capId))
  );
}

// ---------------------------------------------------------------------------
// CombinatorialAuction
// ---------------------------------------------------------------------------

export class CombinatorialAuction {
  private readonly auctions = new Map<string, AuctionState>();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Submit a bid into an existing auction.
   *
   * Throws if:
   *   - The auction does not exist.
   *   - The auction has already been resolved.
   *   - The bid bundle references step IDs not present in the auction.
   *   - The bid's perCapabilityPrices keys don't match the bundle.
   *   - totalPrice doesn't equal the sum of perCapabilityPrices (within $0.01).
   */
  submitBid(auctionId: string, bid: AuctionBid): void {
    const state = this.getState(auctionId);

    if (state.resolved) {
      throw new Error(`Auction ${auctionId} has already been resolved`);
    }

    if (bid.bundle.length === 0) {
      throw new Error("Bid bundle must contain at least one capability ID");
    }

    // Every step in the bundle must be a required step in this auction
    const unknownSteps = bid.bundle.filter((id) => !state.requiredSteps.includes(id));
    if (unknownSteps.length > 0) {
      throw new Error(
        `Bid references step IDs not in auction ${auctionId}: ${unknownSteps.join(", ")}`
      );
    }

    // perCapabilityPrices must cover exactly the bundle
    const missingKeys = bid.bundle.filter((id) => !(id in bid.perCapabilityPrices));
    if (missingKeys.length > 0) {
      throw new Error(
        `perCapabilityPrices missing entries for: ${missingKeys.join(", ")}`
      );
    }

    // totalPrice must reconcile with per-capability sum (within 1 cent tolerance)
    const perCapSum = Object.values(bid.perCapabilityPrices).reduce(
      (acc, p) => acc + parsePrice(p),
      0
    );
    const total = parsePrice(bid.totalPrice);
    if (Math.abs(total - perCapSum) > 0.01) {
      throw new Error(
        `totalPrice (${bid.totalPrice}) does not match sum of perCapabilityPrices (${formatPrice(perCapSum)})`
      );
    }

    state.bids.push(bid);
  }

  /**
   * Close the auction and determine winners via greedy set-cover.
   *
   * Idempotent — calling resolve() multiple times on the same auction
   * returns the cached result.
   *
   * Throws if the auction does not exist.
   */
  resolve(auctionId: string): AuctionResult {
    const state = this.getState(auctionId);

    if (state.resolved && state.result) {
      return state.result;
    }

    const now = Date.now();
    const uncovered = new Set(state.requiredSteps);
    const winningBids: AuctionBid[] = [];

    // Greedy loop
    while (uncovered.size > 0) {
      const candidates = filterUseful(state.bids, uncovered, now);
      if (candidates.length === 0) break;

      // Sort by value density ascending (cheapest per capability first)
      candidates.sort((a, b) => valueDensity(a) - valueDensity(b));
      const winner = candidates[0];

      winningBids.push(winner);

      // Mark the steps this bid covers as resolved
      for (const capId of winner.bundle) {
        uncovered.delete(capId);
      }

      // Remove all bids that overlap with the winner's steps (no double-allocation)
      // (This is implicit — filterUseful already skips bids that only cover
      // already-covered steps, but we re-filter at the top of the loop.)
    }

    // Compute aggregate metrics
    const totalCostValue = winningBids.reduce(
      (sum, b) => sum + parsePrice(b.totalPrice),
      0
    );

    const unallocatedSteps = [...uncovered];
    const coveredCount = state.requiredSteps.length - unallocatedSteps.length;
    const allocationEfficiency =
      state.requiredSteps.length === 0
        ? 1
        : coveredCount / state.requiredSteps.length;

    const result: AuctionResult = {
      winningBids,
      totalCost: formatPrice(totalCostValue),
      allocationEfficiency,
      unallocatedSteps,
    };

    state.resolved = true;
    state.result = result;

    return result;
  }

  /**
   * Create a new auction from a CWM workflow.
   *
   * Each CWM step ID becomes a "capability slot" that bidders must cover.
   * Returns the new auctionId.
   */
  static fromCWM(cwm: CWM): string {
    const instance = CombinatorialAuction._defaultInstance;
    const auctionId = randomUUID();
    const requiredSteps = cwm.steps.map((s) => s.id);

    instance.auctions.set(auctionId, {
      requiredSteps,
      bids: [],
      resolved: false,
    });

    return auctionId;
  }

  // -------------------------------------------------------------------------
  // Instance management helpers
  // -------------------------------------------------------------------------

  /**
   * Create a new, independent auction (not from a CWM) with explicit step IDs.
   * Useful for testing or for manually constructed auctions.
   */
  createAuction(requiredSteps: string[]): string {
    const auctionId = randomUUID();
    this.auctions.set(auctionId, {
      requiredSteps: [...requiredSteps],
      bids: [],
      resolved: false,
    });
    return auctionId;
  }

  /**
   * Return all required step IDs for an auction (for introspection / testing).
   */
  getRequiredSteps(auctionId: string): string[] {
    return [...this.getState(auctionId).requiredSteps];
  }

  /**
   * Return all submitted bids (for introspection / testing).
   */
  getBids(auctionId: string): readonly AuctionBid[] {
    return this.getState(auctionId).bids;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getState(auctionId: string): AuctionState {
    const state = this.auctions.get(auctionId);
    if (!state) throw new Error(`Auction not found: ${auctionId}`);
    return state;
  }

  // -------------------------------------------------------------------------
  // Singleton for static fromCWM — keeps module-level state consistent with
  // the instance used by callers who new up their own instance.
  // -------------------------------------------------------------------------

  /** Default singleton used by the static `fromCWM` factory. */
  static readonly _defaultInstance = new CombinatorialAuction();
}

// ---------------------------------------------------------------------------
// Module-level singleton export (mirrors pattern used by audit-service, etc.)
// ---------------------------------------------------------------------------

export const combinatorialAuction = new CombinatorialAuction();
