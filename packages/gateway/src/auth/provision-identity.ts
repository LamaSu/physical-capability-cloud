/**
 * WHICH identity POST /api/auth/provision mints a key for. One function decides it.
 *
 * The route calls resolveProvisionIdentity() to mint. The onboarding chat calls
 * selectProvisionIdentity() (the first half of it) to show a person, before it holds a
 * credential-minting call and again when they confirm it, whose credential the call
 * WOULD mint. Two copies of this decision drifted once: the chat picked the email
 * before the wallet and said an identity-free call cannot mint, while the route picks
 * the wallet first and, with nothing named, falls back to the signed-in SIWE session
 * (astra pack 91b, F2). So the order of precedence lives here and nowhere else:
 *
 *   1. body.walletAddress (truthy): must be a valid EVM address AND be PROVEN by the
 *      caller's SIWE session. The identity is the session's address.
 *   2. body.email (present, even if empty or not a string): an ASSERTED identity,
 *      validated, then checked against reserved and claimed identities.
 *   3. a SIWE session with nothing named: the session's proven address.
 *   4. nobody: refused.
 *
 * The decision is split in two on purpose:
 *   - selectProvisionIdentity(): WHICH identity is chosen. It reads the request's own
 *     credentials and the body, and nothing else, so it reveals nothing about anyone
 *     else. The chat may call it freely.
 *   - resolveProvisionIdentity(): that, then (email only) the reserved / claimed
 *     identity lookup. That lookup answers "does this email already belong to an
 *     operator?", scans the owner tables, and is rate-limited by canProvision (5 per IP
 *     per hour) in the route, so it must not be offered unmetered. Only the route
 *     calls it.
 */

import type { FastifyRequest } from "fastify";
import { resolveSession } from "./siwe-auth.js";
import { decideUnverifiedIdentity, IDENTITY_CLAIMED_RESPONSE, parseStoredScopes } from "./reserved-identities.js";

/** The identity-bearing fields of a provision request body. */
export interface ProvisionIdentityBody {
  email?: unknown;
  walletAddress?: unknown;
}

/** A refusal exactly as the route answers it. */
export interface IdentityRefusal {
  status: number;
  body: Record<string, unknown>;
}

/** Where the chosen identity comes from. */
export type ProvisionIdentitySource =
  /** body.walletAddress, proven by the caller's SIWE session. */
  | "wallet"
  /** Nothing named: the caller's own SIWE session (the documented SIWE provision flow). */
  | "session"
  /** body.email: asserted, never proven. */
  | "email";

export type IdentitySelection =
  | {
      ok: true;
      source: ProvisionIdentitySource;
      /** The identity the key's operatorId will be (an email is the trimmed text as typed). */
      operatorId: string;
      /**
       * True only when this identity was proven by an EIP-4361 signature, never when it
       * was merely asserted (an email is a claim, not a proof). Gates the `settlement`
       * grant: an unproven identity can never move funds, whatever the allowlist says.
       */
      siweVerified: boolean;
    }
  | ({ ok: false } & IdentityRefusal);

export type ResolvedProvisionIdentity =
  | {
      ok: true;
      source: ProvisionIdentitySource;
      operatorId: string;
      siweVerified: boolean;
      /**
       * Set when the caller is authenticated AS the requested email identity (F3): the
       * scopes of the caller's own key, which bound what may be minted.
       */
      delegatingScopes: string[] | null;
      /**
       * On that same path, the caller key's own expiry: the new key expires no later
       * (R4). null = the caller's key does not expire.
       */
      delegatingNotAfter: string | null;
    }
  | ({ ok: false } & IdentityRefusal);

const refuse = (status: number, body: Record<string, unknown>): { ok: false } & IdentityRefusal => ({ ok: false, status, body });

/**
 * Type guards: prevent object/array/number injection (red team #14, #15). The route runs
 * this BEFORE its other body checks (name, capability, publicKey), and the selection
 * runs it again, so a caller that skips the route's order is still safe.
 */
export function identityTypeRefusal(body: ProvisionIdentityBody): IdentityRefusal | null {
  if (body.walletAddress !== undefined && typeof body.walletAddress !== "string") {
    return { status: 400, body: { error: "invalid_type", message: "walletAddress must be a string" } };
  }
  if (body.email !== undefined && typeof body.email !== "string") {
    return { status: 400, body: { error: "invalid_type", message: "email must be a string" } };
  }
  return null;
}

/**
 * Choose the identity a provision request would mint for: steps 1 to 4 above, WITHOUT
 * the reserved / claimed identity lookup. `req` supplies only the caller's credentials
 * (a SIWE session, by cookie or Bearer token); the body supplies what was named.
 */
