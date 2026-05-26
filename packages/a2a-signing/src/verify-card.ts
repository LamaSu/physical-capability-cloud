/**
 * Verify an A2A v1.0 signed Agent Card.
 *
 * Steps (per spec §8.4):
 *  1. Pluck `signatures[0]` from the card.
 *  2. Re-canonicalize the rest of the body using JCS.
 *  3. Decode the protected header to extract `kid` and `jku`.
 *  4. Fetch JWKS from `jku` (or use a caller-supplied JWKS / key).
 *  5. Verify the JWS using the key whose `kid` matches.
 *
 * Returns `{valid, card?, error?}`. `card` is the verified body (with
 * `signatures` stripped). `error` carries a short reason on failure.
 */

import * as canonicalizeModule from "canonicalize";
import { compactVerify, importJWK, type JWK, type KeyLike } from "jose";
import type { SignedAgentCard } from "./sign-card.js";

const canonicalize = (canonicalizeModule as unknown as {
  default: (input: unknown) => string | undefined;
}).default;

export interface VerifyResult {
  valid: boolean;
  /** Verified card body (signatures stripped). Present only when valid. */
  card?: Record<string, unknown>;
  /** Short reason on failure. */
  error?: string;
  /** kid resolved from the protected header (for diagnostics). */
  kid?: string;
}

export interface VerifyOptions {
  /**
   * Either:
   *   - `jwksUrl` — fetch JWKS over HTTP (verify-time), OR
   *   - `jwks` — caller-supplied JWKS document (no fetch), OR
   *   - `key` — caller-supplied KeyLike (skip JWKS resolution entirely).
   *
   * `key` takes precedence over `jwks` takes precedence over `jwksUrl`.
   */
  jwksUrl?: string;
  jwks?: { keys: Array<Record<string, unknown>> };
  key?: KeyLike;

  /** Override the global fetch (testing). */
  fetchImpl?: typeof fetch;
}

interface ProtectedHeader {
  alg?: string;
  kid?: string;
  jku?: string;
  typ?: string;
  [k: string]: unknown;
}

/**
 * Verify a signed agent card. Pure function — no I/O unless `jwksUrl` is
 * supplied (in which case it fetches).
 */
export async function verifyAgentCard(
  signedCard: SignedAgentCard | Record<string, unknown>,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const signatures = (signedCard as SignedAgentCard).signatures;
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return { valid: false, error: "no_signature" };
  }

  const sig = signatures[0];
  if (!sig || typeof sig.protected !== "string" || typeof sig.signature !== "string") {
    return { valid: false, error: "malformed_signature" };
  }

  let header: ProtectedHeader;
  try {
    const headerJson = Buffer.from(sig.protected, "base64url").toString("utf-8");
    header = JSON.parse(headerJson) as ProtectedHeader;
  } catch (err) {
    return { valid: false, error: `header_decode_failed: ${(err as Error).message}` };
  }

  if (header.alg !== "ES256") {
    return { valid: false, error: `unsupported_alg: ${header.alg}` };
  }

  // Re-canonicalize the body (everything except signatures).
  const { signatures: _ignored, ...body } = signedCard as Record<string, unknown>;
  const canonical = canonicalize(body);
  if (canonical === undefined) {
    return { valid: false, error: "canonicalize_failed" };
  }
  const payloadB64 = Buffer.from(canonical, "utf-8").toString("base64url");

  // Reconstruct the JWS Compact: protected.payload.signature
  const jws = `${sig.protected}.${payloadB64}.${sig.signature}`;

  // Resolve the verification key.
  const keyResult = await resolveKey(header, options);
  if (!keyResult.ok) {
    return { valid: false, error: keyResult.error, kid: header.kid };
  }

  try {
    await compactVerify(jws, keyResult.key, { algorithms: ["ES256"] });
  } catch (err) {
    return {
      valid: false,
      error: `verify_failed: ${(err as Error).message}`,
      kid: header.kid,
    };
  }

  return { valid: true, card: body, kid: header.kid };
}

type KeyResolveResult =
  | { ok: true; key: KeyLike }
  | { ok: false; error: string };

async function resolveKey(
  header: ProtectedHeader,
  options: VerifyOptions,
): Promise<KeyResolveResult> {
  if (options.key) return { ok: true, key: options.key };

  let jwks = options.jwks;
  if (!jwks) {
    const url = options.jwksUrl ?? header.jku;
    if (!url) {
      return { ok: false, error: "no_jwks_source" };
    }
    try {
      const f = options.fetchImpl ?? fetch;
      const res = await f(url);
      if (!res.ok) {
        return { ok: false, error: `jwks_fetch_http_${res.status}` };
      }
      jwks = (await res.json()) as { keys: Array<Record<string, unknown>> };
    } catch (err) {
      return { ok: false, error: `jwks_fetch_failed: ${(err as Error).message}` };
    }
  }

  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    return { ok: false, error: "jwks_empty" };
  }

  // Find matching kid. If header.kid is undefined, fall back to first key.
  const match = header.kid
    ? jwks.keys.find((k) => (k as { kid?: string }).kid === header.kid)
    : jwks.keys[0];
  if (!match) {
    return { ok: false, error: `kid_not_in_jwks: ${header.kid}` };
  }

  try {
    const key = (await importJWK(match as unknown as JWK, "ES256")) as KeyLike;
    return { ok: true, key };
  } catch (err) {
    return { ok: false, error: `jwk_import_failed: ${(err as Error).message}` };
  }
}
