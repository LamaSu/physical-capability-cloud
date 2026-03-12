/**
 * DePIN Economics types — capability certificates, reward epochs,
 * claims, and treasury balances.
 *
 * Capability Certificates are soulbound compressed NFTs (cNFTs) on Solana
 * via Metaplex Bubblegum v2.  In this codebase they are represented as
 * pure-TypeScript types; the actual Solana program interaction is
 * simulated in @pcc/contracts.
 */

// ── Capability Certificate ──────────────────────────────────────

export interface CertificateMetadata {
  /** Tolerance specifications keyed by dimension name */
  toleranceSpecs?: Record<string, string>;
  /** Materials this certificate covers */
  materials?: string[];
  /** IPFS CID of the calibration proof document */
  calibrationProofCid?: string;
  /** ISO 8601 date of last calibration */
  calibrationDate?: string;
  /** Human-readable build volume, e.g. "250x210x210 mm" */
  maxBuildVolume?: string;
}

export interface CapabilityCertificate {
  /** Prefixed ID: cnft_xxx */
  id: string;
  /** DID of the kernel that owns this certificate */
  kernelDid: string;
  /** The capability type the cert attests, e.g. "fdm", "cnc-3axis" */
  capabilityType: string;
  /** Assurance tier the operator is certified for */
  assuranceTier: number;
  /** Rich metadata embedded in the cNFT */
  metadata: CertificateMetadata;
  /** ISO 8601 mint timestamp */
  mintedAt: string;
  /** Soulbound — always true; non-transferable */
  soulbound: true;
  /** Lifecycle status */
  status: "active" | "revoked" | "expired";
  // ── Solana-specific fields (mock) ────────────────────────────
  /** Merkle tree public key (base58) */
  merkleTree?: string;
  /** Leaf index within the tree */
  leafIndex?: number;
  /** Compressed asset ID (base58) */
  assetId?: string;
}

// ── Reward Epoch ────────────────────────────────────────────────

export interface KernelEpochScore {
  kernelId: string;
  kernelDid: string;
  /** Number of jobs completed in this epoch — 40 % weight */
  jobsCompleted: number;
  /** Quality score 0-1 — 25 % weight */
  qualityScore: number;
  /** Uptime percentage 0-100 — 15 % weight */
  uptimePercent: number;
  /** Count of unique capability types — 10 % weight */
  capabilityDiversity: number;
  /** Scarcity bonus 0-1 — 10 % weight */
  scarcityBonus: number;
  /** Weighted total */
  totalScore: number;
  /** Reward amount in token units (string to avoid fp) */
  rewardAmount: string;
}

export interface RewardEpoch {
  /** Prefixed ID: epoch_xxx */
  id: string;
  /** Sequential epoch number */
  epochNumber: number;
  /** ISO 8601 start */
  startTime: string;
  /** ISO 8601 end */
  endTime: string;
  /** Total reward pool in token units */
  totalRewards: string;
  /** Epoch lifecycle */
  status: "active" | "completed" | "distributing";
  /** Per-kernel scoring for this epoch */
  kernelScores: KernelEpochScore[];
}

// ── Reward Claim ────────────────────────────────────────────────

export interface DePINRewardClaim {
  /** Prefixed ID: claim_xxx */
  id: string;
  kernelId: string;
  epochId: string;
  /** Amount in token units */
  amount: string;
  /** Target chain (e.g. "solana", "base") */
  chain: string;
  /** Claim lifecycle */
  status: "pending" | "claimed" | "failed";
  /** On-chain transaction hash, populated on success */
  txHash?: string;
  /** ISO 8601 claim completion time */
  claimedAt?: string;
}

// ── Treasury ────────────────────────────────────────────────────

export interface TreasuryBalance {
  agentId: string;
  chain: string;
  balances: { currency: string; amount: string }[];
  /** Estimated USD value of all balances */
  totalUsdValue: string;
  /** ISO 8601 */
  lastUpdated: string;
}

// ── Funding ─────────────────────────────────────────────────────

export interface FundingProposal {
  /** Prefixed ID: fund_xxx */
  id: string;
  /** Capability type that is under-served */
  capabilityType: string;
  /** Proposed grant amount */
  amount: string;
  /** Human-readable justification */
  reason: string;
  /** Lifecycle */
  status: "proposed" | "approved" | "denied" | "disbursed";
  createdAt: string;
}
