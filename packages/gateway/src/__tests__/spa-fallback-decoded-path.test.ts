/**
 * AZ-6 (astra, pack 59 verdict): an unmatched request is classified by the SAME
 * decoded path apiGate authorized.
 *
 * With SERVE_DASHBOARD=true, the not-found handler decided "API, so a bare 404" or
 * "the SPA" from the RAW url, while apiGate decodes the path (middleware/route-path.ts
 * authPath). So an unmatched GET /%61pi/dht/nonexistent was authorized as
 * /api/dht/... (a public prefix) and then answered with the SPA's index.html (200),
 * contradicting route-path.ts's stated guarantee that an unmatched /api/* or /sse/*
 * path gets a bare 404. No privileged handler ran, but the classification
 * disagreed. Reproduced at 8ea04fdb before any code changed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";

const MARKER = "SPA-INDEX-MARKER-az6";
let dir = "";
let withDashboard: FastifyInstance;
let withoutDashboard: FastifyInstance;
let key = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcc-spa-az6-"));
  writeFileSync(join(dir, "index.html"), `<html><body>${MARKER}</body></html>`);
  const server = await import("../server.js");
  const { provisionApiKey } = await import("../auth/api-key-auth.js");
  process.env.SERVE_DASHBOARD = "true";
  process.env.DASHBOARD_PATH = dir;
  withDashboard = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await withDashboard.ready();
  delete process.env.SERVE_DASHBOARD;
  delete process.env.DASHBOARD_PATH;
  withoutDashboard = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await withoutDashboard.ready();
  key = provisionApiKey({ operatorId: "az6-caller@x.test", scopes: ["operator"] }).rawKey;
});

afterAll(async () => {
  await withDashboard?.close();
  await withoutDashboard?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (app: FastifyInstance, url: string, withKey = false) =>
  app.inject({ method: "GET", url, headers: withKey ? { authorization: `Bearer ${key}` } : {} });

describe("AZ-6: an unmatched request is classified by the decoded path, as apiGate authorized it", () => {
  it.each([
    ["an encoded public-prefix path, no key", "/%61pi/dht/nonexistent", false],
    ["an encoded non-public path, with a key", "/%61pi/does-not-exist", true],
    ["an encoded /sse/ path, with a key", "/%73se/does-not-exist", true],
  ])("[neg] dashboard ON, %s: a bare 404, never the SPA", async (_name, url, withKey) => {
    const res = await get(withDashboard, url as string, withKey as boolean);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(MARKER);
  });

  it("[neg] dashboard OFF: the same encoded paths are a 404 too", async () => {
    for (const [url, withKey] of [["/%61pi/dht/nonexistent", false], ["/%61pi/does-not-exist", true]] as const) {
      const res = await get(withoutDashboard, url, withKey);
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("control: a literal unmatched /api/ path is a bare 404, and a real SPA route still gets the SPA", async () => {
    const api = await get(withDashboard, "/api/does-not-exist", true);
    expect(api.statusCode).toBe(404);
    expect(api.body).not.toContain(MARKER);
    const spa = await get(withDashboard, "/some/dashboard/route");
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain(MARKER);
  });
});
