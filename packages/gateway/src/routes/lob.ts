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
 * HONEST ASYMMETRY (see lob-client.ts header for the full argument): Lob is
 * printer AND mailer AND webhook emitter, so `letter.mailed` / `letter.delivered`
 * are OPERATOR SELF-REPORT, not an independent USPS scan against a
 * pre-committed label. We still emit the same courier_* EvidenceEvents (fixed
 * @pcc/spec vocabulary) and compute a creation-time commitment, but this leg is
 * a strictly LOWER assurance tier than the human leg. That gap is real and is
 * not papered over.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { hashEvent, type EvidenceEvent, type EvidenceSource } from "@pcc/spec";
import { getLobClient, type LobAddress } from "../services/lob-client.js";
import {
  getLobLetterStore,
  type LobLetterRecord,
  type LobLetterStatus,
} from "../services/lob-letter-store.js";

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
  };
  // trackingNumber is optional (usually null for Lob standard letters) — only
  // include it when present, so canonical hashing omits it rather than hashing null.
  if (record.trackingNumber) payload.trackingNumber = record.trackingNumber;

  const withoutHash = { type, timestamp: occurredAt, source, payload } as const;
  const hash = await hashEvent(withoutHash);
  return { id: randomUUID(), ...withoutHash, hash };
}

export async function lobRoutes(app: FastifyInstance) {
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

  app.get("/api/lob/healthz", async () => {
    const store = getLobLetterStore();
    const client = getLobClient();
    return {
      ok: true,
      service: "lob (print-and-mail)",
      mock: client.isMock,
      webhookConfigured: client.hasWebhookSecret,
      letters: store.size(),
      // Constant reminder of the assurance tier for anyone probing health.
      assuranceTier: "operator_self_report",
      ts: new Date().toISOString(),
    };
  });

  app.post<{ Body: CreateLetterBody }>("/api/lob/letters", async (req, reply) => {
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

    const store = getLobLetterStore();
    const existing = store.getByJobId(b.jobId!);
    if (existing) {
      // Idempotent per jobId: never create a second letter (and second charge)
      // for a job we already mailed.
      return reply.code(200).send({ ...toLetterDTO(existing), note: "already created for this jobId" });
    }

    try {
      const client = getLobClient();
      const result = await client.createLetter({
        jobId: b.jobId!,
        to: b.to as LobAddress,
        from: b.from as LobAddress,
        file: b.file!,
        color: b.color,
        doubleSided: b.doubleSided,
        description: b.description,
        useType: b.useType,
        mailType: b.mailType,
      });
      const record = store.create({
        jobId: b.jobId!,
        kernelId: b.kernelId!,
        lobLetterId: result.lobLetterId,
        carrier: result.carrier,
        trackingNumber: result.trackingNumber,
        expectedDeliveryDate: result.expectedDeliveryDate,
        url: result.url,
        commitment: result.commitment,
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

  app.get<{ Params: { jobId: string } }>("/api/lob/letters/:jobId", async (req, reply) => {
    const record = getLobLetterStore().getByJobId(req.params.jobId);
    if (!record) return reply.code(404).send({ error: "not_found" });
    return toLetterDTO(record);
  });

  app.post("/api/lob/webhook", async (req, reply) => {
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
