import { randomBytes } from "node:crypto";
import { getAddress, recoverMessageAddress } from "viem";
import { sql } from "@pcc/store";
import {
  canonicalize,
  isValidKernelId,
  type KernelRegistrationChallengeInput,
  type KernelRegistrationChallenge,
  type KernelRegistrationProof,
  type RegisteredSigner,
} from "@pcc/spec";
import { getStore } from "../db.js";
import { normalizePublicKeyHex, verifyEd25519Signature } from "./ed25519.js";
import { resolveBundlerConfig } from "../config/bundler-config.js";
import { walletLinkConfig } from "../services/wallet-links/config.js";
import type { KernelAuthority } from "./kernel-authority.js";

const TTL_MS = 10 * 60 * 1000;
const OPEN_CHALLENGE_LIMIT = 5;

interface ChallengeRow {
  id: string;
  kernel_id: string;
  algorithm: "ed25519" | "secp256k1";
  signer: string;
  nonce: string;
  env: string;
  chain_id: number;
  domain: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  created_by_key_id: string | null;
  created_by_session_identity: string | null;
  message: string;
}

/** Only the exact opt-in enables static registration proofs. */
export function legacySigningProofAllowed(): boolean {
  return process.env.PCC_KERNEL_LEGACY_SIGNING_PROOF === "allow";
}

function registrationContext() {
  const { domain, publicOrigin, env } = walletLinkConfig();
  const chainId = process.env.PCC_CHAIN_ID === undefined
    ? resolveBundlerConfig().chainId
    : Number(process.env.PCC_CHAIN_ID);
  if (!domain || !Number.isSafeInteger(chainId) || chainId <= 0 || !/^[a-zA-Z0-9_-]+$/.test(env)) {
    throw new Error("Invalid kernel registration context configuration");
  }
  return { domain, publicOrigin, chainId, env };
}

export function registrationProofRefusal(): Error {
  return Object.assign(new Error("Kernel registration proof is invalid, expired, or already consumed"), {
    name: "ForbiddenError",
  });
}

export function normalizeRegistrationSigner(input: unknown): RegisteredSigner | null {
  if (!input || typeof input !== "object") return null;
  const signer = input as Record<string, unknown>;
  if (signer.algorithm === "ed25519" && typeof signer.publicKey === "string") {
    const key = normalizePublicKeyHex(signer.publicKey);
    return key ? { algorithm: "ed25519", publicKey: `0x${key}` } : null;
  }
  if (signer.algorithm === "secp256k1" && typeof signer.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(signer.address)) {
    return { algorithm: "secp256k1", address: getAddress(signer.address.toLowerCase()) };
  }
  return null;
}

const signerValue = (signer: RegisteredSigner) => signer.algorithm === "ed25519" ? signer.publicKey : signer.address;

