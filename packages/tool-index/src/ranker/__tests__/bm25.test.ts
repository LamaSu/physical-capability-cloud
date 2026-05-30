import { describe, it, expect } from "vitest";
import {
  BM25_B_DEFAULT,
  BM25_K1_DEFAULT,
  bm25B,
  bm25K1,
  bm25Score,
  tokenize,
  type CorpusStats,
  type DocStats,
} from "../bm25.js";

describe("tokenize", () => {
  it("lowercases + splits on non-word", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });
  it("returns empty array for empty / whitespace-only", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
  it("preserves underscores and digits", () => {
    expect(tokenize("FDM_3d-print v2")).toEqual(["fdm_3d", "print", "v2"]);
  });
});

describe("bm25 defaults + env overrides", () => {
  it("BM25_K1_DEFAULT and BM25_B_DEFAULT match Vespa/Lucene", () => {
    expect(BM25_K1_DEFAULT).toBe(1.2);
    expect(BM25_B_DEFAULT).toBe(0.75);
  });
  it("bm25K1 reads PCC_RANK_BM25_K1 when set, else falls back to default", () => {
    expect(bm25K1({ PCC_RANK_BM25_K1: "1.5" } as NodeJS.ProcessEnv)).toBe(1.5);
    expect(bm25K1({} as NodeJS.ProcessEnv)).toBe(1.2);
    // Invalid values fall back to default.
    expect(bm25K1({ PCC_RANK_BM25_K1: "not-a-number" } as NodeJS.ProcessEnv)).toBe(1.2);
  });
  it("bm25B clamps to [0, 1] range and falls back to default outside", () => {
    expect(bm25B({ PCC_RANK_BM25_B: "0.5" } as NodeJS.ProcessEnv)).toBe(0.5);
    expect(bm25B({ PCC_RANK_BM25_B: "1.5" } as NodeJS.ProcessEnv)).toBe(0.75);
    expect(bm25B({} as NodeJS.ProcessEnv)).toBe(0.75);
  });
});

describe("bm25Score", () => {
  // Tiny corpus for smoke testing.
  function corpus(): CorpusStats {
    return {
      totalDocs: 3,
      avgDocLength: 6,
      docFreq: new Map<string, number>([
        ["summarize", 2],
        ["documents", 1],
        ["articles", 1],
        ["search", 1],
        ["web", 1],
      ]),
    };
  }

  function doc(text: string[]): DocStats {
    const termFreq = new Map<string, number>();
    for (const t of text) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    return { length: text.length, termFreq };
  }

  it("returns 0 for empty query or empty doc", () => {
    const d = doc(["summarize"]);
    const c = corpus();
    expect(bm25Score([], d, c)).toBe(0);
    expect(bm25Score(["summarize"], { length: 0, termFreq: new Map() }, c)).toBe(0);
  });

  it("returns positive score when query term is in doc", () => {
    const d = doc(["summarize", "documents"]);
    const score = bm25Score(["summarize"], d, corpus());
    expect(score).toBeGreaterThan(0);
  });

  it("scores rarer terms (lower df) higher than common terms", () => {
    const d = doc(["summarize", "articles"]);
    const c = corpus(); // summarize df=2, articles df=1
    const rareScore = bm25Score(["articles"], d, c);
    const commonScore = bm25Score(["summarize"], d, c);
    expect(rareScore).toBeGreaterThan(commonScore);
  });

  it("returns 0 when no query term is in the doc", () => {
    const d = doc(["completely", "unrelated", "text"]);
    expect(bm25Score(["summarize"], d, corpus())).toBe(0);
  });
});
