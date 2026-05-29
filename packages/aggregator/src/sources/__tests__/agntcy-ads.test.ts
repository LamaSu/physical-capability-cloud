import { describe, it, expect, vi } from "vitest";
import { DigitalCaptureClass, TrustTier } from "@pcc/spec";
import {
  AgntcyAdsSourceAdapter,
  inferActionClassFromSkills,
  makeAgntcyAdsSourceAdapter,
  oasfToIndexedTool,
  type OasfRecord,
} from "../agntcy-ads.js";
import pccCncCap from "../../__tests__/fixtures/agntcy-pcc-cnc-cap.json" with { type: "json" };
import genericSummarizer from "../../__tests__/fixtures/agntcy-generic-summarizer.json" with { type: "json" };

const ENDPOINT = "https://prod.api.ads.outshift.io";

// ── Construction guards ──────────────────────────────────────────────────

describe("AgntcyAdsSourceAdapter constructor", () => {
  it("requires a skill (AGNTCY spec G6)", () => {
    expect(() => new AgntcyAdsSourceAdapter({ skill: "" })).toThrow(/skill/);
    // @ts-expect-error — exercise the runtime guard
    expect(() => new AgntcyAdsSourceAdapter({})).toThrow(/skill/);
  });

  it("accepts a valid skill", () => {
    const a = new AgntcyAdsSourceAdapter({ skill: "manufacturing/cnc-5axis" });
    expect(a.id).toBe("agntcy-ads");
    expect(a.sourceType).toBe("agntcy-dht");
  });
});

// ── REST fetch wiring ─────────────────────────────────────────────────────

describe("AgntcyAdsSourceAdapter.fetch", () => {
  it("posts to /v1/search with the skill filter and projects results", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return new Response(
        JSON.stringify({
          records: [pccCncCap],
          cids: ["bafyPccCnc001"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const adapter = makeAgntcyAdsSourceAdapter({
      skill: "manufacturing/cnc-5axis",
      domains: ["manufacturing/cnc"],
    });
    const tools = await adapter.fetch({
      url: ENDPOINT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Wire correctness.
    expect(captured.url).toBe(`${ENDPOINT}/v1/search`);
    expect(captured.init?.method).toBe("POST");
    const body = JSON.parse(captured.init?.body as string);
    expect(body.skill).toBe("manufacturing/cnc-5axis");
    expect(body.domains).toEqual(["manufacturing/cnc"]);
    expect(body.limit).toBe(50);

    // Projection correctness.
    expect(tools).toHaveLength(1);
    const t = tools[0];
    expect(t.id).toBe("agntcy:bafyPccCnc001");
    expect(t.agntcyRecordCid).toBe("bafyPccCnc001");
    expect(t.skills).toEqual(["manufacturing/cnc-5axis"]);
    expect(t.domains).toEqual(["manufacturing/cnc"]);
    expect(t.features).toContain("physical-capability/v1");
    // Round-trip detection.
    expect(t.trustTier).toBe(TrustTier.PCC_NATIVE);
    expect(t.assuranceCeiling).toBe(DigitalCaptureClass.DCC5);
    // OASF round-trip fields preserved.
    expect(t.oasfModules?.length).toBeGreaterThan(0);
    expect(t.locatorUrls?.length).toBeGreaterThan(0);
  });

  it("falls back to VERIFIED_PARTNER / DCC4 for non-PCC records", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            records: [genericSummarizer],
            cids: ["bafySummarizer"],
          }),
          { status: 200 },
        ),
    );
    const adapter = makeAgntcyAdsSourceAdapter({
      skill: "natural_language_processing/summarization",
    });
    const tools = await adapter.fetch({
      url: ENDPOINT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].trustTier).toBe(TrustTier.VERIFIED_PARTNER);
    expect(tools[0].assuranceCeiling).toBe(DigitalCaptureClass.DCC4);
  });

  it("throws on non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 500, statusText: "Server Error" }),
    );
    const adapter = makeAgntcyAdsSourceAdapter({ skill: "any" });
    await expect(
      adapter.fetch({
        url: ENDPOINT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/AGNTCY ADS search 500/);
  });

  it("attaches Authorization header when authToken provided", async () => {
    const captured: { init?: RequestInit } = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      captured.init = init;
      return new Response(JSON.stringify({ records: [], cids: [] }), {
        status: 200,
      });
    });
    const adapter = makeAgntcyAdsSourceAdapter({
      skill: "x",
      authToken: "test-token-123",
    });
    await adapter.fetch({
      url: ENDPOINT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token-123");
  });

  it("rejects unsafe internal URLs via SSRF guard", async () => {
    const adapter = makeAgntcyAdsSourceAdapter({ skill: "x" });
    // 192.168.0.0/16 is RFC-1918 private — guard must reject regardless of allowLocalhostHttp.
    await expect(
      adapter.fetch({ url: "http://192.168.1.1:8080" }),
    ).rejects.toThrow();
  });
});

