/**
 * Print-and-mail HANDOFF leg tests.
 *
 * Covers the whole leg end-to-end through the REAL routes:
 *   - the driver claims via the EXISTING courier-jobs claim route, then submits
 *     handoff evidence here (reuse, not a second claim model);
 *   - the handoff produces custody_handoff_confirmed (human) + photo_captured
 *     (photo-camera) EvidenceEvents, bound to the carrier commitment hash and
 *     carrying the (printJobId, trackingCode) document→envelope binding;
 *   - the mail-leg grader closes ONLY on an authentic courier_pickup_confirmed
 *     from courier_api, and
 *   - the NEGATIVE CONTROL: a photo_captured event alone does NOT satisfy the
 *     mail leg (and neither does a full human handoff).
 *
 * No network. The courier-jobs store is initialised with an injected clock; no
 * carrier branch code is imported — the carrier scan is reconstructed here
 * EXACTLY as feat/carrier-integration's carrier.ts builds it, and injected via
 * the documented CarrierBridge seam.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  hashEvent,
  verifyEventHash,
  EVIDENCE_EVENT_TYPES,
  EVIDENCE_DEVICE_TYPES,
  EvidenceEventSchema,
  type EvidenceEvent,
} from "@pcc/spec";
import { courierJobsRoutes } from "../routes/courier-jobs.js";
import { printAndMailRoutes } from "../routes/print-and-mail.js";
import {
  initCourierJobsStore,
  _resetCourierJobsStoreForTests,
} from "../services/courier-jobs-store.js";
import {
  initPrintAndMailHandoffStore,
  _resetPrintAndMailHandoffStoreForTests,
  setCarrierBridge,
  type CarrierBridge,
} from "../services/print-and-mail-handoff-store.js";
import {
  buildHandoffEvidence,
  evaluateMailLeg,
} from "../services/print-and-mail-handoff.js";

// ── Time controller ──────────────────────────────────────────────────────────

let mockNowMs = 0;
const now = () => new Date(mockNowMs);

// ── App: BOTH the existing courier-jobs routes and the new handoff routes ─────

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(courierJobsRoutes);
  await app.register(printAndMailRoutes);
  await app.ready();
  return app;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DRIVER = "did:pcc:driver-skylar";
const KERNEL = "kernel-hp-printer-01";
const COMMITMENT_HASH = "a".repeat(64); // stand-in for the carrier's sha256 hex commitment
const TRACKING = "EZMOCK0000012345";
const PRINT_JOB_ID = "printjob_ks_0xdeadbeef"; // kernel-signed print job id, visible on page 1

function validHandoffBody(overrides: Record<string, unknown> = {}) {
  return {
    driverAgent: DRIVER,
    kernelId: KERNEL,
    commitmentHash: COMMITMENT_HASH,
    trackingCode: TRACKING,
    printJobId: PRINT_JOB_ID,
    photo: {
      imageHash: "sha256:" + "b".repeat(64),
      capturedAt: "2026-08-27T12:00:00.000Z",
      mimeType: "image/jpeg",
    },
    dropOff: { name: "USPS Rincon Center", address: "180 Steuart St, San Francisco, CA 94105" },
    ...overrides,
  };
}

/** Post + claim a courier.dispatch job through the REAL routes, returning its id. */
async function createAndClaimJob(
  app: FastifyInstance,
  opts: { jobId: string; driver?: string } = { jobId: "job-print-mail-1" },
): Promise<string> {
  const create = await app.inject({
    method: "POST",
    url: "/api/courier-jobs",
    payload: {
      deliveryId: opts.jobId,
      pickup: { name: "PCC Shop", address: "1 Shop Way, SF" },
      dropoff: { name: "USPS Rincon Center", address: "180 Steuart St, SF" },
    },
    headers: { "x-posted-by": "did:pcc:operator-poster" },
  });
  if (create.statusCode !== 201 && create.statusCode !== 200) {
    throw new Error(`job create failed: ${create.statusCode} ${create.body}`);
  }
  const claim = await app.inject({
    method: "POST",
    url: `/api/courier-jobs/${opts.jobId}/claim`,
    payload: { driverAgent: opts.driver ?? DRIVER },
  });
  if (claim.statusCode !== 200) {
    throw new Error(`job claim failed: ${claim.statusCode} ${claim.body}`);
  }
  return opts.jobId;
}

