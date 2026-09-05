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
 * PRODUCTION FAILS CLOSED AT THE REQUEST (not at boot, since #316) without: an EasyPost
 * key, a webhook secret, the gateway signing key, and durable storage — the mail capability
 * goes unavailable and says so (503) while the rest of the gateway boots and serves normally.
 * Since the #316 sol review: readiness is recomputed PER REQUEST (a key that disappears
 * after boot turns into 503s, never into silently-unverified evidence), "production" is the
 * fail-closed DEFAULT classification (only an explicit NODE_ENV of test/development opts
 * out — see isCarrierProductionEnv), and the gate is enforced STRUCTURALLY by one plugin
 * preHandler whose default covers every route that does not visibly opt out.
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
  isCarrierProductionEnv,
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

/**
 * Route-level per-job mutex around the WHOLE purchase/recovery flow. The
 * store's fine-grained locks protect individual mutations (and webhooks vs
 * mutations), but the purchase is a multi-step sequence with an external
 * call in the middle — without this, a second request for the same job could
 * enter the buy_in_flight RECOVERY branch while the first request's /buy is
 * still in flight, "recover" the mock/duplicate purchase, and leave the
 * first request's markPurchased to fail into reconciliation. Serializing at
 * the route makes the second request simply observe the first's outcome.
 * (Deliberately separate from the store's locks: store methods each take the
 * per-job lock themselves, so holding that same lock here would deadlock.)
 */
