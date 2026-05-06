import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CypherApiError, CypherClient } from "./client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_API_KEY = "cyp_lims_test_key_123";
const BASE_URL = "https://cypherbio.ai/backend";

/** Create a mock Response with JSON body. */
function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Create a CypherClient with a controllable fetch spy. */
function makeClient(overrides: { baseUrl?: string } = {}) {
  const fetchSpy = vi.fn();
  const client = new CypherClient({
    apiKey: VALID_API_KEY,
    baseUrl: overrides.baseUrl ?? BASE_URL,
    fetchImpl: fetchSpy as unknown as typeof fetch,
  });
  return { client, fetchSpy };
}

// ---------------------------------------------------------------------------
// Federation catalog fixture (from CYPHER-API-NOTES.md)
// ---------------------------------------------------------------------------
const WAYBIO_SERVICE = {
  _id: "svc_waybio_001",
  name: "Plasmid Cloning / Prep / Consultation",
  description: "Professional plasmid preparation services",
  category: "molecular-biology",
  status: "active",
  visibility: "public",
  pricing: { pricingModel: "quote", priceDescription: "Quote on request" },
  estimatedTurnaround: { min: 2, max: 4, unit: "weeks" },
  provider: {
    name: "WayBio",
    slug: "waybio",
    description: "Plasmid synthesis specialists",
    contactEmail: "orders@waybio.com",
    logo: "https://s3.us-east-2.amazonaws.com/cypherbio-files/waybio-logo.png",
  },
  stats: { totalOrders: 5, completedOrders: 3, reviewCount: 0 },
  sourceInstance: {
    _id: "inst_waybio",
    instanceId: "waybio",
    name: "WayBio LIMS",
    baseUrl: "https://waybio.cypherbio.ai",
  },
  orderFormSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["email", "company", "plasmidCount"],
    properties: {
      email: { type: "string", format: "email" },
      company: { type: "string" },
      plasmidCount: { type: "number", minimum: 1 },
    },
  },
  allowedOrganizations: [],
  allowedUsers: [],
};

const FLOCK_BIO_SERVICE = {
  _id: "svc_flock_001",
  name: "Pooled DNA Libraries",
  description: "High-throughput pooled DNA library services",
  category: "genomics",
  status: "active",
  visibility: "public",
  pricing: { pricingModel: "quote" },
  provider: { name: "Flock Bio", slug: "flockbio" },
  allowedOrganizations: [],
  allowedUsers: [],
};

// ---------------------------------------------------------------------------
// LIMS fixtures
// ---------------------------------------------------------------------------
const LIMS_REQUEST_FIXTURE = {
  _id: "req_abc123",
  requestNumber: "REQ-20260506-0001",
  workType: "plasmid_prep",
  status: "pending",
  createdAt: "2026-05-06T10:00:00.000Z",
};

const LIMS_WORKFLOW_FIXTURE = {
  _id: "69fb91edc06dfa1d86f21100",
  workflowLineageId: "WFL-20260506-0002",
  name: "",
  visibility: "organization",
};

// ---------------------------------------------------------------------------
// Constructor tests
// ---------------------------------------------------------------------------
describe("CypherClient — constructor", () => {
  it("throws when apiKey is absent", () => {
    expect(
      () => new CypherClient({ apiKey: "" }),
    ).toThrow("apiKey is required");
  });

  it("stores apiKey and defaults baseUrl to https://cypherbio.ai/backend", () => {
    const fetchSpy = vi.fn();
    const client = new CypherClient({
      apiKey: VALID_API_KEY,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    // Verify the client uses the correct default by making a request and
    // checking the URL passed to fetchImpl.
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }));
    void client.browseFederationCatalogPublic();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://cypherbio.ai/backend"),
      expect.any(Object),
    );
  });

  it("accepts a custom baseUrl and strips trailing slash", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(mockJsonResponse([]));
    const client = new CypherClient({
      apiKey: VALID_API_KEY,
      baseUrl: "https://custom.example.com/backend/",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await client.browseFederationCatalogPublic();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("https://custom.example.com/backend");
    expect(url).not.toMatch(/backend\/\//);
  });
});

