/**
 * Carrier routes — buy a real postage label upstream (before any human
 * touches the envelope) and receive the carrier's own tracking-scan webhook
 * as physical-provenance evidence.
 *
 * This is the mechanism the print-and-mail demo depends on (coord
 * #1585/demo-print-and-mail.md design C): the tracking number is issued by
 * the carrier before execution, so the later scan closes a pre-committed
 * claim the executing human never authored. What the scan proves and does
 * not prove is stated on ShipmentCommitment in services/easypost-client.ts.
 *
 * Authorization (sol #297 findings 3/4): the caller must be the operator of
 * the kernel the job is assigned to; jobId and kernelId are resolved against
 * the authoritative job/kernel records, never trusted from the body, and the
 * job must be in an active state. Reads are owner-only. The webhook path is
 * the ONE public route here — its authentication is the verified provider
 * HMAC (see middleware/api-gate.ts).
 *
 * MONEY CANNOT BE DOUBLE-SPENT OR SILENTLY LOST (sol round 3, R3-1):
 *   reserve (durable lock) -> createShipment (NO charge; failures release)
 *   -> buy_in_flight (durable, BEFORE dispatch) -> buyRate (THE charge)
 *   -> purchased_pending (durable) -> finalize (label bytes + commitment).
 * After dispatch, no path releases: an ambiguous outcome is recovered by
 * asking EasyPost what happened (getShipment) or parked as
 * reconciliation_required for a human — never re-bought on a guess.
 *
 * SCANS ARE NEVER DROPPED AND NEVER BACK-DATED (R3-4/R3-5): a signature-
 * valid scan that cannot yet be matched is durably ledgered and replayed
 * after the purchase/commitment lands; a scan whose carrier timestamp
 * predates commitment.committedAt is permanently non-qualifying.
 *
 * EVIDENCE EMISSION IS GATED (R3-7): an event is only ever created when the
 * commitment's identity equals the stored purchase, its hash recomputes,
 * and — when a signing key is configured — its gateway signature verifies.
 * A failed gate throws (the provider retries); it never emits.
 *
 * PRODUCTION BOOT FAILS CLOSED without: an EasyPost key, a webhook secret,
 * the gateway signing key, and durable storage.
 *
 * Provider: EasyPost. No SDK dependency.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { canonicalize, hashEvent, type EvidenceEvent, type EvidenceSource } from "@pcc/spec";
import {
  EasyPostError,
  POST_CHARGE_ERROR_CODES,
  getEasyPostClient,
  isValidDocumentHash,
  sha256Hex,
  verifyCommitmentHash,
  type CreateLabelParams,
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
    reconciliationReason: record.reconciliationReason,
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

/** The raw material a ledgered scan needs for a faithful later replay. */
interface LedgeredScan {
  rawBodyB64: string;
  signatureHeader: string;
  parsed: TrackerWebhookEvent;
}

