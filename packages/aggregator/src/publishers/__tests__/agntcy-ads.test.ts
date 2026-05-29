import { describe, it, expect, vi } from "vitest";
import {
  DigitalCaptureClass,
  TrustTier,
  type IndexedTool,
} from "@pcc/spec";
import {
  AgntcyAdsPublisher,
  buildLocators,
  buildPccModules,
  indexedToolToOasf,
  makeAgntcyAdsPublisher,
} from "../agntcy-ads.js";
import type { CosignSpawn } from "../../types.js";

// ── Test fixture (PCC-side IndexedTool) ──────────────────────────────────

function makeTool(overrides: Partial<IndexedTool> = {}): IndexedTool {
  return {
    id: "pcc-native:cap-cnc-5axis-001",
    cid: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    version: "2.0.0",
    source: {
      type: "pcc-native",
      url: "https://capability.network/api/capabilities/cap-cnc-5axis-001",
      fetchedAt: "2026-05-25T12:00:00.000Z",
    },
    ingestedAt: "2026-05-25T12:00:00.000Z",
    ingestionMethod: "manual",
    upstreamId: "PCC CNC 5-Axis",
    upstreamUrl: "https://capability.network/api/capabilities/cap-cnc-5axis-001",
    upstreamVendor: "PrintShop Alpha <ops@printshop.example>",
    skills: ["manufacturing/cnc-5axis"],
    domains: ["manufacturing/cnc"],
    features: [],
    inputSchema: { type: "object", properties: { gcode: { type: "string" } } },
    outputSchema: { type: "object" },
    description: "5-axis CNC milling, ±0.05mm, Ra 1.6",
    actionClass: "exec",
    assuranceCeiling: DigitalCaptureClass.DCC5,
    trustTier: TrustTier.PCC_NATIVE,
    knownVulns: [],
    lastFetchedAt: "2026-05-25T12:00:00.000Z",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [],
    hostingPeers: [],
    ...overrides,
  };
}

// ── IndexedTool → OASF projection ────────────────────────────────────────

describe("indexedToolToOasf", () => {
  it("projects every required OASF field", () => {
    const rec = indexedToolToOasf(makeTool());
    expect(rec.schema_version).toBe("1.0.0");
    expect(rec.name).toBe("PCC CNC 5-Axis");
    expect(rec.skills).toEqual([
      { name: "manufacturing/cnc-5axis", id: 9102 },
    ]);
    expect(rec.domains).toEqual([{ name: "manufacturing/cnc", id: 9011 }]);
    expect(rec.authors).toEqual([
      "PrintShop Alpha <ops@printshop.example>",
    ]);
    expect(rec.modules.some((m) => m.name === "physical-capability/v1")).toBe(
      true,
    );
    expect(rec.modules.some((m) => m.name === "tool-schema/v1")).toBe(true);
    expect(rec.locators.length).toBeGreaterThan(0);
  });

  it("falls back to default IDs for unknown skills/domains", () => {
    const rec = indexedToolToOasf(
      makeTool({
        skills: ["unknown/skill-here"],
        domains: ["unknown/domain-here"],
      }),
    );
    expect(rec.skills[0].id).toBe(1001);
    expect(rec.domains[0].id).toBe(1500);
  });

  it("falls back to PCC default author when upstreamVendor missing", () => {
    const rec = indexedToolToOasf(makeTool({ upstreamVendor: undefined }));
    expect(rec.authors[0]).toContain("Physical Capability Cloud");
  });
});

describe("buildPccModules", () => {
  it("always emits tool-schema/v1 and physical-capability/v1", () => {
    const mods = buildPccModules(makeTool(), {});
    expect(mods.map((m) => m.name)).toContain("tool-schema/v1");
    expect(mods.map((m) => m.name)).toContain("physical-capability/v1");
  });

  it("populates pcc_facets with action_class, trust_tier, dcc_max", () => {
    const mods = buildPccModules(makeTool(), {});
    const pc = mods.find((m) => m.name === "physical-capability/v1")!;
    const facets = pc.data.pcc_facets as Record<string, unknown>;
    expect(facets.action_class).toBe("exec");
    expect(facets.trust_tier).toBe("PCC_NATIVE");
    expect(facets.dcc_max).toBe("DCC5");
  });

  it("preserves incoming oasfModules but deduplicates own slots", () => {
    const tool = makeTool({
      oasfModules: [
        { name: "physical-capability/v1", data: { stale: true } },
        { name: "custom/module-x", data: { keep: true } },
      ],
    });
    const mods = buildPccModules(tool, {});
    const slots = mods.map((m) => m.name);
    expect(slots).toContain("custom/module-x");
    // Should have exactly one physical-capability/v1 (the freshly-built one)
    const pcSlots = slots.filter((s) => s === "physical-capability/v1");
    expect(pcSlots).toHaveLength(1);
    const pc = mods.find((m) => m.name === "physical-capability/v1")!;
    // The fresh module wins — `stale` key from preserved version is gone.
    expect((pc.data as Record<string, unknown>).stale).toBeUndefined();
  });
});

