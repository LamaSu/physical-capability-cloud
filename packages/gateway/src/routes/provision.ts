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
    };

    let operatorId: string;

    if (body.walletAddress) {
      // Wallet address path
      if (!/^0x[0-9a-fA-F]{40}$/.test(body.walletAddress)) {
        return reply.status(400).send({
          error: "invalid_wallet_address",
          message: "walletAddress must be a valid EVM address (0x + 40 hex chars)",
        });
      }
      operatorId = body.walletAddress;
    } else if (body.email) {
      // Email path
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
      const { rawKey, record } = provisionApiKey({
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
      });

      if (!record) return reply.status(500).send({ error: "provision_failed" });
      auditService.log({
        eventType: "auth.key_provisioned",
        actor: operatorId,
        resourceType: "api_key",
        resourceId: record.id,
        action: "create",
        metadata: { name: body.name, capability: body.capability },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      trackServerEvent("api_key_provisioned", { email: body.email, capability: body.capability });
      return reply.status(201).send({
        api_key: rawKey,
        key_id: record.id,
        operator_id: operatorId,
        scopes: JSON.parse(record.scopes),
        rate_limit: record.rateLimit,
        expires_at: record.expiresAt,
        created_at: record.createdAt,
        warning: "Save this API key now — it will not be shown again.",
        usage: {
          header: `Authorization: Bearer ${rawKey}`,
          example: `curl -H "Authorization: Bearer ${rawKey}" ${req.protocol}://${req.hostname}/api/capabilities/types`,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to provision key";
      if (message.includes("Maximum 5")) {
        return reply.status(429).send({ error: "too_many_keys", message });
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

    if (!key) {
      return reply.status(404).send({ error: "Key not found" });
    }

    if (key.operatorId !== operatorId) {
      return reply.status(403).send({ error: "Not your key" });
    }

    if (key.revokedAt) {
      return reply.status(409).send({ error: "Key already revoked" });
    }

    repo.revoke(keyId);
    return reply.send({ ok: true, key_id: keyId, revoked_at: new Date().toISOString() });
  });
}
