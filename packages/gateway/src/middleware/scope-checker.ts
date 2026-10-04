/**
 * Scope Checker middleware — API key scope validation against endpoint requirements.
 *
 * Attaches an `onRequest` hook that validates the caller's scopes after api-gate
 * has already resolved the principal: either req.apiKeyId (an API key), or just
 * req.userId with no req.apiKeyId (a SIWE wallet session, which proves identity
 * but carries no scopes). Endpoint scope requirements come from TWO sources that
 * both ALWAYS apply:
 *
 *   - DEFAULT_SCOPE_REQUIREMENTS, the hardcoded built-in rules. These are a
 *     floor: nothing in the endpointScopes table can remove or weaken one.
 *   - The endpointScopes table (cached 5 minutes) — rows ADD requirements on
 *     top of the defaults; they never replace them.
 *
 * For a request, the most-specific matching default rule and the most-specific
 * matching table-row rule are found independently (same matcher, same
 * specificity ordering as before: fewer wildcards = more specific). The caller
 * must satisfy EACH rule that matched — not just one of them.
 *
 * Behaviour:
 *   - A caller with NO API key holds NO scopes at all, so it fails any default
 *     or row rule that matches (403, with a message noting the route needs an
 *     API key). A route neither layer covers behaves exactly as before it is
 *     open, except for the money-path default-deny below, which applies to
 *     every caller equally.
 *   - Wildcard scope ("*") grants access to all endpoints. Unchanged — and
 *     irrelevant to a session, whose scope set is always empty.
 *   - MONEY-PATH routes (MONEY_PATH_PREFIXES) are DEFAULT-DENY for MUTATING
 *     methods (POST/PUT/PATCH/DELETE): if NEITHER a default NOR a row rule
 *     matches, access is REFUSED. A new money-moving route is therefore closed
 *     the moment it is added, rather than silently open until someone
 *     remembers a rule. Money-path READS stay open — the dashboard does GET
 *     /api/escrow and no GET requirement covers it; the exposure closed here
 *     is funds MOVEMENT.
 *   - All other routes remain open-by-default when NEITHER layer matches
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

/**
 * Rows loaded from the endpointScopes table. These ADD to
 * DEFAULT_SCOPE_REQUIREMENTS — they never replace it. Empty until the DB has
 * rows (or is not ready yet), in which case only the defaults apply.
 */
let scopeCache: ScopeRequirement[] = [];
let lastScopeCacheRefresh = 0;
const SCOPE_CACHE_TTL = 300_000; // 5 minutes

/**
 * Refreshes `scopeCache` from the governance table.
 *
 * `scopeCache` holds ONLY the table's rows — never the hardcoded defaults.
 * DEFAULT_SCOPE_REQUIREMENTS is consulted unconditionally in the request hook
 * below, so a row can only ADD a requirement, never remove or weaken one.
 * The previous version swapped the defaults out entirely the moment the table
 * had any row — and the governance seed always writes some — which silently
 * dropped every built-in rule (kernels, evidence, negotiate, jobs, build,
 * admin, templates, audit, compliance) the moment that seed ran.
 */
function refreshScopeCache(): void {
  try {
    const rows = getRepos().governance.findAllEndpointScopes();
    scopeCache = rows.map((r) => ({
      method: r.method,
      pattern: r.routePattern,
      scopes: Array.isArray(r.requiredScopes) ? r.requiredScopes : [],
    }));
  } catch {
    // DB not ready — leave scopeCache as-is (typically still empty). The
    // defaults apply unconditionally regardless, so this never opens anything.
  }
  lastScopeCacheRefresh = Date.now();
}

function ensureScopeCacheReady(): void {
  if (Date.now() - lastScopeCacheRefresh > SCOPE_CACHE_TTL) {
    refreshScopeCache();
  }
}

/**
 * Test-only: drop the cached rows so the next request re-reads them.
 *
 * The cache is module-level with a 5-minute TTL, so a suite that changes
 * what the governance table returns would otherwise assert against rows
 * loaded by an earlier test in the same file.
 */
