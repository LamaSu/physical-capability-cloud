import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { batchRoutes, _clearSharedBatchesForTests } from "../routes/batches.js";
import { batchTracker } from "../services.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, initStore } from "../db.js";

// ───────────────────────────────────────────────────────────────────────────
// Board row N49: a shared-batch slot claim belongs to the authenticated caller.
// Before this fix, POST /api/batches/shared/:batchId/claim took `agentId` from
// the request body with no check against the caller, so any key holder could
// file claims (and their payment obligations) under any identity. The dashboard
// sent the fixture identity "demo-user". Mounted behind apiGate, as in server.ts.
// ───────────────────────────────────────────────────────────────────────────

const PREV_DB = process.env.PCC_DB_PATH;
let app: FastifyInstance;
let alice: string;
let bob: string;

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  closeStore();
  initStore({ seed: false });
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(batchRoutes);
  await app.ready();
  alice = provisionApiKey({ operatorId: ALICE }).rawKey;
  bob = provisionApiKey({ operatorId: BOB }).rawKey;
});

afterAll(async () => {
  await app.close();
  closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
});

beforeEach(() => {
  _clearSharedBatchesForTests();
});

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

async function createBatch(key = alice, totalSlots = 8): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/batches/shared",
    headers: auth(key),
    payload: { kernelId: "kernel-lab", capabilityType: "liquid-handling", totalSlots, pricePerSlot: "1.50", protocolType: "dilution" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().batch.id;
}

