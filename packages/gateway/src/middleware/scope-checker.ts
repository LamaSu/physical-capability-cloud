/**
 * Scope Checker middleware — principal scope validation against endpoint
 * requirements. Runs as an `onRequest` hook AFTER api-gate has resolved the
 * caller into a principal (API-key → req.apiKeyId; SIWE → req.userId).
 * Endpoint scope requirements come from the endpointScopes table (cached
 * 5 minutes) with hardcoded defaults as fallback.
 *
 * Behaviour (FAIL CLOSED — C-01 / C-02 containment):
 *   - Requests with NO principal are public routes that api-gate already
 *     allowed through; they are skipped here.
 *   - Both API-key AND SIWE principals are scope-checked identically. A SIWE
 *     principal currently carries NO granted scopes (no authoritative role
 *     store yet), so it is denied on every scoped/unmatched route — a fresh
 *     wallet is not privileged.
 *   - Missing / null / unreadable scopes resolve to an EMPTY set → DENY
 *     (never a wildcard).
 *   - A route with NO matching scope requirement → DENY (default-deny).
 *   - "*" is NOT a grant-all here; a legacy wildcard key matches no requirement
 *     and is therefore denied.
 *
 * Returns 403 with a descriptive error including the required scopes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getRepos } from "../db.js";

// ── Default Scope Requirements ───────────────────────────────────

const DEFAULT_SCOPE_REQUIREMENTS: Array<{
  method: string;
  pattern: string;
  scopes: string[];
}> = [
  // Operator endpoints — manage kernels, submit evidence
  { method: "POST",   pattern: "/api/kernels/*",                    scopes: ["operator", "admin"] },
  { method: "PUT",    pattern: "/api/kernels/*",                    scopes: ["operator", "admin"] },
  { method: "POST",   pattern: "/api/evidence/*",                   scopes: ["operator", "verifier", "admin"] },
  // Requestor endpoints — browse, submit jobs, build contracts
  { method: "POST",   pattern: "/api/negotiate/*",                  scopes: ["requestor", "operator", "agent", "admin"] },
  { method: "POST",   pattern: "/api/jobs/*",                       scopes: ["requestor", "operator", "agent", "admin"] },
  { method: "POST",   pattern: "/api/build/*",                      scopes: ["requestor", "operator", "agent", "admin"] },
  // Verifier endpoints — attestations on specific jobs
  { method: "POST",   pattern: "/api/jobs/*/attestations/*",        scopes: ["verifier", "admin"] },
  // Admin endpoints — full access
  { method: "*",      pattern: "/api/admin/*",                      scopes: ["admin"] },
  // Template author endpoints — publish templates
  { method: "POST",   pattern: "/api/templates/*",                  scopes: ["template_author", "operator", "admin"] },
  { method: "PUT",    pattern: "/api/templates/*",                  scopes: ["template_author", "operator", "admin"] },
  // Auditor endpoints — read-only audit and compliance access
  { method: "GET",    pattern: "/api/audit/*",                      scopes: ["auditor", "admin"] },
  { method: "GET",    pattern: "/api/compliance/*",                 scopes: ["auditor", "operator", "admin"] },
];

// ── Scope Cache ──────────────────────────────────────────────────

interface ScopeRequirement {
  method: string;  // HTTP method or "*"
  pattern: string; // route pattern with optional wildcards
  scopes: string[];
}

let scopeCache: ScopeRequirement[] = [];
let lastScopeCacheRefresh = 0;
const SCOPE_CACHE_TTL = 300_000; // 5 minutes

function refreshScopeCache(): void {
  try {
    const rows = getRepos().governance.findAllEndpointScopes();
    if (rows.length > 0) {
      scopeCache = rows.map((r) => ({
        method: r.method,
        pattern: r.routePattern,
        scopes: Array.isArray(r.requiredScopes) ? r.requiredScopes : [],
      }));
    } else {
      scopeCache = DEFAULT_SCOPE_REQUIREMENTS.map((r) => ({ ...r }));
    }
  } catch {
    // DB not ready — use defaults
    if (scopeCache.length === 0) {
      scopeCache = DEFAULT_SCOPE_REQUIREMENTS.map((r) => ({ ...r }));
    }
  }
  lastScopeCacheRefresh = Date.now();
}

function ensureScopeCacheReady(): void {
  if (Date.now() - lastScopeCacheRefresh > SCOPE_CACHE_TTL) {
    refreshScopeCache();
  }
}

// ── Route Matching ───────────────────────────────────────────────

/**
 * Convert a route pattern with wildcards to a regex.
 * "**" matches any sequence of path segments (including slashes).
 * "*" matches a single path segment (no slashes).
 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const reStr = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${reStr}(?:\\?.*)?$`);
}

/**
 * Returns true if the requirement matches the incoming request's method + URL.
 */
function matchRoute(
  reqMethod: string,
  reqUrl: string,
  ruleMethod: string,
  rulePattern: string,
): boolean {
  const path = reqUrl.split("?")[0];

  // Method check: "*" is a wildcard
  const methodMatches =
    ruleMethod === "*" || ruleMethod.toUpperCase() === reqMethod.toUpperCase();
  if (!methodMatches) return false;

  return patternToRegex(rulePattern).test(path);
}

