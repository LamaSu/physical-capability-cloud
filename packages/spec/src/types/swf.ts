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
