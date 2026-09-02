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
 * ── Why `settlement` is its OWN scope, separate from `operator` ───
 * `operator` is the scope every self-service key gets, because it is what the
 * documented onboarding flow needs (register a kernel, submit evidence,
 * negotiate/build). Moving funds is a categorically different authority, so it
 * is a categorically different scope: an `operator` key can run a shop, and
 * CANNOT fund/release/dispute an escrow or trigger a fiat withdrawal.
 *
 * Consequence, stated plainly because it is a BREAKING change: a key holding
 * only `operator` now gets 403 on the money path where it previously
 * succeeded. `settlement` is granted by manual approval, never by merely
 * completing self-service signup — see PCC_SETTLEMENT_OPERATORS in
 * routes/provision.ts.
 *
 * ── The remaining gap (coord #615), deliberately still open ───────
 * Keys minted BEFORE self-service provisioning was narrowed still hold
 * scopes:["*"], and the wildcard short-circuit below still grants those keys
 * everything regardless of the rules here. That migration is a separate,
 * operator-owned decision (some wildcard keys back live integrations); this
 * file does not force it. GET /api/admin/keys/wildcard-audit reports which keys
 * are still affected. New keys are no longer minted with "*".
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
  // Admin endpoints — full access.
  // `**`, not `*`: a single star matches ONE segment, so "/api/admin/*" did not
  // cover nested admin routes like /api/admin/keys/wildcard-audit or
  // /api/admin/observability/funnel — they fell through to the non-money
  // open-by-default branch, i.e. the advertised admin gate did not actually
  // apply to them. (Those routes carry their own env allowlists, which is why
  // this was not an open door, but the rule was lying.) Caught by cross-family
  // review of PR #309.
  { method: "*",      pattern: "/api/admin/**",                     scopes: ["admin"] },
  // Template author endpoints — publish templates
  { method: "POST",   pattern: "/api/templates/*",                  scopes: ["template_author", "operator", "admin"] },
  { method: "PUT",    pattern: "/api/templates/*",                  scopes: ["template_author", "operator", "admin"] },
  // Auditor endpoints — read-only audit and compliance access
  { method: "GET",    pattern: "/api/audit/*",                      scopes: ["auditor", "admin"] },
  { method: "GET",    pattern: "/api/compliance/*",                 scopes: ["auditor", "operator", "admin"] },
  // Money-path rules are NOT listed here — they are an immutable floor applied
  // on top of whatever this table (or the DB) says. See MONEY_PATH_FLOOR.
];

/**
 * Money-path requirements, enforced as an IMMUTABLE FLOOR.
 *
 * WRITES here move funds and require the dedicated `settlement` scope, NOT
 * `operator` — see the "why settlement is its own scope" note in the file
 * header. Reads stay ungated to avoid breaking the dashboard; what is being
 * closed is funds MOVEMENT.
 *
 * Why a floor and not just another row in the table: `refreshScopeCache` REPLACES
 * the hardcoded defaults wholesale whenever the endpointScopes DB table has any
 * rows. A single stale row — say an escrow rule still naming `operator`, written
 * before this split — would therefore silently restore the old, weaker money
 * authorization, and nothing in the code would say so. Caught by cross-family
 * review of PR #309.
 *
 * These rules are applied AFTER the DB rules and win over them, so the money
 * path is governed by code that ships with the binary, never by a row somebody
 * forgot to migrate. Operators can still TIGHTEN the money path with a DB rule
 * that matches more specifically; they cannot loosen it below this.
 */
const MONEY_PATH_FLOOR: Array<{ method: string; pattern: string; scopes: string[] }> = [
  { method: "POST",   pattern: "/api/escrow/**",                    scopes: ["settlement", "admin"] },
  { method: "PUT",    pattern: "/api/escrow/**",                    scopes: ["settlement", "admin"] },
  { method: "PATCH",  pattern: "/api/escrow/**",                    scopes: ["settlement", "admin"] },
  { method: "DELETE", pattern: "/api/escrow/**",                    scopes: ["admin"] },
  { method: "POST",   pattern: "/api/fiat-ramp/**",                 scopes: ["settlement", "admin"] },
  { method: "PUT",    pattern: "/api/fiat-ramp/**",                 scopes: ["settlement", "admin"] },
  { method: "PATCH",  pattern: "/api/fiat-ramp/**",                 scopes: ["settlement", "admin"] },
  { method: "DELETE", pattern: "/api/fiat-ramp/**",                 scopes: ["admin"] },
];

