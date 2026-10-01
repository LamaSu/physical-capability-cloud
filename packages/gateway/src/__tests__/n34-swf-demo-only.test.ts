/**
 * The SWF answers only in demo mode (board N34; astra round 1 on #421, r1a HIGH and MEDIUM).
 *
 * The SWF service is an in-memory mock: process-local maps, an epoch created when the route
 * module is imported, a summary whose "last distribution" is the current time and whose
 * Base USDC balance was never read from a chain. Every SWF route served that state outside
 * demo mode, and a released milestone accrued an invented 1,000 USDC into it. So:
 *   - with PCC_DEMO_ROUTES off (and always under NODE_ENV=production) every /api/swf route
 *     answers 501 not_available before its body is parsed, and reads or writes nothing;
 *   - epoch distribution answers 501 in every mode, also before its body is parsed (the
 *     steward's ruling, operator item 69: the SWF's money routes stay 501);
 *   - in demo mode the other routes answer from the mock, and every answer says so;
 *   - a released milestone accrues nothing into the SWF (no real amount reaches it).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const RELEASED = (jobId: string, byte: string) => ({ status: "released", jobId, txHash: `0x${byte.repeat(32)}` });

vi.mock("../activities/escrow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../activities/escrow.js")>()),
  releaseMilestoneByJobActivity: { invoke: vi.fn(async () => ({ ok: true, value: RELEASED("job-swf-route", "ab") })) },
}));
vi.mock("../services/settlement-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/settlement-service.js")>()),
  getSettlementService: () => ({ releaseMilestone: vi.fn(async () => RELEASED("job-swf-facade", "cd")) }),
}));

import { swfRoutes, swfService } from "../routes/swf.js";
import { settlementRoutes } from "../routes/settlement.js";
import { getSettlementFacade } from "../facades/index.js";
import { initStore, closeStore } from "../db.js";

const ENV = ["PCC_DEMO_ROUTES", "PCC_DB_PATH", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};
const swfRouteList: Array<{ method: string; url: string }> = [];
let app: FastifyInstance;

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  app = Fastify({ logger: false });
  app.addHook("onRoute", (r) => {
    for (const method of [r.method].flat()) {
      if (method !== "HEAD" && r.url.startsWith("/api/swf")) swfRouteList.push({ method, url: r.url });
    }
  });
  await app.register(swfRoutes);
  await app.register(settlementRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  delete process.env.PCC_DEMO_ROUTES;
  process.env.NODE_ENV = saved.NODE_ENV ?? "test";
});

const concrete = (url: string) => url.replace(/:[^/]+/g, "x");
const MALFORMED = { headers: { "content-type": "application/json" }, payload: "{not json" };
/** The SWF's records, as a fingerprint: a refused request must leave it unchanged. */
const state = () =>
  JSON.stringify({
    epochs: swfService.listEpochs(),
    participants: swfService.listParticipants(),
    proposals: swfService.listProposals(),
    termSheets: swfService.listTermSheets(),
  });

describe("demo off: every SWF route refuses before it reads, parses or writes anything", () => {
  it("the probe sees the whole SWF family", () => {
    expect(swfRouteList.length).toBeGreaterThan(20);
  });

  it("each route answers 501 not_available, the same body for every route, and nothing changes", async () => {
    const before = state();
    for (const r of swfRouteList) {
      const res = await app.inject({ method: r.method as "GET" | "POST", url: concrete(r.url), ...(r.method === "POST" ? { payload: {} } : {}) });
      expect(res.statusCode, `${r.method} ${r.url}: ${res.body}`).toBe(501);
      const body = res.json();
      expect(body.error, `${r.method} ${r.url}`).toBe("not_available");
      expect(Object.keys(body).sort(), `${r.method} ${r.url}`).toEqual(["error", "message", "see"]);
    }
    expect(state()).toBe(before);
  });

  it("a malformed JSON body is refused with the 501, not parsed into a 400 (r1a MEDIUM)", async () => {
    for (const url of ["/api/swf/participants", "/api/swf/epochs/x/distribute", "/api/swf/claims", "/api/swf/equity/record-revenue"]) {
      const res = await app.inject({ method: "POST", url, ...MALFORMED });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(501);
    }
  });

  it("NODE_ENV=production refuses even with PCC_DEMO_ROUTES=true", async () => {
    process.env.PCC_DEMO_ROUTES = "true";
    process.env.NODE_ENV = "production";
    const res = await app.inject({ method: "GET", url: "/api/swf/summary" });
    expect(res.statusCode, res.body).toBe(501);
  });
});

describe("demo on: the mock answers and says so; distribution still refuses", () => {
  beforeEach(() => {
    process.env.PCC_DEMO_ROUTES = "true";
  });

  it("GET /api/swf/summary is served from the mock and marked mock and demo", async () => {
    const res = await app.inject({ method: "GET", url: "/api/swf/summary" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ mock: true, demo: true });
  });

  it("a demo write is marked too", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/swf/participants",
      payload: { did: "did:n34:demo-only", walletAddress: `0x${"ab".repeat(20)}`, role: "operator" },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ mock: true, demo: true });
  });

  it("epoch distribution answers 501 before its body is parsed, and changes nothing", async () => {
    const before = state();
    const malformed = await app.inject({ method: "POST", url: "/api/swf/epochs/x/distribute", ...MALFORMED });
    expect(malformed.statusCode, malformed.body).toBe(501);
    expect(malformed.json().error).toBe("not_available");
    const valid = await app.inject({ method: "POST", url: "/api/swf/epochs/x/distribute", payload: {} });
    expect(valid.statusCode, valid.body).toBe(501);
    expect(state()).toBe(before);
  });
});

describe("a released milestone accrues nothing into the SWF (r1a HIGH: the invented 1,000)", () => {
  it("neither the release route nor the settlement facade writes an accrual", async () => {
    const accruals = () => swfService.listEpochs().reduce((n, e) => n + swfService.getAccrualsForEpoch(e.id).length, 0);
    const before = accruals();

    const res = await app.inject({
      method: "POST",
      url: "/api/settlement/release",
      payload: { jobId: "job-swf-route", attestation: { escrowAddress: `0x${"11".repeat(20)}` } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe("released");

    const viaFacade = await getSettlementFacade().releaseMilestoneForJob(
      "job-swf-facade",
      0,
      { escrowAddress: `0x${"11".repeat(20)}` } as never,
    );
    expect(viaFacade.success, JSON.stringify(viaFacade)).toBe(true);

    expect(accruals()).toBe(before);
  });
});
