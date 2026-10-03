/**
 * Diagnostic log collection endpoints.
 *
 * Operators upload encrypted diagnostic bundles via pcc-node.
 * Admin retrieves and decrypts them using the retrieval code
 * the operator shares.
 *
 *   POST /api/operator/diagnostics       — upload encrypted diagnostic bundle
 *   GET  /api/operator/diagnostics       — list uploads (own; every upload with the admin secret)
 *   GET  /api/operator/diagnostics/:id   — get a specific upload by ID
 *   POST /api/operator/diagnostics/decrypt — decrypt a bundle with retrieval code
 *
 * Ownership (WP-A; astra, pack 47): an upload belongs to the identity that uploaded
 * it (apiGate's attached identity), recorded at upload. The kernelId in the body is a
 * label the caller asserts, never ownership: the list used to match the caller's
 * identity against it, and GET /:id and POST /decrypt checked nothing. Only the
 * uploader, or the admin secret, lists, fetches or decrypts an upload; anyone else
 * gets the same 404 as for an unknown id, before any decryption work.
 */

import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { adminOrCaller, callerIdentity, mayAccess } from "../auth/admin-secret-gate.js";

// In-memory store (backed by audit log for persistence across restarts).
// For a production system you'd use the DB, but this keeps it simple
// and avoids schema migrations.
interface DiagnosticUpload {
  id: string;
  /** The identity that uploaded it: its owner (see the header). */
  operatorId: string;
  kernelId: string;
  encrypted: {
    ciphertext_b64: string;
    iv_b64: string;
    salt_b64: string;
    tag_b64: string;
  };
  bundleHash: string;
  bundleSize: number;
  logLineCount: number;
  systemPlatform: string;
  collectedAt: string;
  uploadedAt: string;
  expiresAt: string;
  ip: string;
}

// Store up to 100 diagnostic uploads in memory (FIFO eviction)
const MAX_UPLOADS = 100;
const EXPIRY_HOURS = 72; // bundles expire after 72 hours
const uploads: DiagnosticUpload[] = [];

function pruneExpired(): void {
  const now = Date.now();
  let i = 0;
  while (i < uploads.length) {
    if (new Date(uploads[i].expiresAt).getTime() < now) {
      uploads.splice(i, 1);
    } else {
      i++;
    }
  }
}