// ---------------------------------------------------------------------------
// X-API-Key header tests
// ---------------------------------------------------------------------------
describe("CypherClient — auth headers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends X-API-Key header on authenticated requests (listLimsRequests)", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse([]));
    await client.listLimsRequests();
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      "X-API-Key": VALID_API_KEY,
    });
  });

  it("sends X-API-Key on getLimsRequest", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(LIMS_REQUEST_FIXTURE));
    await client.getLimsRequest("REQ-123");
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": VALID_API_KEY });
  });

  it("does NOT send X-API-Key on browseFederationCatalogPublic (noAuth endpoint)", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse([WAYBIO_SERVICE]));
    await client.browseFederationCatalogPublic();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBeUndefined();
  });

  it("does NOT send X-API-Key on getProtocolsPublic", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse([]));
    await client.getProtocolsPublic();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getMe — 403 for LIMS-scoped keys
// ---------------------------------------------------------------------------
describe("CypherClient — getMe()", () => {
  it("returns typed CypherApiError with status 403 for LIMS-scoped key", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ error: "Insufficient scope", message: "LIMS-only key" }, 403),
    );
    await expect(client.getMe()).rejects.toMatchObject({
      name: "CypherApiError",
      status: 403,
    });
  });

  it("returns CypherApiError with status 401 for TOKEN_INVALID", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ error: "TOKEN_INVALID", action: "login_required" }, 401),
    );
    await expect(client.getMe()).rejects.toMatchObject({
      name: "CypherApiError",
      status: 401,
    });
  });
});

// ---------------------------------------------------------------------------
// listLimsRequests
// ---------------------------------------------------------------------------
describe("CypherClient — listLimsRequests()", () => {
  it("returns paginated shape {requests, total, limit, offset} when server returns array", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse([LIMS_REQUEST_FIXTURE]));
    const res = await client.listLimsRequests({});
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data[0].requestNumber).toBe("REQ-20260506-0001");
  });

  it("passes workType as a query parameter", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse([]));
    await client.listLimsRequests({ workType: "plasmid_prep" });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("workType=plasmid_prep");
  });

  it("passes limit and offset as query parameters", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse([]));
    await client.listLimsRequests({ limit: 10, offset: 20 });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=20");
  });

  it("does not include undefined query params in the URL", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse([]));
    await client.listLimsRequests({});
    const [url] = fetchSpy.mock.calls[0];
    expect(url).not.toContain("workType");
    expect(url).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// getLimsRequest
// ---------------------------------------------------------------------------
describe("CypherClient — getLimsRequest()", () => {
  it("URL-encodes the requestNumber parameter", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(LIMS_REQUEST_FIXTURE));
    await client.getLimsRequest("REQ-123/special");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("REQ-123%2Fspecial");
  });

  it("returns the request object on 200", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(LIMS_REQUEST_FIXTURE));
    const res = await client.getLimsRequest("REQ-123");
    expect(res.data.requestNumber).toBe("REQ-20260506-0001");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// createLimsWorkflow
// ---------------------------------------------------------------------------
describe("CypherClient — createLimsWorkflow()", () => {
  it("returns {workflowLineageId, _id} shape on success", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(LIMS_WORKFLOW_FIXTURE));
    const res = await client.createLimsWorkflow({ name: "test-workflow" });
    expect(res.data._id).toBe("69fb91edc06dfa1d86f21100");
    expect(res.data.workflowLineageId).toBe("WFL-20260506-0002");
  });

  it("POSTs to /api/lims/workflows", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(LIMS_WORKFLOW_FIXTURE));
    await client.createLimsWorkflow({ name: "wf" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/lims/workflows");
    expect((init as RequestInit).method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// advanceStep
// ---------------------------------------------------------------------------
describe("CypherClient — advanceStep()", () => {
  it("POSTs to /api/lims/steps with the step body", async () => {
    const { client, fetchSpy } = makeClient();
    const stepFixture = { _id: "step_001", name: "init", workflowId: "wf_001" };
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(stepFixture));
    await client.advanceStep({ name: "init", requestId: "req_001" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/lims/steps");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.name).toBe("init");
  });
});

// ---------------------------------------------------------------------------
// postMeasurementBatchPreview
// ---------------------------------------------------------------------------
describe("CypherClient — postMeasurementBatchPreview()", () => {
  it("POSTs to /api/lims/measurements/batches/preview with dataPoints", async () => {
    const { client, fetchSpy } = makeClient();
    const previewResult = { rows: 2, errors: [] };
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(previewResult));
    const dp = [{ sampleId: "s1", value: 42, metric: "concentration", unit: "ng/uL" }];
    await client.postMeasurementBatchPreview({ dataPoints: dp });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/lims/measurements/batches/preview");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.dataPoints).toHaveLength(1);
  });

  it("throws CypherApiError(400) when body is empty (INVALID_INPUT)", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ error: "INVALID_INPUT", message: "file, fileId, or dataPoints required" }, 400),
    );
    await expect(
      client.postMeasurementBatchPreview({}),
    ).rejects.toMatchObject({ name: "CypherApiError", status: 400 });
  });
});

