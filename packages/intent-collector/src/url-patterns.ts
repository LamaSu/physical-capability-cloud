/**
 * URL pattern library for intent-detection.
 *
 * Each pattern is a heuristic — when a wrapped fetch sees a URL that matches
 * one of these regexes (and is a state-changing verb where applicable), the
 * collector forms a partial DemandEnvelope from the match groups and the
 * surrounding context (verb, body, headers). The envelope is then merged
 * with collector-level defaults and submitted.
 *
 * Conservative goals:
 *   - High precision over high recall. A pattern that fires on every page
 *     load creates noise; a pattern that fires once per real purchase is gold.
 *   - capabilityTypes are PCC-style strings (kebab-case nouns) so they
 *     aggregate cleanly across sources in the demand-intel store.
 *   - Patterns capture the SHAPE of the intent (a fulfillment, a ride, a
 *     reservation) not the SUBJECT — subject hashing is the caller's job
 *     when it matters.
 *
 * Patterns deliberately do NOT extract identifiers — that's left to the
 * caller via captureIntent() with explicit field passing. The matcher is
 * scoped to detecting "this URL is an intent of type X."
 */

import type { DemandEnvelope } from "@pcc/spec";

/**
 * A pattern that recognises an intent-shaped outbound URL.
 *
 * `extract` returns a partial DemandEnvelope with the fields the pattern
 * can confidently infer from URL + body. The client fills the rest
 * (compositionSignature, createdAt, id, source, hashing).
 */
export interface UrlPattern {
  /** Stable short name (e.g. "amazon-product", "doordash-store") */
  name: string;
  /** Regex matched against the full request URL */
  regex: RegExp;
  /** Capability types this pattern represents (PCC-style kebab-case) */
  capabilityTypes: string[];
  /** Extract envelope-shaped fields from the URL/body. */
  extract: (
    url: string,
    body?: unknown,
    method?: string,
  ) => Partial<DemandEnvelope>;
}

/**
 * Match result from running all patterns against a URL.
 */
export interface UrlPatternMatch {
  pattern: UrlPattern;
  partial: Partial<DemandEnvelope>;
}

/**
 * Helper — build an extract function that always emits a fixed summary
 * + capabilityTypes. Most patterns don't need anything more.
 */
function fixedExtract(
  capabilityTypes: string[],
  summaryTemplate: string,
): UrlPattern["extract"] {
  return () => ({
    capabilityTypes,
    summary: summaryTemplate.slice(0, 200),
  });
}

/**
 * Initial pattern library — 18 entries covering the major commerce, food,
 * mobility, travel, and scheduling surfaces an agent is most likely to
 * touch in 2026.
 *
 * Note: regexes are intentionally loose on host (e.g. `amazon\\.[a-z.]+`)
 * so they fire across regional TLDs (amazon.com, amazon.co.uk, etc.).
 */
