/**
 * The SWF never distributes an epoch on random scores (board N34, the server side of PX-3).
 *
 * POST /api/swf/epochs/:epochId/distribute scored every active participant with
 * Math.random() (job count, reputation, uptime, votes), then DISTRIBUTED the epoch on those
 * scores: dividend claims with real-looking amounts, and the epoch marked completed. It is
 * the only route in swf.ts that drew random values, so it is the only one changed: it
 * answers 501 not_available BEFORE anything is read, scored or written, and the epoch stays
 * exactly as it was. There is no demo path (boards N34 and N46; the steward's ruling on the
 * SWF, operator item 69, economics #3315): PCC_DEMO_ROUTES does not turn it on.
 *
 * Every other route is REAL (it reads and writes the SWF service's own records, which hold
 * only what callers put there) and must behave the same with the flag on or off.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { swfRoutes, swfService } from "../routes/swf.js";
import { initStore, closeStore } from "../db.js";

const MESSAGE =
  "Per-epoch contribution scores (each participant's jobs, reputation, activity and votes in this epoch) " +
  "are not computed on this gateway, " +
  "so the epoch was not scored or distributed: without them, every participant's share would come " +
  "from random numbers.";
const REFUSAL = { error: "not_available", message: MESSAGE, see: ["GET /api/swf/epochs/:epochId", "GET /api/swf/accruals"] };

/** What a distribution produces. None may appear in a refusal. */
const DISTRIBUTION = /"epoch":|"scores":|shareOfEpoch|totalScore|jobVolume|swf_claim_|"totalDistributed"|"(calculating|distributing|completed)"/;

