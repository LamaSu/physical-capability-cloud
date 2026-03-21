/**
 * Story Protocol integration types for Physical Capability Cloud.
 *
 * These types bridge PCC's capability/job/evidence model with
 * Story Protocol's IP Asset / License / Royalty primitives.
 *
 * Chain IDs:
 *   Story Mainnet  — 1514
 *   Story Aeneid (testnet) — 1513
 */

/** A PCC capability registered as an IP Asset on Story Protocol. */
export interface StoryIPRegistration {
  /** IP Account address on Story (0x...) */
  ipId: string;
  /** Token ID of the underlying NFT that backs the IP Asset */
  nftTokenId: string;
  /** PIL (Programmable IP License) terms ID */
  licenseTermsId: string;
  /** Registration transaction hash */
  txHash: string;
  /** PCC capability ID this IP Asset represents */
  capabilityId: string;
  /** CSD URI: pcc://capabilities/<id> or IPFS CID */
  csdUrl: string;
  /** ISO 8601 timestamp */
  registeredAt: string;
  /** Which Story chain this was registered on */
  chain: "story" | "story-aeneid";
}

/**
 * Revenue split configuration for an IP Asset.
 * 100 Royalty Tokens total; each token = 1% of all future revenue.
 */
export interface StoryRoyaltySplit {
  /** Which IP Asset these splits apply to */
  ipId: string;
  splits: Array<{
    /** Recipient wallet address */
    address: string;
    /** Role in the production of this capability */
    role: "designer" | "operator" | "verifier" | "assembler" | "curator";
    /** Integer 1-100; all splits must sum to 100 */
    percentage: number;
    /** Human-readable label, e.g. "CSD Author", "Machine Operator" */
    label: string;
  }>;
  /** Total Royalty Tokens distributed (should equal 100) */
  totalTokensDistributed: number;
}

/**
 * A parent→child link between two IP Assets on Story Protocol.
 * Created when a completed job's evidence bundle is registered as
 * a derivative of the CSD IP Asset it was built from.
 */
export interface StoryDerivativeLink {
  /** Parent IP Asset address (the CSD) */
  parentIpId: string;
  /** Child IP Asset address (the job evidence bundle) */
  childIpId: string;
  /** Story license token ID used to create the derivative */
  licenseTokenId: string;
  /** PCC job ID */
  jobId: string;
  /** SHA-256 of the evidence bundle */
  evidenceBundleHash: string;
  /** Link transaction hash */
  txHash: string;
  /** ISO 8601 timestamp */
  linkedAt: string;
}

/** Revenue snapshot for an IP Asset's Royalty Vault. */
export interface StoryRevenueSnapshot {
  /** IP Asset address */
  ipId: string;
  /** IP Royalty Vault contract address */
  vaultAddress: string;
  /** Total revenue accumulated in the vault (WIP/USDC, as string for bigint safety) */
  totalRevenue: string;
  /** Revenue available to claim right now */
  unclaimedRevenue: string;
  /** All Royalty Token holders and their claimable amounts */
  tokenHolders: Array<{
    address: string;
    /** Tokens held out of 100 */
    tokensHeld: number;
    /** Amount this holder can claim (string for bigint safety) */
    claimable: string;
  }>;
  /** ISO 8601 timestamp of the last payment into this vault */
  lastPaymentAt: string;
}

/**
 * A dispute raised against an IP Asset on Story Protocol.
 * Uses Story's UMA-based DisputeModule; supplements PCC's own challenge window.
 */
export interface StoryDispute {
  /** Story dispute ID */
  disputeId: string;
  /** IP Asset being disputed */
  ipId: string;
  /** Address of the dispute initiator */
  initiator: string;
  /** Hash of the evidence submitted with the dispute */
  evidenceHash: string;
  /** Human-readable dispute reason */
  reason: string;
  /** Current dispute status */
  status: "pending" | "resolved" | "cancelled";
  /** ISO 8601 timestamp */
  createdAt: string;
  /** ISO 8601 timestamp — only set when status is "resolved" */
  resolvedAt?: string;
}
