/**
 * Kit royalties (R4): the License hash kits pin, the lineage split, and the exact split a buyer funds.
 * computeKitSplit is checked against the accepted-plan seam itself: the seam accepts the gross it finds,
 * and refuses one base unit less.
 */

import { describe, expect, it } from "vitest";
import { netSplitterFor, type ServerEconomicsFacts } from "../economics/bind.js";
import { compileEconomics } from "../economics/compile.js";
import { exampleSparePrinter } from "../economics/examples.js";
import { domainHash } from "../economics/hash.js";
import {
  KIT_LINEAGE_WEIGHTS,
  KIT_ROYALTY_ROLE,
  LICENSE_DOMAIN,
  computeKitSplit,
  kitLineageDistribution,
  kitRoyaltyRequirement,
  kitSplitAgreement,
  licenseHash,
} from "../economics/kits.js";
import type { EconomicAgreement } from "../economics/types.js";

const USDC = { code: "USDC", decimals: 6 };

/** What an honest server would know about a one-unit kit agreement. */
function serverFacts(ag: EconomicAgreement): ServerEconomicsFacts {
  return {
    feeBps: ag.fee.feeBps,
    feeRecipient: ag.fee.feeRecipient ?? "0x0000000000000000000000000000000000000000",
    currency: ag.currency,
    now: ag.asOf + 60,
    intendedUse: structuredClone(ag.use),
    licenses: structuredClone(ag.licenses),
    parties: ag.parties.flatMap((p) => (p.payTo === null ? [] : [{ partyId: p.partyId, payTo: p.payTo }])),
    unitFacts: Object.fromEntries(ag.units.map((u) => [u.unitRef, { components: structuredClone(u.components), measures: structuredClone(u.measures) }])),
    schedules: [],
    forbiddenRecipients: [],
  };
}

/** The seam's answer for a unit at `gross` with the operator's `quote`. */
function seam(gross: bigint, quote: bigint, input: { feeBps: number; licenseBps: number; lineage: readonly string[] }): string {
  const ag = kitSplitAgreement(gross, { currency: USDC, ...input });
  const operator = ag.parties.find((p) => p.partyId === "kit-split:operator")!.payTo!;
  const f = (gross * BigInt(input.feeBps)) / 10_000n;
  const r = netSplitterFor({ agreement: ag, accepted: null, server: serverFacts(ag) })([{ nodeId: "job", operator, payoutAddress: operator, quote, g: gross, f, n: gross - f }]);
  return r.ok ? "ok" : r.code;
}

describe("licenseHash: the License's content address", () => {
  const license = exampleSparePrinter().licenses[0]!;

  it("is 0x and 64 lowercase hex, the domain hash of the parsed License, whatever the key order", () => {
    const h = licenseHash(license);
    if (!h.ok) throw new Error(h.reason);
    expect(h.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.hash).toBe(domainHash(LICENSE_DOMAIN, license));
    const reordered = Object.fromEntries(Object.entries(license).reverse());
    expect(licenseHash(reordered)).toEqual(h);
  });

  it("a changed License hashes differently; a malformed one or a non-JSON value is refused, never hashed", () => {
    const h = licenseHash(license);
    expect(licenseHash({ ...license, version: license.version + 1 })).not.toEqual(h);
    expect(licenseHash({ ...license, class: "unheard-of" })).toMatchObject({ ok: false });
    expect(licenseHash({ ...license, extra: 1 })).toMatchObject({ ok: false });
    expect(licenseHash(Object.defineProperty({ ...license }, "label", { get: () => "x", enumerable: true }))).toMatchObject({ ok: false });
  });
});

