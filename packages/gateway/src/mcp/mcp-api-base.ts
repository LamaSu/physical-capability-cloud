/**
 * Upstream API data-plane resolution for the MCP proxy (PCC_API_BASE_URL).
 *
 * SECURITY (re-audit environment-isolation blocker, 2026-07-15): the /mcp proxy
 * forwards the caller's bearer credential to this origin and can perform WRITE
 * operations there (the full /mcp surface). It was hardcoded to
 * `https://capability.network`, so ANY non-production gateway proxied — and could
 * write — to PRODUCTION (escrow = money path). This module makes the target
 * validated, environment-local, and fail-closed:
 *
 *   - Deployed (NODE_ENV=production): PCC_API_BASE_URL is REQUIRED, https, a bare
 *     origin. There is NO silent production fallback — missing/invalid → the MCP
 *     proxy is DISABLED (fail closed); the rest of the gateway stays healthy.
 *   - Environment isolation: a non-production deployment (e.g. `staging`) MUST NOT
 *     target the production origin.
 *   - Local/test: an explicit value wins; otherwise the gateway's own localhost
 *     API (http allowed off-deploy).
 *
 * This is DISTINCT from PCC_MCP_APP_DOMAIN (the reviewed iframe/app origin) — that
 * is the app view's browser origin; this is the upstream API data plane.
 */

/** The production data-plane origin. A non-production deployment may not target it. */
export const PCC_PRODUCTION_ORIGIN = "https://capability.network";

/** Env var carrying the upstream API origin the /mcp proxy forwards to. */
export const MCP_API_BASE_ENV = "PCC_API_BASE_URL";

/** True in a deployed environment (staging/production) — NOT local/test. */
function isDeployed(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * The deployment environment identity: an explicit `PCC_DEPLOYMENT_ENV` wins,
 * else Railway's `RAILWAY_ENVIRONMENT_NAME`. Lower-cased; null if neither is set.
 */
export function deploymentEnvName(): string | null {
  const explicit = (process.env.PCC_DEPLOYMENT_ENV ?? "").trim().toLowerCase();
  if (explicit) return explicit;
  const railway = (process.env.RAILWAY_ENVIRONMENT_NAME ?? "").trim().toLowerCase();
  return railway || null;
}

export interface McpApiBase {
  /** Validated, normalized upstream origin (scheme://host[:port], no trailing slash/path). */
  origin: string;
}
export interface McpApiBaseError {
  /** Why the proxy is failed-closed (surfaced as the MCP error message). */
  error: string;
}

/** Parse + validate a configured value as a bare origin (no path/query/fragment/creds). */
function normalizeOrigin(raw: string, requireHttps: boolean): McpApiBase | McpApiBaseError {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: `${MCP_API_BASE_ENV} is not a valid URL: ${JSON.stringify(raw)}` };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { error: `${MCP_API_BASE_ENV} must be an http(s) origin (got ${u.protocol})` };
  }
  if (requireHttps && u.protocol !== "https:") {
    return { error: `${MCP_API_BASE_ENV} must use https in a deployed environment (got ${u.protocol})` };
  }
  if (u.username || u.password) {
    return { error: `${MCP_API_BASE_ENV} must not contain credentials (username/password)` };
  }
  if (u.search || u.hash) {
    return { error: `${MCP_API_BASE_ENV} must not contain a query string or fragment` };
  }
  if (u.pathname !== "/" && u.pathname !== "") {
    return { error: `${MCP_API_BASE_ENV} must be a bare origin with no path (got ${JSON.stringify(u.pathname)})` };
  }
  // `URL.origin` is the normalized origin — trailing slash + root path stripped.
  return { origin: u.origin };
}

/**
 * Resolve the upstream API origin for the MCP proxy, or an error that fails the
 * proxy CLOSED. Deterministic over the environment; call per-request (cheap).
 */
export function resolveMcpApiBase(): McpApiBase | McpApiBaseError {
  const raw = (process.env[MCP_API_BASE_ENV] ?? "").trim();
  const deployed = isDeployed();
  const envName = deploymentEnvName();

  if (!raw) {
    if (deployed) {
      return {
        error:
          `${MCP_API_BASE_ENV} is not set — the MCP proxy is disabled for this ` +
          `${envName ?? "deployed"} environment (no silent fallback to production).`,
      };
    }
    // Off-deploy convenience: the gateway's own API on localhost (http allowed).
    const port = (process.env.PORT ?? "3200").trim();
    return { origin: `http://127.0.0.1:${port}` };
  }

  const normalized = normalizeOrigin(raw, deployed);
  if ("error" in normalized) return normalized;

  // Environment isolation: a non-production deployment must not target production.
  if (envName && envName !== "production" && normalized.origin === PCC_PRODUCTION_ORIGIN) {
    return {
      error:
        `${MCP_API_BASE_ENV} points at the production origin (${PCC_PRODUCTION_ORIGIN}) from a ` +
        `'${envName}' deployment — refusing (environment isolation).`,
    };
  }

  return normalized;
}

/** The resolved proxy origin, or null when the MCP proxy is failed-closed. */
export function mcpApiBaseOrigin(): string | null {
  const r = resolveMcpApiBase();
  return "error" in r ? null : r.origin;
}

/** The fail-closed error message, or null when the proxy base is available. */
export function mcpApiBaseUnavailableMessage(): string | null {
  const r = resolveMcpApiBase();
  return "error" in r ? r.error : null;
}
