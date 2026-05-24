import { describe, it, expect } from "vitest";
import {
  IndexedToolSchema,
  TrustTier,
  TRUST_TIER_NUMERIC,
  TRUST_TIER_DCC_CEILING,
  type IndexedTool,
} from "../types/indexed-tool.js";
import { DigitalCaptureClass } from "../types/dcc.js";

const validSha256 = "sha256:" + "a".repeat(64);

function makeIndexedTool(overrides: Partial<IndexedTool> = {}): IndexedTool {
  const base: IndexedTool = {
    id: "tool-001",
    cid: validSha256,
    version: "1.0.0",
    source: {
      type: "anthropic-registry",
      url: "https://registry.modelcontextprotocol.io/v0/servers/example",
      fetchedAt: "2026-05-23T12:00:00.000Z",
    },
    ingestedAt: "2026-05-23T12:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://example.com/mcp",
    skills: ["nlp.summarization"],
    domains: ["text"],
    features: ["abstractive"],
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    description: "Summarize text",
    actionClass: "read",
    assuranceCeiling: DigitalCaptureClass.DCC1,
    trustTier: TrustTier.AUTO_INDEXED,
    knownVulns: [],
    lastFetchedAt: "2026-05-23T12:00:00.000Z",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [validSha256],
    hostingPeers: [],
  };
  return { ...base, ...overrides };
}

describe("TrustTier ordering", () => {
  it("orders -1..4 per spec §7", () => {
    expect(TRUST_TIER_NUMERIC[TrustTier.QUARANTINED]).toBe(-1);
    expect(TRUST_TIER_NUMERIC[TrustTier.UNTRUSTED]).toBe(0);
    expect(TRUST_TIER_NUMERIC[TrustTier.AUTO_INDEXED]).toBe(1);
    expect(TRUST_TIER_NUMERIC[TrustTier.VERIFIED_PUBLISHER]).toBe(2);
    expect(TRUST_TIER_NUMERIC[TrustTier.VERIFIED_PARTNER]).toBe(3);
    expect(TRUST_TIER_NUMERIC[TrustTier.PCC_NATIVE]).toBe(4);
  });

  it("maps each tier to its DCC ceiling per spec §7 table", () => {
    expect(TRUST_TIER_DCC_CEILING[TrustTier.QUARANTINED]).toBe(DigitalCaptureClass.DCC0);
    expect(TRUST_TIER_DCC_CEILING[TrustTier.UNTRUSTED]).toBe(DigitalCaptureClass.DCC1);
    expect(TRUST_TIER_DCC_CEILING[TrustTier.AUTO_INDEXED]).toBe(DigitalCaptureClass.DCC2);
    expect(TRUST_TIER_DCC_CEILING[TrustTier.VERIFIED_PUBLISHER]).toBe(DigitalCaptureClass.DCC3);
    expect(TRUST_TIER_DCC_CEILING[TrustTier.VERIFIED_PARTNER]).toBe(DigitalCaptureClass.DCC4);
    expect(TRUST_TIER_DCC_CEILING[TrustTier.PCC_NATIVE]).toBe(DigitalCaptureClass.DCC5);
  });
});

describe("IndexedToolSchema (zod)", () => {
  it("accepts a minimal valid record", () => {
    const tool = makeIndexedTool();
    expect(() => IndexedToolSchema.parse(tool)).not.toThrow();
  });

  it("rejects a malformed CID", () => {
    const tool = makeIndexedTool({ cid: "not-a-sha256" as `sha256:${string}` });
    expect(() => IndexedToolSchema.parse(tool)).toThrow();
  });

  it("rejects a non-URL upstreamUrl", () => {
    const tool = makeIndexedTool({ upstreamUrl: "not a url" });
    expect(() => IndexedToolSchema.parse(tool)).toThrow();
  });

  it("requires cpFiveMcpScore in 0..13 if set", () => {
    expect(() => IndexedToolSchema.parse(makeIndexedTool({ cpFiveMcpScore: -1 }))).toThrow();
    expect(() => IndexedToolSchema.parse(makeIndexedTool({ cpFiveMcpScore: 14 }))).toThrow();
    expect(() => IndexedToolSchema.parse(makeIndexedTool({ cpFiveMcpScore: 13 }))).not.toThrow();
    expect(() => IndexedToolSchema.parse(makeIndexedTool({ cpFiveMcpScore: 0 }))).not.toThrow();
  });

  it("clamps successRate to [0,1] if set", () => {
    expect(() => IndexedToolSchema.parse(makeIndexedTool({ successRate: -0.01 }))).toThrow();
    expect(() => IndexedToolSchema.parse(makeIndexedTool({ successRate: 1.01 }))).toThrow();
    expect(() => IndexedToolSchema.parse(makeIndexedTool({ successRate: 0.5 }))).not.toThrow();
  });

  it("accepts each ingestionMethod literal", () => {
    for (const m of ["mcp-list", "openapi", "a2a-card", "oasf", "manual", "wellknown"] as const) {
      expect(() => IndexedToolSchema.parse(makeIndexedTool({ ingestionMethod: m }))).not.toThrow();
    }
  });

  it("accepts each action class", () => {
    for (const a of ["read", "write", "exec", "network", "credential"] as const) {
      expect(() => IndexedToolSchema.parse(makeIndexedTool({ actionClass: a }))).not.toThrow();
    }
  });

  it("preserves schemaHashHistory append-only ordering at the type level", () => {
    const tool = makeIndexedTool({
      schemaHashHistory: [
        ("sha256:" + "a".repeat(64)) as `sha256:${string}`,
        ("sha256:" + "b".repeat(64)) as `sha256:${string}`,
        ("sha256:" + "c".repeat(64)) as `sha256:${string}`,
      ],
    });
    const parsed = IndexedToolSchema.parse(tool);
    expect(parsed.schemaHashHistory).toHaveLength(3);
    expect(parsed.schemaHashHistory[2]).toMatch(/c{64}/);
  });
});
