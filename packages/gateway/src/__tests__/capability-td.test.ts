/**
 * Tests for GET /api/capabilities/:id/td
 *
 * Verifies the W3C WoT Thing Description endpoint:
 *   - Returns 200 with valid TD shape for known capability
 *   - 404 for unknown capability
 *   - Correct JSON-LD @context (WoT 1.1)
 *   - Required TD top-level fields present
 *   - actions.execute.input derived from CapabilityTemplate params
 *   - properties (queueDepth/available/reputation) are read-only
 *   - events.jobStatusChanged links to SSE
 *   - security uses apiKey scheme
 *   - PCC extension fields (pcc:capabilityType, pcc:kernelId, pcc:pricing)
 *   - CORS wildcard + 5min cache
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { capabilityRoutes } from "../routes/capabilities.js";
import { initStore, closeStore } from "../db.js";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_GATEWAY_URL = "https://test.capability.network";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(capabilityRoutes);
  await app.ready();
  return app;
}

async function getFirstCapabilityId(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: "GET", url: "/api/capabilities" });
  const body = res.json();
  const items = body.items ?? body.capabilities ?? [];
  if (items.length === 0) throw new Error("No seeded capabilities found");
  return items[0].id as string;
}

// Lightweight TD validator — checks the small set of fields the WoT TD 1.1
// JSON Schema requires. We can't pull the full schema into a unit test, so
// we assert the structural invariants that matter for downstream agents.
function assertTdRequiredFields(td: Record<string, unknown>): void {
  expect(td["@context"]).toBeDefined();
  expect(Array.isArray(td["@context"])).toBe(true);
  expect(td["@type"]).toBe("Thing");
  expect(typeof td.id).toBe("string");
  expect(typeof td.title).toBe("string");
  expect(td.securityDefinitions).toBeDefined();
  expect(td.security).toBeDefined();
}

describe("GET /api/capabilities/:id/td", () => {
  let app: FastifyInstance;
  let capId: string;

  beforeAll(async () => {
    app = await buildApp();
    capId = await getFirstCapabilityId(app);
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("returns 404 for unknown capability", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities/cap-NONE-xyz/td",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 200 for known capability", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns application/td+json content-type", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    expect(res.headers["content-type"]).toContain("application/td+json");
  });

  it("declares WoT 1.1 JSON-LD context", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    const td = res.json();
    assertTdRequiredFields(td);
    expect(td["@context"][0]).toBe("https://www.w3.org/2022/wot/td/v1.1");
  });

  it("Thing id uses urn:pcc:capability:<id> scheme", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    const td = res.json();
    expect(td.id).toBe(`urn:pcc:capability:${capId}`);
  });

  it("declares an 'execute' action with input + output schemas", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    const td = res.json();
    expect(td.actions).toBeDefined();
    expect(td.actions.execute).toBeDefined();
    expect(td.actions.execute.input).toBeDefined();
    expect(td.actions.execute.input.type).toBe("object");
    expect(td.actions.execute.output).toBeDefined();
    expect(td.actions.execute.output.required).toContain("jobId");
  });

  it("execute action 'forms' POSTs to /api/jobs/submit", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    const td = res.json();
    const form = td.actions.execute.forms[0];
    expect(form.href).toContain("/api/jobs/submit");
    expect(form["htv:methodName"]).toBe("POST");
  });

  it("declares queueDepth / available / reputation as read-only properties", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    const td = res.json();
    expect(td.properties.queueDepth).toBeDefined();
    expect(td.properties.queueDepth.readOnly).toBe(true);
    expect(td.properties.available).toBeDefined();
    expect(td.properties.available.readOnly).toBe(true);
    expect(td.properties.reputation).toBeDefined();
    expect(td.properties.reputation.readOnly).toBe(true);
  });

  it("declares jobStatusChanged event subscribable via SSE", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    const td = res.json();
    expect(td.events).toBeDefined();
    expect(td.events.jobStatusChanged).toBeDefined();
    const form = td.events.jobStatusChanged.forms[0];
    expect(form.subprotocol).toBe("sse");
    expect(form.href).toContain("/sse/stream/job/");
  });

  it("security definition uses apiKey scheme with bearer", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    const td = res.json();
    expect(td.security).toContain("apiKey");
    expect(td.securityDefinitions.apiKey.scheme).toBe("bearer");
  });

  it("includes PCC extension fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    const td = res.json();
    expect(typeof td["pcc:capabilityType"]).toBe("string");
    expect(typeof td["pcc:kernelId"]).toBe("string");
    expect(td["pcc:pricing"]).toBeDefined();
  });

  it("response includes CORS wildcard header", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("Cache-Control is public, max-age=300", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/td`,
    });
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
  });
});
