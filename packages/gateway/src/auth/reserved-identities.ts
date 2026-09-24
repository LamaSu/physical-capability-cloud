/**
 * Reserved identities — operatorIds that UNVERIFIED self-service may not claim.
 *
 * Several gateway routes authorize by an operatorId ALLOWLIST held in an env
 * var: whoever's key carries a listed operatorId gets that route's elevated
 * access. The self-service email paths (POST /api/auth/provision with `email`,
 * POST /api/contributors/quickstart) set a new key's operatorId from an email
 * the caller merely TYPED — nothing proves they own it. So, before this guard,
 * anyone could provision `{email: "<an admin's email>"}` and receive a key that
 * every one of those allowlists recognizes as that admin (WP-A A7).
 *
 * ONE list of every such env var lives here, so a new allowlist is reserved by
 * adding it in one place. The unverified email paths refuse to mint a key whose
 * operatorId is on ANY of them — with the same 409 `identity_claimed` answer a
 * claimed identity gets (repair R5: a distinct answer would let anyone
 * enumerate the allowlists). Paths that PROVE the identity (a SIWE-verified
 * wallet) are not restricted by this: proving control of the listed wallet is
 * exactly what the allowlist means.
 *
 * Matching is trimmed + case-insensitive, and the env is re-read on every call
 * (no import-time freeze), mirroring the allowlist readers themselves. Most of
 * them lower-case both sides; PCC_OBSERVABILITY_ADMINS compares exactly, so
 * reserving case-insensitively is a superset of every reader — never narrower.
 *
 * The same paths also enforce IDENTITY BINDING (WP-A fold F3, below): an
 * operatorId that has, or ever had, a key, or owns a kernel / registration /
 * job offer / UI artifact, cannot be claimed by anyone but itself.
 */

import type { FastifyRequest } from "fastify";
import { getRepos, getStore } from "../db.js";
import { getJobOffersStore } from "../services/job-offers-store.js";
import { resolveApiKey } from "./api-key-auth.js";
import { SCOPES_NOT_CARRIED_BY_WILDCARD, parseScopeColumn } from "../middleware/scope-checker.js";

/** Every env var that grants elevated access by operatorId allowlist. */
export const ADMIN_IDENTITY_ALLOWLIST_ENV_VARS = [
  "PCC_KEY_ADMINS",            // routes/admin-key-audit.ts (historical gate; still reserved)
  "AUDIT_ADMINS",              // routes/audit.ts — unscoped audit-log access
  "PCC_DEMAND_ADMINS",         // routes/admin-demand.ts
  "PCC_AGGREGATOR_ADMINS",     // routes/aggregator/agntcy.ts, routes/aggregator/ingest.ts
  "PCC_TOOL_INDEX_ADMINS",     // routes/tool-search.ts — POST /api/tools/reload
  "PCC_OBSERVABILITY_ADMINS",  // routes/admin-observability.ts
  "PCC_SETTLEMENT_OPERATORS",  // routes/provision.ts — settlement-scope approval
  "BROKER_OPERATORS",          // middleware/security-hardening.ts isBrokerOperator —
                               // assigns work to other operators; admin view of
                               // diagnostic logs + support messages
] as const;

export type AdminIdentityAllowlist = (typeof ADMIN_IDENTITY_ALLOWLIST_ENV_VARS)[number];

/**
 * THE identity fold: trimmed (every Unicode space, as JS `trim` does) and
 * lower-cased (full Unicode, as JS `toLowerCase` does). Every identity
 * comparison in this module applies it to BOTH sides — the requested id here in
 * JS, a stored column through the `pcc_norm` SQL function (registered below with
 * this very function) — so the two sides can never fold differently, and an
 * exact string always matches itself. `null`/`undefined` fold to "".
 */
export function normalizeIdentity(id: unknown): string {
  return String(id ?? "").trim().toLowerCase();
}

/** Names of the allowlists that contain `operatorId` (empty = not reserved). */
export function reservedIdentityAllowlists(operatorId: string): AdminIdentityAllowlist[] {
  const needle = normalizeIdentity(operatorId);
  if (!needle) return [];
  return ADMIN_IDENTITY_ALLOWLIST_ENV_VARS.filter((name) =>
    (process.env[name] ?? "")
      .split(",")
      .map(normalizeIdentity)
      .some((entry) => entry.length > 0 && entry === needle),
  );
}

/** True when `operatorId` appears on ANY elevated-access allowlist. */
export function isReservedIdentity(operatorId: string): boolean {
  return reservedIdentityAllowlists(operatorId).length > 0;
}

