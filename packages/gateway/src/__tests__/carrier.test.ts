/**
 * Carrier route tests — authorization against the REAL job/kernel records
 * (seeded in-memory store + facades, not stubs), the guarded purchase
 * lifecycle (reserve -> buy_in_flight -> purchased_pending -> label_bought,
 * with getShipment recovery and reconciliation parking), and the webhook
 * receiver's full signature -> identity -> commitment-time -> ordering ->
 * lattice -> gated-evidence path. Webhook signatures are computed with real
 * HMAC-SHA256 (not stubbed).
 *
 * Scan timestamps are OFFSETS FROM NOW: commitments are minted at wall-clock
 * time and a scan predating its commitment is (correctly) refused, so
 * hardcoded past dates would trip the R3-4 gate in every test.
 *
 * Test names reference sol #297 finding numbers (rounds 1-3).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac, createHash } from "node:crypto";
import { verifyEventHash } from "@pcc/spec";
import { carrierRoutes } from "../routes/carrier.js";
import {
  EasyPostClient,
  EasyPostError,
  _setEasyPostClientForTests,
  verifyCommitmentHash,
  type BoughtShipment,
  type CreateLabelParams,
  type CreatedShipment,
  type EasyPostClientConfig,
  type FinalizedLabel,
} from "../services/easypost-client.js";
import {
  _resetCarrierShipmentStoreForTests,
  getCarrierShipmentStore,
  initCarrierShipmentStore,
  nextStatus,
} from "../services/carrier-shipment-store.js";
import { initStore, closeStore } from "../db.js";
import { getJobFacade, getKernelFacade } from "../facades/index.js";
import { computeCid, type ICidBlobStorage } from "../services/cid-blob-storage.js";

const WEBHOOK_SECRET = "whsec_test_carrier_suite";
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KERNEL = "kernel-hp-printer-test";
const JOB = "job-print-mail-1";
const documentHash = createHash("sha256").update("court filing.pdf").digest("hex");

const T0 = Date.now();
/** Carrier-clock timestamps as offsets from now — always AFTER the commitment minted during the test. */
const ts = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

const sign = (body: string) => "hmac-sha256-hex=" + createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex");

/** Hermetic content-addressed store for label bytes (no disk). */
function memBlobStore(): ICidBlobStorage {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(bytes, opts) {
      const cid = computeCid(bytes);
      blobs.set(cid, bytes);
      return { cid, sizeBytes: bytes.length, mediaType: opts?.mediaType ?? "application/octet-stream", backend: "local", storedAt: new Date().toISOString() };
    },
    async get(cid) {
      const b = blobs.get(cid);
      if (!b) throw new Error("not found");
      return b;
    },
    async getRange(cid, start, end) {
      return (await this.get(cid)).slice(start, end);
    },
    async exists(cid) {
      return blobs.has(cid);
    },
  };
}

function testClient(extra: Partial<EasyPostClientConfig> = {}): EasyPostClient {
  return new EasyPostClient({ webhookSecret: WEBHOOK_SECRET, blobStore: memBlobStore(), ...extra });
}

/** Test app: carrier routes + a stand-in for apiGate that maps X-Test-Operator -> req.operatorId. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-operator"];
    if (typeof h === "string" && h) (req as unknown as { operatorId?: string }).operatorId = h;
  });
  await app.register(carrierRoutes);
  await app.ready();
  return app;
}

const validBody = {
  jobId: JOB,
  kernelId: KERNEL,
  documentHash,
  toAddress: { name: "Court Clerk", street1: "60 Centre St", city: "New York", state: "NY", zip: "10007" },
  fromAddress: { name: "PCC Operator", street1: "1 Shop Way", city: "San Francisco", state: "CA", zip: "94103" },
  parcel: { weightOz: 2 },
};
const asOwner = { "x-test-operator": OWNER };

/** Webhook body builder. Passes the tracker id by default because every purchase records one, and the route rejects tracker-less scans for such purchases. */
function trackerEvent(
  bought: { trackingCode: string; trackerId: string | null; shipmentId: string | null },
  status: string,
  id: string,
  updatedAt: string,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    id,
    description: "tracker.updated",
    result: {
      id: bought.trackerId ?? undefined,
      shipment_id: bought.shipmentId ?? undefined,
      tracking_code: bought.trackingCode,
      status,
      carrier: "USPS",
      updated_at: updatedAt,
      ...extra,
    },
  });
}

