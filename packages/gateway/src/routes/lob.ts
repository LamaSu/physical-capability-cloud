/**
 * Lob routes — create a real Lob letter (a second operator for the same
 * document.print-and-mail contract the human/USPS leg fulfils) and receive
 * Lob's own letter.* webhooks as lifecycle evidence.
 *
 * Mirrors routes/carrier.ts (PR #297) deliberately: same raw-body-for-HMAC
 * content-type parser, same fail-closed webhook posture, same
 * commit-before-confirm evidence shape — so a job can route to Lob or to a
 * human and the buyer agent cannot tell which mailed it.
 *
 * HARDENED to carrier parity (carrier-lane audit, bulletin #1577): fail-closed
 * production classification + per-request config gate (structural, plugin-level),
 * documented live_/test_ key-prefix policy, carrier-grade authn/authz on the money
 * route, owner-only reads, Idempotency-Key on create, and a POST-only apiGate
 * exemption so Lob's webhooks actually reach the HMAC check in deployments.
 *
 * HONEST ASYMMETRY (see lob-client.ts header for the full argument): Lob is
 * printer AND mailer AND webhook emitter, so `letter.mailed` / `letter.delivered`
 * are OPERATOR SELF-REPORT, not an independent USPS scan against a
 * pre-committed label. We still emit the same courier_* EvidenceEvents (fixed
 * @pcc/spec vocabulary) and compute a creation-time commitment, but this leg is
 * a strictly LOWER assurance tier than the human leg. That gap is real and is
 * not papered over.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { hashEvent, type EvidenceEvent, type EvidenceSource } from "@pcc/spec";
import { computeLetterRequestDigest, getLobClient, lobKeyMode, type CreateLetterParams, type LobAddress } from "../services/lob-client.js";
import { isCarrierProductionEnv } from "../services/easypost-client.js";
import {
  getLobLetterStore,
  type LobLetterRecord,
  type LobLetterStatus,
} from "../services/lob-letter-store.js";
import { getJobFacade, getKernelFacade } from "../facades/index.js";

// NOTE: must agree with routes/carrier.ts's identical augmentation — TS merges
// these declarations and rejects conflicting types (that exact conflict broke
// the build when PR #297 and #303 first met). Buffer, byte-exact, everywhere.
declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

interface CreateLetterBody {
  jobId?: string;
  kernelId?: string;
  to?: Partial<LobAddress>;
  from?: Partial<LobAddress>;
  file?: string;
  color?: boolean;
  doubleSided?: boolean;
  description?: string;
  useType?: "operational" | "marketing";
  mailType?: "usps_first_class" | "usps_standard";
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Job states that may still legitimately mail a document — mirrors routes/carrier.ts. */
const ACTIVE_JOB_STATUSES = new Set(["pending", "queued", "in_progress", "paused"]);

function callerId(req: FastifyRequest): string | null {
  const r = req as unknown as { operatorId?: string | null; userId?: string | null };
  return r.operatorId ?? r.userId ?? null;
}

function missingAddressFields(a: Partial<LobAddress> | undefined): string[] {
  const required: (keyof LobAddress)[] = [
    "name",
    "addressLine1",
    "addressCity",
    "addressState",
    "addressZip",
  ];
  if (!a) return required as string[];
  return required.filter((f) => !a[f]) as string[];
}

