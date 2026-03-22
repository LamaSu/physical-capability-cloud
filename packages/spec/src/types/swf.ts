/**
 * Sovereign Wealth Fund (SWF) types — protocol-wide fund that accrues
 * from every fee-generating transaction and distributes dividends to
 * all network participants, weighted by contribution score.
 *
 * Governance is lightweight: any participant (30+ days tenure) can
 * propose a new allocation strategy; votes are score-weighted with
 * a 30 % quorum requirement.
 */

// ── Participant ───────────────────────────────────────────────────

/** Role a participant plays in the PCC network */
export type SWFParticipantRole =
  | "operator"
  | "user"
  | "verifier"
  | "courier"
  | "arbiter"
  | "staker"
  | "curator";

/** A registered participant eligible for SWF dividends */
export interface SWFParticipant {
  /** Prefixed ID: swf_part_xxx */
  id: string;
  /** DID of the participant */
  did: string;
  /** Wallet address (0x… or base58) */
  walletAddress: string;
  /** Primary role in the network */
  role: SWFParticipantRole;
  /** ISO 8601 registration timestamp */
  registeredAt: string;
  /** Lifecycle status */
  status: "active" | "suspended" | "withdrawn";
}

// ── Allocation Strategy ───────────────────────────────────────────

/** How the fund's epoch accrual is allocated — must sum to 100 */
export interface SWFAllocationStrategy {
  /** % of epoch accrual to direct dividends */
  dividendPercent: number;
  /** % to infrastructure investment pools */
  infrastructurePercent: number;
  /** % to capability development grants */
  grantsPercent: number;
  /** % kept in reserve */
  reservePercent: number;
}

// ── Accrual ───────────────────────────────────────────────────────

/** Source type for an accrual into the fund */
export type SWFAccrualSource =
  | "protocol_fee"
  | "escrow_release"
  | "settlement"
  | "bounty_fee"
  | "pool_revenue"
  | "dispute_slash";

/** A single accrual into the fund */
export interface SWFAccrual {
  /** Prefixed ID: swf_acc_xxx */
  id: string;
  /** What generated this accrual */
  sourceType: SWFAccrualSource;
  /** Reference ID (job ID, escrow ID, etc.) */
  sourceId: string;
  /** Total transaction amount (string to avoid fp) */
  grossAmount: string;
  /** Basis points taken for SWF (e.g. 200 = 2 %) */
  accrualBps: number;
  /** Actual amount accrued (string to avoid fp) */
  accrualAmount: string;
  /** Currency of the accrual */
  currency: "USDC" | "CREDITS";
  /** Chain the accrual originated on */
  chain: string;
  /** ISO 8601 timestamp */
  accruedAt: string;
  /** Which epoch this accrual belongs to */
  epochId: string;
}

// ── Contribution Score ────────────────────────────────────────────

/** Per-participant per-epoch contribution score */
export interface SWFContributionScore {
  participantId: string;
  epochId: string;
  /** Jobs completed / submitted / verified — 30 % weight */
  jobVolume: number;
  /** ERC-8004 reputation score — 25 % weight */
  reputationScore: number;
  /** Kernel uptime or user activity frequency — 20 % weight */
  uptimeOrActivity: number;
  /** Time on network 0-1, capped at 2 years — 15 % weight */
  tenureFactor: number;
  /** Voted in proposals this epoch — 10 % weight */
  governanceParticipation: number;
  /** Weighted composite score */
  totalScore: number;
  /** This participant's fraction of the total epoch score */
  shareOfEpoch: number;
}

// ── Epoch ─────────────────────────────────────────────────────────

/** Epoch lifecycle status */
export type SWFEpochStatus =
  | "active"
  | "calculating"
  | "distributing"
  | "completed";

/** A distribution epoch (weekly by default) */
export interface SWFEpoch {
  /** Prefixed ID: swf_epoch_xxx */
  id: string;
  /** Sequential epoch number */
  epochNumber: number;
  /** ISO 8601 start */
  startTime: string;
  /** ISO 8601 end */
  endTime: string;
  /** Total amount collected this epoch (string to avoid fp) */
  totalAccrued: string;
  /** Amount distributed as dividends (string to avoid fp) */
  totalDistributed: string;
  /** Allocation strategy used for this epoch */
  allocationStrategy: SWFAllocationStrategy;
  /** Epoch lifecycle */
  status: SWFEpochStatus;
  /** Number of eligible participants */
  participantCount: number;
  /** Per-participant scoring (populated during distribution) */
  scores: SWFContributionScore[];
}

