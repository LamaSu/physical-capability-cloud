import { describe, it, expect } from "vitest";
import {
  liftLightweightTool,
  liftLightweightTools,
} from "../lift-to-spec.js";
import { TrustTier, DigitalCaptureClass } from "@pcc/spec";
import type { IndexedTool as LightweightIndexedTool } from "../../types.js";

const NOW = "2026-05-23T00:00:00.000Z";

function lt(overrides: Partial<LightweightIndexedTool> = {}): LightweightIndexedTool {
  return {
    id: "pcc:test_tool",
    source: "pcc-mcp",
    name: "test_tool",
    description: "test tool",
    schema: {},
    ...overrides,
  };
}

describe("liftLightweightTool", () => {
  it("maps required fields with PCC_NATIVE defaults", () => {
    const out = liftLightweightTool(lt(), NOW);
    expect(out.id).toBe("pcc:test_tool");
    expect(out.trustTier).toBe(TrustTier.PCC_NATIVE);
    expect(out.assuranceCeiling).toBe(DigitalCaptureClass.DCC5);
    expect(out.source.type).toBe("pcc-native");
    expect(out.invocationCount).toBe(0);
    expect(out.driftAlerts).toEqual([]);
    expect(out.knownVulns).toEqual([]);
  });

  it("infers actionClass from HTTP method (GET → read)", () => {
    expect(
      liftLightweightTool(
        lt({ endpoint: { method: "GET", path: "/api/x" } }),
        NOW,
      ).actionClass,
    ).toBe("read");
    expect(
      liftLightweightTool(
        lt({ endpoint: { method: "POST", path: "/api/x" } }),
        NOW,
      ).actionClass,
    ).toBe("write");
    expect(
      liftLightweightTool(
        lt({ endpoint: { method: "DELETE", path: "/api/x" } }),
        NOW,
      ).actionClass,
    ).toBe("write");
  });

  it("populates skills from capabilities + domains from tags", () => {
    const out = liftLightweightTool(
      lt({
        capabilities: ["nlp.summarization", "data.transform"],
        tags: ["fast", "free"],
      }),
      NOW,
    );
    expect(out.skills).toEqual(["nlp.summarization", "data.transform"]);
    expect(out.domains).toEqual(["fast", "free"]);
  });

  it("constructs upstreamUrl from endpoint when present", () => {
    const out = liftLightweightTool(
      lt({ endpoint: { method: "GET", path: "/api/jobs/123" } }),
      NOW,
    );
    expect(out.upstreamUrl).toBe("https://capability.network/api/jobs/123");
  });
});

describe("liftLightweightTools", () => {
  it("bulk-lifts an array with one timestamp", () => {
    const out = liftLightweightTools(
      [lt({ id: "a" }), lt({ id: "b" })],
      NOW,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.lastFetchedAt).toBe(NOW);
    expect(out[1]?.lastFetchedAt).toBe(NOW);
  });
});
