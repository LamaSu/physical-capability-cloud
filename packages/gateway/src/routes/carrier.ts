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
 * the authoritative job/kernel records, never trusted from the body, and the
 * job must be in an active state. Reads are owner-only. The webhook path is
 * the ONE public route here — its authentication is the verified provider
 * HMAC (see middleware/api-gate.ts).
 *
 * PURCHASE IS TWO PHASES (sol round 2, NEW-2/NEW-6): the job is durably
 * RESERVED before EasyPost is contacted (the row's PK is the cross-process
 * spending lock), the purchase is durably RECORDED the moment /buy returns,
 * and only then is the label downloaded/hashed/committed. A failure after
 * /buy leaves `purchased_pending`; an identical retry FINALIZES that
 * purchase instead of charging again.
 *
 * PRODUCTION BOOT FAILS CLOSED (round 2 findings 1/8/10, NEW-7, MED-3)
 * without: an EasyPost key, a webhook secret, the gateway signing key, and
 * durable storage. A carrier route that can spend but not prove — or prove
 * from memory that vanishes on restart — must not come up in production.
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
import { gatewayCommitmentKeyResolver, verifyCommitmentSignature } from "../services/commitment-signer.js";
import { getActiveSigningKey } from "../signing-key.js";
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
/** Job states in which buying postage makes sense. Completed/failed/cancelled jobs must not spend. */
const ACTIVE_JOB_STATUSES = new Set(["pending", "queued", "in_progress", "paused"]);

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
    status: record.status,
    shipmentId: record.shipmentId,
    trackerId: record.trackerId,
    trackingCode: record.trackingCode,
    labelUrl: record.labelUrl,
    labelHash: record.labelHash,
    labelCid: record.labelCid,
    labelFetch: record.labelCid ? `/api/storage/${record.labelCid}` : null,
    carrier: record.carrier,
    service: record.service,
    rate: record.rate,
    currency: record.currency,
    providerMode: record.providerMode,
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
 * finding 2 / round-2 NEW-8): the full commitment, the provider's raw signed
 * bytes (base64, exact) and signature header, its event id, tracker
 * status/detail/location, the provider-attested mode, and the SPLIT
 * verification results — commitmentHashValid (integrity: the hash
 * recomputes) and commitmentSignatureVerified (authenticity: the gateway's
 * ES256 JWS verifies against its JWKS key). Only the latter is an
 * attestation; a recomputable hash alone is not.
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
  if (!record.commitment) return null; // not finalized: no commitment to bind evidence to (store refuses earlier; belt+braces)

  const providerMode = evt.providerMode ?? record.providerMode ?? "mock";
  const source: EvidenceSource = {
    deviceId: `easypost:${record.trackingCode}`,
    deviceType: "courier_api",
    kernelId: record.kernelId,
    // Authentic evidence comes only from a production-mode purchase AND a
    // production-mode tracker. Mock or sandbox anything => simulated.
    simulated: record.mock || providerMode !== "production" || record.providerMode !== "production",
  };
  const payload = {
    jobId: record.jobId,
    trackingCode: record.trackingCode,
    trackerId: record.trackerId,
    shipmentId: record.shipmentId,
    carrier: evt.carrier ?? record.carrier,
    trackerStatus: evt.status,
    statusDetail: evt.statusDetail,
    carrierMessage: evt.carrierMessage,
    trackingLocation: evt.trackingLocation,
    providerEventId: evt.easypostEventId,
    occurredAt: evt.occurredAt,
    provider: "easypost",
    providerMode,
    providerSignatureHeader: signatureHeader,
    /** Exact signed bytes, base64 — decode and re-run HMAC to re-verify (round-2 finding 2: UTF-8 re-encoding is not byte-exact). */
    providerRawBodyB64: rawBody.toString("base64"),
    commitment: record.commitment,
    commitmentHashValid: verifyCommitmentHash(record.commitment),
    commitmentSignatureVerified: await verifyCommitmentSignature(record.commitment, gatewayCommitmentKeyResolver),
  };
  const withoutHash = { type, timestamp: evt.occurredAt, source, payload } as const;
  const hash = await hashEvent(withoutHash);
  return { id: randomUUID(), ...withoutHash, hash };
}

