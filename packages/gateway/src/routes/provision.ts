/**
 * API Key provisioning routes.
 *
 * POST /api/auth/provision  — create a new API key (public — this is how operators register)
 * GET  /api/auth/keys       — list your active keys (requires auth)
 * DELETE /api/auth/keys/:id — revoke a key (requires auth)
 */

import type { FastifyInstance } from "fastify";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getRepos } from "../db.js";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";
import { canProvision } from "../middleware/security-hardening.js";

export async function provisionRoutes(app: FastifyInstance) {
  // ── POST /api/auth/provision ──────────────────────────────────────
  // Public endpoint — this is how new operators get their API key.
  // They provide email + capability description, we issue a key.
  app.post("/api/auth/provision", async (req, reply) => {
    // Rate limit: max 5 provisions per IP per hour (CRIT-02 fix)
    if (!canProvision(req.ip)) {
      return reply.status(429).send({
        error: "rate_limited",
        message: "Too many API key requests. Try again in an hour.",
        retry_after_seconds: 3600,
      });
    }

    const body = (req.body ?? {}) as {
      email?: string;
      walletAddress?: string;
      name?: string;
      capability?: string;
      /**
       * Optional Ed25519 public key (BYOK). 64 hex chars, optional 0x prefix.
       * Omitted → gateway mints a fresh keypair and returns the private
       * key in this response ONCE.
       */
      publicKey?: string;
    };

    let operatorId: string;

    // Type guards — prevent object/array/number injection (red team #14, #15)
    if (body.walletAddress !== undefined && typeof body.walletAddress !== "string") {
      return reply.status(400).send({ error: "invalid_type", message: "walletAddress must be a string" });
    }
    if (body.email !== undefined && typeof body.email !== "string") {
      return reply.status(400).send({ error: "invalid_type", message: "email must be a string" });
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      return reply.status(400).send({ error: "invalid_type", message: "name must be a string" });
    }
    if (body.capability !== undefined && typeof body.capability !== "string") {
      return reply.status(400).send({ error: "invalid_type", message: "capability must be a string" });
    }
    if (body.publicKey !== undefined && typeof body.publicKey !== "string") {
      return reply.status(400).send({ error: "invalid_type", message: "publicKey must be a string" });
    }

    if (body.walletAddress) {
      // Wallet address path — format check also implicitly caps length at 42
      if (!/^0x[0-9a-fA-F]{40}$/.test(body.walletAddress)) {
        return reply.status(400).send({
          error: "invalid_wallet_address",
          message: "walletAddress must be a valid EVM address (0x + 40 hex chars)",
        });
      }
      operatorId = body.walletAddress;
    } else if (body.email) {
      // Email path — RFC 5321 max total length is 254
      if (body.email.length > 254) {
        return reply.status(400).send({
          error: "invalid_email",
          message: "Email exceeds 254 character limit",
        });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
        return reply.status(400).send({
          error: "invalid_email",
          message: "Please provide a valid email address",
        });
      }
      operatorId = body.email;
    } else {
      return reply.status(400).send({
        error: "identifier_required",
        message: "Either email or walletAddress is required to provision an API key",
      });
    }

    try {
      const { rawKey, record, ed25519 } = provisionApiKey({
        operatorId,
        name: body.name,
        description: body.capability
          ? `Operator capability: ${body.capability}`
          : undefined,
        scopes: ["*"],
        metadata: {
          capability: body.capability,
          provisionedAt: new Date().toISOString(),
          source: "landing-page",
        },
        publicKey: body.publicKey,
      });

      if (!record) return reply.status(500).send({ error: "provision_failed" });
      auditService.log({
        eventType: "auth.key_provisioned",
        actor: operatorId,
        resourceType: "api_key",
        resourceId: record.id,
        action: "create",
        metadata: {
          name: body.name,
          capability: body.capability,
          ed25519_keypair_source: ed25519 ? "server-minted" : "byok",
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      trackServerEvent("api_key_provisioned", {
        email: body.email,
        capability: body.capability,
        ed25519_keypair_source: ed25519 ? "server-minted" : "byok",
      });
      // Surface the trace_id (stamped by `middleware/trace-id.ts`) so the
      // agent can echo it on every subsequent call via `x-pcc-trace-id`.
      // The trace-id middleware also sets it on the response header — the
      // body field is here for clients that read JSON bodies more easily
      // than headers.
      // See docs/AGENT_ONBOARDING_OBSERVABILITY.md.
      const trace_id = (req as unknown as { traceId?: string }).traceId;
      // Ed25519 surfacing: ALWAYS return the public key; return the private
      // key ONLY when the gateway minted it. BYOK keys never round-trip.
      const ed25519Response = ed25519
        ? {
            public_key: ed25519.publicKeyHex,
            private_key: ed25519.privateKeyHex,
            private_key_pkcs8_base64: ed25519.privateKeyPkcs8B64,
            source: "server-minted",
            warning:
              "Store the private_key now — it will not be shown again. Anyone holding it can sign as this agent.",
          }
        : {
            public_key: record.publicKey ?? null,
            source: "byok",
          };
      return reply.status(201).send({
        api_key: rawKey,
        key_id: record.id,
        operator_id: operatorId,
        scopes: JSON.parse(record.scopes),
        rate_limit: record.rateLimit,
        expires_at: record.expiresAt,
        created_at: record.createdAt,
        warning: "Save this API key now — it will not be shown again.",
        trace_id,
        ed25519: ed25519Response,
        usage: {
          header: `Authorization: Bearer ${rawKey}`,
          trace_header: `x-pcc-trace-id: ${trace_id ?? "<trace_id>"}`,
          example: `curl -H "Authorization: Bearer ${rawKey}" -H "x-pcc-trace-id: ${trace_id ?? "<trace_id>"}" ${req.protocol}://${req.hostname}/api/capabilities/types`,
          trace_hint:
            "Echo `x-pcc-trace-id` on every subsequent request so PCC can correlate your onboarding journey. Quote it when filing `pcc_report` feedback.",
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to provision key";
      if (message.includes("Maximum 5")) {
        return reply.status(429).send({ error: "too_many_keys", message });
      }
      if (
        err instanceof Error &&
        (err as Error & { code?: string }).code === "invalid_public_key"
      ) {
        return reply.status(400).send({ error: "invalid_public_key", message });
      }
      return reply.status(500).send({ error: "provision_failed", message });
    }
  });

  // ── GET /api/auth/validate ────────────────────────────────────────
  // Validate an API key — returns 200 if valid, 401 if not.
  // Used by the dashboard login screen.
  app.get("/api/auth/validate", async (req, reply) => {
    const { resolveApiKey } = await import("../auth/api-key-auth.js");
    const keyRecord = resolveApiKey(req);
    if (!keyRecord) {
      return reply.status(401).send({ error: "invalid_key" });
    }
    return { valid: true, operatorId: keyRecord.operatorId };
  });

  // ── POST /api/agents/:id/verify ────────────────────────────────────
  //
  // Verify that a signature was produced by the agent identified by `:id`.
  // The agent's public key was set at provision time (server-minted OR
  // BYOK). Body: { message: string, signature: string }. Returns
  // { valid: bool, keyId, operatorId } on success. Returns 404 when the
  // key doesn't exist or has no public_key on file (e.g. legacy rows).
  //
  // PUBLIC: signature verification by definition needs no auth — anyone
  // can verify a signed evidence bundle against the issuing agent's key.
  //
  // Wire format: the message is interpreted as UTF-8 by default. Callers
  // can opt into base64 by passing { message_base64: "..." } instead.
  app.post<{
    Params: { id: string };
    Body: {
      message?: string;
      message_base64?: string;
      signature?: string;
    };
  }>("/api/agents/:id/verify", async (req, reply) => {
    const { id } = req.params;
    const body = req.body ?? {};

    if (typeof body.signature !== "string" || body.signature.length === 0) {
      return reply.status(400).send({
        error: "invalid_body",
        message: "signature (hex string) is required",
      });
    }
    if (
      (body.message === undefined || typeof body.message !== "string") &&
      (body.message_base64 === undefined || typeof body.message_base64 !== "string")
    ) {
      return reply.status(400).send({
        error: "invalid_body",
        message: "Provide either message (utf-8) or message_base64",
      });
    }

    let messageBuffer: Buffer;
    if (typeof body.message === "string") {
      messageBuffer = Buffer.from(body.message, "utf-8");
    } else {
      try {
        messageBuffer = Buffer.from(body.message_base64 as string, "base64");
      } catch {
        return reply.status(400).send({
          error: "invalid_body",
          message: "message_base64 must be valid base64",
        });
      }
    }

    const repo = getRepos().apiKeys;
    const key = repo.findById(id);
    // Unify "not found" + "no public key" + "revoked" so the verify
    // endpoint never leaks key existence.
    if (!key || !key.publicKey || key.revokedAt) {
      return reply.status(404).send({
        error: "key_not_found",
        message:
          "No verifiable public key on file for this agent. Re-provision with publicKey or as server-minted.",
      });
    }

    const { verifyEd25519Signature } = await import("../auth/ed25519.js");
    const valid = verifyEd25519Signature(key.publicKey, messageBuffer, body.signature);

    return reply.status(200).send({
      valid,
      key_id: key.id,
      operator_id: key.operatorId,
    });
  });

  // ── GET /api/auth/keys ────────────────────────────────────────────
  // List active keys for the authenticated operator.
  // Requires existing API key or SIWE session.
  app.get("/api/auth/keys", async (req, reply) => {
    // Try resolveApiKey directly since this route is before the gate
    const { resolveApiKey } = await import("../auth/api-key-auth.js");
    const keyRecord = resolveApiKey(req);
    const operatorId = keyRecord?.operatorId ?? (req as any).operatorId ?? (req as any).userId;
    if (!operatorId) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const repo = getRepos().apiKeys;
    const keys = repo.findByOperator(operatorId);

    return reply.send({
      keys: keys.map((k) => ({
        id: k.id,
        prefix: k.keyPrefix,
        name: k.name,
        description: k.description,
        scopes: JSON.parse(k.scopes ?? "[]"),
        rate_limit: k.rateLimit,
        usage_count: parseInt(k.usageCount ?? "0", 10),
        last_used_at: k.lastUsedAt,
        created_at: k.createdAt,
        expires_at: k.expiresAt,
        revoked_at: k.revokedAt,
        active: !k.revokedAt,
      })),
    });
  });

  // ── DELETE /api/auth/keys/:keyId ──────────────────────────────────
  // Revoke an API key. Requires auth + must own the key.
  app.delete("/api/auth/keys/:keyId", async (req, reply) => {
    const operatorId = (req as any).operatorId ?? (req as any).userId;
    if (!operatorId) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const { keyId } = req.params as { keyId: string };
    const repo = getRepos().apiKeys;
    const key = repo.findById(keyId);

    // Unify 404 and 403 into a single "not found" to prevent key ID enumeration
    // (red team #11/#54: different status codes leak resource existence).
    if (!key || key.operatorId !== operatorId) {
      return reply.status(404).send({ error: "Key not found" });
    }

    if (key.revokedAt) {
      return reply.status(409).send({ error: "Key already revoked" });
    }

    repo.revoke(keyId);
    return reply.send({ ok: true, key_id: keyId, revoked_at: new Date().toISOString() });
  });
}