const purchaseLocks = new Map<string, Promise<unknown>>();
function withPurchaseLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = purchaseLocks.get(jobId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Tail-aware cleanup (R5-5): drop the key once the settling promise is
  // still the current chain tail, so the map does not grow per job forever.
  const tail = run.catch(() => {});
  purchaseLocks.set(jobId, tail);
  void tail.finally(() => {
    if (purchaseLocks.get(jobId) === tail) purchaseLocks.delete(jobId);
  });
  return run;
}
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
    c.providerMode === record.providerMode &&
    c.carrier === record.carrier &&
    c.service === record.service &&
    c.mock === record.mock &&
    c.labelHash === record.labelHash &&
    c.labelCid === record.labelCid;
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
  // Production configuration requirements. The four checks and their reasons are UNCHANGED:
  // buying a label or admitting a carrier scan without them means spending money on, or
  // settling against, evidence nobody can verify.
  //
  // WHAT CHANGED: the failure boundary moved from BOOT to REQUEST. server.ts registers
  // carrierRoutes unconditionally, so throwing here took down the ENTIRE gateway — including
  // deployments that will never mail anything (printing-only, CNC-only), for which a shipping
  // vendor's credential is not a sensible dependency. One capability's vendor became a
  // platform-wide availability dependency, and it reddened master CI because staging boots in
  // production mode without these set.
  //
  // The safety property is preserved exactly — it remains impossible to buy a label or admit a
  // carrier scan without real credentials. Only the blast radius changed: the mail capability
  // becomes unavailable and SAYS SO, instead of the process refusing to start. This is the same
  // shape the webhook route below already used (503 + a named, actionable reason).
  /**
   * Compute readiness FRESH on every call — never a registration-time snapshot
   * (sol #316 review, finding 3: a snapshot is a temporal bypass. If the signing key
   * disappears after boot, a snapshot keeps admitting evidence while signature
   * verification has silently stopped; recomputing turns that into a 503).
   *
   * The classification is fail-closed via isCarrierProductionEnv (finding 2): only an
   * explicit NODE_ENV of "test" or "development" opts out — unset or mistyped values
   * get the full 4-requirement gate, so a prod box that forgets NODE_ENV can never
   * spend money or admit evidence unconfigured. The client's mock refusal derives from
   * the SAME function, so the gate and the mock policy cannot diverge.
   */
  const computeMissingConfig = (): string[] => {
    if (!isCarrierProductionEnv()) return [];
    const missing: string[] = [];
    if (!process.env.EASYPOST_API_KEY) missing.push("EASYPOST_API_KEY (mock labels are fabricated evidence)");
    if (!process.env.EASYPOST_WEBHOOK_SECRET) missing.push("EASYPOST_WEBHOOK_SECRET (spending with no functioning proof webhook)");
    if (!getActiveSigningKey()) missing.push("PCC_AGENT_CARD_SIGNING_KEY (an unsigned commitment is a hash anyone can recompute, not an attestation)");
    if (!getCarrierShipmentStore().isDurable) missing.push("durable carrier store (in-memory commitments vanish on restart; re-purchase + unmatched webhooks)");
    return missing;
  };

  // One-shot ops visibility at registration. The GUARD does not use this value —
  // it recomputes per request.
  {
    const missingAtBoot = computeMissingConfig();
    if (missingAtBoot.length) {
      app.log.error(
        { missing: missingAtBoot },
        "carrier capability DISABLED: production config incomplete — carrier routes will 503 until the configuration is completed (environment-variable changes require a restart). The rest of the gateway is unaffected.",
      );
    }
  }

  /**
   * Fail closed at request time for anything that can spend money or admit evidence.
   * Returns true if the request was rejected.
   *
   * `redact` (sol #316 review, finding 5): the webhook is the one PUBLIC carrier route
   * and its gate runs before HMAC auth, so an anonymous caller must not receive the
   * missing[] posture (signing-key + storage-durability status). Authenticated surfaces
   * get the actionable detail; so does /api/carrier/healthz, which sits behind apiGate.
   */
  const rejectIfUnconfigured = (reply: FastifyReply, opts?: { redact?: boolean }): boolean => {
    const missing = computeMissingConfig();
    if (missing.length === 0) return false;
    reply.code(503).send({
      error: "carrier_not_configured",
      message:
        "The carrier (mail) capability is not configured on this deployment. Other capabilities are unaffected.",
      ...(opts?.redact ? {} : { missing }),
    });
    return true;
  };

  /**
   * STRUCTURAL gate — one preHandler for the whole plugin, so completeness is a
   * property of the structure, not of per-route discipline (sol #316 review, systemic:
   * finding 1 was exactly a per-handler guard omission, on the route next to a guarded one).
   *
   * Fail-closed by DEFAULT: a route registered in this plugin with no declaration gets
   * bearer auth + the full config gate. Opting out must be written into the route
   * (`config: { carrierGate: ... }`) where a reviewer can see it:
   *   - "open"    → no gate. ONLY for routes that egress no evidence and spend nothing
   *                 (healthz — and it still reports the missing config, behind apiGate).
   *   - "webhook" → public by design (HMAC is its auth), so the gate runs REDACTED:
   *                 an anonymous caller learns the capability is unconfigured, not which
   *                 of the four requirements is missing (finding 5).
   *   - default   → 401 for anonymous callers FIRST (an anonymous caller learns nothing,
   *                 not even the redacted posture), then the detailed 503.
   */
  app.addHook("preHandler", async (req, reply) => {
    const mode = (req.routeOptions?.config as { carrierGate?: "open" | "webhook" } | undefined)?.carrierGate;
    if (mode === "open") return;
    if (mode === "webhook") {
      if (rejectIfUnconfigured(reply, { redact: true })) return reply;
      return;
    }
    const caller = callerId(req);
    if (!caller) {
      reply.code(401).send({ error: "authentication_required" });
      return reply;
    }
    if (rejectIfUnconfigured(reply)) return reply;
  });

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

  // carrierGate "open": egresses no evidence and spends nothing — and it is the surface
  // that must stay up to DESCRIBE an unconfigured deployment (behind apiGate at the server).
  app.get("/api/carrier/healthz", { config: { carrierGate: "open" } }, async () => {
    const store = getCarrierShipmentStore();
    // Fresh, not a boot snapshot: healthz must describe the deployment as it is NOW
    // (a signing key that vanished after boot shows up here, and in the 503s).
    const missingConfig = computeMissingConfig();
    const carrierConfigured = missingConfig.length === 0;
    // getEasyPostClient() THROWS mock_forbidden_in_production when NODE_ENV=production and
    // EASYPOST_API_KEY is unset (easypost-client.ts:385, requireProductionMode derived from
    // NODE_ENV at :850) — i.e. in exactly the unconfigured-production case this endpoint most
    // needs to describe. Eagerly constructing it here made healthz 500 precisely when an
    // operator is trying to find out what is wrong. Degrade instead: report the client as
    // unavailable and still answer with everything else.
    let client: ReturnType<typeof getEasyPostClient> | null = null;
    let clientError: string | null = null;
    try {
      client = getEasyPostClient();
    } catch (err) {
      clientError = err instanceof Error ? err.message : String(err);
    }
    return {
      // `ok` reflects whether the carrier capability is actually usable, not merely whether
      // this handler ran. An operator polling healthz should not read a green ok while the
      // capability is disabled.
      ok: carrierConfigured && !clientError,
      service: "carrier (EasyPost)",
      configured: carrierConfigured,
      missingConfig,
      clientError,
      mock: client?.isMock ?? null,
      requireProductionMode: client?.requireProductionMode ?? null,
      webhookConfigured: client?.hasWebhookSecret ?? false,
      commitmentSigningConfigured: !!getActiveSigningKey(),
      durable: store.isDurable,
      maxRateUsd: client?.maxRateUsd ?? null,
      maxWeightOz: client?.maxWeightOz ?? null,
      shipments: store.size(),
      pendingFinalize: store.listPendingFinalize().length,
      needsReconciliation: store.listNeedsReconciliation().length,
      unmatchedLedger: store.unmatchedStats(),
      ts: new Date().toISOString(),
    };
  });

  /** Park a possibly-charged purchase for a human. A parking FAILURE is its own loud error (R4-5) — never a durable-looking 409 over an unparked row. */
  async function park(req: FastifyRequest, reply: FastifyReply, jobId: string, reason: string) {
    try {
      await getCarrierShipmentStore().markReconciliationRequired(jobId, reason);
    } catch (err) {
      const code = err instanceof CarrierStoreError ? err.code : "parking_failed";
      req.log.error({ code, jobId, reason }, "carrier: FAILED TO PARK a post-charge outcome — state may not reflect the response");
      return reply.code(500).send({ error: "parking_failed", detailCode: code, originalReason: reason });
    }
    return reply.code(409).send({ error: "reconciliation_required", reason });
  }

  /**
   * Drain the unmatched-scan ledger for a finalized shipment (R3-5, R4-1,
   * R6-1, R6-2). Callable from finalize AND from the idempotent already-
   * bought path, so a row retained by a transient replay failure is drained
   * by the next identical POST rather than stranded forever (R6-1).
   *
   * TRUST COMES FROM THE SIGNED BYTES, not the ledgered parsed object
   * (R6-2): each entry's raw body is HMAC-re-verified, re-parsed, and must
   * agree with the ledger row's own event id + tracking code; the evidence
   * is built exclusively from that freshly verified parse. A row whose
   * signature or identity does not re-verify is corrupt (or the webhook
   * secret was rotated underneath it): it can never become evidence, so it
   * is removed with a loud error rather than retried forever.
   */
  async function drainUnmatched(req: FastifyRequest, rec: CarrierShipmentRecord): Promise<number> {
    const store = getCarrierShipmentStore();
    const client = getEasyPostClient();
    if (!rec.trackingCode) return 0;
    let replayed = 0;
    for (const entry of store.peekUnmatched(rec.trackingCode)) {
      const scan = entry.data as LedgeredScan;
      if (typeof scan?.rawBodyB64 !== "string" || typeof scan?.signatureHeader !== "string") {
        req.log.error({ eventId: entry.eventId }, "carrier: ledgered scan entry malformed — kept for inspection");
        continue;
      }
      const rawBody = Buffer.from(scan.rawBodyB64, "base64");
      if (!client.verifyWebhookSignature(rawBody, scan.signatureHeader)) {
        req.log.error({ eventId: entry.eventId }, "carrier: ledgered scan signature does not re-verify (corrupt row or rotated secret) — removed, cannot become evidence");
        store.deleteUnmatched(entry.eventId);
        continue;
      }
      let verified: TrackerWebhookEvent | null = null;
      try {
        verified = client.parseTrackerEvent(JSON.parse(rawBody.toString("utf8")));
      } catch {
        verified = null;
      }
      if (!verified || verified.easypostEventId !== entry.eventId || verified.trackingCode !== entry.trackingCode) {
        req.log.error({ eventId: entry.eventId }, "carrier: ledgered scan bytes disagree with ledger identity — removed, cannot become evidence");
        store.deleteUnmatched(entry.eventId);
        continue;
      }
      try {
        const res = await store.recordCarrierEvent(
          verified,
          (r, newStatus) => buildCarrierEvidenceEvent(r, newStatus, verified!, rawBody, scan.signatureHeader),
          scan,
        );
        if (res.ok) {
          if (res.outcome === "applied") replayed++;
          store.deleteUnmatched(entry.eventId);
        } else if (res.reason === "not_finalized" || res.reason === "unknown_tracking_code") {
          req.log.warn({ eventId: entry.eventId, reason: res.reason }, "carrier: ledgered scan still unmatchable — kept");
        } else {
          // Permanent refusal (predates commitment / identity mismatch): final outcome.
          req.log.warn({ eventId: entry.eventId, reason: res.reason }, "carrier: ledgered scan permanently non-qualifying");
          store.deleteUnmatched(entry.eventId);
        }
      } catch (err) {
        req.log.error({ err, eventId: entry.eventId }, "carrier: ledgered scan replay failed — row kept; the next identical POST retries it");
      }
    }
    return replayed;
  }

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

      const replayed = await drainUnmatched(req, rec);
      return reply.code(201).send({ ...toShipmentDTO(rec), ...(note ? { note } : {}), replayedScans: replayed });
    } catch (err) {
      const code = err instanceof EasyPostError ? err.code : err instanceof CarrierStoreError ? err.code : "finalize_failed";
      req.log.error({ code, jobId: params.jobId }, "carrier: purchase recorded, finalize failed — retry same request to finalize");
      return reply.code(502).send({ error: "purchase_recorded_finalize_failed", detailCode: code, retry: true });
    }
  }

  // No carrierGate declaration on purpose: the plugin preHandler's fail-closed default
  // (401 for anonymous, then the detailed config 503) is the gate for this money route.
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

    const requestFingerprint = sha256Hex(
      // jobId + kernelId included (R5-4): a fingerprint that omits routing
      // identity could let a retry finalize under different bindings.
      canonicalize({ jobId, kernelId, toAddress: b.toAddress, fromAddress: b.fromAddress, parcel: b.parcel, documentHash: b.documentHash }),
    );

    const store = getCarrierShipmentStore();
    const client = getEasyPostClient();

    return withPurchaseLock(jobId, async () => {
    // Authorization runs INSIDE the purchase lock (R5-2): a request that
    // queued behind another purchase must be judged against the job/kernel
    // state as it is NOW — not as it was before it started waiting. A job
    // cancelled, or a kernel re-owned, while this request was queued must
    // refuse here, immediately before any reservation or charge.
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

    const existing = store.getByJobId(jobId);
    if (existing) {
      // R5-1: an existing carrier record belongs to the principal who bought
      // it. After a kernel ownership or job re-assignment change, the NEW
      // operator must not recover/finalize/read the PREVIOUS operator's
      // purchase — that hand-over is a human decision, not an idempotent
      // retry. (The caller here already passed current-kernel authz; this
      // guards the stored record's own provenance.)
      if (existing.ownerId.toLowerCase() !== caller.toLowerCase() || existing.kernelId !== kernelId) {
        req.log.warn({ jobId, recordOwner: existing.ownerId, caller }, "carrier: existing record owned by a different principal/kernel");
        return reply.code(409).send({ error: "carrier_record_ownership_mismatch" });
      }
      // A `reserved` row is adjudicated by store.reserve() below — BEFORE the
      // fingerprint check: a reservation is not a purchase, so an EXPIRED one
      // must be reclaimable even by a request with different parameters
      // (sol R3-9); a live one answers job_in_flight from reserve(). The
      // guard is also load-bearing for the switch: without it the default
      // branch would answer 200 "already bought" over a bare reservation.
      if (existing.status !== "reserved") {
      if (existing.requestFingerprint !== requestFingerprint) {
        return reply
          .code(409)
          .send({ error: "idempotency_conflict", message: "a purchase already exists for this jobId with different parameters" });
      }
      switch (existing.status) {
        case "reconciliation_required":
          // Parked for a human. Never auto-resolved (R3-1).
          return reply.code(409).send({ error: "reconciliation_required", reason: existing.reconciliationReason });
        case "buy_in_flight": {
          // A prior attempt dispatched /buy and we never learned the outcome.
          // Ask EasyPost what happened (R3-1) — never guess, never re-buy blind.
          // Phase A: the LOOKUP. A transient failure here is retryable (state
          // unchanged); a post-charge classification parks.
          let recovered: Awaited<ReturnType<typeof client.getShipment>>["bought"];
          try {
            recovered = (await client.getShipment(existing.createdShipment!)).bought;
          } catch (err) {
            if (err instanceof EasyPostError && POST_CHARGE_ERROR_CODES.has(err.code)) {
              req.log.error({ code: err.code, detail: err.detail, jobId }, "carrier: recovery hit a post-charge defect — parking for reconciliation");
              return park(req, reply, jobId, err.code);
            }
            const code = err instanceof EasyPostError ? err.code : "recovery_failed";
            req.log.error({ code, jobId }, "carrier: buy_in_flight recovery lookup failed; state unchanged, retry later");
            return reply.code(502).send({ error: "recovery_failed", detailCode: code, retry: true });
          }
          // Phase B: no purchase on record at EasyPost — safe to buy the SAME
          // created shipment. Ambiguity here loops back to recovery.
          if (!recovered) {
            try {
              recovered = await client.buyRate(existing.createdShipment!);
            } catch (err) {
              if (err instanceof EasyPostError && err.code === "easypost_buy_ambiguous") {
                return reply.code(502).send({ error: "buy_ambiguous_retry_to_recover", retry: true });
              }
              const code = err instanceof EasyPostError ? err.code : "easypost_buy_failed";
              req.log.error({ code, jobId }, "carrier: recovery re-buy hit a post-dispatch defect — parking");
              return park(req, reply, jobId, code);
            }
          }
          // Phase C: a CONFIRMED purchase exists. ANY failure to record it is
          // a post-charge fact and parks — never a plain 502 that hides a
          // charge behind an ambiguous-looking retry (sol R3-1 residual).
          try {
            const rec = await store.markPurchased(jobId, recovered);
            return finalizeAndRespond(req, reply, params, rec, "recovered a dispatched purchase");
          } catch (err) {
            const code = err instanceof CarrierStoreError ? err.code : "persist_failed";
            req.log.error({ code, jobId }, "carrier: confirmed purchase could not be recorded — parking for reconciliation");
            return park(req, reply, jobId, `record_failed:${code}`);
          }
        }
        case "purchased_pending":
          return finalizeAndRespond(req, reply, params, existing, "finalized a previously recorded purchase");
        default: {
          // Trackable/terminal: drain any retained ledgered scans too (R6-1)
          // — a transient replay failure after finalize must be retryable by
          // the next identical POST, never stranded forever.
          const drained = await drainUnmatched(req, existing);
          return reply.code(200).send({ ...toShipmentDTO(existing), note: "already bought for this jobId", replayedScans: drained });
        }
      }
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
      return park(req, reply, jobId, code);
    }

    // The charge happened cleanly. Record it, then finalize.
    let record;
    try {
      record = await store.markPurchased(jobId, bought);
    } catch (err) {
      const code = err instanceof CarrierStoreError ? err.code : "record_purchase_failed";
      req.log.error({ code, jobId, shipmentId: bought.shipmentId, trackingCode: bought.trackingCode }, "carrier: PURCHASE MADE but could not be recorded — parking for reconciliation");
      return park(req, reply, jobId, `record_failed:${code}`);
    }
    return finalizeAndRespond(req, reply, params, record);
    });
  });

  // Evidence plane: toShipmentDTO carries commitment + events — the SAME spec-shaped
  // material as the /:jobId/evidence route below. sol's #316 review (finding 1) caught this
  // route unguarded while its neighbour was guarded: an authenticated owner could pull
  // carrier evidence from an unconfigured deployment (a durable store that still holds prior
  // records after a key is removed) and a kernel could fold it into a signed bundle. The
  // plugin preHandler's fail-closed DEFAULT now covers it — and any future egress route —
  // structurally, so that omission cannot recur.
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
  // Evidence plane: an unconfigured deployment must say so rather than return an empty
  // event list, which a kernel could mistake for "the carrier leg legitimately has no
  // events yet" and fold into a bundle. Explicit 503 (plugin preHandler default) beats a
  // silent absence here.
  app.get<{ Params: { jobId: string } }>("/api/carrier/shipments/:jobId/evidence", async (req, reply) => {
    const caller = callerId(req);
    if (!caller) return reply.code(401).send({ error: "authentication_required" });
    const record = getCarrierShipmentStore().getByJobId(req.params.jobId);
    if (!record || record.ownerId.toLowerCase() !== caller.toLowerCase()) {
      return reply.code(404).send({ error: "not_found" });
    }
    return { jobId: record.jobId, kernelId: record.kernelId, status: record.status, events: record.events };
  });

  // carrierGate "webhook": admits evidence into the settlement path. No bearer auth here by
  // design (HMAC is the authentication), so the plugin preHandler runs the gate FIRST and
  // REDACTED — an anonymous caller learns only that the capability is unconfigured, never
  // which of the four requirements is missing (sol #316 review, finding 5). The gate is
  // broader than the webhook-secret check below: without the signing key a commitment is
  // unattested, and without a durable store the commitment it must match may have vanished
  // on restart.
  app.post("/api/carrier/webhook/easypost", { config: { carrierGate: "webhook" } }, async (req, reply) => {
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
        // Ledgering happens INSIDE the store's per-job/per-code lock (R4-2),
        // so a concurrent finalize cannot slip between decision and insert.
        { ledgerUnmatched: true },
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
          // OURS-maybe but not yet matchable: already durably ledgered by the
          // store (R3-5), under its lock (R4-2). 2xx — we hold it now.
          req.log.info({ trackingCode: trackerEvent.trackingCode, reason: result.reason, ledgered: result.ledgered === true }, "carrier webhook: ledgered for post-finalize replay");
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
