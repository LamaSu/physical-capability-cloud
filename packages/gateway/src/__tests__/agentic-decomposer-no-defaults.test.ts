/**
 * Regression tests for board N23 (legacy decomposer capability matcher).
 *
 * `toMatched` used to DEFAULT three values whenever a capability didn't
 * declare them: price fell back to 0 (via `capPrice`'s own "0" fallback),
 * currency fell back to `"USDC"`, and `assuranceTiers` fell back to `[0, 1]`.
 * That meant the planner could propose — and show a buyer — a $0 price, a
 * currency, and evidence tiers that no provider ever declared.
 *
 * `matchableTerms` (exported from agentic-decomposer.ts) is the fail-closed
 * gate: `createMatcher` now skips any capability it rejects, so an
 * undeclared/invalid capability is never matched, no matter how well its
 * text scores against the query.
 *
 * See agentic-decomposer-digest.test.ts next to this file for the sibling
 * suite covering the matched-node digest contract on already-declared caps.
 */

import { describe, it, expect } from "vitest";
import {
  createMatcher,
  matchableTerms,
  scoreCapability,
  type CapabilityLite,
} from "../services/agentic-decomposer.js";
import { matchedCapabilityDigest } from "../services/matched-capability-digest.js";

const QUERY = "wood fired pizza margherita";

// ---------------------------------------------------------------------------
// (e) Unit tests of matchableTerms — every reason, plus the success shape.
// ---------------------------------------------------------------------------

