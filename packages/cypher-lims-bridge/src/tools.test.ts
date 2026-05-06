import { describe, expect, it, vi } from "vitest";

import type { CypherClient } from "./client.js";
import {
  cypherAdvanceStep,
  cypherBrowseFederationCatalog,
  cypherGetLimsRequest,
  cypherListLimsRequests,
  cypherPostMeasurement,
  cypherRecordWork,
  cypherToolDefinitions,
  cypherToolHandlers,
} from "./tools.js";
import type { CypherFederationService, CypherLimsRequest, CypherLimsStep } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WAYBIO_SERVICE: CypherFederationService = {
  _id: "svc_waybio_001",
  name: "Plasmid Cloning / Prep / Consultation",
  description: "Professional plasmid preparation services",
  category: "molecular-biology",
  status: "active",
  visibility: "public",
  pricing: { pricingModel: "quote" },
  provider: { name: "WayBio", slug: "waybio" },
  allowedOrganizations: [],
  allowedUsers: [],
};

const LIMS_REQUEST: CypherLimsRequest = {
  _id: "req_001",
  requestNumber: "REQ-20260506-0001",
  workType: "plasmid_prep",
  status: "pending",
};

const LIMS_STEP: CypherLimsStep = {
  _id: "step_001",
  name: "init",
  workflowId: "wf_001",
};

/** Build a partial CypherClient stub with configurable responses. */
function makeClientStub(overrides: Partial<Record<keyof CypherClient, ReturnType<typeof vi.fn>>> = {}) {
  const defaults: Record<string, ReturnType<typeof vi.fn>> = {
    browseFederationCatalogPublic: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: [WAYBIO_SERVICE],
    }),
    listLimsRequests: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: [LIMS_REQUEST],
    }),
    getLimsRequest: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: LIMS_REQUEST,
    }),
    advanceStep: vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      data: LIMS_STEP,
    }),
    postMeasurementBatchPreview: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { rows: 1, errors: [] },
    }),
    postMeasurementsFromCsv: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { batchId: "batch_001" },
    }),
    recordWork: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { recorded: true },
    }),
  };
  return { ...defaults, ...overrides } as unknown as CypherClient;
}

