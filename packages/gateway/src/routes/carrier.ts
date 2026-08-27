/**
 * Carrier routes — buy a real postage label upstream (before any human
 * touches the envelope) and receive the carrier's own tracking-scan webhook
 * as physical-provenance evidence.
 *
 * This is the mechanism the print-and-mail demo depends on (coord
 * #1585/demo-print-and-mail.md design C): the tracking number is issued by
 * the carrier before execution, so the later scan closes a pre-committed
 * claim the executing human never authored.
 *
 * What the scan proves and does not prove is stated on ShipmentCommitment in
 * services/easypost-client.ts — read it before citing this route as proof of
 * anything beyond "the labelled envelope entered the mail stream".
 *
 * Authorization (sol #297 findings 3/4): the caller must be the operator of
 * the kernel the job is assigned to; jobId and kernelId are resolved against
 * the authoritative job/kernel records, never trusted from the body. Reads
 * are owner-only. The webhook path is the ONE public route here — its
 * authentication is the verified provider HMAC (see middleware/api-gate.ts).
 *
 * Provider: EasyPost. No SDK dependency.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { canonicalize, hashEvent, type EvidenceEvent, type EvidenceSource } from "@pcc/spec";
import {
  EasyPostError,
  getEasyPostClient,
  isValidDocumentHash,
  sha256Hex,
  verifyCommitmentHash,
  type EasyPostAddress,
  type EasyPostParcel,
  type TrackerWebhookEvent,
} from "../services/easypost-client.js";
import {
  CarrierStoreError,
  getCarrierShipmentStore,
  type CarrierShipmentRecord,
  type CarrierShipmentStatus,
} from "../services/carrier-shipment-store.js";
import { getJobFacade, getKernelFacade } from "../facades/index.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

interface CreateShipmentBody {
  jobId?: string;
  kernelId?: string;
  documentHash?: string;
  toAddress?: Partial<EasyPostAddress>;
  fromAddress?: Partial<EasyPostAddress>;
  parcel?: Partial<EasyPostParcel>;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function missingAddressFields(a: Partial<EasyPostAddress> | undefined): string[] {
  if (!a) return ["name", "street1", "city", "state", "zip"];
  const required: (keyof EasyPostAddress)[] = ["name", "street1", "city", "state", "zip"];
  return required.filter((f) => typeof a[f] !== "string" || !(a[f] as string).trim());
}

function callerId(req: FastifyRequest): string | null {
  const r = req as unknown as { operatorId?: string | null; userId?: string | null };
  return r.operatorId ?? r.userId ?? null;
}

function toShipmentDTO(record: CarrierShipmentRecord) {
  return {
    jobId: record.jobId,
    kernelId: record.kernelId,
    shipmentId: record.shipmentId,
    trackerId: record.trackerId,
    trackingCode: record.trackingCode,
    labelUrl: record.labelUrl,
    labelHash: record.labelHash,
    carrier: record.carrier,
    service: record.service,
    status: record.status,
    mock: record.mock,
    commitment: record.commitment,
    events: record.events,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Builds the EvidenceEvent for a pickup/delivery transition. The payload
 * carries everything a verifier needs to RECOMPUTE the binding (sol #297
 * finding 2): the full commitment (+ gateway signature when present), the
 * provider's raw signed bytes and signature header, its event id, and the
 * tracker status/detail — not just a hash of a hash.
 */
async function buildCarrierEvidenceEvent(
  record: CarrierShipmentRecord,
  newStatus: CarrierShipmentStatus,
  evt: TrackerWebhookEvent,
  rawBody: Buffer,
  signatureHeader: string,
): Promise<EvidenceEvent | null> {
  const type =
    newStatus === "in_transit" ? "courier_pickup_confirmed" : newStatus === "delivered" ? "courier_delivery_confirmed" : null;
  if (!type) return null;

  const source: EvidenceSource = {
    deviceId: `easypost:${record.trackingCode}`,
    deviceType: "courier_api",
    kernelId: record.kernelId,
    simulated: record.mock,
  };
  const payload = {
    jobId: record.jobId,
    trackingCode: record.trackingCode,
    trackerId: record.trackerId,
    shipmentId: record.shipmentId,
    carrier: evt.carrier ?? record.carrier,
    trackerStatus: evt.status,
    statusDetail: evt.statusDetail,
    providerEventId: evt.easypostEventId,
    occurredAt: evt.occurredAt,
    provider: "easypost",
    providerSignatureHeader: signatureHeader,
    providerRawBody: rawBody.toString("utf8"),
    commitment: record.commitment,
    commitmentVerified: verifyCommitmentHash(record.commitment),
  };
  const withoutHash = { type, timestamp: evt.occurredAt, source, payload } as const;
  const hash = await hashEvent(withoutHash);
  return { id: randomUUID(), ...withoutHash, hash };
}

