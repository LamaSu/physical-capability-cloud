/**
 * Board N122's operator reads, built in the N31 stack because they need auth/kernel-authority.ts
 * (the steward's #6488 split by sensitivity):
 *   - GET /api/operator/policy/:kernelId: the kernel's own (claimed) principal, a proven
 *     operator wallet or the admin. It is essentially the stop flag, and the starter runbook reads
 *     it with the operator's own key. An unregistered kernel is 404 for a non-admin.
 *   - GET /api/operator/approvals: a PROVEN wallet or the admin only, since approvals carry job
 *     parameters. A proven wallet sees only approvals on kernels it operates; the admin sees all.
 * Both used to serve any kernel to any key.
 *
 * Mounted behind apiGate. Seeded kernel-nyc's operator is 0x1111…, kernel-sf's is 0x2222….
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn(), shutdownPostHog: vi.fn() }));

const PREV_DB = process.env.PCC_DB_PATH;
const PREV_ADMIN = process.env.PCC_ADMIN_KEY;
const ADMIN = "n31c-reads-admin";
const NYC = "0x1111111111111111111111111111111111111111";
const SF = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x9999999999999999999999999999999999993111";

let app: FastifyInstance;
const keys = { nyc: "", stranger: "" };
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const ANON = { "x-forwarded-for": "10.31.13.1" };
const asAdmin = () => ({ ...bearer(keys.stranger), "x-admin-key": ADMIN });
const proven = (wallet: string) => ({ ...bearer(keys.stranger), "x-test-proven-wallet": wallet });

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  const db = await import("../db.js");
  db.closeStore();
  db.initStore({ seed: true });
  const { provisionApiKey } = await import("../auth/api-key-auth.js");
  keys.nyc = provisionApiKey({ operatorId: NYC, name: "n31c-nyc", scopes: ["*"] }).rawKey;
  keys.stranger = provisionApiKey({ operatorId: STRANGER, name: "n31c-reads-stranger", scopes: ["*"] }).rawKey;
  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const p = req.headers["x-test-proven-wallet"];
    if (typeof p === "string") (req as unknown as { provenWallet: string }).provenWallet = p;
  });
  const { apiGate } = await import("../middleware/api-gate.js");
  const { operatorRoutes } = await import("../routes/operator.js");
  await app.register(apiGate);
  await app.register(operatorRoutes);
  await app.ready();
  // One pending approval on each kernel, created by the admin.
  for (const kernelId of ["kernel-nyc", "kernel-sf"]) {
    const res = await app.inject({ method: "POST", url: "/api/operator/approvals", headers: asAdmin(), payload: { kernelId, agentId: `agent-${kernelId}`, parameters: { secret: kernelId } } });
    expect(res.statusCode).toBe(200);
  }
}, 60_000);

afterAll(async () => {
  await app.close();
  (await import("../db.js")).closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
  if (PREV_ADMIN === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = PREV_ADMIN;
});

describe("N122 GET /api/operator/policy/:kernelId: the kernel's own principal, a proven wallet or the admin", () => {
  const read = (headers: Record<string, string>, kernelId = "kernel-nyc") => app.inject({ method: "GET", url: `/api/operator/policy/${kernelId}`, headers });

  it("anonymous is 401", async () => {
    expect((await read(ANON)).statusCode).toBe(401);
  });

  it("a stranger is 403", async () => {
    expect((await read(bearer(keys.stranger))).statusCode).toBe(403);
  });

  it("the kernel's own key (the starter runbook's read), its proven wallet and the admin read it", async () => {
    for (const headers of [bearer(keys.nyc), proven(NYC), asAdmin()]) {
      expect((await read(headers)).statusCode).toBe(200);
    }
  });

  it("an unregistered kernel is 404 for a non-admin", async () => {
    expect((await read(bearer(keys.nyc), "kernel-n31c-missing")).statusCode).toBe(404);
  });
});

describe("N122 GET /api/operator/approvals: a proven wallet (its kernels only) or the admin", () => {
  const list = (headers: Record<string, string>, query = "") => app.inject({ method: "GET", url: `/api/operator/approvals${query}`, headers });
  const kernelsOf = (res: { json(): any }) => [...new Set((res.json().approvals as Array<{ kernelId: string }>).map((a) => a.kernelId))].sort();

  it("anonymous is 401", async () => {
    expect((await list(ANON)).statusCode).toBe(401);
  });

  it("a claimed key is 403, even the kernel operator's own: approvals carry job parameters", async () => {
    for (const headers of [bearer(keys.stranger), bearer(keys.nyc)]) {
      const res = await list(headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).not.toHaveProperty("approvals");
    }
  });

  it("a proven operator sees only its own kernels' approvals, filtered or not", async () => {
    const all = await list(proven(NYC));
    expect(all.statusCode).toBe(200);
    expect(kernelsOf(all)).toEqual(["kernel-nyc"]);
    const pending = await list(proven(NYC), "?status=pending");
    expect(kernelsOf(pending)).toEqual(["kernel-nyc"]);
  });

  it("a proven operator asking for another operator's kernel is refused as not found", async () => {
    expect((await list(proven(NYC), "?kernelId=kernel-sf")).statusCode).toBe(404);
    expect((await list(proven(SF), "?kernelId=kernel-sf")).statusCode).toBe(200);
  });

  it("a proven stranger sees an empty list", async () => {
    const res = await list(proven(STRANGER));
    expect(res.statusCode).toBe(200);
    expect(res.json().approvals).toEqual([]);
  });

  it("the admin sees every kernel's approvals", async () => {
    expect(kernelsOf(await list(asAdmin()))).toEqual(["kernel-nyc", "kernel-sf"]);
  });
});
