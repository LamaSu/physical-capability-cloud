/**
 * Sign an A2A v1.0 Agent Card.
 *
 * Per A2A spec §4.4.7 + §8.4: a JWS signature over the JCS-canonicalized
 * (RFC 8785) card body. PCC uses ES256 (P-256 ECDSA).
 *
 * Output shape (JWS JSON Flattened embedded as `signatures[]`):
 *
 *     {
 *       ...existing card fields...,
 *       "signatures": [
 *         {
 *           "protected": "<base64url JOSE header>",
 *           "signature": "<base64url ES256 sig>"
 *         }
 *       ]
 *     }
 *
 * The `protected` header (decoded) contains `{alg, kid, typ, jwk-set-url}`.
 */

import canonicalize from "canonicalize";
import { CompactSign, type KeyLike } from "jose";

/** Generic agent card shape — accept any object. */
export type AgentCard = Record<string, unknown>;

export interface AgentCardSignature {
  /** base64url-encoded JOSE protected header */
  protected: string;
  /** base64url-encoded signature bytes */
  signature: string;
}

export interface SignedAgentCard extends Record<string, unknown> {
  signatures: AgentCardSignature[];
}

export interface SignCardOptions {
  /** Private key (P-256, alg=ES256). */
  privateKey: KeyLike;
  /** Key identifier — must match a `keys[]` entry in the served JWKS. */
  kid: string;
  /** Absolute URL to the verifier's JWKS endpoint. */
  jwksUrl: string;
}

/**
 * Sign an agent card. Returns the original card with a `signatures` array
 * appended (or replacing any pre-existing one).
 */
export async function signAgentCard(
  card: AgentCard,
  options: SignCardOptions,
): Promise<SignedAgentCard> {
  // Strip any pre-existing signatures from the body before canonicalization
  // (we sign the unsigned body, not "the card including any prior signature").
  const { signatures: _ignored, ...body } = card as Record<string, unknown>;

  const canonical = canonicalize(body);
  if (canonical === undefined) {
    throw new Error(
      "Failed to canonicalize agent card — card contains a value that JCS cannot serialize (likely undefined, function, or circular ref)",
    );
  }
  const payload = new TextEncoder().encode(canonical);

  const jws = await new CompactSign(payload)
    .setProtectedHeader({
      alg: "ES256",
      kid: options.kid,
      typ: "vnd.a2a.card+jws",
      // RFC 7515 reserved `jku` (JWK Set URL) is the canonical header for
      // pointing verifiers at the issuer's key set.
      jku: options.jwksUrl,
    })
    .sign(options.privateKey);

  // CompactSign yields `protectedHeader.payload.signature`; we drop the
  // payload because verifiers reconstruct it by re-canonicalizing the
  // card body.
  const [protectedHeader, , signature] = jws.split(".");

  return {
    ...body,
    signatures: [{ protected: protectedHeader, signature }],
  };
}