async function postWebhook(app: FastifyInstance, body: string) {
  return app.inject({
    method: "POST",
    url: "/api/carrier/webhook/easypost",
    payload: body,
    headers: { "content-type": "application/json", "x-hmac-signature": sign(body) },
  });
}

async function buyViaRoute(app: FastifyInstance) {
  const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
  expect(res.statusCode).toBe(201);
  return res.json() as { trackingCode: string; trackerId: string | null; shipmentId: string | null; labelCid: string; labelFetch: string };
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  const k = await getKernelFacade().register(
    { id: KERNEL, name: "HP printer test kernel", operatorAddress: OWNER, location: { lat: 37.77, lng: -122.42 }, physicalAddress: "1 Shop Way", maxAssuranceTier: 2 } as never,
    OWNER,
  );
  if (!k.success) throw new Error(`kernel register failed: ${JSON.stringify(k.error)}`);
  const j = await getJobFacade().submit({ jobId: JOB, stepId: "step-print-mail", kernelId: KERNEL, capabilityId: "cap-test-print-mail" }, OWNER);
  if (!j.success) throw new Error(`job submit failed: ${JSON.stringify(j.error)}`);
  const j2 = await getJobFacade().submit({ jobId: "job-on-other-kernel", stepId: "s", kernelId: "kernel-somebody-else", capabilityId: "cap-x" }, STRANGER);
  if (!j2.success) throw new Error(`job2 submit failed: ${JSON.stringify(j2.error)}`);
  const j3 = await getJobFacade().submit({ jobId: "job-completed", stepId: "s", kernelId: KERNEL, capabilityId: "cap-test-print-mail" }, OWNER);
  if (!j3.success) throw new Error(`job3 submit failed: ${JSON.stringify(j3.error)}`);
  const done = await getJobFacade().updateStatus("job-completed", "completed");
  if (!done.success) throw new Error(`job3 complete failed: ${JSON.stringify(done.error)}`);
});

afterAll(() => closeStore());

beforeEach(() => {
  _resetCarrierShipmentStoreForTests();
  initCarrierShipmentStore({});
  _setEasyPostClientForTests(testClient());
});

afterEach(() => {
  _resetCarrierShipmentStoreForTests();
  _setEasyPostClientForTests(undefined);
});

