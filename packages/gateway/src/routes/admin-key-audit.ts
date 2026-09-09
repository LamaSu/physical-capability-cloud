/**
 * Admin key audit — visibility into wildcard-scoped API keys
 * (retire-the-wildcard #1099, piece 4).
 *
 * routes/provision.ts no longer mints scopes:["*"] for new self-service keys
 * (see provision-scopes.test.ts), but every key issued before that change
 * still carries scopes:["*"], and the scope-checker wildcard short-circuit
 * still honours it unconditionally — a deliberate, pinned gap (see
 * scope-checker-money-path.test.ts, "KNOWN GAP"). Migrating or revoking those
 * existing keys is a rollout/notification decision for the operator, not
 * something this change makes unilaterally (they may be backing live
 * integrations). This endpoint gives the operator the data to make that
 * call: which keys still hold "*", and how recently each was used.
 *
 *   GET /api/admin/keys/wildcard-audit
 *
 * Gating: apiGate (must be authenticated) + scope-checker (/api/admin/*
 * requires the "admin" scope) + an explicit PCC_KEY_ADMINS allowlist — same
 * pattern as routes/admin-demand.ts and routes/admin-observability.ts.
 * Closed by default: an empty/unset allowlist denies everyone, it does not
 * fall open.
 *
 * Read-only. Revocation already exists (DELETE /api/auth/keys/:keyId) and is
 * deliberately not duplicated here.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getRepos } from "../db.js";

/**
 * Returns true if the operator is on the PCC_KEY_ADMINS allowlist.
 * Comma-separated env var of operator IDs / wallet addresses (lower-cased).
 *
 * If the env var is empty/unset, NO admin is allowed (closed-by-default).
 * Production must explicitly opt in operators.
 */
function isKeyAdmin(operatorId: string | undefined | null): boolean {
  if (!operatorId) return false;
  const raw = process.env.PCC_KEY_ADMINS ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.has(operatorId.toLowerCase());
}

interface WildcardKeySummary {
  key_id: string;
  operator_id: string;
  key_prefix: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}

export async function adminKeyAuditRoutes(app: FastifyInstance) {
  app.get("/api/admin/keys/wildcard-audit", async (req: FastifyRequest, reply: FastifyReply) => {
    const operatorId =
      (req as unknown as { operatorId?: string | null }).operatorId ?? undefined;
    if (!isKeyAdmin(operatorId)) {
      return reply.status(403).send({
        error: "admin_required",
        message: "This endpoint requires an operator on the PCC_KEY_ADMINS allowlist.",
      });
    }

    const active = getRepos().apiKeys.listActive();
    const wildcardKeys: WildcardKeySummary[] = [];

    for (const key of active) {
      let scopes: unknown;
      try {
        scopes = JSON.parse(key.scopes);
      } catch {
        // Malformed scopes already fail CLOSED at the scope-checker layer
        // (getCallerScopes) — not a wildcard grant, so not counted here.
        continue;
      }
      if (Array.isArray(scopes) && scopes.includes("*")) {
        wildcardKeys.push({
          key_id: key.id,
          operator_id: key.operatorId,
          key_prefix: key.keyPrefix,
          name: key.name,
          created_at: key.createdAt,
          last_used_at: key.lastUsedAt,
        });
      }
    }

    return {
      total_active_keys: active.length,
      wildcard_count: wildcardKeys.length,
      narrow_scoped_count: active.length - wildcardKeys.length,
      wildcard_keys: wildcardKeys,
      note:
        "Wildcard keys bypass every scope check (middleware/scope-checker.ts — " +
        "callerScopes.includes('*') short-circuits before the money-path gate). " +
        "Revoke via DELETE /api/auth/keys/:keyId once an operator has migrated to " +
        "a re-provisioned, narrow-scoped key.",
    };
  });
}