export function __resetScopeCacheForTests(): void {
  scopeCache = [];
  lastScopeCacheRefresh = 0;
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

/**
 * Most-specific matching rule in `rules` for this request, or undefined.
 * Specificity ranks by wildcard count — fewer wildcards = more specific —
 * the same ordering the single merged list used before defaults and table
 * rows were split into two lists checked independently (see the header).
 */
function firstMatch(
  rules: ScopeRequirement[],
  reqMethod: string,
  reqUrl: string,
): ScopeRequirement | undefined {
  const sorted = [...rules].sort((a, b) => {
    const wildA = (a.pattern.match(/\*/g) ?? []).length;
    const wildB = (b.pattern.match(/\*/g) ?? []).length;
    return wildA - wildB;
  });
  for (const rule of sorted) {
    if (matchRoute(reqMethod, reqUrl, rule.method, rule.pattern)) return rule;
  }
  return undefined;
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

const DOCS_URL = "https://capability.network/whitepaper.md";

/** Sends the 403 insufficient_scope refusal for a matched rule the caller fails. */
function denyMatchedRule(
  reply: FastifyReply,
  required: string[],
  callerScopes: string[],
  hasApiKey: boolean,
) {
  const base = `This endpoint requires one of the following scopes: ${required.join(", ")}.`;
  const message = hasApiKey
    ? `${base} Your API key has: ${callerScopes.join(", ") || "none"}.`
    : `${base} This route needs an API key — a wallet session alone carries no scopes.`;
  return reply.status(403).send({
    error: "insufficient_scope",
    message,
    required_scopes: required,
    caller_scopes: callerScopes,
    docs: DOCS_URL,
  });
}

async function scopeCheckerImpl(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/")) return;

    ensureScopeCacheReady();

    // A caller with NO API key (the common case: a SIWE session — api-gate
    // accepts it and sets req.userId, never req.apiKeyId) holds NO scopes.
    // This used to `return` here unconditionally, which meant a session-only
    // request skipped the ENTIRE scope layer — money-path default-deny
    // included. Scopes live on API KEYS: a session proves WHO you are, not
    // what you may do, so it is run through the SAME matching below as any
    // other caller, with an empty scope set — it fails any rule that matches,
    // and is unaffected (same as before) by one that doesn't.
    const hasApiKey = !!req.apiKeyId;
    const callerScopes = hasApiKey ? getCallerScopes(req) : [];

    // Wildcard scope grants access to everything. Unchanged; a session's
    // callerScopes is always [], so this never fires for a session.
    if (callerScopes.includes("*")) return;

    // DEFAULT_SCOPE_REQUIREMENTS is consulted UNCONDITIONALLY, and a table
    // row is matched separately against scopeCache — so a row can only ADD a
    // requirement (via matchedRow below) and never remove or weaken the one
    // in matchedDefault.
    const matchedDefault = firstMatch(DEFAULT_SCOPE_REQUIREMENTS, req.method, req.url);
    const matchedRow = firstMatch(scopeCache, req.method, req.url);

    // The caller must satisfy EACH rule that matched — not just one of them.
    for (const matched of [matchedDefault, matchedRow]) {
      if (!matched) continue;
      const hasScope = matched.scopes.some((s) => callerScopes.includes(s));
      if (hasScope) continue;
      return denyMatchedRule(reply, matched.scopes, callerScopes, hasApiKey);
    }

    // Neither a default nor a row rule matched.
    //   - Money path → DENY. An unlisted route under /api/escrow, /api/fiat-ramp
    //     or /api/settlement is an oversight, and defaulting it open is how funds
    //     movement ended up reachable by any authenticated key.
    //   - Everything else → allow, preserving existing behaviour (see the header
    //     note on why the global flip is a separate, sweep-gated change).
    if (!matchedDefault && !matchedRow) {
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
        docs: DOCS_URL,
      });
    }

    // At least one rule matched and the caller satisfied every one of them.
    return;
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