describe("buildLocators", () => {
  it("groups URLs by inferred locator type", () => {
    const tool = makeTool({
      upstreamUrl: "https://capability.network/api/x",
      locatorUrls: [
        "https://github.com/lamasu/pcc",
        "https://capability.network/mcp",
      ],
    });
    const locators = buildLocators(tool);
    const types = locators.map((l) => l.type);
    expect(types).toContain("rest_endpoint");
    expect(types).toContain("source_code");
    expect(types).toContain("mcp_server");
  });

  it("emits a fallback locator when none provided", () => {
    const tool = makeTool({
      upstreamUrl: "",
      locatorUrls: [],
    });
    const locators = buildLocators(tool);
    expect(locators).toHaveLength(1);
    expect(locators[0].type).toBe("rest_endpoint");
  });
});

// ── Publisher.publish error paths ────────────────────────────────────────

describe("AgntcyAdsPublisher.publish", () => {
  it("returns an error result without authToken (does not call fetch)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 200 }));
    const pub = new AgntcyAdsPublisher({});
    const result = await pub.publish(makeTool(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.externalCid).toBe("");
    expect(result.errors[0]).toMatch(/authToken/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns error on push failure (non-2xx)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("err", { status: 500, statusText: "Server Error" }),
    );
    const pub = new AgntcyAdsPublisher({});
    const result = await pub.publish(makeTool(), {
      authToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.externalCid).toBe("");
    expect(result.errors[0]).toMatch(/push: 500/);
  });

  it("returns success when push + announce + sigstore all succeed", async () => {
    let pushed = false;
    let announced = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/records")) {
        pushed = true;
        return new Response(JSON.stringify({ cid: "bafyTestRecord" }), {
          status: 201,
        });
      }
      if (url.endsWith("/v1/routing/publish")) {
        announced = true;
        return new Response("ok", { status: 200 });
      }
      return new Response("404", { status: 404 });
    });
    const cosignSpawn: CosignSpawn = vi.fn(async () => "fake-sigstore-bundle");
    const pub = makeAgntcyAdsPublisher();
    const result = await pub.publish(makeTool(), {
      authToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cosignSpawn,
    });
    expect(pushed).toBe(true);
    expect(announced).toBe(true);
    expect(result.externalCid).toBe("bafyTestRecord");
    expect(result.announced).toBe(true);
    expect(result.sigstoreBundle).toBe("fake-sigstore-bundle");
    expect(result.errors).toEqual([]);
    expect(cosignSpawn).toHaveBeenCalledOnce();
  });

  it("records non-fatal sigstore error in errors[] but still returns CID", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/records"))
        return new Response(JSON.stringify({ cid: "bafyOk" }), { status: 201 });
      return new Response("ok", { status: 200 });
    });
    const cosignSpawn: CosignSpawn = vi.fn(async () => {
      throw new Error("cosign not installed");
    });
    const pub = new AgntcyAdsPublisher();
    const result = await pub.publish(makeTool(), {
      authToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cosignSpawn,
    });
    expect(result.externalCid).toBe("bafyOk");
    expect(result.errors.some((e) => e.startsWith("sigstore:"))).toBe(true);
  });

  it("skips DHT announce when announce=false", async () => {
    let announceCount = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/records"))
        return new Response(JSON.stringify({ cid: "bafyOk" }), { status: 201 });
      if (url.endsWith("/v1/routing/publish")) {
        announceCount++;
        return new Response("ok", { status: 200 });
      }
      return new Response("404", { status: 404 });
    });
    const pub = new AgntcyAdsPublisher();
    const result = await pub.publish(makeTool(), {
      authToken: "t",
      announce: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(announceCount).toBe(0);
    expect(result.announced).toBe(false);
    expect(result.externalCid).toBe("bafyOk");
  });
});
