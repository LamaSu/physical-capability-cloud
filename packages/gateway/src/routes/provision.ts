/**
 * API Key provisioning routes.
 *
 * POST /api/auth/provision  — create a new API key (public — this is how operators register)
 * GET  /api/auth/keys       — list your active keys (requires auth)
 * DELETE /api/auth/keys/:id — revoke a key (requires auth)
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq, or, schema, sql } from "@pcc/store";
import { classifyProvisionError, provisionApiKey, resolveApiKey } from "../auth/api-key-auth.js";
import { authorityOf } from "../auth/kernel-authority.js";
import { resolveSession } from "../auth/siwe-auth.js";
import { SELF_SERVICE_KEY_SCOPES } from "../middleware/scope-checker.js";
import { getRepos, getStore } from "../db.js";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";
import { canProvision } from "../middleware/security-hardening.js";
import { classifyChainError } from "../services/chain-error-code.js";
import {
  registerAgentOnChain,
  isIdentityWriteEnabled,
  getIdentityRegistryAddress,
} from "../services/erc8004-identity-write.js";

/**
 * Only a proven owner or the admin may list or revoke another key of an address.
 * Owner proof comes from exactly: authorityOf(req).provenWallet; a verified SIWE
 * cookie or bearer session resolved by resolveSession; or an unexpired, unrevoked
 * API key whose metadata.source is "siwe-session", using its stored operatorId.
 */
