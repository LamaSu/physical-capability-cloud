/**
 * Carrier routes — buy a real postage label upstream (before any human
 * touches the envelope) and receive the carrier's own tracking-scan webhook
 * as physical-provenance evidence.
 *
 * This is the mechanism the print-and-mail demo depends on (coord
 * #1585/demo-print-and-mail.md design C): the tracking number is issued by
 * the carrier before execution, so the later scan closes a pre-committed
 * claim the executing human never authored. Sol's review (#1382) sharpened
 * this: a scan alone only proves "some labeled parcel entered the network" —
 * the commitment (jobId + destination + tracking code + label hash, computed
 * at buy time) is what binds it to THIS job's THIS document/recipient.
 *
 * Provider: EasyPost (chosen over Shippo/Stamps.com — see the routing memo;
 * Stamps.com/Auctane requires USPS Business Account linking + Customer
 * Onboarding Portal approval, not a self-serve API). No SDK dependency.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { hashEvent, type EvidenceEvent, type EvidenceSource } from "@pcc/spec";
import {
  getEasyPostClient,
  type EasyPostAddress,
  type EasyPostParcel,
} from "../services/easypost-client.js";
import {
  getCarrierShipmentStore,
  type CarrierShipmentRecord,
  type CarrierShipmentStatus,
} from "../services/carrier-shipment-store.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

interface CreateShipmentBody {
  jobId?: string;
  kernelId?: string;
  toAddress?: Partial<EasyPostAddress>;
  fromAddress?: Partial<EasyPostAddress>;
  parcel?: Partial<EasyPostParcel>;
}

function missingAddressFields(a: Partial<EasyPostAddress> | undefined): string[] {
  if (!a) return ["name", "street1", "city", "state", "zip"];
  const required: (keyof EasyPostAddress)[] = ["name", "street1", "city", "state", "zip"];
  return required.filter((f) => !a[f]);
}

function toShipmentDTO(record: CarrierShipmentRecord) {
  return {
    jobId: record.jobId,
    kernelId: record.kernelId,
    shipmentId: record.shipmentId,
    trackerId: record.trackerId,
    trackingCode: record.trackingCode,
    labelUrl: record.labelUrl,
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

/** Builds the EvidenceEvent for a pickup/delivery transition; returns null for transitions with no matching evidence-event type (return_to_sender/failed). */
async function buildCarrierEvidenceEvent(
  record: CarrierShipmentRecord,
  newStatus: CarrierShipmentStatus,
  occurredAt: string,
): Promise<EvidenceEvent | null> {
  const type = newStatus === "in_transit" ? "courier_pickup_confirmed" : newStatus === "delivered" ? "courier_delivery_confirmed" : null;
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
    carrier: record.carrier,
    commitmentHash: record.commitment.hash,
  };
  const withoutHash = { type, timestamp: occurredAt, source, payload } as const;
  const hash = await hashEvent(withoutHash);
  return { id: randomUUID(), ...withoutHash, hash };
}

export async function carrierRoutes(app: FastifyInstance) {
  // Scoped to this plugin's encapsulation context only (Fastify's default
  // per-register() isolation) — does not affect JSON parsing anywhere else
  // in the gateway. Needed so the webhook route can verify EasyPost's HMAC
  // over the EXACT bytes received; re-serializing a parsed body can byte-
  // differ from what was signed and would break verification.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req: FastifyRequest, body: string, done: (err: Error | null, body?: unknown) => void) => {
      req.rawBody = body;
      if (body.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body));
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
      shipments: store.size(),
      ts: new Date().toISOString(),
    };
  });

  app.post<{ Body: CreateShipmentBody }>("/api/carrier/shipments", async (req, reply) => {
    const b = req.body ?? {};
    const errors: string[] = [];
    if (!b.jobId) errors.push("jobId is required");
    if (!b.kernelId) errors.push("kernelId is required");
    const toMissing = missingAddressFields(b.toAddress);
    if (toMissing.length) errors.push(`toAddress missing: ${toMissing.join(", ")}`);
    const fromMissing = missingAddressFields(b.fromAddress);
    if (fromMissing.length) errors.push(`fromAddress missing: ${fromMissing.join(", ")}`);
    if (!b.parcel?.weightOz || b.parcel.weightOz <= 0) errors.push("parcel.weightOz (>0) is required");
    if (errors.length) return reply.code(400).send({ error: "missing_fields", details: errors });

    const store = getCarrierShipmentStore();
    const existing = store.getByJobId(b.jobId!);
    if (existing) {
      return reply.code(200).send({ ...toShipmentDTO(existing), note: "already bought for this jobId" });
    }

    try {
      const client = getEasyPostClient();
      const result = await client.buyCheapestLabel({
        jobId: b.jobId!,
        toAddress: b.toAddress as EasyPostAddress,
        fromAddress: b.fromAddress as EasyPostAddress,
        parcel: b.parcel as EasyPostParcel,
      });
      const record = store.create({
        jobId: b.jobId!,
        kernelId: b.kernelId!,
        shipmentId: result.shipmentId,
        trackerId: result.trackerId,
        trackingCode: result.trackingCode,
        labelUrl: result.labelUrl,
        carrier: result.carrier,
        service: result.service,
        commitment: result.commitment,
        mock: result.mock,
      });
      return reply.code(201).send(toShipmentDTO(record));
    } catch (err) {
      return reply.code(502).send({
        error: "easypost_label_purchase_failed",
        message: err instanceof Error ? err.message : "Failed to buy a carrier label",
      });
    }
  });

  app.get<{ Params: { jobId: string } }>("/api/carrier/shipments/:jobId", async (req, reply) => {
    const record = getCarrierShipmentStore().getByJobId(req.params.jobId);
    if (!record) return reply.code(404).send({ error: "not_found" });
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
    const rawBody = req.rawBody ?? "";
    if (!client.verifyWebhookSignature(rawBody, headerValue)) {
      req.log.warn({ hasHeader: !!headerValue }, "carrier webhook: signature verification failed");
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const trackerEvent = client.parseTrackerEvent(req.body);
    if (!trackerEvent) {
      // Not a tracker event we care about (e.g. batch/other object type) —
      // 2xx so EasyPost does not retry a webhook we're intentionally ignoring.
      return reply.code(200).send({ received: true, ignored: true });
    }

    const result = await getCarrierShipmentStore().recordCarrierEvent(trackerEvent, (record, newStatus) =>
      buildCarrierEvidenceEvent(record, newStatus, trackerEvent.occurredAt),
    );

    if (!result.ok) {
      // Genuinely not ours (e.g. another shipment on the same EasyPost
      // account). Not an error — 2xx so EasyPost does not retry — but logged
      // since an uncommitted tracking code should never silently become
      // evidence for a PCC job.
      req.log.info({ trackingCode: trackerEvent.trackingCode }, "carrier webhook: no PCC shipment committed for this tracking code");
      return reply.code(200).send({ received: true, matched: false });
    }

    return reply.code(200).send({
      received: true,
      matched: true,
      jobId: result.record.jobId,
      status: result.newStatus,
      deduped: result.deduped,
    });
  });
}