export async function diagnosticLogRoutes(app: FastifyInstance) {
  /**
   * POST /api/operator/diagnostics
   *
   * Receive an encrypted diagnostic bundle from an operator node.
   * The bundle is encrypted client-side with the retrieval code as
   * the passphrase — the gateway never sees the plaintext.
   *
   * Body: {
   *   kernelId: string,
   *   encrypted: { ciphertext_b64, iv_b64, salt_b64, tag_b64 },
   *   bundleHash: string,
   *   bundleSize: number,
   *   logLineCount: number,
   *   systemPlatform: string,
   *   collectedAt: string,
   * }
   */
  app.post<{
    Body: {
      kernelId?: string;
      encrypted?: Record<string, string>;
      bundleHash?: string;
      bundleSize?: number;
      logLineCount?: number;
      systemPlatform?: string;
      collectedAt?: string;
    };
  }>("/api/operator/diagnostics", async (req, reply) => {
    // The upload belongs to the caller's identity; with none attached there is no owner (rule 7).
    const owner = callerIdentity(req);
    if (owner === null) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    const {
      kernelId,
      encrypted,
      bundleHash,
      bundleSize,
      logLineCount,
      systemPlatform,
      collectedAt,
    } = req.body ?? {};

    if (!encrypted?.ciphertext_b64) {
      return reply.code(400).send({ error: "encrypted payload required" });
    }

    // Validate encrypted payload has all required fields
    for (const field of ["ciphertext_b64", "iv_b64", "salt_b64", "tag_b64"]) {
      if (!encrypted[field]) {
        return reply.code(400).send({ error: `encrypted.${field} required` });
      }
    }

    // Size guard — reject bundles over 5MB encrypted
    const payloadSize = encrypted.ciphertext_b64.length;
    if (payloadSize > 5 * 1024 * 1024) {
      return reply.code(413).send({
        error: "diagnostic bundle too large",
        maxSize: "5MB",
      });
    }

    pruneExpired();

    // FIFO eviction if at capacity
    if (uploads.length >= MAX_UPLOADS) {
      uploads.shift();
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRY_HOURS * 60 * 60 * 1000);
    const uploadId = `diag-${uuidv4().slice(0, 8)}`;

    const upload: DiagnosticUpload = {
      id: uploadId,
      operatorId: owner,
      kernelId: kernelId ?? "unknown",
      encrypted: encrypted as DiagnosticUpload["encrypted"],
      bundleHash: bundleHash ?? "",
      bundleSize: bundleSize ?? 0,
      logLineCount: logLineCount ?? 0,
      systemPlatform: systemPlatform ?? "unknown",
      collectedAt: collectedAt ?? now.toISOString(),
      uploadedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ip: req.ip,
    };

    uploads.push(upload);

    app.log.info(
      `diagnostic-logs: received bundle ${uploadId} from kernel ${kernelId ?? "?"} ` +
      `(${bundleSize ?? 0} bytes, ${logLineCount ?? 0} lines)`
    );

    return {
      uploadId,
      expiresAt: expiresAt.toISOString(),
      message: "Diagnostic bundle received. Share the retrieval code with support.",
    };
  });

  /**
   * GET /api/operator/diagnostics
   *
   * List recent diagnostic uploads (metadata only, no encrypted payloads).
   * Intended for admin/support use.
   */
  app.get("/api/operator/diagnostics", async (req, reply) => {
    pruneExpired();

    // The admin view (every upload, with IPs) needs the admin SECRET. It used to be
    // granted to any caller whose operatorId was on BROKER_OPERATORS, an identity a
    // legacy key can carry (N2, WP-A round 6). A wrong secret is refused, never
    // downgraded. Without it the caller sees only the uploads IT made, and a request
    // with no attached identity is 401: the old filter let it see every upload (rule 7).
    const who = adminOrCaller(req, reply);
    if (!who) return reply;
    const isAdmin = who.admin;

    // Scoped by the recorded uploader, never by the caller-asserted kernelId (astra,
    // pack 47: the old filter equated the caller's identity with a stored kernel ID).
    const filtered = uploads.filter((u) => mayAccess(who, u.operatorId));

    return {
      uploads: filtered.map((u) => ({
        id: u.id,
        kernelId: u.kernelId,
        bundleHash: u.bundleHash,
        bundleSize: u.bundleSize,
        logLineCount: u.logLineCount,
        systemPlatform: u.systemPlatform,
        collectedAt: u.collectedAt,
        uploadedAt: u.uploadedAt,
        expiresAt: u.expiresAt,
        // Strip IP for non-admin callers
        ...(isAdmin ? { ip: u.ip } : {}),
      })),
      total: filtered.length,
      scoped: !isAdmin,
    };
  });

  /**
   * GET /api/operator/diagnostics/:id
   *
   * Get a specific diagnostic upload by ID.
   * Returns the full encrypted payload for decryption.
   */
  app.get<{
    Params: { id: string };
  }>("/api/operator/diagnostics/:id", async (req, reply) => {
    const who = adminOrCaller(req, reply);
    if (!who) return reply;
    pruneExpired();

    const upload = uploads.find((u) => u.id === req.params.id);
    // Another identity's upload answers exactly like an unknown id.
    if (!upload || !mayAccess(who, upload.operatorId)) {
      return reply.code(404).send({ error: "diagnostic upload not found or expired" });
    }

    return {
      id: upload.id,
      kernelId: upload.kernelId,
      encrypted: upload.encrypted,
      bundleHash: upload.bundleHash,
      bundleSize: upload.bundleSize,
      logLineCount: upload.logLineCount,
      systemPlatform: upload.systemPlatform,
      collectedAt: upload.collectedAt,
      uploadedAt: upload.uploadedAt,
      expiresAt: upload.expiresAt,
    };
  });

  /**
   * POST /api/operator/diagnostics/decrypt
   *
   * Server-side decryption of a diagnostic bundle.
   * Uses the retrieval code the operator shared.
   *
   * Body: { uploadId: string, retrievalCode: string }
   *
   * This endpoint performs decryption on the server so you don't need
   * Python/crypto locally. The retrieval code is NOT stored.
   */
  app.post<{
    Body: { uploadId?: string; retrievalCode?: string };
  }>("/api/operator/diagnostics/decrypt", async (req, reply) => {
    const who = adminOrCaller(req, reply);
    if (!who) return reply;
    const { uploadId, retrievalCode } = req.body ?? {};

    if (!uploadId || !retrievalCode) {
      return reply.code(400).send({ error: "uploadId and retrievalCode required" });
    }

    pruneExpired();

    // Checked BEFORE any key derivation: a retrieval code opens only the caller's own
    // uploads (support decrypts with the admin secret).
    const upload = uploads.find((u) => u.id === uploadId);
    if (!upload || !mayAccess(who, upload.operatorId)) {
      return reply.code(404).send({ error: "diagnostic upload not found or expired" });
    }

    try {
      const crypto = await import("node:crypto");

      const salt = Buffer.from(upload.encrypted.salt_b64, "base64");
      const iv = Buffer.from(upload.encrypted.iv_b64, "base64");
      const ciphertext = Buffer.from(upload.encrypted.ciphertext_b64, "base64");
      const tag = Buffer.from(upload.encrypted.tag_b64, "base64");

      // Derive key with PBKDF2 (must match Python side: sha256, 100k iterations)
      const key = crypto.pbkdf2Sync(retrievalCode, salt, 100_000, 32, "sha256");

      // Try AES-256-GCM first (matches Python `cryptography` path)
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        const bundle = JSON.parse(decrypted.toString("utf-8"));
        return { decrypted: true, bundle };
      } catch {
        // Try HMAC-XOR fallback (matches Python stdlib path)
        const expectedTag = crypto
          .createHmac("sha256", key)
          .update(ciphertext)
          .digest()
          .subarray(0, 16);

        if (!crypto.timingSafeEqual(tag, expectedTag)) {
          return reply.code(403).send({
            error: "invalid_retrieval_code",
            message: "The retrieval code is incorrect or the bundle is corrupted.",
          });
        }

        // XOR stream decryption
        let stream = Buffer.alloc(0);
        let counter = 0;
        while (stream.length < ciphertext.length) {
          const counterBuf = Buffer.alloc(4);
          counterBuf.writeUInt32BE(counter);
          const block = crypto
            .createHmac("sha256", key)
            .update(Buffer.concat([iv, counterBuf]))
            .digest();
          stream = Buffer.concat([stream, block]);
          counter++;
        }

        const plaintext = Buffer.alloc(ciphertext.length);
        for (let i = 0; i < ciphertext.length; i++) {
          plaintext[i] = ciphertext[i] ^ stream[i];
        }

        const bundle = JSON.parse(plaintext.toString("utf-8"));
        return { decrypted: true, bundle };
      }
    } catch (err) {
      return reply.code(403).send({
        error: "decryption_failed",
        message:
          err instanceof Error ? err.message : "Invalid retrieval code or corrupted bundle.",
      });
    }
  });
}