/**
 * Builds the EvidenceEvent for a pickup/delivery transition — GATED (R3-7):
 * throws unless the commitment's identity equals the stored purchase, its
 * hash recomputes, and (when a signing key is configured) its gateway
 * signature verifies. The payload still carries the split flags so a
 * downstream verifier re-checks independently rather than trusting ours.
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
  const c = record.commitment;
  if (!c) throw new Error("evidence_gate: no commitment on record (store admitted an unfinalized shipment?)");

  const identityOk =
    c.jobId === record.jobId &&
    c.kernelId === record.kernelId &&
    c.trackingCode === record.trackingCode &&
    c.shipmentId === record.shipmentId &&
    c.trackerId === record.trackerId &&
    c.providerMode === record.providerMode;
  const commitmentHashValid = verifyCommitmentHash(c);
  const commitmentSignatureVerified = await verifyCommitmentSignature(c, gatewayCommitmentKeyResolver);
  if (!identityOk) throw new Error("evidence_gate: commitment identity does not equal the stored purchase");
  if (!commitmentHashValid) throw new Error("evidence_gate: commitment hash does not recompute");
  if (getActiveSigningKey() && !commitmentSignatureVerified) {
    throw new Error("evidence_gate: gateway signature configured but does not verify");
  }

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
    /** Exact signed bytes, base64 — decode and re-run HMAC to re-verify. */
    providerRawBodyB64: rawBody.toString("base64"),
    commitment: c,
    commitmentHashValid,
    commitmentSignatureVerified,
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
  // per-register() isolation). Captures the exact request BYTES so the
  // webhook route can verify EasyPost's HMAC over what was actually signed.
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
      needsReconciliation: store.listNeedsReconciliation().length,
      ts: new Date().toISOString(),
    };
  });

  /** Finalize a recorded purchase, then replay any ledgered scans for its tracking code. */
  async function finalizeAndRespond(
    req: FastifyRequest,
    reply: FastifyReply,
    params: CreateLabelParams,
    record: CarrierShipmentRecord,
    note?: string,
  ) {
    const client = getEasyPostClient();
    const store = getCarrierShipmentStore();
    try {
      const finalized = await client.finalizeLabel(params, {
        shipmentId: record.shipmentId!,
        trackerId: record.trackerId,
        trackingCode: record.trackingCode!,
        labelUrl: record.labelUrl!,
        carrier: record.carrier!,
        service: record.service!,
        rate: record.rate ?? "0",
        currency: record.currency ?? "USD",
        providerMode: record.providerMode ?? "mock",
        mock: record.mock,
      });
      const rec = await store.finalize(params.jobId, finalized);

      // R3-5: scans that arrived before the commitment existed were durably
      // ledgered; replay them now, oldest first. Pre-commitment scans are
      // refused by the store (scan_predates_commitment) — correctly: the
      // commitment did not predate them.
      let replayed = 0;
      const pending = store.takeUnmatched(rec.trackingCode!);
      for (const entry of pending) {
        const scan = entry.data as LedgeredScan;
        if (!scan?.parsed) continue;
        try {
          const res = await store.recordCarrierEvent(
            scan.parsed,
            (r, newStatus) => buildCarrierEvidenceEvent(r, newStatus, scan.parsed, Buffer.from(scan.rawBodyB64, "base64"), scan.signatureHeader),
            scan,
          );
          if (res.ok && res.outcome === "applied") replayed++;
          if (!res.ok) req.log.warn({ eventId: entry.eventId, reason: res.reason }, "carrier: ledgered scan not applied on replay");
        } catch (err) {
          req.log.error({ err, eventId: entry.eventId }, "carrier: ledgered scan replay failed");
        }
      }

      return reply.code(201).send({ ...toShipmentDTO(rec), ...(note ? { note } : {}), replayedScans: replayed });
    } catch (err) {
      const code = err instanceof EasyPostError ? err.code : err instanceof CarrierStoreError ? err.code : "finalize_failed";
      req.log.error({ code, jobId: params.jobId }, "carrier: purchase recorded, finalize failed — retry same request to finalize");
      return reply.code(502).send({ error: "purchase_recorded_finalize_failed", detailCode: code, retry: true });
    }
  }

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
    const params: CreateLabelParams = {
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
      return reply.code(403).send({ error: "kernel_unowned" }); // no principal to authorize — fail closed
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
      switch (existing.status) {
        case "reserved":
          return reply.code(409).send({ error: "job_in_flight" });
        case "reconciliation_required":
          // Parked for a human. Never auto-resolved (R3-1).
          return reply.code(409).send({ error: "reconciliation_required", reason: existing.reconciliationReason });
        case "buy_in_flight": {
          // A prior attempt dispatched /buy and we never learned the outcome.
          // Ask EasyPost what happened (R3-1) — never guess, never re-buy blind.
          try {
            const { bought } = await client.getShipment(existing.createdShipment!);
            if (bought) {
              const rec = await store.markPurchased(jobId, bought);
              return finalizeAndRespond(req, reply, params, rec, "recovered a dispatched purchase");
            }
            // EasyPost shows NO purchase for the shipment we created: the
            // charge did not happen. Safe to buy now, same shipment.
            const bought2 = await client.buyRate(existing.createdShipment!);
            const rec2 = await store.markPurchased(jobId, bought2);
            return finalizeAndRespond(req, reply, params, rec2);
          } catch (err) {
            if (err instanceof EasyPostError && POST_CHARGE_ERROR_CODES.has(err.code)) {
              req.log.error({ code: err.code, detail: err.detail, jobId }, "carrier: recovery hit a post-charge defect — parking for reconciliation");
              await store.markReconciliationRequired(jobId, err.code).catch(() => {});
              return reply.code(409).send({ error: "reconciliation_required", reason: err.code });
            }
            const code = err instanceof EasyPostError ? err.code : "recovery_failed";
            req.log.error({ code, jobId }, "carrier: buy_in_flight recovery failed; state unchanged, retry later");
            return reply.code(502).send({ error: "recovery_failed", detailCode: code, retry: true });
          }
        }
        case "purchased_pending":
          return finalizeAndRespond(req, reply, params, existing, "finalized a previously recorded purchase");
        default:
          return reply.code(200).send({ ...toShipmentDTO(existing), note: "already bought for this jobId" });
      }
    }

    try {
      store.reserve({ jobId, kernelId, ownerId: caller, requestFingerprint });
    } catch (err) {
      const code = err instanceof CarrierStoreError ? err.code : "reserve_failed";
      return reply.code(409).send({ error: code });
    }

    // Step 1: create + price. NO charge yet — every failure here releases.
    let created;
    try {
      created = await client.createShipment(params);
    } catch (err) {
      store.release(jobId);
      if (err instanceof EasyPostError) {
        req.log.warn({ code: err.code, status: err.status, detail: err.detail, jobId }, "carrier: pre-charge failure");
        const clientFault =
          err.code === "invalid_parcel" ||
          err.code === "invalid_document_hash" ||
          err.code === "provider_mode_not_production" ||
          err.code.endsWith("_ceiling");
        return reply.code(clientFault ? 400 : 502).send({ error: err.code });
      }
      req.log.error({ err, jobId }, "carrier: unexpected pre-charge failure");
      return reply.code(502).send({ error: "easypost_label_purchase_failed" });
    }

    // Record the imminent dispatch durably. From here on, release is forbidden.
    try {
      await store.markBuyInFlight(jobId, created);
    } catch (err) {
      // Nothing dispatched yet — releasing is still safe and correct.
      store.release(jobId);
      const code = err instanceof CarrierStoreError ? err.code : "record_dispatch_failed";
      req.log.error({ code, jobId }, "carrier: could not record buy_in_flight; purchase NOT dispatched");
      return reply.code(500).send({ error: "record_dispatch_failed", detailCode: code });
    }

    // Step 2: THE charge. Any failure now is possibly-post-charge.
    let bought;
    try {
      bought = await client.buyRate(created);
    } catch (err) {
      const code = err instanceof EasyPostError ? err.code : "easypost_buy_ambiguous";
      req.log.error({ code, jobId, shipmentId: created.shipmentId }, "carrier: /buy outcome not clean — parking for recovery/reconciliation, NOT releasing");
      if (err instanceof EasyPostError && err.code === "easypost_buy_ambiguous") {
        // Outcome unknown: stay buy_in_flight; the identical retry runs getShipment recovery.
        return reply.code(502).send({ error: "buy_ambiguous_retry_to_recover", retry: true });
      }
      // Known post-charge defect (unusable object, mode mismatch, hard buy error): human decides.
      await store.markReconciliationRequired(jobId, code).catch(() => {});
      return reply.code(409).send({ error: "reconciliation_required", reason: code });
    }

    // The charge happened cleanly. Record it, then finalize.
    let record;
    try {
      record = await store.markPurchased(jobId, bought);
    } catch (err) {
      const code = err instanceof CarrierStoreError ? err.code : "record_purchase_failed";
      req.log.error({ code, jobId, shipmentId: bought.shipmentId, trackingCode: bought.trackingCode }, "carrier: PURCHASE MADE but could not be recorded — parking for reconciliation");
      await store.markReconciliationRequired(jobId, `record_failed:${code}`).catch(() => {});
      return reply.code(409).send({ error: "reconciliation_required", reason: `record_failed:${code}` });
    }
    return finalizeAndRespond(req, reply, params, record);
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
  // (round-2 NEW-9, option (a)): the kernel PULLS these spec-conformant
  // EvidenceEvents and signs them into the ONE bundle under its
  // kernelSignedEventsRoot — the gateway never signs on the kernel's behalf,
  // so "the party being paid does not author the proof" holds: the kernel
  // signs a bundle CONTAINING a third-party event it could not forge.
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
      // Not a processable tracker event — 2xx so EasyPost does not retry forever.
      return reply.code(200).send({ received: true, ignored: true });
    }
    if (client.requireProductionMode && trackerEvent.providerMode !== "production") {
      // A sandbox tracker must never become evidence in production.
      req.log.warn({ trackingCode: trackerEvent.trackingCode, providerMode: trackerEvent.providerMode }, "carrier webhook: non-production tracker refused");
      return reply.code(200).send({ received: true, ignored: true, reason: "provider_mode_not_production" });
    }

    const ledgered: LedgeredScan = { rawBodyB64: rawBody.toString("base64"), signatureHeader, parsed: trackerEvent };

    let result;
    try {
      result = await getCarrierShipmentStore().recordCarrierEvent(
        trackerEvent,
        (record, newStatus) => buildCarrierEvidenceEvent(record, newStatus, trackerEvent, rawBody, signatureHeader),
        ledgered,
      );
    } catch (err) {
      // Evidence gate or persistence failed: NOT marked seen, so the
      // provider's retry gets a clean attempt. Non-2xx makes EasyPost retry.
      req.log.error({ err, trackingCode: trackerEvent.trackingCode }, "carrier webhook: failed to apply event");
      return reply.code(500).send({ error: "apply_failed" });
    }

    if (!result.ok) {
      switch (result.reason) {
        case "unknown_tracking_code":
        case "not_finalized":
          // OURS-maybe but not yet matchable: durably ledger it so nothing
          // depends on the provider retrying long enough (R3-5), then 2xx.
          getCarrierShipmentStore().ledgeUnmatched(trackerEvent, ledgered);
          req.log.info({ trackingCode: trackerEvent.trackingCode, reason: result.reason }, "carrier webhook: ledgered for post-finalize replay");
          return reply.code(200).send({ received: true, pending: true, reason: result.reason });
        case "scan_predates_commitment":
          // Permanently non-qualifying (R3-4): the commitment did not predate
          // this scan, so it can never support the pre-commitment claim.
          req.log.warn({ trackingCode: trackerEvent.trackingCode }, "carrier webhook: scan predates commitment — permanently non-qualifying");
          return reply.code(200).send({ received: true, matched: false, reason: result.reason });
        default:
          // tracker_missing / tracker_mismatch / shipment_mismatch: same
          // code, different purchase identity — refuse, warn.
          req.log.warn({ trackingCode: trackerEvent.trackingCode, reason: result.reason }, "carrier webhook: identity refused");
          return reply.code(200).send({ received: true, matched: false, reason: result.reason });
      }
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