describe("the lineage split", () => {
  it("halves per generation, nearest first, and pays nobody past the grandparent", () => {
    expect(kitLineageDistribution(["ann"])).toEqual([{ party: "ann", weight: 1, role: null, subject: null }]);
    expect(kitLineageDistribution(["bob", "ann"]).map((d) => [d.party, d.weight])).toEqual([["ann", 1], ["bob", 2]]);
    expect(kitLineageDistribution(["carol", "bob", "ann"]).map((d) => [d.party, d.weight])).toEqual([["ann", 1], ["bob", 2], ["carol", 4]]);
    expect(kitLineageDistribution(["dave", "carol", "bob", "ann"]).map((d) => d.party)).toEqual(["bob", "carol", "dave"]);
  });

  it("a self-fork is one member with the summed weight, in lowest terms; members sort by party id", () => {
    expect(kitLineageDistribution(["ann", "ann"])).toEqual([{ party: "ann", weight: 1, role: null, subject: null }]);
    expect(kitLineageDistribution(["ann", "bob", "ann"]).map((d) => [d.party, d.weight])).toEqual([["ann", 5], ["bob", 2]]);
    expect(() => kitLineageDistribution([])).toThrow(RangeError);
  });

  it("the requirement is a percent of gross, per unit that runs the kit, to that distribution; a free kit requires nothing", () => {
    expect(kitRoyaltyRequirement({ bps: 0, lineage: ["ann"] })).toBeNull();
    expect(kitRoyaltyRequirement({ bps: 50, lineage: ["bob", "ann"] })).toEqual({
      requirementId: "kit-royalty",
      role: KIT_ROYALTY_ROLE,
      per: "using-unit",
      payee: { distribution: kitLineageDistribution(["bob", "ann"]) },
      rule: { kind: "percent", bps: 50, of: "gross", min: null, max: null, rateSource: null },
    });
    expect(() => kitRoyaltyRequirement({ bps: 10_001, lineage: ["ann"] })).toThrow(RangeError);
  });
});

