import { describe, it, expect, beforeEach } from "vitest";
import { IndexedToolRegistry } from "../registry.js";
import {
  type IndexedTool,
  DigitalCaptureClass,
  TrustTier,
} from "@pcc/spec";

const SHA = "sha256:" + "a".repeat(64);

function makeTool(overrides: Partial<IndexedTool> = {}): IndexedTool {
  return {
    id: "tool-1",
    cid: SHA,
    version: "1.0.0",
    source: {
      type: "mcp-directory",
      url: "https://mcp.directory/x",
      fetchedAt: "2026-05-23T00:00:00.000Z",
    },
    ingestedAt: "2026-05-23T00:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://example.com/api",
    skills: ["nlp.summarization"],
    domains: ["data"],
    features: [],
    inputSchema: {},
    description: "summarize documents",
    actionClass: "read",
    assuranceCeiling: DigitalCaptureClass.DCC3,
    trustTier: TrustTier.AUTO_INDEXED,
    knownVulns: [],
    lastFetchedAt: "2026-05-23T00:00:00.000Z",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [SHA],
    hostingPeers: [],
    ...overrides,
  };
}

describe("IndexedToolRegistry — basic CRUD", () => {
  let reg: IndexedToolRegistry;
  beforeEach(() => {
    reg = new IndexedToolRegistry();
  });

  it("upsert + get round-trip", () => {
    const t = makeTool({ id: "t-1" });
    reg.upsert(t);
    expect(reg.get("t-1")).toEqual(t);
    expect(reg.count()).toBe(1);
  });

  it("upsert overwrites existing entry", () => {
    reg.upsert(makeTool({ id: "t-1", description: "original" }));
    reg.upsert(makeTool({ id: "t-1", description: "updated" }));
    expect(reg.get("t-1")?.description).toBe("updated");
    expect(reg.count()).toBe(1);
  });

  it("remove returns true when present, false otherwise", () => {
    reg.upsert(makeTool({ id: "t-1" }));
    expect(reg.remove("t-1")).toBe(true);
    expect(reg.remove("t-1")).toBe(false);
    expect(reg.count()).toBe(0);
  });

  it("clear empties the registry", () => {
    reg.upsert(makeTool({ id: "a" }));
    reg.upsert(makeTool({ id: "b" }));
    reg.clear();
    expect(reg.count()).toBe(0);
  });
});

describe("IndexedToolRegistry — query()", () => {
  let reg: IndexedToolRegistry;
  beforeEach(() => {
    reg = new IndexedToolRegistry();
    reg.upsert(
      makeTool({
        id: "a-summarize",
        description: "summarize documents and articles",
        skills: ["nlp.summarization"],
        actionClass: "read",
        trustTier: TrustTier.VERIFIED_PUBLISHER,
        domains: ["nlp"],
      }),
    );
    reg.upsert(
      makeTool({
        id: "b-delete",
        description: "destroy old records",
        skills: ["data.delete"],
        actionClass: "write",
        trustTier: TrustTier.UNTRUSTED,
        domains: ["data"],
      }),
    );
    reg.upsert(
      makeTool({
        id: "c-search",
        description: "search the web for facts",
        skills: ["web.search"],
        actionClass: "read",
        trustTier: TrustTier.AUTO_INDEXED,
        domains: ["web"],
      }),
    );
  });

  it("q substring match (case-insensitive)", () => {
    const res = reg.query({ q: "SUMMAR" });
    expect(res).toHaveLength(1);
    expect(res[0]?.id).toBe("a-summarize");
  });

  it("filters by actionClass", () => {
    const res = reg.query({ actionClass: "write" });
    expect(res).toHaveLength(1);
    expect(res[0]?.id).toBe("b-delete");
  });

  it("filters by minTrustTier (VERIFIED_PUBLISHER+)", () => {
    const res = reg.query({ minTrustTier: TrustTier.VERIFIED_PUBLISHER });
    expect(res).toHaveLength(1);
    expect(res[0]?.id).toBe("a-summarize");
  });

  it("filters by skill", () => {
    const res = reg.query({ skill: "web.search" });
    expect(res.map((t) => t.id)).toEqual(["c-search"]);
  });

  it("filters by domain", () => {
    const res = reg.query({ domain: "data" });
    expect(res.map((t) => t.id)).toEqual(["b-delete"]);
  });

  it("multiple filters AND-combine", () => {
    const res = reg.query({
      q: "search",
      actionClass: "read",
      minTrustTier: TrustTier.UNTRUSTED,
    });
    expect(res.map((t) => t.id)).toEqual(["c-search"]);
  });

  it("returns ids sorted ascending for stable pagination", () => {
    const res = reg.query({});
    expect(res.map((t) => t.id)).toEqual(["a-summarize", "b-delete", "c-search"]);
  });

  it("limit + offset slice", () => {
    const res = reg.query({ limit: 1, offset: 1 });
    expect(res.map((t) => t.id)).toEqual(["b-delete"]);
  });
});
