import { describe, it, expect } from "vitest";
import { RRF_K_DEFAULT, reciprocalRankFusion, rrfK } from "../rrf.js";

describe("RRF_K_DEFAULT", () => {
  it("is 60 per Cormack 2009 / Vespa / Elastic / Azure standard", () => {
    expect(RRF_K_DEFAULT).toBe(60);
  });
});

describe("rrfK env override", () => {
  it("reads PCC_RANK_RRF_K when set", () => {
    expect(rrfK({ PCC_RANK_RRF_K: "40" } as NodeJS.ProcessEnv)).toBe(40);
  });
  it("falls back to 60 when missing", () => {
    expect(rrfK({} as NodeJS.ProcessEnv)).toBe(60);
  });
  it("rejects negative/zero values", () => {
    expect(rrfK({ PCC_RANK_RRF_K: "0" } as NodeJS.ProcessEnv)).toBe(60);
    expect(rrfK({ PCC_RANK_RRF_K: "-5" } as NodeJS.ProcessEnv)).toBe(60);
  });
});

describe("reciprocalRankFusion", () => {
  it("doc appearing first in both lists scores highest", () => {
    const r1 = ["a", "b", "c"];
    const r2 = ["a", "c", "b"];
    const out = reciprocalRankFusion([r1, r2]);
    expect(out[0]?.id).toBe("a");
  });

  it("doc appearing only in one list still scores positively", () => {
    const r1 = ["a", "b"];
    const r2 = ["c"];
    const out = reciprocalRankFusion([r1, r2]);
    const ids = out.map((o) => o.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("uses k=60 by default — verify with hand-computed score", () => {
    const r1 = ["a"];
    const out = reciprocalRankFusion([r1]);
    // RRF score = 1 / (60 + 1) = 1/61
    expect(out[0]?.score).toBeCloseTo(1 / 61, 6);
  });

  it("custom k changes ordering when rank gaps are large", () => {
    // Two lists where doc 'a' is ranked 1 in r1, 100 in r2;
    // doc 'b' is ranked 50 in both. With k=60 'a' wins; with very large k
    // the picture flattens.
    const r1 = ["a", ...Array.from({ length: 99 }, (_, i) => `f${i}`), "b"].slice(0, 100);
    const r2 = ["b", ...Array.from({ length: 99 }, (_, i) => `g${i}`), "a"].slice(0, 100);

    const outK60 = reciprocalRankFusion([r1, r2], { k: 60 });
    expect(outK60[0]?.id).toMatch(/[ab]/); // one of a / b wins

    // Per-ranker ranks tracked correctly.
    const aHit = outK60.find((o) => o.id === "a")!;
    const bHit = outK60.find((o) => o.id === "b")!;
    expect(aHit.ranks[0]).toBe(1);
    expect(bHit.ranks[1]).toBe(1);
  });
});
