/**
 * EAS contract deployments and constants.
 * Addresses sourced from https://github.com/ethereum-attestation-service/eas-contracts/tree/master/deployments
 * verified 2026-05-27.
 */

import type { EASDeployment } from "./types.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * EIP-712 domain name used by EAS contracts for off-chain attestations.
 * The contract self-reports "EAS Attestation" via getDomainSeparator().
 */
export const EAS_DOMAIN_NAME = "EAS Attestation";

/** Current EAS off-chain attestation version (Version 2 per eas-sdk). */
export const OFFCHAIN_ATTESTATION_VERSION = 2;

/**
 * EAS contract version string used in the EIP-712 domain.
 * Each chain's EAS reports its own version() — common values are "1.3.0" / "1.4.0".
 * Override via OffChainSigner constructor if needed for a specific deployment.
 */
export const DEFAULT_EAS_CONTRACT_VERSION = "1.3.0";

/**
 * Canonical EAS deployments. Sourced from
 * ethereum-attestation-service/eas-contracts:deployments/.
 */
export const EAS_DEPLOYMENTS: Record<number, EASDeployment> = {
  // Ethereum Mainnet
  1: {
    chainId: 1,
    chainName: "mainnet",
    eas: "0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587",
    schemaRegistry: "0xA7b39296258348C78294F95B872b282326A97BDF",
  },
  // Optimism
  10: {
    chainId: 10,
    chainName: "optimism",
    eas: "0x4200000000000000000000000000000000000021",
    schemaRegistry: "0x4200000000000000000000000000000000000020",
  },
  // Polygon
  137: {
    chainId: 137,
    chainName: "polygon",
    eas: "0x5E634ef5355f45A855d02D66eCD687b1502AF790",
    schemaRegistry: "0x7876EEF51A891E737AF8ba5A5E0f0Fd29073D5a7",
  },
  // Arbitrum One
  42161: {
    chainId: 42161,
    chainName: "arbitrum-one",
    eas: "0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458",
    schemaRegistry: "0xA310da9c5B885E7fb3fbA9D66E9Ba6Df512b78eB",
  },
  // Base
  8453: {
    chainId: 8453,
    chainName: "base",
    eas: "0x4200000000000000000000000000000000000021",
    schemaRegistry: "0x4200000000000000000000000000000000000020",
  },
  // Sepolia (Ethereum testnet)
  11155111: {
    chainId: 11155111,
    chainName: "sepolia",
    eas: "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
    schemaRegistry: "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
  },
  // Base Sepolia (testnet)
  84532: {
    chainId: 84532,
    chainName: "base-sepolia",
    eas: "0x4200000000000000000000000000000000000021",
    schemaRegistry: "0x4200000000000000000000000000000000000020",
  },
};

/** Lookup EAS deployment by chain ID; throws if unsupported. */
export function getEASDeployment(chainId: number): EASDeployment {
  const dep = EAS_DEPLOYMENTS[chainId];
  if (!dep) {
    throw new Error(
      `EAS not deployed (or not registered in @pcc/attestations) on chain ${chainId}. ` +
        `Supported chains: ${Object.keys(EAS_DEPLOYMENTS).join(", ")}`,
    );
  }
  return dep;
}