// ---------------------------------------------------------------------------
// Structural tests — each tool has a valid MCP definition
// ---------------------------------------------------------------------------
describe("cypherToolDefinitions — structural checks", () => {
  it("exports exactly 6 tool definitions", () => {
    expect(cypherToolDefinitions).toHaveLength(6);
  });

  it.each([
    "cypher_browse_federation_catalog",
    "cypher_list_lims_requests",
    "cypher_get_lims_request",
    "cypher_advance_step",
    "cypher_post_measurement",
    "cypher_record_work",
  ])("definition '%s' has name, description, input_schema, endpoint", (toolName) => {
    const def = cypherToolDefinitions.find((d) => d.name === toolName);
    expect(def).toBeDefined();
    expect(typeof def?.description).toBe("string");
    expect(def?.input_schema).toBeDefined();
    expect(def?.endpoint).toBeDefined();
    expect(def?.endpoint.method).toMatch(/^(GET|POST|PATCH|DELETE)$/);
    expect(typeof def?.endpoint.path).toBe("string");
  });

  it("all definition names match the handler map keys", () => {
    const handlerKeys = Object.keys(cypherToolHandlers).sort();
    const defNames = cypherToolDefinitions.map((d) => d.name).sort();
    expect(handlerKeys).toEqual(defNames);
  });

  it("each handler has a .definition property", () => {
    for (const [, handler] of Object.entries(cypherToolHandlers)) {
      expect((handler as { definition?: unknown }).definition).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// cypherBrowseFederationCatalog
// ---------------------------------------------------------------------------
describe("cypherBrowseFederationCatalog", () => {
  it("returns {services} array from the public catalog endpoint", async () => {
    const client = makeClientStub();
    const result = await cypherBrowseFederationCatalog(client, {});
    expect(result.services).toHaveLength(1);
    expect(result.services[0].provider.name).toBe("WayBio");
  });

  it("calls browseFederationCatalogPublic on the client", async () => {
    const client = makeClientStub();
    await cypherBrowseFederationCatalog(client, {});
    expect((client.browseFederationCatalogPublic as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("definition.endpoint.method is GET", () => {
    expect(cypherBrowseFederationCatalog.definition.endpoint.method).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// cypherListLimsRequests
// ---------------------------------------------------------------------------
describe("cypherListLimsRequests", () => {
  it("forwards args to client.listLimsRequests", async () => {
    const client = makeClientStub();
    await cypherListLimsRequests(client, { workType: "plasmid_prep", limit: 10, offset: 0 });
    expect(
      (client.listLimsRequests as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(expect.objectContaining({ workType: "plasmid_prep", limit: 10 }));
  });

  it("returns the raw CypherApiResponse shape", async () => {
    const client = makeClientStub();
    const res = await cypherListLimsRequests(client, {});
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("definition.input_schema has workType property", () => {
    const schema = cypherListLimsRequests.definition.input_schema;
    expect(schema.properties?.workType).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// cypherGetLimsRequest
// ---------------------------------------------------------------------------
describe("cypherGetLimsRequest", () => {
  it("calls getLimsRequest with the requestNumber arg", async () => {
    const client = makeClientStub();
    await cypherGetLimsRequest(client, { requestNumber: "REQ-001" });
    expect(
      (client.getLimsRequest as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith("REQ-001");
  });

  it("definition requires 'requestNumber'", () => {
    expect(cypherGetLimsRequest.definition.input_schema.required).toContain("requestNumber");
  });
});

// ---------------------------------------------------------------------------
// cypherPostMeasurement — routing
// ---------------------------------------------------------------------------
describe("cypherPostMeasurement", () => {
  it("routes to preview endpoint when dataPoints supplied", async () => {
    const client = makeClientStub();
    const result = await cypherPostMeasurement(client, {
      dataPoints: [{ sampleId: "s1", value: 42, metric: "concentration", unit: "ng/uL" }],
    });
    expect(result.routedTo).toBe("preview");
    expect(
      (client.postMeasurementBatchPreview as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledTimes(1);
    expect(
      (client.postMeasurementsFromCsv as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("routes to from-csv endpoint when csvData supplied", async () => {
    const client = makeClientStub();
    const result = await cypherPostMeasurement(client, {
      csvData: "sample,value\ns1,42",
    });
    expect(result.routedTo).toBe("from-csv");
    expect(
      (client.postMeasurementsFromCsv as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledTimes(1);
    expect(
      (client.postMeasurementBatchPreview as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("routes to from-csv endpoint when fileId supplied", async () => {
    const client = makeClientStub();
    const result = await cypherPostMeasurement(client, {
      fileId: "file_abc123",
    });
    expect(result.routedTo).toBe("from-csv");
  });

  it("throws a validation error when no dataPoints, csvData, or fileId supplied", async () => {
    const client = makeClientStub();
    await expect(
      cypherPostMeasurement(client, {}),
    ).rejects.toThrow(/must supply at least one/);
  });

  it("result.ok is true on success", async () => {
    const client = makeClientStub();
    const result = await cypherPostMeasurement(client, {
      dataPoints: [{ value: 1 }],
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cypherRecordWork
// ---------------------------------------------------------------------------
describe("cypherRecordWork", () => {
  it("calls client.recordWork with stepId and payload", async () => {
    const client = makeClientStub();
    await cypherRecordWork(client, { stepId: "step_001", payload: { notes: "done" } });
    expect(
      (client.recordWork as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: "step_001", payload: { notes: "done" } }),
    );
  });

  it("definition requires 'stepId' and 'payload'", () => {
    const required = cypherRecordWork.definition.input_schema.required ?? [];
    expect(required).toContain("stepId");
    expect(required).toContain("payload");
  });

  it("definition.endpoint.method is POST", () => {
    expect(cypherRecordWork.definition.endpoint.method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// cypherAdvanceStep
// ---------------------------------------------------------------------------
describe("cypherAdvanceStep", () => {
  it("calls client.advanceStep with the supplied args", async () => {
    const client = makeClientStub();
    await cypherAdvanceStep(client, { name: "init", requestId: "req_001" });
    expect(
      (client.advanceStep as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(
      expect.objectContaining({ name: "init", requestId: "req_001" }),
    );
  });

  it("definition requires 'name'", () => {
    expect(cypherAdvanceStep.definition.input_schema.required).toContain("name");
  });
});