export function provenOwnerAddress(req: FastifyRequest): string | null {
  const provenWallet = authorityOf(req).provenWallet;
  if (provenWallet) return provenWallet.toLowerCase();

  const session = resolveSession(req);
  if (session) return session.address.toLowerCase();

  const key = req.apiKeyId ? getRepos().apiKeys.findById(req.apiKeyId) : undefined;
  if (!key || key.revokedAt || (key.expiresAt !== null && !(Date.parse(key.expiresAt) > Date.now()))) {
    return null;
  }
  try {
    return JSON.parse(key.metadata ?? "null")?.source === "siwe-session"
      ? key.operatorId.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

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
       * Omitted means no signing key on file. The gateway never returns
       * a private key.
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
      const { rawKey, record } = provisionApiKey({
        operatorId,
        name: body.name,
        description: body.capability
          ? `Operator capability: ${body.capability}`
          : undefined,
        scopes: [...SELF_SERVICE_KEY_SCOPES],
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
          ed25519_keypair_source: record.publicKey ? "byok" : "none",
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      trackServerEvent("api_key_provisioned", {
        email: body.email,
        capability: body.capability,
        ed25519_keypair_source: record.publicKey ? "byok" : "none",
      });
      // Surface the trace_id (stamped by `middleware/trace-id.ts`) so the
      // agent can echo it on every subsequent call via `x-pcc-trace-id`.
      // The trace-id middleware also sets it on the response header — the
      // body field is here for clients that read JSON bodies more easily
      // than headers.
      // See docs/AGENT_ONBOARDING_OBSERVABILITY.md.
      const trace_id = (req as unknown as { traceId?: string }).traceId;
      // Provisioning returns only the caller-supplied public key, or null.
      const ed25519Response = {
        public_key: record.publicKey ?? null,
        source: record.publicKey ? "byok" : "none",
      };

      // ── ERC-8004 on-chain identity write (best-effort) ────────────
      // The off-chain DB row is the source of truth at this moment; the
      // on-chain identity is eventually-consistent. If this write fails
      // (network, gas, RPC), the row stays onchain_status='pending' and
      // the retry sweeper will pick it up. Never fail the HTTP request.
      let onchainAttempted = false;
      let onchainResult:
        | { agentId: string; txHash: string; registryAddress: string; chainId: number }
        | undefined;
      if (isIdentityWriteEnabled()) {
        onchainAttempted = true;
        const gatewayUrl =
          process.env.PCC_GATEWAY_URL ?? `${req.protocol}://${req.hostname}`;
        const agentDid =
          operatorId.startsWith("0x") && /^0x[0-9a-fA-F]{40}$/.test(operatorId)
            ? `did:pcc:${operatorId.toLowerCase()}`
            : `did:pcc:${record.id}`;
        try {
          const onchain = await registerAgentOnChain({
            agentDid,
            agentUrl: gatewayUrl,
          });
          getRepos().apiKeys.recordOnchainSuccess(record.id, {
            agentId: onchain.agentId,
            txHash: onchain.txHash,
            registryAddress: onchain.registryAddress,
            chainId: onchain.chainId,
          });
          onchainResult = {
            agentId: String(onchain.agentId),
            txHash: onchain.txHash,
            registryAddress: onchain.registryAddress,
            chainId: onchain.chainId,
          };
          auditService.log({
            eventType: "auth.onchain_identity_written",
            actor: operatorId,
            resourceType: "api_key",
            resourceId: record.id,
            action: "create",
            metadata: onchainResult,
            ip: req.ip,
            userAgent: req.headers["user-agent"],
          });
        } catch (onchainErr) {
          const code = classifyChainError(onchainErr);
          try {
            getRepos().apiKeys.recordOnchainFailure(record.id, code);
          } catch {
            // Non-fatal: DB write failure doesn't block HTTP response
          }
          req.log?.warn(
            { keyId: record.id, code },
            "ERC-8004 on-chain identity write failed — will retry",
          );
          auditService.log({
            eventType: "auth.onchain_identity_failed",
            actor: operatorId,
            resourceType: "api_key",
            resourceId: record.id,
            action: "create",
            metadata: { code },
            ip: req.ip,
            userAgent: req.headers["user-agent"],
          });
        }
      }

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
        // Provisioning never generates or assigns an operator wallet.
        operator_wallet: { source: "none" },
        usage: {
          header: `Authorization: Bearer ${rawKey}`,
          trace_header: `x-pcc-trace-id: ${trace_id ?? "<trace_id>"}`,
          example: `curl -H "Authorization: Bearer ${rawKey}" -H "x-pcc-trace-id: ${trace_id ?? "<trace_id>"}" ${req.protocol}://${req.hostname}/api/capabilities/types`,
          trace_hint:
            "Echo `x-pcc-trace-id` on every subsequent request so PCC can correlate your onboarding journey. Quote it when filing `pcc_report` feedback.",
        },
        onchain: onchainAttempted
          ? onchainResult
            ? { status: "written", ...onchainResult }
            : { status: "pending", registryAddress: getIdentityRegistryAddress() }
          : { status: "disabled" },
      });
    } catch (err: unknown) {
      const code = classifyProvisionError(err);
      if (code === "too_many_keys") {
        return reply.status(429).send({
          error: "too_many_keys", message: "Maximum 5 active API keys per operator",
        });
      }
      if (code === "invalid_public_key") {
        return reply.status(400).send({
          error: "invalid_public_key",
          message: "publicKey must be a 32-byte Ed25519 public key (64 hex chars, optional 0x prefix)",
        });
      }
      if (code === "provision_in_progress") {
        return reply.status(500).send({
          error: "provision_failed", message: "Key provisioning in progress — try again in a moment",
        });
      }
      return reply.status(500).send({ error: "provision_failed", message: "Failed to provision key" });
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
  // The agent's public key is set only from the caller's publicKey.
  // Body: { message: string, signature: string }. Returns
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
          "No verifiable public key on file for this agent. Re-provision with publicKey.",
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
  // Only a proven owner or the admin may list another key of an address.
  app.get("/api/auth/keys", async (req, reply) => {
    const apiKeyId = req.apiKeyId ?? resolveApiKey(req)?.id;
    const authority = authorityOf(req);
    const owner = provenOwnerAddress(req) ?? (authority.admin ? authority.claimed?.toLowerCase() : null);
    if (!apiKeyId && !owner) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const repo = getRepos().apiKeys;
    const ownKey = apiKeyId ? repo.findById(apiKeyId) : undefined;
    const keys = owner
      ? getStore().db.select().from(schema.apiKeys).where(or(
        sql`lower(${schema.apiKeys.operatorId}) = ${owner}`,
        apiKeyId ? eq(schema.apiKeys.id, apiKeyId) : undefined,
      )).all()
      : ownKey ? [ownKey] : [];

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
  // Only a proven owner or the admin may revoke another key of an address.
  app.delete("/api/auth/keys/:keyId", async (req, reply) => {
    const owner = provenOwnerAddress(req);
    const admin = authorityOf(req).admin;
    if (!req.apiKeyId && !owner && !admin) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const { keyId } = req.params as { keyId: string };
    const repo = getRepos().apiKeys;
    const key = repo.findById(keyId);

    if (!key || !(key.id === req.apiKeyId || admin || (owner && key.operatorId.toLowerCase() === owner))) {
      return reply.status(404).send({ error: "Key not found" });
    }

    if (key.revokedAt) {
      return reply.status(409).send({ error: "Key already revoked" });
    }

    repo.revoke(keyId);
    return reply.send({ ok: true, key_id: keyId, revoked_at: new Date().toISOString() });
  });
}
