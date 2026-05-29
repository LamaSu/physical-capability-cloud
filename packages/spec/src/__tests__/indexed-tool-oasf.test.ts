import { describe, it, expect } from "vitest";
import { DigitalCaptureClass } from "../types/dcc.js";
import {
  IndexedToolSchema,
  TrustTier,
  type IndexedTool,
  type OasfModule,
} from "../types/indexed-tool.js";

const baseValidTool: IndexedTool = {
  id: "agntcy:bafy123#manufacturing/cnc-3axis",
  cid: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  version: "1.0.0",
  source: {
    type: "agntcy-dht",
    url: "https://prod.api.ads.outshift.io/v1/records/bafy123",
    fetchedAt: "2026-05-25T12:00:00.000Z",
    scoreSnapshot: { agntcyRecordSize: 1024 },
  },
  ingestedAt: "2026-05-25T12:00:00.000Z",
  ingestionMethod: "oasf",
  upstreamId: "PCC CNC Capability",
  upstreamUrl: "https://capability.network/api/capabilities/cap-001",
  upstreamVendor: "Physical Capability Cloud",
  skills: ["manufacturing/cnc-3axis"],
  domains: ["manufacturing/cnc"],
  features: ["physical-capability/v1"],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  description: "5-axis CNC milling, ±0.05mm, Ra 1.6",
  actionClass: "exec",
  assuranceCeiling: DigitalCaptureClass.DCC4,
  trustTier: TrustTier.VERIFIED_PARTNER,
  knownVulns: [],
  lastFetchedAt: "2026-05-25T12:00:00.000Z",
  invocationCount: 0,
  driftAlerts: [],
  schemaHashHistory: [],
  hostingPeers: [],
};

describe("IndexedTool — OASF round-trip additions", () => {
  it("accepts the new optional locatorUrls / oasfModules / agntcyRecordCid fields", () => {
    const withOasf: IndexedTool = {
      ...baseValidTool,
      locatorUrls: [
        "https://capability.network/api/capabilities/cap-001",
        "https://capability.network/mcp",
      ],
      oasfModules: [
        {
          name: "physical-capability/v1",
          data: { capability_type: "cnc-5axis", materials: ["steel-1018"] },
        },
      ],
      agntcyRecordCid: "bafyExampleCid",
    };
    const result = IndexedToolSchema.safeParse(withOasf);
    if (!result.success) {
      // eslint-disable-next-line no-console
      console.error("validation errors:", result.error.errors);
    }
    expect(result.success).toBe(true);
  });

  it("remains backward-compatible — accepts records without OASF fields", () => {
    const result = IndexedToolSchema.safeParse(baseValidTool);
    expect(result.success).toBe(true);
  });

  it("rejects oasfModules with empty name", () => {
    const invalid: IndexedTool = {
      ...baseValidTool,
      oasfModules: [{ name: "", data: {} } as OasfModule],
    };
    const result = IndexedToolSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("accepts an empty oasfModules array", () => {
    const empty: IndexedTool = { ...baseValidTool, oasfModules: [] };
    expect(IndexedToolSchema.safeParse(empty).success).toBe(true);
  });
});
