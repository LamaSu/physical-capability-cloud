/**
 * Shared admin-SECRET check: `X-Admin-Key` must equal `PCC_ADMIN_KEY`.
 *
 * Why a secret and not an identity (WP-A A8, MUST-CLOSE 9): the operatorId
 * allowlists (PCC_KEY_ADMINS and friends) authorize whoever's key carries a
 * listed operatorId — and a self-service email key could CLAIM any operatorId
 * (see auth/reserved-identities.ts). An admin secret is something a caller
 * holds, not something a caller says, so it cannot be spoofed that way.
 *
 * Properties:
 *   - Constant-time: both values are SHA-256'd to fixed-length digests, the
 *     lengths are checked, then `crypto.timingSafeEqual` compares them — so the
 *     comparison time reveals neither a matching prefix nor the secret's length.
 *   - Fail closed: an unset/blank PCC_ADMIN_KEY denies (503) UNLESS NODE_ENV is
 *     EXACTLY "test" or "development" — a missing, misspelled or "staging"
 *     NODE_ENV denies. A missing, empty, or repeated X-Admin-Key header is 401;
 *     a wrong one is 403.
 *   - The secret is never echoed, logged, or returned.
 *
 * Any route may use this. It is deliberately separate from routes/onboard.ts
 * (owned by another work package) and from kernel-marketplace.ts's older
 * inline check, which this does not change.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export const ADMIN_KEY_HEADER = "x-admin-key";

export type AdminKeyCheck =
  | { ok: true; mode: "key" | "dev-open" }
  | { ok: false; status: 401 | 403 | 503; error: string; message: string };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time equality of two secrets of any length. */
export function adminKeyMatches(provided: string, expected: string): boolean {
  const a = digest(provided);
  const b = digest(expected);
  if (a.length !== b.length) return false; // always 32 — checked, never assumed
  return timingSafeEqual(a, b);
}

/** Only these exact NODE_ENV values may run without a configured admin key. */
function devOpenAllowed(): boolean {
  const env = process.env.NODE_ENV;
  return env === "test" || env === "development";
}

export function checkAdminKey(req: FastifyRequest): AdminKeyCheck {
  const expected = process.env.PCC_ADMIN_KEY;
  if (typeof expected !== "string" || expected.trim().length === 0) {
    if (devOpenAllowed()) return { ok: true, mode: "dev-open" };
    return {
      ok: false,
      status: 503,
      error: "admin_key_unconfigured",
      message: "This admin endpoint is disabled: PCC_ADMIN_KEY is not configured.",
    };
  }

  const provided = req.headers[ADMIN_KEY_HEADER];
  // A repeated header arrives as an array: ambiguous input grants nothing.
  if (typeof provided !== "string" || provided.length === 0) {
    return {
      ok: false,
      status: 401,
      error: "admin_key_required",
      message: "This endpoint requires the X-Admin-Key header.",
    };
  }
  if (!adminKeyMatches(provided, expected)) {
    return {
      ok: false,
      status: 403,
      error: "admin_key_invalid",
      message: "X-Admin-Key is not valid.",
    };
  }
  return { ok: true, mode: "key" };
}

// ── Shared-token admin check (X-Admin-Token) — WP-A fold F7 ──────────
//
// routes/waitlist.ts and routes/feedback.ts gate their admin exports on
// `X-Admin-Token === WAITLIST_ADMIN_TOKEN`, and compared with `!==`: a
// short-circuiting string compare whose timing leaks how long a matching
// prefix is (and the secret's length). This keeps THOSE semantics exactly —
// same header, same env var, 403 on any failure, no dev-open mode — and only
// swaps the comparison for the constant-time one above.
//
// Fail closed, and slightly stricter than before: an unset, empty OR
// whitespace-only token denies (a blank env var used to match a blank-looking
// header); a missing, empty or repeated header denies.

export const ADMIN_TOKEN_HEADER = "x-admin-token";

/** True only when X-Admin-Token equals the configured token, compared in constant time. */
export function adminTokenMatches(req: FastifyRequest, envVar = "WAITLIST_ADMIN_TOKEN"): boolean {
  const expected = process.env[envVar];
  if (typeof expected !== "string" || expected.trim().length === 0) return false;
  const provided = req.headers[ADMIN_TOKEN_HEADER];
  // A repeated header arrives as an array: ambiguous input grants nothing.
  if (typeof provided !== "string" || provided.length === 0) return false;
  return adminKeyMatches(provided, expected);
}

// ── Admin reads with no development bypass (N48) ───────────────────────
//
// Some reads widen what a caller sees when X-Admin-Key is valid (for example every
// account's fiat-ramp sessions instead of the caller's own). There, an unset or blank
// PCC_ADMIN_KEY must grant nothing in ANY environment, so checkAdminKey's dev-open mode
// is deliberately not used. The comparison is adminKeyMatches (constant time, length
// hidden).

/** True only when PCC_ADMIN_KEY is set (not blank) and `provided` equals it. */
export function hasValidAdminKey(provided: unknown, expected: string | undefined = process.env.PCC_ADMIN_KEY): boolean {
  return (
    typeof expected === "string" &&
    expected.trim().length > 0 &&
    typeof provided === "string" &&
    provided.length > 0 &&
    adminKeyMatches(provided, expected)
  );
}