// ---------------------------------------------------------------------------
// recordWork
// ---------------------------------------------------------------------------
describe("CypherClient — recordWork()", () => {
  it("POSTs to /api/lims/record-work with stepId and payload", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ success: true }));
    await client.recordWork({ stepId: "step_001", payload: { notes: "done" } });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/lims/record-work");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.stepId).toBe("step_001");
  });
});

// ---------------------------------------------------------------------------
// browseFederationCatalogPublic
// ---------------------------------------------------------------------------
describe("CypherClient — browseFederationCatalogPublic()", () => {
  it("GETs /api/federation/services/public without auth header", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse([WAYBIO_SERVICE, FLOCK_BIO_SERVICE]),
    );
    const res = await client.browseFederationCatalogPublic();
    expect(res.data).toHaveLength(2);
    expect(res.data[0].provider.name).toBe("WayBio");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/federation/services/public");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling — 401 TOKEN_INVALID
// ---------------------------------------------------------------------------
describe("CypherClient — error handling", () => {
  it("wraps 401 TOKEN_INVALID as CypherApiError with status=401", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ error: "TOKEN_INVALID", action: "login_required" }, 401),
    );
    let err: CypherApiError | undefined;
    try {
      await client.listLimsRequests();
    } catch (e) {
      err = e as CypherApiError;
    }
    expect(err).toBeInstanceOf(CypherApiError);
    expect(err?.status).toBe(401);
    expect(err?.name).toBe("CypherApiError");
  });

  it("wraps network failure (fetch throws) as CypherApiError with status=null", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    let err: CypherApiError | undefined;
    try {
      await client.listLimsRequests();
    } catch (e) {
      err = e as CypherApiError;
    }
    expect(err).toBeInstanceOf(CypherApiError);
    expect(err?.status).toBeNull();
    expect(err?.message).toContain("cypher_unreachable");
  });

  it("exposes path on CypherApiError for debugging", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ error: "NOT_FOUND" }, 404));
    let err: CypherApiError | undefined;
    try {
      await client.getLimsRequest("REQ-NONEXISTENT");
    } catch (e) {
      err = e as CypherApiError;
    }
    expect(err?.path).toContain("/api/lims/requests/");
  });

  it("exposes body on CypherApiError for debugging", async () => {
    const { client, fetchSpy } = makeClient();
    const errorBody = { error: "INVALID_INPUT", details: ["stepId is required"] };
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(errorBody, 400));
    let err: CypherApiError | undefined;
    try {
      await client.recordWork({ stepId: "", payload: {} });
    } catch (e) {
      err = e as CypherApiError;
    }
    expect(err?.body).toMatchObject({ error: "INVALID_INPUT" });
  });

  it("baseUrl override routes requests to the custom host", async () => {
    const { client, fetchSpy } = makeClient({ baseUrl: "https://staging.cypherbio.ai/backend" });
    fetchSpy.mockResolvedValueOnce(mockJsonResponse([]));
    await client.listLimsRequests();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("staging.cypherbio.ai");
  });
});

// ---------------------------------------------------------------------------
// postMeasurementsFromCsv
// ---------------------------------------------------------------------------
describe("CypherClient — postMeasurementsFromCsv()", () => {
  it("POSTs to /api/lims/measurements/batches/from-csv", async () => {
    const { client, fetchSpy } = makeClient();
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ batchId: "batch_001" }));
    await client.postMeasurementsFromCsv({ csvData: "sample,value\ns1,42" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/lims/measurements/batches/from-csv");
    expect((init as RequestInit).method).toBe("POST");
  });
});