describe("matchableTerms", () => {
  const BASE: CapabilityLite = {
    id: "cap-1",
    type: "wood-fired-pizza",
    name: "Mario's Pizza",
    kernelId: "kernel-marios",
    pricing: { currency: "USDC", baseCost: "12" },
    assuranceTiers: [0, 1],
  };

  it("ok:true for a fully declared capability; price is capPrice(cap)", () => {
    expect(matchableTerms(BASE)).toEqual({
      ok: true,
      price: 12,
      currency: "USDC",
      assuranceTiers: [0, 1],
    });
  });

  it("returns tiers as a sorted, deduplicated set", () => {
    const r = matchableTerms({ ...BASE, assuranceTiers: [1, 0, 1, 2] });
    expect(r).toEqual({ ok: true, price: 12, currency: "USDC", assuranceTiers: [0, 1, 2] });
  });

  it("reason: no-declared-tiers — assuranceTiers is undefined", () => {
    const cap: CapabilityLite = { ...BASE };
    delete (cap as { assuranceTiers?: number[] }).assuranceTiers;
    expect(matchableTerms(cap)).toEqual({ ok: false, reason: "no-declared-tiers" });
  });

  it("reason: no-declared-tiers — assuranceTiers is null", () => {
    expect(matchableTerms({ ...BASE, assuranceTiers: null as unknown as number[] })).toEqual({
      ok: false,
      reason: "no-declared-tiers",
    });
  });

  it("reason: invalid-tiers — assuranceTiers is an empty array", () => {
    expect(matchableTerms({ ...BASE, assuranceTiers: [] })).toEqual({
      ok: false,
      reason: "invalid-tiers",
    });
  });

  it("reason: invalid-tiers — assuranceTiers contains an out-of-range number", () => {
    expect(matchableTerms({ ...BASE, assuranceTiers: [4] })).toEqual({
      ok: false,
      reason: "invalid-tiers",
    });
  });

  it("reason: invalid-tiers — assuranceTiers contains a non-number", () => {
    expect(
      matchableTerms({ ...BASE, assuranceTiers: ["1"] as unknown as number[] }),
    ).toEqual({ ok: false, reason: "invalid-tiers" });
  });

  it("reason: no-declared-pricing — pricing is undefined", () => {
    const cap: CapabilityLite = { ...BASE };
    delete (cap as { pricing?: unknown }).pricing;
    expect(matchableTerms(cap)).toEqual({ ok: false, reason: "no-declared-pricing" });
  });

  it("reason: no-declared-pricing — pricing is null", () => {
    expect(
      matchableTerms({ ...BASE, pricing: null as unknown as CapabilityLite["pricing"] }),
    ).toEqual({ ok: false, reason: "no-declared-pricing" });
  });

  it("reason: invalid-pricing — pricing has no currency", () => {
    expect(matchableTerms({ ...BASE, pricing: { baseCost: "12" } })).toEqual({
      ok: false,
      reason: "invalid-pricing",
    });
  });

  it("reason: invalid-pricing — currency is an empty string", () => {
    expect(
      matchableTerms({ ...BASE, pricing: { currency: "", baseCost: "12" } }),
    ).toEqual({ ok: false, reason: "invalid-pricing" });
  });

  it("reason: invalid-pricing — headline is non-numeric (\"abc\")", () => {
    expect(
      matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost: "abc" } }),
    ).toEqual({ ok: false, reason: "invalid-pricing" });
  });

  it("reason: invalid-pricing — neither baseCost nor minimum is present", () => {
    expect(matchableTerms({ ...BASE, pricing: { currency: "USDC" } })).toEqual({
      ok: false,
      reason: "invalid-pricing",
    });
  });

  it('reason: zero-price — headline is "0"', () => {
    expect(
      matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost: "0" } }),
    ).toEqual({ ok: false, reason: "zero-price" });
  });

  it('reason: zero-price — headline is "0.00"', () => {
    expect(
      matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost: "0.00" } }),
    ).toEqual({ ok: false, reason: "zero-price" });
  });

  it("uses minimum as the headline when baseCost is absent (still matches)", () => {
    expect(
      matchableTerms({ ...BASE, pricing: { currency: "USDC", minimum: "5" } }),
    ).toEqual({ ok: true, price: 5, currency: "USDC", assuranceTiers: [0, 1] });
  });

  // ---------------------------------------------------------------------
  // Board N23 follow-up (#439): astra SHIP-WITH-NITS findings.
  // ---------------------------------------------------------------------

  it("subcent_declared_prices_do_not_become_zero_or_share_a_commitment", () => {
    // "0.001" and "0.004" used to both digest as "0.00" (matched-capability-
    // digest.ts's v1 preimage uses toFixed(2)) and both estimate to 0 --
    // two different declared prices sharing one commitment. Reject instead
    // of rounding; this is local to the legacy 2-decimal representation.
    expect(
      matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost: "0.001" } }),
    ).toEqual({ ok: false, reason: "invalid-pricing" });
    expect(
      matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost: "0.004" } }),
    ).toEqual({ ok: false, reason: "invalid-pricing" });
    // A price that IS exactly representable at 2 decimal places still matches.
    expect(
      matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost: "0.50" } }),
    ).toEqual({ ok: true, price: 0.5, currency: "USDC", assuranceTiers: [0, 1] });
  });

  it("unsafe_headline_is_not_returned_as_a_different_declared_price", () => {
    // "9007199254740993" used to become 9007199254740992 via parseFloat.
    expect(
      matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost: "9007199254740993" } }),
    ).toEqual({ ok: false, reason: "invalid-pricing" });
    // Thirty nines used to become 1e+30 (and toFixed(2) on that is exponential).
    expect(
      matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost: "9".repeat(30) } }),
    ).toEqual({ ok: false, reason: "invalid-pricing" });
    // The largest safe integer itself is still fine -- only values that
    // actually lose precision are rejected.
    expect(
      matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost: String(Number.MAX_SAFE_INTEGER) } }),
    ).toEqual({
      ok: true,
      price: Number.MAX_SAFE_INTEGER,
      currency: "USDC",
      assuranceTiers: [0, 1],
    });
  });

  it("astra 130 (439-B): two decimal prices past 2^53 that the v1 digest would collapse into one are refused", () => {
    // Both parse to 9007199254740991, and toFixed(2) would write "9007199254740991.00" for both.
    for (const baseCost of ["9007199254740991.01", "9007199254740991.02"]) {
      expect(matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost } })).toEqual({ ok: false, reason: "invalid-pricing" });
    }
  });

  it("astra 130 (the regression): a zero-padded price is its value, not too many digits", () => {
    expect(matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost: "00000000000000001" } })).toEqual({
      ok: true, price: 1, currency: "USDC", assuranceTiers: [0, 1],
    });
    expect(matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost: "00012.50" } })).toEqual({
      ok: true, price: 12.5, currency: "USDC", assuranceTiers: [0, 1],
    });
  });

  it("every ACCEPTED headline serializes, as the v1 digest does (toFixed(2)), to exactly the two-decimal value written", () => {
    const exact = (h: string): string => {
      const [w, d = ""] = h.split(".");
      return `${w.replace(/^0+(?=[0-9])/, "")}.${(d + "00").slice(0, 2)}`;
    };
    const headlines = [
      "12", "0.1", "0.10", "1.5", "00012.50", "00000000000000001", "1234567890123.45", "99999999999999.99",
      String(Number.MAX_SAFE_INTEGER), "9007199254740991.01", "9007199254740993", "9".repeat(21), "1.005", "2.675",
    ];
    let accepted = 0;
    for (const baseCost of headlines) {
      const r = matchableTerms({ ...BASE, pricing: { currency: "USDC", baseCost } });
      if (r.ok) {
        accepted++;
        expect([baseCost, r.price.toFixed(2)]).toEqual([baseCost, exact(baseCost)]);
      }
    }
    expect(accepted).toBeGreaterThan(5);
  });

  it("matcher_rejects_blank_currency", () => {
    expect(
      matchableTerms({ ...BASE, pricing: { currency: " ", baseCost: "12" } }),
    ).toEqual({ ok: false, reason: "invalid-pricing" });
    expect(
      matchableTerms({ ...BASE, pricing: { currency: " USDC ", baseCost: "12" } }),
    ).toEqual({ ok: false, reason: "invalid-pricing" });
  });

  it("matchableTerms_rejects_sparse_tiers", () => {
    const sparse: number[] = [0, , 1];
    expect(matchableTerms({ ...BASE, assuranceTiers: sparse })).toEqual({
      ok: false,
      reason: "invalid-tiers",
    });
  });

  it("not reproduced: non-object pricing shapes (array, string, number, boolean) already fail via the currency-type guard -- no separate shape check is needed", () => {
    const shapes: unknown[] = [["USDC", "12"], "USDC:12", 12, true];
    for (const pricing of shapes) {
      expect(
        matchableTerms({ ...BASE, pricing: pricing as CapabilityLite["pricing"] }),
      ).toEqual({ ok: false, reason: "invalid-pricing" });
    }
  });
});

