import { createPublicKey, verify } from "node:crypto";
import { canonicalize } from "@pcc/spec";
import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { CONSENT_SHA256, CONSENT_VERSION } from "./consent.js";
import type { WalletLinkConfig } from "./config.js";

/** Internal stored fields used to construct and recheck the signed bytes. */
export interface WalletLinkMessageRequest {
  id: string;
  key_type: "secp256k1" | "ed25519";
  address_or_pubkey: string;
  role: "agent" | "device";
  label: string;
  kernel_id?: string | null;
  chain_id: number;
  env: string;
  domain: string;
  nonce: string;
  created_at: string;
  expires_at: string;
  consent_version: string;
  consent_sha256: string;
}

export function composeProofMessage(request: WalletLinkMessageRequest, config: WalletLinkConfig): string {
  if (request.key_type === "secp256k1") {
    return createSiweMessage({
      domain: request.domain,
      address: getAddress(request.address_or_pubkey),
      statement: `Link this key to PCC as an ${request.role} ("${request.label}"). PCC never holds this key. Consent: wallet-link v1.`,
      uri: config.uri,
      version: "1",
      chainId: request.chain_id,
      nonce: request.nonce,
      issuedAt: new Date(request.created_at),
      expirationTime: new Date(request.expires_at),
      requestId: request.id,
      resources: [
        `urn:pcc:link-request:${request.id}`,
        `urn:pcc:env:${request.env}`,
        `urn:pcc:role:${request.role}`,
        `urn:pcc:consent:${request.consent_version}:sha256:${request.consent_sha256}`,
      ],
    });
  }
  return "PCC-LINK-V1\n" + canonicalize({
    chainId: request.chain_id,
    consent: `${request.consent_version}:sha256:${request.consent_sha256}`,
    domain: request.domain,
    env: request.env,
    expirationTime: request.expires_at,
    issuedAt: request.created_at,
    ...(request.kernel_id ? { kernelId: request.kernel_id } : {}),
    label: request.label,
    nonce: request.nonce,
    publicKey: request.address_or_pubkey,
    requestId: request.id,
    role: request.role,
    uri: config.uri,
  });
}

export async function verifyProofMessage(
  request: WalletLinkMessageRequest & { message: string },
  signature: string,
  config: WalletLinkConfig,
  now = Date.now(),
): Promise<boolean> {
  try {
    if (request.domain !== config.domain) return false;
    if (request.env !== config.env) return false;
    if (!config.allowedChainIds.includes(request.chain_id)) return false;
    if (request.consent_version !== CONSENT_VERSION || request.consent_sha256 !== CONSENT_SHA256) return false;
    const issuedAt = Date.parse(request.created_at);
    const expiresAt = Date.parse(request.expires_at);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now || now - issuedAt > 600_000 || expiresAt <= now) return false;
    if (request.message !== composeProofMessage(request, config)) return false;
    if (request.key_type === "secp256k1") {
      if (!/^0x(?:[0-9a-fA-F]{130}|[0-9a-fA-F]{128})$/.test(signature)) return false;
      const signer = await recoverMessageAddress({ message: request.message, signature: signature as Hex });
      return signer.toLowerCase() === request.address_or_pubkey.toLowerCase();
    }
    if (!/^[0-9a-f]{64}$/.test(request.address_or_pubkey) || !/^[0-9a-fA-F]{128}$/.test(signature)) return false;
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(request.address_or_pubkey, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(request.message, "utf8"), key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}
