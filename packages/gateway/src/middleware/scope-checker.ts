/**
 * Scope Checker middleware — API key scope validation against endpoint requirements.
 *
 * Attaches an `onRequest` hook that validates the caller's scopes after api-gate
 * has already set req.apiKeyId. Endpoint scope requirements come from the
 * endpointScopes table (cached 5 minutes) with hardcoded defaults as fallback.
 *
 * Behaviour:
 *   - Wildcard scope ("*") grants every endpoint EXCEPT money writes, the admin
 *     namespace and operator-control writes. It is NOT money authority, NOT
 *     admin authority and NOT operator-control authority: a money write needs an
 *     explicit MONEY_SCOPES entry, /api/admin/** needs an explicit "admin" scope
 *     and a write under /api/operator/** needs an explicit "operator"/"admin"
 *     scope, whatever else the key holds (see the migration note below).
 *   - The admin namespace (/api/admin/**) is enforced IN THE HOOK, independent
 *     of the rule table and of pattern precedence: explicit "admin", and a
 *     principal with no API key (a SIWE session) is refused there.
 *   - MONEY-PATH routes (MONEY_PATH_PREFIXES) are DEFAULT-DENY for MUTATING
 *     methods (POST/PUT/PATCH/DELETE): if no requirement matches, access is
 *     REFUSED. A new money-moving route is therefore closed the moment it is
 *     added, rather than silently open until someone remembers a rule.
 *     Money-path READS stay open — the dashboard does GET /api/escrow and no GET
 *     requirement covers it; the exposure closed here is funds MOVEMENT.
 *   - The exact money-moving routes OUTSIDE those prefixes (MONEY_EXACT_WRITES:
 *     the Story IP royalty/revenue writes) are money writes too, resolved the
 *     same way (WP-A fold F2).
 *   - Mutating methods under /api/operator/** (the operator control surface:
 *     e-stop, approvals, policy, diagnostics, the pcc-node relay) need an
 *     EXPLICIT `operator` or `admin` — a floor enforced in the hook, not a table
 *     row (WP-A fold F4), checked BEFORE the legacy wildcard (repair R3).
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
 * ── MIGRATION NOTE: legacy wildcard keys (coord #615, MUST-CLOSE 7) ─
 * Keys minted BEFORE self-service provisioning was narrowed still hold
 * scopes:["*"] (at the time of writing, every live production key). They used
 * to short-circuit this whole layer, money path and admin namespace included —
 * i.e. every live key could move money. That short-circuit is now narrowed:
 *   - an old wildcard key KEEPS every other route (so existing integrations
 *     keep working — including rule-table requirements such as money-path READ
 *     rules, which bind explicit-scope keys only, and every READ under
 *     /api/operator/**);
 *   - it LOSES money writes (needs an explicit `settlement`/`admin` key),
 *     the whole /api/admin/** namespace (needs an explicit `admin` key), and
 *     every MUTATING method under /api/operator/** (needs an explicit
 *     `operator`/`admin` key). The last one is WP-A repair R3: emergency stop
 *     and resume, approval decisions, policy and diagnostics decrypt are
 *     physical-safety controls, the same class as money and admin, and a
 *     leaked wildcard key (one sits in public git history) must not hold them.
 *     It includes the pcc-node relay (heartbeat, evidence, job status, support,
 *     diagnostics upload): a node that relays with a wildcard key needs an
 *     explicit `operator` key BEFORE the deploy that carries this.
 * The holder of a wildcard key that needs money, admin or operator-control
 * authority must be RE-ISSUED an explicit key; a wildcard key cannot mint one
 * for itself (auth/reserved-identities.ts callerMayDelegate). This code does
 * NOT make old wildcard keys disappear: they keep their remaining access until
 * they are REVOKED, and revocation is the operator's call — see
 * docs/security/WILDCARD_KEY_ROTATION.md. GET /api/admin/keys/wildcard-audit
 * lists the keys still holding "*". New keys can no longer be minted with "*"
 * at all (auth/api-key-auth.ts refuses it).
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
  // Fiat-ramp SETUP routes are NOT listed here any more: they resolve against
  // FIAT_SETUP_REQUIREMENTS in the hook, independent of this table (see there).
  // Money-path rules are NOT listed here — they are an immutable floor applied
  // on top of whatever this table (or the DB) says. See MONEY_PATH_FLOOR.
];

/** The admin namespace root. Everything at or under it is admin-only. */
const ADMIN_NAMESPACE_ROOT = "/api/admin";
/** The one scope that is admin authority. `"*"` is NOT admin authority. */
const ADMIN_SCOPES = ["admin"];

