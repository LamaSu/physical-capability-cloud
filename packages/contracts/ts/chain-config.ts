/**
 * Chain configuration — contract addresses per network.
 *
 * In development/testing: use localhost addresses (from forge script deploy).
 * On base-sepolia/base: fill in after deployment.
 */
import type { Address, Chain } from "viem";
import { baseSepolia, base, localhost, sepolia } from "viem/chains";

export interface ChainDeployment {
  chain: Chain;
  rpcUrl?: string;
  contracts: {
    milestoneEscrowFactory?: Address;
    mockUSDC?: Address;
    /** Real USDC on base-sepolia (Circle-deployed) */
    usdc?: Address;
    /** ERC-8004 registries */
    identityRegistry?: Address;
    reputationRegistry?: Address;
    validationRegistry?: Address;
  };
  blockExplorer?: string;
}

export const deployments: Record<string, ChainDeployment> = {
  localhost: {
    chain: localhost,
    rpcUrl: "http://127.0.0.1:8545",
    contracts: {
      // Filled by `forge script Deploy` output
      milestoneEscrowFactory: undefined,
      mockUSDC: undefined,
    },
  },
  sepolia: {
    chain: sepolia,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    contracts: {
      milestoneEscrowFactory: "0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454",
      mockUSDC: "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb",
    },
    blockExplorer: "https://sepolia.etherscan.io",
  },
  "base-sepolia": {
    chain: baseSepolia,
    rpcUrl: "https://sepolia.base.org",
    contracts: {
      // Base Sepolia USDC (Circle testnet faucet)
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      // Deployed contract addresses — fill after Base Sepolia deployment
      milestoneEscrowFactory: undefined,
      mockUSDC: undefined,
    },
    blockExplorer: "https://sepolia.basescan.org",
  },
  base: {
    chain: base,
    rpcUrl: "https://mainnet.base.org",
    contracts: {
      // Base Mainnet USDC
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      milestoneEscrowFactory: undefined,
      mockUSDC: undefined,
    },
    blockExplorer: "https://basescan.org",
  },
};

export function getDeployment(network: string): ChainDeployment {
  const deployment = deployments[network];
  if (!deployment) {
    throw new Error(`Unknown network: ${network}. Available: ${Object.keys(deployments).join(", ")}`);
  }
  return deployment;
}

export function getContractAddress(network: string, contract: keyof ChainDeployment["contracts"]): Address {
  const deployment = getDeployment(network);
  const addr = deployment.contracts[contract];
  if (!addr) {
    throw new Error(`Contract ${contract} not deployed on ${network}`);
  }
  return addr;
}