// ── Dividend Claim ────────────────────────────────────────────────

/** A dividend claim by a participant */
export interface SWFDividendClaim {
  /** Prefixed ID: swf_claim_xxx */
  id: string;
  /** Participant who owns this claim */
  participantId: string;
  /** Epoch this claim is for */
  epochId: string;
  /** Amount claimable (string to avoid fp) */
  amount: string;
  /** Target chain for settlement */
  chain: string;
  /** Claim lifecycle */
  status: "pending" | "claimed" | "failed";
  /** On-chain transaction hash, populated on success */
  txHash?: string;
  /** ISO 8601 claim completion time */
  claimedAt?: string;
}

// ── Governance ────────────────────────────────────────────────────

/** Governance proposal lifecycle */
export type SWFProposalStatus =
  | "active"
  | "passed"
  | "rejected"
  | "executed";

/** Governance proposal for changing allocation strategy */
export interface SWFProposal {
  /** Prefixed ID: swf_prop_xxx */
  id: string;
  /** Participant who created the proposal */
  proposer: string;
  /** Short title */
  title: string;
  /** Full description / rationale */
  description: string;
  /** The proposed new allocation strategy */
  proposedStrategy: SWFAllocationStrategy;
  /** ISO 8601 voting window start */
  votingStart: string;
  /** ISO 8601 voting window end */
  votingEnd: string;
  /** Current lifecycle status */
  status: SWFProposalStatus;
  /** Sum of yes-vote weights */
  yesVotes: number;
  /** Sum of no-vote weights */
  noVotes: number;
  /** Number of participants who voted */
  totalVoters: number;
  /** Fraction of eligible participants required to vote (e.g. 0.30) */
  quorumRequired: number;
  /** ISO 8601 creation timestamp */
  createdAt: string;
}

/** A single vote on a governance proposal */
export interface SWFVote {
  /** Prefixed ID: swf_vote_xxx */
  id: string;
  proposalId: string;
  participantId: string;
  /** Vote direction */
  vote: "yes" | "no" | "abstain";
  /** Contribution-score weight of this vote */
  weight: number;
  /** ISO 8601 timestamp */
  votedAt: string;
}

// ── Summary ───────────────────────────────────────────────────────

/** Fund-level summary for dashboards */
export interface SWFSummary {
  /** Current fund balance across all chains (string to avoid fp) */
  totalBalance: string;
  /** All-time distributed amount */
  totalDistributedAllTime: string;
  /** All-time accrued amount */
  totalAccruedAllTime: string;
  /** Current active epoch ID */
  currentEpochId: string;
  /** Active allocation strategy */
  currentAllocationStrategy: SWFAllocationStrategy;
  /** Total registered participants */
  participantCount: number;
  /** Number of active governance proposals */
  activeProposals: number;
  /** ISO 8601 of last distribution */
  lastDistributionAt: string;
  /** Per-chain balances */
  chainBalances: Array<{ chain: string; currency: string; amount: string }>;
}

// ── Forecast-Driven Allocation ─────────────────────────────────────

/** A demand signal used for forecast-driven infrastructure allocation */
export interface SWFDemandForecast {
  /** Capability type (e.g. "fdm", "cnc-3axis") */
  capabilityType: string;
  /** Number of unique requesters */
  requesterCount: number;
  /** Estimated annual value in USD */
  annualValue: number;
  /** Whether this capability already exists on the network */
  alreadyServed: boolean;
  /** Existing supply utilization 0-100 (null if not served) */
  utilizationPercent?: number;
}

/** A single allocation decision within the infrastructure budget */
export interface SWFInfraAllocation {
  /** Capability type receiving funding */
  capabilityType: string;
  /** Amount allocated from the infrastructure budget (string to avoid fp) */
  amount: string;
  /** Why this was selected — human-readable rationale */
  rationale: string;
  /** Forecast ROI: estimated annual revenue / allocation amount */
  forecastROI: number;
  /** Score used for ranking (higher = funded first) */
  priorityScore: number;
}

