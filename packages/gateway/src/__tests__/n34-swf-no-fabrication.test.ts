/**
 * The SWF never distributes an epoch on random scores (board N34, the server side of PX-3).
 *
 * POST /api/swf/epochs/:epochId/distribute scored every active participant with
 * Math.random() (job count, reputation, uptime, votes), then DISTRIBUTED the epoch on those
 * scores: dividend claims with real-looking amounts, and the epoch marked completed. It now
 * answers 501 not_available before its body is parsed or anything is read, scored or
 * written, and the epoch stays exactly as it was. There is no demo path (boards N34 and N46;
 * the steward's ruling on the SWF, operator item 69, economics #3315): PCC_DEMO_ROUTES does
 * not turn it on.
 *
 * Every other SWF route answers only in demo mode, from the in-memory simulation, and says
 * so (astra round 1 on #421; the demo-off refusals are in n34-swf-demo-only.test.ts). Here
 * the simulation is set up and read through the service itself, so a refusal can be shown
 * to change nothing whatever the mode.
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
const REFUSAL = { error: "not_available", message: MESSAGE, see: [] };

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

  // Two active participants: a distribution would score both.
  for (const [did, role] of [
    ["did:n34:operator-a", "operator"],
    ["did:n34:user-b", "user"],
  ] as const) {
    swfService.registerParticipant({ did, walletAddress: `0x${"ab".repeat(20)}`, role });
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

/** A fresh active epoch holding an accrual (so a distribution would have money to share). */
function fundedEpoch(): string {
  const epochId = swfService.createEpoch().id;
  // 2% of 50,000 = 1,000 accrued; 60% of it (600) is the dividend pool.
  swfService.accrue({ sourceType: "settlement", sourceId: `job-n34-${epochId}`, grossAmount: 50_000, epochId });
  return epochId;
}
/** The epoch as stored, copied, so a later comparison sees any change. */
const stored = (epochId: string) => JSON.parse(JSON.stringify(swfService.getEpoch(epochId)));

describe("NEGATIVE: the distribution refuses (501) before any parse, read, score or write", () => {
  it("501 not_available, and the epoch, its scores and its claims are untouched; no random draw", async () => {
    const epochId = fundedEpoch();
    const before = stored(epochId);
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

    expect(stored(epochId)).toEqual(before);
    expect(swfService.getClaimsForEpoch(epochId)).toEqual([]);
  });

  it("a malformed body is refused the same way, before it is parsed (not a 400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/swf/epochs/${fundedEpoch()}/distribute`,
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode, res.body).toBe(501);
    expect(res.json()).toEqual(REFUSAL);
  });

  it("the refusal points nowhere: outside demo mode every SWF route refuses too", async () => {
    expect(REFUSAL.see).toEqual([]);
    expect((await get("/api/swf/accruals")).statusCode).toBe(501);
  });

  it("an unknown epoch is refused the same way (501, not the old 409)", async () => {
    const res = await post("/api/swf/epochs/swf_epoch_none/distribute");
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(REFUSAL);
  });

  it("no value of PCC_DEMO_ROUTES turns distribution on, \"true\" included", async () => {
    const epochId = fundedEpoch();
    const before = stored(epochId);
    for (const v of ["true", "false", "1", "TRUE", "yes", ""]) {
      process.env.PCC_DEMO_ROUTES = v;
      const res = await post(`/api/swf/epochs/${epochId}/distribute`);
      expect(res.statusCode, `PCC_DEMO_ROUTES=${JSON.stringify(v)}`).toBe(501);
      expect(res.json(), `PCC_DEMO_ROUTES=${JSON.stringify(v)}`).toEqual(REFUSAL);
    }
    expect(stored(epochId)).toEqual(before);
  });

  it("PCC_DEMO_ROUTES=true is ignored under NODE_ENV=production: refused, nothing written", async () => {
    const epochId = fundedEpoch();
    const before = stored(epochId);
    process.env.PCC_DEMO_ROUTES = "true";
    process.env.NODE_ENV = "production";
    const res = await post(`/api/swf/epochs/${epochId}/distribute`);
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(REFUSAL);
    expect(stored(epochId)).toEqual(before);
    expect(swfService.getClaimsForEpoch(epochId)).toEqual([]);
  });
});

