import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPccFederationManifest, fetchPccCapabilities } from "./manifest.js";

const GATEWAY = "https://capability.network";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function rejectResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("fetchPccCapabilities", () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchImpl = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns summaries built from the public types list when no token is provided", async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({ types: ["3d-printing", "cnc", "hplc"] }));
    const out = await fetchPccCapabilities(GATEWAY, { fetchImpl });
    expect(out).toHaveLength(3);
    expect(out[0].type).toBe("3d-printing");
    expect(out[0].name).toBe("3d Printing");
    expect(out[0].pricing?.pricingModel).toBe("quote");
    // No bearer token means templates is not fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list when the gateway is unreachable (soft fail)", async () => {
    fetchImpl.mockRejectedValueOnce(new TypeError("ECONNREFUSED"));
    const out = await fetchPccCapabilities(GATEWAY, { fetchImpl });
    expect(out).toEqual([]);
  });

  it("returns an empty list when the gateway returns 500", async () => {
    fetchImpl.mockResolvedValueOnce(rejectResponse(500, {}));
    const out = await fetchPccCapabilities(GATEWAY, { fetchImpl });
    expect(out).toEqual([]);
  });

  it("merges template metadata when a bearer token is provided", async () => {
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ types: ["3d-printing"] }))
      .mockResolvedValueOnce(
        jsonResponse({
          templates: [
            {
              type: "3d-printing",
              name: "FDM 3D Printing",
              description: "Polymer extrusion",
              assuranceTiers: [0, 1, 2],
              currency: "USD",
              basePrice: "12.00",
              priceDescription: "Per part",
              tags: ["polymer", "fdm"],
              inputSchema: { type: "object", required: ["material"] },
            },
          ],
        }),
      );

    const out = await fetchPccCapabilities(GATEWAY, { fetchImpl, pccApiKey: "pcc_live_x" });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("FDM 3D Printing");
    expect(out[0].description).toBe("Polymer extrusion");
    expect(out[0].pricing?.baseCost).toBe("12.00");
    expect(out[0].tags).toEqual(["polymer", "fdm"]);
    expect(out[0].inputSchema).toMatchObject({ type: "object" });
    // Two calls: types + templates.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const tmplInit = fetchImpl.mock.calls[1][1] as RequestInit;
    expect((tmplInit.headers as Record<string, string>).Authorization).toBe("Bearer pcc_live_x");
  });

  it("survives template endpoint failure without dropping types", async () => {
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ types: ["cnc"] }))
      .mockResolvedValueOnce(rejectResponse(401, { error: "TOKEN_INVALID" }));

    const out = await fetchPccCapabilities(GATEWAY, { fetchImpl, pccApiKey: "bad" });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Cnc"); // humanized fallback
  });
});

describe("buildPccFederationManifest", () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchImpl = vi.fn();
  });

  it("builds a manifest with required fields and live services", async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({ types: ["3d-printing", "cnc"] }));
    const m = await buildPccFederationManifest({
      gatewayUrl: GATEWAY,
      instanceId: "pcc",
      name: "PCC",
      baseUrl: "https://capability.network/cypher/federation",
      contactEmail: "ops@capability.network",
      fetchImpl,
    });
    expect(m.instanceId).toBe("pcc");
    expect(m.name).toBe("PCC");
    expect(m.baseUrl).toBe("https://capability.network/cypher/federation");
    expect(m.contactEmail).toBe("ops@capability.network");
    expect(m.services).toHaveLength(2);
    expect(m.services?.[0].type).toBe("3d-printing");
    expect(m.description).toContain("Physical Capability Cloud");
  });

  it("respects skipServices and ships an empty service list", async () => {
    const m = await buildPccFederationManifest({
      gatewayUrl: GATEWAY,
      instanceId: "pcc",
      name: "PCC",
      baseUrl: "https://x",
      contactEmail: "x@x",
      skipServices: true,
      fetchImpl, // never called
    });
    expect(m.services).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects missing required fields", async () => {
    await expect(
      buildPccFederationManifest({
        gatewayUrl: "",
        instanceId: "pcc",
        name: "PCC",
        baseUrl: "x",
        contactEmail: "",
      }),
    ).rejects.toThrow(/gatewayUrl/);
  });
});