// A reserved identity is refused with the SAME status and body as a claimed
// one (409 IDENTITY_CLAIMED_RESPONSE, below) — repair R5. A distinct
// 403 `identity_reserved` told any anonymous caller which emails sit on an
// admin allowlist. See decideUnverifiedIdentity.

// ═════════════════════════════════════════════════════════════════════
// Identity binding — WP-A fold F3 (operator-ux #2389 -> board N2)
// ═════════════════════════════════════════════════════════════════════
//
// A7 above stops self-service from claiming an ADMIN identity. The general
// case is the same bug for everyone else: ownership checks compare a key's
// operatorId with the owner recorded on a resource (shop_kernels.
// operator_address, a job offer's poster, ...), and operatorAddress is PUBLIC
// (GET /api/operators/:slug/status). So anyone could provision
// `{email: "<victim's operatorId>"}` and pass every ownership check the victim
// passes — including the e-stop / claim guards other lanes are adding (#335).
// Every ownership fix in that family needs this binding to mean anything.
//
// Rule, on the UNVERIFIED email paths (POST /api/auth/provision {email},
// POST /api/contributors/quickstart): an operatorId that is already CLAIMED —
// it has, or ever had, an API key (revoked and expired keys included), or owns
// a kernel, a machine registration, a job offer (as poster) or a UI artifact —
// is refused with 409 `identity_claimed`, UNLESS the request is authenticated
// AS that operatorId (a valid Bearer API key whose operatorId matches). Then
// the additional key is minted with scopes never wider than the caller's own
// (callerMayDelegate). Matching is trimmed and case-insensitive everywhere
// (normalizeIdentity on both sides). The refusal never says WHICH resource
// matched. The wallet path is unaffected: it is SIWE-gated (proof of control).
//
// ONCE ISSUED, AN IDENTITY STAYS BOUND (repair R2). Revoking an identity's
// last key does NOT release it: resources keyed on that operatorId outlive
// the key (artifacts, request-node assignments, support threads, diagnostics
// listings, ...), and a stranger who re-claimed the id would inherit them all —
// while the real owner was locked out. The A10 revocation campaign revokes
// test, expired and dormant keys without re-issue, which would have released
// exactly those identities. Re-issue for a holder with no valid key goes
// through a still-valid key of the same identity (Bearer), SIWE (a wallet
// identity), or the operator (out-of-band) — never through a typed email.
//
// Which owner tables are consulted (R2 asked for every operatorId-owned store
// the reviewer named, where the lookup is a cheap indexed one):
//   - api_keys.operator_id (ANY row), shop_kernels.operator_address,
//     machine_registrations (tenant_id, operator.walletAddress/email),
//     job_offers.poster_did (+ the in-memory offer store) — F3;
//   - ui_artifacts.owner — R2: a scalar owner column with its own index
//     (ui_artifacts_owner_idx), which also covers the pcc_norm scan.
// Deliberately NOT consulted:
//   - capability_requests: a request node's owner is
//     capability_dag[*].assignedOperator, inside a JSON array — no column, no
//     index; the lookup would json_each-parse every request's DAG. A node is
//     assigned to the calling key's own operatorId (bound for good by its
//     api_keys row) unless a BROKER_OPERATORS caller names another id. The
//     scalar requester_email/requester_wallet are body-supplied and authorize
//     nothing, so matching them would only let anyone block a signup.
//   - support threads (routes/support-messages.ts): an in-memory array (<=200,
//     gone on restart), not a table. A thread's owner is always its
//     authenticated creator: a key's operatorId (bound by its api_keys row) or
//     a SIWE address (never email-shaped, so the email paths cannot mint it).
//   - diagnostics uploads (routes/diagnostic-logs.ts): an in-memory array
//     (<=100, 72h), not a table, and no authenticated owner is recorded — the
//     only owner-like field is the body-supplied kernelId. Matching it would
//     let any key holder reserve an arbitrary email for 72h.
//
// Fails CLOSED: if the lookup itself errors, the identity is treated as
// claimed — an unanswerable ownership question grants nothing.

interface RawSqlite {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  function(name: string, options: { deterministic: boolean }, fn: (value: unknown) => string): unknown;
}

/** Connections that already carry `pcc_norm` (registration is per handle). */
const normRegistered = new WeakSet<object>();