/**
 * Reconstruct the carrier's own pickup-scan EvidenceEvent EXACTLY as
 * feat/carrier-integration's carrier.ts buildCarrierEvidenceEvent does:
 * type courier_pickup_confirmed, deviceType courier_api, payload carries the
 * commitmentHash, hashed with @pcc/spec's canonical hashEvent. This is the
 * ONLY thing allowed to close the mail leg.
 */
async function makeCarrierPickupEvent(opts: {
  jobId: string;
  kernelId?: string;
  commitmentHash?: string;
  trackingCode?: string;
  simulated?: boolean;
  deviceTypeOverride?: string; // for the forgery test
}): Promise<EvidenceEvent> {
  const source = {
    deviceId: `easypost:${opts.trackingCode ?? TRACKING}`,
    deviceType: (opts.deviceTypeOverride ?? "courier_api") as EvidenceEvent["source"]["deviceType"],
    kernelId: opts.kernelId ?? KERNEL,
    simulated: opts.simulated ?? false,
  };
  const payload = {
    jobId: opts.jobId,
    trackingCode: opts.trackingCode ?? TRACKING,
    trackerId: "trk_test_1",
    carrier: "USPS",
    commitmentHash: opts.commitmentHash ?? COMMITMENT_HASH,
  };
  const withoutHash = { type: "courier_pickup_confirmed", timestamp: "2026-08-27T13:00:00.000Z", source, payload } as const;
  return { id: randomUUID(), ...withoutHash, hash: await hashEvent(withoutHash) };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  _resetCourierJobsStoreForTests();
  _resetPrintAndMailHandoffStoreForTests();
  mockNowMs = Date.parse("2026-08-27T00:00:00.000Z");
  initCourierJobsStore({ now });
  initPrintAndMailHandoffStore({ now });
});

afterEach(() => {
  _resetCourierJobsStoreForTests();
  _resetPrintAndMailHandoffStoreForTests();
});

// ── Vocabulary is fixed (no new event/device types) ──────────────────────────

describe("evidence vocabulary is the FIXED @pcc/spec vocabulary", () => {
  it("every type/deviceType the handoff emits already exists in the spec arrays", async () => {
    const { custodyEvent, photoEvent } = await buildHandoffEvidence({
      jobId: "j1",
      kernelId: KERNEL,
      driverAgent: DRIVER,
      commitmentHash: COMMITMENT_HASH,
      trackingCode: TRACKING,
      printJobId: PRINT_JOB_ID,
      photo: { imageHash: "sha256:x", capturedAt: "2026-08-27T12:00:00.000Z" },
    });
    for (const e of [custodyEvent, photoEvent]) {
      expect(EVIDENCE_EVENT_TYPES).toContain(e.type);
      expect(EVIDENCE_DEVICE_TYPES).toContain(e.source.deviceType);
      // hashes + full schema both validate (well-formed per the runtime validator)
      expect(await verifyEventHash(e)).toBe(true);
      expect(() => EvidenceEventSchema.parse(e)).not.toThrow();
    }
    expect(custodyEvent.type).toBe("custody_handoff_confirmed");
    expect(custodyEvent.source.deviceType).toBe("human");
    expect(photoEvent.type).toBe("photo_captured");
    expect(photoEvent.source.deviceType).toBe("photo-camera");
  });
});

// ── healthz ───────────────────────────────────────────────────────────────────

