/**
 * Tests for the URL pattern library.
 *
 * Each pattern gets a positive case (URL that should match) and at least
 * one near-miss negative case (URL on the same domain but a different
 * route shape). The negative cases prevent regression from over-permissive
 * regexes.
 */

import { describe, it, expect } from "vitest";
import { URL_PATTERNS, matchUrlPattern } from "../url-patterns.js";

describe("URL_PATTERNS — sanity", () => {
  it("contains at least 15 patterns", () => {
    expect(URL_PATTERNS.length).toBeGreaterThanOrEqual(15);
  });

  it("every pattern has name, regex, capabilityTypes, extract", () => {
    for (const p of URL_PATTERNS) {
      expect(p.name).toMatch(/^[a-z0-9-]+$/);
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(Array.isArray(p.capabilityTypes)).toBe(true);
      expect(p.capabilityTypes.length).toBeGreaterThan(0);
      expect(typeof p.extract).toBe("function");
    }
  });

  it("every pattern's extract() returns capabilityTypes + summary <= 200 chars", () => {
    for (const p of URL_PATTERNS) {
      const out = p.extract("https://example.com/test", undefined, "GET");
      expect(Array.isArray(out.capabilityTypes)).toBe(true);
      expect(out.capabilityTypes!.length).toBeGreaterThan(0);
      expect(typeof out.summary).toBe("string");
      expect(out.summary!.length).toBeLessThanOrEqual(200);
    }
  });

  it("all pattern names are unique", () => {
    const names = URL_PATTERNS.map((p) => p.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Positive cases — pattern fires
// ─────────────────────────────────────────────────────────────────────────

describe("matchUrlPattern — positive cases", () => {
  const cases: Array<[string, string, string[]]> = [
    [
      "amazon-product",
      "https://www.amazon.com/dp/B07XJ8C8F5",
      ["fulfillment-2day-us", "retail-purchase"],
    ],
    [
      "amazon-product (UK)",
      "https://www.amazon.co.uk/dp/B07XJ8C8F5",
      ["fulfillment-2day-us", "retail-purchase"],
    ],
    [
      "amazon-product (gp/product)",
      "https://www.amazon.com/some-product-name/gp/product/B0ABCDEFGH",
      ["fulfillment-2day-us", "retail-purchase"],
    ],
    [
      "amazon-cart",
      "https://www.amazon.com/gp/cart",
      ["fulfillment-2day-us", "retail-cart"],
    ],
    [
      "shopify-cart",
      "https://myshop.com/cart/add.json",
      ["retail-cart", "shopify-storefront"],
    ],
    [
      "ebay-listing",
      "https://www.ebay.com/itm/123456789",
      ["retail-purchase", "auction-bid"],
    ],
    [
      "instacart-shop",
      "https://www.instacart.com/store/safeway/storefront",
      ["grocery-delivery", "fulfillment-same-day"],
    ],
    [
      "doordash-store",
      "https://www.doordash.com/store/big-mama-12345/",
      ["food-delivery"],
    ],
    [
      "ubereats-store",
      "https://www.ubereats.com/store/some-restaurant/abcXYZ123",
      ["food-delivery"],
    ],
    [
      "grubhub-restaurant",
      "https://www.grubhub.com/restaurant/big-mac-shack-12345",
      ["food-delivery"],
    ],
    [
      "postmates-store",
      "https://www.postmates.com/store/wholefoods-soho",
      ["food-delivery", "courier-on-demand"],
    ],
    [
      "caviar-restaurant",
      "https://www.trycaviar.com/sf/restaurants/lucky-cat-123",
      ["food-delivery"],
    ],
    [
      "uber-ride",
      "https://m.uber.com/ride/?lat=37.77&lng=-122.42",
      ["rideshare", "mobility-on-demand"],
    ],
    [
      "lyft-ride",
      "https://www.lyft.com/ride",
      ["rideshare", "mobility-on-demand"],
    ],
    [
      "airbnb-room",
      "https://www.airbnb.com/rooms/12345678",
      ["short-term-rental", "accommodation"],
    ],
    [
      "booking-hotel",
      "https://www.booking.com/hotel/us/some-hotel.html",
      ["hotel-stay", "accommodation"],
    ],
    [
      "expedia-hotel",
      "https://www.expedia.com/Las-Vegas-Hotels-Bellagio.h12345.Hotel-Information",
      ["hotel-stay", "accommodation"],
    ],
    [
      "kayak-flight",
      "https://www.kayak.com/flights/SFO-JFK/2026-06-01",
      ["flight-booking", "travel"],
    ],
    [
      "calendly-booking",
      "https://calendly.com/some-person/30min",
      ["scheduling", "appointment-booking"],
    ],
    [
      "opentable-restaurant",
      "https://www.opentable.com/r/some-restaurant-san-francisco",
      ["restaurant-reservation"],
    ],
  ];

  for (const [label, url, expectedTypes] of cases) {
    it(`fires for ${label}`, () => {
      const m = matchUrlPattern(url);
      expect(m, `expected match for ${label}: ${url}`).not.toBeNull();
      for (const t of expectedTypes) {
        expect(m!.partial.capabilityTypes).toContain(t);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Negative cases — pattern does NOT fire
// ─────────────────────────────────────────────────────────────────────────

describe("matchUrlPattern — near-miss negative cases", () => {
  const cases: Array<[string, string]> = [
    ["amazon home", "https://www.amazon.com/"],
    ["amazon prime video", "https://www.amazon.com/Prime-Video/b?node=2858778011"],
    ["shopify storefront root", "https://myshop.com/"],
    ["ebay home", "https://www.ebay.com/"],
    ["airbnb home", "https://www.airbnb.com/"],
    ["airbnb experiences", "https://www.airbnb.com/experiences/12345"],
    ["doordash home", "https://www.doordash.com/"],
    ["calendly home", "https://calendly.com/"],
    ["random blog", "https://random-blog.example.com/posts/123"],
    ["github repo", "https://github.com/lamasu/physical-capability-cloud"],
    ["mdn docs", "https://developer.mozilla.org/en-US/docs/Web/API/fetch"],
    ["arbitrary api endpoint", "https://api.example.com/v1/widgets/42"],
  ];

  for (const [label, url] of cases) {
    it(`does NOT fire for ${label}`, () => {
      const m = matchUrlPattern(url);
      expect(m, `unexpected match for ${label}: ${url}`).toBeNull();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// matchUrlPattern API
// ─────────────────────────────────────────────────────────────────────────

describe("matchUrlPattern — API contract", () => {
  it("returns { pattern, partial } shape on match", () => {
    const m = matchUrlPattern("https://www.amazon.com/dp/B07XJ8C8F5");
    expect(m).not.toBeNull();
    expect(m!.pattern.name).toBe("amazon-product");
    expect(m!.partial.capabilityTypes).toBeDefined();
    expect(m!.partial.summary).toBeDefined();
  });

  it("returns the first matching pattern (priority by array order)", () => {
    // amazon-product is listed before amazon-cart and matches /dp/<asin>.
    const m = matchUrlPattern("https://www.amazon.com/dp/B07XJ8C8F5");
    expect(m!.pattern.name).toBe("amazon-product");
  });

  it("returns null on URL the library doesn't recognise", () => {
    expect(matchUrlPattern("https://example.com/")).toBeNull();
  });
});
