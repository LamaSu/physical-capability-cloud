/**
 * Sovereign Wealth Fund demo fixtures: sample values, not live PCC state.
 *
 * Rendered only in demo mode (lib/demo-mode.ts), under a DemoBanner, by
 * pages/SWFDashboardPage.tsx. Before implementer-delta moved them here, the
 * page always showed this fund: a $48,250 balance, $124,780.50 distributed,
 * 47 participants, two epochs, three accruals, two dividend claims and one
 * active proposal.
 *
 * Outside demo mode the page shows only what the gateway holds as real
 * records (participant and proposal counts, the allocation strategy and
 * active proposals; see lib/swf-live.ts). Its balances, epochs, accruals and
 * claims are not live: the gateway books every milestone release as a fixed
 * 1,000 USDC gross and splits distributions by randomly drawn scores.
 */

import type {
  SWFSummary,
  SWFEpoch,
  SWFAccrual,
  SWFDividendClaim,
  SWFProposal,
  SWFAllocationStrategy,
} from "@pcc/spec";

export const DEMO_SWF_STRATEGY: SWFAllocationStrategy = {
  dividendPercent: 60,
  infrastructurePercent: 25,
  grantsPercent: 10,
  reservePercent: 5,
};

export const DEMO_SWF_SUMMARY: SWFSummary = {
  totalBalance: "48250.00",
  totalDistributedAllTime: "124780.50",
  totalAccruedAllTime: "173030.50",
  currentEpochId: "swf_epoch_0012",
  currentAllocationStrategy: DEMO_SWF_STRATEGY,
  participantCount: 47,
  activeProposals: 2,
  lastDistributionAt: "2026-03-14T00:00:00Z",
  chainBalances: [
    { chain: "base", currency: "USDC", amount: "38250.00" },
    { chain: "solana", currency: "USDC", amount: "10000.00" },
  ],
};

export const DEMO_SWF_EPOCHS: SWFEpoch[] = [
  {
    id: "swf_epoch_0012",
    epochNumber: 12,
    startTime: "2026-03-14T00:00:00Z",
    endTime: "2026-03-21T00:00:00Z",
    totalAccrued: "4280.00",
    totalDistributed: "0",
    allocationStrategy: DEMO_SWF_STRATEGY,
    status: "active",
    participantCount: 47,
    scores: [],
  },
  {
    id: "swf_epoch_0011",
    epochNumber: 11,
    startTime: "2026-03-07T00:00:00Z",
    endTime: "2026-03-14T00:00:00Z",
    totalAccrued: "5120.00",
    totalDistributed: "3072.00",
    allocationStrategy: DEMO_SWF_STRATEGY,
    status: "completed",
    participantCount: 45,
    scores: [],
  },
];

export const DEMO_SWF_ACCRUALS: SWFAccrual[] = [
  {
    id: "swf_acc_0042",
    sourceType: "escrow_release",
    sourceId: "job-789",
    grossAmount: "2500.00",
    accrualBps: 200,
    accrualAmount: "50.00",
    currency: "USDC",
    chain: "base",
    accruedAt: "2026-03-20T14:30:00Z",
    epochId: "swf_epoch_0012",
  },
  {
    id: "swf_acc_0041",
    sourceType: "pool_revenue",
    sourceId: "dist-0018",
    grossAmount: "1200.00",
    accrualBps: 200,
    accrualAmount: "24.00",
    currency: "USDC",
    chain: "base",
    accruedAt: "2026-03-19T10:15:00Z",
    epochId: "swf_epoch_0012",
  },
  {
    id: "swf_acc_0040",
    sourceType: "bounty_fee",
    sourceId: "bounty-005",
    grossAmount: "5000.00",
    accrualBps: 200,
    accrualAmount: "100.00",
    currency: "USDC",
    chain: "base",
    accruedAt: "2026-03-18T16:45:00Z",
    epochId: "swf_epoch_0012",
  },
];

export const DEMO_SWF_CLAIMS: SWFDividendClaim[] = [
  {
    id: "swf_claim_0021",
    participantId: "swf_part_0001",
    epochId: "swf_epoch_0011",
    amount: "68.25",
    chain: "base",
    status: "claimed",
    txHash: "0xabc123...def456",
    claimedAt: "2026-03-15T09:00:00Z",
  },
  {
    id: "swf_claim_0020",
    participantId: "swf_part_0001",
    epochId: "swf_epoch_0010",
    amount: "52.10",
    chain: "base",
    status: "claimed",
    txHash: "0x789abc...123def",
    claimedAt: "2026-03-08T11:30:00Z",
  },
];

export const DEMO_SWF_PROPOSALS: SWFProposal[] = [
  {
    id: "swf_prop_0003",
    proposer: "swf_part_0005",
    title: "Increase dividend allocation to 70%",
    description: "With fund reserves now healthy, propose shifting 10% from infrastructure to direct dividends.",
    proposedStrategy: {
      dividendPercent: 70,
      infrastructurePercent: 15,
      grantsPercent: 10,
      reservePercent: 5,
    },
    votingStart: "2026-03-18T00:00:00Z",
    votingEnd: "2026-03-25T00:00:00Z",
    status: "active",
    yesVotes: 12.5,
    noVotes: 4.2,
    totalVoters: 18,
    quorumRequired: 0.3,
    createdAt: "2026-03-18T00:00:00Z",
  },
];