const ENV = ["PCC_DEMO_ROUTES", "PCC_DB_PATH", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance;

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.PCC_DEMO_ROUTES;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  app = Fastify({ logger: false });
  await app.register(swfRoutes);
  await app.ready();

  // Two active participants, through the REAL route: a distribution would score both.
  for (const [did, role] of [
    ["did:n34:operator-a", "operator"],
    ["did:n34:user-b", "user"],
  ] as const) {
    const res = await app.inject({
      method: "POST",
      url: "/api/swf/participants",
      payload: { did, walletAddress: `0x${"ab".repeat(20)}`, role },
    });
    expect(res.statusCode, res.body).toBe(201);
  }
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

const get = (url: string) => app.inject({ method: "GET", url });
const post = (url: string, payload?: unknown) => app.inject({ method: "POST", url, payload: payload as any });

/** A fresh active epoch holding a real accrual (so a distribution would have money to share). */
async function fundedEpoch(): Promise<string> {
  const res = await post("/api/swf/epochs");
  expect(res.statusCode, res.body).toBe(201);
  const epochId: string = res.json().epoch.id;
  // 2% of 50,000 = 1,000 accrued; 60% of it (600) is the dividend pool.
  swfService.accrue({ sourceType: "settlement", sourceId: `job-n34-${epochId}`, grossAmount: 50_000, epochId });
  return epochId;
}

describe("NEGATIVE: the distribution refuses (501) before any read, score or write", () => {
  it("501 not_available, and the epoch, its scores and its claims are untouched; no random draw", async () => {
    const epochId = await fundedEpoch();
    const before = (await get(`/api/swf/epochs/${epochId}`)).json().epoch;
    expect(before).toMatchObject({ status: "active", scores: [], participantCount: 0, totalAccrued: "1000" });

    const random = vi.spyOn(Math, "random");
    try {
      const res = await post(`/api/swf/epochs/${epochId}/distribute`);
      expect(res.statusCode, res.body).toBe(501);
      // The refusal is the whole body: nothing else rides along.
      expect(res.json()).toEqual(REFUSAL);
      expect(res.body).not.toMatch(DISTRIBUTION);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }

    const after = await get(`/api/swf/epochs/${epochId}`);
    expect(after.json().epoch).toEqual(before);
    expect(swfService.getClaimsForEpoch(epochId)).toEqual([]);
  });

  it("each `see` pointer names a route this gateway registers", () => {
    for (const p of REFUSAL.see) {
      const [method, url] = p.split(" ");
      expect(app.hasRoute({ method: method as "GET", url }), p).toBe(true);
    }
  });

  it("an unknown epoch is refused the same way (501, not the old 409)", async () => {
    const res = await post("/api/swf/epochs/swf_epoch_none/distribute");
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(REFUSAL);
  });

  it("no value of PCC_DEMO_ROUTES turns distribution on, \"true\" included", async () => {
    const epochId = await fundedEpoch();
    for (const v of ["true", "false", "1", "TRUE", "yes", ""]) {
      process.env.PCC_DEMO_ROUTES = v;
      const res = await post(`/api/swf/epochs/${epochId}/distribute`);
      expect(res.statusCode, `PCC_DEMO_ROUTES=${JSON.stringify(v)}`).toBe(501);
    }
    expect((await get(`/api/swf/epochs/${epochId}`)).json().epoch.status).toBe("active");
  });

  it("PCC_DEMO_ROUTES=true is ignored under NODE_ENV=production: refused, nothing written", async () => {
    const epochId = await fundedEpoch();
    process.env.PCC_DEMO_ROUTES = "true";
    process.env.NODE_ENV = "production";
    const res = await post(`/api/swf/epochs/${epochId}/distribute`);
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(REFUSAL);
    process.env.NODE_ENV = saved.NODE_ENV ?? "test";
    expect((await get(`/api/swf/epochs/${epochId}`)).json().epoch).toMatchObject({ status: "active", scores: [] });
    expect(swfService.getClaimsForEpoch(epochId)).toEqual([]);
  });
});

describe("NEGATIVE: PCC_DEMO_ROUTES=true has no demo distribution (operator item 69, N46)", () => {
  beforeEach(() => {
    process.env.PCC_DEMO_ROUTES = "true";
  });

  it("501 with the same refusal: no random draw, no score, no claim, the epoch unchanged", async () => {
    const epochId = await fundedEpoch();
    const before = (await get(`/api/swf/epochs/${epochId}`)).json().epoch;
    const random = vi.spyOn(Math, "random");
    try {
      const res = await post(`/api/swf/epochs/${epochId}/distribute`);
      expect(res.statusCode, res.body).toBe(501);
      expect(res.json()).toEqual(REFUSAL);
      expect(res.body).not.toMatch(DISTRIBUTION);
      expect(res.body).not.toMatch(/"mock"|"demo"/);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
    expect((await get(`/api/swf/epochs/${epochId}`)).json().epoch).toEqual(before);
    expect(swfService.getClaimsForEpoch(epochId)).toEqual([]);
  });

  it("an unknown epoch is refused the same way, not the old 409", async () => {
    const res = await post("/api/swf/epochs/swf_epoch_none/distribute");
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(REFUSAL);
  });
});

describe("REAL routes: the same answer with PCC_DEMO_ROUTES on or off, never marked", () => {
  const unmarked = (body: Record<string, unknown>) => {
    expect(body).not.toHaveProperty("mock");
    expect(body).not.toHaveProperty("demo");
  };

  it("reads answer identically in both modes", async () => {
    const epochId = await fundedEpoch();
    const participantId = (await get("/api/swf/participants")).json().participants[0].id as string;
    const reads = [
      "/api/swf/summary",
      "/api/swf/participants",
      "/api/swf/participants?role=operator",
      `/api/swf/participants/${participantId}`,
      "/api/swf/epochs",
      "/api/swf/epochs?status=active",
      `/api/swf/epochs/${epochId}`,
      `/api/swf/accruals?epochId=${epochId}`,
      "/api/swf/accruals",
      "/api/swf/proposals",
      "/api/swf/equity/portfolio",
      "/api/swf/terms",
    ];
    // summary.lastDistributionAt falls back to the time of the call when nothing was ever
    // distributed; it is the one field that may differ between two calls.
    const stable = (url: string, body: any) => {
      if (url === "/api/swf/summary") delete body.summary.lastDistributionAt;
      return body;
    };
    for (const url of reads) {
      delete process.env.PCC_DEMO_ROUTES;
      const off = await get(url);
      process.env.PCC_DEMO_ROUTES = "true";
      const on = await get(url);
      expect(off.statusCode, url).toBe(200);
      expect(on.statusCode, url).toBe(200);
      unmarked(off.json());
      unmarked(on.json());
      expect(on.headers["x-pcc-demo"], url).toBeUndefined();
      expect(stable(url, on.json()), url).toEqual(stable(url, off.json()));
    }
    expect((await get(`/api/swf/accruals?epochId=${epochId}`)).json()).toMatchObject({
      total: 1,
      accruals: [{ epochId, grossAmount: "50000", accrualAmount: "1000" }],
    });
  });

  for (const demo of [false, true]) {
    it(`writes and their errors are unchanged with PCC_DEMO_ROUTES ${demo ? "on" : "off"}`, async () => {
      if (demo) process.env.PCC_DEMO_ROUTES = "true";

      const epoch = await post("/api/swf/epochs");
      expect(epoch.statusCode).toBe(201);
      expect(epoch.json().epoch).toMatchObject({ status: "active", totalAccrued: "0" });
      unmarked(epoch.json());

      const participant = await post("/api/swf/participants", {
        did: `did:n34:verifier-${demo ? "on" : "off"}`,
        walletAddress: `0x${"cd".repeat(20)}`,
        role: "verifier",
      });
      expect(participant.statusCode).toBe(201);
      expect(participant.json().participant).toMatchObject({ role: "verifier", status: "active" });
      unmarked(participant.json());

      const missing = await post("/api/swf/participants", { did: "did:n34:incomplete" });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toEqual({ error: "bad_request", message: "did, walletAddress, and role are required" });

      const epochId = epoch.json().epoch.id as string;
      const noDemands = await post(`/api/swf/epochs/${epochId}/forecast-allocate`, {});
      expect(noDemands.statusCode).toBe(400);
      unmarked(noDemands.json());
      const allocate = await post(`/api/swf/epochs/${epochId}/forecast-allocate`, {
        demands: [{ capabilityType: "cnc", annualValue: 10_000, requesterCount: 3, alreadyServed: false }],
      });
      expect(allocate.statusCode, allocate.body).toBe(200);
      // The epoch has accrued nothing, so there is no budget to allocate: nothing invented.
      expect(allocate.json().forecastAllocation).toMatchObject({ epochId, totalBudget: "0", allocations: [] });
      unmarked(allocate.json());

      const claim = await post("/api/swf/claims", {});
      expect(claim.statusCode).toBe(400);
      expect(claim.json()).toEqual({ error: "bad_request", message: "claimId is required" });

      const unknownEpoch = await get("/api/swf/epochs/swf_epoch_none");
      expect(unknownEpoch.statusCode).toBe(404);
      expect(unknownEpoch.json()).toEqual({ error: "not_found", message: "Epoch swf_epoch_none not found" });
    });
  }
});
