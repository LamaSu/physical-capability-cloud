/**
 * Wave 4.1 — TENANT_ENFORCE feature flag.
 *
 * Per the migration plan in docs/agent-onboarder/NAVI-V2-MIGRATION-PLAN.md
 * (Wave 4.1), tenant scoping on machine_registrations rolls out behind this
 * flag. Default OFF: existing call sites read cross-tenant exactly as
 * before. After dual-running for a week, ops flips TENANT_ENFORCE=true and
 * scoped routes start filtering by req.tenantId.
 *
 * Single source of truth for the flag — every consuming route uses
 * `tenantOpts(req)` so the call sites are uniform and easy to grep.
 *
 * Related:
 *   - packages/gateway/src/middleware/tenant-context.ts (T1.9 — attaches
 *     req.tenantId from API key / SIWE session)
 *   - packages/db/src/interfaces/IRegistrationRepository.ts (TenantScopeOpts)
 */

import type { FastifyRequest } from "fastify";

/**
 * True when the deployment has flipped on tenant filtering.
 *
 * IMPORTANT: this is a function, not a const, because we need to re-read the
 * env var per call. Routes are imported once at boot, and freezing the flag
 * at import time would prevent runtime toggles (and prevent the vitest
 * suite from setting different values per test without `resetModules`,
 * which has its own collateral when transitively pulling in @pcc/agent-runtime).
 *
 * The string comparison is intentional — any value other than the literal
 * "true" disables the flag (no accidental enablement from "1", "yes", or empty).
 */
export function isTenantEnforceOn(): boolean {
  return process.env.TENANT_ENFORCE === "true";
}

/**
 * Build the TenantScopeOpts for a route handler. Returns:
 *
 *   - undefined            → no filter, all rows (TENANT_ENFORCE off, today's behavior)
 *   - { tenantId: string } → filter to that tenant (auth'd request, flag on)
 *   - { tenantId: null }   → filter to anonymous public-discovery rows (no auth, flag on)
 *
 * Pass straight to `repos.registrations.findAll(...)` /
 * `findByCompliance(...)` etc.
 *
 * Why null vs undefined matters here: an anonymous request under
 * TENANT_ENFORCE must NOT see tenant-scoped rows leak (security), but it
 * SHOULD still see rows that were inserted without a tenant (the
 * public-discovery default). The repo's tri-state semantics enforce that.
 */
export function tenantOpts(
  req: Pick<FastifyRequest, "tenantId">,
): { tenantId: string | null } | undefined {
  if (!isTenantEnforceOn()) return undefined;
  return { tenantId: req.tenantId ?? null };
}