// ---------------------------------------------------------------------------
// (a) Undeclared/invalid assuranceTiers -> createMatcher returns null, even
//     as the sole, best-scoring candidate.
// ---------------------------------------------------------------------------

describe("createMatcher — fails closed on undeclared/invalid tiers", () => {
  const NO_TIERS: CapabilityLite = {
    id: "cap-no-tiers",
    type: "wood-fired-pizza",
    name: "Only Pizza Provider",
    tags: ["pizza", "food"],
    kernelId: "kernel-only",
    pricing: { currency: "USDC", baseCost: "12" },
    // assuranceTiers intentionally omitted — never declared.
  };

  it("never matches a capability with no declared assuranceTiers, even as the sole best-scoring candidate", async () => {
    const matcher = createMatcher(() => [NO_TIERS]);
    expect(await matcher.match(QUERY)).toBeNull();
  });

  it("never matches when assuranceTiers is []", async () => {
    const matcher = createMatcher(() => [{ ...NO_TIERS, assuranceTiers: [] }]);
    expect(await matcher.match(QUERY)).toBeNull();
  });

  it("never matches when assuranceTiers is [4]", async () => {
    const matcher = createMatcher(() => [{ ...NO_TIERS, assuranceTiers: [4] }]);
    expect(await matcher.match(QUERY)).toBeNull();
  });

  it('never matches when assuranceTiers is ["1"]', async () => {
    const matcher = createMatcher(() => [
      { ...NO_TIERS, assuranceTiers: ["1"] as unknown as number[] },
    ]);
    expect(await matcher.match(QUERY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (b) Undeclared/invalid pricing -> createMatcher returns null; minimum
//     fallback headline still matches.
// ---------------------------------------------------------------------------

describe("createMatcher — fails closed on undeclared/invalid pricing", () => {
  const NO_PRICING: CapabilityLite = {
    id: "cap-no-pricing",
    type: "wood-fired-pizza",
    name: "Only Pizza Provider",
    tags: ["pizza", "food"],
    kernelId: "kernel-only",
    assuranceTiers: [0, 1],
    // pricing intentionally omitted — never declared.
  };

  it("never matches with no pricing declared", async () => {
    const matcher = createMatcher(() => [NO_PRICING]);
    expect(await matcher.match(QUERY)).toBeNull();
  });

  it("never matches when pricing has no currency", async () => {
    const matcher = createMatcher(() => [{ ...NO_PRICING, pricing: { baseCost: "12" } }]);
    expect(await matcher.match(QUERY)).toBeNull();
  });

  it('never matches when the headline is "0"', async () => {
    const matcher = createMatcher(() => [
      { ...NO_PRICING, pricing: { currency: "USDC", baseCost: "0" } },
    ]);
    expect(await matcher.match(QUERY)).toBeNull();
  });

  it('never matches when the headline is "0.00"', async () => {
    const matcher = createMatcher(() => [
      { ...NO_PRICING, pricing: { currency: "USDC", baseCost: "0.00" } },
    ]);
    expect(await matcher.match(QUERY)).toBeNull();
  });

  it('never matches when the headline is non-numeric ("abc")', async () => {
    const matcher = createMatcher(() => [
      { ...NO_PRICING, pricing: { currency: "USDC", baseCost: "abc" } },
    ]);
    expect(await matcher.match(QUERY)).toBeNull();
  });

  it("matches using minimum as the headline when baseCost is absent", async () => {
    const matcher = createMatcher(() => [
      { ...NO_PRICING, pricing: { currency: "USDC", minimum: "5" } },
    ]);
    const result = await matcher.match(QUERY);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(5);
    expect(result!.currency).toBe("USDC");
  });
});

// ---------------------------------------------------------------------------
// (c) A declared capability matches with exactly its declared (sorted) tiers
//     and currency, and its digest equals one computed over those values.
// ---------------------------------------------------------------------------

describe("createMatcher — declared terms flow through unchanged into the digest", () => {
  const DECLARED: CapabilityLite = {
    id: "cap-declared",
    type: "wood-fired-pizza",
    name: "Mario's 12-inch Margherita",
    description: "wood fired pizza oven, neapolitan style",
    tags: ["pizza", "food", "wood-fired"],
    materials: ["dough", "mozzarella"],
    kernelId: "kernel-marios",
    pricing: { currency: "USDC", baseCost: "12" },
    // Declared out of order on purpose -- the match must return it sorted.
    assuranceTiers: [1, 0],
  };

  it("matches with exactly the declared tiers (as a sorted set) and currency", async () => {
    const matcher = createMatcher(() => [DECLARED]);
    const result = await matcher.match(QUERY);
    expect(result).not.toBeNull();
    expect(result!.assuranceTiers).toEqual([0, 1]);
    expect(result!.currency).toBe("USDC");
    expect(result!.price).toBe(12);
  });

  it("matchedCapabilityDigest equals matchedCapabilityDigest computed over the declared values", async () => {
    const matcher = createMatcher(() => [DECLARED]);
    const result = await matcher.match(QUERY);
    expect(result).not.toBeNull();

    const expected = matchedCapabilityDigest({
      capabilityId: DECLARED.id,
      capabilityType: DECLARED.type,
      kernelId: DECLARED.kernelId,
      price: 12,
      currency: "USDC",
      assuranceTiers: [0, 1],
    });
    expect(result!.matchedCapabilityDigest).toBe(expected);
  });

  it("preserves_declared_non_default_currency", async () => {
    // Guards against unconditional replacement with "USDC": the prior
    // coverage only ever declared "USDC", so it could not catch that
    // mutant (board N23 follow-up #439-E).
    const eur: CapabilityLite = {
      ...DECLARED,
      id: "cap-eur-declared",
      pricing: { currency: "EUR", baseCost: "12" },
    };
    const matcher = createMatcher(() => [eur]);
    const result = await matcher.match(QUERY);
    expect(result).not.toBeNull();
    expect(result!.currency).toBe("EUR");
  });

  it("createMatcher never matches a sub-cent declared price rather than inventing a 2-decimal representation of it", async () => {
    const subcent: CapabilityLite = {
      ...DECLARED,
      id: "cap-subcent-declared",
      pricing: { currency: "USDC", baseCost: "0.001" },
    };
    const matcher = createMatcher(() => [subcent]);
    expect(await matcher.match(QUERY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (d) A higher-scoring but undeclared candidate must lose to a lower-scoring
//     but declared one -- undeclared terms are never "the best match".
// ---------------------------------------------------------------------------

describe("createMatcher — a declared candidate wins over a higher-scoring undeclared one", () => {
  const HIGH_SCORE_UNDECLARED: CapabilityLite = {
    id: "cap-high-score-undeclared",
    type: "wood-fired-pizza",
    name: "Wood Fired Pizza Margherita Specialist",
    tags: ["pizza", "wood-fired", "margherita"],
    kernelId: "kernel-high",
    // No pricing, no assuranceTiers -- would win on score alone.
  };
  const LOWER_SCORE_DECLARED: CapabilityLite = {
    id: "cap-lower-score-declared",
    type: "pizza-catering",
    name: "Local Catering Co",
    tags: ["pizza"],
    kernelId: "kernel-low",
    pricing: { currency: "USDC", baseCost: "9" },
    assuranceTiers: [0],
  };

  it("the undeclared candidate really does score higher (premise check)", () => {
    const high = scoreCapability(QUERY, HIGH_SCORE_UNDECLARED).score;
    const low = scoreCapability(QUERY, LOWER_SCORE_DECLARED).score;
    expect(high).toBeGreaterThan(low);
  });

  it("the matcher returns the declared (lower-scoring) capability, not the undeclared (higher-scoring) one", async () => {
    const matcher = createMatcher(() => [HIGH_SCORE_UNDECLARED, LOWER_SCORE_DECLARED]);
    const result = await matcher.match(QUERY);
    expect(result).not.toBeNull();
    expect(result!.capabilityId).toBe("cap-lower-score-declared");
  });

  it("still returns the declared capability when candidate order is reversed", async () => {
    const matcher = createMatcher(() => [LOWER_SCORE_DECLARED, HIGH_SCORE_UNDECLARED]);
    const result = await matcher.match(QUERY);
    expect(result).not.toBeNull();
    expect(result!.capabilityId).toBe("cap-lower-score-declared");
  });
});
