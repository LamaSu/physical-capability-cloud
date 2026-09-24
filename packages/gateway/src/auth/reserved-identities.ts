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
 */

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
