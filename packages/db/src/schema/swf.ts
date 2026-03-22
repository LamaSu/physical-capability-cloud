import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/**
 * SWF participants — registered fund beneficiaries.
 */
export const swfParticipants = sqliteTable("swf_participants", {
  id: text("id").primaryKey(),
  did: text("did").notNull(),
  walletAddress: text("wallet_address").notNull(),
  role: text("role").notNull(),
  registeredAt: text("registered_at").notNull(),
  status: text("status").notNull().default("active"),
});

/**
 * SWF distribution epochs — weekly cycles.
 */
export const swfEpochs = sqliteTable("swf_epochs", {
  id: text("id").primaryKey(),
  epochNumber: integer("epoch_number").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  totalAccrued: text("total_accrued").notNull().default("0"),
  totalDistributed: text("total_distributed").notNull().default("0"),
  /** JSON-encoded SWFAllocationStrategy */
  allocationStrategy: text("allocation_strategy").notNull(),
  status: text("status").notNull().default("active"),
  participantCount: integer("participant_count").notNull().default(0),
});

/**
 * SWF accruals — individual fee contributions to the fund.
 */
export const swfAccruals = sqliteTable("swf_accruals", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  grossAmount: text("gross_amount").notNull(),
  accrualBps: integer("accrual_bps").notNull(),
  accrualAmount: text("accrual_amount").notNull(),
  currency: text("currency").notNull().default("USDC"),
  chain: text("chain").notNull(),
  accruedAt: text("accrued_at").notNull(),
  epochId: text("epoch_id").notNull(),
});

/**
 * SWF contribution scores — per-participant per-epoch weighted scores.
 */
export const swfContributionScores = sqliteTable("swf_contribution_scores", {
  /** Composite key: participantId + epochId */
  id: text("id").primaryKey(),
  participantId: text("participant_id").notNull(),
  epochId: text("epoch_id").notNull(),
  jobVolume: real("job_volume").notNull().default(0),
  reputationScore: real("reputation_score").notNull().default(0),
  uptimeOrActivity: real("uptime_or_activity").notNull().default(0),
  tenureFactor: real("tenure_factor").notNull().default(0),
  governanceParticipation: real("governance_participation").notNull().default(0),
  totalScore: real("total_score").notNull().default(0),
  shareOfEpoch: real("share_of_epoch").notNull().default(0),
});

/**
 * SWF dividend claims — claim records for participant payouts.
 */
export const swfDividendClaims = sqliteTable("swf_dividend_claims", {
  id: text("id").primaryKey(),
  participantId: text("participant_id").notNull(),
  epochId: text("epoch_id").notNull(),
  amount: text("amount").notNull(),
  chain: text("chain").notNull(),
  status: text("status").notNull().default("pending"),
  txHash: text("tx_hash"),
  claimedAt: text("claimed_at"),
});

/**
 * SWF governance proposals — allocation strategy change proposals.
 */
export const swfProposals = sqliteTable("swf_proposals", {
  id: text("id").primaryKey(),
  proposer: text("proposer").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  /** JSON-encoded SWFAllocationStrategy */
  proposedStrategy: text("proposed_strategy").notNull(),
  votingStart: text("voting_start").notNull(),
  votingEnd: text("voting_end").notNull(),
  status: text("status").notNull().default("active"),
  yesVotes: real("yes_votes").notNull().default(0),
  noVotes: real("no_votes").notNull().default(0),
  totalVoters: integer("total_voters").notNull().default(0),
  quorumRequired: real("quorum_required").notNull().default(0.3),
  createdAt: text("created_at").notNull(),
});

/**
 * SWF votes — individual votes on governance proposals.
 */
export const swfVotes = sqliteTable("swf_votes", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  participantId: text("participant_id").notNull(),
  vote: text("vote").notNull(),
  weight: real("weight").notNull().default(0),
  votedAt: text("voted_at").notNull(),
});