export function selectProvisionIdentity(req: FastifyRequest, body: ProvisionIdentityBody): IdentitySelection {
  const typeRefusal = identityTypeRefusal(body);
  if (typeRefusal) return refuse(typeRefusal.status, typeRefusal.body);

  // Wallet identity must be proven with SIWE (EIP-4361) before it can mint a
  // key (retire-the-wildcard #1099). A bare walletAddress string used to be
  // trusted with zero proof of control — anyone could provision a live key
  // against an address they don't own. auth/siwe-auth.ts already implements
  // nonce + verify; this wires it into provisioning for wallet-bearing
  // (machine) operators. The email path is unaffected.
  const session = resolveSession(req);

  if (body.walletAddress) {
    const walletAddress = body.walletAddress as string;
    // Wallet address path — format check also implicitly caps length at 42
    if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      return refuse(400, {
        error: "invalid_wallet_address",
        message: "walletAddress must be a valid EVM address (0x + 40 hex chars)",
      });
    }
    if (!session || session.address.toLowerCase() !== walletAddress.toLowerCase()) {
      return refuse(401, {
        error: "wallet_not_verified",
        message:
          "walletAddress must be proven with a SIWE (EIP-4361) session before it can " +
          "provision a key: 1) GET /api/auth/nonce  2) sign the returned SIWE message " +
          "with this wallet  3) POST /api/auth/verify {message, signature} and capture " +
          "the returned token  4) retry this request with Authorization: Bearer <token> " +
          "(or the pcc_session cookie).",
        siwe: { nonce_url: "/api/auth/nonce", verify_url: "/api/auth/verify" },
      });
    }
    return { ok: true, source: "wallet", operatorId: session.address, siweVerified: true };
  }

  if (body.email !== undefined) {
    // Explicit email path WINS over an ambient SIWE session (finding H4). A
    // caller who put `email` in the body chose the email identity; an ambient
    // pcc_session cookie must not silently override it. The old order (session
    // before email) let a wallet-A session + {email} mint a wallet-A key —
    // carrying A's `settlement` scope — on the UNVERIFIED email path, skipping
    // email validation and misattributing telemetry to the email while the key
    // belonged to the wallet. Checking body.email first makes explicit win.
    //
    // Gate on `!== undefined`, NOT truthiness (astra #326 re-review, finding 5):
    // an EXPLICIT but empty/non-string email ({email:""}, {email:null},
    // {email:1}) is still a chosen-email intent — it must be VALIDATED and
    // rejected here, never allowed to fall through to the ambient SIWE session
    // below (which would mint that session's key, settlement scope and all).
    if (typeof body.email !== "string" || body.email.trim().length === 0) {
      return refuse(400, { error: "invalid_email", message: "email must be a non-empty string" });
    }
    // Trim FIRST (F3): " victim@x.test " names the same identity as
    // "victim@x.test", so it must reach the same identity checks rather than
    // bounce off the format check while the bare form is claimable.
    const email = body.email.trim();
    // Email path — RFC 5321 max total length is 254
    if (email.length > 254) {
      return refuse(400, { error: "invalid_email", message: "Email exceeds 254 character limit" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return refuse(400, { error: "invalid_email", message: "Please provide a valid email address" });
    }
    return { ok: true, source: "email", operatorId: email, siweVerified: false };
  }

  if (session) {
    // A verified SIWE session with NO explicit identity in the body — use the
    // cryptographically-proven address directly (the documented SIWE provision
    // flow: POST /api/auth/provision {name} with the session token, walletAddress
    // omitted). siweVerified is what gates the settlement scope.
    return { ok: true, source: "session", operatorId: session.address, siweVerified: true };
  }

  return refuse(400, {
    error: "identifier_required",
    message:
      "Either email, or a verified SIWE session (see /api/auth/nonce + " +
      "/api/auth/verify), is required to provision an API key",
  });
}

/**
 * The full decision the route makes before it mints anything: the selection, then, for
 * an email only, the reserved / claimed identity check.
 *
 * The email is ASSERTED, not proven, so before anything is minted:
 *   - an email on an operatorId allowlist (AUDIT_ADMINS, PCC_DEMAND_ADMINS,
 *     ...) is refused, or anyone who can type it would hold that admin
 *     identity (WP-A A7);
 *   - IDENTITY BINDING (F3, board N2): ownership checks compare a key's
 *     operatorId with a resource's recorded owner, and owner ids are
 *     public, so an email that already names an identity (a key ever
 *     issued, a kernel, a registration, a job offer, an artifact) is
 *     refused unless the caller is authenticated AS it — a valid Bearer
 *     API key whose operatorId matches. The new key then carries the SAME
 *     operatorId string and scopes no wider than the caller's own.
 * Both refusals are the same 409 (R5), which never says what matched.
 * The wallet paths are SIWE-proven and not restricted by this.
 */
export function resolveProvisionIdentity(req: FastifyRequest, body: ProvisionIdentityBody): ResolvedProvisionIdentity {
  const selected = selectProvisionIdentity(req, body);
  if (!selected.ok) return selected;
  if (selected.source !== "email") return { ...selected, delegatingScopes: null, delegatingNotAfter: null };

  const decision = decideUnverifiedIdentity(req, selected.operatorId);
  if (decision.kind === "refuse") return refuse(409, IDENTITY_CLAIMED_RESPONSE);
  if (decision.kind === "self") {
    return {
      ok: true,
      source: "email",
      operatorId: decision.caller.operatorId,
      siweVerified: false,
      delegatingScopes: parseStoredScopes(decision.caller.scopes),
      // Never outlive the delegating key (R4): a short-lived key must not
      // mint a permanent one. "" counts as no expiry, as in the auth check.
      delegatingNotAfter: decision.caller.expiresAt || null,
    };
  }
  return { ...selected, delegatingScopes: null, delegatingNotAfter: null };
}
