/**
 * Buyer-request → capability-listing matcher.
 *
 * The P0 "payout wall": a buyer asks for a capability *type* — rideshare-driver,
 * wood-fired-pizza, anything an operator registered via POST /api/capabilities —
 * and we must route that request to the operator's actual listing (the
 * capability row on a kernel) so an escrow can be funded against it.
 *
 * Before this matcher, the only buyer-request entry point (POST /api/requests)
 * decomposed natural language through a handful of hardcoded composite templates
 * and never produced a node whose `capabilityType` matched an ad-hoc listing.
 * Ad-hoc operators were *discoverable* (they show up in /api/capabilities/by-type)
 * but *unreachable*: no request ever resolved to their listing, so no escrow was
 * funded and the operator was never paid.
 *
 * This matcher keys off the capability's OWN type string and pricing model — a
 * DB lookup by `type`, priced from the row's `pricing.baseCost` — NOT a fixed
 * allow-list of "known" capability types. Any registered capability type matches,
 * open-taxonomy by construction.
 */

import { getRepos } from "../db.js";

/** A capability listing a buyer request can be routed to (and funded against). */
export interface RoutedListing {
  /** The capability row id — the specific listing on a kernel. */
  capabilityId: string;
  /** The kernel (operator site) that offers this listing. */
  kernelId: string;
  /** The capability's own type string (the matching key). */
  capabilityType: string;
  /** Human-readable listing name. */
  name: string;
  /** Base price as a dollar-string, from the listing's pricing model. */
  basePrice: string;
  /** Pricing currency from the listing's pricing model (e.g. "USDC"). */
  currency: string;
  /** Jobs currently queued on this listing — used to prefer available operators. */
  queueDepth: number;
}

export interface MatchResult {
  /** Listings that can fulfil the request, best-first. Empty when nothing matched. */
  matches: RoutedListing[];
  /** Populated when `matches` is empty — why nothing matched (caller emits 4xx). */
  reason?: string;
}

export interface MatchOptions {
  /** Pin to one listing (the buyer already chose a specific operator/capability). */
  capabilityId?: string;
  /** Constrain matches to a single kernel. */
  kernelId?: string;
}

/** Minimal shape of a capability row this matcher reads. */
interface CapabilityRowLike {
  id: string;
  kernelId: string;
  type: string;
  name: string;
  pricing: { currency?: string; baseCost?: string | number } | null;
  queueDepth?: number;
}

/** Project a capability row onto a routed listing, pricing from its own model. */
function toRoutedListing(row: CapabilityRowLike): RoutedListing {
  const baseCostNum = Number(row.pricing?.baseCost);
  const basePrice = Number.isFinite(baseCostNum) ? baseCostNum.toFixed(2) : "0.00";
  return {
    capabilityId: row.id,
    kernelId: row.kernelId,
    capabilityType: row.type,
    name: row.name,
    basePrice,
    currency: row.pricing?.currency ?? "USDC",
    queueDepth: row.queueDepth ?? 0,
  };
}

/**
 * Resolve the registered capability listings that can fulfil a request for
 * `capabilityType`. Returns best-first matches (most-available, then cheapest,
 * then stable by id), or an empty list with a reason when nothing is registered.
 *
 * Matching is purely data-driven: it looks up rows whose `type` equals the
 * requested type and prices them from each row's pricing model. There is no
 * allow-list, so ad-hoc types match exactly the same way built-in ones do.
 */
export function matchListings(capabilityType: string, opts: MatchOptions = {}): MatchResult {
  const type = (capabilityType ?? "").trim();
  if (!type) return { matches: [], reason: "capabilityType is required" };

  let rows: CapabilityRowLike[];
  try {
    const repos = getRepos();
    if (opts.capabilityId) {
      const row = repos.capabilities.findById(opts.capabilityId) as CapabilityRowLike | undefined;
      if (!row) {
        return { matches: [], reason: `No capability ${opts.capabilityId} found` };
      }
      // A pinned capabilityId must actually be of the requested type, otherwise
      // we'd price/route against a different capability than the buyer asked for.
      if (row.type !== type) {
        return {
          matches: [],
          reason: `Capability ${opts.capabilityId} is type "${row.type}", not "${type}"`,
        };
      }
      rows = [row];
    } else {
      rows = repos.capabilities.findByType(type) as CapabilityRowLike[];
    }
  } catch {
    // Repos not initialised (isolated test contexts) — surface a clean reason
    // so the caller emits a 4xx instead of a 500.
    return { matches: [], reason: "capability store unavailable" };
  }

  if (opts.kernelId) {
    rows = rows.filter((r) => r.kernelId === opts.kernelId);
  }

  if (!rows || rows.length === 0) {
    return {
      matches: [],
      reason: `No registered listing offers capability type "${type}"`,
    };
  }

  const matches = rows.map(toRoutedListing).sort((a, b) => {
    // Prefer the most-available operator, then the cheapest, then a stable id
    // tie-break so routing is deterministic across runs.
    if (a.queueDepth !== b.queueDepth) return a.queueDepth - b.queueDepth;
    const pa = parseFloat(a.basePrice);
    const pb = parseFloat(b.basePrice);
    if (pa !== pb) return pa - pb;
    return a.capabilityId < b.capabilityId ? -1 : a.capabilityId > b.capabilityId ? 1 : 0;
  });

  return { matches };
}