describe("GET /api/print-and-mail/healthz", () => {
  it("returns ok with no carrier bridge wired by default", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/print-and-mail/healthz" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.carrierBridgeWired).toBe(false);
      expect(body.handoffs).toBe(0);
    } finally {
      await app.close();
    }
  });
});

// ── Happy path: claim (existing route) → submit handoff evidence ─────────────

describe("POST /api/print-and-mail/:jobId/handoff", () => {
  it("records two EvidenceEvents bound to the commitment, but does NOT close the mail leg", async () => {
    const app = await buildApp();
    try {
      const jobId = await createAndClaimJob(app, { jobId: "job-1" });
      const res = await app.inject({
        method: "POST",
        url: `/api/print-and-mail/${jobId}/handoff`,
        payload: validHandoffBody(),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();

      // Two events, correct types + device types.
      expect(body.handoff.events).toHaveLength(2);
      const types = body.handoff.events.map((e: EvidenceEvent) => e.type).sort();
      expect(types).toEqual(["custody_handoff_confirmed", "photo_captured"]);
      const custody = body.handoff.events.find((e: EvidenceEvent) => e.type === "custody_handoff_confirmed");
      const photo = body.handoff.events.find((e: EvidenceEvent) => e.type === "photo_captured");
      expect(custody.source.deviceType).toBe("human");
      expect(photo.source.deviceType).toBe("photo-camera");

      // Both carry the document→envelope binding, bound to the commitment.
      for (const e of [custody, photo]) {
        expect(e.payload.commitmentHash).toBe(COMMITMENT_HASH);
        expect(e.payload.trackingCode).toBe(TRACKING);
        expect(e.payload.printJobId).toBe(PRINT_JOB_ID);
        expect(await verifyEventHash(e)).toBe(true);
      }

      // No carrier bridge on this branch → commitment recorded, NOT verified.
      expect(body.handoff.commitmentVerified).toBe(false);
      expect(body.note).toMatch(/caller-attested/);

      // THE POINT: handoff evidence does not close the mail leg.
      expect(body.mailLeg.closed).toBe(false);
      expect(body.mailLeg.grade).toBe("human_print_and_seal_attestation");
      expect(body.mailLeg.handoffAttested).toBe(true);
      expect(body.mailLeg.documentBinding.present).toBe(true);
      expect(body.mailLeg.documentBinding.printJobId).toBe(PRINT_JOB_ID);
    } finally {
      await app.close();
    }
  });

  it("400s when required binding fields are missing", async () => {
    const app = await buildApp();
    try {
      const jobId = await createAndClaimJob(app, { jobId: "job-2" });
      const res = await app.inject({
        method: "POST",
        url: `/api/print-and-mail/${jobId}/handoff`,
        payload: validHandoffBody({ printJobId: undefined, photo: { capturedAt: "2026-08-27T12:00:00.000Z" } }),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("missing_fields");
      expect(body.details.some((d: string) => d.includes("printJobId"))).toBe(true);
      expect(body.details.some((d: string) => d.includes("photo.imageHash"))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("is immutable: a second handoff for the same job is rejected with 409", async () => {
    const app = await buildApp();
    try {
      const jobId = await createAndClaimJob(app, { jobId: "job-3" });
      const first = await app.inject({ method: "POST", url: `/api/print-and-mail/${jobId}/handoff`, payload: validHandoffBody() });
      const second = await app.inject({ method: "POST", url: `/api/print-and-mail/${jobId}/handoff`, payload: validHandoffBody() });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("handoff_already_recorded");
    } finally {
      await app.close();
    }
  });
});

// ── Reuse of the EXISTING claim model (no second auth) ───────────────────────

describe("handoff reuses the courier-jobs claim state", () => {
  it("404s when the job was never posted", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/print-and-mail/ghost/handoff", payload: validHandoffBody() });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("job_not_found");
    } finally {
      await app.close();
    }
  });

  it("409s when the job exists but is not claimed", async () => {
    const app = await buildApp();
    try {
      // post but do NOT claim
      await app.inject({
        method: "POST",
        url: "/api/courier-jobs",
        payload: { deliveryId: "job-open", pickup: { name: "a" }, dropoff: { name: "b" } },
        headers: { "x-posted-by": "did:pcc:operator" },
      });
      const res = await app.inject({ method: "POST", url: "/api/print-and-mail/job-open/handoff", payload: validHandoffBody() });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("job_not_claimed");
    } finally {
      await app.close();
    }
  });

  it("403s when a DIFFERENT agent than the claimant submits the handoff", async () => {
    const app = await buildApp();
    try {
      const jobId = await createAndClaimJob(app, { jobId: "job-4", driver: DRIVER });
      const res = await app.inject({
        method: "POST",
        url: `/api/print-and-mail/${jobId}/handoff`,
        payload: validHandoffBody({ driverAgent: "did:pcc:driver-impostor" }),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("not_claimant");
    } finally {
      await app.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NEGATIVE CONTROL — a photo (or a full human handoff) must NOT close the leg.
// ══════════════════════════════════════════════════════════════════════════════

describe("NEGATIVE CONTROL: the photo can never close the mail leg", () => {
  it("a photo_captured event ALONE does not satisfy the mail leg", async () => {
    const { photoEvent } = await buildHandoffEvidence({
      jobId: "job-neg",
      kernelId: KERNEL,
      driverAgent: DRIVER,
      commitmentHash: COMMITMENT_HASH,
      trackingCode: TRACKING,
      printJobId: PRINT_JOB_ID,
      photo: { imageHash: "sha256:z", capturedAt: "2026-08-27T12:00:00.000Z" },
    });
    const result = evaluateMailLeg([photoEvent], { expectedCommitmentHash: COMMITMENT_HASH });
    expect(result.closed).toBe(false);
    expect(result.closingEvent).toBeNull();
    expect(result.grade).toBe("none"); // a lone photo is not even a complete attestation
  });

  it("a complete human handoff (custody + photo) does not close the leg either", async () => {
    const { custodyEvent, photoEvent } = await buildHandoffEvidence({
      jobId: "job-neg2",
      kernelId: KERNEL,
      driverAgent: DRIVER,
      commitmentHash: COMMITMENT_HASH,
      trackingCode: TRACKING,
      printJobId: PRINT_JOB_ID,
      photo: { imageHash: "sha256:z", capturedAt: "2026-08-27T12:00:00.000Z" },
    });
    const result = evaluateMailLeg([custodyEvent, photoEvent], { expectedCommitmentHash: COMMITMENT_HASH });
    expect(result.closed).toBe(false);
    expect(result.grade).toBe("human_print_and_seal_attestation");
    expect(result.handoffAttested).toBe(true);
  });

  it("via the route+GET: after a handoff, the mail leg is still OPEN", async () => {
    const app = await buildApp();
    try {
      const jobId = await createAndClaimJob(app, { jobId: "job-5" });
      await app.inject({ method: "POST", url: `/api/print-and-mail/${jobId}/handoff`, payload: validHandoffBody() });
      const res = await app.inject({ method: "GET", url: `/api/print-and-mail/${jobId}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().mailLeg.closed).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("a forged courier_pickup_confirmed from deviceType HUMAN does not close the leg", async () => {
    const forged = await makeCarrierPickupEvent({ jobId: "job-forge", deviceTypeOverride: "human" });
    const result = evaluateMailLeg([forged], { expectedCommitmentHash: COMMITMENT_HASH });
    expect(result.closed).toBe(false); // right type, WRONG source — the property is source-typed
  });

  it("a SIMULATED carrier scan does not authentically close a real leg", async () => {
    const sim = await makeCarrierPickupEvent({ jobId: "job-sim", simulated: true });
    const result = evaluateMailLeg([sim], { expectedCommitmentHash: COMMITMENT_HASH });
    expect(result.closed).toBe(false);
    expect(result.simulatedClosingEventPresent).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE: the mail leg closes ONLY on an authentic carrier pickup scan.
// ══════════════════════════════════════════════════════════════════════════════

describe("the mail leg closes on courier_pickup_confirmed from courier_api", () => {
  it("closes when an authentic carrier scan (bound to the commitment) is present", async () => {
    const carrier = await makeCarrierPickupEvent({ jobId: "job-close" });
    const { custodyEvent, photoEvent } = await buildHandoffEvidence({
      jobId: "job-close",
      kernelId: KERNEL,
      driverAgent: DRIVER,
      commitmentHash: COMMITMENT_HASH,
      trackingCode: TRACKING,
      printJobId: PRINT_JOB_ID,
      photo: { imageHash: "sha256:z", capturedAt: "2026-08-27T12:00:00.000Z" },
    });
    const result = evaluateMailLeg([custodyEvent, photoEvent, carrier], { expectedCommitmentHash: COMMITMENT_HASH });
    expect(result.closed).toBe(true);
    expect(result.grade).toBe("carrier_pickup_scan");
    expect(result.closingEvent?.type).toBe("courier_pickup_confirmed");
    expect(result.closingEvent?.source.deviceType).toBe("courier_api");
  });

  it("does NOT close when the carrier scan is for a DIFFERENT commitment", async () => {
    const carrier = await makeCarrierPickupEvent({ jobId: "job-x", commitmentHash: "f".repeat(64) });
    const result = evaluateMailLeg([carrier], { expectedCommitmentHash: COMMITMENT_HASH });
    expect(result.closed).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Carrier bridge wired (simulating post-merge): verification + closure via routes
// ══════════════════════════════════════════════════════════════════════════════

describe("with the CarrierBridge wired (post-merge behaviour)", () => {
  function wireBridge(jobId: string, events: EvidenceEvent[], commitment = { hash: COMMITMENT_HASH, trackingCode: TRACKING }) {
    const bridge: CarrierBridge = {
      getCommitment: (id) => (id === jobId ? commitment : null),
      getEvents: (id) => (id === jobId ? events : []),
    };
    setCarrierBridge(bridge);
  }

  it("verifies the referenced commitment against the pre-committed label", async () => {
    const app = await buildApp();
    try {
      const jobId = await createAndClaimJob(app, { jobId: "job-6" });
      wireBridge(jobId, []);
      const res = await app.inject({ method: "POST", url: `/api/print-and-mail/${jobId}/handoff`, payload: validHandoffBody() });
      expect(res.statusCode).toBe(201);
      expect(res.json().handoff.commitmentVerified).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("409s a commitment_mismatch when the referenced hash is not the pre-committed one", async () => {
    const app = await buildApp();
    try {
      const jobId = await createAndClaimJob(app, { jobId: "job-7" });
      wireBridge(jobId, [], { hash: "9".repeat(64), trackingCode: TRACKING });
      const res = await app.inject({ method: "POST", url: `/api/print-and-mail/${jobId}/handoff`, payload: validHandoffBody() });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("commitment_mismatch");
    } finally {
      await app.close();
    }
  });

  it("GET reports mailLeg CLOSED once the carrier scan has flowed through the bridge", async () => {
    const app = await buildApp();
    try {
      const jobId = await createAndClaimJob(app, { jobId: "job-8" });
      wireBridge(jobId, []);
      await app.inject({ method: "POST", url: `/api/print-and-mail/${jobId}/handoff`, payload: validHandoffBody() });

      // Now a real carrier scan arrives — rewire the bridge to return it.
      const carrier = await makeCarrierPickupEvent({ jobId });
      wireBridge(jobId, [carrier]);

      const res = await app.inject({ method: "GET", url: `/api/print-and-mail/${jobId}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.carrierEventCount).toBe(1);
      expect(body.mailLeg.closed).toBe(true);
      expect(body.mailLeg.grade).toBe("carrier_pickup_scan");
    } finally {
      await app.close();
    }
  });
});
