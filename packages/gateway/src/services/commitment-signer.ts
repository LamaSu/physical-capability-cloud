/**
 * Shipment-commitment signer — turns a ShipmentCommitment from "a hash this
 * gateway computed" into "a binding this gateway ATTESTED to, before
 * execution", by signing canonicalize(body) with the gateway's ES256 key.
 *
 * Reuses the A2A agent-card signing key (PCC_AGENT_CARD_SIGNING_KEY, loaded
 * once at boot by signing-key.ts) and the same JWS shape verifiers already
 * handle for agent cards — but with its own `typ`, so a commitment can never
 * be mistaken for a signed agent card (or vice versa). The public key is
 * served from the gateway JWKS route; `kid` selects it.
 *
 * Verification (for the oracle/verifier lanes): JWS payload = UTF-8 bytes of
 * canonicalize(body) where body = commitment minus {hash, signature};
 * sha256(payload) must equal commitment.hash; the JWS must verify against
 * the JWKS key with matching kid; protected header typ must be
 * COMMITMENT_JWS_TYP. sol #297 finding 1.
 */

import { CompactSign, type KeyLike } from "jose";
import { canonicalize } from "@pcc/spec";
import { getActiveSigningKey } from "../signing-key.js";
import type { CommitmentSigner, CommitmentSignature, ShipmentCommitmentBody } from "./easypost-client.js";

export const COMMITMENT_JWS_TYP = "vnd.pcc.shipment-commitment+jws";

export interface CommitmentSigningKey {
  privateKey: KeyLike;
  kid: string;
  alg: string;
}

/** Build a signer bound to a specific key (tests inject a generated key). */
export function createCommitmentSigner(key: CommitmentSigningKey): CommitmentSigner {
  return async (body: ShipmentCommitmentBody, _hash: string): Promise<CommitmentSignature> => {
    const payload = new TextEncoder().encode(canonicalize(body));
    const jws = await new CompactSign(payload)
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: COMMITMENT_JWS_TYP })
      .sign(key.privateKey);
    return { alg: key.alg, kid: key.kid, jws };
  };
}

/**
 * Signer backed by the gateway's boot-loaded key. Resolves the key lazily on
 * every call so the order of initSigningKey() vs client construction does not
 * matter; returns null (unsigned commitment) when no key is configured —
 * `commitment.signature === null` is the honest, visible state, never a
 * fake signature.
 */
export const gatewayCommitmentSigner: CommitmentSigner = async (body, hash) => {
  const key = getActiveSigningKey();
  if (!key) return null;
  return createCommitmentSigner({ privateKey: key.privateKey, kid: key.kid, alg: key.alg })(body, hash);
};
