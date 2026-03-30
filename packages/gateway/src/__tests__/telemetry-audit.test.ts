/**
 * Tests for GET /api/telemetry/audit
 *
 * The endpoint queries the audit log and returns entries with optional
 * filtering by limit, method, eventType, actor, and since.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { initStore, closeStore } from "../db.js";
import { auditService } from "../services/audit-service.js";
import { telemetryRoutes } from "../routes/telemetry.js";

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  closeStore();
  initStore({ seed: false });

  const app = Fastify({ logger: false });
  await app.register(telemetryRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/telemetry/audit", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    delete process.env.PCC_DB_PATH;
  });

  it("returns empty entries when audit log is empty", async () => {
    const res = await app.inject({ method: "GET", url: "/api/telemetry/audit" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("returns audit entries when they exist", async () => {
    auditService.log({ eventType: "job.submitted", action: "create", actor: "alice" });
    auditService.log({ eventType: "escrow.funded", action: "fund", actor: "bob" });

    const res = await app.inject({ method: "GET", url: "/api/telemetry/audit" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("respects the limit query param", async () => {
    for (let i = 0; i < 10; i++) {
      auditService.log({ eventType: "test.event", action: "create" });
    }

    const res = await app.inject({ method: "GET", url: "/api/telemetry/audit?limit=3" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(3);
    expect(body.filters.limit).toBe(3);
  });

  it("caps limit at 500", async () => {
    const res = await app.inject({ method: "GET", url: "/api/telemetry/audit?limit=9999" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.filters.limit).toBe(500);
  });

  it("defaults limit to 50", async () => {
    const res = await app.inject({ method: "GET", url: "/api/telemetry/audit" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.filters.limit).toBe(50);
  });

  it("filters by eventType", async () => {
    auditService.log({ eventType: "job.submitted", action: "create", actor: "alice" });
    auditService.log({ eventType: "escrow.funded", action: "fund", actor: "bob" });
    auditService.log({ eventType: "job.submitted", action: "create", actor: "charlie" });

    const res = await app.inject({
      method: "GET",
      url: "/api/telemetry/audit?eventType=job.submitted",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.entries.every((e: { eventType: string }) => e.eventType === "job.submitted")).toBe(true);
    expect(body.filters.eventType).toBe("job.submitted");
  });

  it("filters by actor", async () => {
    auditService.log({ eventType: "job.submitted", action: "create", actor: "alice" });
    auditService.log({ eventType: "escrow.funded", action: "fund", actor: "bob" });
    auditService.log({ eventType: "job.submitted", action: "create", actor: "alice" });

    const res = await app.inject({
      method: "GET",
      url: "/api/telemetry/audit?actor=alice",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.entries.every((e: { actor?: string }) => e.actor === "alice")).toBe(true);
    expect(body.filters.actor).toBe("alice");
  });

  it("filters by method (http.write entries)", async () => {
    // http.write entries have metadata.method
    auditService.log({
      eventType: "http.write",
      action: "post",
      metadata: { method: "POST", url: "/api/jobs/submit", statusCode: 201 },
    });
    auditService.log({
      eventType: "http.write",
      action: "delete",
      metadata: { method: "DELETE", url: "/api/marketplace/listings/lst-1", statusCode: 200 },
    });
    auditService.log({ eventType: "job.submitted", action: "create" });

    const res = await app.inject({
      method: "GET",
      url: "/api/telemetry/audit?method=POST",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(
      (body.entries[0].metadata as Record<string, unknown>).method,
    ).toBe("POST");
    expect(body.filters.method).toBe("POST");
  });

  it("returns null filters when not provided", async () => {
    const res = await app.inject({ method: "GET", url: "/api/telemetry/audit" });
    const body = res.json();
    expect(body.filters.method).toBeNull();
    expect(body.filters.eventType).toBeNull();
    expect(body.filters.actor).toBeNull();
    expect(body.filters.since).toBeNull();
  });

  it("returns entries with correct shape", async () => {
    auditService.log({
      eventType: "job.submitted",
      actor: "alice",
      resourceType: "job",
      resourceId: "job-123",
      action: "create",
      metadata: { kernelId: "k-1" },
    });

    const res = await app.inject({ method: "GET", url: "/api/telemetry/audit" });
    const body = res.json();
    const entry = body.entries[0];
    expect(typeof entry.eventType).toBe("string");
    expect(typeof entry.action).toBe("string");
    expect(entry.actor).toBe("alice");
    expect(entry.resourceType).toBe("job");
    expect(entry.resourceId).toBe("job-123");
  });
});