describe("GET /api/carrier/healthz", () => {
  it("reports mock mode, webhook config, durability, ceilings, and reconciliation counts", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/carrier/healthz" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        ok: true,
        mock: true,
        webhookConfigured: true,
        durable: false, // in-memory in tests — production boot refuses this
        maxRateUsd: 25,
        maxWeightOz: 70,
        pendingFinalize: 0,
        needsReconciliation: 0,
      });
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/carrier/shipments — authorization (findings 3/4)", () => {
  it("401s without a caller identity", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("400s with details when required fields (incl. documentHash) are missing", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: { jobId: JOB }, headers: asOwner });
      expect(res.statusCode).toBe(400);
      expect(res.json().details.join(" ")).toContain("documentHash");
    } finally {
      await app.close();
    }
  });

  it("404s for a jobId that does not exist in the job store (never trusts the body)", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: { ...validBody, jobId: "job-does-not-exist" }, headers: asOwner });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("job_not_found");
    } finally {
      await app.close();
    }
  });

  it("409s when the body's kernelId is not the job's assigned kernel", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: { ...validBody, kernelId: "kernel-somebody-else" }, headers: asOwner });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("kernel_mismatch");
    } finally {
      await app.close();
    }
  });

  it("409s for a job that is no longer active — a completed job must not spend", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: { ...validBody, jobId: "job-completed" }, headers: asOwner });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("job_not_active");
    } finally {
      await app.close();
    }
  });

  it("403s when the caller is not the kernel's operator — a stranger cannot buy postage under a victim job", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: { "x-test-operator": STRANGER } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("not_kernel_operator");
      expect(getCarrierShipmentStore().size()).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/carrier/shipments — guarded purchase lifecycle", () => {
  it("buys a (mock) label and returns a verifiable commitment with labelCid", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ jobId: JOB, kernelId: KERNEL, mock: true, providerMode: "mock", status: "label_bought" });
      expect(body.commitment).toMatchObject({ jobId: JOB, kernelId: KERNEL, documentHash, mock: true, providerMode: "mock", signature: null });
      expect(body.labelFetch).toBe(`/api/storage/${body.labelCid}`);
      expect(verifyCommitmentHash(body.commitment)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns the SAME shipment (200) on an identical re-request — no second purchase", async () => {
    const app = await buildApp();
    try {
      const first = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      const second = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json().trackingCode).toBe(first.json().trackingCode);
      expect(getCarrierShipmentStore().size()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("409s on the same jobId with DIFFERENT parameters instead of silently reusing the old label (finding 12)", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      const changed = { ...validBody, toAddress: { ...validBody.toAddress, street1: "1 Attacker Ave" } };
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: changed, headers: asOwner });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("idempotency_conflict");
    } finally {
      await app.close();
    }
  });

  it("two CONCURRENT buys for one jobId yield exactly one charge (round-2 NEW-6)", async () => {
    let buys = 0;
    class SlowBuy extends EasyPostClient {
      override async buyRate(c: CreatedShipment): Promise<BoughtShipment> {
        buys++;
        await new Promise((r) => setTimeout(r, 30));
        return super.buyRate(c);
      }
    }
    _setEasyPostClientForTests(new SlowBuy({ webhookSecret: WEBHOOK_SECRET, blobStore: memBlobStore() }));
    const app = await buildApp();
    try {
      const [a, b] = await Promise.all([
        app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner }),
        app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      // The loser either waits on the purchase lock and observes the winner's
      // completed purchase (200 already-bought) or hits the reservation
      // window (409 job_in_flight). Either way: EXACTLY one charge.
      expect(codes[0] === 200 || codes[0] === 201).toBe(true);
      expect([[200, 201].includes(codes[0]!), [201, 409].includes(codes[1]!)]).toEqual([true, true]);
      expect(codes).toContain(201);
      expect(buys).toBe(1);
      expect(getCarrierShipmentStore().size()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("a finalize failure NEVER causes a second charge: the identical retry finalizes the recorded purchase (round-2 NEW-2)", async () => {
    let buys = 0;
    let finalizeAttempts = 0;
    class FlakyFinalize extends EasyPostClient {
      override async buyRate(c: CreatedShipment): Promise<BoughtShipment> {
        buys++;
        return super.buyRate(c);
      }
      override async finalizeLabel(p: CreateLabelParams, bought: BoughtShipment): Promise<FinalizedLabel> {
        finalizeAttempts++;
        if (finalizeAttempts === 1) throw new Error("blob store hiccup");
        return super.finalizeLabel(p, bought);
      }
    }
    _setEasyPostClientForTests(new FlakyFinalize({ webhookSecret: WEBHOOK_SECRET, blobStore: memBlobStore() }));
    const app = await buildApp();
    try {
      const first = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(first.statusCode).toBe(502);
      expect(first.json()).toMatchObject({ error: "purchase_recorded_finalize_failed", retry: true });
      const rec = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(rec.status).toBe("purchased_pending"); // the charge is RECORDED, not lost
      expect(getCarrierShipmentStore().listPendingFinalize()).toHaveLength(1);

      const retry = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(retry.statusCode).toBe(201);
      expect(retry.json().note).toContain("finalized a previously recorded purchase");
      expect(retry.json().trackingCode).toBe(rec.trackingCode); // SAME purchase
      expect(buys).toBe(1); // exactly one charge across both requests
      expect(getCarrierShipmentStore().getByJobId(JOB)!.status).toBe("label_bought");
    } finally {
      await app.close();
    }
  });

  it("an AMBIGUOUS /buy outcome stays buy_in_flight; the retry asks EasyPost and finds the purchase WAS made — no second charge (R3-1)", async () => {
    let buyCalls = 0;
    class AmbiguousThenRecovered extends EasyPostClient {
      override async buyRate(c: CreatedShipment): Promise<BoughtShipment> {
        buyCalls++;
        // The charge "happened" at EasyPost, but we never saw the response.
        throw new EasyPostError("easypost_buy_ambiguous", null, "socket hang up after dispatch");
      }
      // Recovery lookup finds the purchase EasyPost recorded (mock base returns bought).
    }
    _setEasyPostClientForTests(new AmbiguousThenRecovered({ webhookSecret: WEBHOOK_SECRET, blobStore: memBlobStore() }));
    const app = await buildApp();
    try {
      const first = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(first.statusCode).toBe(502);
      expect(first.json()).toMatchObject({ error: "buy_ambiguous_retry_to_recover", retry: true });
      expect(getCarrierShipmentStore().getByJobId(JOB)!.status).toBe("buy_in_flight"); // NOT released (R3-1)

      const retry = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(retry.statusCode).toBe(201);
      expect(retry.json().note).toContain("recovered a dispatched purchase");
      expect(buyCalls).toBe(1); // recovery NEVER re-dispatched /buy
      expect(getCarrierShipmentStore().getByJobId(JOB)!.status).toBe("label_bought");
    } finally {
      await app.close();
    }
  });

  it("an AMBIGUOUS /buy where EasyPost shows NO purchase re-buys safely on retry — exactly one eventual charge (R3-1)", async () => {
    let buyCalls = 0;
    let lookups = 0;
    class AmbiguousThenUnbought extends EasyPostClient {
      override async buyRate(c: CreatedShipment): Promise<BoughtShipment> {
        buyCalls++;
        if (buyCalls === 1) throw new EasyPostError("easypost_buy_ambiguous", null, "socket hang up before dispatch completed");
        return super.buyRate(c);
      }
      override async getShipment(_c: CreatedShipment): Promise<{ bought: BoughtShipment | null }> {
        lookups++;
        return { bought: null }; // EasyPost shows no charge for the created shipment
      }
    }
    _setEasyPostClientForTests(new AmbiguousThenUnbought({ webhookSecret: WEBHOOK_SECRET, blobStore: memBlobStore() }));
    const app = await buildApp();
    try {
      expect((await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner })).statusCode).toBe(502);
      const retry = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(retry.statusCode).toBe(201);
      expect(lookups).toBe(1);
      expect(buyCalls).toBe(2); // one failed dispatch, one real charge — never two charges
    } finally {
      await app.close();
    }
  });

  it("a KNOWN post-charge defect parks as reconciliation_required and is never auto-retried (R3-1/R3-10)", async () => {
    let buyCalls = 0;
    class UnusableBuy extends EasyPostClient {
      override async buyRate(_c: CreatedShipment): Promise<BoughtShipment> {
        buyCalls++;
        throw new EasyPostError("easypost_bought_but_unusable", null, "charged but no tracking code");
      }
    }
    _setEasyPostClientForTests(new UnusableBuy({ webhookSecret: WEBHOOK_SECRET, blobStore: memBlobStore() }));
    const app = await buildApp();
    try {
      const first = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(first.statusCode).toBe(409);
      expect(first.json()).toEqual({ error: "reconciliation_required", reason: "easypost_bought_but_unusable" });
      const rec = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(rec.status).toBe("reconciliation_required");
      expect(getCarrierShipmentStore().listNeedsReconciliation()).toHaveLength(1);

      const retry = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(retry.statusCode).toBe(409);
      expect(retry.json().error).toBe("reconciliation_required");
      expect(buyCalls).toBe(1); // a parked purchase is a HUMAN decision, never an auto-retry
    } finally {
      await app.close();
    }
  });

  it("an existing record bought by a DIFFERENT principal is never recovered/read via POST after re-ownership (R5-1)", async () => {
    const app = await buildApp();
    try {
      await buyViaRoute(app);
      // Simulate an ownership hand-over having happened: the stored record's
      // owner is no longer the kernel's current operator.
      const rec = getCarrierShipmentStore().getByJobId(JOB)!;
      (rec as { ownerId: string }).ownerId = STRANGER;
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("carrier_record_ownership_mismatch");
    } finally {
      await app.close();
    }
  });

  it("authorization is re-judged INSIDE the purchase lock — a job completed while queued must not spend (R5-2)", async () => {
    class SlowBuy extends EasyPostClient {
      override async buyRate(c: CreatedShipment): Promise<BoughtShipment> {
        await new Promise((r) => setTimeout(r, 60));
        return super.buyRate(c);
      }
    }
    _setEasyPostClientForTests(new SlowBuy({ webhookSecret: WEBHOOK_SECRET, blobStore: memBlobStore() }));
    const app = await buildApp();
    try {
      const first = app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      await new Promise((r) => setTimeout(r, 10)); // first is inside buyRate, holding the purchase lock
      const secondP = app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      await new Promise((r) => setTimeout(r, 10));
      await getJobFacade().updateStatus(JOB, "cancelled"); // job dies while second waits in the queue
      const [a, b] = await Promise.all([first, secondP]);
      try {
        // The queued request must re-check and refuse — or, if it slipped in
        // before observing the winner's record, observe it; it must NEVER
        // start a NEW purchase against the now-cancelled job.
        const codes = [a.statusCode, b.statusCode].sort();
        expect(codes[0]).toBe(201); // the first request, authorized while active
        expect([200, 409]).toContain(codes[1]);
        if (codes[1] === 409) expect(["job_not_active", "job_in_flight"]).toContain(b.json().error ?? a.json().error);
        expect(getCarrierShipmentStore().size()).toBe(1);
      } finally {
        await getJobFacade().updateStatus(JOB, "queued"); // restore for other tests
      }
    } finally {
      await app.close();
    }
  });

  it("an EXPIRED runtime reservation is reclaimed by the next request — no restart needed (R3-9)", async () => {
    _resetCarrierShipmentStoreForTests();
    initCarrierShipmentStore({ reservationTtlMs: 1 }); // everything expires ~immediately
    const app = await buildApp();
    try {
      // Simulate a crash between reserve and dispatch: a bare reservation left behind.
      getCarrierShipmentStore().reserve({ jobId: JOB, kernelId: KERNEL, ownerId: OWNER, requestFingerprint: "does-not-matter-it-expired" });
      await new Promise((r) => setTimeout(r, 10));
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(res.statusCode).toBe(201); // reclaimed + purchased, not 409-until-restart
      expect(getCarrierShipmentStore().getByJobId(JOB)!.status).toBe("label_bought");
    } finally {
      await app.close();
    }
  });

  it("a recovery that cannot RECORD the confirmed purchase parks it — never a plain 502 that hides a charge (R3-1 residual)", async () => {
    let buyCalls = 0;
    class AmbiguousBuy extends EasyPostClient {
      override async buyRate(_c: CreatedShipment): Promise<BoughtShipment> {
        buyCalls++;
        throw new EasyPostError("easypost_buy_ambiguous", null, "hang up");
      }
      override async getShipment(_c: CreatedShipment): Promise<{ bought: BoughtShipment | null }> {
        // Recovery confirms a purchase whose tracking code is ALREADY TAKEN
        // by another job -> markPurchased will fail with duplicate_tracking_code.
        return { bought: { shipmentId: _c.shipmentId, trackerId: "trk_x", trackingCode: "EZTAKEN0001", labelUrl: "https://easypost-mock.invalid/l.png", carrier: "USPS", service: "First", rate: "1.00", currency: "USD", providerMode: "mock", mock: true } };
      }
    }
    _setEasyPostClientForTests(new AmbiguousBuy({ webhookSecret: WEBHOOK_SECRET, blobStore: memBlobStore() }));
    const app = await buildApp();
    try {
      // Occupy the tracking code under a different job first.
      const store = getCarrierShipmentStore();
      store.reserve({ jobId: "job-occupier", kernelId: KERNEL, ownerId: OWNER, requestFingerprint: "x" });
      await store.markBuyInFlight("job-occupier", { shipmentId: "shp_occ", providerMode: "mock", rateId: "r", carrier: "USPS", service: "First", rate: "1", currency: "USD", mock: true });
      await store.markPurchased("job-occupier", { shipmentId: "shp_occ", trackerId: "trk_occ", trackingCode: "EZTAKEN0001", labelUrl: "https://easypost-mock.invalid/o.png", carrier: "USPS", service: "First", rate: "1", currency: "USD", providerMode: "mock", mock: true });

      expect((await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner })).statusCode).toBe(502);
      const retry = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(retry.statusCode).toBe(409);
      expect(retry.json()).toMatchObject({ error: "reconciliation_required", reason: "record_failed:duplicate_tracking_code" });
      expect(getCarrierShipmentStore().getByJobId(JOB)!.status).toBe("reconciliation_required");
      expect(buyCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("maps ceiling violations to 400 with a stable code, and the reservation is released (findings 11/14)", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: { ...validBody, parcel: { weightOz: 999 } }, headers: asOwner });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "weight_exceeds_ceiling" });
      expect(getCarrierShipmentStore().size()).toBe(0); // pre-charge failure -> released
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/carrier/shipments/:jobId — owner-only (finding 4)", () => {
  it("returns the record to its owner and 404 (not 403 — no existence oracle) to anyone else", async () => {
    const app = await buildApp();
    try {
      await buyViaRoute(app);
      const mine = await app.inject({ method: "GET", url: `/api/carrier/shipments/${JOB}`, headers: asOwner });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().labelUrl).toBeTruthy();
      const theirs = await app.inject({ method: "GET", url: `/api/carrier/shipments/${JOB}`, headers: { "x-test-operator": STRANGER } });
      expect(theirs.statusCode).toBe(404);
      const anon = await app.inject({ method: "GET", url: `/api/carrier/shipments/${JOB}` });
      expect(anon.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("exposes the evidence seam (owner-only) the kernel folds into its signed bundle (round-2 NEW-9)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      await postWebhook(app, trackerEvent(bought, "in_transit", "evt_e1", ts(1)));
      const mine = await app.inject({ method: "GET", url: `/api/carrier/shipments/${JOB}/evidence`, headers: asOwner });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().events).toHaveLength(1);
      expect(mine.json().events[0].type).toBe("courier_pickup_confirmed");
      const theirs = await app.inject({ method: "GET", url: `/api/carrier/shipments/${JOB}/evidence`, headers: { "x-test-operator": STRANGER } });
      expect(theirs.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("status lattice (finding 7)", () => {
  it("is monotonic with terminal states, and pre-purchase states are not trackable", () => {
    expect(nextStatus("in_transit", "label_bought")).toBe("in_transit");
    expect(nextStatus("in_transit", "in_transit")).toBeNull();
    expect(nextStatus("delivered", "in_transit")).toBe("delivered");
    expect(nextStatus("in_transit", "delivered")).toBeNull(); // no regression
    expect(nextStatus("delivered", "return_to_sender")).toBeNull(); // RTS terminal; later 'delivered' = delivery back to sender
    expect(nextStatus("in_transit", "failed")).toBeNull();
    expect(nextStatus("pre_transit", "label_bought")).toBeNull();
    expect(nextStatus("unknown", "label_bought")).toBeNull();
    expect(nextStatus("in_transit", "reserved")).toBeNull();
    expect(nextStatus("in_transit", "buy_in_flight")).toBeNull();
    expect(nextStatus("in_transit", "purchased_pending")).toBeNull();
    expect(nextStatus("in_transit", "reconciliation_required")).toBeNull();
  });
});

describe("POST /api/carrier/webhook/easypost", () => {
  it("503s when no webhook secret is configured", async () => {
    _setEasyPostClientForTests(testClient({ webhookSecret: undefined }));
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/webhook/easypost", payload: "{}", headers: { "content-type": "application/json", "x-hmac-signature": "x" } });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("401s on an invalid signature", async () => {
    const app = await buildApp();
    try {
      const body = trackerEvent({ trackingCode: "X", trackerId: null, shipmentId: null }, "in_transit", "evt", ts(1));
      const res = await app.inject({ method: "POST", url: "/api/carrier/webhook/easypost", payload: body, headers: { "content-type": "application/json", "x-hmac-signature": "hmac-sha256-hex=deadbeef" } });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("applies a signed in_transit scan and emits a byte-verifiable, recomputable, GATED EvidenceEvent (finding 2 / NEW-8 / R3-7)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const body = trackerEvent(bought, "in_transit", "evt_pickup_1", ts(1), {
        status_detail: "arrived_at_destination_facility",
        tracking_details: [{ message: "Accepted at USPS Origin Facility", status: "in_transit", datetime: ts(1), tracking_location: { city: "SAN FRANCISCO", state: "CA", zip: "94103", country: "US" } }],
      });
      const res = await postWebhook(app, body);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ matched: true, status: "in_transit", outcome: "applied" });

      const record = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(record.status).toBe("in_transit");
      expect(record.events).toHaveLength(1);
      const event = record.events[0]!;
      expect(event.type).toBe("courier_pickup_confirmed");
      expect(event.source).toMatchObject({ deviceType: "courier_api", kernelId: KERNEL, simulated: true }); // mock purchase -> simulated
      expect(event.payload.trackingLocation).toEqual({ city: "SAN FRANCISCO", state: "CA", zip: "94103", country: "US" });
      expect(event.payload.carrierMessage).toBe("Accepted at USPS Origin Facility");
      expect(Buffer.from(event.payload.providerRawBodyB64 as string, "base64").toString("utf8")).toBe(body);
      expect(event.payload.providerSignatureHeader).toBe(sign(body));
      expect(event.payload.providerEventId).toBe("evt_pickup_1");
      // Split verification results: the hash recomputes; with no signing key
      // configured there is no attestation — and the payload says so.
      expect(event.payload.commitmentHashValid).toBe(true);
      expect(event.payload.commitmentSignatureVerified).toBe(false);
      expect((event.payload.commitment as { labelCid: string }).labelCid).toBe(bought.labelCid);
      expect(await verifyEventHash(event)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("REFUSES to emit evidence when the commitment identity has been corrupted — 500, provider retries (R3-7)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const record = getCarrierShipmentStore().getByJobId(JOB)!;
      (record.commitment as { jobId: string }).jobId = "job-somebody-else"; // simulated corruption/tamper
      const res = await postWebhook(app, trackerEvent(bought, "in_transit", "evt_gate", ts(1)));
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("apply_failed");
      expect(record.events).toHaveLength(0); // nothing emitted
      expect(getCarrierShipmentStore().hasSeenEvent("evt_gate")).toBe(false); // retryable
    } finally {
      await app.close();
    }
  });

  it("dedupes on provider event id — a retried delivery does not duplicate evidence (finding 5)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const body = trackerEvent(bought, "in_transit", "evt_retry", ts(1));
      expect((await postWebhook(app, body)).json().outcome).toBe("applied");
      expect((await postWebhook(app, body)).json().outcome).toBe("deduped");
      expect(getCarrierShipmentStore().getByJobId(JOB)!.events).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("two CONCURRENT identical deliveries apply exactly once (round-2 NEW-4)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const body = trackerEvent(bought, "in_transit", "evt_conc", ts(1));
      const [a, b] = await Promise.all([postWebhook(app, body), postWebhook(app, body)]);
      const outcomes = [a.json().outcome, b.json().outcome].sort();
      expect(outcomes).toEqual(["applied", "deduped"]);
      expect(getCarrierShipmentStore().getByJobId(JOB)!.events).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("two CONCURRENT DIFFERENT events serialize per shipment — no stale-snapshot overwrite (R3-3)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const older = trackerEvent(bought, "in_transit", "evt_a", ts(1));
      const newer = trackerEvent(bought, "delivered", "evt_b", ts(5));
      const [ra, rb] = await Promise.all([postWebhook(app, older), postWebhook(app, newer)]);
      // Whichever order the mutex ran them in, the final state MUST be delivered
      // with both events accounted for and no regression.
      expect([ra.statusCode, rb.statusCode]).toEqual([200, 200]);
      const record = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(record.status).toBe("delivered");
      const types = record.events.map((e) => e.type).sort();
      // in_transit-first ordering yields both events; delivered-first makes the older one stale (no pickup event) — both are correct, regression is not.
      expect(types.length === 2 ? types : types).toContain("courier_delivery_confirmed");
    } finally {
      await app.close();
    }
  });

  it("ignores an older event delivered late — no regression, no fabricated transition (finding 7)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      expect((await postWebhook(app, trackerEvent(bought, "delivered", "evt_deliv", ts(10)))).json().status).toBe("delivered");
      const late = await postWebhook(app, trackerEvent(bought, "in_transit", "evt_late", ts(1)));
      expect(late.json().outcome).toBe("stale");
      const record = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(record.status).toBe("delivered");
      expect(record.events.map((e) => e.type)).toEqual(["courier_delivery_confirmed"]);
    } finally {
      await app.close();
    }
  });

  it("a newer NO-OP event still advances the watermark, shutting the door on older late arrivals (R3 MED-1)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const noop = await postWebhook(app, trackerEvent(bought, "pre_transit", "evt_noop", ts(6)));
      expect(noop.json().outcome).toBe("no_transition");
      const older = await postWebhook(app, trackerEvent(bought, "in_transit", "evt_older", ts(2)));
      expect(older.json().outcome).toBe("stale");
      const record = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(record.status).toBe("label_bought");
      expect(record.events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("return_to_sender followed by 'delivered' never emits courier_delivery_confirmed (finding 7)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      await postWebhook(app, trackerEvent(bought, "in_transit", "e1", ts(1)));
      await postWebhook(app, trackerEvent(bought, "return_to_sender", "e2", ts(5)));
      const res = await postWebhook(app, trackerEvent(bought, "delivered", "e3", ts(9)));
      expect(res.json().outcome).toBe("terminal");
      const record = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(record.status).toBe("return_to_sender");
      expect(record.events.map((e) => e.type)).toEqual(["courier_pickup_confirmed"]);
    } finally {
      await app.close();
    }
  });

  it("refuses a scan whose carrier timestamp PREDATES the commitment — permanently non-qualifying (R3-4)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const res = await postWebhook(app, trackerEvent(bought, "in_transit", "evt_backdated", ts(-5)));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ matched: false, reason: "scan_predates_commitment" });
      const record = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(record.status).toBe("label_bought");
      expect(record.events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("refuses a scan whose tracker id differs from the purchased tracker, and one MISSING a tracker id entirely (finding 6)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const wrong = await postWebhook(app, trackerEvent({ ...bought, trackerId: "trk_someone_elses", shipmentId: null }, "in_transit", "e1", ts(1)));
      expect(wrong.json()).toMatchObject({ matched: false, reason: "tracker_mismatch" });
      const missing = await postWebhook(app, trackerEvent({ ...bought, trackerId: null, shipmentId: null }, "in_transit", "e2", ts(2)));
      expect(missing.json()).toMatchObject({ matched: false, reason: "tracker_missing" });
      expect(getCarrierShipmentStore().getByJobId(JOB)!.status).toBe("label_bought");
    } finally {
      await app.close();
    }
  });

  it("LEDGERS a scan for an unknown tracking code instead of dropping it (R3-5)", async () => {
    const app = await buildApp();
    try {
      const res = await postWebhook(app, trackerEvent({ trackingCode: "EZ_NOT_YET_KNOWN", trackerId: null, shipmentId: null }, "in_transit", "e_stray", ts(1)));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ received: true, pending: true, reason: "unknown_tracking_code" });
    } finally {
      await app.close();
    }
  });

  it("a scan arriving BEFORE finalize is ledgered and REPLAYED after the finalize retry — nothing depends on provider retries (R3-5)", async () => {
    let finalizeAttempts = 0;
    class FlakyFinalize extends EasyPostClient {
      override async finalizeLabel(p: CreateLabelParams, bought: BoughtShipment): Promise<FinalizedLabel> {
        finalizeAttempts++;
        if (finalizeAttempts === 1) throw new Error("still down");
        return super.finalizeLabel(p, bought);
      }
    }
    _setEasyPostClientForTests(new FlakyFinalize({ webhookSecret: WEBHOOK_SECRET, blobStore: memBlobStore() }));
    const app = await buildApp();
    try {
      const first = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(first.statusCode).toBe(502);
      const rec = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(rec.status).toBe("purchased_pending");

      // The human already dropped the envelope; USPS scans it before finalize succeeded.
      // ts(1) is AFTER the (upcoming) commitment mint at retry time, so it qualifies on replay.
      const scan = await postWebhook(app, trackerEvent({ trackingCode: rec.trackingCode!, trackerId: rec.trackerId, shipmentId: rec.shipmentId }, "in_transit", "evt_early", ts(1)));
      expect(scan.statusCode).toBe(200);
      expect(scan.json()).toMatchObject({ pending: true, reason: "not_finalized" });
      expect(getCarrierShipmentStore().hasSeenEvent("evt_early")).toBe(false);

      const retry = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(retry.statusCode).toBe(201);
      expect(retry.json().replayedScans).toBe(1); // the ledgered scan was applied during finalize
      const after = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(after.status).toBe("in_transit");
      expect(after.events.map((e) => e.type)).toEqual(["courier_pickup_confirmed"]);
      expect(getCarrierShipmentStore().hasSeenEvent("evt_early")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("refuses a non-production tracker when the client requires production mode (round-2 NEW-1)", async () => {
    _setEasyPostClientForTests(testClient({ apiKey: "EZAKprod", requireProductionMode: true }));
    const app = await buildApp();
    try {
      const body = trackerEvent({ trackingCode: "X", trackerId: null, shipmentId: null }, "in_transit", "evt_test_mode", ts(1), { mode: "test" });
      const res = await postWebhook(app, body);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ignored: true, reason: "provider_mode_not_production" });
    } finally {
      await app.close();
    }
  });

  it("does NOT mark an event seen when evidence construction fails, so the provider's retry succeeds (finding 9)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const store = getCarrierShipmentStore();
      const evt = {
        easypostEventId: "evt_fail_once",
        trackerId: bought.trackerId,
        shipmentId: bought.shipmentId,
        trackingCode: bought.trackingCode,
        status: "in_transit",
        carrier: "USPS",
        statusDetail: null,
        occurredAt: ts(1),
        providerMode: null,
        carrierMessage: null,
        trackingLocation: null,
      };
      await expect(store.recordCarrierEvent(evt, () => { throw new Error("hash service down"); })).rejects.toThrow("hash service down");
      expect(store.hasSeenEvent("evt_fail_once")).toBe(false);
      expect(store.getByJobId(JOB)!.status).toBe("label_bought");
      const retryRes = await store.recordCarrierEvent(evt, () => null);
      expect(retryRes.ok && retryRes.outcome).toBe("applied");
    } finally {
      await app.close();
    }
  });
});
