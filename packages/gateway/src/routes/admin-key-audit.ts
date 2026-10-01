/**
 * Admin key audit — visibility into wildcard-scoped API keys
 * (retire-the-wildcard #1099, piece 4; WP-A A8, MUST-CLOSE 9).
 *
 * New keys can no longer be minted with scopes:["*"] (auth/api-key-auth.ts
 * refuses it), but every key issued before that change still carries "*". Since
 * WP-A A1 such a key is no longer money or admin authority
 * (middleware/scope-checker.ts), yet it keeps every other route until it is
 * REVOKED — and migrating or revoking those keys is a rollout/notification
 * decision for the operator (they may be backing live integrations; see
 * docs/security/WILDCARD_KEY_ROTATION.md). This endpoint gives the operator the
 * inventory for that call: which keys still hold "*", and how recently each
 * was used.
 *
 *   GET /api/admin/keys/wildcard-audit
 *
 * Gating (all three must pass):
 *   1. apiGate — the caller is authenticated;
 *   2. scope-checker — /api/admin/** requires an EXPLICIT `admin` scope (a
 *      legacy "*" does not count, and a SIWE session is refused);
 *   3. HERE — `X-Admin-Key` must equal `PCC_ADMIN_KEY` (auth/admin-key.ts:
 *      constant-time, fails closed when unset outside NODE_ENV test/development).
 *
 * It used to be gated by the PCC_KEY_ADMINS operatorId allowlist instead of (3).
 * That authorized an IDENTITY, and a self-service email key could claim any
 * identity — so the gate was spoofable. A secret is held, not claimed.
 *
 * Read-only. The response carries key_id, operator_id, key_prefix (the first 12
 * chars generateApiKey() stores for recognition — never usable as a
 * credential), name, created_at and last_used_at — never a key hash or a raw
 * key. Revocation already exists (DELETE /api/auth/keys/:keyId, by the key's
 * owner) and is deliberately not duplicated here.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getRepos } from "../db.js";
import { checkAdminKey } from "../auth/admin-key.js";

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
    const gate = checkAdminKey(req);
    if (!gate.ok) {
      return reply.status(gate.status).send({ error: gate.error, message: gate.message });
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
        // Build the summary field by field — never spread the row, which also
        // carries key_hash and operator-wallet material.
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
        "Wildcard keys are no longer money or admin authority (middleware/scope-checker.ts) " +
        "but keep every other route until revoked. Re-issue an explicitly-scoped key to " +
        "each holder that still needs access, then revoke the wildcard key (owner: " +
        "DELETE /api/auth/keys/:keyId; otherwise an operator DB action). Runbook: " +
        "docs/security/WILDCARD_KEY_ROTATION.md.",
    };
  });
}