export async function carrierRoutes(app: FastifyInstance) {
  // Mock mode fabricates labels and tracking codes. Serving that from a
  // production gateway would let fabricated "carrier" evidence exist at all;
  // refuse to boot instead (same pattern as fiat-ramp.ts's legacy-flag guard).
  if (process.env.NODE_ENV === "production" && !process.env.EASYPOST_API_KEY) {
    throw new Error(
      "EASYPOST_API_KEY is required in production: the carrier route must never run in mock mode " +
        "(mock labels would be indistinguishable from real ones to a downstream verifier that ignores source.simulated).",
    );
  }

  // Scoped to this plugin's encapsulation context only (Fastify's default
  // per-register() isolation) — does not affect JSON parsing anywhere else
  // in the gateway. Captures the exact request BYTES so the webhook route can
  // verify EasyPost's HMAC over what was actually signed.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
      req.rawBody = body;
      if (body.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body.toString("utf8")));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get("/api/carrier/healthz", async () => {
    const store = getCarrierShipmentStore();
    const client = getEasyPostClient();
    return {
      ok: true,
      service: "carrier (EasyPost)",
      mock: client.isMock,
      webhookConfigured: client.hasWebhookSecret,
      maxRateUsd: client.maxRateUsd,
      maxWeightOz: client.maxWeightOz,
      shipments: store.size(),
      ts: new Date().toISOString(),
    };
  });

  app.post<{ Body: CreateShipmentBody }>("/api/carrier/shipments", async (req, reply) => {
    const caller = callerId(req);
    if (!caller) return reply.code(401).send({ error: "authentication_required" });

    const b = req.body ?? {};
    const errors: string[] = [];
    if (!b.jobId || typeof b.jobId !== "string") errors.push("jobId is required");
    if (!b.kernelId || typeof b.kernelId !== "string") errors.push("kernelId is required");
    if (!isValidDocumentHash(b.documentHash)) errors.push("documentHash (sha256 hex of the document to mail) is required");
    const toMissing = missingAddressFields(b.toAddress);
    if (toMissing.length) errors.push(`toAddress missing: ${toMissing.join(", ")}`);
    const fromMissing = missingAddressFields(b.fromAddress);
    if (fromMissing.length) errors.push(`fromAddress missing: ${fromMissing.join(", ")}`);
    if (typeof b.parcel?.weightOz !== "number" || !(b.parcel.weightOz > 0)) errors.push("parcel.weightOz (>0) is required");
    if (errors.length) return reply.code(400).send({ error: "missing_fields", details: errors });

    const jobId = b.jobId!;
    const kernelId = b.kernelId!;

    // Resolve against the AUTHORITATIVE job + kernel; never trust the body's claims.
    const jobRes = await getJobFacade().getById(jobId);
    if (!jobRes.success) {
      return reply.code(jobRes.error.httpStatus === 404 ? 404 : 502).send({ error: jobRes.error.httpStatus === 404 ? "job_not_found" : "job_lookup_failed" });
    }
    if (jobRes.data.kernelId !== kernelId) {
      return reply.code(409).send({ error: "kernel_mismatch", message: "kernelId does not match the job's assigned kernel" });
    }
    const kernelRes = await getKernelFacade().getById(kernelId);
    if (!kernelRes.success) {
      return reply.code(kernelRes.error.httpStatus === 404 ? 404 : 502).send({ error: kernelRes.error.httpStatus === 404 ? "kernel_not_found" : "kernel_lookup_failed" });
    }
    const owner = (kernelRes.data as { operatorAddress?: string }).operatorAddress;
    if (!owner || owner === ZERO_ADDRESS) {
      // An unowned kernel has no principal we could authorize — fail closed.
      return reply.code(403).send({ error: "kernel_unowned" });
    }
    if (owner.toLowerCase() !== caller.toLowerCase()) {
      return reply.code(403).send({ error: "not_kernel_operator" });
    }

    const requestFingerprint = sha256Hex(
      canonicalize({ toAddress: b.toAddress, fromAddress: b.fromAddress, parcel: b.parcel, documentHash: b.documentHash }),
    );

    const store = getCarrierShipmentStore();
    const existing = store.getByJobId(jobId);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        return reply.code(409).send({ error: "idempotency_conflict", message: "a label was already bought for this jobId with different parameters" });
      }
      return reply.code(200).send({ ...toShipmentDTO(existing), note: "already bought for this jobId" });
    }

    try {
      store.reserve(jobId);
    } catch (err) {
      const code = err instanceof CarrierStoreError ? err.code : "reserve_failed";
      return reply.code(409).send({ error: code });
    }

    try {
      const client = getEasyPostClient();
      const result = await client.buyCheapestLabel({
        jobId,
        kernelId,
        documentHash: b.documentHash!,
        toAddress: b.toAddress as EasyPostAddress,
        fromAddress: b.fromAddress as EasyPostAddress,
        parcel: b.parcel as EasyPostParcel,
      });
      const record = store.create({
        jobId,
        kernelId,
        ownerId: caller,
        shipmentId: result.shipmentId,
        trackerId: result.trackerId,
        trackingCode: result.trackingCode,
        labelUrl: result.labelUrl,
        labelHash: result.labelHash,
        carrier: result.carrier,
        service: result.service,
        commitment: result.commitment,
        requestFingerprint,
        mock: result.mock,
      });
      return reply.code(201).send(toShipmentDTO(record));
    } catch (err) {
      if (err instanceof EasyPostError) {
        // Provider detail (may echo address data / provider diagnostics) stays server-side.
        req.log.warn({ code: err.code, status: err.status, detail: err.detail, jobId }, "carrier: label purchase failed");
        const client = err.code === "invalid_parcel" || err.code === "invalid_document_hash" || err.code.endsWith("_ceiling");
        return reply.code(client ? 400 : 502).send({ error: err.code });
      }
      if (err instanceof CarrierStoreError) {
        req.log.error({ code: err.code, jobId }, "carrier: label bought but could not be recorded");
        return reply.code(409).send({ error: err.code });
      }
      req.log.error({ err, jobId }, "carrier: unexpected failure");
      return reply.code(502).send({ error: "easypost_label_purchase_failed" });
    } finally {
      store.release(jobId);
    }
  });

  app.get<{ Params: { jobId: string } }>("/api/carrier/shipments/:jobId", async (req, reply) => {
    const caller = callerId(req);
    if (!caller) return reply.code(401).send({ error: "authentication_required" });
    const record = getCarrierShipmentStore().getByJobId(req.params.jobId);
    // Same response for missing and not-yours: no existence oracle.
    if (!record || record.ownerId.toLowerCase() !== caller.toLowerCase()) {
      return reply.code(404).send({ error: "not_found" });
    }
    return toShipmentDTO(record);
  });

  app.post("/api/carrier/webhook/easypost", async (req, reply) => {
    const client = getEasyPostClient();
    if (!client.hasWebhookSecret) {
      return reply.code(503).send({
        error: "webhook_secret_not_configured",
        message: "Set EASYPOST_WEBHOOK_SECRET before pointing an EasyPost webhook at this endpoint.",
      });
    }

    const header = req.headers["x-hmac-signature"];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    if (!client.verifyWebhookSignature(rawBody, headerValue)) {
      req.log.warn({ hasHeader: !!headerValue, bytes: rawBody.length }, "carrier webhook: signature verification failed");
      return reply.code(401).send({ error: "invalid_signature" });
    }
    const signatureHeader = headerValue as string;

    const trackerEvent = client.parseTrackerEvent(req.body);
    if (!trackerEvent) {
      // Not a processable tracker event (other object type, or missing the
      // fields we key on) — 2xx so EasyPost does not retry it forever.
      return reply.code(200).send({ received: true, ignored: true });
    }

    let result;
    try {
      result = await getCarrierShipmentStore().recordCarrierEvent(
        trackerEvent,
        (record, newStatus) => buildCarrierEvidenceEvent(record, newStatus, trackerEvent, rawBody, signatureHeader),
        { rawBody: rawBody.toString("utf8"), signatureHeader, parsed: trackerEvent },
      );
    } catch (err) {
      // Evidence build or persistence failed: NOT marked seen, so the
      // provider's retry gets a clean attempt. Non-2xx makes EasyPost retry.
      req.log.error({ err, trackingCode: trackerEvent.trackingCode }, "carrier webhook: failed to apply event");
      return reply.code(500).send({ error: "apply_failed" });
    }

    if (!result.ok) {
      // unknown tracking code: genuinely not ours (another shipment on the
      // same EasyPost account) -> 2xx, no retry, but logged: an uncommitted
      // tracking code must never silently become evidence for a PCC job.
      // tracker/shipment mismatch: same code, different purchase identity ->
      // refuse; logged at warn because that is not a benign shape.
      const level = result.reason === "unknown_tracking_code" ? "info" : "warn";
      req.log[level]({ trackingCode: trackerEvent.trackingCode, reason: result.reason }, "carrier webhook: not applied");
      return reply.code(200).send({ received: true, matched: false, reason: result.reason });
    }

    return reply.code(200).send({
      received: true,
      matched: true,
      jobId: result.record.jobId,
      status: result.newStatus,
      outcome: result.outcome,
    });
  });
}
