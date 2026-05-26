/**
 * Test fixtures — builds canonical IndexedTool records for the ranker
 * test suite. Reuses the @pcc/spec IndexedTool shape directly so we test
 * against the production type, not a stub.
 */

import {
  type IndexedTool,
  DigitalCaptureClass,
  TrustTier,
} from "@pcc/spec";

const SHA = "sha256:" + "a".repeat(64);

/** Build a baseline IndexedTool with the supplied overrides. */
export function makeTool(overrides: Partial<IndexedTool> = {}): IndexedTool {
  return {
    id: "tool-1",
    cid: SHA,
    version: "1.0.0",
    source: {
      type: "pcc-native",
      url: "https://example.com/pcc",
      fetchedAt: "2026-05-23T00:00:00.000Z",
    },
    ingestedAt: "2026-05-23T00:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://example.com/api",
    skills: ["nlp.summarization"],
    domains: ["nlp"],
    features: ["batch"],
    inputSchema: {},
    description: "summarize documents and articles into concise abstracts",
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