/**
 * The scopes that authorise funds MOVEMENT. Kept as one named constant so the
 * default-deny branch below reports the same answer the rules above enforce —
 * they drifted apart once already (the deny message advertised
 * ["operator","admin"] while the rules had been changed), and a wrong hint on a
 * money route sends an integrator to ask for exactly the wrong grant.
 */
const MONEY_SCOPES = ["settlement", "admin"];

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

/**
 * Drop any persisted rule that targets the money path, then append the
 * hardcoded floor. A DB row can never weaken funds-movement authorization;
 * see MONEY_PATH_FLOOR for why this is not just another table row.
 */
function withMoneyFloor(rules: ScopeRequirement[]): ScopeRequirement[] {
  const nonMoney = rules.filter((r) => !isMoneyPath(r.pattern));
  return [...nonMoney, ...MONEY_PATH_FLOOR.map((r) => ({ ...r }))];
}

function refreshScopeCache(): void {
  try {
    const rows = getRepos().governance.findAllEndpointScopes();
    if (rows.length > 0) {
      scopeCache = withMoneyFloor(
        rows.map((r) => ({
          method: r.method,
          pattern: r.routePattern,
          scopes: Array.isArray(r.requiredScopes) ? r.requiredScopes : [],
        })),
      );
    } else {
      scopeCache = withMoneyFloor(DEFAULT_SCOPE_REQUIREMENTS.map((r) => ({ ...r })));
    }
  } catch {
    // DB not ready — use defaults
    if (scopeCache.length === 0) {
      scopeCache = withMoneyFloor(DEFAULT_SCOPE_REQUIREMENTS.map((r) => ({ ...r })));
    }
  }
  lastScopeCacheRefresh = Date.now();
}

/**
 * Test-only: drop the cached rules so the next request re-reads them.
 *
 * The cache is module-level with a 5-minute TTL, so a suite that changes what
 * the governance table returns would otherwise assert against rules loaded by
 * an earlier test. Mirrors __resetSignerLockForTests / _resetDocsAssetCacheForTests.
 */
export function __resetScopeCacheForTests(): void {
  scopeCache = [];
  lastScopeCacheRefresh = 0;
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

    const reqPath = req.url.split("?")[0];
    const isMoneyWrite =
      isMoneyPath(reqPath) && MUTATING_METHODS.has(req.method.toUpperCase());

    // A principal with NO API KEY has no scopes at all. The common case is a
    // SIWE session: apiGate accepts it and sets only `req.userId`, never
    // `req.apiKeyId`. This used to `return` unconditionally — which meant a
    // session principal skipped the ENTIRE scope layer, money path included.
    //
    // Caught by cross-family review of PR #309 and reproduced by
    // settlement-scope.test.ts. It was latent only because SIWE login was
    // 401ing in production; opening /api/auth/nonce + /verify makes it
    // reachable by anyone holding any wallet, so the bootstrap fix and this
    // guard must ship together.
    //
    // Scopes live on API KEYS. A session proves WHO you are; it is not an
    // authorization to spend. So on a money write, no key => denied. Everything
    // else keeps the previous behaviour (the global default-deny flip is still
    // the separate, sweep-gated change described in the header).
    if (!req.apiKeyId) {
      if (!isMoneyWrite) return;
      return reply.status(403).send({
        error: "insufficient_scope",
        message:
          "Funds movement requires an API key carrying the `settlement` scope. " +
          "A SIWE session proves identity but grants no scopes — provision a key " +
          "with that session (POST /api/auth/provision) and call this route with it.",
        required_scopes: MONEY_SCOPES,
        caller_scopes: [],
        docs: "https://capability.network/whitepaper.md",
      });
    }

    ensureScopeCacheReady();

    const callerScopes = getCallerScopes(req);

    // Wildcard scope grants access to everything.
    //
    // KNOWN, DELIBERATE GAP (coord #615): keys minted before self-service
    // provisioning was narrowed still hold "*", and this short-circuit still
    // honours them on the money path. Retiring them is an operator rollout
    // decision — GET /api/admin/keys/wildcard-audit reports which remain.
    if (callerScopes.includes("*")) return;

    // The floor is applied here too: this fallback is reached only if the cache
    // is somehow empty, and it must not be the one path where a money rule is
    // missing. (It would still fail closed via the default-deny branch below,
    // but "denied for the right reason" beats "denied by accident".)
    const requirements =
      scopeCache.length > 0 ? scopeCache : withMoneyFloor(DEFAULT_SCOPE_REQUIREMENTS);

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
        required_scopes: MONEY_SCOPES,
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
