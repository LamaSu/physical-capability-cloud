import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FederationApiError,
  FederationAuthError,
  FederationPeer,
} from "./peer.js";
import type { CypherFederationService, FederationManifest } from "./types.js";

const BASE = "https://cypherbio.ai/backend";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 500): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

describe("FederationPeer constructor", () => {
  it("requires apiKey", () => {
    expect(() => new FederationPeer({ apiKey: "" })).toThrow(/apiKey is required/);
  });

  it("accepts custom baseUrl and strips trailing slash", () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ registered: true }));
    const peer = new FederationPeer({ apiKey: "k", baseUrl: "https://x.example/api/", fetchImpl });
    return peer.status().then(() => {
      const url = fetchImpl.mock.calls[0][0] as string;
      expect(url).toBe("https://x.example/api/api/federation/status");
    });
  });
});

describe("FederationPeer.register", () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchImpl = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the manifest with X-API-Key and returns credentials", async () => {
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({
        credentials: {
          apiKey: "fed_secret_xyz",
          secret: "hmac-secret",
          instanceId: "pcc",
          expiresAt: null,
        },
        instance: { _id: "abc", instanceId: "pcc", name: "PCC", baseUrl: "https://capability.network/cypher/federation" },
      }),
    );

    const peer = new FederationPeer({ apiKey: "cyp_admin_test", fetchImpl });
    const manifest: FederationManifest = {
      instanceId: "pcc",
      name: "PCC",
      baseUrl: "https://capability.network/cypher/federation",
      contactEmail: "ops@example.com",
    };
    const creds = await peer.register(manifest);

    expect(creds.apiKey).toBe("fed_secret_xyz");
    expect(creds.instanceId).toBe("pcc");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/federation/instances/register`);
    const initObj = init as RequestInit;
    expect(initObj.method).toBe("POST");
    expect((initObj.headers as Record<string, string>)["X-API-Key"]).toBe("cyp_admin_test");
    expect((initObj.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(initObj.body as string);
    expect(body.instanceId).toBe("pcc");
    expect(body.contactEmail).toBe("ops@example.com");
  });

  it("throws FederationAuthError on 403 (LIMS-scoped key)", async () => {
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ error: "Insufficient scope", message: "federation requires admin scope" }, 403),
    );

    const peer = new FederationPeer({ apiKey: "cyp_lims_test", fetchImpl });
    const manifest: FederationManifest = {
      instanceId: "pcc",
      name: "PCC",
      baseUrl: "https://x",
      contactEmail: "ops@example.com",
    };

    await expect(peer.register(manifest)).rejects.toBeInstanceOf(FederationAuthError);
    try {
      await peer.register(manifest);
    } catch (e) {
      expect(e).toBeInstanceOf(FederationAuthError);
      expect((e as FederationAuthError).status).toBe(403);
      expect((e as FederationAuthError).message).toContain("federation requires admin scope");
    }
  });

  it("throws FederationAuthError on 401", async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({ error: "TOKEN_INVALID" }, 401));
    const peer = new FederationPeer({ apiKey: "k", fetchImpl });
    await expect(
      peer.register({ instanceId: "x", name: "x", baseUrl: "x", contactEmail: "x@x" }),
    ).rejects.toBeInstanceOf(FederationAuthError);
  });

  it("throws FederationApiError on 500 with non-JSON body", async () => {
    fetchImpl.mockResolvedValueOnce(textResponse("internal server error", 500));
    const peer = new FederationPeer({ apiKey: "k", fetchImpl });
    await expect(
      peer.register({ instanceId: "x", name: "x", baseUrl: "x", contactEmail: "x@x" }),
    ).rejects.toMatchObject({ name: "FederationApiError", status: 500 });
  });

  it("throws FederationApiError when fetch itself rejects (network error)", async () => {
    fetchImpl.mockRejectedValueOnce(new TypeError("ECONNREFUSED"));
    const peer = new FederationPeer({ apiKey: "k", fetchImpl });
    await expect(
      peer.register({ instanceId: "x", name: "x", baseUrl: "x", contactEmail: "x@x" }),
    ).rejects.toMatchObject({ name: "FederationApiError", status: null });
  });
});

describe("FederationPeer.disconnect / status", () => {
  it("disconnect POSTs instanceId and resolves on 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const peer = new FederationPeer({ apiKey: "k", fetchImpl });
    await peer.disconnect("pcc");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/federation/disconnect`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ instanceId: "pcc" });
  });

  it("status GETs and returns parsed body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ registered: true, lastSyncAt: "2026-05-06T00:00:00Z", openOrders: 2 }),
    );
    const peer = new FederationPeer({ apiKey: "k", fetchImpl });
    const out = await peer.status();
    expect(out.registered).toBe(true);
    expect(out.openOrders).toBe(2);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});

describe("FederationPeer.browseServices / publish / unpublish", () => {
  const sampleService: CypherFederationService = {
    _id: "srv_pcc_1",
    name: "FDM 3D printing",
    pricing: { basePrice: 0, currency: "USD", pricingModel: "quote" },
    provider: { name: "PCC", slug: "pcc" },
    sourceInstance: { instanceId: "pcc", name: "PCC", baseUrl: "https://capability.network/cypher/federation" },
    sourceServiceId: "cap-fdm-1",
  };

  it("browseServices unwraps {services} envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({ services: [sampleService] }),
    );
    const peer = new FederationPeer({ apiKey: "k", fetchImpl });
    const out = await peer.browseServices();
    expect(out).toHaveLength(1);
    expect(out[0]._id).toBe("srv_pcc_1");
  });

  it("browseServices accepts a bare array body too", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse([sampleService]));
    const peer = new FederationPeer({ apiKey: "k", fetchImpl });
    const out = await peer.browseServices();
    expect(out).toHaveLength(1);
  });

  it("publishService POSTs the service body", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true }));
    const peer = new FederationPeer({ apiKey: "k", fetchImpl });
    await peer.publishService(sampleService);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/federation/services`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)._id).toBe("srv_pcc_1");
  });

  it("unpublishService URL-encodes the service id", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true }));
    const peer = new FederationPeer({ apiKey: "k", fetchImpl });
    await peer.unpublishService("srv id with space");
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/federation/services/srv%20id%20with%20space/publish`);
  });

  it("unpublishService rejects empty serviceId", async () => {
    const fetchImpl = vi.fn();
    const peer = new FederationPeer({ apiKey: "k", fetchImpl });
    await expect(peer.unpublishService("")).rejects.toThrow(/serviceId is required/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("FederationPeer error path detail extraction", () => {
  it("uses message field over generic statusText", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({ message: "instance already registered" }, 409),
    );
    const peer = new FederationPeer({ apiKey: "k", fetchImpl });
    try {
      await peer.disconnect("pcc");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FederationApiError);
      expect((e as FederationApiError).message).toContain("instance already registered");
      expect((e as FederationApiError).status).toBe(409);
    }
  });
});
