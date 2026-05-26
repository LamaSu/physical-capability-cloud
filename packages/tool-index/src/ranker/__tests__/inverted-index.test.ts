import { describe, it, expect } from "vitest";
import { InvertedIndex, searchableTextOf } from "../inverted-index.js";

describe("searchableTextOf", () => {
  it("concatenates name + description + skills + domains + features + tags", () => {
    const text = searchableTextOf({
      name: "summarize",
      description: "summarize a document",
      skills: ["nlp.summarization"],
      domains: ["nlp"],
      features: ["batch"],
      tags: ["fast"],
    });
    expect(text).toContain("summarize");
    expect(text).toContain("nlp.summarization");
    expect(text).toContain("nlp");
    expect(text).toContain("batch");
    expect(text).toContain("fast");
  });
  it("handles missing fields gracefully", () => {
    expect(searchableTextOf({})).toBe("");
    expect(searchableTextOf({ description: "x" })).toBe("x");
  });
});

describe("InvertedIndex", () => {
  it("upsert + candidatesFor round-trip", () => {
    const idx = new InvertedIndex();
    idx.upsert("a", "summarize documents");
    idx.upsert("b", "search the web");
    expect(idx.size()).toBe(2);
    expect(idx.candidatesFor(["summarize"])).toEqual(new Set(["a"]));
    expect(idx.candidatesFor(["web"])).toEqual(new Set(["b"]));
    expect(idx.candidatesFor(["summarize", "web"])).toEqual(new Set(["a", "b"]));
  });

  it("remove cleans the postings", () => {
    const idx = new InvertedIndex();
    idx.upsert("a", "summarize documents");
    expect(idx.candidatesFor(["summarize"])).toEqual(new Set(["a"]));
    expect(idx.remove("a")).toBe(true);
    expect(idx.candidatesFor(["summarize"])).toEqual(new Set());
    expect(idx.size()).toBe(0);
    expect(idx.remove("a")).toBe(false);
  });

  it("upsert with same id replaces old terms (no stale postings)", () => {
    const idx = new InvertedIndex();
    idx.upsert("a", "summarize documents");
    idx.upsert("a", "search web");
    expect(idx.candidatesFor(["summarize"])).toEqual(new Set());
    expect(idx.candidatesFor(["search"])).toEqual(new Set(["a"]));
  });

  it("corpusStats reflects current state", () => {
    const idx = new InvertedIndex();
    idx.upsert("a", "alpha beta gamma");
    idx.upsert("b", "alpha delta");
    const stats = idx.corpusStats();
    expect(stats.totalDocs).toBe(2);
    expect(stats.avgDocLength).toBe(2.5);
    expect(stats.docFreq.get("alpha")).toBe(2);
    expect(stats.docFreq.get("beta")).toBe(1);
    expect(stats.docFreq.get("delta")).toBe(1);
  });

  it("docStatsOf returns per-doc term-frequency table", () => {
    const idx = new InvertedIndex();
    idx.upsert("a", "alpha alpha beta");
    const ds = idx.docStatsOf("a");
    expect(ds?.length).toBe(3);
    expect(ds?.termFreq.get("alpha")).toBe(2);
    expect(ds?.termFreq.get("beta")).toBe(1);
  });

  it("reset empties index + postings", () => {
    const idx = new InvertedIndex();
    idx.upsert("a", "alpha");
    idx.reset();
    expect(idx.size()).toBe(0);
    expect(idx.candidatesFor(["alpha"])).toEqual(new Set());
  });
});