describe("computeKitSplit: what a buyer funds, exactly as settlement pays it", () => {
  it("a $25.00 print, PCC's 2.35% fee, a 0.50% royalty to a fork of a fork (4 : 2 : 1)", () => {
    const s = computeKitSplit({ quoteMinor: "25000000", currency: USDC, feeBps: 235, licenseBps: 50, lineage: ["carol", "bob", "ann"] });
    if (!s.ok) throw new Error(s.reason);
    expect(BigInt(s.grossMinor)).toBe(BigInt(s.feeMinor) + BigInt(s.royaltyMinor) + BigInt(s.operatorMinor));
    expect(BigInt(s.operatorMinor)).toBeGreaterThanOrEqual(25_000_000n - 587_500n); // the quote less the fee on it
    expect(s.shares.map((x) => [x.party, x.weight])).toEqual([["carol", 4], ["bob", 2], ["ann", 1]]);
    expect(s.shares.reduce((t, x) => t + BigInt(x.amountMinor), 0n)).toBe(BigInt(s.royaltyMinor));
    expect(seam(BigInt(s.grossMinor), 25_000_000n, { feeBps: 235, licenseBps: 50, lineage: ["carol", "bob", "ann"] })).toBe("ok");
    expect(seam(BigInt(s.grossMinor) - 1n, 25_000_000n, { feeBps: 235, licenseBps: 50, lineage: ["carol", "bob", "ann"] })).toBe("economics:OPERATOR_BELOW_QUOTE:job");
  });

  it("the compiler pays the same legs for that gross", () => {
    const input = { quoteMinor: 2_500_000_000n, currency: USDC, feeBps: 235, licenseBps: 100, lineage: ["bob", "ann"] };
    const s = computeKitSplit(input);
    if (!s.ok) throw new Error(s.reason);
    const c = compileEconomics(kitSplitAgreement(BigInt(s.grossMinor), input));
    if (!c.ok) throw new Error("fixture");
    expect(c.units[0]!.fee).toBe(s.feeMinor);
    expect(c.units[0]!.payouts.map((p) => p.amount).sort()).toEqual([s.operatorMinor, ...s.shares.map((x) => x.amountMinor)].sort());
  });

  it("refuses what it cannot price honestly: a free kit, a tiny quote, an unknown fee, a reserved party id", () => {
    const base = { quoteMinor: "25000000", currency: USDC, feeBps: 235, licenseBps: 50, lineage: ["ann"] };
    expect(computeKitSplit({ ...base, licenseBps: 0 })).toMatchObject({ ok: false });
    expect(computeKitSplit({ ...base, quoteMinor: "4" })).toMatchObject({ ok: false });
    expect(computeKitSplit({ ...base, quoteMinor: "1.5" })).toMatchObject({ ok: false });
    expect(computeKitSplit({ ...base, feeBps: 1001 })).toMatchObject({ ok: false });
    expect(computeKitSplit({ ...base, lineage: ["kit-split:operator"] })).toMatchObject({ ok: false });
    expect(computeKitSplit({ ...base, lineage: [] })).toMatchObject({ ok: false });
  });

  it("every lineage, fee and rate, at three quotes each (270 cases): every unit conserves, and the seam accepts the gross and refuses one less", () => {
    // BigInt arithmetic: a Number LCG overflows 2^53 and degenerates, which left two of the six lineages
    // untested at 320687fc (astra EC4 L2). Every combination now runs explicitly.
    let seed = 7n;
    const nextQuote = () => {
      seed = (seed * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % 2n ** 64n;
      return 5n + ((seed >> 33n) % 1_000_000_000n);
    };
    const lineages = [["ann"], ["bob", "ann"], ["carol", "bob", "ann"], ["dave", "carol", "bob", "ann"], ["ann", "bob", "ann"], ["ann", "ann"]];
    let cases = 0;
    const ran = new Set<number>();
    lineages.forEach((lineage, li) => {
      for (const feeBps of [0, 235, 1000]) {
        for (const licenseBps of [1, 50, 100, 150, 1000]) {
          for (let k = 0; k < 3; k++) {
            const quote = nextQuote();
            const s = computeKitSplit({ quoteMinor: quote, currency: USDC, feeBps, licenseBps, lineage });
            if (!s.ok) throw new Error(`${quote} ${feeBps} ${licenseBps}: ${s.reason}`);
            const g = BigInt(s.grossMinor);
            expect(g).toBe(BigInt(s.feeMinor) + BigInt(s.royaltyMinor) + BigInt(s.operatorMinor));
            expect(s.shares.reduce((t, x) => t + BigInt(x.amountMinor), 0n)).toBe(BigInt(s.royaltyMinor));
            expect(seam(g, quote, { feeBps, licenseBps, lineage })).toBe("ok");
            expect(seam(g - 1n, quote, { feeBps, licenseBps, lineage })).toMatch(/OPERATOR_BELOW_QUOTE|QUOTE_NOT_COVERED/);
            cases++;
            ran.add(li);
          }
        }
      }
    });
    expect(cases).toBe(270);
    expect(ran.size).toBe(lineages.length);
  });
});

describe("astra EC4 (#492 round 1 at 320687fc)", () => {
  const base = { quoteMinor: "25000000", currency: USDC, feeBps: 235, licenseBps: 50 };

  it("M1: the lineage is read once: a getter that changes its answer cannot misattribute the royalty", () => {
    let reads = 0;
    const r = computeKitSplit({
      quoteMinor: 5n,
      currency: USDC,
      feeBps: 0,
      licenseBps: 1000,
      get lineage() {
        return ++reads <= 6 ? ["ann"] : ["bob"];
      },
    });
    expect(r.ok ? r.shares.map((x) => x.party) : "refused").toBe("refused");
  });

  it("M1: a sparse or non-string lineage is refused, never thrown", () => {
    expect(() => computeKitSplit({ ...base, lineage: new Array(1) })).not.toThrow();
    expect(computeKitSplit({ ...base, lineage: new Array(1) })).toMatchObject({ ok: false });
    expect(computeKitSplit({ ...base, lineage: [42 as unknown as string] })).toMatchObject({ ok: false });
    expect(() => kitLineageDistribution(new Array(1))).toThrow(RangeError);
  });

  it("M2: the lineage weights cannot be changed at runtime", () => {
    expect(() => {
      (KIT_LINEAGE_WEIGHTS as number[])[0] = 8;
    }).toThrow(TypeError);
    expect(kitLineageDistribution(["carol", "bob", "ann"]).map((d) => d.weight)).toEqual([1, 2, 4]);
  });

  it("M3: kitSplitAgreement refuses a free kit with a RangeError, never a crash", () => {
    expect(() => kitSplitAgreement(100n, { currency: USDC, feeBps: 235, licenseBps: 0, lineage: ["ann"] })).toThrow(RangeError);
  });

  it("L1: a quote must be a canonical decimal amount", () => {
    for (const q of ["0x10", "+16", " 16 ", "016", "1e7"]) expect(computeKitSplit({ ...base, quoteMinor: q, lineage: ["ann"] }), q).toMatchObject({ ok: false });
  });
});
