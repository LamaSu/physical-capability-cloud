/**
 * DePIN Economics demo fixtures: sample values, not live PCC state.
 *
 * Rendered only in demo mode (lib/demo-mode.ts), under a DemoBanner, by
 * pages/DePINDashboardPage.tsx. No gateway route serves real DePIN state:
 *   - GET /api/treasury/summary, GET /api/certificates and
 *     GET /api/rewards/epochs return records written as literals in
 *     packages/gateway/src/routes/rewards.ts;
 *   - no route lists reward claims (only POST /api/rewards/claims, which
 *     stores nothing, and GET /api/rewards/claims/:claimId over the same
 *     literals).
 * Before implementer-delta moved them here, the page loaded these values into
 * its store on every visit and showed them as the network's treasury,
 * certificates, epochs and claims.
 */

import type {
  CapabilityCertificate,
  RewardEpoch,
  DePINRewardClaim,
  TreasuryBalance,
} from "@pcc/spec";

export const DEMO_TREASURY: TreasuryBalance = {
  agentId: "broker-agent-001",
  chain: "solana",
  balances: [
    { currency: "USDC", amount: "12450.00" },
    { currency: "SOL", amount: "84.25" },
  ],
  totalUsdValue: "24780.50",
  // A fixed time: sample data never claims to be fresh.
  lastUpdated: "2026-03-12T12:00:00Z",
};

export const DEMO_CERTIFICATES: CapabilityCertificate[] = [
  {
    id: "cnft_cert001",
    kernelDid: "did:pcc:kernel:kernel-sovereign-001",
    capabilityType: "fdm",
    assuranceTier: 2,
    metadata: { materials: ["PLA", "PETG"], maxBuildVolume: "250x210x210 mm" },
    mintedAt: "2026-03-01T10:00:00Z",
    soulbound: true,
    status: "active",
    merkleTree: "TreeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    leafIndex: 0,
    assetId: "Assetcnftcert001aaa",
  },
  {
    id: "cnft_cert002",
    kernelDid: "did:pcc:kernel:kernel-midwest-002",
    capabilityType: "cnc-3axis",
    assuranceTier: 3,
    metadata: { materials: ["Aluminum", "Steel"], toleranceSpecs: { xy: "+/-0.01mm" } },
    mintedAt: "2026-02-20T14:30:00Z",
    soulbound: true,
    status: "active",
    merkleTree: "TreeBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    leafIndex: 1,
    assetId: "Assetcnftcert002bbb",
  },
  {
    id: "cnft_cert003",
    kernelDid: "did:pcc:kernel:kernel-east-003",
    capabilityType: "laser-cut",
    assuranceTier: 1,
    metadata: { materials: ["Acrylic", "MDF"] },
    mintedAt: "2026-01-15T08:00:00Z",
    soulbound: true,
    status: "revoked",
    merkleTree: "TreeCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    leafIndex: 2,
    assetId: "Assetcnftcert003ccc",
  },
];

export const DEMO_REWARD_EPOCHS: RewardEpoch[] = [
  {
    id: "epoch_e001",
    epochNumber: 42,
    startTime: "2026-03-01T00:00:00Z",
    endTime: "2026-03-07T23:59:59Z",
    totalRewards: "1000.000000",
    status: "completed",
    kernelScores: [
      {
        kernelId: "kernel-sovereign-001",
        kernelDid: "did:pcc:kernel:kernel-sovereign-001",
        jobsCompleted: 12,
        qualityScore: 0.95,
        uptimePercent: 99.2,
        capabilityDiversity: 2,
        scarcityBonus: 0.8,
        totalScore: 0.8515,
        rewardAmount: "520.123456",
      },
      {
        kernelId: "kernel-midwest-002",
        kernelDid: "did:pcc:kernel:kernel-midwest-002",
        jobsCompleted: 8,
        qualityScore: 0.88,
        uptimePercent: 97.5,
        capabilityDiversity: 1,
        scarcityBonus: 0.4,
        totalScore: 0.6342,
        rewardAmount: "387.654321",
      },
      {
        kernelId: "kernel-east-003",
        kernelDid: "did:pcc:kernel:kernel-east-003",
        jobsCompleted: 3,
        qualityScore: 0.72,
        uptimePercent: 85.0,
        capabilityDiversity: 1,
        scarcityBonus: 0.2,
        totalScore: 0.393,
        rewardAmount: "92.222223",
      },
    ],
  },
  {
    id: "epoch_e002",
    epochNumber: 43,
    startTime: "2026-03-08T00:00:00Z",
    endTime: "2026-03-12T12:00:00Z",
    totalRewards: "1000.000000",
    status: "active",
    kernelScores: [],
  },
];

export const DEMO_REWARD_CLAIMS: DePINRewardClaim[] = [
  {
    id: "claim_c001",
    kernelId: "kernel-sovereign-001",
    epochId: "epoch_e001",
    amount: "520.123456",
    chain: "solana",
    status: "claimed",
    txHash: "5VERy...FaKe",
    claimedAt: "2026-03-08T02:15:00Z",
  },
  {
    id: "claim_c002",
    kernelId: "kernel-midwest-002",
    epochId: "epoch_e001",
    amount: "387.654321",
    chain: "solana",
    status: "pending",
  },
  {
    id: "claim_c003",
    kernelId: "kernel-east-003",
    epochId: "epoch_e001",
    amount: "92.222223",
    chain: "solana",
    status: "failed",
  },
];