export async function carrierRoutes(app: FastifyInstance) {
  if (process.env.NODE_ENV === "production") {
    const missing: string[] = [];
    if (!process.env.EASYPOST_API_KEY) missing.push("EASYPOST_API_KEY (mock labels are fabricated evidence)");
    if (!process.env.EASYPOST_WEBHOOK_SECRET) missing.push("EASYPOST_WEBHOOK_SECRET (spending with no functioning proof webhook)");
    if (!getActiveSigningKey()) missing.push("PCC_AGENT_CARD_SIGNING_KEY (an unsigned commitment is a hash anyone can recompute, not an attestation)");
    if (!getCarrierShipmentStore().isDurable) missing.push("durable carrier store (in-memory commitments vanish on restart; re-purchase + unmatched webhooks)");
    if (missing.length) {
      throw new Error(`carrier route refuses production boot; missing: ${missing.join("; ")}`);
    }
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
      requireProductionMode: client.requireProductionMode,
      webhookConfigured: client.hasWebhookSecret,
      commitmentSigningConfigured: !!getActiveSigningKey(),
      durable: store.isDurable,
      maxRateUsd: client.maxRateUsd,
      maxWeightOz: client.maxWeightOz,
      shipments: store.size(),
      pendingFinalize: store.listPendingFinalize().length,
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
    const params = {
      jobId,
      kernelId,
      documentHash: b.documentHash!,
      toAddress: b.toAddress as EasyPostAddress,
      fromAddress: b.fromAddress as EasyPostAddress,
      parcel: b.parcel as EasyPostParcel,
    };

    // Resolve against the AUTHORITATIVE job + kernel; never trust the body's claims.
    const jobRes = await getJobFacade().getById(jobId);
    if (!jobRes.success) {
      return reply
        .code(jobRes.error.httpStatus === 404 ? 404 : 502)
        .send({ error: jobRes.error.httpStatus === 404 ? "job_not_found" : "job_lookup_failed" });
    }
    if (jobRes.data.kernelId !== kernelId) {
      return reply.code(409).send({ error: "kernel_mismatch", message: "kernelId does not match the job's assigned kernel" });
    }
    if (!ACTIVE_JOB_STATUSES.has(jobRes.data.status)) {
      return reply.code(409).send({ error: "job_not_active", status: jobRes.data.status });
    }
    const kernelRes = await getKernelFacade().getById(kernelId);
    if (!kernelRes.success) {
      return reply
        .code(kernelRes.error.httpStatus === 404 ? 404 : 502)
        .send({ error: kernelRes.error.httpStatus === 404 ? "kernel_not_found" : "kernel_lookup_failed" });
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
    const client = getEasyPostClient();

    const existing = store.getByJobId(jobId);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        return reply
          .code(409)
          .send({ error: "idempotency_conflict", message: "a purchase already exists for this jobId with different parameters" });
      }
      if (existing.status === "reserved") {
        return reply.code(409).send({ error: "job_in_flight" });
      }
      if (existing.status === "purchased_pending") {
        // A prior attempt charged EasyPost and then failed before finalize.
        // FINALIZE the recorded purchase — never buy again (round-2 NEW-2).
        try {
          const finalized = await client.finalizeLabel(params, {
            shipmentId: existing.shipmentId!,
            trackerId: existing.trackerId,
            trackingCode: existing.trackingCode!,
            labelUrl: existing.labelUrl!,
            carrier: existing.carrier!,
            service: existing.service!,
            rate: existing.rate ?? "0",
            currency: existing.currency ?? "USD",
            providerMode: existing.providerMode ?? "mock",
            mock: existing.mock,
          });
          const record = store.finalize(jobId, finalized);
          return reply.code(201).send({ ...toShipmentDTO(record), note: "finalized a previously recorded purchase" });
        } catch (err) {
          const code = err instanceof EasyPostError ? err.code : "finalize_failed";
          req.log.error({ err, jobId }, "carrier: finalize of recorded purchase failed (purchase remains recorded)");
          return reply.code(502).send({ error: "purchase_recorded_finalize_failed", detailCode: code, retry: true });
        }
      }
      return reply.code(200).send({ ...toShipmentDTO(existing), note: "already bought for this jobId" });
    }

    try {
      store.reserve({ jobId, kernelId, ownerId: caller, requestFingerprint });
    } catch (err) {
      const code = err instanceof CarrierStoreError ? err.code : "reserve_failed";
      return reply.code(409).send({ error: code });
    }

    // Phase 1: create + buy. On ANY failure here nothing was recorded as
    // purchased — release the reservation so a retry can start clean.
    let bought;
    try {
      bought = await client.createAndBuy(params);
    } catch (err) {
      store.release(jobId);
      if (err instanceof EasyPostError) {
        req.log.warn({ code: err.code, status: err.status, detail: err.detail, jobId }, "carrier: purchase failed before charge was usable");
        const clientFault =
          err.code === "invalid_parcel" ||
          err.code === "invalid_document_hash" ||
          err.code === "provider_mode_not_production" ||
          err.code.endsWith("_ceiling");
        // easypost_bought_but_unusable: EasyPost DID charge but returned an
        // unusable object — releasing the reservation is still correct (we
        // recorded no tracking identity to reconcile against) but it must be
        // loud, not a silent 502.
        if (err.code === "easypost_bought_but_unusable") {
          req.log.error({ detail: err.detail, jobId }, "carrier: EasyPost charged but returned an unusable shipment — manual reconciliation needed");
        }
        return reply.code(clientFault ? 400 : 502).send({ error: err.code });
      }
      req.log.error({ err, jobId }, "carrier: unexpected failure before purchase was recorded");
      return reply.code(502).send({ error: "easypost_label_purchase_failed" });
    }

    // The charge happened. Record it durably BEFORE anything else can fail.
    try {
      store.markPurchased(jobId, bought);
    } catch (err) {
      const code = err instanceof CarrierStoreError ? err.code : "record_purchase_failed";
      req.log.error({ code, jobId, shipmentId: bought.shipmentId, trackingCode: bought.trackingCode }, "carrier: PURCHASE MADE but could not be recorded — manual reconciliation needed");
      return reply.code(500).send({ error: "purchase_made_but_not_recorded", detailCode: code });
    }

    // Phase 2: label bytes -> hash/CID -> commitment. Failure leaves
    // purchased_pending; the identical retry above finalizes it.
    try {
      const finalized = await client.finalizeLabel(params, bought);
      const record = store.finalize(jobId, finalized);
      return reply.code(201).send(toShipmentDTO(record));
    } catch (err) {
      const code = err instanceof EasyPostError ? err.code : err instanceof CarrierStoreError ? err.code : "finalize_failed";
      req.log.error({ code, jobId }, "carrier: purchase recorded, finalize failed — retry same request to finalize");
      return reply.code(502).send({ error: "purchase_recorded_finalize_failed", detailCode: code, retry: true });
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

  // The seam the kernel uses to fold the mail leg into its signed bundle
  // (round-2 NEW-9, option (a) per coord: the kernel PULLS these
  // spec-conformant EvidenceEvents and signs them into the ONE bundle under
  // its kernelSignedEventsRoot — the gateway never signs on the kernel's
  // behalf, so "the party being paid does not author the proof" holds: the
  // kernel signs a bundle CONTAINING a third-party event it could not forge).
  app.get<{ Params: { jobId: string } }>("/api/carrier/shipments/:jobId/evidence", async (req, reply) => {
    const caller = callerId(req);
    if (!caller) return reply.code(401).send({ error: "authentication_required" });
    const record = getCarrierShipmentStore().getByJobId(req.params.jobId);
    if (!record || record.ownerId.toLowerCase() !== caller.toLowerCase()) {
      return reply.code(404).send({ error: "not_found" });
    }
    return { jobId: record.jobId, kernelId: record.kernelId, status: record.status, events: record.events };
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
    if (client.requireProductionMode && trackerEvent.providerMode !== "production") {
      // A sandbox tracker must never become evidence in production. 2xx (do
      // not make EasyPost retry what we will never accept), loudly logged.
      req.log.warn({ trackingCode: trackerEvent.trackingCode, providerMode: trackerEvent.providerMode }, "carrier webhook: non-production tracker refused");
      return reply.code(200).send({ received: true, ignored: true, reason: "provider_mode_not_production" });
    }

    let result;
    try {
      result = await getCarrierShipmentStore().recordCarrierEvent(
        trackerEvent,
        (record, newStatus) => buildCarrierEvidenceEvent(record, newStatus, trackerEvent, rawBody, signatureHeader),
        { rawBodyB64: rawBody.toString("base64"), signatureHeader, parsed: trackerEvent },
      );
    } catch (err) {
      // Evidence build or persistence failed: NOT marked seen, so the
      // provider's retry gets a clean attempt. Non-2xx makes EasyPost retry.
      req.log.error({ err, trackingCode: trackerEvent.trackingCode }, "carrier webhook: failed to apply event");
      return reply.code(500).send({ error: "apply_failed" });
    }

    if (!result.ok) {
      // unknown_tracking_code: genuinely not ours -> 2xx, no retry, logged.
      // not_finalized: OUR purchase but the commitment is not built yet ->
      //   non-2xx so EasyPost RETRIES after the finalize retry lands; the
      //   scan must not be dropped.
      // tracker_missing/_mismatch/shipment_mismatch: same code, different
      //   purchase identity -> refuse, warn (not a benign shape).
      if (result.reason === "not_finalized") {
        req.log.warn({ trackingCode: trackerEvent.trackingCode }, "carrier webhook: scan arrived before finalize; asking provider to retry");
        return reply.code(409).send({ received: false, reason: result.reason, retry: true });
      }
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
