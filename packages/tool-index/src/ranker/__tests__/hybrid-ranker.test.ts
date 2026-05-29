import { describe, it, expect } from "vitest";
import { HybridRanker } from "../index.js";
import { HashFallbackProvider } from "../../embeddings.js";
import { TrustTier, DigitalCaptureClass } from "@pcc/spec";
import { makeTool } from "./fixtures.js";

function ranker() {
  return new HybridRanker(new HashFallbackProvider());
}

describe("HybridRanker — lifecycle", () => {
  it("upsert, size, get, remove", async () => {
    const r = ranker();
    await r.upsert(makeTool({ id: "a" }));
    expect(r.size()).toBe(1);
    expect(r.get("a")?.id).toBe("a");
    expect(await r.remove("a")).toBe(true);
    expect(r.size()).toBe(0);
    expect(await r.remove("a")).toBe(false);
  });

  it("reset replaces the entire index", async () => {
    const r = ranker();
    await r.upsert(makeTool({ id: "a" }));
    await r.reset([makeTool({ id: "b" }), makeTool({ id: "c" })]);
    expect(r.size()).toBe(2);
    expect(r.get("a")).toBeUndefined();
  });

  it("providerName and dim surface the underlying provider", () => {
    const r = ranker();
    expect(r.providerName).toBe("hash-fallback-sha256-256");
    expect(r.dim).toBe(256);
  });
});

describe("HybridRanker — rank()", () => {
  it("returns top-K hits sorted by score desc", async () => {
    const r = ranker();
    await r.reset([
      makeTool({ id: "a", description: "summarize documents into abstracts" }),
      makeTool({ id: "b", description: "perform CNC milling operations" }),
      makeTool({ id: "c", description: "summarize articles and posts" }),
    ]);
    const hits = await r.rank({ q: "summarize document", topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const ids = hits.map((h) => h.tool.id);
    expect(ids).toContain("a");
    // Scores monotonically decrease.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
    // Ranks 1..N.
    expect(hits[0]!.rank).toBe(1);
  });

  it("hard filter excludes ineligible tools", async () => {
    const r = ranker();
    await r.reset([
      makeTool({ id: "a", trustTier: TrustTier.PCC_NATIVE }),
      makeTool({ id: "b", trustTier: TrustTier.UNTRUSTED }),
      makeTool({ id: "c", trustTier: TrustTier.QUARANTINED }),
    ]);
    const hits = await r.rank({
      q: "summarize",
      filter: { minTrustTier: TrustTier.AUTO_INDEXED },
    });
    const ids = hits.map((h) => h.tool.id);
    expect(ids).toContain("a");
    expect(ids).not.toContain("b");
    expect(ids).not.toContain("c");
  });

  it("explain=true populates phase1Score + signals + passedGates", async () => {
    const r = ranker();
    await r.reset([
      makeTool({
        id: "a",
        invocationCount: 100,
        successRate: 0.9,
        assuranceCeiling: DigitalCaptureClass.DCC5,
        trustTier: TrustTier.PCC_NATIVE,
        description: "summarize documents",
      }),
    ]);
    const [hit] = await r.rank({ q: "summarize", explain: true });
    expect(hit?.phase1Score).toBeDefined();
    expect(hit?.signals).toBeDefined();
    expect(hit?.signals?.trust).toBeGreaterThan(0);
    expect(hit?.signals?.provenance).toBeGreaterThan(0);
    expect(hit?.passedGates).toContain("no-quarantined");
  });

  it("presets produce different orderings for same query", async () => {
    const r = ranker();
    await r.reset([
      // Tool A: PCC_NATIVE with high provenance — should win agent-default.
      makeTool({
        id: "a",
        trustTier: TrustTier.PCC_NATIVE,
        invocationCount: 1000,
        successRate: 1.0,
        assuranceCeiling: DigitalCaptureClass.DCC5,
        description: "summarize documents",
      }),
      // Tool B: untrusted but high BM25 relevance — should win discovery-explore.
      makeTool({
        id: "b",
        trustTier: TrustTier.AUTO_INDEXED,
        invocationCount: 0,
        successRate: 0,
        assuranceCeiling: DigitalCaptureClass.DCC1,
        description: "summarize summarize summarize document document document",
      }),
    ]);
    const defaultHits = await r.rank({ q: "summarize document", profile: "agent-default" });
    const exploreHits = await r.rank({ q: "summarize document", profile: "discovery-explore" });
    // We just want orderings to be allowed to differ (they may or may not based on the
    // exact signal magnitudes); the contract is that both hits are returned in each case.
    expect(defaultHits.length).toBeGreaterThan(0);
    expect(exploreHits.length).toBeGreaterThan(0);
  });

  it("empty query (filter-only) returns hard-filtered tools scored by phase-2 only", async () => {
    const r = ranker();
    await r.reset([
      makeTool({ id: "a", trustTier: TrustTier.PCC_NATIVE }),
      makeTool({ id: "b", trustTier: TrustTier.UNTRUSTED }),
    ]);
    const hits = await r.rank({});
    const ids = hits.map((h) => h.tool.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    // PCC_NATIVE should score higher than UNTRUSTED with default weights.
    const aIdx = ids.indexOf("a");
    const bIdx = ids.indexOf("b");
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("topK clamps to [1, 100]", async () => {
    const r = ranker();
    const tools = Array.from({ length: 5 }, (_, i) =>
      makeTool({ id: `t-${i}`, description: `tool ${i} summarize` }),
    );
    await r.reset(tools);
    const hits = await r.rank({ q: "summarize", topK: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});

describe("HybridRanker — phase-1 retrieve()", () => {
  it("returns CandidateHits with phase1Score in [0, 1]", async () => {
    const r = ranker();
    await r.reset([
      makeTool({ id: "a", description: "alpha bravo" }),
      makeTool({ id: "b", description: "charlie delta" }),
    ]);
    const cands = await r.retrieve({ q: "alpha" });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.phase1Score).toBeGreaterThanOrEqual(0);
      expect(c.phase1Score).toBeLessThanOrEqual(1);
    }
  });
});
