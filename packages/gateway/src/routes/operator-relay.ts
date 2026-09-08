/**
 * Operator relay endpoints -- the pcc-node HTTP polling protocol.
 *
 * These routes are the gateway side of the pcc-node protocol loop.
 * The pcc-node polls these endpoints instead of needing a persistent
 * WebSocket connection, which keeps the node zero-dependency.
 *
 *   GET  /api/operator/jobs           — poll for pending jobs (kernelId + status filter)
 *   POST /api/operator/evidence       — push evidence bundle from operator node
 *   POST /api/operator/heartbeat      — operator heartbeat + capability re-announcement
 *   POST /api/operator/job-status     — update job status from operator node
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import { getRepos, getStore } from "../db.js";
import { getJobFacade, getKernelFacade } from "../facades/index.js";
import { JOB_STATUSES, normalizeJobStatus } from "../config/job-status.js";
import { extractNodeSignedBundle } from "../services/device-evidence-settlement.js";
import {
  buildCanonicalEvidenceEnvelope,
  isEvidenceHashForm,
  type EvidenceEnvelopeEvent,
} from "../services/evidence-envelope.js";
import { v4 as uuidv4 } from "uuid";
import crypto from "node:crypto";

function sendResult<T>(reply: FastifyReply, result: Result<T>): unknown {
  if (result.success) return result.data;
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}

// ---------------------------------------------------------------------------
// Request body types
// ---------------------------------------------------------------------------

interface EvidenceBody {
  jobId: string;
  kernelId?: string;
  evidence: Record<string, unknown>;
  timestamp?: number;
}

interface HeartbeatBody {
  kernelId: string;
  status?: string;
  capabilities?: Array<Record<string, unknown>>;
  timestamp?: number;
}

interface JobStatusBody {
  jobId: string;
  kernelId?: string;
  status: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// LO-GW-4a — the "no signature" record
// ---------------------------------------------------------------------------

/**
 * What the unsigned relay path stores in `kernelSignature`.
 *
 * The honest value is SQL NULL, and that is what the ROUTE emits in its
 * response. It is not what the column can hold: `evidence_bundles
 * .kernel_signature` is `TEXT NOT NULL` (packages/db/src/migrate.ts:89), and
 * relaxing that is a SQLite table rebuild on the money-path evidence table —
 * out of scope here, and flagged as a follow-up rather than done quietly.
 *
 * So absence is recorded, inside the constraint, as a value that asserts
 * NOTHING: no signer is named, the algorithm is literally "none", the value is
 * empty. Contrast the record it replaces —
 * `{signer: <kernelId>, algorithm: "sha256", value: "operator-relay-auto"}` —
 * which named a real kernel as the signer of bytes it never signed.
 * `isDeviceSignedSignature` rejects this on three independent grounds
 * (algorithm, empty value, empty signer), so it can never anchor settlement.
 */
export const NO_DEVICE_SIGNATURE = {
  signer: "",
  algorithm: "none",
  value: "",
} as const;

// ---------------------------------------------------------------------------
// LO-GW-4b — relayed event extraction
// ---------------------------------------------------------------------------

/**
 * Pull the `events` array out of a relayed evidence body and normalise each
 * entry down to the six envelope fields.
 *
 * Why this exists: before this, POST /api/operator/evidence NEVER called
 * `repos.evidence.insertEvents` — the string "events" did not occur anywhere in
 * this file — so every event a pcc-node pushed was silently discarded on BOTH
 * the signed and unsigned branches. The bundle row survived; the evidence
 * inside it did not. `GET /api/evidence/:hash` then served an envelope with
 * `events: []`, and the oracle's authenticity-of-origin floor (pcc-oracle
 * PR #15) reads `bundle.events[]` off that document — a doc with no events
 * verifies but detects nothing.
 *
 * Normalisation rules (all fail-open on a malformed entry, which is skipped):
 *   - `type` is required and must be a string; anything else is not an event.
 *   - `id` is BUNDLE-SCOPED before storage (`<bundleId>:<node id>`, or
 *     `<bundleId>-ev-<i>` when the node omitted one) because
 *     `evidence_events.id` is a GLOBAL primary key while the node's id is only
 *     unique inside its own bundle. `hash` is derived deterministically when
 *     omitted (content hash over the other five fields). The SAME array is
 *     hashed and stored, so the canonical envelope round-trips byte-identically.
 *   - Two events sharing an id INSIDE one bundle are reported in
 *     `duplicateIds` and dropped; the caller refuses the whole relay rather
 *     than rewriting the node's data.
 *   - `source` is preserved verbatim when the node supplied one. When it did
 *     not, the gateway records where the event actually came from — the relay —
 *     rather than inventing a device identity it cannot attest to.
 */
