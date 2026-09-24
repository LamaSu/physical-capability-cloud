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
 * operatorId is on ANY of them (403 `identity_reserved`). Paths that PROVE the
 * identity (a SIWE-verified wallet) are not restricted by this: proving control
 * of the listed wallet is exactly what the allowlist means.
 *
 * Matching is trimmed + case-insensitive, and the env is re-read on every call
 * (no import-time freeze), mirroring the allowlist readers themselves. Most of
 * them lower-case both sides; PCC_OBSERVABILITY_ADMINS compares exactly, so
 * reserving case-insensitively is a superset of every reader — never narrower.
 *
 * The same paths also enforce IDENTITY BINDING (WP-A fold F3, below): an
 * operatorId that already has a key or owns a kernel / registration / job
 * offer cannot be claimed by anyone but itself.
 */

import type { FastifyRequest } from "fastify";
import { getRepos, getStore } from "../db.js";
import { getJobOffersStore } from "../services/job-offers-store.js";
import { resolveApiKey } from "./api-key-auth.js";
import { SCOPES_NOT_CARRIED_BY_WILDCARD } from "../middleware/scope-checker.js";

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

function normalize(id: string): string {
  return id.trim().toLowerCase();
}

/** Names of the allowlists that contain `operatorId` (empty = not reserved). */
export function reservedIdentityAllowlists(operatorId: string): AdminIdentityAllowlist[] {
  const needle = normalize(operatorId);
  if (!needle) return [];
  return ADMIN_IDENTITY_ALLOWLIST_ENV_VARS.filter((name) =>
    (process.env[name] ?? "")
      .split(",")
      .map(normalize)
      .some((entry) => entry.length > 0 && entry === needle),
  );
}

/** True when `operatorId` appears on ANY elevated-access allowlist. */
export function isReservedIdentity(operatorId: string): boolean {
  return reservedIdentityAllowlists(operatorId).length > 0;
}

/**
 * The refusal body the unverified paths return. It deliberately does NOT name
 * which allowlist matched.
 */
export const IDENTITY_RESERVED_RESPONSE = {
  error: "identity_reserved",
  message:
    "This identity is reserved and cannot be claimed through unverified " +
    "self-service. An administrator's key is issued out-of-band (or, for a " +
    "wallet identity, provisioned after proving control with SIWE).",
} as const;

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
// it has ANY unrevoked API key, or owns a kernel, a machine registration, or a
// job offer (as poster) — is refused with 409 `identity_claimed`, UNLESS the
// request is authenticated AS that operatorId (a valid Bearer API key whose
// operatorId matches). Then the additional key is minted with scopes never
// wider than the caller's own (callerMayDelegate). Matching is trimmed and
// case-insensitive everywhere. The refusal never says WHICH resource matched.
// The wallet path is unaffected: it is SIWE-gated (proof of control).
//
// Fails CLOSED: if the lookup itself errors, the identity is treated as
// claimed — an unanswerable ownership question grants nothing.

interface RawSqlite {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

function rawSqlite(): RawSqlite {
  const client = (getStore().db as unknown as { $client?: RawSqlite }).$client;
  if (!client || typeof client.prepare !== "function") {
    throw new Error("identity binding: raw sqlite handle unavailable");
  }
  return client;
}

// Each query answers "does anything already belong to this id?" — LIMIT 1, no
// data returned. machine_registrations.operator is JSON: json_valid() guards
// json_extract so one malformed row cannot make every lookup throw.
const CLAIM_QUERIES: ReadonlyArray<{ sql: string; params: number }> = [
  {
    sql: "SELECT 1 FROM api_keys WHERE revoked_at IS NULL AND lower(trim(operator_id)) = ? LIMIT 1",
    params: 1,
  },
  {
    sql: "SELECT 1 FROM shop_kernels WHERE lower(trim(operator_address)) = ? LIMIT 1",
    params: 1,
  },
  {
    sql:
      "SELECT 1 FROM machine_registrations WHERE lower(trim(coalesce(tenant_id, ''))) = ? " +
      "OR (json_valid(operator) AND (" +
      "lower(trim(coalesce(json_extract(operator, '$.walletAddress'), ''))) = ? " +
      "OR lower(trim(coalesce(json_extract(operator, '$.email'), ''))) = ?)) LIMIT 1",
    params: 3,
  },
  {
    sql: "SELECT 1 FROM job_offers WHERE lower(trim(coalesce(poster_did, ''))) = ? LIMIT 1",
    params: 1,
  },
];

/**
 * True when `operatorId` (trimmed, case-insensitive) already has an unrevoked
 * API key, or owns a kernel, a machine registration or a job offer. Errors
 * count as claimed (fail closed). An empty id is never claimed.
 */
export function isClaimedIdentity(operatorId: string): boolean {
  const needle = normalize(operatorId);
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
  const x = normalize(a ?? "");
  return x.length > 0 && x === normalize(b ?? "");
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

/** Parse a stored `scopes` column; anything but a JSON string array => none. */
export function parseStoredScopes(raw: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) && parsed.every((s) => typeof s === "string") ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** 409 body for a claimed identity. Deliberately does NOT say what matched. */
export const IDENTITY_CLAIMED_RESPONSE = {
  error: "identity_claimed",
  message:
    "This identity already belongs to an existing operator. To add a key for " +
    "it, call this endpoint authenticated as that operator (Authorization: " +
    "Bearer <one of its API keys>). A wallet identity can be provisioned after " +
    "proving control with SIWE.",
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
