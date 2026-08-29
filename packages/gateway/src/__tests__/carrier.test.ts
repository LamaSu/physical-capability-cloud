/**
 * Carrier route tests — authorization against the REAL job/kernel records
 * (seeded in-memory store + facades, not stubs), the two-phase purchase
 * (reserve -> markPurchased -> finalize) including finalize-failure recovery
 * WITHOUT a second charge, idempotency, concurrency, and the webhook
 * receiver's full signature -> identity -> ordering -> lattice -> evidence
 * path. Webhook signatures are computed with real HMAC-SHA256 (not stubbed).
 *
 * Test names reference sol #297 finding numbers (rounds 1 and 2).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac, createHash } from "node:crypto";
import { verifyEventHash } from "@pcc/spec";
import { carrierRoutes } from "../routes/carrier.js";
import {
  EasyPostClient,
  _setEasyPostClientForTests,
  verifyCommitmentHash,
  type CreateLabelParams,
  type BoughtShipment,
  type EasyPostClientConfig,
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

/** Webhook body builder. Passes the tracker id by default because every purchase records one, and the route rejects tracker-less scans for such purchases (finding 6). */
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
  it("reports mock mode, webhook config, durability, and ceilings", async () => {
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

  it("409s for a job that is no longer active — a completed job must not spend (round-2 NEW-5, partial)", async () => {
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

describe("POST /api/carrier/shipments — two-phase purchase + idempotency", () => {
  it("buys a (mock) label for the kernel operator and returns a verifiable commitment with labelCid", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ jobId: JOB, kernelId: KERNEL, mock: true, providerMode: "mock", status: "label_bought" });
      expect(body.commitment).toMatchObject({ jobId: JOB, kernelId: KERNEL, documentHash, mock: true, providerMode: "mock", signature: null });
      expect(body.labelCid).toBeTruthy();
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

  it("two CONCURRENT buys for one jobId yield exactly one charge (finding 6 / NEW-6)", async () => {
    let buys = 0;
    class SlowBuy extends EasyPostClient {
      override async createAndBuy(p: CreateLabelParams): Promise<BoughtShipment> {
        buys++;
        await new Promise((r) => setTimeout(r, 30));
        return super.createAndBuy(p);
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
      expect(codes).toEqual([201, 409]);
      expect(buys).toBe(1);
      expect(getCarrierShipmentStore().size()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("a finalize failure NEVER causes a second charge: purchase is recorded, the identical retry finalizes it (round-2 NEW-2)", async () => {
    let buys = 0;
    let finalizeAttempts = 0;
    class FlakyFinalize extends EasyPostClient {
      override async createAndBuy(p: CreateLabelParams): Promise<BoughtShipment> {
        buys++;
        return super.createAndBuy(p);
      }
      override async finalizeLabel(p: CreateLabelParams, bought: BoughtShipment) {
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
      expect(rec.trackingCode).toBeTruthy();
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

  it("maps ceiling violations to 400 with a stable code and no provider detail (findings 11/14)", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: { ...validBody, parcel: { weightOz: 999 } }, headers: asOwner });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "weight_exceeds_ceiling" });
      expect(getCarrierShipmentStore().size()).toBe(0); // reservation released
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
      await postWebhook(app, trackerEvent(bought, "in_transit", "evt_e1", "2026-08-27T14:22:00Z"));
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
    expect(nextStatus("delivered", "return_to_sender")).toBeNull(); // RTS is terminal; a later 'delivered' is delivery back to sender
    expect(nextStatus("in_transit", "failed")).toBeNull();
    expect(nextStatus("pre_transit", "label_bought")).toBeNull();
    expect(nextStatus("unknown", "label_bought")).toBeNull();
    expect(nextStatus("in_transit", "reserved")).toBeNull();
    expect(nextStatus("in_transit", "purchased_pending")).toBeNull();
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
      const body = trackerEvent({ trackingCode: "X", trackerId: null, shipmentId: null }, "in_transit", "evt", "2026-08-27T14:22:00Z");
      const res = await app.inject({ method: "POST", url: "/api/carrier/webhook/easypost", payload: body, headers: { "content-type": "application/json", "x-hmac-signature": "hmac-sha256-hex=deadbeef" } });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("applies a signed in_transit scan and emits a byte-verifiable, recomputable EvidenceEvent (finding 2 / NEW-8)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const body = trackerEvent(bought, "in_transit", "evt_pickup_1", "2026-08-27T14:22:00Z", {
        status_detail: "arrived_at_destination_facility",
        tracking_details: [{ message: "Accepted at USPS Origin Facility", status: "in_transit", datetime: "2026-08-27T14:22:00Z", tracking_location: { city: "SAN FRANCISCO", state: "CA", zip: "94103", country: "US" } }],
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
      expect(event.timestamp).toBe("2026-08-27T14:22:00.000Z");
      // "accepted into the mail stream, ZIP 94103, 14:22" lives in the authenticated payload:
      expect(event.payload.trackingLocation).toEqual({ city: "SAN FRANCISCO", state: "CA", zip: "94103", country: "US" });
      expect(event.payload.carrierMessage).toBe("Accepted at USPS Origin Facility");
      // The raw signed bytes ride as base64 and decode to the exact body:
      expect(Buffer.from(event.payload.providerRawBodyB64 as string, "base64").toString("utf8")).toBe(body);
      expect(event.payload.providerSignatureHeader).toBe(sign(body));
      expect(event.payload.providerEventId).toBe("evt_pickup_1");
      // Split verification results (NEW-8): the hash recomputes, but with no
      // signing key configured there is no attestation — and the payload says so.
      expect(event.payload.commitmentHashValid).toBe(true);
      expect(event.payload.commitmentSignatureVerified).toBe(false);
      expect((event.payload.commitment as { labelCid: string }).labelCid).toBe(bought.labelCid);
      expect(verifyCommitmentHash(event.payload.commitment as never)).toBe(true);
      expect(await verifyEventHash(event)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("dedupes on provider event id — a retried delivery does not duplicate evidence (finding 5)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const body = trackerEvent(bought, "in_transit", "evt_retry", "2026-08-27T14:22:00Z");
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
      const body = trackerEvent(bought, "in_transit", "evt_conc", "2026-08-27T14:22:00Z");
      const [a, b] = await Promise.all([postWebhook(app, body), postWebhook(app, body)]);
      const outcomes = [a.json().outcome, b.json().outcome].sort();
      expect(outcomes).toEqual(["applied", "deduped"]);
      expect(getCarrierShipmentStore().getByJobId(JOB)!.events).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("ignores an older event delivered late — no regression, no fabricated transition (finding 7)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      expect((await postWebhook(app, trackerEvent(bought, "delivered", "evt_deliv", "2026-08-29T09:00:00Z"))).json().status).toBe("delivered");
      const late = await postWebhook(app, trackerEvent(bought, "in_transit", "evt_late", "2026-08-27T14:22:00Z"));
      expect(late.json().outcome).toBe("stale");
      const record = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(record.status).toBe("delivered");
      expect(record.events.map((e) => e.type)).toEqual(["courier_delivery_confirmed"]);
    } finally {
      await app.close();
    }
  });

  it("a newer NO-OP event still advances the watermark, shutting the door on older late arrivals (round-2 MED-1)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      // Newer pre_transit: no transition, but the watermark must advance…
      const noop = await postWebhook(app, trackerEvent(bought, "pre_transit", "evt_noop", "2026-08-27T15:00:00Z"));
      expect(noop.json().outcome).toBe("no_transition");
      // …so an OLDER in_transit arriving later is stale, not applied.
      const older = await postWebhook(app, trackerEvent(bought, "in_transit", "evt_older", "2026-08-27T14:00:00Z"));
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
      await postWebhook(app, trackerEvent(bought, "in_transit", "e1", "2026-08-27T14:22:00Z"));
      await postWebhook(app, trackerEvent(bought, "return_to_sender", "e2", "2026-08-28T10:00:00Z"));
      const res = await postWebhook(app, trackerEvent(bought, "delivered", "e3", "2026-08-30T10:00:00Z"));
      expect(res.json().outcome).toBe("terminal");
      const record = getCarrierShipmentStore().getByJobId(JOB)!;
      expect(record.status).toBe("return_to_sender");
      expect(record.events.map((e) => e.type)).toEqual(["courier_pickup_confirmed"]);
    } finally {
      await app.close();
    }
  });

  it("refuses a scan whose tracker id differs from the purchased tracker, and one MISSING a tracker id entirely (finding 6)", async () => {
    const app = await buildApp();
    try {
      const bought = await buyViaRoute(app);
      const wrong = await postWebhook(app, trackerEvent({ ...bought, trackerId: "trk_someone_elses", shipmentId: null }, "in_transit", "e1", "2026-08-27T14:22:00Z"));
      expect(wrong.json()).toMatchObject({ matched: false, reason: "tracker_mismatch" });
      const missing = await postWebhook(app, trackerEvent({ ...bought, trackerId: null, shipmentId: null }, "in_transit", "e2", "2026-08-27T14:23:00Z"));
      expect(missing.json()).toMatchObject({ matched: false, reason: "tracker_missing" });
      expect(getCarrierShipmentStore().getByJobId(JOB)!.status).toBe("label_bought");
    } finally {
      await app.close();
    }
  });

  it("does not treat a scan for an uncommitted tracking code as evidence for any job", async () => {
    const app = await buildApp();
    try {
      const res = await postWebhook(app, trackerEvent({ trackingCode: "EZ_NEVER_COMMITTED", trackerId: null, shipmentId: null }, "in_transit", "e_stray", "2026-08-27T14:22:00Z"));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ matched: false, reason: "unknown_tracking_code" });
    } finally {
      await app.close();
    }
  });

  it("asks the provider to RETRY (409) a scan that arrives before finalize — the scan must not be dropped", async () => {
    let finalizeAttempts = 0;
    class NeverFinalize extends EasyPostClient {
      override async finalizeLabel(): Promise<never> {
        finalizeAttempts++;
        throw new Error("still down");
      }
    }
    _setEasyPostClientForTests(new NeverFinalize({ webhookSecret: WEBHOOK_SECRET, blobStore: memBlobStore() }));
    const app = await buildApp();
    try {
      const first = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody, headers: asOwner });
      expect(first.statusCode).toBe(502);
      const rec = getCarrierShipmentStore().getByJobId(JOB)!;
      const res = await postWebhook(app, trackerEvent({ trackingCode: rec.trackingCode!, trackerId: rec.trackerId, shipmentId: rec.shipmentId }, "in_transit", "evt_early", "2026-08-27T14:22:00Z"));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ received: false, reason: "not_finalized", retry: true });
      expect(getCarrierShipmentStore().hasSeenEvent("evt_early")).toBe(false); // not consumed — the retry gets a clean attempt
      expect(finalizeAttempts).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("refuses a non-production tracker when the client requires production mode (round-2 NEW-1)", async () => {
    _setEasyPostClientForTests(testClient({ apiKey: "EZAKprod", requireProductionMode: true }));
    const app = await buildApp();
    try {
      const body = trackerEvent({ trackingCode: "X", trackerId: null, shipmentId: null }, "in_transit", "evt_test_mode", "2026-08-27T14:22:00Z", { mode: "test" });
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
        occurredAt: "2026-08-27T14:22:00.000Z",
        providerMode: null,
        carrierMessage: null,
        trackingLocation: null,
      };
      await expect(store.recordCarrierEvent(evt, () => { throw new Error("hash service down"); })).rejects.toThrow("hash service down");
      expect(store.hasSeenEvent("evt_fail_once")).toBe(false);
      expect(store.getByJobId(JOB)!.status).toBe("label_bought");
      const retry = await store.recordCarrierEvent(evt, () => null);
      expect(retry.ok && retry.outcome).toBe("applied");
    } finally {
      await app.close();
    }
  });
});
