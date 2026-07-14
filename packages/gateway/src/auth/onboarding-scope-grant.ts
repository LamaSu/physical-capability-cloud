/**
 * Verified-onboarding scope grant (audit P0, lane d749deff).
 *
 * A freshly-provisioned key is minted SCOPELESS (`scopes: []`) — fail-closed, so
 * it can't act until an authenticated/verified onboarding step grants it scopes
 * (paired with 9de363c7's provision + scope-checker on fix/audit-p0). This is
 * that grant: it validates a bounded scope list and calls
 * `apiKeys.updateScopes` (active-key-only).
 *
 * SECURITY: self-service onboarding may grant ONLY least-privilege operator /
 * requestor. It can never grant a wildcard or a privileged role (admin, verifier,
 * auditor, agent, template_author) — those require a separate, admin-gated path.
 * The CALLER is responsible for only invoking this AFTER the onboarding step is
 * actually verified (e.g. a registration is approved/activated, or an identity
 * proof passed); this module owns the "what may be granted", not the "was it
 * earned".
 */
import type { IApiKeyRepository } from "@pcc/store";

// ApiKeyRow isn't a named @pcc/store export; derive it from updateScopes' return.
type ApiKeyRow = NonNullable<ReturnType<IApiKeyRepository["updateScopes"]>>;

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

/**
 * Validate a requested onboarding grant. Returns a list of errors ([] = safe).
 * Rejects: empty, wildcard "*", and anything outside GRANTABLE_ONBOARDING_SCOPES.
 */
export function validateOnboardingGrant(scopes: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(scopes) || scopes.length === 0) return ["grant must be a non-empty scope array"];
  for (const s of scopes) {
    if (typeof s !== "string") errors.push(`non-string scope: ${JSON.stringify(s)}`);
    else if (s === "*") errors.push('wildcard "*" is never grantable via onboarding');
    else if (!GRANTABLE_ONBOARDING_SCOPES.has(s))
      errors.push(`scope "${s}" is not grantable via self-service onboarding (only operator/requestor)`);
  }
  return errors;
}

/**
 * Grant scopes to a verified-onboarding key. Validates the list, then replaces
 * the key's scopes (active keys only). Throws ScopeGrantError on an invalid grant
 * or if the key is missing/revoked. Returns the updated key row.
 *
 * @param apiKeys the api-keys repository (e.g. getRepos().apiKeys)
 * @param keyId   the id of the key to elevate
 * @param scopes  the scopes to grant (default: operator + requestor)
 */
export function grantVerifiedOnboardingScopes(
  apiKeys: Pick<IApiKeyRepository, "updateScopes">,
  keyId: string,
  scopes: readonly string[] = DEFAULT_ONBOARDING_SCOPES,
): ApiKeyRow {
  const list = [...scopes];
  const errors = validateOnboardingGrant(list);
  if (errors.length) {
    throw new ScopeGrantError(`invalid onboarding scope grant: ${errors.join("; ")}`);
  }
  const updated = apiKeys.updateScopes(keyId, list);
  if (!updated) {
    throw new ScopeGrantError(`scope grant failed: key ${keyId} not found or revoked`);
  }
  return updated;
}
