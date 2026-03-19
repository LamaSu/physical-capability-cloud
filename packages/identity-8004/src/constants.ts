/**
 * ERC-8004 registry contract addresses per chain.
 */

export interface RegistryAddresses {
  identityRegistry: `0x${string}`;
  reputationRegistry: `0x${string}`;
  validationRegistry?: `0x${string}`;
}

/** Known ERC-8004 registry deployments */
export const REGISTRY_ADDRESSES: Record<number, RegistryAddresses> = {
  // Ethereum Sepolia (testnet)
  11155111: {
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
  // Base Sepolia (testnet — Daydreams deployment)
  84532: {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
  // Base Mainnet — TODO: update once canonical singletons deployed
  // 8453: { identityRegistry: "0x...", reputationRegistry: "0x..." },
};

/**
 * Get registry addresses for a chain, or throw if unsupported.
 */
export function getRegistryAddresses(chainId: number): RegistryAddresses {
  const addresses = REGISTRY_ADDRESSES[chainId];
  if (!addresses) {
    throw new Error(
      `No ERC-8004 registry addresses for chain ${chainId}. ` +
      `Supported chains: ${Object.keys(REGISTRY_ADDRESSES).join(", ")}`,
    );
  }
  return addresses;
}
