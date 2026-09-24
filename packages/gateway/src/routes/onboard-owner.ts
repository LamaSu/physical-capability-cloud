/**
 * Who owns a machine registration (WP-B round 5, M3).
 *
 * A registration's owner is the AUTHENTICATED caller that created it, never
 * an identity named in the request body. /prove, PATCH and DELETE authorize
 * by comparing the caller with this owner, and #326 (WP-A) treats the
 * operator identities on registrations as claimed identities, so a
 * body-chosen owner would let anyone squat someone else's email or wallet
 * (and make the victim's own provisioning fail with 409 identity_claimed).
 *
 * Used by both writers of machine_registrations: POST /api/onboard/register
 * and the onboarding wizard's machine-onboarding completion.
 */

import { isPlainObject } from "./onboard-evidence.js";

/** Stored when a registration has no authenticated owner; it matches nobody. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_ADDRESS_RE = /^0x0{40}$/i;

/** The identity fields of a registration's operator block. */
const OWNER_IDENTITY_FIELDS = ["walletAddress", "email"] as const;

/**
 * The identity fold for comparing identities: trimmed and lower-cased. It
 * must stay identical to normalizeIdentity in #326's
 * auth/reserved-identities.ts; unify the two at integration.
 */
export function foldIdentity(id: unknown): string {
  return String(id ?? "").trim().toLowerCase();
}

/** An empty value or the zero-address placeholder names nobody. */
function namesNobody(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  return typeof v === "string" && (v.trim() === "" || ZERO_ADDRESS_RE.test(v.trim()));
}

export type OwnerBinding =
  | { ok: true; operator: Record<string, unknown> }
  | { ok: false; status: 400 | 403; error: "invalid_operator" | "operator_must_be_caller"; message: string; field?: string };

/**
 * Bind a new registration's operator block to the authenticated `actor`
 * (req.operatorId for an API key, the SIWE req.userId otherwise).
 *
 * - Every identity the body names (operator.walletAddress, operator.email)
 *   must be the actor's own, compared folded; anything else is 403
 *   operator_must_be_caller. With no actor, the body may name nobody.
 * - The stored owner identity is the actor's exact string, in walletAddress
 *   (the field the ownership checks read first). An email the body named,
 *   being the actor's, is stored as the actor's string too.
 * - With no actor, the registration gets the zero-address placeholder, which
 *   no caller can act as (rule 7).
 * - The rest of the operator block (displayName, certifications, ...) is kept.
 */
export function bindRegistrationOwner(actor: string | null, bodyOperator: unknown): OwnerBinding {
  if (bodyOperator !== undefined && bodyOperator !== null && !isPlainObject(bodyOperator)) {
    return { ok: false, status: 400, error: "invalid_operator", message: "operator must be an object." };
  }
  const given: Record<string, unknown> = isPlainObject(bodyOperator) ? bodyOperator : {};
  const caller = actor === null ? null : foldIdentity(actor);
  for (const field of OWNER_IDENTITY_FIELDS) {
    const named = given[field];
    if (namesNobody(named)) continue;
    if (caller === null || typeof named !== "string" || foldIdentity(named) !== caller) {
      return {
        ok: false,
        status: 403,
        error: "operator_must_be_caller",
        field: `operator.${field}`,
        message:
          caller === null
            ? `operator.${field} names an identity, but the request is not authenticated. A registration's owner is the authenticated caller.`
            : `operator.${field} must be your own identity: a registration's owner is the authenticated caller, never an identity named in the body.`,
      };
    }
  }
  const { walletAddress: _walletAddress, email, ...rest } = given;
  const operator: Record<string, unknown> = {
    displayName: "Unknown",
    certifications: [],
    trainingAcknowledgments: {},
    ...rest,
    walletAddress: actor ?? ZERO_ADDRESS,
  };
  if (actor !== null && !namesNobody(email)) operator.email = actor;
  return { ok: true, operator };
}
