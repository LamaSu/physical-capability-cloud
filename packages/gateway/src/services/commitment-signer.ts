/**
 * Shipment-commitment signer/verifier — turns a ShipmentCommitment from "a
 * hash this gateway computed" into "a binding this gateway ATTESTED to,
 * before execution", by signing canonicalize(body) with the gateway's ES256
 * key; and verifies such an attestation against the matching public key.
 *
 * Reuses the A2A agent-card signing key (PCC_AGENT_CARD_SIGNING_KEY, loaded
 * once at boot by signing-key.ts) and the same JWS shape verifiers already
 * handle for agent cards — but with its own `typ`, so a commitment can never
 * be mistaken for a signed agent card (or vice versa). The public key is
 * served from the gateway JWKS route; `kid` selects it.
 *
 * Verification rule (sol #297 round 2, NEW-8): a hash that recomputes is
 * NOT an attestation — anyone can recompute a hash over a modified body.
 * Only a JWS that verifies against the gateway's public key, with the
 * expected typ and kid, and whose payload equals canonicalize(body), proves
 * the gateway bound these fields before execution.
 */

import { CompactSign, compactVerify, type KeyLike } from "jose";
import { canonicalize } from "@pcc/spec";
import { getActiveSigningKey } from "../signing-key.js";
import type {
  CommitmentSigner,
  CommitmentSignature,
  ShipmentCommitment,
  ShipmentCommitmentBody,
} from "./easypost-client.js";

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
 * fake signature. Production boot refuses to run the carrier route without
 * a key (routes/carrier.ts), so a null signature only ever exists in dev/test.
 */
export const gatewayCommitmentSigner: CommitmentSigner = async (body, hash) => {
  const key = getActiveSigningKey();
  if (!key) return null;
  return createCommitmentSigner({ privateKey: key.privateKey, kid: key.kid, alg: key.alg })(body, hash);
};

export type CommitmentVerifyKeyResolver = (kid: string) => Promise<KeyLike | null> | KeyLike | null;

/**
 * Verifies a commitment's gateway attestation. True only if: a signature is
 * present, its kid resolves to a public key, the JWS verifies under ES256,
 * the protected header typ is COMMITMENT_JWS_TYP with the same kid, and the
 * signed payload is byte-equal to canonicalize(body) — i.e. the signature
 * covers exactly these fields. Never throws; any failure is `false`.
 */
export async function verifyCommitmentSignature(
  commitment: ShipmentCommitment,
  resolveKey: CommitmentVerifyKeyResolver,
): Promise<boolean> {
  try {
    const sig = commitment.signature;
    if (!sig || !sig.jws || !sig.kid) return false;
    const key = await resolveKey(sig.kid);
    if (!key) return false;
    const { payload, protectedHeader } = await compactVerify(sig.jws, key, { algorithms: ["ES256"] });
    if (protectedHeader.typ !== COMMITMENT_JWS_TYP) return false;
    if (protectedHeader.kid !== sig.kid) return false;
    const { hash: _h, signature: _s, ...body } = commitment;
    return new TextDecoder().decode(payload) === canonicalize(body);
  } catch {
    return false;
  }
}

/** Resolver for the gateway's own boot-loaded key (the only key we ever sign with). */
export const gatewayCommitmentKeyResolver: CommitmentVerifyKeyResolver = (kid) => {
  const key = getActiveSigningKey();
  if (!key || key.kid !== kid) return null;
  return key.publicKey;
};
