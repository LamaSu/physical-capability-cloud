/**
 * /api/storage — generic CID blob storage routes.
 *
 *   POST   /api/storage           upload bytes, returns CID + metadata
 *   GET    /api/storage/:cid      retrieve blob (auth-gated unless public+offer-linked)
 *   GET    /api/storage/:cid/meta metadata only (no bytes)
 *   DELETE /api/storage/:cid      owner-only soft-delete
 *
 * Substrate primitive for binary artifacts that 6 PCC categories cannot
 * ship without:
 *   - C.4  manufacturing (STL, gcode, photo evidence)
 *   - C.5  lab (raw .d files, instrument outputs)
 *   - C.10 brokerage (booking confirmations)
 *   - C.14 sensory (drone imagery, sensor data)
 *   - C.15 creative (portfolio samples, WIP, final deliverables)
 *   - cross-cutting photo evidence for ANY category
 *
 * The gateway does NOT interpret the bytes. It stores, addresses, and
 * retrieves them. Downstream consumers (e.g. @pcc/evidence-judge VLM)
 * fetch by CID and do interpretation.
 *
 * Upload protocol: raw binary in the request body. Content-Type is the
 * declared media type (auto-detected from magic bytes if absent).
 * Optional label / category / related_offer_id passed via query string.
 *
 * Author: implementer-foxtrot-cid-storage
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { sql } from "@pcc/store";
import { getStore } from "../db.js";
import { requireAuth } from "../auth/require-auth.js";
import {
  getCidBlobStorage,
  isValidCid,
  detectMediaType,
} from "../services/cid-blob-storage.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_UPLOAD_MB = 100;
const MAX_UPLOAD_BYTES =
  Number(process.env["STORAGE_MAX_UPLOAD_MB"] ?? DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;

const BINARY_CT_PATTERN = /^(application\/(octet-stream|pdf|zip|json)|image\/.*|video\/.*|audio\/.*|model\/.*|text\/.*)/i;

// ---------------------------------------------------------------------------
// DB helpers (raw SQL — same pattern as device-relay.ts)
// ---------------------------------------------------------------------------

interface StorageBlobRow {
  cid: string;
  size_bytes: number;
  media_type: string;
  backend: string;
  uploaded_by: string;
  uploaded_by_agent_id: string | null;
  related_offer_id: string | null;
  label: string | null;
  category: string | null;
  public_read: number | null;
  created_at: string;
  deleted_at: string | null;
}

function findBlob(cid: string): StorageBlobRow | undefined {
  const db = getStore().db;
  const rows = db.all<StorageBlobRow[]>(
    sql`SELECT * FROM storage_blobs WHERE cid = ${cid} LIMIT 1`,
  );
  return rows[0];
}

function insertBlobRow(row: Omit<StorageBlobRow, "deleted_at">): void {
  const db = getStore().db;
  db.run(sql`
    INSERT INTO storage_blobs (
      cid, size_bytes, media_type, backend, uploaded_by,
      uploaded_by_agent_id, related_offer_id, label, category, public_read, created_at
    ) VALUES (
      ${row.cid},
      ${row.size_bytes},
      ${row.media_type},
      ${row.backend},
      ${row.uploaded_by},
      ${row.uploaded_by_agent_id},
      ${row.related_offer_id},
      ${row.label},
      ${row.category},
      ${row.public_read ?? 0},
      ${row.created_at}
    )
  `);
}

function softDeleteBlob(cid: string, when: string): void {
  const db = getStore().db;
  db.run(sql`UPDATE storage_blobs SET deleted_at = ${when} WHERE cid = ${cid}`);
}

// ---------------------------------------------------------------------------
// Auth helper — figure out caller identity from req (Bearer + SIWE)
// ---------------------------------------------------------------------------

function callerIdentity(req: FastifyRequest): {
  operatorId: string;
  agentId: string | null;
} {
  // apiGate sets operatorId from API key; requireAuth sets userId from SIWE.
  const operatorId =
    (req as any).operatorId ??
    (req.userId ? String(req.userId) : "") ??
    "anonymous";
  const agentId = (req as any).apiKeyId ?? null;
  return { operatorId: operatorId || "anonymous", agentId };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function storageRoutes(app: FastifyInstance): Promise<void> {
  // Register a content-type parser for binary uploads. We buffer the raw
  // request body into a Uint8Array for the put handler. For files near the
  // upper limit we accept the memory cost — chunked streaming via Helia's
  // unixfs.addFile() is a follow-up.
  app.addContentTypeParser(
    BINARY_CT_PATTERN,
    { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // POST /api/storage — upload
  app.post<{
    Querystring: {
      label?: string;
      category?: string;
      related_offer_id?: string;
      public?: string;
    };
    Body: Buffer | unknown;
  }>(
    "/api/storage",
    {
      preHandler: [requireAuth],
      bodyLimit: MAX_UPLOAD_BYTES,
    },
    async (req, reply) => {
      const body = req.body;

      if (!body || !(body instanceof Buffer)) {
        return reply.code(400).send({
          error: "invalid_body",
          message:
            "Request body must be binary. Set Content-Type to a known binary media type (e.g. application/octet-stream) and PUT raw bytes.",
        });
      }

      if (body.length === 0) {
        return reply.code(400).send({ error: "empty_body", message: "Empty upload not allowed." });
      }

      if (body.length > MAX_UPLOAD_BYTES) {
        return reply.code(413).send({
          error: "payload_too_large",
          message: `Upload exceeds STORAGE_MAX_UPLOAD_MB (${MAX_UPLOAD_BYTES} bytes).`,
        });
      }

      const bytes = new Uint8Array(body);
      const declared = (req.headers["content-type"] ?? "").toString().split(";")[0]?.trim();
      const mediaType =
        declared && declared !== "application/octet-stream"
          ? declared
          : detectMediaType(bytes);

      const storage = await getCidBlobStorage();
      let meta;
      try {
        meta = await storage.put(bytes, { mediaType });
      } catch (err) {
        req.log.error({ err }, "[storage] backend put failed");
        return reply.code(500).send({ error: "storage_backend_error" });
      }

      const { operatorId, agentId } = callerIdentity(req);
      const existing = findBlob(meta.cid);
      const isPublicFlag = req.query.public === "true" ? 1 : 0;

      if (existing && !existing.deleted_at) {
        // Idempotent re-upload — return existing row's metadata, do not re-insert.
        return reply.code(200).send({
          cid: existing.cid,
          size_bytes: existing.size_bytes,
          media_type: existing.media_type,
          backend: existing.backend,
          stored_at_iso: existing.created_at,
          label: existing.label,
          category: existing.category,
          related_offer_id: existing.related_offer_id,
          public_read: !!existing.public_read,
          idempotent: true,
        });
      }

      const nowIso = new Date().toISOString();

      // Either an undeleted row exists (handled above) or no row exists.
      // For a soft-deleted row, we revive it by inserting a fresh one — but
      // PRIMARY KEY conflict on cid would block that, so first clear the
      // tombstone if present.
      if (existing && existing.deleted_at) {
        const db = getStore().db;
        db.run(sql`DELETE FROM storage_blobs WHERE cid = ${meta.cid}`);
      }

      insertBlobRow({
        cid: meta.cid,
        size_bytes: meta.sizeBytes,
        media_type: mediaType,
        backend: meta.backend,
        uploaded_by: operatorId,
        uploaded_by_agent_id: agentId,
        related_offer_id: req.query.related_offer_id ?? null,
        label: req.query.label ?? null,
        category: req.query.category ?? null,
        public_read: isPublicFlag,
        created_at: nowIso,
      });

      return reply.code(201).send({
        cid: meta.cid,
        size_bytes: meta.sizeBytes,
        media_type: mediaType,
        backend: meta.backend,
        stored_at_iso: nowIso,
        label: req.query.label ?? null,
        category: req.query.category ?? null,
        related_offer_id: req.query.related_offer_id ?? null,
        public_read: !!isPublicFlag,
        idempotent: false,
      });
    },
  );

  // Shared helper to decide whether a GET can proceed without auth.
  function canPublicRead(
    row: StorageBlobRow,
    req: FastifyRequest,
  ): boolean {
    if (!row.public_read) return false;
    if (!row.related_offer_id) return false;
    // For now the public-read flag plus an offer linkage is sufficient.
    // A follow-up will verify the offer is actually publicly visible — for
    // v0.1 the operator marks at upload time and that is the gate.
    if (req.query && (req.query as any).public === "true") return true;
    return false;
  }

  // GET /api/storage/:cid — retrieve bytes
  app.get<{
    Params: { cid: string };
    Querystring: { range?: string; public?: string };
  }>(
    "/api/storage/:cid",
    async (req, reply) => {
      const cid = req.params.cid;
      if (!isValidCid(cid)) {
        return reply.code(400).send({ error: "invalid_cid" });
      }

      const row = findBlob(cid);
      if (!row) {
        return reply.code(404).send({ error: "not_found" });
      }

      if (row.deleted_at) {
        return reply.code(410).send({ error: "gone", message: "Blob was soft-deleted." });
      }

      // Auth gating
      const publicAllowed = canPublicRead(row, req);
      if (!publicAllowed) {
        // Run requireAuth manually since route doesn't preHandler — we need
        // to permit unauthenticated public reads above.
        await requireAuth(req, reply);
        if (reply.sent) return;
      }

      const storage = await getCidBlobStorage();
      let bytes: Uint8Array;

      // Range support — single contiguous range only.
      const rangeStr = req.query.range ?? (req.headers["range"] as string | undefined);
      if (rangeStr) {
        const match = /bytes[= ](\d+)-(\d+)/i.exec(rangeStr.toString().trim());
        if (match) {
          const start = parseInt(match[1]!, 10);
          const end = Math.min(parseInt(match[2]!, 10), row.size_bytes - 1);
          if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start) {
            return reply.code(416).send({ error: "range_not_satisfiable" });
          }
          try {
            bytes = await storage.getRange(cid, start, end);
          } catch (err) {
            req.log.error({ err }, "[storage] backend getRange failed");
            return reply.code(500).send({ error: "storage_backend_error" });
          }
          reply
            .code(206)
            .header("Content-Type", row.media_type)
            .header("Content-Length", String(bytes.length))
            .header("Content-Range", `bytes ${start}-${end}/${row.size_bytes}`)
            .header("Accept-Ranges", "bytes");
          return reply.send(Buffer.from(bytes));
        }
      }

      try {
        bytes = await storage.get(cid);
      } catch (err) {
        req.log.error({ err }, "[storage] backend get failed");
        return reply.code(404).send({ error: "not_found_in_backend" });
      }

      reply
        .header("Content-Type", row.media_type)
        .header("Content-Length", String(bytes.length))
        .header("Accept-Ranges", "bytes");
      return reply.send(Buffer.from(bytes));
    },
  );

  // GET /api/storage/:cid/meta — metadata only
  app.get<{ Params: { cid: string }; Querystring: { public?: string } }>(
    "/api/storage/:cid/meta",
    async (req, reply) => {
      const cid = req.params.cid;
      if (!isValidCid(cid)) {
        return reply.code(400).send({ error: "invalid_cid" });
      }
      const row = findBlob(cid);
      if (!row) return reply.code(404).send({ error: "not_found" });
      if (row.deleted_at) return reply.code(410).send({ error: "gone" });

      const publicAllowed = canPublicRead(row, req);
      if (!publicAllowed) {
        await requireAuth(req, reply);
        if (reply.sent) return;
      }

      return {
        cid: row.cid,
        size_bytes: row.size_bytes,
        media_type: row.media_type,
        backend: row.backend,
        stored_at_iso: row.created_at,
        label: row.label,
        category: row.category,
        related_offer_id: row.related_offer_id,
        public_read: !!row.public_read,
      };
    },
  );

  // DELETE /api/storage/:cid — soft-delete (owner only)
  app.delete<{ Params: { cid: string } }>(
    "/api/storage/:cid",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const cid = req.params.cid;
      if (!isValidCid(cid)) {
        return reply.code(400).send({ error: "invalid_cid" });
      }

      const row = findBlob(cid);
      if (!row) return reply.code(404).send({ error: "not_found" });
      if (row.deleted_at) return reply.code(410).send({ error: "already_deleted" });

      const { operatorId } = callerIdentity(req);
      if (row.uploaded_by !== operatorId) {
        return reply.code(403).send({ error: "forbidden", message: "Only the uploader may delete this blob." });
      }

      const nowIso = new Date().toISOString();
      softDeleteBlob(cid, nowIso);
      return { status: "soft_deleted", cid, deleted_at: nowIso };
    },
  );
}
