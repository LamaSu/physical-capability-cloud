/**
 * Board N43 (found again by the #533 door sweep, bus #6070): api-gate's old allowlist listed
 * "/api/capabilities" for EVERY method. Its replacement PUBLIC_READ_EXACT limits that entry to
 * reads. Previously an anonymous POST reached
 * routes/capabilities.ts, which creates a capability on any kernel id with no caller check: a
 * stranger could publish listings under another operator's kernel.
 *
 * Mounted as production mounts it: apiGate first, then the routes. The capability reads stay
 * public: the listing, the types, a capability's detail, its button and its TD. Every write goes
 * through the gate. The landing-page template matcher (POST, read-only, public by design) stays
 * public.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { graphSearchRoutes } from "../routes/graph-search.js";
import { orchestratorTemplatesRoutes } from "../routes/orchestrator-templates.js";
import { initStore, closeStore, getRepos } from "../db.js";

const PREV_DB = process.env.PCC_DB_PATH;
let app: FastifyInstance;
let capId = "";
const ANON = { "x-forwarded-for": "10.43.0.1" };

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  closeStore();
  initStore({ seed: true });
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(capabilityRoutes);
  await app.register(graphSearchRoutes);
  await app.register(orchestratorTemplatesRoutes);
  await app.ready();
  capId = (getRepos().capabilities.findAll() as Array<{ id: string }>)[0]!.id;
});

afterAll(async () => {
  await app.close();
  closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
});

describe("N43: an anonymous caller cannot create or change a capability", () => {
  it("anonymous POST /api/capabilities on another operator's kernel is 401, and nothing is created", async () => {
    const before = getRepos().capabilities.findAll().length;
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      headers: ANON,
      payload: { kernelId: "kernel-nyc", type: "forged-n43-type", name: "Forged by anonymous" },
    });
    expect(res.statusCode).toBe(401);
    expect(getRepos().capabilities.findAll().length).toBe(before);
  });

  it("every other method on the public capability paths is gated too", async () => {
    for (const [method, url] of [
      ["PUT", "/api/capabilities"],
      ["DELETE", "/api/capabilities"],
      ["POST", "/api/capabilities/types"],
      ["POST", "/api/capabilities/graph-search"],
      ["POST", `/api/capabilities/${capId}`],
      ["DELETE", `/api/capabilities/${capId}`],
      ["POST", `/api/capabilities/${capId}/button`],
    ] as const) {
      const res = await app.inject({ method, url, headers: ANON, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("the capability reads stay public: the listing, the types, the detail, its button and its TD", async () => {
    for (const url of ["/api/capabilities", "/api/capabilities/types", `/api/capabilities/${capId}`, `/api/capabilities/${capId}/button`, `/api/capabilities/${capId}/td`]) {
      const res = await app.inject({ method: "GET", url, headers: ANON });
      expect(res.statusCode, `GET ${url}`).not.toBe(401);
      expect(res.statusCode, `GET ${url}`).toBeLessThan(500);
    }
    expect((await app.inject({ method: "HEAD", url: "/api/capabilities", headers: ANON })).statusCode).not.toBe(401);
  });

  it("the landing-page template matcher stays public: a read-only POST that stores nothing", async () => {
    const res = await app.inject({ method: "POST", url: "/api/capabilities/templates/match", headers: ANON, payload: { input: "3d print a bracket" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("matches");
  });
});