function extractRelayedEvents(
  evidence: unknown,
  ctx: { bundleId: string; kernelId: string; now: string },
): { events: EvidenceEnvelopeEvent[]; duplicateIds: string[] } {
  if (!evidence || typeof evidence !== "object") return { events: [], duplicateIds: [] };
  const root = evidence as Record<string, unknown>;
  // Mirror extractNodeSignedBundle's `{ bundle: {...} }` unwrap so a signed
  // bundle's events are found on the same path its signature is.
  const b = (root.bundle && typeof root.bundle === "object" ? root.bundle : root) as Record<
    string,
    unknown
  >;
  const raw = Array.isArray(b.events) ? b.events : Array.isArray(root.events) ? root.events : null;
  if (!raw) return { events: [], duplicateIds: [] };

  const out: EvidenceEnvelopeEvent[] = [];
  const seenNodeIds = new Set<string>();
  const duplicateIds: string[] = [];
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") return;
    const e = entry as Record<string, unknown>;
    if (typeof e.type !== "string" || e.type === "") return;

    // BUNDLE-SCOPED STORAGE ID (round 2). `evidence_events.id` is a GLOBAL
    // `TEXT PRIMARY KEY` (packages/db/src/migrate.ts), but `EvidenceEvent.id`
    // is only unique WITHIN the node's own bundle — the kernel-sdk mints it per
    // job (`id: ids.evidence()`), and the spec makes it REQUIRED, so the
    // collision-eligible shape is the canonical one. Feeding a bundle-scoped
    // identifier straight into a global key is the defect: a node that relays
    // the same spec-conformant bundle twice (a retry after a timeout) reuses
    // its stable event ids, collides with the FIRST bundle's rows, and — since
    // `insertEvents` is one multi-row INSERT — aborts EVERY row of the retry.
    //
    // The relay is the boundary where an un-namespaced external id enters a
    // global keyspace, so the relay is where it gets scoped. The gateway's own
    // fallback id was ALREADY bundle-scoped (`<bundleId>-ev-<i>`); this makes
    // both branches consistent instead of inventing a second convention. The
    // node's own id stays legible as the suffix, and because the SAME array is
    // both hashed and stored, the envelope still round-trips byte-identically.
    const nodeEventId = typeof e.id === "string" && e.id !== "" ? e.id : null;
    if (nodeEventId !== null) {
      if (seenNodeIds.has(nodeEventId)) {
        // Two events in ONE bundle naming themselves the same id. Scoping
        // cannot separate them and renaming one would silently rewrite the
        // node's data, so this is reported to the caller rather than resolved
        // by guesswork. See the 400 in POST /api/operator/evidence.
        duplicateIds.push(nodeEventId);
        return;
      }
      seenNodeIds.add(nodeEventId);
    }
    const id = nodeEventId !== null ? `${ctx.bundleId}:${nodeEventId}` : `${ctx.bundleId}-ev-${i}`;
    const timestamp = typeof e.timestamp === "string" && e.timestamp !== "" ? e.timestamp : ctx.now;
    const source =
      e.source && typeof e.source === "object"
        ? e.source
        : {
            // Honest provenance: the gateway saw this event arrive over the
            // operator relay. It did NOT observe a device produce it.
            deviceId: "operator-relay",
            deviceType: "relay",
            kernelId: ctx.kernelId,
          };
    const payload = e.payload && typeof e.payload === "object" ? e.payload : {};
    const hash =
      typeof e.hash === "string" && e.hash !== ""
        ? e.hash
        : `sha256:${crypto
            .createHash("sha256")
            .update(JSON.stringify({ id, type: e.type, timestamp, source, payload }))
            .digest("hex")}`;

    out.push({ id, type: e.type, timestamp, source, payload, hash });
  });
  return { events: out, duplicateIds };
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function operatorRelayRoutes(app: FastifyInstance) {
  const jobFacade = getJobFacade();
  const kernelFacade = getKernelFacade();
  /**
   * GET /api/operator/jobs
   *
   * Query params:
   *   kernelId  — filter by kernel (required)
   *   status    — filter by status (default: "queued")
   *
   * Returns { jobs: Job[] }
   */
  app.get<{
    Querystring: { kernelId?: string; status?: string };
  }>("/api/operator/jobs", async (req, reply) => {
    const { kernelId, status = "queued" } = req.query;

    if (!kernelId) {
      return reply.code(400).send({ error: "kernelId query param required" });
    }

    const result = await jobFacade.list({ kernelId, status });
    if (!result.success) return { jobs: [] };
    return { jobs: result.data.items ?? [] };
  });

  /**
   * POST /api/operator/evidence
   *
   * Push an evidence bundle from an operator node after job execution.
   * Stores the bundle and links it to the job.
   *
   * Body: { jobId, kernelId?, evidence: { ... }, timestamp? }
   */
  app.post<{ Body: EvidenceBody }>("/api/operator/evidence", async (req, reply) => {
    const { jobId, kernelId, evidence, timestamp } = req.body ?? {};

    if (!jobId) {
      return reply.code(400).send({ error: "jobId required" });
    }
    if (!evidence) {
      return reply.code(400).send({ error: "evidence required" });
    }

    try {
      const repos = getRepos();

      // Verify the job exists
      const job = repos.jobs.findById(jobId);
      if (!job) {
        // Return 200 anyway — the node shouldn't hard-fail on this
        app.log.warn(`operator-relay: evidence for unknown job ${jobId}`);
        return {
          stored: false,
          jobId,
          warning: "job_not_found",
          timestamp: new Date().toISOString(),
        };
      }

      // Store evidence bundle
      const bundleId = `ev-${uuidv4()}`;
      const now = new Date().toISOString();

      // SEAM-2 (path 1): capture the node's REAL device (#236) Ed25519 signature and
      // real bundleHash when the pushed evidence carries a signed bundle — instead of
      // discarding the signature and writing a gateway placeholder. This only
      // PERSISTS the truth of what the device signed; it does NOT verify it or gate
      // settlement. The oracle #52 verifier (stubbed, fail-closed) still owns whether
      // this evidence may settle. Old nodes / non-bundle evidence fall back to the
      // placeholder, unchanged.
      //
      // assuranceTier stays 0 ON PURPOSE (fails closed): an UNVERIFIED bundle
      // "actually supports" only the tier-0 permissionless floor (eligibility.ts).
      // The node's self-declared tier is a claim, not proof — trusting it here would
      // let resume-settlement's `?? latestBundle.assuranceTier` fallback escalate the
      // release tier from unverified evidence. The tier is lifted only once the gated
      // #52 verifier confirms the evidence on deployed infra (SEAM-2 ready-but-gated).
      const captured = extractNodeSignedBundle(evidence);
      const effectiveKernelId = kernelId ?? job.kernelId;
      const stepId = job.stepId ?? "operator-relay";

      // The signed path anchors on the CALLER's `bundleHash`, and
      // `extractNodeSignedBundle` accepts any non-empty string for it. A value
      // that is not a recognised hash form can never be served back: it is not
      // matched by `findByHash` and not routed by `isEvidenceHashForm`, so
      // `GET /api/evidence/:hash` cannot return the bundle at all. Storing such
      // a row commits evidence to a hash nothing can ever fetch — the same
      // defect the unsigned path's old `sha256-<uuid>` had.
      //
      // The remedy is REFUSAL, not substitution: replacing an unfetchable hash
      // with a gateway-computed one would make an unverified, caller-supplied
      // bundle MORE reachable than it is today, which is the wrong direction.
      // This is a storage-shape check only — it asserts nothing about whether
      // the signature is genuine (the gated #52 verifier owns that).
      if (captured && !isEvidenceHashForm(captured.bundleHash)) {
        return reply.code(400).send({
          error: "invalid_bundle_hash",
          message:
            "bundleHash must be sha256:<64 hex>, 0x<64 hex>, or bare 64 hex — "
            + "any other form cannot be served back by GET /api/evidence/:hash.",
          jobId,
        });
      }

      // LO-GW-4a — HONEST SIGNATURE. The signed path keeps the device's real
      // Ed25519 signature (unchanged). The unsigned path now stores NULL rather
      // than inventing `{signer: <kernelId>, algorithm: "sha256", value:
      // "operator-relay-auto"}` — a record that named a real kernel as the
      // SIGNER of bytes it never signed. `isDeviceSignedSignature` already
      // rejected that value, so settlement was never at risk; the defect was
      // that the stored evidence asserted a provenance that did not exist, and
      // ALCOA "Original" reads exactly this field. Absent evidence of a
      // signature is recorded as absence.
      // `storedSignature` goes into the row AND the hashed envelope; the
      // response reports plain `null` so no caller ever reads a signature the
      // gateway does not hold.
      const storedSignature = captured ? captured.kernelSignature : NO_DEVICE_SIGNATURE;

      // LO-GW-4b — the pushed events, on BOTH branches.
      const { events, duplicateIds } = extractRelayedEvents(evidence, {
        bundleId,
        kernelId: effectiveKernelId,
        now,
      });

      // A bundle that names two different events with the SAME id is
      // internally inconsistent: the gateway cannot store it faithfully, and
      // quietly renaming one would rewrite the node's own data. Refuse before
      // anything is written, and say which ids collided so the node can fix and
      // resend. (Cross-BUNDLE reuse of a stable id is legitimate and is handled
      // by the bundle-scoping in extractRelayedEvents — only a within-bundle
      // duplicate is a defect.)
      if (duplicateIds.length > 0) {
        return reply.code(400).send({
          error: "duplicate_event_id",
          message:
            "Two or more relayed events share an id within one bundle; "
            + "each event id must be unique inside its own bundle.",
          jobId,
          duplicateIds: [...new Set(duplicateIds)],
        });
      }

      // LO-GW-4b — CONTENT-ADDRESSED HASH on the unsigned path. `sha256-<uuid>`
      // was a synthetic non-content string: it commits to nothing, and it is not
      // in any of the three hash forms `GET /api/evidence/:hash` recognises
      // (isEvidenceHashForm), so a bundle stored under it was unreachable by the
      // oracle's fetch-and-verify. It is now `sha256:<sha256(canonical
      // envelope)>` — the SAME construction paid-job-flow.ts uses (:1060) and
      // the exact bytes the retrieval route rebuilds and serves back, so a
      // raw-byte re-hash verifies. The signed path keeps the DEVICE's own
      // bundleHash untouched (SEAM-2 anchors settlement on it).
      const bundleHash =
        captured?.bundleHash ??
        `sha256:${crypto
          .createHash("sha256")
          .update(
            buildCanonicalEvidenceEnvelope(
              {
                id: bundleId,
                jobId,
                stepId,
                kernelId: effectiveKernelId,
                assuranceTier: 0,
                createdAt: now,
                kernelSignature: storedSignature,
              },
              events,
            ),
          )
          .digest("hex")}`;

      try {
        // ATOMIC (round 2). The bundle row and its events are ONE fact, and
        // better-sqlite3 autocommits every statement — so as two separate
        // statements the bundle row was already DURABLE by the time
        // `insertEvents` could throw. That left exactly the state this route
        // claims to have eliminated: a committed bundle whose `bundleHash` is
        // content-addressed over an envelope CONTAINING events, with zero event
        // rows stored. `GET /api/evidence/:hash` then rebuilds `events: []`, so
        // the served bytes do not re-hash to the committed hash (the oracle
        // fails closed) and the authenticity-of-origin floor reads an empty
        // `bundle.events[]`. Worse, the response said `stored:false` while the
        // orphan row persisted — and settlement.facade.ts reports a job's LAST
        // bundle, so the orphan became the job's advertised evidence.
        //
        // One transaction makes the two writes commit or roll back together, so
        // `stored:false` now means nothing was written, whatever the cause.
        // `getStore().db` is the same connection the repositories hold
        // (`buildRepositories(db)`), so repo calls inside the callback run
        // inside the transaction — the pattern routes/artifacts.ts:171 already
        // uses for its slug/alias pair.
        getStore().db.transaction(() => {
          repos.evidence.insert({
            id: bundleId,
            jobId,
            stepId,
            kernelId: effectiveKernelId,
            assuranceTier: 0,
            bundleHash,
            kernelSignature: storedSignature,
            sessionKeyAuthorization: captured?.sessionKeyAuthorization ?? null,
            createdAt: now,
          });
          if (events.length > 0) {
            repos.evidence.insertEvents(
              events.map((ev) => ({
                id: ev.id,
                bundleId,
                type: ev.type,
                timestamp: ev.timestamp,
                source: ev.source as { deviceId: string; deviceType: string; kernelId: string },
                payload: ev.payload as Record<string, unknown>,
                hash: ev.hash,
              })),
            );
          }
        });
      } catch (insertErr) {
        // Nothing was committed — the transaction rolled back. Acknowledge
        // receipt (the node should not hard-fail) and report honestly that the
        // gateway holds no bundle for this push.
        app.log.error(`operator-relay: evidence insert failed: ${insertErr}`);
        return {
          stored: false,
          jobId,
          bundleId,
          error: "storage_failed",
          timestamp: now,
        };
      }

      return {
        stored: true,
        jobId,
        bundleId,
        // True when the node's real device-signed (#236) bundle was captured
        // (real Ed25519 signature persisted); false when there was none.
        // It says a well-formed device signature was PRESENT — never that it
        // was checked. A relay caller can supply an arbitrary ed25519-shaped
        // signature over an arbitrary hash and land `deviceSigned:true`; that
        // is a forgery the gated #52 verifier rejects against the REGISTERED
        // signer, not a signature this route has validated. `signatureVerified`
        // is emitted alongside so no caller can read presence as proof.
        deviceSigned: !!captured,
        signatureVerified: false,
        // Explicitly null on the unsigned path — the response never reports a
        // signature the gateway does not hold.
        kernelSignature: captured ? captured.kernelSignature : null,
        bundleHash,
        // The bundle is UNVERIFIED evidence: tier 0 is the permissionless floor
        // (eligibility.ts) and is not lifted by anything on this route.
        assuranceTier: 0,
        eventsStored: events.length,
        timestamp: now,
      };
    } catch (err) {
      return reply.code(500).send({
        error: "evidence_store_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  /**
   * POST /api/operator/heartbeat
   *
   * Operator node heartbeat: keeps the kernel marked "online" and
   * optionally re-announces capabilities.
   *
   * Body: { kernelId, status?, capabilities?, timestamp? }
   */
  app.post<{ Body: HeartbeatBody }>("/api/operator/heartbeat", async (req, reply) => {
    const { kernelId, status = "online", capabilities, timestamp } = req.body ?? {};

    if (!kernelId) {
      return reply.code(400).send({ error: "kernelId required" });
    }

    const result = await kernelFacade.heartbeat(kernelId, { status, capabilities, timestamp });
    return sendResult(reply, result);
  });

  /**
   * POST /api/operator/job-status
   *
   * Update job status from an operator node (alternative to PATCH /api/jobs/:id/status).
   * Used when the node doesn't know the exact route shape.
   *
   * Body: { jobId, kernelId?, status, metadata?, timestamp? }
   */
  app.post<{ Body: JobStatusBody }>("/api/operator/job-status", async (req, reply) => {
    const { jobId, status, metadata, timestamp } = req.body ?? {};

    if (!jobId) {
      return reply.code(400).send({ error: "jobId required" });
    }
    if (!status) {
      return reply.code(400).send({ error: "status required" });
    }

    // Same canonical vocabulary as PATCH /api/jobs/:id/status — tolerate the
    // documented `running` alias, normalise to `in_progress` before storing.
    const canonicalStatus = normalizeJobStatus(status);
    if (!canonicalStatus) {
      return reply.code(400).send({
        error: "invalid_status",
        valid: [...JOB_STATUSES],
      });
    }

    try {
      const repos = getRepos();
      const updated = repos.jobs.updateStatus(jobId, canonicalStatus);

      if (!updated) {
        // Job not found — return 200 so the node doesn't fail hard
        return {
          updated: false,
          jobId,
          status: canonicalStatus,
          warning: "job_not_found",
          timestamp: new Date().toISOString(),
        };
      }

      return {
        updated: true,
        jobId,
        status: canonicalStatus,
        metadata: metadata ?? null,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return reply.code(500).send({
        error: "status_update_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });
}
