/**
 * Scope Checker middleware — API key scope validation against endpoint requirements.
 *
 * Attaches an `onRequest` hook that validates the caller's scopes after api-gate
 * has already set req.apiKeyId. Endpoint scope requirements come from the
 * endpointScopes table (cached 5 minutes) with hardcoded defaults as fallback.
 *
 * Behaviour:
 *   - Wildcard scope ("*") grants access to all endpoints.
 *   - MONEY-PATH routes (MONEY_PATH_PREFIXES) are DEFAULT-DENY for MUTATING
 *     methods (POST/PUT/PATCH/DELETE): if no requirement matches, access is
 *     REFUSED. A new money-moving route is therefore closed the moment it is
 *     added, rather than silently open until someone remembers a rule.
 *     Money-path READS stay open — the dashboard does GET /api/escrow and no GET
 *     requirement covers it; the exposure closed here is funds MOVEMENT.
 *   - All other routes remain open-by-default when no requirement matches
 *     (backwards compatibility — see the note below on why this is not yet global).
 *   - If a requirement exists and the caller lacks all required scopes → 403.
 *
 * Returns 403 with a descriptive error including the required scopes.
 *
 * ── Why money-path-only default-deny, and not global ──────────────
 * Global default-deny is the correct end state but is NOT a safe single step:
 * `routes/contributors.ts` issues live keys scoped
 * ["contributor:read","contributor:write","schedule:read","schedule:publish"],
 * and most routes have no requirement entry, so a global flip would 403 those
 * keys across the API. Narrowing to the money path closes the actual exposure
 * (funds movement) with no breakage, and leaves the global flip as a follow-up
 * that needs a per-route requirement sweep first.
 *
 * ── This is only HALF the fix (see coord #615) ────────────────────
 * `routes/provision.ts` mints every self-service key with scopes:["*"], and the
 * wildcard short-circuit below grants those keys everything regardless of the
 * rules here. This file and the provisioning policy must BOTH change for the
 * money path to actually be gated; neither alone is sufficient.
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
  // ── Money path — WRITES move funds. Previously had NO requirement at all,
  // so any authenticated key could fund/release/dispute an escrow or trigger a
  // fiat withdrawal/payout. Reads are deliberately left ungated here to avoid
  // breaking the dashboard; the exposure being closed is funds MOVEMENT.
  { method: "POST",   pattern: "/api/escrow/**",                    scopes: ["operator", "admin"] },
  { method: "PUT",    pattern: "/api/escrow/**",                    scopes: ["operator", "admin"] },
  { method: "PATCH",  pattern: "/api/escrow/**",                    scopes: ["operator", "admin"] },
  { method: "DELETE", pattern: "/api/escrow/**",                    scopes: ["admin"] },
  { method: "POST",   pattern: "/api/fiat-ramp/**",                 scopes: ["operator", "admin"] },
  { method: "PUT",    pattern: "/api/fiat-ramp/**",                 scopes: ["operator", "admin"] },
  { method: "PATCH",  pattern: "/api/fiat-ramp/**",                 scopes: ["operator", "admin"] },
  { method: "DELETE", pattern: "/api/fiat-ramp/**",                 scopes: ["admin"] },
];

/**
 * Route prefixes where a MISSING requirement means DENY rather than allow.
 *
 * Anything under these prefixes moves money or authorises movement of money, so
 * an unlisted route here is a bug, not an intentionally-public endpoint. Keep
 * this list and the money-path requirements above in sync.
 */
const MONEY_PATH_PREFIXES = ["/api/escrow/", "/api/fiat-ramp/", "/api/settlement/"];

/** Methods that can move funds. Default-deny applies to these only. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isMoneyPath(path: string): boolean {
  return MONEY_PATH_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p));
}

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
  // Single pass with an alternation, so a replacement's OUTPUT is never
  // re-scanned by a later pass.
  //
  // The previous implementation chained two replaces:
  //     .replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")
  // The second pass saw the "*" inside the ".*" the first pass had just
  // written and rewrote it to ".[^/]*", so "**" matched exactly one character
  // followed by a single segment — it could never cross a slash. "**" has
  // therefore never behaved as its docstring describes. Caught by the
  // money-path rules below, which are the first "**" patterns in this table.
  const reStr = escaped.replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]*"));
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
 * Extract scopes from the API key record.
 * Falls back to ["*"] for backwards compatibility when scopes are not set.
 */