/**
 * Admin routes whose authentication is an admin SECRET checked in the route
 * itself AND which api-gate deliberately leaves public — so no API key is ever
 * attached to them (apiGate returns before resolving a key on a public path)
 * and requiring an `admin` scope here would make them unreachable for everyone.
 * "METHOD /path", exact. Keep this list as short as it is.
 *
 *   GET /api/admin/feedback — X-Admin-Token === WAITLIST_ADMIN_TOKEN, fails
 *     closed when the env var is unset (routes/feedback.ts adminOk); listed in
 *     api-gate PUBLIC_PREFIXES for exactly that reason.
 *
 * Every OTHER /api/admin/** route requires an explicit `admin` scope here, on
 * top of whatever gate the route itself carries.
 */
const ADMIN_SECRET_GATED_PUBLIC_ROUTES = new Set(["GET /api/admin/feedback"]);

function isAdminNamespace(path: string): boolean {
  return path === ADMIN_NAMESPACE_ROOT || path.startsWith(`${ADMIN_NAMESPACE_ROOT}/`);
}

/**
 * True when this request must carry an explicit `admin` scope (A3). Decided on
 * the method + normalized path alone — never on the rule table — so no table
 * rule, however specific, can open the admin namespace. (Example that used to
 * work: a DB rule "GET /api/<one-star>/keys/wildcard-audit -> [operator]" has
 * ONE wildcard, `/api/admin/**` has two, so the precedence sort picked the DB
 * rule and an operator key read the admin audit — astra MED, #326.)
 */
