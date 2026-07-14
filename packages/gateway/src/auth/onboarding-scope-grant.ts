/**
 * Scope grants (audit P0, lane d749deff).
 *
 * A freshly-provisioned key is minted SCOPELESS (`scopes: []`) — fail-closed, so
 * it can't act until a grant assigns scopes (paired with 9de363c7's provision +
 * scope-checker on fix/audit-p0). Two authorities may grant, both on top of
 * `apiKeys.updateScopes` (active-key-only):
 *
 *   - grantVerifiedOnboardingScopes — the self-service path. May grant ONLY
 *     least-privilege operator/requestor. The CALLER must invoke it only AFTER a
 *     verified onboarding step (registration approved/activated, identity proof);
 *     this module owns "what may be granted", not "was it earned".
 *   - grantAdminScopes — the admin-controlled path. May grant any real role
 *     (operator/requestor/verifier/auditor/agent/template_author/admin). The
 *     CALLER must gate it behind an admin principal (the route's scope policy).
 *
 * NEITHER path can ever grant a wildcard "*". EVERY grant is audited by
 * construction — the audit sink is a required argument, so no scope change can
 * happen without a record.
 */
import type { IApiKeyRepository } from "@pcc/store";

// ApiKeyRow isn't a named @pcc/store export; derive it from updateScopes' return.
type ApiKeyRow = NonNullable<ReturnType<IApiKeyRepository["updateScopes"]>>;

/** Every real scope. Admin grants may assign any of these; NONE is "*". */
export const VALID_SCOPES = new Set<string>([
  "operator", "requestor", "verifier", "admin", "agent", "auditor", "template_author",
]);

/** The only scopes a self-service onboarding flow may grant. */
export const GRANTABLE_ONBOARDING_SCOPES = new Set<string>(["operator", "requestor"]);

/** Default grant for a verified operator/requestor onboarding. */
export const DEFAULT_ONBOARDING_SCOPES: readonly string[] = ["operator", "requestor"];

export class ScopeGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeGrantError";
  }
}

/** Audit event emitted for EVERY successful scope change. */
export interface ScopeGrantAudit {
  keyId: string;
  scopes: string[];
  via: "verified-onboarding" | "admin";
  /** who authorized it: an admin operator id, or "system:verified-onboarding". */
  grantedBy: string;
}
export type ScopeGrantAuditSink = (event: ScopeGrantAudit) => void;

function validate(scopes: unknown, allowlist: Set<string>, allowedLabel: string): string[] {
  const errors: string[] = [];
  if (!Array.isArray(scopes) || scopes.length === 0) return ["grant must be a non-empty scope array"];
  for (const s of scopes) {
    if (typeof s !== "string") errors.push(`non-string scope: ${JSON.stringify(s)}`);
    else if (s === "*") errors.push('wildcard "*" is never grantable');
    else if (!allowlist.has(s)) errors.push(`scope "${s}" is not grantable (allowed: ${allowedLabel})`);
  }
  return errors;
}

/** Validate a self-service onboarding grant (operator/requestor only). */
export function validateOnboardingGrant(scopes: unknown): string[] {
  return validate(scopes, GRANTABLE_ONBOARDING_SCOPES, "operator, requestor");
}

/** Validate an admin-controlled grant (any real role, never "*"). */
export function validateAdminGrant(scopes: unknown): string[] {
  return validate(scopes, VALID_SCOPES, [...VALID_SCOPES].join(", "));
}

function doGrant(
  apiKeys: Pick<IApiKeyRepository, "updateScopes">,
  keyId: string,
  scopes: readonly string[],
  errors: string[],
  via: ScopeGrantAudit["via"],
  grantedBy: string,
  audit: ScopeGrantAuditSink,
): ApiKeyRow {
  if (errors.length) {
    throw new ScopeGrantError(`invalid ${via} scope grant: ${errors.join("; ")}`);
  }
  const list = [...scopes];
  const updated = apiKeys.updateScopes(keyId, list);
  if (!updated) {
    // updateScopes returns undefined for a missing OR revoked/inactive key.
    throw new ScopeGrantError(`scope grant failed: key ${keyId} not found or revoked`);
  }
  audit({ keyId, scopes: list, via, grantedBy });
  return updated;
}

/**
 * Grant scopes to a verified-onboarding key (default: operator + requestor). May
 * grant ONLY operator/requestor. Throws on an invalid grant or a missing/revoked
 * key. Audits on success.
 */
export function grantVerifiedOnboardingScopes(
  apiKeys: Pick<IApiKeyRepository, "updateScopes">,
  keyId: string,
  audit: ScopeGrantAuditSink,
  scopes: readonly string[] = DEFAULT_ONBOARDING_SCOPES,
  grantedBy = "system:verified-onboarding",
): ApiKeyRow {
  return doGrant(apiKeys, keyId, scopes, validateOnboardingGrant([...scopes]), "verified-onboarding", grantedBy, audit);
}

/**
 * Admin-controlled grant: assign any real role (never "*"). The CALLER must have
 * already authorized the actor as an admin (the route's admin scope policy).
 * Throws on an invalid grant or a missing/revoked key. Audits on success.
 */
export function grantAdminScopes(
  apiKeys: Pick<IApiKeyRepository, "updateScopes">,
  keyId: string,
  scopes: readonly string[],
  audit: ScopeGrantAuditSink,
  grantedBy: string,
): ApiKeyRow {
  return doGrant(apiKeys, keyId, scopes, validateAdminGrant(scopes), "admin", grantedBy, audit);
}