function claim(batchId: string, key: string | null, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/batches/shared/${batchId}/claim`,
    headers: key ? auth(key) : {},
    payload,
  });
}

async function claimCount(batchId: string): Promise<number> {
  const res = await app.inject({ method: "GET", url: `/api/batches/shared/${batchId}`, headers: auth(alice) });
  return res.json().summary.claimants;
}

describe("N49: the claimant is the authenticated caller", () => {
  it("rejects an anonymous claim with 401", async () => {
    const id = await createBatch();
    const res = await claim(id, null, { slotCount: 1 });
    expect(res.statusCode).toBe(401);
    expect(await claimCount(id)).toBe(0);
  });

  it("attributes a claim without agentId to the caller", async () => {
    const id = await createBatch();
    const res = await claim(id, alice, { slotCount: 2 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claim.agentId).toBe(ALICE);
    expect(body.claim.slotIndices).toEqual([0, 1]);
    expect(body.claim.amount).toBe("3.00");
    expect(body.batchStatus).toBe("filling");
  });

  it("refuses a body agentId that names someone else (403) and records nothing", async () => {
    const id = await createBatch();
    for (const other of ["demo-user", BOB, "", 0, null]) {
      const res = await claim(id, alice, { agentId: other, slotCount: 1 });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("agent_mismatch");
    }
    expect(await claimCount(id)).toBe(0);
  });

  it("accepts a body agentId equal to the caller (older clients keep working)", async () => {
    const id = await createBatch();
    const res = await claim(id, alice, { agentId: ALICE, slotCount: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().claim.agentId).toBe(ALICE);
  });

  it("rejects slotCount that is not a positive integer (a negative count used to mint a negative-amount claim)", async () => {
    const id = await createBatch();
    // agentId equals the caller, so the count is the only thing under test.
    for (const slotCount of [0, -1, 1.5, "2", null, undefined]) {
      const res = await claim(id, alice, { agentId: ALICE, slotCount });
      expect(res.statusCode).toBe(400);
    }
    expect(await claimCount(id)).toBe(0);
  });

  it("rejects preferredIndices that are out of range, non-integer or duplicated", async () => {
    const id = await createBatch(alice, 4);
    for (const preferredIndices of [[4, 1], [-1, 0], [1, 1], [0.5, 2]]) {
      const res = await claim(id, alice, { slotCount: 2, preferredIndices });
      expect(res.statusCode).toBe(400);
    }
    const ok = await claim(id, alice, { slotCount: 2, preferredIndices: [3, 0] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().claim.slotIndices).toEqual([3, 0]);
  });
});

describe("N49: only the claimant can release a claim", () => {
  it("returns 403 to another caller and 200 to the claimant", async () => {
    const id = await createBatch();
    const claimId = (await claim(id, alice, { slotCount: 1 })).json().claim.id;

    const byBob = await app.inject({ method: "DELETE", url: `/api/batches/shared/${id}/claim/${claimId}`, headers: auth(bob) });
    expect(byBob.statusCode).toBe(403);
    expect(byBob.json().error).toBe("not_claimant");
    expect(await claimCount(id)).toBe(1);

    const anon = await app.inject({ method: "DELETE", url: `/api/batches/shared/${id}/claim/${claimId}` });
    expect(anon.statusCode).toBe(401);

    const byAlice = await app.inject({ method: "DELETE", url: `/api/batches/shared/${id}/claim/${claimId}`, headers: auth(alice) });
    expect(byAlice.statusCode).toBe(200);
    expect(await claimCount(id)).toBe(0);
  });
});

describe("N49: a claimant's identity is shown only to that claimant", () => {
  it("redacts other callers' identities and sample labels on the detail, open-list and availability reads", async () => {
    const id = await createBatch();
    await claim(id, alice, { slotCount: 2, sampleLabels: ["patient-7731-serum", "patient-7731-plasma"] });

    const asBob = (await app.inject({ method: "GET", url: `/api/batches/shared/${id}`, headers: auth(bob) })).json();
    expect(asBob.batch.claimedSlots[0].agentId).toBeNull();
    expect(asBob.batch.claimedSlots[0].own).toBe(false);
    expect(asBob.batch.claimedSlots[0].sampleLabels).toEqual([]);
    expect(JSON.stringify(asBob)).not.toContain(ALICE);
    expect(JSON.stringify(asBob)).not.toContain("patient-7731");

    const asAlice = (await app.inject({ method: "GET", url: `/api/batches/shared/${id}`, headers: auth(alice) })).json();
    expect(asAlice.batch.claimedSlots[0].agentId).toBe(ALICE);
    expect(asAlice.batch.claimedSlots[0].own).toBe(true);
    expect(asAlice.batch.claimedSlots[0].sampleLabels).toEqual(["patient-7731-serum", "patient-7731-plasma"]);

    const open = (await app.inject({ method: "GET", url: "/api/batches/shared/open", headers: auth(bob) })).json();
    expect(JSON.stringify(open)).not.toContain(ALICE);
    expect(JSON.stringify(open)).not.toContain("patient-7731");
    expect(open.batches[0].claimedSlots[0].slotIndices).toEqual([0, 1]);

    const avail = (await app.inject({ method: "GET", url: `/api/batches/shared/${id}/availability`, headers: auth(bob) })).json();
    expect(avail.claimedBy[0]).toMatchObject({ agentId: null, own: false, slotCount: 2 });
    expect(avail.available).toBe(6);
  });
});

describe("N49: the route itself fails closed without apiGate", () => {
  it("returns 401 from requireAuth on create, claim and add-sample when no gate ran and no session exists", async () => {
    const id = await createBatch();
    const bare = Fastify({ logger: false });
    await bare.register(batchRoutes);
    await bare.ready();
    try {
      const created = await bare.inject({
        method: "POST",
        url: "/api/batches/shared",
        payload: { kernelId: "k", capabilityType: "c", totalSlots: 2, pricePerSlot: "1" },
      });
      expect(created.statusCode).toBe(401);
      const res = await bare.inject({ method: "POST", url: `/api/batches/shared/${id}/claim`, payload: { agentId: "demo-user", slotCount: 1 } });
      expect(res.statusCode).toBe(401);
      const sample = await bare.inject({
        method: "POST",
        url: `/api/batches/${batchTracker.createBatch("kernel-lab", "dev-1", "cap-1", {}).id}/slots`,
        payload: { position: "A1", jobId: "j", stepId: "s", sampleLabel: "x", userId: "demo-user" },
      });
      expect(sample.statusCode).toBe(401);
    } finally {
      await bare.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Round 2 (coord-watch #2939, gateway #2830): input validation, the creator,
// what a non-owner sees, and the legacy batch-manifest routes.
// ───────────────────────────────────────────────────────────────────────────

function createWith(payload: Record<string, unknown>, key: string | null = alice) {
  return app.inject({ method: "POST", url: "/api/batches/shared", headers: key ? auth(key) : {}, payload });
}

const GOOD = { kernelId: "kernel-lab", capabilityType: "liquid-handling", totalSlots: 8, pricePerSlot: "1.50" };

describe("N49 round 2: creating a shared batch", () => {
  it("records the creator and shows it only to the creator", async () => {
    const res = await createWith(GOOD);
    expect(res.statusCode).toBe(200);
    const id = res.json().batch.id;
    expect(res.json().batch.createdBy).toBe(ALICE);
    const asBob = (await app.inject({ method: "GET", url: `/api/batches/shared/${id}`, headers: auth(bob) })).json();
    expect(asBob.batch.createdBy).toBeNull();
    expect(JSON.stringify(asBob)).not.toContain(ALICE);
  });

  it("refuses a capacity that is not an integer from 1 to 1536", async () => {
    for (const totalSlots of [0, -1, 1.5, "8", 1537, 1e9, Number.MAX_SAFE_INTEGER + 2, null, undefined]) {
      expect((await createWith({ ...GOOD, totalSlots })).statusCode, String(totalSlots)).toBe(400);
    }
    expect((await createWith({ ...GOOD, totalSlots: 1536 })).statusCode).toBe(200);
  });

  it("refuses a minSlotsToRun outside 1..totalSlots", async () => {
    for (const minSlotsToRun of [0, 9, 1.5, "2"]) {
      expect((await createWith({ ...GOOD, minSlotsToRun })).statusCode, String(minSlotsToRun)).toBe(400);
    }
    expect((await createWith({ ...GOOD, minSlotsToRun: 8 })).statusCode).toBe(200);
  });

  it("accepts only a non-negative price with at most 6 decimals, as a string or a number", async () => {
    for (const pricePerSlot of ["-1", "abc", "1.1234567", "", " 1", "1e3", -1, Number.NaN, Infinity, null]) {
      expect((await createWith({ ...GOOD, pricePerSlot })).statusCode, String(pricePerSlot)).toBe(400);
    }
    const asNumber = await createWith({ ...GOOD, pricePerSlot: 1.5 });
    expect(asNumber.statusCode).toBe(200);
    expect(asNumber.json().batch.pricePerSlot).toBe("1.5");
  });

  it("refuses a bad currency, closesAt, or over-long text field", async () => {
    expect((await createWith({ ...GOOD, currency: "usdc" })).statusCode).toBe(400);
    expect((await createWith({ ...GOOD, closesAt: "tomorrow" })).statusCode).toBe(400);
    expect((await createWith({ ...GOOD, kernelId: "k".repeat(201) })).statusCode).toBe(400);
    expect((await createWith({ ...GOOD, protocolType: 7 })).statusCode).toBe(400);
  });
});

describe("N49 round 2: claim input", () => {
  it("refuses supplied preferredIndices that are not an array of slotCount entries (never auto-assigns instead)", async () => {
    const id = await createBatch(alice, 4);
    for (const preferredIndices of ["0,1", { 0: 1 }, 5, [0], [0, 1, 2], null]) {
      const res = await claim(id, alice, { slotCount: 2, preferredIndices });
      expect(res.statusCode, JSON.stringify(preferredIndices)).toBe(400);
    }
    expect(await claimCount(id)).toBe(0);
  });

  it("accepts at most slotCount sample labels of at most 200 characters, and pads the rest", async () => {
    const id = await createBatch(alice, 8);
    for (const sampleLabels of ["a", [1, 2], ["a", "b", "c"], ["x".repeat(201)], { a: 1 }]) {
      const res = await claim(id, alice, { slotCount: 2, sampleLabels });
      expect(res.statusCode, JSON.stringify(sampleLabels)).toBe(400);
    }
    expect(await claimCount(id)).toBe(0);
    const ok = await claim(id, alice, { slotCount: 2, sampleLabels: ["only-one"] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().claim.sampleLabels).toEqual(["only-one", "sample-1"]);
  });
});

describe("N49 round 2: what someone else's claim shows", () => {
  it("gives a non-owner the taken slots and status only: no claim id, amount, escrow or time", async () => {
    const id = await createBatch();
    const mine = (await claim(id, alice, { slotCount: 2 })).json().claim;

    const asBob = (await app.inject({ method: "GET", url: `/api/batches/shared/${id}`, headers: auth(bob) })).json();
    expect(asBob.batch.claimedSlots[0]).toEqual({ slotIndices: [0, 1], status: "claimed", agentId: null, sampleLabels: [], own: false });
    expect(JSON.stringify(asBob)).not.toContain(mine.id);

    const asAlice = (await app.inject({ method: "GET", url: `/api/batches/shared/${id}`, headers: auth(alice) })).json();
    expect(asAlice.batch.claimedSlots[0]).toMatchObject({ id: mine.id, amount: "3.00", own: true });
  });
});

describe("N49 round 2: the legacy batch-manifest routes", () => {
  function assembling() {
    return batchTracker.createBatch("kernel-lab", "dev-1", "cap-1", {}).id;
  }
  function addSample(batchId: string, key: string, payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: `/api/batches/${batchId}/slots`, headers: auth(key), payload });
  }
  const SAMPLE = { position: "A1", jobId: "job-a", stepId: "step-1", sampleLabel: "patient-7731-serum" };

  it("adds a sample as the caller and refuses a body userId naming anyone else", async () => {
    const batchId = assembling();
    const forged = await addSample(batchId, alice, { ...SAMPLE, userId: BOB });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error).toBe("agent_mismatch");

    const ok = await addSample(batchId, alice, SAMPLE);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().slot).toMatchObject({ userId: ALICE, sampleLabel: "patient-7731-serum", own: true });
    expect(batchTracker.getBatch(batchId)!.slots).toHaveLength(1);
  });

  it("refuses malformed sample fields", async () => {
    const batchId = assembling();
    for (const bad of [{ position: "" }, { jobId: 7 }, { sampleLabel: "x".repeat(201) }, { sampleType: "plasma" }]) {
      const res = await addSample(batchId, alice, { ...SAMPLE, ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(batchTracker.getBatch(batchId)!.slots).toHaveLength(0);
  });

  it("shows each viewer only their own samples' owner, label, job and results on list, detail, events and by-job", async () => {
    const batchId = assembling();
    await addSample(batchId, alice, SAMPLE);
    await addSample(batchId, bob, { ...SAMPLE, position: "A2", jobId: "job-b", sampleLabel: "bob-sample" });

    const detail = (await app.inject({ method: "GET", url: `/api/batches/${batchId}`, headers: auth(bob) })).json();
    const [aliceSlot, bobSlot] = detail.batch.slots;
    expect(aliceSlot).toMatchObject({ position: "A1", own: false });
    expect(aliceSlot).not.toHaveProperty("userId");
    expect(aliceSlot).not.toHaveProperty("sampleLabel");
    expect(aliceSlot).not.toHaveProperty("jobId");
    expect(bobSlot).toMatchObject({ userId: BOB, sampleLabel: "bob-sample", own: true });
    const aliceEvents = detail.events.filter((e: { slotId?: string }) => e.slotId === aliceSlot.id);
    expect(aliceEvents.length).toBeGreaterThan(0);
    for (const e of aliceEvents) expect(e.payload).toEqual({});

    for (const url of ["/api/batches", `/api/batches/by-job/job-a`, `/api/batches/${batchId}`]) {
      const body = JSON.stringify((await app.inject({ method: "GET", url, headers: auth(bob) })).json());
      expect(body, url).not.toContain(ALICE);
      expect(body, url).not.toContain("patient-7731");
    }
  });

  it("answers 404 for an unknown batch", async () => {
    const res = await app.inject({ method: "GET", url: "/api/batches/batch-none", headers: auth(alice) });
    expect(res.statusCode).toBe(404);
  });
});
