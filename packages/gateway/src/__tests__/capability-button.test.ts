/**
 * Tests for GET /api/capabilities/:id/button
 *
 * Verifies the embeddable button config endpoint:
 *   - JSON response shape (default format)
 *   - HTML snippet format (?format=html)
 *   - Script embed format (?format=script)
 *   - 404 for unknown capability
 *   - CORS wildcard header on all responses
 *   - Custom label and theme query params
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { capabilityRoutes } from "../routes/capabilities.js";
import { initStore, closeStore } from "../db.js";

// ---------------------------------------------------------------------------
// Test app — registers only the capability routes, no auth middleware
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(capabilityRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the first capability ID from the seeded DB via the list endpoint */
async function getFirstCapabilityId(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: "GET", url: "/api/capabilities" });
  const body = res.json();
  // PaginatedResult shape: { items: CapabilityDTO[] }
  const items = body.items ?? body.capabilities ?? [];
  if (items.length === 0) throw new Error("No seeded capabilities found");
  return items[0].id as string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/capabilities/:id/button", () => {
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

  // ── 404 for unknown capability ───────────────────────────────────────────

  it("returns 404 for a non-existent capability id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities/cap-DOES-NOT-EXIST-xyz/button",
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBeDefined();
  });

  // ── JSON format (default) ────────────────────────────────────────────────

  it("returns 200 with JSON body for a known capability", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("JSON response includes capability, button, html, embedScript fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button`,
    });
    const body = res.json();
    expect(body.capability).toBeDefined();
    expect(body.button).toBeDefined();
    expect(body.html).toBeDefined();
    expect(body.embedScript).toBeDefined();
  });

  it("button.command matches pcc negotiate --capability {type} --kernel {kernelId}", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button`,
    });
    const body = res.json();
    const cap = body.capability;
    expect(body.button.command).toBe(
      `pcc negotiate --capability ${cap.type} --kernel ${cap.kernelId}`,
    );
  });

  it("button.label defaults to 'Run on Claude Code'", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button`,
    });
    const body = res.json();
    expect(body.button.label).toBe("Run on Claude Code");
  });

  it("button.contextUrl contains the capability id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button`,
    });
    const body = res.json();
    expect(body.button.contextUrl).toContain(capId);
  });

  it("button.mcpServer is a URL string", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button`,
    });
    const body = res.json();
    expect(typeof body.button.mcpServer).toBe("string");
    expect(body.button.mcpServer.length).toBeGreaterThan(0);
  });

  it("button.prompt mentions the capability type", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button`,
    });
    const body = res.json();
    expect(body.button.prompt).toContain(body.capability.type);
  });

  it("html field starts with <claude-code-button", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button`,
    });
    const body = res.json();
    expect(body.html).toMatch(/^<claude-code-button/);
  });

  it("capability summary includes id, type, kernelId, available, queueDepth", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button`,
    });
    const body = res.json();
    const cap = body.capability;
    expect(typeof cap.id).toBe("string");
    expect(typeof cap.type).toBe("string");
    expect(typeof cap.kernelId).toBe("string");
    expect(typeof cap.available).toBe("boolean");
    expect(typeof cap.queueDepth).toBe("number");
  });

  // ── CORS header ──────────────────────────────────────────────────────────

  it("response includes Access-Control-Allow-Origin: * header", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button`,
    });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("Cache-Control is public, max-age=60", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button`,
    });
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
  });

  // ── Custom label query param ─────────────────────────────────────────────

  it("?label param overrides the default button label", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button?label=Print+Now`,
    });
    const body = res.json();
    expect(body.button.label).toBe("Print Now");
  });

  // ── HTML format ──────────────────────────────────────────────────────────

  it("?format=html returns 200 with text/html content-type", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button?format=html`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("?format=html body starts with <claude-code-button", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button?format=html`,
    });
    expect(res.body.trim()).toMatch(/^<claude-code-button/);
  });

  it("?format=html response includes CORS header", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button?format=html`,
    });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("?format=html returns 404 for non-existent capability", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/cap-NONE-xyz/button?format=html`,
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Script format ────────────────────────────────────────────────────────

  it("?format=script returns 200 with text/html content-type", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button?format=script`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("?format=script body contains a <script> tag", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button?format=script`,
    });
    expect(res.body).toContain("<script");
  });

  it("?format=script body contains <claude-code-button", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/${capId}/button?format=script`,
    });
    expect(res.body).toContain("<claude-code-button");
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it("two requests to the same id return the same command", async () => {
    const url = `/api/capabilities/${capId}/button`;
    const [res1, res2] = await Promise.all([
      app.inject({ method: "GET", url }),
      app.inject({ method: "GET", url }),
    ]);
    expect(res1.json().button.command).toBe(res2.json().button.command);
  });
});