describe("NEGATIVE: PCC_DEMO_ROUTES=true has no demo distribution (operator item 69, N46)", () => {
  beforeEach(() => {
    process.env.PCC_DEMO_ROUTES = "true";
  });

  it("501 with the same refusal, unmarked: no random draw, no score, no claim, the epoch unchanged", async () => {
    const epochId = fundedEpoch();
    const before = stored(epochId);
    const random = vi.spyOn(Math, "random");
    try {
      const res = await post(`/api/swf/epochs/${epochId}/distribute`);
      expect(res.statusCode, res.body).toBe(501);
      expect(res.json()).toEqual(REFUSAL);
      expect(res.body).not.toMatch(DISTRIBUTION);
      expect(res.body).not.toMatch(/"mock"|"demo"/);
      expect(res.headers["x-pcc-demo"]).toBeUndefined();
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
    expect(stored(epochId)).toEqual(before);
    expect(swfService.getClaimsForEpoch(epochId)).toEqual([]);
  });

  it("an unknown epoch is refused the same way, not the old 409", async () => {
    const res = await post("/api/swf/epochs/swf_epoch_none/distribute");
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(REFUSAL);
  });
});

describe("demo mode: the simulation answers as before, and every answer says it is simulated", () => {
  beforeEach(() => {
    process.env.PCC_DEMO_ROUTES = "true";
  });

  const marked = (res: { headers: Record<string, unknown>; json: () => any }, what: string) => {
    expect(res.headers["x-pcc-demo"], what).toBe("true");
    expect(res.json(), what).toMatchObject({ mock: true, demo: true });
  };

  it("reads answer from the simulation, marked", async () => {
    const epochId = fundedEpoch();
    const participantId = swfService.listParticipants()[0]!.id;
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
    for (const url of reads) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      marked(res, url);
    }
    expect((await get(`/api/swf/accruals?epochId=${epochId}`)).json()).toMatchObject({
      total: 1,
      accruals: [{ epochId, grossAmount: "50000", accrualAmount: "1000" }],
    });
  });

  it("writes and their errors behave as before, marked; an allocation invents no budget", async () => {
    const epoch = await post("/api/swf/epochs");
    expect(epoch.statusCode).toBe(201);
    expect(epoch.json().epoch).toMatchObject({ status: "active", totalAccrued: "0" });
    marked(epoch, "POST /api/swf/epochs");

    const participant = await post("/api/swf/participants", {
      did: "did:n34:verifier-demo",
      walletAddress: `0x${"cd".repeat(20)}`,
      role: "verifier",
    });
    expect(participant.statusCode).toBe(201);
    expect(participant.json().participant).toMatchObject({ role: "verifier", status: "active" });
    marked(participant, "POST /api/swf/participants");

    const missing = await post("/api/swf/participants", { did: "did:n34:incomplete" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "bad_request", message: "did, walletAddress, and role are required" });

    const epochId = epoch.json().epoch.id as string;
    const noDemands = await post(`/api/swf/epochs/${epochId}/forecast-allocate`, {});
    expect(noDemands.statusCode).toBe(400);
    const allocate = await post(`/api/swf/epochs/${epochId}/forecast-allocate`, {
      demands: [{ capabilityType: "cnc", annualValue: 10_000, requesterCount: 3, alreadyServed: false }],
    });
    expect(allocate.statusCode, allocate.body).toBe(200);
    // The epoch has accrued nothing, so there is no budget to allocate: nothing invented.
    expect(allocate.json().forecastAllocation).toMatchObject({ epochId, totalBudget: "0", allocations: [] });
    marked(allocate, "POST forecast-allocate");

    const claim = await post("/api/swf/claims", {});
    expect(claim.statusCode).toBe(400);
    expect(claim.json()).toMatchObject({ error: "bad_request", message: "claimId is required" });

    const unknownEpoch = await get("/api/swf/epochs/swf_epoch_none");
    expect(unknownEpoch.statusCode).toBe(404);
    expect(unknownEpoch.json()).toMatchObject({ error: "not_found", message: "Epoch swf_epoch_none not found" });
  });
});