// ── Pure projection ───────────────────────────────────────────────────────

describe("oasfToIndexedTool", () => {
  it("preserves all OASF round-trip fields", () => {
    const t = oasfToIndexedTool(
      pccCncCap as unknown as OasfRecord,
      "bafyPccCnc001",
      ENDPOINT,
      "2026-05-25T00:00:00.000Z",
    );
    expect(t.agntcyRecordCid).toBe("bafyPccCnc001");
    expect(t.oasfModules).toEqual((pccCncCap as { modules: unknown[] }).modules);
    expect(t.locatorUrls).toEqual([
      "https://capability.network/api/capabilities/cap-cnc-001",
      "https://capability.network/mcp",
    ]);
  });

  it("falls back to endpoint when no locators present", () => {
    const noLocators: OasfRecord = {
      ...(genericSummarizer as unknown as OasfRecord),
      locators: [],
    };
    const t = oasfToIndexedTool(
      noLocators,
      "bafyEmpty",
      "https://anchor.test",
      "2026-05-25T00:00:00.000Z",
    );
    expect(t.upstreamUrl).toBe("https://anchor.test");
  });

  it("clamps description to 280 chars", () => {
    const long: OasfRecord = {
      ...(genericSummarizer as unknown as OasfRecord),
      description: "x".repeat(500),
    };
    const t = oasfToIndexedTool(long, "bafyX", "https://x", "2026-05-25T00:00:00.000Z");
    expect(t.description.length).toBeLessThanOrEqual(280 + 1); // ± "…"
  });

  it("falls back to (no description) for empty descriptions", () => {
    const empty: OasfRecord = {
      ...(genericSummarizer as unknown as OasfRecord),
      description: "",
    };
    const t = oasfToIndexedTool(empty, "bafyE", "https://x", "2026-05-25T00:00:00.000Z");
    expect(t.description).toBe("(no description)");
  });
});

// ── Action class inference ────────────────────────────────────────────────

describe("inferActionClassFromSkills", () => {
  it("returns 'credential' for credential keywords", () => {
    expect(inferActionClassFromSkills([{ name: "auth/secret_storage" }])).toBe(
      "credential",
    );
    expect(
      inferActionClassFromSkills([{ name: "identity/credential_issuance" }]),
    ).toBe("credential");
  });

  it("returns 'write' for mutating verbs", () => {
    expect(inferActionClassFromSkills([{ name: "data/create_record" }])).toBe("write");
    expect(inferActionClassFromSkills([{ name: "data/delete_record" }])).toBe("write");
  });

  it("returns 'exec' for invocation verbs", () => {
    expect(
      inferActionClassFromSkills([{ name: "agent_orchestration/task_execute" }]),
    ).toBe("exec");
  });

  it("returns 'network' for transport verbs", () => {
    expect(inferActionClassFromSkills([{ name: "transport/http_fetch" }])).toBe(
      "network",
    );
  });

  it("defaults to 'read'", () => {
    expect(inferActionClassFromSkills([{ name: "nlp/summarization" }])).toBe("read");
    expect(inferActionClassFromSkills([])).toBe("read");
  });
});
