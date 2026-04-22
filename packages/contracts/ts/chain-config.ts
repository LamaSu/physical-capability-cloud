/**
 * Chain configuration — contract addresses per network.
 *
 * In development/testing: use localhost addresses (from forge script deploy).
 * On base-sepolia/base: fill in after deployment.
 * Story Protocol chains (1514 mainnet / 1513 Aeneid testnet) are also defined here.
 */
import type { Address, Chain } from "viem";
import { defineChain } from "viem";
import { baseSepolia, base, localhost, sepolia } from "viem/chains";

// ── Story Protocol chains ─────────────────────────────────────────────────────

/** Story Network Mainnet (chain 1514) */
export const storyMainnet = defineChain({
  id: 1514,
  name: "Story",
  nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://mainnet.storyrpc.io"] },
    public: { http: ["https://mainnet.storyrpc.io"] },
  },
  blockExplorers: {
    default: { name: "Story Explorer", url: "https://explorer.story.foundation" },
  },
});

/** Story Aeneid Testnet (chain 1513) */
export const storyAeneid = defineChain({
  id: 1513,
  name: "Story Aeneid",
  nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://aeneid.storyrpc.io"] },
    public: { http: ["https://aeneid.storyrpc.io"] },
  },
  blockExplorers: {
    default: { name: "Story Aeneid Explorer", url: "https://aeneid.explorer.story.foundation" },
  },
  testnet: true,
});

// ── Flow EVM Chain ────────────────────────────────────────────────────────────

/** Flow EVM Testnet (chain 545) */
export const flowEVMTestnet = defineChain({
  id: 545,
  name: "Flow EVM Testnet",
  nativeCurrency: { name: "Flow", symbol: "FLOW", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet.evm.nodes.onflow.org"] },
    public: { http: ["https://testnet.evm.nodes.onflow.org"] },
  },
  blockExplorers: {
    default: { name: "FlowScan EVM Testnet", url: "https://evm-testnet.flowscan.io" },
  },
  testnet: true,
});

export interface ChainDeployment {
  chain: Chain;
  rpcUrl?: string;
  contracts: {
    milestoneEscrowFactory?: Address;
    mockUSDC?: Address;
    /** Real USDC on base-sepolia (Circle-deployed) */
    usdc?: Address;
    /** PCCProtocol root contract — collects 2.35% from all settlements via oracle attestation */
    pccProtocol?: Address;
    /** PCCOracleVerifier — on-chain EIP-712 attestation verification */
    oracleVerifier?: Address;
    /** VerifierRegistry — verifier staking */
    verifierRegistry?: Address;
    /** CaptureClassRegistry — on-chain CVP anchors (deployed 2026-04-22) */
    captureClassRegistry?: Address;
    /** ERC-8004 registries */
    identityRegistry?: Address;
    reputationRegistry?: Address;
    validationRegistry?: Address;
    // ── Story Protocol contracts (same addresses on mainnet + Aeneid testnet) ──
    /** Story Protocol IPAssetRegistry — registers NFTs as IP Assets */
    ipAssetRegistry?: Address;
    /** Story Protocol LicenseRegistry — tracks license terms and tokens */
    licenseRegistry?: Address;
    /** Story Protocol RoyaltyModule — routes royalty payments to IP Vaults */
    royaltyModule?: Address;
    /** Story Protocol DisputeModule — UMA-based dispute arbitration */
    disputeModule?: Address;
    /** Story Protocol PILicenseTemplate — Programmable IP License template */
    pilLicenseTemplate?: Address;
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
      milestoneEscrowFactory: "0x10059efeeab1ddf013489e9597a3aec4480d95e1",
      mockUSDC: "0x18bef3dee9f4f97f7cec16db0c4a0a930f478470",
      // PCCProtocol v2 — 2.35% fee, oracle-gated settlement (deployed 2026-03-31)
      pccProtocol: "0x80aD204d2c4B659CBdAab11684AE1A9f0DC14b23",
      identityRegistry: "0xA35972487B8148601E74a92250289b264376c955",
      reputationRegistry: "0x354860589bE457b4a4D195F4063659c2CD7899E8",
      validationRegistry: "0xb09ca0eC847e66f67a1288eFF3237E8904C9d395",
      verifierRegistry: "0x5D84285C487B1dc631B55512D5423A12A48cd97A",
      // CaptureClassRegistry — CVP on-chain anchor (deployed 2026-04-22, block 40562689)
      captureClassRegistry: "0xAaB3F94fdEDF02663A4817961A6f7C4f5A912A66",
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

  // ── Story Protocol Networks ───────────────────────────────────────────────

  /**
   * Story Network Mainnet (chain 1514).
   * Contract addresses are the same as on Aeneid testnet.
   */
  story: {
    chain: storyMainnet,
    rpcUrl: "https://mainnet.storyrpc.io",
    contracts: {
      ipAssetRegistry: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
      licenseRegistry: "0x529a750E02d8E2f15649c13D69a465286a780e24",
      royaltyModule: "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086",
      disputeModule: "0x9b7A9c70AFF961C799110954fc06F3093aeb94C5",
      pilLicenseTemplate: "0x2E896b0b2Fdb7457499B56AAaA4AE55BCB4Cd316",
    },
    blockExplorer: "https://explorer.story.foundation",
  },

  /**
   * Story Aeneid Testnet (chain 1513).
   * Use STORY_NETWORK=story-aeneid (default for development).
   */
  "story-aeneid": {
    chain: storyAeneid,
    rpcUrl: "https://aeneid.storyrpc.io",
    contracts: {
      ipAssetRegistry: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
      licenseRegistry: "0x529a750E02d8E2f15649c13D69a465286a780e24",
      royaltyModule: "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086",
      disputeModule: "0x9b7A9c70AFF961C799110954fc06F3093aeb94C5",
      pilLicenseTemplate: "0x2E896b0b2Fdb7457499B56AAaA4AE55BCB4Cd316",
    },
    blockExplorer: "https://aeneid.explorer.story.foundation",
  },

  // ── Flow EVM Networks ─────────────────────────────────────────────────────

  /**
   * Flow EVM Testnet (chain 545).
   * Deployed for PL Genesis hackathon — Flow EVM bounty.
   * Use PCC_NETWORK=flow-evm-testnet to target this network.
   */
  "flow-evm-testnet": {
    chain: flowEVMTestnet,
    rpcUrl: "https://testnet.evm.nodes.onflow.org",
    contracts: {
      // Deployed 2026-03-31 via scripts/deploy-flow-evm.ts (deployer: 0xdDF4...)
      milestoneEscrowFactory: "0xe2afaab2729b3af290af58c443665b74eba5739b",
      mockUSDC: "0x5f2eb54dc5cb9a6bfff58222c672e73e16e763e9",
      pccProtocol: "0x10059efeeab1ddf013489e9597a3aec4480d95e1",
    },
    blockExplorer: "https://evm-testnet.flowscan.io",
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