export function issueKernelRegistrationChallenge(
  input: KernelRegistrationChallengeInput,
  authority: KernelAuthority,
): KernelRegistrationChallenge {
  const signer = normalizeRegistrationSigner(input?.signer);
  if (!signer || !isValidKernelId(input?.kernelId)) {
    throw Object.assign(new Error("A kernelId and a valid Ed25519 public key or secp256k1 address are required"), {
      name: "BadRequestError",
    });
  }
  const { domain, publicOrigin, chainId, env } = registrationContext();
  const createdByKeyId = authority.apiKeyId ?? null;
  const sessionIdentity = authority.sessionIdentity ?? null;
  if (!createdByKeyId && !sessionIdentity) throw registrationProofRefusal();
  const challengeId = randomBytes(32).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + TTL_MS).toISOString();
  const kernelId = input.kernelId;
  const message = signer.algorithm === "secp256k1"
    ? `${domain} wants you to sign in with your Ethereum account:\n${signer.address}\n\n` +
      `Register this key as the signing key of PCC kernel ${kernelId}. Consent: kernel-registration v1.\n\n` +
      `URI: ${publicOrigin}/kernels/register\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\n` +
      `Issued At: ${issuedAt}\nExpiration Time: ${expiresAt}\nRequest ID: ${challengeId}\nResources:\n` +
      `- urn:pcc:kernel-registration:${challengeId}\n- urn:pcc:kernel:${encodeURIComponent(kernelId)}\n- urn:pcc:env:${env}`
    : Buffer.from("PCC-KERNEL-REG-V1\n" + canonicalize({
      challengeId, kernelId, nonce, env, chainId, domain, issuedAt, expiresAt, publicKey: signer.publicKey,
    }), "utf8").toString("base64");

  const db = getStore().db;
  const issued = db.transaction(() => {
    db.run(sql`DELETE FROM kernel_registration_challenges WHERE expires_at <= ${issuedAt}`);
    const principalCount = db.get<{ count: number }>(sql`SELECT count(*) AS count FROM kernel_registration_challenges
      WHERE consumed_at IS NULL AND expires_at > ${issuedAt} AND
        ((${createdByKeyId} IS NOT NULL AND created_by_key_id = ${createdByKeyId}) OR
         (${createdByKeyId} IS NULL AND created_by_session_identity = ${sessionIdentity}))`)!.count;
    if (principalCount >= OPEN_CHALLENGE_LIMIT) {
      return false;
    }
    db.run(sql`INSERT INTO kernel_registration_challenges
      (id, kernel_id, algorithm, signer, created_by_key_id, created_by_session_identity, nonce, env, chain_id, domain, issued_at, expires_at, message)
      VALUES (${challengeId}, ${kernelId}, ${signer.algorithm}, ${signerValue(signer)}, ${createdByKeyId}, ${sessionIdentity},
        ${nonce}, ${env}, ${chainId}, ${domain}, ${issuedAt}, ${expiresAt}, ${message})`);
    return true;
  });
  if (!issued) {
    throw Object.assign(new Error("Too many open kernel registration challenges"), { name: "RegistrationChallengeLimitError" });
  }
  return { challengeId, message, expiresAt };
}

/** Verify issuer, context and signature; the caller must burn before the action transaction. */
export async function verifyKernelRegistrationProof(
  kernelId: string,
  signer: RegisteredSigner | null,
  proof: KernelRegistrationProof,
  authority: KernelAuthority,
): Promise<() => void> {
  if (!signer || !proof || typeof proof.challengeId !== "string" || typeof proof.signature !== "string") {
    throw registrationProofRefusal();
  }
  const row = getStore().db.get<ChallengeRow>(sql`SELECT * FROM kernel_registration_challenges WHERE id = ${proof.challengeId}`);
  if (!row) throw registrationProofRefusal();
  const issuedToCaller = row.created_by_key_id !== null
    ? row.created_by_key_id === authority.apiKeyId
    : row.created_by_session_identity !== null && row.created_by_session_identity === authority.sessionIdentity;
  if (!authority.admin && !issuedToCaller) throw registrationProofRefusal();
  const { env, chainId, domain } = registrationContext();
  if (row.kernel_id !== kernelId) throw registrationProofRefusal();
  if (row.algorithm !== signer.algorithm || row.signer.toLowerCase() !== signerValue(signer).toLowerCase()) throw registrationProofRefusal();
  if (row.env !== env) throw registrationProofRefusal();
  if (row.chain_id !== chainId || row.domain !== domain) throw registrationProofRefusal();

  const checkFreshness = () => {
    const now = Date.now();
    const issued = Date.parse(row.issued_at);
    const expires = Date.parse(row.expires_at);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now ||
        now - issued > TTL_MS || expires <= now || expires - issued > TTL_MS || expires <= issued) {
      throw registrationProofRefusal();
    }
  };
  checkFreshness();
  let valid = false;
  if (row.algorithm === "ed25519") {
    valid = verifyEd25519Signature(row.signer, Buffer.from(row.message, "base64"), proof.signature);
  } else {
    try {
      const recovered = await recoverMessageAddress({ message: row.message, signature: proof.signature as `0x${string}` });
      valid = recovered.toLowerCase() === row.signer.toLowerCase();
    } catch {
      valid = false;
    }
  }
  if (!valid) throw registrationProofRefusal();

  return () => {
    checkFreshness();
    const consumed = getStore().db.run(sql`UPDATE kernel_registration_challenges SET consumed_at = ${new Date().toISOString()}
      WHERE id = ${row.id} AND consumed_at IS NULL`).changes;
    if (consumed !== 1) throw registrationProofRefusal();
  };
}
