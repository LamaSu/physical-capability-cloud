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
import { authPath } from "./route-path.js";

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
  // Fiat-ramp SETUP (non-money — see MONEY_PATH_EXCEPTIONS). An operator sets up
  // their OWN funding rails; this is not funds movement, so it needs [operator],
  // NOT [settlement]. More specific than the /api/fiat-ramp/** floor (zero
  // wildcards), so it is matched first. Finding H2.
  { method: "POST",   pattern: "/api/fiat-ramp/cdp/wallet",         scopes: ["operator", "admin"] },
  { method: "POST",   pattern: "/api/fiat-ramp/cdp/provision",      scopes: ["operator", "admin"] },
  { method: "POST",   pattern: "/api/fiat-ramp/coinbase/onramp",    scopes: ["operator", "admin"] },
  // Money-path rules are NOT listed here — they are an immutable floor applied
  // on top of whatever this table (or the DB) says. See MONEY_PATH_FLOOR.
];

/**
 * The scopes that authorise funds MOVEMENT. One named constant so the rules and
 * the default-deny message can never disagree — they drifted apart once already
 * (the message advertised ["operator","admin"] after the rules had changed),
 * and a wrong hint on a money route sends an integrator to request exactly the
 * wrong grant.
 */
const MONEY_SCOPES = ["settlement", "admin"];
/** Destroying a money resource is admin-only; `settlement` moves funds, it does not delete. */
const MONEY_DELETE_SCOPES = ["admin"];

/**
 * Route prefixes where a MISSING requirement means DENY rather than allow.
 *
 * Anything under these prefixes moves money or authorises movement of money, so
 * an unlisted route here is a bug, not an intentionally-public endpoint.
 */
const MONEY_PATH_PREFIXES = ["/api/escrow/", "/api/fiat-ramp/", "/api/settlement/"];

/**
 * Exact routes that sit UNDER a money prefix but do NOT move PCC funds, so the
 * settlement floor must not apply to them (cross-family review of #309, finding
 * H2). Every POST under /api/fiat-ramp/ inherited [settlement,admin], which 403s
 * an ordinary [operator] key on the documented card-free SETUP flow:
 *   - POST /api/fiat-ramp/cdp/wallet      → createWallet(): an UNFUNDED smart wallet
 *   - POST /api/fiat-ramp/cdp/provision   → wallet + a funding-session URL
 *   - POST /api/fiat-ramp/coinbase/onramp → a Coinbase onramp URL (the USER funds)
 * None of these move PCC's USDC; they are operator setup and are gated to
 * [operator] in DEFAULT_SCOPE_REQUIREMENTS below. GRANTING spend authority (POST
 * /api/fiat-ramp/cdp/spend-permission) is deliberately NOT here — issuing a spend
 * permission IS a money-authority act and stays on the settlement floor.
 *
 * The Stripe/Yellowcard webhooks are also NOT exempted, deviating from sol's H2
 * suggestion for a concrete reason: they are RETIRED (410 unless a dev-only legacy
 * flag) precisely because an unsigned callback could forge a credit, so making
 * them public would re-open that hole. Their over-scope only changes the status
 * code of a dead endpoint, not a live callback — the public+provider-HMAC
 * end-state belongs with re-enabling them, not here.
 */
const MONEY_PATH_EXCEPTIONS = new Set([
  "/api/fiat-ramp/cdp/wallet",
  "/api/fiat-ramp/cdp/provision",
  "/api/fiat-ramp/coinbase/onramp",
]);

/** Methods that can move funds. Default-deny applies to these only. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isMoneyPath(path: string): boolean {
  if (MONEY_PATH_EXCEPTIONS.has(path)) return false;
  return MONEY_PATH_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p));
}

/**
 * The money-path floor, DERIVED from MONEY_PATH_PREFIXES rather than written by
 * hand. Two bugs came from hand-maintaining it, both found by the second-opinion
 * review (bridge #1526):
 *
 *   - `/api/settlement/` was in the prefix list (so writes there default-deny)
 *     but had NO floor rules, meaning a settlement write was refused to
 *     EVERYONE, admin included. Latent only because no such route exists yet;
 *     adding one would have shipped it dead on arrival.
 *   - Pattern "/api/escrow/**" compiles to ^/api/escrow/.*$ and does not match
 *     the BARE ROOT "/api/escrow", which isMoneyPath() nevertheless treats as
 *     money — so a root money write was also refused to everyone.
 *
 * Deriving both the subtree and the root for every prefix makes the two lists
 * incapable of drifting apart, which is what the old "keep this in sync"
 * comment was asking a human to guarantee.
 */
const MONEY_PATH_FLOOR: ScopeRequirement[] = MONEY_PATH_PREFIXES.flatMap((prefix) => {
  const root = prefix.slice(0, -1);          // "/api/escrow"
  return [root, `${prefix}**`].flatMap((pattern) => [
    { method: "POST", pattern, scopes: MONEY_SCOPES },
    { method: "PUT", pattern, scopes: MONEY_SCOPES },
    { method: "PATCH", pattern, scopes: MONEY_SCOPES },
    { method: "DELETE", pattern, scopes: MONEY_DELETE_SCOPES },
  ]);
});

/**
 * Rules that are NON-NEGOTIABLE regardless of what the governance table says.
 *
 * `refreshScopeCache` REPLACES the hardcoded defaults wholesale once the DB has
 * any rows, so a security rule that only exists in the defaults silently
 * disappears the moment someone adds an unrelated row. That is fine for a
 * policy choice and unacceptable for a gate: the admin namespace is the other
 * place where a MISSING rule is a hole rather than a preference, so it is
 * pinned here alongside the money floor.
 */
