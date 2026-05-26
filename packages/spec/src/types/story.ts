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
 * ContributorRole — the canonical taxonomy of parties who can earn from a job.
 *
 * Introduced by ADR-12 (2026-04-23). Replaces the former 5-value union
 * (`designer | operator | verifier | assembler | curator`) with a 10-value
 * union that separates execution, trust, contribution, coordination, and
 * network concerns.
 *
 * Semantics per role are documented in ADR-12 §2.1 and §4.
 *
 * Migration notes:
 *   - `designer` is kept as a deprecated member so legacy records still decode.
 *     See ADR-12 §2.2 for the designer→{protocol-author|assembler|integrator}
 *     data-migration plan.
 *   - All other legacy roles (operator, verifier, assembler, curator) carry
 *     forward unchanged.
 */
export type ContributorRole =
  // Execution — always present
  | "operator"
  // Trust layer
  | "verifier"
  | "insurer"
  // Contribution layers — all use ContributorNFT + RateSchedule
  | "integrator"
  | "protocol-author"
  | "model-author"
  | "dataset-contributor"
  /**
   * PyLabRobot backend author. Earns when a PCC job runs through a PLR
   * backend module (e.g., pylabrobot.liquid_handling.backends.hamilton.STAR)
   * that they've registered with the on-chain PLRBackendRegistry. Distinct
   * from `integrator` (PCC adapter author) — backend-author is the upstream
   * OSS driver author one layer below the adapter.
   * Added by ADR-PLR-1 (2026-05-25).
   */
  | "backend-author"
  // Coordination (unchanged from legacy enum)
  | "curator"
  | "assembler"
  // Network
  | "network-treasury"
  /**
   * @deprecated Use `protocol-author`, `assembler`, or `integrator` depending
   * on CSD kind. Retained for backward compatibility so legacy records still
   * decode. See ADR-12 §2.2 for the migration map.
   */
  | "designer";

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
    /** Role in the production of this capability (ContributorRole). */
    role: ContributorRole;
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
