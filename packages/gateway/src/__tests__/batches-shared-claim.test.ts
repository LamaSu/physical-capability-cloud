import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { batchRoutes, _clearSharedBatchesForTests, _setSharedBatchLimitsForTests } from "../routes/batches.js";
import { batchTracker } from "../services.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { schema } from "@pcc/store";

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
let carol: string;

const ALICE = "alice@example.com"; // operates kernel-lab
const BOB = "bob@example.com"; // operates kernel-other
const CAROL = "carol@example.com"; // operates nothing

/** Kernels, capabilities and jobs the legacy batch routes check against (round 3). */
function seedLab() {
  const { db } = getStore();
  const now = new Date().toISOString();
  for (const [id, operator] of [["kernel-lab", ALICE], ["kernel-other", BOB]] as const) {
    db.insert(schema.shopKernels).values({
      id, name: id, operatorAddress: operator, location: { lat: 0, lng: 0 }, physicalAddress: "1 Lab St",
      maxAssuranceTier: 2, publicKey: "pk", reputation: 0, totalJobsCompleted: 0, status: "online",
      registeredAt: now, lastHeartbeat: now, version: "1",
    } as any).run();
    getRepos().capabilities.insert({
      id: `cap-${id}`, kernelId: id, type: "liquid-handling", name: id, description: "", location: { lat: 0, lng: 0 },
      pricing: { currency: "USDC", baseCost: "1", minimum: "1" }, materials: [], assuranceTiers: [0], availability: {},
    } as any);
  }
  for (const [jobId, kernelId] of [["job-a", "kernel-lab"], ["job-b", "kernel-lab"], ["job-x", "kernel-other"]]) {
    db.insert(schema.jobs).values({
      id: jobId, stepId: "step-1", cwmId: `cwm-${jobId}`, capabilityId: `cap-${kernelId}`, kernelId,
      status: "queued", assignedDevices: [], progress: 0,
    } as any).run();
  }
}

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
  carol = provisionApiKey({ operatorId: CAROL }).rawKey;
  seedLab();
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
    expect(body.claim.amount).toBe("3"); // N49 F6: honest full-precision display amount
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
  it("answers another caller exactly as for a missing claim (404), and 200 to the claimant", async () => {
    const id = await createBatch();
    const claimId = (await claim(id, alice, { slotCount: 1 })).json().claim.id;

    const byBob = await app.inject({ method: "DELETE", url: `/api/batches/shared/${id}/claim/${claimId}`, headers: auth(bob) });
    const missing = await app.inject({ method: "DELETE", url: `/api/batches/shared/${id}/claim/claim-none`, headers: auth(bob) });
    expect(byBob.statusCode).toBe(404);
    expect(byBob.json()).toEqual(missing.json()); // no existence oracle
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

  it("round 3: refuses explicit nulls, whitespace-only text, and a number price that would need rounding", async () => {
    for (const bad of [
      { minSlotsToRun: null }, { currency: null }, { kernelId: "   " }, { capabilityType: " \t" },
      { pricePerSlot: 1.1234567 }, { pricePerSlot: 0.0000001 }, { pricePerSlot: 0.1 + 0.2 },
    ]) {
      expect((await createWith({ ...GOOD, ...bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await createWith({ ...GOOD, pricePerSlot: "0010.500000" })).json().batch.pricePerSlot).toBe("10.5");
    expect((await createWith({ ...GOOD, pricePerSlot: 2.675 })).json().batch.pricePerSlot).toBe("2.675");
  });

  it("round 3: closesAt is a real UTC calendar time, in the future and at most 30 days away", async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000);
    const day = soon.toISOString().slice(0, 10);
    for (const closesAt of [
      "0", "Oct 1 2026", day, `${day}T24:30:00Z`, `${day}T12:60:00Z`, `${day}T12:00:00+02:00`,
      new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 31 * 86_400_000).toISOString(), 1234, null,
    ]) {
      expect((await createWith({ ...GOOD, closesAt })).statusCode, String(closesAt)).toBe(400);
    }
    expect((await createWith({ ...GOOD, closesAt: `${day}T12:00:00Z` })).statusCode).toBe(200);
  });

  it("round 3: a batch past its closesAt takes no claims and leaves the open list", async () => {
    const id = (await createWith({ ...GOOD, closesAt: new Date(Date.now() + 1200).toISOString() })).json().batch.id;
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const late = await claim(id, bob, { slotCount: 1 });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("batch_closed");
    const open = (await app.inject({ method: "GET", url: "/api/batches/shared/open", headers: auth(bob) })).json();
    expect(open.batches.map((b: { id: string }) => b.id)).not.toContain(id);
  });

  it("round 3: one creator holds at most 20 open batches", async () => {
    for (let i = 0; i < 20; i++) expect((await createWith(GOOD, bob)).statusCode).toBe(200);
    const over = await createWith(GOOD, bob);
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe("too_many_open_batches");
    expect((await createWith(GOOD, alice)).statusCode).toBe(200);
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
    for (const sampleLabels of ["a", [1, 2], ["a", "b", "c"], ["x".repeat(201)], { a: 1 }, ["   "], ["ok", "   "]]) {
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
    expect(asAlice.batch.claimedSlots[0]).toMatchObject({ id: mine.id, amount: "3", own: true });
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
    for (const bad of [{ position: "" }, { jobId: 7 }, { sampleLabel: "x".repeat(201) }, { sampleType: "plasma" }, { sampleLabel: "   " }]) {
      const res = await addSample(batchId, alice, { ...SAMPLE, ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(batchTracker.getBatch(batchId)!.slots).toHaveLength(0);
  });

  it("shows a non-owner positions and status only, and none of their sample events, on list, detail and by-job", async () => {
    const batchId = assembling();
    await addSample(batchId, alice, SAMPLE); // alice operates kernel-lab
    // A buyer's own sample, attached kernel-side: the tracker records its owner.
    batchTracker.addSample(batchId, { position: "A2", jobId: "job-b", stepId: "step-1", sampleLabel: "bob-sample", userId: BOB as any });
    const aliceSlotId = batchTracker.getBatch(batchId)!.slots[0].id;

    const detail = (await app.inject({ method: "GET", url: `/api/batches/${batchId}`, headers: auth(bob) })).json();
    const [aliceSlot, bobSlot] = detail.batch.slots;
    expect(aliceSlot).toEqual({ position: "A1", status: "pending", own: false }); // no id, type or timing
    expect(bobSlot).toMatchObject({ userId: BOB, sampleLabel: "bob-sample", own: true });
    expect(detail.events.every((e: { slotId?: string }) => e.slotId === undefined || e.slotId === bobSlot.id)).toBe(true);
    expect(detail.events.some((e: { slotId?: string }) => e.slotId === bobSlot.id)).toBe(true);
    expect(detail.events.find((e: { type: string }) => e.type === "batch_created")).toMatchObject({ payload: {} });

    for (const url of ["/api/batches", "/api/batches/by-job/job-a", `/api/batches/${batchId}`]) {
      const body = JSON.stringify((await app.inject({ method: "GET", url, headers: auth(bob) })).json());
      expect(body, url).not.toContain(ALICE);
      expect(body, url).not.toContain("patient-7731");
      expect(body, url).not.toContain(aliceSlotId);
    }
  });

  it("round 3: lets only the batch kernel's operator add samples, for a job step on that kernel", async () => {
    const batchId = assembling();
    const byBob = await addSample(batchId, bob, SAMPLE);
    expect(byBob.statusCode).toBe(403);
    expect(byBob.json().error).toBe("not_kernel_operator");
    for (const bad of [{ jobId: "job-none" }, { jobId: "job-x" }, { stepId: "step-2" }]) {
      const res = await addSample(batchId, alice, { ...SAMPLE, ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(batchTracker.getBatch(batchId)!.slots).toHaveLength(0);
    expect((await addSample("batch-none", alice, SAMPLE)).statusCode).toBe(404);

    expect((await addSample(batchId, alice, SAMPLE)).statusCode).toBe(200);
    batchTracker.seal(batchId);
    const sealed = await addSample(batchId, alice, { ...SAMPLE, position: "A3" });
    expect(sealed.statusCode).toBe(409);
    expect(sealed.json()).toEqual({ error: "batch_not_assembling", status: "sealed" });
  });

  it("round 3: never forwards the tracker's own error message", async () => {
    const batchId = assembling();
    const spy = vi.spyOn(batchTracker, "addSample").mockImplementationOnce(() => {
      throw new Error("internal detail: /srv/pcc/secret-path");
    });
    try {
      const res = await addSample(batchId, alice, SAMPLE);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "sample_not_added" });
    } finally {
      spy.mockRestore();
    }
  });

  it("round 3: by-job is no membership oracle", async () => {
    const batchId = assembling();
    await addSample(batchId, alice, SAMPLE);
    batchTracker.addSample(batchId, { position: "A2", jobId: "job-b", stepId: "step-1", sampleLabel: "bob-sample", userId: BOB as any });
    const byJob = async (jobId: string, key: string) =>
      (await app.inject({ method: "GET", url: `/api/batches/by-job/${jobId}`, headers: auth(key) })).json().batches.map((b: { id: string }) => b.id);
    expect(await byJob("job-a", alice)).toContain(batchId); // the operator of job-a's kernel
    expect(await byJob("job-b", bob)).toContain(batchId); // bob's own sample
    expect(await byJob("job-a", bob)).toEqual([]); // the same answer as a job with no batches
    expect(await byJob("job-a", carol)).toEqual([]);
    expect(await byJob("job-none", carol)).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/batches/by-job/job-a" })).statusCode).toBe(401);
  });

  it("answers 404 for an unknown batch", async () => {
    const res = await app.inject({ method: "GET", url: "/api/batches/batch-none", headers: auth(alice) });
    expect(res.statusCode).toBe(404);
  });
});

// ── gpt-5.6-sol round 3 findings ───────────────────────────────────────────
import { projectBatchStreamEvent } from "../sse/batch-stream-projection.js";

describe("N49 F1: the shared batch stream carries no per-sample data", () => {
  it("drops every per-sample event (slotId, timing, resultHash, resultRef)", () => {
    for (const type of ["sample_added", "sample_claimed", "sample_injecting", "sample_completed", "sample_failed"]) {
      const msg = projectBatchStreamEvent({
        type, batchId: "b1",
        payload: { slotId: "slot-alice", position: "A1", resultHash: "0xsecret", resultRef: "ipfs://x", timestamp: "t" },
      });
      expect(msg, type).toBeNull();
    }
  });
  it("passes batch-level events but only their aggregate fields", () => {
    const sealed = projectBatchStreamEvent({ id: "e1", type: "batch_sealed", timestamp: "t", batchId: "b1", payload: { slotCount: 12, secret: "x" } });
    expect(sealed?.payload).toEqual({ batchId: "b1", slotCount: 12 });
    const done = projectBatchStreamEvent({ id: "e2", type: "batch_completed", timestamp: "t", batchId: "b1", payload: { completed: 10, failed: 2, resultHash: "0xsecret" } });
    expect(done?.payload).toEqual({ batchId: "b1", completed: 10, failed: 2 });
  });
  it("drops an unlisted event type", () => {
    expect(projectBatchStreamEvent({ type: "batch_new_thing", batchId: "b1", payload: { x: 1 } })).toBeNull();
  });
  // Round 5: the projection now runs at the stream boundary on whatever any
  // publisher put on the batch topic, so it must judge every input without throwing.
  it("round 5: counts a payload that is not an object as no payload, instead of throwing", () => {
    for (const payload of ["raw-secret", ["raw-secret"], 7, true, null, undefined]) {
      expect(projectBatchStreamEvent({ type: "batch_sealed", batchId: "b1", payload })?.payload, String(payload)).toEqual({ batchId: "b1" });
    }
  });
  it("round 5: an event type that is a prototype key is not a listed type (null, not a throw)", () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(projectBatchStreamEvent({ type, batchId: "b1", payload: { completed: 1 } }), type).toBeNull();
    }
  });
  it("round 5: an aggregate field passes only as a whole-number count", () => {
    const done = (completed: unknown, failed: unknown) =>
      projectBatchStreamEvent({ type: "batch_completed", batchId: "b1", payload: { completed, failed } })?.payload;
    expect(done("patient-7731", { secret: 1 })).toEqual({ batchId: "b1" });
    for (const bad of [-1, 1.5, Number.NaN, Infinity, null, [3], "3"]) {
      expect(done(bad, bad), String(bad)).toEqual({ batchId: "b1" });
    }
    expect(done(0, 12)).toEqual({ batchId: "b1", completed: 0, failed: 12 });
  });
});

describe("N49 F2: the legacy manifest view never exposes runConfig", () => {
  it("omits runConfig (proprietary/customer params) from the public detail and list views", async () => {
    const manifest = batchTracker.createBatch("kernel-lab", "dev-1", "cap-1", { secretProtocol: "tenant-secret", ph: 7.4 });
    const detail = await app.inject({ method: "GET", url: `/api/batches/${manifest.id}`, headers: auth(alice) });
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(detail.json())).not.toContain("tenant-secret");
    expect(detail.json().batch.runConfig).toBeUndefined();
    const list = await app.inject({ method: "GET", url: "/api/batches", headers: auth(alice) });
    expect(JSON.stringify(list.json())).not.toContain("tenant-secret");
  });
});

describe("N49 F6: a six-decimal price yields an honest display amount, never 0.00", () => {
  it("computes 0.000001 * 3 = 0.000003 (not a two-decimal 0.00)", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/batches/shared", headers: auth(alice),
      payload: { kernelId: "kernel-lab", capabilityType: "liquid-handling", totalSlots: 8, pricePerSlot: "0.000001", protocolType: "dilution" },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().batch.id;
    const c = await claim(id, bob, { slotCount: 3 });
    expect(c.statusCode).toBe(200);
    expect(c.json().claim.amount).toBe("0.000003");
  });
});

// ── N49 round 5, F2: a terminal batch must not hold the store until closesAt ──
// Retention used to be measured from closesAt (up to 30 days away), and the
// per-creator limit counted only batches still open for claims. So one principal
// could create one-slot batches closing in 30 days, fill each, and keep the
// store at its global cap (batch_store_full, 503) for about 30 days.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("N49 r5 F2: terminal batches stop holding the store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A one-slot batch that closes far in the future and is filled at once by bob. */
  async function fillOneSlotBatch(closesAt: string, creator = alice): Promise<string> {
    const created = await createWith({ ...GOOD, totalSlots: 1, closesAt }, creator);
    expect(created.statusCode).toBe(200);
    const id = created.json().batch.id;
    const claimed = await claim(id, bob, { slotCount: 1 });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().batchStatus).toBe("full");
    return id;
  }

  it("a full batch leaves the global cap an hour after it filled, however far off its closesAt is", async () => {
    _setSharedBatchLimitsForTests({ maxSharedBatches: 4, maxBatchesPerCreator: 100 });
    vi.useFakeTimers({ toFake: ["Date"] }); // move the clock without waiting
    const start = Date.now();
    const closesAt = new Date(start + 29 * DAY).toISOString();
    for (let i = 0; i < 4; i++) await fillOneSlotBatch(closesAt);

    // The global cap holds while the filled batches are inside their retention hour.
    const full = await createWith({ ...GOOD, closesAt });
    expect(full.statusCode).toBe(503);
    expect(full.json().error).toBe("batch_store_full");
    vi.setSystemTime(start + 30 * MIN);
    expect((await createWith({ ...GOOD, closesAt })).statusCode).toBe(503);

    // An hour after they filled they may be pruned, though closesAt is still 29 days away.
    vi.setSystemTime(start + 2 * HOUR);
    const later = await createWith({ ...GOOD, closesAt });
    expect(later.statusCode).toBe(200);
  });

  it("one creator's limit counts every batch of theirs that is still retained, filled ones too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const closesAt = new Date(start + 29 * DAY).toISOString();
    for (let i = 0; i < 20; i++) await fillOneSlotBatch(closesAt, alice);

    const over = await createWith({ ...GOOD, closesAt }, alice);
    expect(over.statusCode).toBe(409);
    expect(over.json()).toEqual({ error: "too_many_open_batches", limit: 20 });
    expect((await createWith(GOOD, carol)).statusCode).toBe(200); // another creator is unaffected

    // An hour after they filled, they no longer count.
    vi.setSystemTime(start + HOUR + MIN);
    expect((await createWith({ ...GOOD, closesAt }, alice)).statusCode).toBe(200);
  });

  it("a batch whose only claim is released is claimable again, so it is not pruned as closed", async () => {
    _setSharedBatchLimitsForTests({ maxSharedBatches: 1 });
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const id = (await createWith({ ...GOOD, totalSlots: 1 })).json().batch.id; // closes in 24 h
    const claimed = (await claim(id, bob, { slotCount: 1 })).json();
    expect(claimed.batchStatus).toBe("full");
    const released = await app.inject({ method: "DELETE", url: `/api/batches/shared/${id}/claim/${claimed.claim.id}`, headers: auth(bob) });
    expect(released.json().batchStatus).toBe("open");

    vi.setSystemTime(start + 2 * HOUR); // it filled over an hour ago, but it is open now
    expect((await createWith(GOOD)).statusCode).toBe(503); // not prunable: still open and unexpired
    expect((await claim(id, bob, { slotCount: 1 })).statusCode).toBe(200);
  });

  it("keeps the retention bookkeeping out of the public batch view (viewBatch spreads the batch)", async () => {
    const id = await fillOneSlotBatch(new Date(Date.now() + 5 * DAY).toISOString());
    const view = (await app.inject({ method: "GET", url: `/api/batches/shared/${id}`, headers: auth(alice) })).json().batch;
    expect(Object.keys(view).sort()).toEqual([
      "capabilityType", "claimedSlots", "closesAt", "createdAt", "createdBy", "currency", "id", "kernelId",
      "minSlotsToRun", "pricePerSlot", "protocolType", "status", "totalSlots",
    ]);
    expect(view.status).toBe("full");
  });

  it("an open batch nobody filled is still kept for an hour after its closesAt and pruned after that", async () => {
    _setSharedBatchLimitsForTests({ maxSharedBatches: 1 });
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const id = (await createWith({ ...GOOD, closesAt: new Date(start + 2 * HOUR).toISOString() })).json().batch.id;

    vi.setSystemTime(start + 2 * HOUR + 30 * MIN); // closed half an hour ago
    expect((await claim(id, bob, { slotCount: 1 })).json().error).toBe("batch_closed");
    expect((await createWith(GOOD)).statusCode).toBe(503);

    vi.setSystemTime(start + 3 * HOUR + MIN); // closed over an hour ago
    expect((await createWith(GOOD)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/batches/shared/${id}`, headers: auth(bob) })).statusCode).toBe(404);
  });
});
