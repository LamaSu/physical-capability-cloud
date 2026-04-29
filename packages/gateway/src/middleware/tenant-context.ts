/**
 * Tenant context middleware (T1.9, interim).
 *
 * The full RLS / tenant-aware repo migration is Wave 4 work — it requires a
 * schema change adding `tenant_id` columns to every workspace table plus a
 * Postgres row-level-security policy. This middleware lays the plumbing so
 * the migration can land without touching call sites a second time:
 *
 *   1. Reads the authenticated principal (API key operatorId OR SIWE
 *      address) and attaches it as `req.tenantId`.
 *   2. Provides `getTenantContext(req)` for repo helpers to consume.
 *   3. Documents (via TODO(wave-4) comments at the existing findAll() call
 *      sites) where the actual `where: { tenantId }` filter must land.
 *
 * For routes that legitimately need cross-tenant reads (buyer marketplace
 * surfing the public capability catalog, e.g.), the fix is to opt out
 * explicitly with `{ skipTenantFilter: true, reason: '...' }` so the
 * exception is auditable.
 *
 * Until Wave 4, repos.findAll() still returns all rows — but the request
 * pipeline now records the tenant identity that *should have been* applied,
 * which is half the work. The other half (schema migration + filter
 * application) is tracked in CRITICAL-FINDINGS-AND-REPAIRS.md F9 / Wave 4.
 *
 * T1.9 (2026-04-29).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveApiKey } from "../auth/api-key-auth.js";
import { resolveSession } from "../auth/siwe-auth.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Tenant identity for the authenticated request, OR null for anonymous
     * /api/* routes that opt into being public via PUBLIC_PREFIXES.
     *
     * Source priority: API key operatorId > SIWE wallet address > null.
     */
    tenantId: string | null;
  }
}

export interface TenantContext {
  tenantId: string | null;
  /** True if the request authenticated via API key (most common). */
  byApiKey: boolean;
  /** True if the request authenticated via SIWE wallet session. */
  bySession: boolean;
}

/**
 * Extract the tenant context for a request without mutating it. Used by
 * repo wrappers that need to scope queries.
 */
export function getTenantContext(req: FastifyRequest): TenantContext {
  return {
    tenantId: req.tenantId ?? null,
    byApiKey: req.apiKeyId != null,
    bySession: req.userId != null && req.apiKeyId == null,
  };
}

/**
 * Fastify plugin that attaches `req.tenantId` early in the request lifecycle.
 *
 * Runs as a NON-ENCAPSULATED plugin (skip-override symbol) so the hook fires
 * for sibling route plugins — same pattern apiGate uses (T1.5).
 */
async function tenantContextImpl(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, _reply: FastifyReply) => {
    // Default to null. apiGate sets req.apiKeyId / req.userId BEFORE this hook
    // when registered ahead of tenantContext in the plugin chain; if not, we
    // re-resolve here so the field is always populated for downstream code.
    if (req.apiKeyId && req.operatorId) {
      req.tenantId = req.operatorId;
      return;
    }

    // Try API key directly (covers cases where this plugin is mounted
    // before apiGate or where apiGate is bypassed for a public route that
    // still wants to know the tenant if the request happens to be auth'd).
    const apiKey = resolveApiKey(req);
    if (apiKey) {
      req.tenantId = apiKey.operatorId;
      return;
    }

    // Fall back to SIWE wallet address.
    const session = resolveSession(req);
    if (session) {
      req.tenantId = session.address;
      return;
    }

    req.tenantId = null;
  });
}

(tenantContextImpl as unknown as { [k: symbol]: unknown })[Symbol.for("skip-override")] = true;
(tenantContextImpl as unknown as { [k: symbol]: unknown })[Symbol.for("fastify.display-name")] =
  "tenantContext";

export const tenantContext = tenantContextImpl;