const NON_NEGOTIABLE_RULES: ScopeRequirement[] = [
  ...MONEY_PATH_FLOOR,
  { method: "*", pattern: "/api/admin/**", scopes: ["admin"] },
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

/**
 * Put the non-negotiable rules FIRST, then whatever else survives.
 *
 * Order matters because the matcher sorts by wildcard COUNT and takes the first
 * hit, and `Array.prototype.sort` is stable — so equal-wildcard rules are
 * resolved by insertion order. The floor used to be appended LAST, which meant a
 * broad persisted rule like "POST /api/** -> operator" (2 wildcards, same as
 * "/api/escrow/**") tied the floor and won, letting an operator-only key move
 * money. The floor was not immutable at all. Found by the second-opinion review
 * (bridge #1526) and reproduced before this fix.
 *
 * Ordering alone is not relied upon: money WRITES bypass this table entirely and
 * resolve against the floor directly (see the request hook). This ordering is
 * the belt to that fix's braces, and it covers the admin namespace too.
 */
function withNonNegotiable(rules: ScopeRequirement[]): ScopeRequirement[] {
  const rest = rules.filter(
    (r) => !isMoneyPath(r.pattern) && !r.pattern.startsWith("/api/admin"),
  );
  return [...NON_NEGOTIABLE_RULES.map((r) => ({ ...r })), ...rest];
}

function refreshScopeCache(): void {
  try {
    const rows = getRepos().governance.findAllEndpointScopes();
    if (rows.length > 0) {
      scopeCache = withNonNegotiable(
        rows.map((r) => ({
          method: r.method,
          pattern: r.routePattern,
          scopes: Array.isArray(r.requiredScopes) ? r.requiredScopes : [],
        })),
      );
    } else {
      scopeCache = withNonNegotiable(DEFAULT_SCOPE_REQUIREMENTS.map((r) => ({ ...r })));
    }
  } catch {
    // DB not ready — use defaults
    if (scopeCache.length === 0) {
      scopeCache = withNonNegotiable(DEFAULT_SCOPE_REQUIREMENTS.map((r) => ({ ...r })));
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

    // Accept ONLY a valid JSON array of strings — fail CLOSED on anything else.
    //
    // The previous code, on a JSON.parse failure, fell back to treating the raw
    // column as comma-separated values, so a malformed row like `scopes =
    // settlement` parsed to ["settlement"] and could call POST /api/escrow/.../
    // release — a privilege escalation that comes purely from bad serialization
    // (cross-family review of #309, finding H3). Missing keys already failed
    // closed; malformed serialization did not. Now a corrupt or non-array
    // `scopes` grants nothing.
    //
    // MIGRATION NOTE: if any legacy key stored `scopes` as a bare or CSV string
    // rather than a JSON array, it now resolves to no scopes and must be
    // re-serialized to a JSON array before it works again. This is intentional —
    // the money gate must not infer authority from an unparseable value.
    let parsed: unknown;
    try {
      parsed = JSON.parse(keyRecord.scopes);
    } catch {
      return []; // unparseable serialization → no scopes
    }
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === "string");
    }
    // Valid JSON but not an array (e.g. "settlement", 42, {"*":true}) → no scopes.
    return [];
  } catch {
    // Repo/DB error — a security control must not fail open.
    return [];
  }
}

// ── Fastify Plugin ───────────────────────────────────────────────

async function scopeCheckerImpl(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Authorize against the route Fastify MATCHED, never the raw request line —
    // see authPath (finding H1: percent-encoded paths bypassed the raw-URL checks).
    const reqPath = authPath(req);
    if (!reqPath.startsWith("/api/")) return;

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

    // MONEY WRITES RESOLVE AGAINST THE FLOOR ALONE.
    //
    // Not "the floor plus the table, ordered so the floor wins" — that was the
    // previous attempt, and it lost: a persisted "POST /api/** -> operator" has
    // the SAME wildcard count as "/api/escrow/**", so the sort tied and stable
    // ordering decided it. Ordering is too subtle a thing to rest funds movement
    // on. Excluding the table outright means no rule anyone can write — in the
    // DB, in the defaults, broad or narrow — can widen who moves money. The only
    // way to change that is to change this file.
    //
    // Consequence, stated so nobody is surprised: a money write can no longer be
    // TIGHTENED by a DB rule either. Tightening is a real use case, so if it is
    // ever wanted, it belongs here as an explicit intersect step, not as a
    // silent side effect of table precedence.
    const requirements = isMoneyWrite
      ? MONEY_PATH_FLOOR
      : scopeCache.length > 0
        ? scopeCache
        : withNonNegotiable(DEFAULT_SCOPE_REQUIREMENTS);

    // Find the most-specific matching requirement for this request.
    // We rank by specificity: fewer wildcards = more specific = checked first.
    const sorted = [...requirements].sort((a, b) => {
      const wildA = (a.pattern.match(/\*/g) ?? []).length;
      const wildB = (b.pattern.match(/\*/g) ?? []).length;
      return wildA - wildB;
    });

    let matchedRequirement: ScopeRequirement | undefined;
    for (const req_ of sorted) {
      if (matchRoute(req.method, reqPath, req_.method, req_.pattern)) {
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
      const path = reqPath;
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