function rawSqlite(): RawSqlite {
  const client = (getStore().db as unknown as { $client?: RawSqlite }).$client;
  if (!client || typeof client.prepare !== "function" || typeof client.function !== "function") {
    throw new Error("identity binding: raw sqlite handle unavailable");
  }
  if (!normRegistered.has(client)) {
    // SQLite's built-in lower()/trim() fold ASCII letters and plain spaces
    // only. The claim check used to compare lower(trim(col)) with a needle
    // folded by JS, so a stored 'Émile.Probe@…' stayed 'Émile.probe@…' in SQL
    // while the needle became 'émile.probe@…': the identity was never found
    // claimed, not even for the EXACT same string (review R1). The column is now
    // folded by the same JS function as the needle.
    client.function("pcc_norm", { deterministic: true }, (value) => normalizeIdentity(value));
    normRegistered.add(client);
  }
  return client;
}

// Each query answers "does anything already belong to this id?" — LIMIT 1, no
// data returned. Every stored owner id goes through pcc_norm (= normalizeIdentity)
// and is compared with the needle folded by the same function. A function over
// the column cannot use a b-tree index on it, so each lookup is a scan: of the
// table for api_keys, shop_kernels and machine_registrations, of the covering
// owner index for job_offers and ui_artifacts (EXPLAIN QUERY PLAN). The earlier
// lower(trim(col)) form was a scan too. Both callers are rate-limited signups:
// provision at 5 per IP per hour (canProvision), quickstart only by the global
// per-IP limiter (and it also creates a wallet, a key and a schedule per call).
// An expression index would need a schema change and the function registered on
// every connection that writes these tables, so it is not done here.
//
// machine_registrations.operator is JSON: CASE (evaluated lazily, unlike AND)
// guards json_extract, so one malformed row cannot make every lookup throw.
const CLAIM_QUERIES: ReadonlyArray<{ sql: string; params: number }> = [
  // ANY key row, revoked or expired included: once issued, an identity stays
  // bound (R2). There is no revoked_at filter on purpose.
  {
    sql: "SELECT 1 FROM api_keys WHERE pcc_norm(operator_id) = ? LIMIT 1",
    params: 1,
  },
  {
    sql: "SELECT 1 FROM shop_kernels WHERE pcc_norm(operator_address) = ? LIMIT 1",
    params: 1,
  },
  {
    sql:
      "SELECT 1 FROM machine_registrations WHERE pcc_norm(tenant_id) = ? " +
      "OR pcc_norm(CASE WHEN json_valid(operator) THEN json_extract(operator, '$.walletAddress') END) = ? " +
      "OR pcc_norm(CASE WHEN json_valid(operator) THEN json_extract(operator, '$.email') END) = ? LIMIT 1",
    params: 3,
  },
  {
    sql: "SELECT 1 FROM job_offers WHERE pcc_norm(poster_did) = ? LIMIT 1",
    params: 1,
  },
  {
    sql: "SELECT 1 FROM ui_artifacts WHERE pcc_norm(owner) = ? LIMIT 1",
    params: 1,
  },
];

/**
 * True when `operatorId` (trimmed, case-insensitive — normalizeIdentity on both
 * sides) has, or ever had, an API key (revoked and expired included), or owns
 * a kernel, a machine registration, a job offer or a UI artifact. Errors count
 * as claimed (fail closed). An empty id is never claimed.
 */
export function isClaimedIdentity(operatorId: string): boolean {
  const needle = normalizeIdentity(operatorId);
  if (!needle) return false;
  try {
    const db = rawSqlite();
    for (const q of CLAIM_QUERIES) {
      if (db.prepare(q.sql).get(...Array(q.params).fill(needle))) return true;
    }
  } catch {
    return true; // cannot answer => refuse
  }
  // Offers live in the in-memory store (write-through to job_offers when a
  // sqlite handle is attached; memory-only in some deployments and in tests).
  try {
    if (getJobOffersStore().hasOfferPostedBy(needle)) return true;
  } catch {
    // Store not initialised in this process => no offers were posted through
    // it; persisted offers were already covered by the job_offers query.
  }
  return false;
}

/**
 * The caller's own API key record, or null: the key api-gate already attached
 * (non-public routes), else a `Bearer pcc_…` on this request (public routes
 * such as /api/auth/provision, which api-gate does not resolve). Revoked or
 * expired keys are never returned. A SIWE session is NOT a key.
 */
export function callerApiKey(req: FastifyRequest) {
  const attached = (req as unknown as { apiKeyId?: string }).apiKeyId;
  if (attached) {
    const rec = getRepos().apiKeys.findById(attached);
    if (!rec || rec.revokedAt) return null;
    if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) return null;
    return rec;
  }
  return resolveApiKey(req);
}

