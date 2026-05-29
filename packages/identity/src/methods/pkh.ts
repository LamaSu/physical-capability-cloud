/**
 * did:pkh resolver — public-key-hash DIDs based on CAIP-10 account identifiers.
 *
 * Format: did:pkh:<caip-2-chain>:<account-address>
 *   e.g. did:pkh:eip155:8453:0x1234567890abcdef1234567890abcdef12345678
 *
 * CAIP-10: https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-10.md
 * did:pkh spec: https://w3c-ccg.github.io/did-method-pkh/
 */

import { isAddress, getAddress } from "viem";
import { parseDID } from "../did.js";
import {
  DIDResolutionError,
  type DIDDocument,
  type ParsedDID,
  type ResolverOptions,
  type VerificationMethod,
} from "../types.js";

/**
 * Per the did:pkh spec, each supported chain has a verification-method type.
 * eip155 = Ethereum + L2s (Base, Optimism, Arbitrum, ...).
 */
type SupportedNamespace = "eip155" | "bip122" | "solana" | "tezos";

interface ParsedPKH {
  namespace: SupportedNamespace;
  chainReference: string;
  address: string;
}

/**
 * Parse the method-specific-id of a did:pkh DID.
 *
 * Format: <namespace>:<chain-reference>:<address>
 * For eip155, address is checksummed if it was supplied checksummed.
 */
export function parsePKHIdentifier(methodSpecificId: string, did: string): ParsedPKH {
  const parts = methodSpecificId.split(":");
  if (parts.length !== 3) {
    throw new DIDResolutionError(
      `did:pkh method-specific-id must be <namespace>:<chain>:<address> — got "${methodSpecificId}"`,
      did,
      "invalidDid",
    );
  }
  const [namespace, chainReference, address] = parts as [string, string, string];

  if (!isSupportedNamespace(namespace)) {
    throw new DIDResolutionError(
      `did:pkh namespace "${namespace}" not supported (supported: eip155, bip122, solana, tezos)`,
      did,
      "methodNotSupported",
    );
  }

  if (namespace === "eip155") {
    if (!isAddress(address)) {
      throw new DIDResolutionError(
        `did:pkh:eip155 address "${address}" is not a valid Ethereum address`,
        did,
        "invalidDid",
      );
    }
    if (!/^\d+$/.test(chainReference)) {
      throw new DIDResolutionError(
        `did:pkh:eip155 chain reference "${chainReference}" must be a numeric chain ID`,
        did,
        "invalidDid",
      );
    }
  }

  return { namespace, chainReference, address };
}

function isSupportedNamespace(ns: string): ns is SupportedNamespace {
  return ns === "eip155" || ns === "bip122" || ns === "solana" || ns === "tezos";
}

/**
 * Resolve a did:pkh DID to a DIDDocument.
 *
 * The resolver is fully deterministic — no network calls — because did:pkh
 * embeds the public-key hash directly. The DIDDocument is synthesized.
 */
export async function resolvePKH(
  parsed: ParsedDID,
  _options: ResolverOptions = {},
): Promise<DIDDocument> {
  if (parsed.method !== "pkh") {
    throw new DIDResolutionError(`Expected did:pkh, got did:${parsed.method}`, parsed.did, "methodNotSupported");
  }

  const pkh = parsePKHIdentifier(parsed.methodSpecificId, parsed.did);

  const vmType = pickVerificationMethodType(pkh.namespace);
  const vmId = `${parsed.did}#blockchainAccountId`;

  // For eip155 the on-chain blockchainAccountId is CAIP-10 lowercased per spec,
  // but the DID itself may be supplied checksummed.
  const blockchainAccountId =
    pkh.namespace === "eip155"
      ? `${pkh.namespace}:${pkh.chainReference}:${getAddress(pkh.address)}`
      : `${pkh.namespace}:${pkh.chainReference}:${pkh.address}`;

  const vm: VerificationMethod = {
    id: vmId,
    type: vmType,
    controller: parsed.did,
    blockchainAccountId,
  };

  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/blockchain-2021/v1",
    ],
    id: parsed.did,
    verificationMethod: [vm],
    authentication: [vmId],
    assertionMethod: [vmId],
  };
}

function pickVerificationMethodType(namespace: SupportedNamespace): string {
  switch (namespace) {
    case "eip155":
      return "EcdsaSecp256k1RecoveryMethod2020";
    case "bip122":
      return "EcdsaSecp256k1VerificationKey2019";
    case "solana":
      return "Ed25519VerificationKey2018";
    case "tezos":
      return "Ed25519VerificationKey2018";
  }
}