function toLetterDTO(record: LobLetterRecord) {
  return {
    jobId: record.jobId,
    kernelId: record.kernelId,
    lobLetterId: record.lobLetterId,
    carrier: record.carrier,
    trackingNumber: record.trackingNumber,
    expectedDeliveryDate: record.expectedDeliveryDate,
    url: record.url,
    status: record.status,
    simulated: record.simulated,
    commitment: record.commitment,
    events: record.events,
    // Surfaced on every response so a consumer cannot miss it: this leg is
    // operator self-report, weaker than the human/USPS leg's pre-committed scan.
    assurance: {
      tier: "operator_self_report",
      independentCarrierScan: false,
      note: "Lob prints, mails, and reports the same piece; mailed/delivered are Lob's own assertions, not an independent USPS scan against a pre-committed label.",
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Builds the EvidenceEvent for a mailed/delivered transition; returns null for
 * transitions with no matching evidence-event type (created/rendered/
 * in_transit/failed). Uses the FIXED @pcc/spec vocabulary — no new event types:
 *   letter.mailed    -> courier_pickup_confirmed
 *   letter.delivered -> courier_delivery_confirmed
 * both with deviceType "courier_api". The `simulated` flag rides through from
 * mock mode so detector layers treat fabricated events as non-authentic.
 *
 * NOTE: these are the SAME event types the human/USPS carrier leg emits, on
 * purpose (same contract). The difference is provenance, not vocabulary — see
 * the file header. `trackingNumber` is included only when Lob actually provides
 * one (certified mail); for standard letters it is omitted, honestly.
 */
async function buildLobEvidenceEvent(
  record: LobLetterRecord,
  newStatus: LobLetterStatus,
  occurredAt: string,
): Promise<EvidenceEvent | null> {
  const type =
    newStatus === "mailed"
      ? "courier_pickup_confirmed"
      : newStatus === "delivered"
        ? "courier_delivery_confirmed"
        : null;
  if (!type) return null;

  const source: EvidenceSource = {
    deviceId: `lob:${record.lobLetterId}`,
    deviceType: "courier_api",
    kernelId: record.kernelId,
    simulated: record.simulated,
  };
  const payload: Record<string, unknown> = {
    jobId: record.jobId,
    lobLetterId: record.lobLetterId,
    carrier: record.carrier,
    commitmentHash: record.commitment.hash,
    // Machine-readable tier boundary IN THE SIGNED MATERIAL (sol lob review, R5):
    // the operator_self_report caveat must not live only in the surrounding DTO —
    // a verifier reading the event alone (e.g. folded into a kernel-signed bundle)
    // needs the provenance to refuse treating this as an independent carrier scan.
    provenance: "operator_self_report",
    independentCarrierScan: false,
  };
  // trackingNumber is optional (usually null for Lob standard letters) — only
  // include it when present, so canonical hashing omits it rather than hashing null.
  if (record.trackingNumber) payload.trackingNumber = record.trackingNumber;

  const withoutHash = { type, timestamp: occurredAt, source, payload } as const;
  const hash = await hashEvent(withoutHash);
  return { id: randomUUID(), ...withoutHash, hash };
}

export async function lobRoutes(app: FastifyInstance) {
  /**
   * Production configuration requirements for the Lob capability — recomputed FRESH on
   * every call, never a registration snapshot, under the SAME fail-closed environment
   * classification as the carrier surface (isCarrierProductionEnv: only an explicit
   * NODE_ENV of "test"/"development" opts out; unset or mistyped values are production).
   * Same architecture as routes/carrier.ts post-#316-review; see that file for the
   * full findings trail (snapshot = temporal bypass, NODE_ENV===production = fail-open).
   *
   * TWO requirements, not carrier's four, and the difference is deliberate:
   *  - LOB_API_KEY must be present AND a documented `live_` key. Lob (unlike EasyPost)
   *    documents its prefixes, so a `test_` or unrecognized key in production is
   *    sandbox-as-real and is refused BY NAME. Missing key = mock letters = fabricated
   *    evidence — refused.
   *  - LOB_WEBHOOK_SECRET: without it the lifecycle leg cannot be authenticated.
   *  - A DURABLE letter store (sol lob review R2/R3): Lob's Idempotency-Key covers only
   *    a 24-hour window, so on a real-money endpoint an in-memory record is not
   *    "one job, one charge" — a post-window retry after a restart double-charges, and
   *    lost records orphan paid letters' webhooks. The current store is memory-only,
   *    so in production this requirement keeps the capability 503 BY CONSTRUCTION
   *    until a durable implementation lands. Deliberate fail-closed sequencing, not an
   *    oversight.
   *  - NOT required (owner design calls, flagged in the carrier-lane audit as L5/L7):
   *    the gateway signing key — the Lob commitment is currently unsigned by design;
   *    this leg is operator_self_report tier and the event payloads now carry that
   *    provenance machine-readably.
   */
  const computeMissingLobConfig = (): string[] => {
    if (!isCarrierProductionEnv()) return [];
    const missing: string[] = [];
    const keyMode = lobKeyMode(process.env.LOB_API_KEY);
    if (keyMode === "mock") {
      missing.push("LOB_API_KEY (no key at all means MOCK letters — fabricated evidence)");
    } else if (keyMode !== "live") {
      missing.push("LOB_API_KEY (a live_ key is required in production — test_/unrecognized prefixes are Lob's sandbox)");
    }
    if (!process.env.LOB_WEBHOOK_SECRET) {
      missing.push("LOB_WEBHOOK_SECRET (letter lifecycle events would be unauthenticatable)");
    }
    if (!getLobLetterStore().isDurable) {
      missing.push("durable letter store (in-memory records + a 24h provider idempotency window cannot guarantee one-job-one-charge across restarts)");
    }
    return missing;
  };

  {
    const missingAtBoot = computeMissingLobConfig();
    if (missingAtBoot.length) {
      app.log.error(
        { missing: missingAtBoot },
        "lob capability DISABLED: production config incomplete — lob routes will 503 until the configuration is completed (environment-variable changes require a restart). The rest of the gateway is unaffected.",
      );
    }
  }

  const rejectIfUnconfigured = (reply: FastifyReply, opts?: { redact?: boolean }): boolean => {
    const missing = computeMissingLobConfig();
    if (missing.length === 0) return false;
    reply.code(503).send({
      error: "lob_not_configured",
      message:
        "The Lob (print-and-mail) capability is not configured on this deployment. Other capabilities are unaffected.",
      ...(opts?.redact ? {} : { missing }),
    });
    return true;
  };

  /**
   * STRUCTURAL gate — same two-phase design as routes/carrier.ts (see the extended
   * comment there for the sol-review reasoning): fail-closed DEFAULT, so a route added
   * to this plugin with no declaration gets bearer auth + the config gate; opting out
   * is written into the route (`config.lobGate`): "open" (healthz — self-redacting) or
   * "webhook" (public by design, HMAC is its auth, gate always REDACTED). onRequest
   * fires before parsing; preHandler re-checks and authenticates default routes.
   * Anonymous callers on default routes get a plain 401, never config posture.
   */
  const gateModeOf = (req: FastifyRequest): "open" | "webhook" | undefined =>
    (req.routeOptions?.config as { lobGate?: "open" | "webhook" } | undefined)?.lobGate;

  app.addHook("onRequest", async (req, reply) => {
    const mode = gateModeOf(req);
    if (mode === "open") return;
    if (mode === "webhook") {
      if (rejectIfUnconfigured(reply, { redact: true })) return reply;
      return;
    }
    const caller = callerId(req);
    if (!caller) return; // preHandler 401s them; no config posture for anonymous callers
    if (rejectIfUnconfigured(reply)) return reply;
  });

  app.addHook("preHandler", async (req, reply) => {
    const mode = gateModeOf(req);
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
  // per-register() isolation) — does not affect JSON parsing anywhere else in
  // the gateway. Needed so the webhook route can verify Lob's HMAC over the
  // EXACT bytes received; re-serializing a parsed body can byte-differ from
  // what Lob signed and would break verification.
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

  // lobGate "open": egresses no evidence and spends nothing — and it must stay up to
  // DESCRIBE an unconfigured deployment. Self-redacts for anonymous production callers
  // so plugin confidentiality does not depend on the external apiGate wrapper.
  app.get("/api/lob/healthz", { config: { lobGate: "open" } }, async (req) => {
    const store = getLobLetterStore();
    const missingConfig = computeMissingLobConfig();
    const configured = missingConfig.length === 0;
    if (isCarrierProductionEnv() && !callerId(req)) {
      return {
        ok: configured,
        service: "lob (print-and-mail)",
        configured,
        redacted: true,
        ts: new Date().toISOString(),
      };
    }
    const client = getLobClient();
    return {
      // ok reflects whether the capability is USABLE, not merely that this handler ran.
      ok: configured,
      service: "lob (print-and-mail)",
      configured,
      missingConfig,
      mock: client.isMock,
      keyMode: lobKeyMode(process.env.LOB_API_KEY),
      webhookConfigured: client.hasWebhookSecret,
      letters: store.size(),
      // Constant reminder of the assurance tier for anyone probing health.
      assuranceTier: "operator_self_report",
      ts: new Date().toISOString(),
    };
  });

  // No lobGate declaration on purpose: the plugin preHandler's fail-closed default
  // (401 for anonymous, then the config 503) gates this MONEY route before the handler.
  app.post<{ Body: CreateLetterBody }>("/api/lob/letters", async (req, reply) => {
    const caller = callerId(req);
    if (!caller) return reply.code(401).send({ error: "authentication_required" });

    const b = req.body ?? {};
    const errors: string[] = [];
    if (!b.jobId) errors.push("jobId is required");
    if (!b.kernelId) errors.push("kernelId is required");
    if (!b.file) errors.push("file is required (HTML string, URL, or tmpl_ id)");
    const toMissing = missingAddressFields(b.to);
    if (toMissing.length) errors.push(`to missing: ${toMissing.join(", ")}`);
    const fromMissing = missingAddressFields(b.from);
    if (fromMissing.length) errors.push(`from missing: ${fromMissing.join(", ")}`);
    if (errors.length) return reply.code(400).send({ error: "missing_fields", details: errors });

    // Authorization — carrier-parity (carrier audit L2; sol #297 findings 3/4):
    // this route spends the deployment's Lob balance and binds a destination +
    // document to a PCC job, so the caller must be the operator of the job's
    // assigned kernel, and the job must exist and still be mailable. Without
    // this, any bearer-key holder could charge the account for ANY jobId — and,
    // because creation is idempotent per jobId, permanently squat the job with a
    // bogus destination the legitimate operator can never replace.
    const jobRes = await getJobFacade().getById(b.jobId!);
    if (!jobRes.success) {
      return reply
        .code(jobRes.error.httpStatus === 404 ? 404 : 502)
        .send({ error: jobRes.error.httpStatus === 404 ? "job_not_found" : "job_lookup_failed" });
    }
    if (jobRes.data.kernelId !== b.kernelId) {
      return reply.code(409).send({ error: "kernel_mismatch", message: "kernelId does not match the job's assigned kernel" });
    }
    if (!ACTIVE_JOB_STATUSES.has(jobRes.data.status)) {
      return reply.code(409).send({ error: "job_not_active", status: jobRes.data.status });
    }
    const kernelRes = await getKernelFacade().getById(b.kernelId!);
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

    const letterParams: CreateLetterParams = {
      jobId: b.jobId!,
      to: b.to as LobAddress,
      from: b.from as LobAddress,
      file: b.file!,
      color: b.color,
      doubleSided: b.doubleSided,
      description: b.description,
      useType: b.useType,
      mailType: b.mailType,
    };
    const requestDigest = computeLetterRequestDigest(letterParams);

    const store = getLobLetterStore();
    const existing = store.getByJobId(b.jobId!);
    if (existing) {
      // An existing record belongs to the principal who created it (carrier R5-1):
      // after a kernel re-ownership, the NEW operator must not read or reuse the
      // PREVIOUS operator's letter as if it were their own.
      if (existing.ownerId.toLowerCase() !== caller.toLowerCase() || existing.kernelId !== b.kernelId) {
        req.log.warn({ jobId: b.jobId, recordOwner: existing.ownerId, caller }, "lob: existing letter owned by a different principal/kernel");
        return reply.code(409).send({ error: "lob_record_ownership_mismatch" });
      }
      // Idempotent reuse is legal ONLY for an IDENTICAL request (sol R1): the
      // Idempotency-Key is the jobId, so Lob would answer a changed-body retry
      // with the ORIGINAL letter — and returning it here as if it matched the
      // new body would hand the caller a record whose commitment describes a
      // different document/destination than the physical letter. Refuse loudly.
      if (existing.requestDigest !== requestDigest) {
        req.log.warn({ jobId: b.jobId }, "lob: same jobId, DIFFERENT request body — refusing idempotent reuse");
        return reply.code(409).send({
          error: "idempotency_conflict",
          message: "A letter already exists for this jobId with a DIFFERENT request body. One job mails one document to one destination.",
        });
      }
      // Identical request: never create a second letter (and second charge)
      // for a job we already mailed.
      return reply.code(200).send({ ...toLetterDTO(existing), note: "already created for this jobId" });
    }

    try {
      const client = getLobClient();
      const result = await client.createLetter(letterParams);
      const record = store.create({
        jobId: b.jobId!,
        kernelId: b.kernelId!,
        ownerId: caller,
        lobLetterId: result.lobLetterId,
        carrier: result.carrier,
        trackingNumber: result.trackingNumber,
        expectedDeliveryDate: result.expectedDeliveryDate,
        url: result.url,
        commitment: result.commitment,
        requestDigest: result.requestDigest,
        simulated: result.simulated,
      });
      return reply.code(201).send(toLetterDTO(record));
    } catch (err) {
      return reply.code(502).send({
        error: "lob_create_letter_failed",
        message: err instanceof Error ? err.message : "Failed to create a Lob letter",
      });
    }
  });

  // Evidence plane: the DTO carries the commitment + events. Owner-only, with the same
  // response for missing and not-yours — no existence oracle (carrier parity).
  app.get<{ Params: { jobId: string } }>("/api/lob/letters/:jobId", async (req, reply) => {
    const caller = callerId(req);
    if (!caller) return reply.code(401).send({ error: "authentication_required" });
    const record = getLobLetterStore().getByJobId(req.params.jobId);
    if (!record || record.ownerId.toLowerCase() !== caller.toLowerCase()) {
      return reply.code(404).send({ error: "not_found" });
    }
    return toLetterDTO(record);
  });

  // lobGate "webhook": public by design (Lob cannot present a PCC key — its HMAC is the
  // authentication), so the plugin gate runs FIRST and REDACTED at both phases.
  app.post("/api/lob/webhook", { config: { lobGate: "webhook" } }, async (req, reply) => {
    const client = getLobClient();
    // Fail closed: without a configured secret we cannot verify authenticity,
    // so we refuse to accept events at all (503) rather than trust them.
    if (!client.hasWebhookSecret) {
      return reply.code(503).send({
        error: "webhook_secret_not_configured",
        message: "Set LOB_WEBHOOK_SECRET before pointing a Lob webhook at this endpoint.",
      });
    }

    const sigHeader = req.headers["lob-signature"];
    const tsHeader = req.headers["lob-signature-timestamp"];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const timestamp = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
    const rawBody = req.rawBody ?? Buffer.alloc(0);

    if (!client.verifyWebhookSignature(rawBody, signature, timestamp)) {
      req.log.warn(
        { hasSig: !!signature, hasTs: !!timestamp },
        "lob webhook: signature verification failed",
      );
      return reply.code(401).send({ error: "invalid_signature" });
    }

    // Replay protection (Lob guide Step 4): reject provably-stale timestamps.
    if (client.isReplay(timestamp)) {
      req.log.warn({ timestamp }, "lob webhook: stale timestamp (possible replay)");
      return reply.code(401).send({ error: "stale_timestamp" });
    }

    const event = client.parseLetterEvent(req.body);
    if (!event) {
      // Not a letter.* event we track (e.g. a postcard/check event on the same
      // account) — 2xx so Lob does not retry a webhook we intentionally ignore.
      return reply.code(200).send({ received: true, ignored: true });
    }

    const result = await getLobLetterStore().recordLetterEvent(event, (record, newStatus) =>
      buildLobEvidenceEvent(record, newStatus, event.occurredAt),
    );

    if (!result.ok) {
      // A letter.* event for a letter we never created/committed. Not an error
      // (another integration may share this Lob account) — 2xx so Lob does not
      // retry — but logged, since an uncommitted letter id must never silently
      // become evidence for a PCC job.
      req.log.info(
        { lobLetterId: event.lobLetterId, eventType: event.eventType },
        "lob webhook: no committed letter for this id",
      );
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