/** Result of a forecast-driven allocation run */
export interface SWFForecastAllocationResult {
  /** Epoch this allocation was computed for */
  epochId: string;
  /** Total infrastructure budget for this epoch (string to avoid fp) */
  totalBudget: string;
  /** Individual allocations, ranked by priority */
  allocations: SWFInfraAllocation[];
  /** Amount remaining unallocated (goes to reserve) */
  unallocated: string;
  /** ISO 8601 timestamp */
  computedAt: string;
}

// ── Equity Positions ──────────────────────────────────────────────

/** Equity tier — higher risk funding = higher equity stake */
export type SWFEquityTier = "seed" | "growth" | "expansion";

/** An equity position the fund holds in a capability it funded */
export interface SWFEquityPosition {
  /** Prefixed ID: swf_equity_xxx */
  id: string;
  /** Capability type the fund invested in */
  capabilityType: string;
  /** NFT ID — soulbound to the fund (Metaplex cNFT or on-chain token) */
  nftId: string;
  /** Merkle tree address for the cNFT (Solana) */
  merkleTree?: string;
  /** Original seed amount invested (string to avoid fp) */
  seedAmount: string;
  /** Revenue share in basis points the fund receives from this capability */
  revenueShareBps: number;
  /** Risk tier at time of investment */
  equityTier: SWFEquityTier;
  /** Total revenue earned back from this position (string to avoid fp) */
  totalRevenue: string;
  /** ROI = totalRevenue / seedAmount */
  realizedROI: number;
  /** Whether the capability is now active on the network */
  capabilityActive: boolean;
  /** Epoch the position was created in */
  originEpochId: string;
  /** ISO 8601 mint timestamp */
  mintedAt: string;
  /** Lifecycle status */
  status: "active" | "matured" | "written_off";
  /** ISO 8601 maturity date (if matured — e.g., after 10x ROI) */
  maturedAt?: string;
}

/** Revenue event flowing back to the fund from an equity position */
export interface SWFEquityRevenue {
  /** Prefixed ID: swf_eqrev_xxx */
  id: string;
  /** Equity position this revenue belongs to */
  equityPositionId: string;
  /** Job that generated the revenue */
  jobId: string;
  /** Total protocol fee from the job (string to avoid fp) */
  protocolFee: string;
  /** Fund's share of the fee (string to avoid fp) */
  fundShare: string;
  /** ISO 8601 timestamp */
  earnedAt: string;
}

/** Summary of the fund's equity portfolio */
export interface SWFEquityPortfolio {
  /** Total equity positions held */
  totalPositions: number;
  /** Active positions (capability is live, earning revenue) */
  activePositions: number;
  /** Total seed capital deployed (string to avoid fp) */
  totalDeployed: string;
  /** Total revenue earned back across all positions (string to avoid fp) */
  totalRevenueEarned: string;
  /** Portfolio ROI = totalRevenue / totalDeployed */
  portfolioROI: number;
  /** Individual positions */
  positions: SWFEquityPosition[];
}

/**
 * Equity tier → revenue share schedule.
 * Higher risk (seed) = higher equity stake for the fund.
 */
export const SWF_EQUITY_SCHEDULE = {
  /** Unserved capability — fund takes largest stake */
  seed: { revenueShareBps: 800, maturityMultiplier: 10 },
  /** Underserved / high utilization — moderate stake */
  growth: { revenueShareBps: 500, maturityMultiplier: 7 },
  /** Capacity expansion — smallest stake */
  expansion: { revenueShareBps: 300, maturityMultiplier: 5 },
} as const;

// ── Participant Dashboard ─────────────────────────────────────────

/** Per-participant dashboard data */
export interface SWFParticipantDashboard {
  participant: SWFParticipant;
  /** Total earned across all epochs (string to avoid fp) */
  totalEarned: string;
  /** Pending unclaimed dividends */
  pendingDividends: string;
  /** Epochs the participant was scored in */
  epochCount: number;
  /** Claim history */
  claims: SWFDividendClaim[];
  /** Proposals voted on */
  votingHistory: SWFVote[];
}