export function isAdminScopedRoute(method: string, path: string): boolean {
  if (!isAdminNamespace(path)) return false;
  return !ADMIN_SECRET_GATED_PUBLIC_ROUTES.has(`${method.toUpperCase()} ${path}`);
}

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
 * None of these move PCC's USDC; they are operator setup. GRANTING spend
 * authority (POST /api/fiat-ramp/cdp/spend-permission) is deliberately NOT here —
 * issuing a spend permission IS a money-authority act and stays on the
 * settlement floor.
 *
 * These resolve against THIS set alone, in the hook — never against the rule
 * table (astra MED, #326). They used to live in DEFAULT_SCOPE_REQUIREMENTS, so
 * the moment the governance table had ANY row (which replaces the defaults
 * wholesale) the setup rules vanished and the `/api/fiat-ramp/**` floor entries
 * in the table matched instead: an [operator] key got 403 on setup again. As
 * with money writes and the floor, no table rule can now widen OR tighten them.
 *
 * Exemption is METHOD + path: any OTHER mutating method on one of these paths
 * is an ordinary money write and stays on the floor.
 *
 * The Stripe/Yellowcard webhooks are also NOT exempted, deviating from sol's H2
 * suggestion for a concrete reason: they are RETIRED (410 unless a dev-only legacy
 * flag) precisely because an unsigned callback could forge a credit, so making
 * them public would re-open that hole. Their over-scope only changes the status
 * code of a dead endpoint, not a live callback — the public+provider-HMAC
 * end-state belongs with re-enabling them, not here.
 */
const FIAT_SETUP_REQUIREMENTS: ScopeRequirement[] = [
  { method: "POST", pattern: "/api/fiat-ramp/cdp/wallet",      scopes: ["operator", "admin"] },
  { method: "POST", pattern: "/api/fiat-ramp/cdp/provision",   scopes: ["operator", "admin"] },
  { method: "POST", pattern: "/api/fiat-ramp/coinbase/onramp", scopes: ["operator", "admin"] },
];

/** Paths of the setup routes above (used to keep table rules for them). */
const MONEY_PATH_EXCEPTIONS = new Set(FIAT_SETUP_REQUIREMENTS.map((r) => r.pattern));

/**
 * Money-moving routes that live OUTSIDE the money prefixes (WP-A fold F2 —
 * economics #2353, steward #2450 N10a). The Story IP routes that move royalty
 * or revenue value. They are money writes exactly like a write under
 * MONEY_PATH_PREFIXES: they resolve against MONEY_PATH_FLOOR alone, need an
 * EXPLICIT `settlement`/`admin` scope (a legacy `"*"` does not count), a
 * key-less SIWE session is refused, and no rule-table row can widen them.
 *
 *   POST /api/ip/distribute-royalties  — sets/distributes an IP revenue split
 *   POST /api/ip/settle-royalties      — triggers royalty settlement for a job
 *   POST /api/ip/:ipId/pay             — pays royalty into an IP vault
 *   POST /api/ip/:ipId/claim           — claims revenue out of an IP vault
 *
 * EXACT method + path, deliberately NOT the /api/ip prefix: registering IP,
 * setting licensing terms, raising a dispute and every READ under /api/ip are
 * not funds movement and keep their current rules. `*` is ONE path segment, so
 * a param route matches the matched template (`/api/ip/:ipId/pay`), a concrete
 * path and the `{ipId}` form agent introspection uses.
 */
const MONEY_EXACT_WRITES: ReadonlyArray<{ method: string; pattern: string }> = [
  { method: "POST", pattern: "/api/ip/distribute-royalties" },
  { method: "POST", pattern: "/api/ip/settle-royalties" },
  { method: "POST", pattern: "/api/ip/*/pay" },
  { method: "POST", pattern: "/api/ip/*/claim" },
];

function isMoneyExactWrite(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return MONEY_EXACT_WRITES.some(
    (r) => r.method === m && patternToRegex(r.pattern).test(path.split("?")[0]),
  );
}

/** Methods that can move funds. Default-deny applies to these only. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The operator namespace (WP-A fold F4 — operator-ux #2348, board N31).
 *
 * /api/operator/** carries the operator's CONTROL surface: emergency stop and
 * resume, approval decisions, policy, the pcc-node relay (evidence, heartbeat,
 * job status), support and diagnostics. With no rule it was open-by-default, so
 * ANY authenticated key — a contributor-scoped quickstart key included — could
 * mutate it. A mutating method there now needs `operator` or `admin`.
 *
 * This is a scope FLOOR, enforced in the hook, not a table row: the governance
 * table replaces the defaults wholesale, so a row-only rule would vanish the
 * moment anyone added an unrelated row. A table rule can still TIGHTEN a route
 * here (the hook falls through to normal rule matching after the floor), never
 * widen it. Ownership — WHICH kernel a key may stop — is the route's job
 * (WP-C), not this layer's.
 *
 * EXPLICIT scopes only: a legacy `"*"` does NOT pass this floor (WP-A repair
 * R3). Emergency stop and resume, approval decisions, policy and diagnostics
 * decrypt are physical-safety controls — the same class as money and admin, on
 * which `"*"` is refused too (A1 / MUST-CLOSE 7) — and the one thing ownership
 * checks cannot fix is a leaked key of the owner itself: every legacy key is a
 * wildcard, and one of them sits in public git history. The floor is therefore
 * checked BEFORE the legacy-wildcard return in the hook. It covers the whole
 * mutating surface, the pcc-node relay (heartbeat, evidence, job status,
 * support, diagnostics upload) included, so a node relaying with a wildcard key
 * needs a re-issued explicit `operator` key (see the migration note). A key
 * holding `"*"` AND `operator` passes. A key-less SIWE session holds no scopes
 * and is refused, exactly as on the admin namespace.
 *
 * The singular `/api/operator` root only — `/api/operators/**` (public operator
 * profiles, ratings, channels) is a different namespace and is not affected.
 */
const OPERATOR_NAMESPACE_ROOT = "/api/operator";
const OPERATOR_WRITE_SCOPES = ["operator", "admin"];

/** The explicit scopes an /api/operator/** write needs (F4 / R3). */
export function operatorWriteScopes(): string[] {
  return [...OPERATOR_WRITE_SCOPES];
}

/**
 * Scopes whose authority a legacy `"*"` does NOT carry: exactly the explicit
 * scopes this hook demands on the three request classes where `"*"` is refused
 * — money writes (A1), the admin namespace (A1/A3) and operator-control writes
 * (R3). Derived from those lists so it cannot drift from what is enforced.
 *
 * Used where a key's authority is REPORTED or DELEGATED rather than enforced:
 * a wildcard key must never mint a new key holding one of these for itself
 * (auth/reserved-identities.ts callerMayDelegate) — otherwise one call would
 * launder `"*"` into the very authority it was denied.
 */
export const SCOPES_NOT_CARRIED_BY_WILDCARD: ReadonlySet<string> = new Set([
  ...MONEY_SCOPES,
  ...MONEY_DELETE_SCOPES,
  ...ADMIN_SCOPES,
  ...OPERATOR_WRITE_SCOPES,
]);

/** True for a MUTATING method at or under /api/operator (F4). */
export function isOperatorWriteRequest(method: string, path: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  const p = path.split("?")[0];
  return p === OPERATOR_NAMESPACE_ROOT || p.startsWith(`${OPERATOR_NAMESPACE_ROOT}/`);
}

/** Read methods a `"*"`-method money-path table rule keeps governing (A2). */
const READ_METHODS = ["GET", "HEAD"];

/** Under a money prefix (or its bare root), setup exceptions included. */
function isUnderMoneyPrefix(path: string): boolean {
  return MONEY_PATH_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p));
}

