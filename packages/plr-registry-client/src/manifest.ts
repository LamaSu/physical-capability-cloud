/**
 * EIP-712 signing + verification for BackendManifest documents.
 *
 * Uses viem's typed-data helpers so any wallet that supports
 * `signTypedData` (MetaMask, Rabby, Frame, Privy, Coinbase Smart Wallet,
 * Gnosis Safe via Safe Apps SDK) can sign with one click.
 */

import {
  hashTypedData,
  recoverTypedDataAddress,
  isAddressEqual,
  type Address,
} from "viem";
import {
  BACKEND_MANIFEST_EIP712_TYPES,
  type BackendManifest,
  type SignedBackendManifest,
} from "@pcc/spec";

/**
 * EIP-712 domain inputs for the registry. Pass the chainId + the deployed
 * PLRBackendRegistry address (or address(0) for off-chain-only testing).
 */
export interface RegistryEip712Domain {
  chainId: number;
  verifyingContract: Address;
}

/**
 * Minimal interface a signer must satisfy. Most wallet adapters (viem's
 * WalletClient, ethers Signer, MetaMask provider) wrap a method shaped
 * roughly like this.
 *
 * @returns 0x-prefixed hex signature (65 bytes for ECDSA recoverable).
 */
export interface SignerLike {
  signTypedData(args: {
    domain: ReturnType<typeof toViemDomain>;
    types: typeof BACKEND_MANIFEST_EIP712_TYPES;
    primaryType: "BackendManifest";
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

/**
 * Internal helper — convert our domain inputs to viem's TypedDataDomain
 * shape with the fixed name + version constants.
 */
function toViemDomain(d: RegistryEip712Domain) {
  return {
    name: "PCC-PLRBackendRegistry" as const,
    version: "1" as const,
    chainId: d.chainId,
    verifyingContract: d.verifyingContract,
  };
}

/**
 * Reshape a BackendManifest into the wire format the EIP-712 types expect.
 * Optional fields (name, handle, role on each author; delegatedAgentId,
 * notes on the manifest) are emitted as empty strings / zero hashes so
 * the encoded structure remains stable regardless of which fields the
 * author populated.
 */
export function prepareEip712Payload(
  manifest: BackendManifest,
): Record<string, unknown> {
  const ZERO_BYTES32: `0x${string}` = `0x${"0".repeat(64)}`;
  return {
    schemaVersion: manifest.schemaVersion,
    plrModulePath: manifest.plrModulePath,
    plrVersionRange: manifest.plrVersionRange,
    className: manifest.className,
    authors: manifest.authors.map((a) => ({
      address: a.address as Address,
      groupBps: a.groupBps,
      name: a.name ?? "",
      handle: a.handle ?? "",
      role: a.role ?? "",
    })),
    rateScheduleHash: manifest.rateScheduleHash as `0x${string}`,
    delegatedAgentId: (manifest.delegatedAgentId ?? ZERO_BYTES32) as `0x${string}`,
    license: manifest.license,
    notes: manifest.notes ?? "",
    issuedAt: manifest.issuedAt,
  };
}

/**
 * Compute the EIP-712 typed-data digest of a manifest. Useful for
 * deterministic equality testing without going through a signer.
 */
export function backendManifestDigest(
  manifest: BackendManifest,
  domain: RegistryEip712Domain,
): `0x${string}` {
  return hashTypedData({
    domain: toViemDomain(domain),
    types: BACKEND_MANIFEST_EIP712_TYPES,
    primaryType: "BackendManifest",
    message: prepareEip712Payload(manifest),
  });
}

/**
 * Sign a manifest via EIP-712 typed-data. The signer's address MUST be
 * `manifest.authors[0].address`; this is enforced before invoking the
 * signer (no point making the wallet pop up if we'd reject the result).
 */
export async function signBackendManifest(
  manifest: BackendManifest,
  signer: SignerLike,
  domain: RegistryEip712Domain,
  expectedSignerAddress?: Address,
): Promise<SignedBackendManifest> {
  if (manifest.authors.length === 0) {
    throw new Error("signBackendManifest: manifest has no authors");
  }
  const primaryAuthor = manifest.authors[0].address as Address;
  if (
    expectedSignerAddress &&
    !isAddressEqual(expectedSignerAddress, primaryAuthor)
  ) {
    throw new Error(
      `signBackendManifest: expected signer ${expectedSignerAddress} != authors[0] ${primaryAuthor}`,
    );
  }

  const signature = await signer.signTypedData({
    domain: toViemDomain(domain),
    types: BACKEND_MANIFEST_EIP712_TYPES,
    primaryType: "BackendManifest",
    message: prepareEip712Payload(manifest),
  });

  return {
    manifest,
    signature,
    signerAddress: primaryAuthor,
  };
}

/**
 * Recover the signer of a SignedBackendManifest and verify it matches
 * `manifest.authors[0].address`. Returns the validity + recovered address.
 */
export async function verifyBackendManifest(
  signed: SignedBackendManifest,
  domain: RegistryEip712Domain,
): Promise<{ valid: boolean; recovered: Address; reason?: string }> {
  const primaryAuthor = signed.manifest.authors[0]?.address as Address;
  if (!primaryAuthor) {
    return {
      valid: false,
      recovered: "0x0000000000000000000000000000000000000000",
      reason: "manifest has no authors",
    };
  }

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: toViemDomain(domain),
      types: BACKEND_MANIFEST_EIP712_TYPES,
      primaryType: "BackendManifest",
      message: prepareEip712Payload(signed.manifest),
      signature: signed.signature as `0x${string}`,
    });
  } catch (err) {
    return {
      valid: false,
      recovered: "0x0000000000000000000000000000000000000000",
      reason: `signature recovery failed: ${(err as Error).message}`,
    };
  }

  const valid = isAddressEqual(recovered, primaryAuthor);
  return {
    valid,
    recovered,
    reason: valid ? undefined : `recovered ${recovered} != authors[0] ${primaryAuthor}`,
  };
}
