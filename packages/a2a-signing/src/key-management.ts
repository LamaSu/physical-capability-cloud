/**
 * Key management for A2A signed agent cards.
 *
 * - Loads ES256 (P-256) signing key from env: `PCC_AGENT_CARD_SIGNING_KEY`
 *   (PEM-encoded private key).
 * - kid (key id) from env: `PCC_AGENT_CARD_SIGNING_KID` (default
 *   `pcc-2026-q2`).
 * - Builds a JWKS document for the public verification endpoint.
 *
 * Generation (one-time, during deploy bootstrap):
 *   openssl ecparam -name prime256v1 -genkey -noout -out card-sk.pem
 *   openssl ec -in card-sk.pem -pubout -out card-pk.pem
 * PEM contents go into Railway env vars; never on disk in prod.
 */

import { importPKCS8, importSPKI, exportJWK, type KeyLike } from "jose";

export const DEFAULT_KID = "pcc-2026-q2";
export const DEFAULT_ALG = "ES256";

export interface LoadedSigningKey {
  /** Private key for signing. */
  privateKey: KeyLike;
  /** Matching public key (derived) for serving in JWKS. */
  publicKey: KeyLike;
  /** Key identifier — embedded in JWS `kid` header. */
  kid: string;
  /** Signature algorithm — always ES256 for v1. */
  alg: string;
}

/**
 * Load the signing key from environment.
 *
 * Returns `null` if `PCC_AGENT_CARD_SIGNING_KEY` is unset — callers
 * should serve the unsigned card in that case (backwards compat).
 *
 * Throws if the env var is set but the PEM is malformed.
 */
export async function loadSigningKey(): Promise<LoadedSigningKey | null> {
  const pem = process.env.PCC_AGENT_CARD_SIGNING_KEY;
  if (!pem || pem.trim().length === 0) {
    return null;
  }

  const kid = process.env.PCC_AGENT_CARD_SIGNING_KID ?? DEFAULT_KID;

  // Accept either PKCS#8 private (BEGIN PRIVATE KEY) or EC SEC1 (BEGIN EC
  // PRIVATE KEY). jose's importPKCS8 expects PKCS#8 — if we got SEC1, we
  // need to convert. We attempt PKCS#8 first; if it fails and the PEM
  // looks like SEC1, raise a clearer error.
  const normalized = normalizePem(pem);

  let privateKey: KeyLike;
  try {
    privateKey = await importPKCS8(normalized, DEFAULT_ALG, {
      extractable: true,
    });
  } catch (err) {
    if (normalized.includes("BEGIN EC PRIVATE KEY")) {
      throw new Error(
        "PCC_AGENT_CARD_SIGNING_KEY appears to be SEC1 (BEGIN EC PRIVATE KEY). " +
          "Convert to PKCS#8 with: openssl pkcs8 -topk8 -nocrypt -in sec1.pem -out pkcs8.pem",
      );
    }
    throw new Error(
      `Failed to import PCC_AGENT_CARD_SIGNING_KEY as PKCS#8 ES256: ${(err as Error).message}`,
    );
  }

  // Derive the public key by exporting the private key as JWK, stripping
  // the private component `d`, then re-importing as SPKI. This avoids
  // requiring the operator to supply a separate public key env var.
  const privJwk = await exportJWK(privateKey);
  const pubJwk = { ...privJwk };
  delete (pubJwk as Record<string, unknown>).d;
  // exportJWK on a private key returns the curve params (x, y, crv, kty)
  // which is exactly what we need for the public key.
  const { importJWK } = await import("jose");
  const publicKey = (await importJWK(pubJwk, DEFAULT_ALG)) as KeyLike;

  return { privateKey, publicKey, kid, alg: DEFAULT_ALG };
}

/**
 * Build a JWKS document containing the active public key.
 *
 * Old (rotated-out) keys can be added via a rotation registry file in a
 * future iteration; for v1 we serve only the active key.
 */
export async function generateJWKS(
  publicKey: KeyLike,
  kid: string,
): Promise<{ keys: Array<Record<string, unknown>> }> {
  const jwk = await exportJWK(publicKey);
  return {
    keys: [
      {
        ...jwk,
        kid,
        use: "sig",
        alg: DEFAULT_ALG,
      },
    ],
  };
}

/**
 * Normalize a PEM string: handle escaped newlines from env vars,
 * trim whitespace, ensure final newline.
 */
function normalizePem(pem: string): string {
  // Railway / Docker often store multi-line strings with literal "\n"
  // sequences instead of real newlines. Convert.
  let s = pem.replace(/\\n/g, "\n").trim();
  if (!s.endsWith("\n")) s += "\n";
  return s;
}