/** Path-level money test (setup exceptions excluded) — used for rule PATTERNS. */
function isMoneyPath(path: string): boolean {
  if (MONEY_PATH_EXCEPTIONS.has(path)) return false;
  return isUnderMoneyPrefix(path);
}

/** Exact method + path match against a fiat-ramp setup route. */
function fiatSetupRequirement(method: string, path: string): ScopeRequirement | undefined {
  const m = method.toUpperCase();
  return FIAT_SETUP_REQUIREMENTS.find((r) => r.method === m && r.pattern === path);
}

/**
 * True when this request is a money WRITE: a mutating method under a money
 * prefix, other than a fiat-ramp SETUP route for its own setup method, or one
 * of the exact money-moving routes outside the prefixes (MONEY_EXACT_WRITES,
 * F2). Money writes resolve against MONEY_PATH_FLOOR alone and require an
 * EXPLICIT money scope — never `"*"`. Exported so agent introspection reports
 * the same thing this hook enforces.
 */
export function isMoneyWriteRequest(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (!MUTATING_METHODS.has(m)) return false;
  if (isMoneyExactWrite(m, path)) return true;
  if (fiatSetupRequirement(m, path)) return false;
  return isUnderMoneyPrefix(path);
}

/** The explicit scopes a money write needs (DELETE is admin-only). */
export function moneyWriteScopes(method: string): string[] {
  return method.toUpperCase() === "DELETE" ? [...MONEY_DELETE_SCOPES] : [...MONEY_SCOPES];
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
const MONEY_PATH_FLOOR: ScopeRequirement[] = [
  ...MONEY_PATH_PREFIXES.flatMap((prefix) => {
    const root = prefix.slice(0, -1);          // "/api/escrow"
    return [root, `${prefix}**`].flatMap((pattern) => [
      { method: "POST", pattern, scopes: MONEY_SCOPES },
      { method: "PUT", pattern, scopes: MONEY_SCOPES },
      { method: "PATCH", pattern, scopes: MONEY_SCOPES },
      { method: "DELETE", pattern, scopes: MONEY_DELETE_SCOPES },
    ]);
  }),
  // The exact money-moving routes outside the prefixes (F2), each for its own
  // method only — so isMoneyWriteRequest and the floor can never disagree.
  ...MONEY_EXACT_WRITES.map((r) => ({
    method: r.method,
    pattern: r.pattern,
    scopes: r.method === "DELETE" ? MONEY_DELETE_SCOPES : MONEY_SCOPES,
  })),
];

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
  { method: "*", pattern: "/api/admin/**", scopes: ADMIN_SCOPES },
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
 * resolve against the floor directly, and the admin namespace is enforced in
 * the hook too (see the request hook). This ordering is the belt to those braces.
 *
 * WHAT IS DROPPED FROM THE TABLE — only rules that are inert anyway:
 *   - money-path rules for a MUTATING method: money writes never consult the
 *     table (they resolve against MONEY_PATH_FLOOR alone), so such a rule could
 *     only mislead a reader about what is enforced;
 *   - admin-namespace rules: /api/admin/** is decided in the hook.
 * WHAT SURVIVES — money-path READ rules (astra HIGH, #326). This used to drop
 * EVERY rule whose pattern was a money path, although the floor covers writes
 * only: a governance row like `GET /api/escrow/** -> [auditor, admin]` silently
 * disappeared and an [operator] key read escrow anyway. A read rule cannot widen
 * a money WRITE (writes never look here), so it is kept. A `"*"`-method
 * money-path rule is kept for its READ methods only — its write half never
 * applied and is not carried into the table.
 */
function withNonNegotiable(rules: ScopeRequirement[]): ScopeRequirement[] {
  const rest = rules.flatMap((r): ScopeRequirement[] => {
    if (r.pattern.startsWith(ADMIN_NAMESPACE_ROOT)) return [];
    if (!isMoneyPath(r.pattern)) return [r];
    const m = r.method.toUpperCase();
    if (MUTATING_METHODS.has(m)) return [];
    if (m === "*") return READ_METHODS.map((method) => ({ ...r, method }));
    return [r];
  });
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
 * Parse an api_keys `scopes` column. The ONE parser for it: this hook, the DLP
 * redactor (middleware/dlp-redactor.ts), agent introspection and the identity
 * delegation helper all read scopes through it, so no two layers can disagree
 * about what a key holds (review R6: the redactor had its own, looser parse).
 *
 * Accepts ONLY a JSON array whose EVERY element is a string — fails CLOSED to
 * `[]` on anything else:
 *   - an unparseable value (no CSV fallback — see below);
 *   - valid JSON that is not an array (e.g. "settlement", 42, {"*":true});
 *   - a mixed array like [42,"settlement"]: a malformed value grants NOTHING,
 *     not its string subset (astra #326 re-review).
 *
 * The CSV fallback is gone on purpose: it turned a malformed row like
 * `scopes = settlement` into ["settlement"] and could call POST
 * /api/escrow/.../release — a privilege escalation that comes purely from bad
 * serialization (cross-family review of #309, finding H3).
 *
 * MIGRATION NOTE: if any legacy key stored `scopes` as a bare or CSV string
 * rather than a JSON array, it resolves to no scopes and must be re-serialized
 * to a JSON array before it works again. This is intentional — no gate may
 * infer authority from an unparseable value.
 */
export function parseScopeColumn(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // unparseable serialization → no scopes
  }
  if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
    return parsed as string[];
  }
  return [];
}

/**
 * Extract scopes from the API key record.
 * Fails CLOSED: a missing key, a DB error, or a scopes value that is not a JSON
 * array of strings yields NO scopes (it used to fall back to ["*"]).
 */
function getCallerScopes(req: FastifyRequest): string[] {
  if (!req.apiKeyId) return [];

  try {
    const keyRecord = getRepos().apiKeys.findById(req.apiKeyId);
    if (!keyRecord) return [];
    return parseScopeColumn(keyRecord.scopes);
  } catch {
    // Repo/DB error — a security control must not fail open.
    return [];
  }
}

// ── Fastify Plugin ───────────────────────────────────────────────

/** Most-specific rule first: fewer wildcards = more specific. Stable for ties. */
function firstMatch(
  rules: ScopeRequirement[],
  method: string,
  path: string,
): ScopeRequirement | undefined {
  const sorted = [...rules].sort((a, b) => {
    const wildA = (a.pattern.match(/\*/g) ?? []).length;
    const wildB = (b.pattern.match(/\*/g) ?? []).length;
    return wildA - wildB;
  });
  return sorted.find((r) => matchRoute(method, path, r.method, r.pattern));
}

const DOCS_URL = "https://capability.network/whitepaper.md";

/** Appended to a refusal when the caller holds the legacy wildcard. */
const WILDCARD_NOT_AUTHORITY =
  " A legacy wildcard key (scopes [\"*\"]) is not money, admin or operator-control " +
  "authority: request a re-issued key carrying the explicit scope.";

function deny(
  reply: FastifyReply,
  required: string[],
  callerScopes: string[],
  message: string,
) {
  return reply.status(403).send({
    error: "insufficient_scope",
    message: callerScopes.includes("*") ? message + WILDCARD_NOT_AUTHORITY : message,
    required_scopes: required,
    caller_scopes: callerScopes,
    docs: DOCS_URL,
  });
}

async function scopeCheckerImpl(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Authorize against the route Fastify MATCHED, never the raw request line —
    // see authPath (finding H1: percent-encoded paths bypassed the raw-URL checks).
    const reqPath = authPath(req);
    if (!reqPath.startsWith("/api/")) return;
    const method = req.method.toUpperCase();

    // Decided on method + normalized path ONLY — never on the rule table, never
    // on what the key holds — so neither a table rule nor a wildcard can move
    // a request out of these three classes.
    const adminRoute = isAdminScopedRoute(method, reqPath);
    const isMoneyWrite = isMoneyWriteRequest(method, reqPath);
    const operatorWrite = isOperatorWriteRequest(method, reqPath);

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
    // authorization to spend, nor to administer. So on a money write OR on the
    // admin namespace, no key => denied (the admin half is astra MED, #326: a
    // session used to walk into /api/admin/** because only money writes were
    // checked here). Everything else keeps the previous behaviour (the global
    // default-deny flip is still the separate, sweep-gated change described in
    // the header).
    if (!req.apiKeyId) {
      if (adminRoute) {
        return deny(
          reply,
          ADMIN_SCOPES,
          [],
          "The admin namespace requires an API key carrying the explicit `admin` " +
            "scope. A SIWE session proves identity but grants no scopes.",
        );
      }
      if (operatorWrite && !isMoneyWrite) {
        // F4: the operator control surface (e-stop, approvals, relay) needs a
        // key carrying `operator`/`admin`; a session holds no scopes at all.
        return deny(
          reply,
          OPERATOR_WRITE_SCOPES,
          [],
          "Changing operator state requires an API key carrying the `operator` " +
            "scope. A SIWE session proves identity but grants no scopes — provision " +
            "a key with that session (POST /api/auth/provision) and call this route with it.",
        );
      }
      if (!isMoneyWrite) return;
      return deny(
        reply,
        moneyWriteScopes(method),
        [],
        "Funds movement requires an API key carrying the `settlement` scope. " +
          "A SIWE session proves identity but grants no scopes — provision a key " +
          "with that session (POST /api/auth/provision) and call this route with it.",
      );
    }

    ensureScopeCacheReady();

    const callerScopes = getCallerScopes(req);

    // ADMIN NAMESPACE — resolved HERE, independent of the table (A3).
    //
    // Explicit `admin` only. `"*"` does not count (A1). No table rule is
    // consulted, so pattern precedence cannot open it and a table rule can
    // neither widen nor tighten it; like money writes, changing who
    // administers means changing this file.
    if (adminRoute) {
      if (ADMIN_SCOPES.some((s) => callerScopes.includes(s))) return;
      return deny(
        reply,
        ADMIN_SCOPES,
        callerScopes,
        "The admin namespace requires the explicit `admin` scope.",
      );
    }

    // MONEY WRITES RESOLVE AGAINST THE FLOOR ALONE — and on EXPLICIT scopes.
    //
    // Not "the floor plus the table, ordered so the floor wins" — that was the
    // previous attempt, and it lost: a persisted "POST /api/** -> operator" has
    // the SAME wildcard count as "/api/escrow/**", so the sort tied and stable
    // ordering decided it. Ordering is too subtle a thing to rest funds movement
    // on. Excluding the table outright means no rule anyone can write — in the
    // DB, in the defaults, broad or narrow — can widen who moves money. The only
    // way to change that is to change this file.
    //
    // `"*"` is not in MONEY_SCOPES and is not honoured here (A1, MUST-CLOSE 7):
    // it used to short-circuit BEFORE this point, so every live wildcard key
    // could move money.
    //
    // Consequence, stated so nobody is surprised: a money write can no longer be
    // TIGHTENED by a DB rule either. Tightening is a real use case, so if it is
    // ever wanted, it belongs here as an explicit intersect step, not as a
    // silent side effect of table precedence.
    if (isMoneyWrite) {
      const floorRule = firstMatch(MONEY_PATH_FLOOR, method, reqPath);
      if (!floorRule) {
        // Unreachable while the floor derives root + subtree for every prefix
        // and every mutating method; kept so a future edit fails CLOSED.
        return deny(
          reply,
          moneyWriteScopes(method),
          callerScopes,
          "This money-path endpoint has no scope requirement configured and is " +
            "therefore denied by default.",
        );
      }
      if (floorRule.scopes.some((s) => callerScopes.includes(s))) return;
      return deny(
        reply,
        floorRule.scopes,
        callerScopes,
        `Funds movement requires one of the following explicit scopes: ${floorRule.scopes.join(", ")}.`,
      );
    }

    // OPERATOR CONTROL SURFACE — a scope FLOOR resolved here, independent of
    // the table (F4): a mutating method under /api/operator needs an EXPLICIT
    // `operator` or `admin`. Checked BEFORE the legacy wildcard (repair R3):
    // e-stop/resume, approvals, policy and diagnostics decrypt are physical
    // safety, the same class as money and admin, so `"*"` does not count here
    // either (see OPERATOR_NAMESPACE_ROOT). Passing the floor is necessary, not
    // sufficient — an explicit-scope key then falls through to normal rule
    // matching, so a table rule can tighten one of these routes but can never
    // open it.
    if (operatorWrite && !OPERATOR_WRITE_SCOPES.some((s) => callerScopes.includes(s))) {
      return deny(
        reply,
        OPERATOR_WRITE_SCOPES,
        callerScopes,
        `Changing operator state requires one of the following explicit scopes: ${OPERATOR_WRITE_SCOPES.join(", ")}. ` +
          `Your API key has: ${callerScopes.join(", ") || "none"}.`,
      );
    }

    // LEGACY WILDCARD — everything else (see the migration note in the
    // header). Past this point the request is not a money write, not in the
    // admin namespace, and not an operator-control write the key lacks an
    // explicit scope for — which is exactly the access an old wildcard key
    // keeps until it is revoked.
    if (callerScopes.includes("*")) return;

    // FIAT-RAMP SETUP — resolved against FIAT_SETUP_REQUIREMENTS alone, never
    // the table (A4). A governance row used to replace the defaults that held
    // these rules, after which the /api/fiat-ramp/** floor matched and 403'd an
    // [operator] key on setup.
    const setupRule = fiatSetupRequirement(method, reqPath);
    if (setupRule) {
      if (setupRule.scopes.some((s) => callerScopes.includes(s))) return;
      return deny(
        reply,
        setupRule.scopes,
        callerScopes,
        `This endpoint requires one of the following scopes: ${setupRule.scopes.join(", ")}. ` +
          `Your API key has: ${callerScopes.join(", ") || "none"}.`,
      );
    }

    const requirements =
      scopeCache.length > 0 ? scopeCache : withNonNegotiable(DEFAULT_SCOPE_REQUIREMENTS);

    // Find the most-specific matching requirement for this request.
    const matchedRequirement = firstMatch(requirements, method, reqPath);

    // No scope requirement matched → allow, preserving existing behaviour (see
    // the header note on why the global flip is a separate, sweep-gated
    // change). Money WRITES never get here (they resolved against the floor
    // above, default-deny included); money-path READS with no matching rule stay
    // open — the dashboard does GET /api/escrow — because the exposure being
    // closed is funds MOVEMENT. A read-side sweep is a separate change with its
    // own compatibility surface.
    if (!matchedRequirement) return;

    // Check if caller has any of the required scopes
    const hasScope = matchedRequirement.scopes.some((s) => callerScopes.includes(s));
    if (hasScope) return;

    return deny(
      reply,
      matchedRequirement.scopes,
      callerScopes,
      `This endpoint requires one of the following scopes: ${matchedRequirement.scopes.join(", ")}. ` +
        `Your API key has: ${callerScopes.join(", ") || "none"}.`,
    );
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