function getCallerScopes(req: FastifyRequest): string[] {
  if (!req.apiKeyId) return [];

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
    // Non-fatal
  }

  // FAIL CLOSED. This path is reached only when a key record exists but its
  // `scopes` column is neither a JSON array nor a non-empty string — i.e. it is
  // malformed. The previous behaviour returned ["*"], so a corrupt scopes value
  // silently granted WILDCARD access to every endpoint. A security control must
  // not fail open: an unreadable scope set grants nothing.
  // (A legitimately empty scope set stored as "[]" parses as an array and
  // returns [] above, so it never reaches here.)
  return [];
}

// ── Fastify Plugin ───────────────────────────────────────────────

async function scopeCheckerImpl(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/")) return;

    // Only check scopes for API key callers (api-gate handles unauthenticated reqs)
    if (!req.apiKeyId) return;

    ensureScopeCacheReady();

    const callerScopes = getCallerScopes(req);

    // Wildcard scope grants access to everything
    if (callerScopes.includes("*")) return;

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

    // No scope requirement matched.
    //   - Money path → DENY. An unlisted route under /api/escrow, /api/fiat-ramp
    //     or /api/settlement is an oversight, and defaulting it open is how funds
    //     movement ended up reachable by any authenticated key.
    //   - Everything else → allow, preserving existing behaviour (see the header
    //     note on why the global flip is a separate, sweep-gated change).
    if (!matchedRequirement) {
      const path = req.url.split("?")[0];
      // Default-deny covers MUTATING methods only. Money-path reads stay open
      // (the dashboard does GET /api/escrow, and no GET requirement covers it),
      // because the exposure being closed here is funds MOVEMENT. A read-side
      // sweep is a separate change with its own compatibility surface.
      if (!isMoneyPath(path) || !MUTATING_METHODS.has(req.method.toUpperCase())) return;

      return reply.status(403).send({
        error: "insufficient_scope",
        message:
          "This money-path endpoint has no scope requirement configured and is " +
          "therefore denied by default. If this route is legitimate, add an " +
          "explicit requirement for it.",
        required_scopes: ["operator", "admin"],
        caller_scopes: callerScopes,
        docs: "https://capability.network/whitepaper.md",
      });
    }

    // Check if caller has any of the required scopes
    const hasScope = matchedRequirement.scopes.some((s) => callerScopes.includes(s));
    if (hasScope) return;

    return reply.status(403).send({
      error: "insufficient_scope",
      message: `This endpoint requires one of the following scopes: ${matchedRequirement.scopes.join(", ")}. Your API key has: ${callerScopes.join(", ") || "none"}.`,
      required_scopes: matchedRequirement.scopes,
      caller_scopes: callerScopes,
      docs: "https://capability.network/whitepaper.md",
    });
  });
}

// scopeChecker must run as a NON-ENCAPSULATED plugin so its onRequest hook
// applies to sibling route plugins registered against the parent app. Without
// these symbols Fastify isolates the hook to this plugin's own scope — and
// since no routes are registered inside it, the hook fired for NOTHING and the
// entire scope/RBAC layer was inert.
//
// This is the identical defect fixed for apiGate in T1.5 (2026-04-29, see
// api-gate.ts and apigate-encapsulation.test.ts); the same fix was never
// applied here. idempotency, rate-limiter, tenant-context and trace-id all set
// this symbol — scope-checker was the one middleware that did not.
//
// Caught empirically: every deny-case in scope-checker-money-path.test.ts
// returned 200 instead of 403 because the hook never ran.
//
// Equivalent to wrapping with fastify-plugin(fn) without adding the dep.
(scopeCheckerImpl as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
(scopeCheckerImpl as unknown as Record<symbol, unknown>)[
  Symbol.for("fastify.display-name")
] = "scopeChecker";

export const scopeChecker = scopeCheckerImpl;
