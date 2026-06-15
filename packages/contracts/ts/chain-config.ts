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

// ── Ethereum Attestation Service (EAS) addresses ──────────────────────────────

/**
 * EAS contract — Base Sepolia (84532) + OP-Stack predeploy. Threaded into
 * MilestoneEscrowV2 as the `eas` immutable.
 * WARNING: Base MAINNET (8453) EAS is NOT this predeploy address — verify against
 * eas-contracts deployments/ before any mainnet use.
 */
export const EAS_ADDRESS = "0x4200000000000000000000000000000000000021" as const;

/**
 * EAS SchemaRegistry — Base Sepolia (84532) + OP-Stack predeploy. Used by
 * RegisterEASSchema.s.sol to register the `pcc.evidence.v1` schema (gate G1).
 * WARNING: Base MAINNET (8453) EAS is NOT this predeploy address — verify against
 * eas-contracts deployments/ before any mainnet use.
 */
export const EAS_SCHEMA_REGISTRY = "0x4200000000000000000000000000000000000020" as const;

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
  /**
   * Ordered fallback RPC URLs for this network (primary first). When the
   * primary RPC (`rpcUrl`) is laggy, rate-limited, or down, on-chain reads and
   * writes rotate through these. Consumed by `getRpcUrls()` and the gateway's
   * viem `fallback()` transport. `rpcUrl` is implicitly the head of the list;
   * entries here are the additional fallbacks (deduped against `rpcUrl`).
   */
  rpcUrls?: string[];
  /**
   * EAS `pcc.evidence.v1` schema UID for this network. Undefined until the schema
   * is registered on-chain (migration gate G1). keccak256(abi.encodePacked(schemaString,
   * address(0), true)) — the SAME UID resolves on Base Sepolia and Base mainnet only if
   * the exact same (string, resolver, revocable) triple is used. Threaded into
   * MilestoneEscrowV2 as the PCC_EVIDENCE_SCHEMA_UID immutable.
   */
  pccEvidenceSchemaUid?: `0x${string}`;
  contracts: {
    milestoneEscrowFactory?: Address;
    /**
     * PCCProtocolV2 factory — deploys EAS-gated MilestoneEscrowV2 instances.
     * Undefined until the V2 factory is deployed (migration gate G3). Address must be
     * hand-added here after `forge script DeployProtocolV2.s.sol` (no automated ingestion).
     */
    milestoneEscrowFactoryV2?: Address;
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
    /** ReceiptAnchorRegistry — Phase-2 InvocationReceipt anchors (anchorOne + anchorBatch).
     *  Address filled in after deploying via script/DeployReceiptAnchorRegistry.s.sol.
     *  Design doc: ai/scoping/onchain-receipt-anchoring-2026-05-23.md */
    receiptAnchorRegistry?: Address;
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
    rpcUrls: [
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://rpc.sepolia.org",
      "https://1rpc.io/sepolia",
    ],
    contracts: {
      milestoneEscrowFactory: "0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454",
      mockUSDC: "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb",
    },
    blockExplorer: "https://sepolia.etherscan.io",
  },
  "base-sepolia": {
    chain: baseSepolia,
    rpcUrl: "https://sepolia.base.org",
    // Fallback RPCs (public, no-key) for failover when sepolia.base.org is
    // rate-limited or laggy — the root cause of the P0-1 nonce/milestone races.
    rpcUrls: [
      "https://sepolia.base.org",
      "https://base-sepolia-rpc.publicnode.com",
      "https://base-sepolia.drpc.org",
    ],
    contracts: {
      // Base Sepolia USDC (Circle testnet faucet)
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      milestoneEscrowFactory: "0x10059efeeab1ddf013489e9597a3aec4480d95e1",
      // PCCProtocolV2 factory — deploys EAS-gated MilestoneEscrowV2 instances via
      // createEscrowV2(payer,arbiter,token,cwmId). Threaded into the V2 settlement
      // path (paid-job-flow) when PCC_USE_EAS_V2=true. Deployment record:
      // deployments/base-sepolia/PCCProtocolV2.json. (Retired per-instance factory
      // 0x5810Bf is superseded by this one — see coord CANONICAL STATE.)
      milestoneEscrowFactoryV2: "0x39F6958b132c0972Ce8f5658A3F8F16491395642",
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

/** Last-resort RPC when a network is unknown or has no configured URL. */
const DEFAULT_RPC_URL = "https://sepolia.base.org";

/**
 * Resolve the ordered RPC URL list for a network (primary first, fallbacks
 * after). This is the single source of truth for RPC failover — consumers build
 * a viem `fallback()` transport from the result so reads/writes rotate off a
 * laggy or rate-limited endpoint instead of dropping a tx.
 *
 * Precedence:
 *   1. `PCC_RPC_URLS` env (comma-separated) — full override, used verbatim.
 *   2. `PCC_RPC_URL` env (single) — becomes the primary, then the network's
 *      configured fallbacks (back-compat: the legacy single-URL override still
 *      works AND now gains failover).
 *   3. The network's `rpcUrl` + `rpcUrls` from chain-config.
 *   4. `DEFAULT_RPC_URL` (matches the historical hardcoded fallback).
 *
 * The list is always deduped (case-sensitive, order-preserving) and non-empty.
 */
export function getRpcUrls(network: string): string[] {
  const dedupe = (urls: Array<string | undefined>): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of urls) {
      const url = u?.trim();
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
    return out;
  };

  const envList = process.env.PCC_RPC_URLS
    ? dedupe(process.env.PCC_RPC_URLS.split(","))
    : [];
  if (envList.length > 0) return envList;

  const deployment = deployments[network];
  const configured = [deployment?.rpcUrl, ...(deployment?.rpcUrls ?? [])];

  const envSingle = process.env.PCC_RPC_URL?.trim();
  const merged = dedupe(envSingle ? [envSingle, ...configured] : configured);

  return merged.length > 0 ? merged : [DEFAULT_RPC_URL];
}
