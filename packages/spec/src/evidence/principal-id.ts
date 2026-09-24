/**
 * Principal ids for FinalMilestonePackageV2 (`pcc.evidence.principal-id.v1`).
 *
 * The package names who stands behind a milestone with two ids, and each id is
 * bound to a signature the verifier already checks, so a principal id is never
 * a free-text claim:
 *
 *   operatorPrincipalId = "eip155:<chainId>:0x<40 lowercase hex>"   (CAIP-10)
 *       The D1 (secp256k1 EIP-712) signer's address on the unit's chain. Its
 *       address part must equal the D1 signature entry's signer.
 *   devicePrincipalId   = "ed25519:0x<64 lowercase hex>"
 *       The Ed25519 key of the device or node that signs the evidence. Its key
 *       part must equal the D2 signature entry's signer, and the kernel
 *       registry row for the producing kernel must hold that key.
 *
 * Both forms are lowercase-pinned, so the package digest never drifts on hex
 * case. The registry stores Ed25519 keys as 0x + lowercase hex (matching the
 * device form byte for byte) but secp256k1 addresses EIP-55 checksummed, so
 * compare a registry signer only through `principalFromRegistry`, never raw.
 * The same CAIP-10 form is the owner-address form key bindings use (N2): there
 * is one form, not two.
 *
 * An Ed25519 key whose secret half was published is never a device principal:
 * anyone can sign as it (N35). `COMPROMISED_DEVICE_PUBLIC_KEYS` lists them.
 */

import { normalizeRegisteredSigner } from "./verifiers/registered-signer.js";

export const PRINCIPAL_ID_CONTRACT = "pcc.evidence.principal-id.v1";

export const OPERATOR_PRINCIPAL_ID_PATTERN = /^eip155:([1-9][0-9]*):0x([0-9a-f]{40})$/;
export const DEVICE_PRINCIPAL_ID_PATTERN = /^ed25519:0x([0-9a-f]{64})$/;

/**
 * Ed25519 public keys (0x + lowercase hex) whose secret halves are public, so
 * no signature by them proves anything:
 *   - the pcc-node key pair committed to the public repository (N35).
 */
export const COMPROMISED_DEVICE_PUBLIC_KEYS: ReadonlySet<string> = new Set([
  "0x4145722275a24983ebda639a0cc0bcda8072eed3a6cf38b56135859a56c51d36",
]);

export class PrincipalIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrincipalIdError";
  }
}

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;

/** True when the key (any hex case, 0x optional) is one whose secret was published. */
export function isCompromisedDevicePublicKey(publicKey: unknown): boolean {
  if (typeof publicKey !== "string" || !HEX64.test(publicKey)) return false;
  return COMPROMISED_DEVICE_PUBLIC_KEYS.has("0x" + publicKey.replace(/^0x/, "").toLowerCase());
}

/** `eip155:<chainId>:0x<address, lowercased>`. Throws on a malformed chain or address. */
export function formatOperatorPrincipalId(chainId: number, address: string): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new PrincipalIdError(`chainId must be a positive integer, got ${String(chainId)}`);
  }
  if (typeof address !== "string" || !HEX40.test(address)) {
    throw new PrincipalIdError("address must be 0x + 40 hex characters");
  }
  return `eip155:${chainId}:${address.toLowerCase()}`;
}

/** `ed25519:0x<key, lowercased>`. Throws on a malformed or compromised key. */
export function formatDevicePrincipalId(publicKey: string): string {
  if (typeof publicKey !== "string" || !HEX64.test(publicKey)) {
    throw new PrincipalIdError("publicKey must be 64 hex characters, 0x optional");
  }
  if (isCompromisedDevicePublicKey(publicKey)) {
    throw new PrincipalIdError("this Ed25519 key's secret half is public; it cannot be a device principal");
  }
  return `ed25519:0x${publicKey.replace(/^0x/, "").toLowerCase()}`;
}

/** The parts of an operator principal id, or null unless it is exactly the pinned form. */
export function parseOperatorPrincipalId(id: unknown): { chainId: number; address: `0x${string}` } | null {
  if (typeof id !== "string") return null;
  const m = OPERATOR_PRINCIPAL_ID_PATTERN.exec(id);
  if (!m) return null;
  const chainId = Number(m[1]);
  if (!Number.isSafeInteger(chainId)) return null;
  return { chainId, address: `0x${m[2]}` };
}

/** The key of a device principal id, or null unless it is exactly the pinned form. */
export function parseDevicePrincipalId(id: unknown): { publicKey: `0x${string}` } | null {
  if (typeof id !== "string") return null;
  const m = DEVICE_PRINCIPAL_ID_PATTERN.exec(id);
  return m ? { publicKey: `0x${m[1]}` } : null;
}

/**
 * D1 binding: the operator principal id is well formed, on `chainId` when one
 * is given, and its address is the D1 signer's (the signer in any hex case).
 */
export function operatorPrincipalMatchesSigner(id: unknown, d1Signer: unknown, chainId?: number): boolean {
  const parsed = parseOperatorPrincipalId(id);
  if (!parsed || typeof d1Signer !== "string" || !HEX40.test(d1Signer)) return false;
  if (chainId !== undefined && parsed.chainId !== chainId) return false;
  return parsed.address === d1Signer.toLowerCase();
}

/**
 * D2 binding: the device principal id is well formed, its key is the D2 signer
 * (the signer in any hex case, 0x optional), and that key is not compromised.
 */
export function devicePrincipalMatchesSigner(id: unknown, d2Signer: unknown): boolean {
  const parsed = parseDevicePrincipalId(id);
  if (!parsed || typeof d2Signer !== "string" || !HEX64.test(d2Signer)) return false;
  if (isCompromisedDevicePublicKey(parsed.publicKey)) return false;
  return parsed.publicKey === "0x" + d2Signer.replace(/^0x/, "").toLowerCase();
}

/**
 * The principal id a kernel registry signer stands for, or null: an Ed25519
 * key gives its device principal (null when compromised), and a secp256k1
 * address gives its operator principal on `chainId`, with the registry's
 * EIP-55 checksum lowercased. Compare registry signers through this, never raw.
 */
export function principalFromRegistry(signer: unknown, chainId: number): string | null {
  const normalized = normalizeRegisteredSigner(signer);
  if (!normalized) return null;
  try {
    return normalized.algorithm === "ed25519"
      ? formatDevicePrincipalId(normalized.publicKey)
      : formatOperatorPrincipalId(chainId, normalized.address);
  } catch {
    return null;
  }
}
