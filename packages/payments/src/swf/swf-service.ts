// ---------------------------------------------------------------------------
// Sovereign Wealth Fund Service — In-memory mock implementation
// ---------------------------------------------------------------------------

import type {
  SWFParticipant,
  SWFParticipantRole,
  SWFEpoch,
  SWFAccrual,
  SWFAccrualSource,
  SWFContributionScore,
  SWFDividendClaim,
  SWFProposal,
  SWFVote,
  SWFAllocationStrategy,
  SWFSummary,
  SWFParticipantDashboard,
} from "@pcc/spec";

import {
  type SWFConfig,
  type ParticipantEpochInput,
  DEFAULT_SWF_CONFIG,
  SWF_SCORE_WEIGHTS,
} from "./types.js";

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let nextPartId = 1;
let nextEpochId = 1;
let nextAccrualId = 1;
let nextClaimId = 1;
let nextProposalId = 1;
let nextVoteId = 1;
let nextScoreId = 1;

function genPartId(): string {
  return `swf_part_${String(nextPartId++).padStart(4, "0")}`;
}
function genEpochId(): string {
  return `swf_epoch_${String(nextEpochId++).padStart(4, "0")}`;
}
function genAccrualId(): string {
  return `swf_acc_${String(nextAccrualId++).padStart(4, "0")}`;
}
function genClaimId(): string {
  return `swf_claim_${String(nextClaimId++).padStart(4, "0")}`;
}
function genProposalId(): string {
  return `swf_prop_${String(nextProposalId++).padStart(4, "0")}`;
}
function genVoteId(): string {
  return `swf_vote_${String(nextVoteId++).padStart(4, "0")}`;
}
function genScoreId(): string {
  return `swf_score_${String(nextScoreId++).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// SWFService
// ---------------------------------------------------------------------------

export class SWFService {
  private participants = new Map<string, SWFParticipant>();
  private epochs = new Map<string, SWFEpoch>();
  private accruals = new Map<string, SWFAccrual>();
  private claims = new Map<string, SWFDividendClaim>();
  private proposals = new Map<string, SWFProposal>();
  private votes = new Map<string, SWFVote>();

  private config: SWFConfig;
  private currentStrategy: SWFAllocationStrategy;

  constructor(config?: Partial<SWFConfig>) {
    this.config = { ...DEFAULT_SWF_CONFIG, ...config };
    this.currentStrategy = { ...this.config.defaultAllocationStrategy };
  }

  // ── Participant Management ──────────────────────────────────────

  registerParticipant(params: {
    did: string;
    walletAddress: string;
    role: SWFParticipantRole;
  }): SWFParticipant {
    // Prevent duplicate registration by DID
    for (const p of this.participants.values()) {
      if (p.did === params.did && p.status !== "withdrawn") {
        return p;
      }
    }

    const participant: SWFParticipant = {
      id: genPartId(),
      did: params.did,
      walletAddress: params.walletAddress,
      role: params.role,
      registeredAt: new Date().toISOString(),
      status: "active",
    };

    this.participants.set(participant.id, participant);
    return participant;
  }

  suspendParticipant(participantId: string): SWFParticipant {
    const p = this.participants.get(participantId);
    if (!p) throw new Error(`Participant ${participantId} not found`);
    if (p.status !== "active") {
      throw new Error(`Participant ${participantId} is not active (status: ${p.status})`);
    }
    p.status = "suspended";
    return p;
  }

  withdrawParticipant(participantId: string): SWFParticipant {
    const p = this.participants.get(participantId);
    if (!p) throw new Error(`Participant ${participantId} not found`);
    p.status = "withdrawn";
    return p;
  }

  getParticipant(id: string): SWFParticipant | null {
    return this.participants.get(id) ?? null;
  }

  findParticipantByDid(did: string): SWFParticipant | null {
    for (const p of this.participants.values()) {
      if (p.did === did && p.status !== "withdrawn") return p;
    }
    return null;
  }

  listParticipants(filter?: {
    role?: SWFParticipantRole;
    status?: SWFParticipant["status"];
  }): SWFParticipant[] {
    let result = [...this.participants.values()];
    if (filter?.role) result = result.filter((p) => p.role === filter.role);
    if (filter?.status) result = result.filter((p) => p.status === filter.status);
    return result;
  }

  // ── Accrual ─────────────────────────────────────────────────────

  accrue(params: {
    sourceType: SWFAccrualSource;
    sourceId: string;
    grossAmount: number;
    currency?: "USDC" | "CREDITS";
    chain?: string;
    epochId: string;
  }): SWFAccrual {
    const epoch = this.epochs.get(params.epochId);
    if (!epoch) throw new Error(`Epoch ${params.epochId} not found`);
    if (epoch.status !== "active") {
      throw new Error(`Epoch ${params.epochId} is not active (status: ${epoch.status})`);
    }

    const accrualAmount = (params.grossAmount * this.config.accrualBps) / 10_000;

    const accrual: SWFAccrual = {
      id: genAccrualId(),
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      grossAmount: String(params.grossAmount),
      accrualBps: this.config.accrualBps,
      accrualAmount: String(accrualAmount),
      currency: params.currency ?? "USDC",
      chain: params.chain ?? "base",
      accruedAt: new Date().toISOString(),
      epochId: params.epochId,
    };

    this.accruals.set(accrual.id, accrual);

    // Update epoch total
    epoch.totalAccrued = String(Number(epoch.totalAccrued) + accrualAmount);

    return accrual;
  }

  getAccrualsForEpoch(epochId: string): SWFAccrual[] {
    return [...this.accruals.values()].filter((a) => a.epochId === epochId);
  }

  // ── Epoch Lifecycle ─────────────────────────────────────────────

  createEpoch(): SWFEpoch {
    const now = new Date();
    const end = new Date(now.getTime() + this.config.epochDurationDays * 86_400_000);

    const epoch: SWFEpoch = {
      id: genEpochId(),
      epochNumber: this.epochs.size + 1,
      startTime: now.toISOString(),
      endTime: end.toISOString(),
      totalAccrued: "0",
      totalDistributed: "0",
      allocationStrategy: { ...this.currentStrategy },
      status: "active",
      participantCount: 0,
      scores: [],
    };

    this.epochs.set(epoch.id, epoch);
    return epoch;
  }

  getEpoch(epochId: string): SWFEpoch | null {
    return this.epochs.get(epochId) ?? null;
  }

  listEpochs(filter?: { status?: SWFEpoch["status"] }): SWFEpoch[] {
    let result = [...this.epochs.values()];
    if (filter?.status) result = result.filter((e) => e.status === filter.status);
    return result;
  }

  getActiveEpoch(): SWFEpoch | null {
    for (const e of this.epochs.values()) {
      if (e.status === "active") return e;
    }
    return null;
  }

  calculateContributionScores(
    epochId: string,
    inputs: ParticipantEpochInput[],
  ): SWFContributionScore[] {
    const epoch = this.epochs.get(epochId);
    if (!epoch) throw new Error(`Epoch ${epochId} not found`);

    epoch.status = "calculating";

    // Normalize inputs and calculate raw scores
    const maxJobs = Math.max(1, ...inputs.map((i) => i.jobCount));
    const maxRep = 1000; // ERC-8004 max
    const maxUptime = 100;
    const maxTenure = 730; // 2 years cap

    const rawScores = inputs.map((input) => {
      const jobVolume = input.jobCount / maxJobs;
      const reputationScore = input.reputation / maxRep;
      const uptimeOrActivity = input.uptimeOrActivity / maxUptime;
      const tenureFactor = Math.min(input.tenureDays / maxTenure, 1);
      const governanceParticipation = input.votedThisEpoch ? 1 : 0;

      const totalScore =
        jobVolume * SWF_SCORE_WEIGHTS.jobVolume +
        reputationScore * SWF_SCORE_WEIGHTS.reputationScore +
        uptimeOrActivity * SWF_SCORE_WEIGHTS.uptimeOrActivity +
        tenureFactor * SWF_SCORE_WEIGHTS.tenureFactor +
        governanceParticipation * SWF_SCORE_WEIGHTS.governanceParticipation;

      return {
        participantId: input.participantId,
        epochId,
        jobVolume,
        reputationScore,
        uptimeOrActivity,
        tenureFactor,
        governanceParticipation,
        totalScore,
        shareOfEpoch: 0, // filled below
      };
    });

    // Calculate shares
    const totalAllScores = rawScores.reduce((sum, s) => sum + s.totalScore, 0);
    const scores: SWFContributionScore[] = rawScores.map((s) => ({
      ...s,
      shareOfEpoch: totalAllScores > 0 ? s.totalScore / totalAllScores : 0,
    }));

    epoch.scores = scores;
    epoch.participantCount = scores.length;

    return scores;
  }

  distributeEpoch(epochId: string): SWFEpoch {
    const epoch = this.epochs.get(epochId);
    if (!epoch) throw new Error(`Epoch ${epochId} not found`);
    if (epoch.status !== "calculating") {
      throw new Error(
        `Epoch ${epochId} must be in calculating status to distribute (status: ${epoch.status})`,
      );
    }
    if (epoch.scores.length === 0) {
      throw new Error(`Epoch ${epochId} has no scores — run calculateContributionScores first`);
    }

    epoch.status = "distributing";

    const totalAccrued = Number(epoch.totalAccrued);
    const dividendPool =
      (totalAccrued * epoch.allocationStrategy.dividendPercent) / 100;

    // Create pending claims for each participant
    for (const score of epoch.scores) {
      if (score.shareOfEpoch <= 0) continue;

      const amount = dividendPool * score.shareOfEpoch;
      if (amount <= 0) continue;

      const claim: SWFDividendClaim = {
        id: genClaimId(),
        participantId: score.participantId,
        epochId,
        amount: String(amount),
        chain: "base",
        status: "pending",
      };

      this.claims.set(claim.id, claim);
    }

    epoch.totalDistributed = String(dividendPool);
    epoch.status = "completed";

    return epoch;
  }

  // ── Claims ──────────────────────────────────────────────────────

  submitClaim(claimId: string, chain?: string): SWFDividendClaim {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim ${claimId} not found`);
    if (claim.status !== "pending") {
      throw new Error(`Claim ${claimId} is not pending (status: ${claim.status})`);
    }
    if (chain) claim.chain = chain;
    return claim;
  }

  settleClaim(claimId: string, txHash: string): SWFDividendClaim {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim ${claimId} not found`);
    if (claim.status !== "pending") {
      throw new Error(`Claim ${claimId} is not pending (status: ${claim.status})`);
    }
    claim.status = "claimed";
    claim.txHash = txHash;
    claim.claimedAt = new Date().toISOString();
    return claim;
  }

  failClaim(claimId: string): SWFDividendClaim {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim ${claimId} not found`);
    claim.status = "failed";
    return claim;
  }

  getClaimsForParticipant(participantId: string): SWFDividendClaim[] {
    return [...this.claims.values()].filter((c) => c.participantId === participantId);
  }

  getClaimsForEpoch(epochId: string): SWFDividendClaim[] {
    return [...this.claims.values()].filter((c) => c.epochId === epochId);
  }

  // ── Governance ──────────────────────────────────────────────────

  createProposal(params: {
    proposer: string;
    title: string;
    description: string;
    proposedStrategy: SWFAllocationStrategy;
  }): SWFProposal {
    const p = this.participants.get(params.proposer);
    if (!p) throw new Error(`Participant ${params.proposer} not found`);
    if (p.status !== "active") {
      throw new Error(`Participant ${params.proposer} is not active`);
    }

    // Validate strategy sums to 100
    const sum =
      params.proposedStrategy.dividendPercent +
      params.proposedStrategy.infrastructurePercent +
      params.proposedStrategy.grantsPercent +
      params.proposedStrategy.reservePercent;
    if (sum !== 100) {
      throw new Error(`Allocation strategy must sum to 100 (got ${sum})`);
    }

    // Check tenure
    const tenureDays =
      (Date.now() - new Date(p.registeredAt).getTime()) / 86_400_000;
    if (tenureDays < this.config.minTenureForVotingDays) {
      throw new Error(
        `Participant must have at least ${this.config.minTenureForVotingDays} days tenure to create proposals (has ${Math.floor(tenureDays)})`,
      );
    }

    const now = new Date();
    const votingEnd = new Date(
      now.getTime() + this.config.proposalDurationDays * 86_400_000,
    );

    const proposal: SWFProposal = {
      id: genProposalId(),
      proposer: params.proposer,
      title: params.title,
      description: params.description,
      proposedStrategy: params.proposedStrategy,
      votingStart: now.toISOString(),
      votingEnd: votingEnd.toISOString(),
      status: "active",
      yesVotes: 0,
      noVotes: 0,
      totalVoters: 0,
      quorumRequired: this.config.quorumRequired,
      createdAt: now.toISOString(),
    };

    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  castVote(params: {
    proposalId: string;
    participantId: string;
    vote: "yes" | "no" | "abstain";
    weight?: number;
  }): SWFVote {
    const proposal = this.proposals.get(params.proposalId);
    if (!proposal) throw new Error(`Proposal ${params.proposalId} not found`);
    if (proposal.status !== "active") {
      throw new Error(`Proposal ${params.proposalId} is not active (status: ${proposal.status})`);
    }

    const participant = this.participants.get(params.participantId);
    if (!participant) throw new Error(`Participant ${params.participantId} not found`);
    if (participant.status !== "active") {
      throw new Error(`Participant ${params.participantId} is not active`);
    }

    // Prevent double voting
    for (const v of this.votes.values()) {
      if (v.proposalId === params.proposalId && v.participantId === params.participantId) {
        throw new Error(`Participant ${params.participantId} already voted on proposal ${params.proposalId}`);
      }
    }

    const weight = params.weight ?? 1;

    const vote: SWFVote = {
      id: genVoteId(),
      proposalId: params.proposalId,
      participantId: params.participantId,
      vote: params.vote,
      weight,
      votedAt: new Date().toISOString(),
    };

    this.votes.set(vote.id, vote);

    // Update proposal tallies
    if (params.vote === "yes") proposal.yesVotes += weight;
    if (params.vote === "no") proposal.noVotes += weight;
    proposal.totalVoters++;

    return vote;
  }

  tallyProposal(proposalId: string): SWFProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
    if (proposal.status !== "active") {
      throw new Error(`Proposal ${proposalId} is not active (status: ${proposal.status})`);
    }

    const eligibleCount = this.listParticipants({ status: "active" }).length;
    const quorumMet = eligibleCount > 0 &&
      proposal.totalVoters / eligibleCount >= proposal.quorumRequired;

    if (!quorumMet) {
      proposal.status = "rejected";
      return proposal;
    }

    proposal.status = proposal.yesVotes > proposal.noVotes ? "passed" : "rejected";
    return proposal;
  }

  executeProposal(proposalId: string): SWFProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
    if (proposal.status !== "passed") {
      throw new Error(
        `Proposal ${proposalId} must be passed to execute (status: ${proposal.status})`,
      );
    }

    this.currentStrategy = { ...proposal.proposedStrategy };
    proposal.status = "executed";
    return proposal;
  }

  listProposals(filter?: {
    status?: SWFProposal["status"];
  }): SWFProposal[] {
    let result = [...this.proposals.values()];
    if (filter?.status) result = result.filter((p) => p.status === filter.status);
    return result;
  }

  getProposal(proposalId: string): SWFProposal | null {
    return this.proposals.get(proposalId) ?? null;
  }

  getVotesForProposal(proposalId: string): SWFVote[] {
    return [...this.votes.values()].filter((v) => v.proposalId === proposalId);
  }

  // ── Summary & Dashboard ─────────────────────────────────────────

  getSummary(): SWFSummary {
    let totalAccrued = 0;
    let totalDistributed = 0;
    let lastDistributionAt = "";

    for (const epoch of this.epochs.values()) {
      totalAccrued += Number(epoch.totalAccrued);
      totalDistributed += Number(epoch.totalDistributed);
      if (epoch.status === "completed" && epoch.endTime > lastDistributionAt) {
        lastDistributionAt = epoch.endTime;
      }
    }

    const activeEpoch = this.getActiveEpoch();
    const activeProposals = this.listProposals({ status: "active" }).length;
    const balance = totalAccrued - totalDistributed;

    return {
      totalBalance: String(balance),
      totalDistributedAllTime: String(totalDistributed),
      totalAccruedAllTime: String(totalAccrued),
      currentEpochId: activeEpoch?.id ?? "",
      currentAllocationStrategy: { ...this.currentStrategy },
      participantCount: this.listParticipants({ status: "active" }).length,
      activeProposals,
      lastDistributionAt: lastDistributionAt || new Date().toISOString(),
      chainBalances: [
        { chain: "base", currency: "USDC", amount: String(balance) },
      ],
    };
  }

  getParticipantDashboard(participantId: string): SWFParticipantDashboard {
    const participant = this.participants.get(participantId);
    if (!participant) throw new Error(`Participant ${participantId} not found`);

    const claims = this.getClaimsForParticipant(participantId);
    const totalEarned = claims
      .filter((c) => c.status === "claimed")
      .reduce((sum, c) => sum + Number(c.amount), 0);
    const pendingDividends = claims
      .filter((c) => c.status === "pending")
      .reduce((sum, c) => sum + Number(c.amount), 0);

    // Count epochs participated in
    let epochCount = 0;
    for (const epoch of this.epochs.values()) {
      if (epoch.scores.some((s) => s.participantId === participantId)) {
        epochCount++;
      }
    }

    // Voting history
    const votingHistory = [...this.votes.values()].filter(
      (v) => v.participantId === participantId,
    );

    return {
      participant,
      totalEarned: String(totalEarned),
      pendingDividends: String(pendingDividends),
      epochCount,
      claims,
      votingHistory,
    };
  }

  // ── Accessors ───────────────────────────────────────────────────

  getCurrentStrategy(): SWFAllocationStrategy {
    return { ...this.currentStrategy };
  }

  getConfig(): SWFConfig {
    return { ...this.config };
  }
}