// ── Scope Extraction ─────────────────────────────────────────────

/**
 * Resolve the caller's granted scopes. FAIL CLOSED (C-01): any missing / null /
 * unreadable scope source resolves to an EMPTY set (deny), NEVER a wildcard.
 *
 * - API-key principal: read the key's scopes column. Unknown key, unreadable
 *   scopes, or an empty value → [].
 * - SIWE principal (userId, no apiKeyId): no authoritative scope store is wired
 *   yet, so a SIWE caller has NO granted scopes and is denied on scoped routes.
 *   TODO(audit P0 follow-up, Wave 1): resolve SIWE scopes from a normalized
 *   principal / role record so verified wallets can hold real scopes.
 */
function getCallerScopes(req: FastifyRequest): string[] {
  if (req.apiKeyId) {
    try {
      const keyRecord = getRepos().apiKeys.findById(req.apiKeyId);
      if (!keyRecord) return [];

      let scopesRaw: unknown;
      try {
        scopesRaw = JSON.parse(keyRecord.scopes);
      } catch {
        scopesRaw = keyRecord.scopes;
      }

      if (Array.isArray(scopesRaw)) {
        return (scopesRaw as string[]).filter((s) => typeof s === "string");
      }
      if (typeof scopesRaw === "string" && scopesRaw.length > 0) {
        return scopesRaw.split(",").map((s) => s.trim()).filter(Boolean);
      }
    } catch {
      // Non-fatal — fall through to deny.
    }
    // Unreadable / empty scopes → deny (no wildcard fallback).
    return [];
  }

  // SIWE principal (or any non-api-key principal): no granted scopes.
  return [];
}

// ── Fastify Plugin ───────────────────────────────────────────────

async function scopeCheckerImpl(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/")) return;

    // No principal at all → api-gate already allowed this through as a PUBLIC
    // route (it 401s non-public unauthenticated requests before this hook runs,
    // short-circuiting the chain). Do NOT scope-check public routes.
    // C-02: we key on principal PRESENCE (apiKeyId OR userId), not on apiKeyId
    // alone, so SIWE principals are enforced identically to API-key principals.
    if (!req.apiKeyId && !req.userId) return;

    ensureScopeCacheReady();

    const callerScopes = getCallerScopes(req);

    // NOTE: "*" is intentionally NOT a grant-all (C-01). A legacy wildcard key
    // resolves to the literal scope "*", which matches no requirement below and
    // is therefore denied. Enforcement is uniform for API-key and SIWE callers.

    const requirements =
      scopeCache.length > 0 ? scopeCache : DEFAULT_SCOPE_REQUIREMENTS;

    // Find the most-specific matching requirement for this request.
    // We rank by specificity: fewer wildcards = more specific = checked first.
    const sorted = [...requirements].sort((a, b) => {
      const wildA = (a.pattern.match(/\*/g) ?? []).length;
      const wildB = (b.pattern.match(/\*/g) ?? []).length;
      return wildA - wildB;
    });

    let matchedRequirement: ScopeRequirement | undefined;
    for (const req_ of sorted) {
      if (matchRoute(req.method, req.url, req_.method, req_.pattern)) {
        matchedRequirement = req_;
        break;
      }
    }

    // C-01 default-deny: a route with NO matching scope policy is DENIED, not
    // allowed. An authenticated principal reaching an unpoliced /api/* route
    // gets 403 until that route declares its required scopes.
    // TODO(audit P0 follow-up, Wave 1): attach a required-scope policy to every
    // /api/* route (route metadata) + a CI check that fails on any unpoliced
    // route, so default-deny never silently over-blocks a legitimate route.
    if (!matchedRequirement) {
      return reply.status(403).send({
        error: "insufficient_scope",
        message:
          "This endpoint has no scope policy and access is denied by default. " +
          "Authenticate with a principal that has an explicit scope grant for this route.",
        required_scopes: [],
        caller_scopes: callerScopes,
        docs: "https://capability.network/whitepaper.md",
      });
    }

    // Check if caller has any of the required scopes
    const hasScope = matchedRequirement.scopes.some((s) => callerScopes.includes(s));
    if (hasScope) return;

    return reply.status(403).send({
      error: "insufficient_scope",
      message: `This endpoint requires one of the following scopes: ${matchedRequirement.scopes.join(", ")}. Your principal has: ${callerScopes.join(", ") || "none"}.`,
      required_scopes: matchedRequirement.scopes,
      caller_scopes: callerScopes,
      docs: "https://capability.network/whitepaper.md",
    });
  });
}

// C-01/C-02: scopeChecker MUST run as a NON-ENCAPSULATED plugin (mirroring
// apiGate) so its onRequest hook applies to the sibling /api/* route plugins.
// Without the skip-override symbol, Fastify isolates the hook to this plugin's
// own (empty) scope, leaving scope enforcement INERT on every route registered
// elsewhere — the pre-existing state this corrects. HIGH BLAST RADIUS: scope
// enforcement that was effectively off is now on; requires integration testing
// (cf. apigate-encapsulation.test.ts for the apiGate precedent).
(scopeCheckerImpl as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
(scopeCheckerImpl as unknown as Record<symbol, unknown>)[Symbol.for("fastify.display-name")] = "scopeChecker";

export const scopeChecker = scopeCheckerImpl;