export const URL_PATTERNS: UrlPattern[] = [
  // ─── Commerce / fulfilment ────────────────────────────────────────────
  {
    name: "amazon-product",
    regex: /^https?:\/\/(?:www\.)?amazon\.[a-z.]+\/(?:[^/]+\/)?(?:dp|gp\/product)\/[A-Z0-9]{10}/i,
    capabilityTypes: ["fulfillment-2day-us", "retail-purchase"],
    extract: fixedExtract(
      ["fulfillment-2day-us", "retail-purchase"],
      "Amazon product page / order",
    ),
  },
  {
    name: "amazon-cart",
    regex: /^https?:\/\/(?:www\.)?amazon\.[a-z.]+\/.*\/cart/i,
    capabilityTypes: ["fulfillment-2day-us", "retail-cart"],
    extract: fixedExtract(
      ["fulfillment-2day-us", "retail-cart"],
      "Amazon cart action",
    ),
  },
  {
    name: "shopify-cart",
    regex: /^https?:\/\/[^/]+\/cart\/(add|update|change)\.json/i,
    capabilityTypes: ["retail-cart", "shopify-storefront"],
    extract: fixedExtract(
      ["retail-cart", "shopify-storefront"],
      "Shopify cart mutation",
    ),
  },
  {
    name: "ebay-listing",
    regex: /^https?:\/\/(?:www\.)?ebay\.[a-z.]+\/itm\/\d+/i,
    capabilityTypes: ["retail-purchase", "auction-bid"],
    extract: fixedExtract(
      ["retail-purchase", "auction-bid"],
      "eBay listing view / purchase",
    ),
  },
  {
    name: "instacart-shop",
    regex: /^https?:\/\/(?:www\.)?instacart\.[a-z.]+\/(?:store|shop)\//i,
    capabilityTypes: ["grocery-delivery", "fulfillment-same-day"],
    extract: fixedExtract(
      ["grocery-delivery", "fulfillment-same-day"],
      "Instacart store / grocery cart",
    ),
  },

  // ─── Food delivery ────────────────────────────────────────────────────
  {
    name: "doordash-store",
    regex: /^https?:\/\/(?:www\.)?doordash\.[a-z.]+\/(?:store|business)\//i,
    capabilityTypes: ["food-delivery"],
    extract: fixedExtract(["food-delivery"], "DoorDash restaurant page / order"),
  },
  {
    name: "ubereats-store",
    regex: /^https?:\/\/(?:www\.)?ubereats\.[a-z.]+\/(?:store|category)\//i,
    capabilityTypes: ["food-delivery"],
    extract: fixedExtract(["food-delivery"], "Uber Eats restaurant page / order"),
  },
  {
    name: "grubhub-restaurant",
    regex: /^https?:\/\/(?:www\.)?grubhub\.[a-z.]+\/restaurant\//i,
    capabilityTypes: ["food-delivery"],
    extract: fixedExtract(["food-delivery"], "Grubhub restaurant page / order"),
  },
  {
    name: "postmates-store",
    regex: /^https?:\/\/(?:www\.)?postmates\.[a-z.]+\/(?:store|merchant)\//i,
    capabilityTypes: ["food-delivery", "courier-on-demand"],
    extract: fixedExtract(
      ["food-delivery", "courier-on-demand"],
      "Postmates store / courier",
    ),
  },
  {
    name: "caviar-restaurant",
    regex: /^https?:\/\/(?:www\.)?(?:tryc|trycaviar|caviar)\.com\/(?:[a-z-]+\/)?restaurants?\//i,
    capabilityTypes: ["food-delivery"],
    extract: fixedExtract(
      ["food-delivery"],
      "Caviar restaurant page / order",
    ),
  },

  // ─── Mobility / rideshare ─────────────────────────────────────────────
  {
    name: "uber-ride",
    regex: /^https?:\/\/(?:m\.|www\.)?uber\.[a-z.]+\/(?:ride|riders|go|en)\b/i,
    capabilityTypes: ["rideshare", "mobility-on-demand"],
    extract: fixedExtract(
      ["rideshare", "mobility-on-demand"],
      "Uber ride request",
    ),
  },
  {
    name: "lyft-ride",
    regex: /^https?:\/\/(?:www\.)?lyft\.[a-z.]+\/(?:ride|rider|driver|en)\b/i,
    capabilityTypes: ["rideshare", "mobility-on-demand"],
    extract: fixedExtract(
      ["rideshare", "mobility-on-demand"],
      "Lyft ride request",
    ),
  },

  // ─── Travel / hospitality ─────────────────────────────────────────────
  {
    name: "airbnb-room",
    regex: /^https?:\/\/(?:www\.)?airbnb\.[a-z.]+\/rooms\/\d+/i,
    capabilityTypes: ["short-term-rental", "accommodation"],
    extract: fixedExtract(
      ["short-term-rental", "accommodation"],
      "Airbnb listing view / reservation",
    ),
  },
  {
    name: "booking-hotel",
    regex: /^https?:\/\/(?:www\.)?booking\.[a-z.]+\/hotel\//i,
    capabilityTypes: ["hotel-stay", "accommodation"],
    extract: fixedExtract(
      ["hotel-stay", "accommodation"],
      "Booking.com hotel page / reservation",
    ),
  },
  {
    name: "expedia-hotel",
    regex: /^https?:\/\/(?:www\.)?expedia\.[a-z.]+\/(?:[a-z]+-)?(?:Hotel|Hotels)-/i,
    capabilityTypes: ["hotel-stay", "accommodation"],
    extract: fixedExtract(
      ["hotel-stay", "accommodation"],
      "Expedia hotel search / reservation",
    ),
  },
  {
    name: "kayak-flight",
    regex: /^https?:\/\/(?:www\.)?kayak\.[a-z.]+\/flights\//i,
    capabilityTypes: ["flight-booking", "travel"],
    extract: fixedExtract(
      ["flight-booking", "travel"],
      "Kayak flight search / booking",
    ),
  },

  // ─── Scheduling / professional services ───────────────────────────────
  {
    name: "calendly-booking",
    regex: /^https?:\/\/(?:www\.)?calendly\.com\/[^/]+\/[^/?]+/i,
    capabilityTypes: ["scheduling", "appointment-booking"],
    extract: fixedExtract(
      ["scheduling", "appointment-booking"],
      "Calendly appointment booking",
    ),
  },
  {
    name: "opentable-restaurant",
    regex: /^https?:\/\/(?:www\.)?opentable\.[a-z.]+\/r(?:estaurant)?\//i,
    capabilityTypes: ["restaurant-reservation"],
    extract: fixedExtract(
      ["restaurant-reservation"],
      "OpenTable restaurant reservation",
    ),
  },
];

/**
 * Run all patterns against a URL. Returns the first match (highest priority
 * is first in the array). Returns `null` if no pattern fires.
 *
 * Most agent fetches will NOT match; this keeps overhead at one regex
 * per pattern per call. The list is short (18 patterns), so this is
 * trivial.
 */
export function matchUrlPattern(
  url: string,
  body?: unknown,
  method?: string,
): UrlPatternMatch | null {
  for (const pattern of URL_PATTERNS) {
    if (pattern.regex.test(url)) {
      return { pattern, partial: pattern.extract(url, body, method) };
    }
  }
  return null;
}
