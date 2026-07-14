/**
 * Scope grants (audit P0, lane d749deff; review finding #3).
 *
 * A freshly-provisioned key is minted SCOPELESS (`scopes: []`) — fail-closed, so
 * it can't act until a grant assigns scopes. Two authorities may grant, both on
 * top of `apiKeys.updateScopes` (active-key-only):
 *
 *   - grantVerifiedOnboardingScopes — self-service; may grant ONLY operator/requestor.
 *   - grantAdminScopes — admin-controlled; may grant any real role.
 *
 * NEITHER can ever grant a wildcard "*".
 *
 * ATOMIC AUDIT (finding #3): the scope update and the durable audit record are one
 * TRANSACTION. If the audit insert fails, the scope update rolls back — so there is
 * no committed privilege grant without a matching durable record. The caller
 * supplies a transaction runner + a concrete audit recorder (not an arbitrary
 * callback): a no-op recorder cannot satisfy the contract because a real recorder
 * performs a durable insert whose failure is what triggers rollback.
 *
 * The caller still owns the AUTHORIZATION (verified onboarding step / admin route);
 * this module owns what-may-be-granted + the atomicity.
 */
import type { IApiKeyRepository } from "@pcc/store";

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

/** The durable audit event for EVERY scope change. */
export interface ScopeGrantAudit {
  keyId: string;
  scopes: string[];
  via: "verified-onboarding" | "admin";
  /** who authorized it: an admin operator id, or "system:verified-onboarding". */
  grantedBy: string;
}

/** A concrete, durable audit recorder — NOT an arbitrary callback. */
export interface ScopeGrantAuditRecorder {
  record(event: ScopeGrantAudit): void;
}

/**
 * Dependencies for an atomic grant. `runInTransaction` must run its callback in a
 * DB transaction that rolls back on throw (e.g. store.db.transaction). apiKeys +
 * audit operations inside it commit or roll back together.
 */
export interface ScopeGrantDeps {
  runInTransaction<T>(fn: () => T): T;
  apiKeys: Pick<IApiKeyRepository, "updateScopes">;
  audit: ScopeGrantAuditRecorder;
}

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
  deps: ScopeGrantDeps,
  keyId: string,
  scopes: readonly string[],
  errors: string[],
  via: ScopeGrantAudit["via"],
  grantedBy: string,
): ApiKeyRow {
  if (errors.length) {
    throw new ScopeGrantError(`invalid ${via} scope grant: ${errors.join("; ")}`);
  }
  const list = [...scopes];
  // Update + durable audit in ONE transaction — audit failure rolls back the grant.
  return deps.runInTransaction(() => {
    const updated = deps.apiKeys.updateScopes(keyId, list);
    if (!updated) {
      // undefined for a missing OR revoked/inactive key.
      throw new ScopeGrantError(`scope grant failed: key ${keyId} not found or revoked`);
    }
    deps.audit.record({ keyId, scopes: list, via, grantedBy });
    return updated;
  });
}

/**
 * Grant scopes to a verified-onboarding key (default: operator + requestor). May
 * grant ONLY operator/requestor. Throws on an invalid grant or a missing/revoked
 * key. Grant + audit are atomic.
 */
export function grantVerifiedOnboardingScopes(
  deps: ScopeGrantDeps,
  keyId: string,
  scopes: readonly string[] = DEFAULT_ONBOARDING_SCOPES,
  grantedBy = "system:verified-onboarding",
): ApiKeyRow {
  return doGrant(deps, keyId, scopes, validateOnboardingGrant([...scopes]), "verified-onboarding", grantedBy);
}

/**
 * Admin-controlled grant: assign any real role (never "*"). The CALLER must have
 * already authorized the actor as an admin (the route's admin scope policy).
 * Throws on an invalid grant or a missing/revoked key. Grant + audit are atomic.
 */
export function grantAdminScopes(
  deps: ScopeGrantDeps,
  keyId: string,
  scopes: readonly string[],
  grantedBy: string,
): ApiKeyRow {
  return doGrant(deps, keyId, scopes, validateAdminGrant(scopes), "admin", grantedBy);
}