/** Same identity, trimmed + case-insensitive. Never true for an empty id. */
export function sameIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeIdentity(a);
  return x.length > 0 && x === normalizeIdentity(b);
}

type CallerKey = NonNullable<ReturnType<typeof callerApiKey>>;

/** What an unverified email path may do for a requested operatorId. */
export type UnverifiedIdentityDecision =
  /** Refuse with 409 IDENTITY_CLAIMED_RESPONSE — reserved and claimed alike. */
  | { kind: "refuse" }
  /** The caller is authenticated AS this identity: mint a delegated key. */
  | { kind: "self"; caller: CallerKey }
  /** Nobody holds this identity: mint for the requested id. */
  | { kind: "fresh" };

/**
 * The ONE decision both unverified email paths (POST /api/auth/provision
 * {email}, POST /api/contributors/quickstart) make before minting anything:
 *
 *   - reserved (on an admin allowlist, A7)  -> refuse, even for a caller that
 *     holds a key of that very identity: an admin key is issued out-of-band;
 *   - the caller's valid Bearer key IS this identity (F3) -> self (delegate,
 *     never wider — callerMayDelegate — and never longer-lived: the routes
 *     pass the caller key's expiresAt to provisionApiKey as `notAfter`, R4);
 *   - claimed (a key was ever issued, or it owns something: F3/R2) -> refuse;
 *   - otherwise -> fresh.
 *
 * Reserved and claimed are refused IDENTICALLY — same status, same body
 * (repair R5). They used to differ (403 identity_reserved vs 409
 * identity_claimed), which let an anonymous caller learn which emails sit on
 * an admin allowlist. The claim lookup also runs for a reserved identity, so
 * the reserved refusal is not the one answer that never touches the database.
 */
export function decideUnverifiedIdentity(req: FastifyRequest, requested: string): UnverifiedIdentityDecision {
  const reserved = isReservedIdentity(requested);
  if (!reserved) {
    const caller = callerApiKey(req);
    if (caller && sameIdentity(caller.operatorId, requested)) return { kind: "self", caller };
  }
  const claimed = isClaimedIdentity(requested);
  return reserved || claimed ? { kind: "refuse" } : { kind: "fresh" };
}

/**
 * The subset of `requested` a caller holding `callerScopes` may delegate to a
 * new key for its OWN identity — never wider than what the caller holds:
 *   - a scope the caller holds verbatim;
 *   - a legacy `"*"` covers a scope ONLY if the wildcard really carries that
 *     scope's authority — never settlement or admin (A1: not money or admin
 *     authority) and never operator (repair R3: not operator-control authority,
 *     since /api/operator/** writes refuse `"*"`). See
 *     SCOPES_NOT_CARRIED_BY_WILDCARD. Otherwise one self-service call would
 *     turn a leaked wildcard key back into the authority it was denied;
 *   - `admin` covers `operator` (every operator rule also names admin).
 * Anything else is dropped. An empty result means "nothing to delegate".
 */
export function callerMayDelegate(callerScopes: readonly string[], requested: readonly string[]): string[] {
  return requested.filter((s) => {
    if (callerScopes.includes(s)) return true;
    if (callerScopes.includes("*") && !SCOPES_NOT_CARRIED_BY_WILDCARD.has(s)) return true;
    if (s === "operator" && callerScopes.includes("admin")) return true;
    return false;
  });
}

/**
 * Parse a stored `scopes` column; anything but a JSON string array => none.
 * The scope-checker's own parser, so delegation reads exactly what is enforced.
 */
export function parseStoredScopes(raw: string | null | undefined): string[] {
  return parseScopeColumn(raw);
}

/** 409 body for a claimed identity. Deliberately does NOT say what matched. */
export const IDENTITY_CLAIMED_RESPONSE = {
  error: "identity_claimed",
  message:
    "This identity already belongs to an existing operator and cannot be " +
    "claimed through unverified self-service. If it is yours: call this " +
    "endpoint authenticated as it (Authorization: Bearer <one of its valid API " +
    "keys>), prove a wallet identity with SIWE, or ask the PCC operator to " +
    "issue the key.",
} as const;

/** 403 body when the caller's own key holds none of the scopes being minted. */
export const NOTHING_TO_DELEGATE_RESPONSE = {
  error: "insufficient_scope",
  message:
    "Your key holds none of the scopes this endpoint would mint, and a key " +
    "can only mint keys no wider than itself. A legacy wildcard key is not " +
    "operator, money or admin authority, so it cannot mint those: ask the PCC " +
    "operator to re-issue your key with explicit scopes.",
} as const;
