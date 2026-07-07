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

// ---------------------------------------------------------------------------
// Free-text inference of an ad-hoc listing (no explicit capabilityType)
// ---------------------------------------------------------------------------

export interface InferResult {
  /** The single confidently-matched listing, or null when inference declined. */
  listing: RoutedListing | null;
  /** Why inference matched / declined — surfaced in the response for transparency. */
  reason: string;
  /** Match score of the winner (0 when none). Diagnostic only. */
  score?: number;
}

/** Words too generic to be a distinctive signal for a capability type/name. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "with", "in", "on", "at",
  "my", "your", "our", "i", "we", "want", "need", "please", "get", "me", "some",
  "service", "services", "custom", "job", "order", "make", "build", "do",
]);

/** Tokenize a type slug or name into distinctive lowercase word tokens. */
function distinctiveTokens(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Infer a single registered listing from a buyer's free-text description when
 * they did NOT name a capabilityType. Deterministic, conservative, and
 * kill-switchable (PCC_NL_INFER_ADHOC_DISABLED=1) — it exists to reach ad-hoc
 * listings ("I want a wood-fired pizza" → the pizzeria's listing) on the
 * no-LLM path, WITHOUT hijacking genuine composite requests.
 *
 * Matching keys off each capability's OWN `type` slug + `name` tokens (never a
 * fixed list), so ad-hoc types resolve exactly like built-in ones. It declines
 * (returns null) unless there is ONE clearly-strongest match:
 *   - the winner must clear a minimum distinctive-token score, AND
 *   - it must be strictly stronger than the runner-up (no ambiguous ties).
 * On any doubt it declines and the caller falls through to composite
 * decomposition — inference never overrides an explicit capabilityType.
 */
export function inferListingFromText(description: string): InferResult {
  if (process.env.PCC_NL_INFER_ADHOC_DISABLED === "1") {
    return { listing: null, reason: "inference disabled", score: 0 };
  }

  const text = (description ?? "").toLowerCase();
  if (text.trim().length === 0) {
    return { listing: null, reason: "empty description", score: 0 };
  }

  let rows: CapabilityRowLike[];
  try {
    rows = getRepos().capabilities.findAll() as CapabilityRowLike[];
  } catch {
    return { listing: null, reason: "capability store unavailable", score: 0 };
  }
  if (!rows || rows.length === 0) {
    return { listing: null, reason: "no registered capabilities", score: 0 };
  }

  // Score each capability by how many of its distinctive type/name tokens
  // appear in the description. The exact type slug appearing verbatim is the
  // strongest single signal.
  type Scored = { row: CapabilityRowLike; score: number };
  const scored: Scored[] = [];
  for (const row of rows) {
    const typeSlug = (row.type ?? "").toLowerCase();
    const tokens = new Set([...distinctiveTokens(row.type), ...distinctiveTokens(row.name)]);
    let score = 0;
    // Verbatim type slug (e.g. "wood-fired-pizza" or its spaced form) is decisive.
    if (typeSlug.length >= 3) {
      if (text.includes(typeSlug)) score += 3;
      else if (text.includes(typeSlug.replace(/[.-]/g, " "))) score += 3;
    }
    for (const tok of tokens) {
      if (text.includes(tok)) score += 1;
    }
    if (score > 0) scored.push({ row, score });
  }

  if (scored.length === 0) {
    return { listing: null, reason: "no capability matched the description", score: 0 };
  }

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  const runnerUp = scored[1];

  // Minimum confidence: at least 2 points (a verbatim slug, or two distinctive
  // token hits). One incidental token hit is not enough to route an order.
  const MIN_SCORE = 2;
  if (winner.score < MIN_SCORE) {
    return {
      listing: null,
      reason: `best match too weak (score ${winner.score} < ${MIN_SCORE}) — routing to composite decomposition`,
      score: winner.score,
    };
  }

  // Unambiguous: winner must be strictly stronger than the runner-up of a
  // DIFFERENT type. Two listings of the SAME type tying is fine (matchListings
  // will rank them); a tie across different types is genuine ambiguity.
  if (runnerUp && runnerUp.score === winner.score && runnerUp.row.type !== winner.row.type) {
    return {
      listing: null,
      reason:
        `ambiguous: "${winner.row.type}" and "${runnerUp.row.type}" tied (score ${winner.score}) — ` +
        `routing to composite decomposition`,
      score: winner.score,
    };
  }

  return {
    listing: toRoutedListing(winner.row),
    reason: `inferred capability type "${winner.row.type}" from description (score ${winner.score})`,
    score: winner.score,
  };
}
