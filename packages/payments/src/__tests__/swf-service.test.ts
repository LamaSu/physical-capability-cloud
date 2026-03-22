// ---------------------------------------------------------------------------
// SWFService — comprehensive test suite
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { SWFService } from "../swf/swf-service.js";
import type { ParticipantEpochInput } from "../swf/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(overrides?: Partial<import("../swf/types.js").SWFConfig>) {
  return new SWFService(overrides);
}

/** Register a participant and return it. */
function reg(
  svc: SWFService,
  did = "did:key:operator1",
  walletAddress = "0xAAA",
  role: Parameters<SWFService["registerParticipant"]>[0]["role"] = "operator",
) {
  return svc.registerParticipant({ did, walletAddress, role });
}

// ---------------------------------------------------------------------------
// Participant Management
// ---------------------------------------------------------------------------

describe("Participant management", () => {
  let svc: SWFService;

  beforeEach(() => {
    svc = makeService();
  });

  it("registers a new participant with active status", () => {
    const p = reg(svc);
    expect(p.id).toMatch(/^swf_part_/);
    expect(p.did).toBe("did:key:operator1");
    expect(p.walletAddress).toBe("0xAAA");
    expect(p.role).toBe("operator");
    expect(p.status).toBe("active");
    expect(p.registeredAt).toBeTruthy();
  });

  it("is idempotent by DID — returns same participant on duplicate register", () => {
    const a = reg(svc, "did:key:alice");
    const b = reg(svc, "did:key:alice");
    expect(b.id).toBe(a.id);
  });

  it("allows re-registration after withdrawal (withdrawn DID is not deduped)", () => {
    const a = reg(svc, "did:key:bob");
    svc.withdrawParticipant(a.id);
    const b = reg(svc, "did:key:bob");
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe("active");
  });

  it("suspends an active participant", () => {
    const p = reg(svc, "did:key:suspend-me");
    const updated = svc.suspendParticipant(p.id);
    expect(updated.status).toBe("suspended");
    expect(svc.getParticipant(p.id)!.status).toBe("suspended");
  });

  it("throws when suspending a non-active participant", () => {
    const p = reg(svc, "did:key:already-sus");
    svc.suspendParticipant(p.id);
    expect(() => svc.suspendParticipant(p.id)).toThrow(/not active/);
  });

  it("throws when suspending unknown participant", () => {
    expect(() => svc.suspendParticipant("swf_part_9999")).toThrow(/not found/);
  });

  it("withdraws a participant", () => {
    const p = reg(svc, "did:key:withdraw-me");
    const updated = svc.withdrawParticipant(p.id);
    expect(updated.status).toBe("withdrawn");
    expect(svc.getParticipant(p.id)!.status).toBe("withdrawn");
  });

  it("getParticipant returns null for unknown id", () => {
    expect(svc.getParticipant("swf_part_0000")).toBeNull();
  });

  it("findParticipantByDid locates active participant", () => {
    const p = reg(svc, "did:key:find-me");
    const found = svc.findParticipantByDid("did:key:find-me");
    expect(found?.id).toBe(p.id);
  });

  it("findParticipantByDid returns null for withdrawn participant", () => {
    const p = reg(svc, "did:key:bye");
    svc.withdrawParticipant(p.id);
    expect(svc.findParticipantByDid("did:key:bye")).toBeNull();
  });

  it("findParticipantByDid returns null when DID not registered", () => {
    expect(svc.findParticipantByDid("did:key:nobody")).toBeNull();
  });

  it("listParticipants returns all participants", () => {
    reg(svc, "did:key:p1");
    reg(svc, "did:key:p2");
    expect(svc.listParticipants()).toHaveLength(2);
  });

  it("listParticipants filters by role", () => {
    reg(svc, "did:key:op1", "0xA", "operator");
    reg(svc, "did:key:usr1", "0xB", "user");
    reg(svc, "did:key:op2", "0xC", "operator");

    const operators = svc.listParticipants({ role: "operator" });
    expect(operators).toHaveLength(2);
    operators.forEach((p) => expect(p.role).toBe("operator"));
  });

  it("listParticipants filters by status", () => {
    const p1 = reg(svc, "did:key:f1");
    const p2 = reg(svc, "did:key:f2");
    reg(svc, "did:key:f3");
    svc.suspendParticipant(p1.id);
    svc.withdrawParticipant(p2.id);

    expect(svc.listParticipants({ status: "active" })).toHaveLength(1);
    expect(svc.listParticipants({ status: "suspended" })).toHaveLength(1);
    expect(svc.listParticipants({ status: "withdrawn" })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Epochs
// ---------------------------------------------------------------------------

describe("Epochs", () => {
  let svc: SWFService;

  beforeEach(() => {
    svc = makeService();
  });

  it("creates an epoch with active status", () => {
    const epoch = svc.createEpoch();
    expect(epoch.id).toMatch(/^swf_epoch_/);
    expect(epoch.status).toBe("active");
    expect(epoch.epochNumber).toBe(1);
    expect(epoch.totalAccrued).toBe("0");
    expect(epoch.totalDistributed).toBe("0");
    expect(epoch.scores).toHaveLength(0);
  });

  it("sequential epochs get increasing epoch numbers", () => {
    const e1 = svc.createEpoch();
    const e2 = svc.createEpoch();
    expect(e1.epochNumber).toBe(1);
    expect(e2.epochNumber).toBe(2);
  });

  it("getActiveEpoch returns the active epoch", () => {
    const epoch = svc.createEpoch();
    const active = svc.getActiveEpoch();
    expect(active?.id).toBe(epoch.id);
  });

  it("getActiveEpoch returns null when none exist", () => {
    expect(svc.getActiveEpoch()).toBeNull();
  });

  it("listEpochs filters by status", () => {
    const e1 = svc.createEpoch();
    svc.createEpoch(); // second epoch stays active

    // Push e1 through the lifecycle
    const p = reg(svc, "did:key:ep-list");
    svc.calculateContributionScores(e1.id, [
      {
        participantId: p.id,
        jobCount: 10,
        reputation: 500,
        uptimeOrActivity: 80,
        tenureDays: 90,
        votedThisEpoch: false,
      },
    ]);
    svc.distributeEpoch(e1.id);

    expect(svc.listEpochs({ status: "active" })).toHaveLength(1);
    expect(svc.listEpochs({ status: "completed" })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Accruals
// ---------------------------------------------------------------------------

describe("Accruals", () => {
  let svc: SWFService;
  let epochId: string;

  beforeEach(() => {
    svc = makeService();
    epochId = svc.createEpoch().id;
  });

  it("accrues 2% of gross amount by default (200 bps)", () => {
    const accrual = svc.accrue({
      sourceType: "protocol_fee",
      sourceId: "job_001",
      grossAmount: 1000,
      epochId,
    });

    expect(accrual.id).toMatch(/^swf_acc_/);
    expect(accrual.grossAmount).toBe("1000");
    expect(accrual.accrualBps).toBe(200);
    expect(accrual.accrualAmount).toBe("20");
    expect(accrual.currency).toBe("USDC");
    expect(accrual.chain).toBe("base");
    expect(accrual.epochId).toBe(epochId);
  });

  it("updates epoch totalAccrued after accrual", () => {
    svc.accrue({ sourceType: "protocol_fee", sourceId: "j1", grossAmount: 500, epochId });
    svc.accrue({ sourceType: "escrow_release", sourceId: "j2", grossAmount: 1000, epochId });

    const epoch = svc.getEpoch(epochId)!;
    // 500*0.02 + 1000*0.02 = 10 + 20 = 30
    expect(Number(epoch.totalAccrued)).toBeCloseTo(30, 5);
  });

  it("respects custom accrualBps config", () => {
    const svc2 = makeService({ accrualBps: 100 }); // 1%
    const eid = svc2.createEpoch().id;
    const acc = svc2.accrue({ sourceType: "settlement", sourceId: "s1", grossAmount: 2000, epochId: eid });
    expect(acc.accrualAmount).toBe("20");
  });

  it("accepts custom currency and chain", () => {
    const acc = svc.accrue({
      sourceType: "bounty_fee",
      sourceId: "b1",
      grossAmount: 100,
      currency: "CREDITS",
      chain: "solana",
      epochId,
    });
    expect(acc.currency).toBe("CREDITS");
    expect(acc.chain).toBe("solana");
  });

  it("throws when epoch not found", () => {
    expect(() =>
      svc.accrue({ sourceType: "protocol_fee", sourceId: "x", grossAmount: 100, epochId: "swf_epoch_9999" })
    ).toThrow(/not found/);
  });

  it("throws when epoch is not active", () => {
    const p = reg(svc);
    svc.calculateContributionScores(epochId, [
      { participantId: p.id, jobCount: 1, reputation: 100, uptimeOrActivity: 50, tenureDays: 10, votedThisEpoch: false },
    ]);
    svc.distributeEpoch(epochId);

    expect(() =>
      svc.accrue({ sourceType: "protocol_fee", sourceId: "x", grossAmount: 100, epochId })
    ).toThrow(/not active/);
  });

  it("getAccrualsForEpoch returns accruals for specific epoch", () => {
    const e2 = svc.createEpoch().id;
    svc.accrue({ sourceType: "protocol_fee", sourceId: "a1", grossAmount: 100, epochId });
    svc.accrue({ sourceType: "protocol_fee", sourceId: "a2", grossAmount: 200, epochId });
    svc.accrue({ sourceType: "settlement", sourceId: "a3", grossAmount: 300, epochId: e2 });

    expect(svc.getAccrualsForEpoch(epochId)).toHaveLength(2);
    expect(svc.getAccrualsForEpoch(e2)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Contribution Scores
// ---------------------------------------------------------------------------

describe("Contribution scores", () => {
  let svc: SWFService;
  let epochId: string;
  let p1Id: string;
  let p2Id: string;
  let p3Id: string;

  beforeEach(() => {
    svc = makeService();
    epochId = svc.createEpoch().id;
    p1Id = reg(svc, "did:key:scorer1").id;
    p2Id = reg(svc, "did:key:scorer2").id;
    p3Id = reg(svc, "did:key:scorer3").id;
  });

  const baseInputs = (ids: string[]): ParticipantEpochInput[] =>
    ids.map((id, i) => ({
      participantId: id,
      jobCount: (i + 1) * 10,
      reputation: (i + 1) * 200,
      uptimeOrActivity: 70,
      tenureDays: 100,
      votedThisEpoch: i === 0,
    }));

  it("returns one score per input", () => {
    const scores = svc.calculateContributionScores(epochId, baseInputs([p1Id, p2Id, p3Id]));
    expect(scores).toHaveLength(3);
  });

  it("transitions epoch to calculating status", () => {
    svc.calculateContributionScores(epochId, baseInputs([p1Id]));
    expect(svc.getEpoch(epochId)!.status).toBe("calculating");
  });

  it("shareOfEpoch values sum to approximately 1.0", () => {
    const scores = svc.calculateContributionScores(epochId, baseInputs([p1Id, p2Id, p3Id]));
    const total = scores.reduce((s, sc) => s + sc.shareOfEpoch, 0);
    expect(total).toBeCloseTo(1.0, 5);
  });

  it("higher metrics produce higher scores", () => {
    const inputs: ParticipantEpochInput[] = [
      { participantId: p1Id, jobCount: 5, reputation: 100, uptimeOrActivity: 20, tenureDays: 10, votedThisEpoch: false },
      { participantId: p2Id, jobCount: 50, reputation: 900, uptimeOrActivity: 95, tenureDays: 700, votedThisEpoch: true },
    ];
    const scores = svc.calculateContributionScores(epochId, inputs);
    const s1 = scores.find((s) => s.participantId === p1Id)!;
    const s2 = scores.find((s) => s.participantId === p2Id)!;
    expect(s2.totalScore).toBeGreaterThan(s1.totalScore);
  });

  it("tenureFactor is capped at 1 (2 years)", () => {
    const scores = svc.calculateContributionScores(epochId, [
      { participantId: p1Id, jobCount: 1, reputation: 0, uptimeOrActivity: 0, tenureDays: 10000, votedThisEpoch: false },
    ]);
    expect(scores[0].tenureFactor).toBeLessThanOrEqual(1);
  });

  it("governanceParticipation is 1 when voted, 0 otherwise", () => {
    const scores = svc.calculateContributionScores(epochId, [
      { participantId: p1Id, jobCount: 10, reputation: 500, uptimeOrActivity: 50, tenureDays: 100, votedThisEpoch: true },
      { participantId: p2Id, jobCount: 10, reputation: 500, uptimeOrActivity: 50, tenureDays: 100, votedThisEpoch: false },
    ]);
    expect(scores.find((s) => s.participantId === p1Id)!.governanceParticipation).toBe(1);
    expect(scores.find((s) => s.participantId === p2Id)!.governanceParticipation).toBe(0);
  });

  it("single participant gets shareOfEpoch = 1.0", () => {
    const scores = svc.calculateContributionScores(epochId, [
      { participantId: p1Id, jobCount: 10, reputation: 500, uptimeOrActivity: 80, tenureDays: 90, votedThisEpoch: false },
    ]);
    expect(scores[0].shareOfEpoch).toBeCloseTo(1.0, 5);
  });

  it("throws when epoch not found", () => {
    expect(() =>
      svc.calculateContributionScores("swf_epoch_9999", [])
    ).toThrow(/not found/);
  });

  it("stores scores on the epoch", () => {
    const scores = svc.calculateContributionScores(epochId, baseInputs([p1Id, p2Id]));
    const epoch = svc.getEpoch(epochId)!;
    expect(epoch.scores).toHaveLength(2);
    expect(epoch.participantCount).toBe(2);
    expect(epoch.scores[0].epochId).toBe(epochId);
  });
});

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

describe("Distribution", () => {
  let svc: SWFService;
  let epochId: string;
  let p1Id: string;
  let p2Id: string;

  beforeEach(() => {
    svc = makeService();
    epochId = svc.createEpoch().id;
    p1Id = reg(svc, "did:key:dist1").id;
    p2Id = reg(svc, "did:key:dist2").id;

    // Accrue some funds
    svc.accrue({ sourceType: "protocol_fee", sourceId: "j1", grossAmount: 10000, epochId });
    // totalAccrued = 200 USDC

    // Score
    svc.calculateContributionScores(epochId, [
      { participantId: p1Id, jobCount: 10, reputation: 500, uptimeOrActivity: 80, tenureDays: 100, votedThisEpoch: false },
      { participantId: p2Id, jobCount: 5, reputation: 250, uptimeOrActivity: 40, tenureDays: 50, votedThisEpoch: false },
    ]);
  });

  it("distributes epoch and sets status to completed", () => {
    const epoch = svc.distributeEpoch(epochId);
    expect(epoch.status).toBe("completed");
  });

  it("creates pending claims for each participant", () => {
    svc.distributeEpoch(epochId);
    const claims1 = svc.getClaimsForParticipant(p1Id);
    const claims2 = svc.getClaimsForParticipant(p2Id);
    expect(claims1).toHaveLength(1);
    expect(claims2).toHaveLength(1);
    expect(claims1[0].status).toBe("pending");
    expect(claims2[0].status).toBe("pending");
  });

  it("total claims amount equals dividendPool (60% of totalAccrued by default)", () => {
    svc.distributeEpoch(epochId);
    const allClaims = svc.getClaimsForEpoch(epochId);
    const totalClaimed = allClaims.reduce((s, c) => s + Number(c.amount), 0);

    // totalAccrued = 200, dividendPercent = 60% → pool = 120
    expect(totalClaimed).toBeCloseTo(120, 5);
  });

  it("epoch totalDistributed reflects the dividend pool", () => {
    const epoch = svc.distributeEpoch(epochId);
    expect(Number(epoch.totalDistributed)).toBeCloseTo(120, 5);
  });

  it("throws when distributing an epoch not in calculating status", () => {
    // Still active (no calculateContributionScores ran yet in this test)
    const e2 = svc.createEpoch().id;
    expect(() => svc.distributeEpoch(e2)).toThrow(/calculating/);
  });

  it("throws when distributing already-completed epoch", () => {
    svc.distributeEpoch(epochId);
    expect(() => svc.distributeEpoch(epochId)).toThrow(/calculating/);
  });

  it("throws when no scores present", () => {
    // Manually transition a new epoch to calculating without scores via
    // an empty inputs array — service will set status to calculating but no scores
    const e3 = svc.createEpoch().id;
    svc.calculateContributionScores(e3, []); // empty inputs → calculating, no scores
    // Should throw because scores.length === 0
    expect(() => svc.distributeEpoch(e3)).toThrow(/no scores/);
  });

  it("claims belong to correct epoch", () => {
    svc.distributeEpoch(epochId);
    const claims = svc.getClaimsForEpoch(epochId);
    claims.forEach((c) => expect(c.epochId).toBe(epochId));
  });
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

describe("Claims", () => {
  let svc: SWFService;
  let epochId: string;
  let pId: string;
  let claimId: string;

  beforeEach(() => {
    svc = makeService();
    epochId = svc.createEpoch().id;
    pId = reg(svc, "did:key:claimant").id;

    svc.accrue({ sourceType: "protocol_fee", sourceId: "j1", grossAmount: 5000, epochId });

    svc.calculateContributionScores(epochId, [
      { participantId: pId, jobCount: 5, reputation: 400, uptimeOrActivity: 70, tenureDays: 60, votedThisEpoch: false },
    ]);

    svc.distributeEpoch(epochId);
    claimId = svc.getClaimsForParticipant(pId)[0].id;
  });

  it("pending claim has correct fields", () => {
    const claim = svc.getClaimsForParticipant(pId)[0];
    expect(claim.id).toMatch(/^swf_claim_/);
    expect(claim.participantId).toBe(pId);
    expect(claim.epochId).toBe(epochId);
    expect(claim.status).toBe("pending");
    expect(Number(claim.amount)).toBeGreaterThan(0);
  });

  it("settleClaim transitions to claimed and sets txHash", () => {
    const settled = svc.settleClaim(claimId, "0xdeadbeef");
    expect(settled.status).toBe("claimed");
    expect(settled.txHash).toBe("0xdeadbeef");
    expect(settled.claimedAt).toBeTruthy();
  });

  it("failClaim transitions to failed", () => {
    const failed = svc.failClaim(claimId);
    expect(failed.status).toBe("failed");
  });

  it("settleClaim throws when claim already settled", () => {
    svc.settleClaim(claimId, "0xaaa");
    expect(() => svc.settleClaim(claimId, "0xbbb")).toThrow(/not pending/);
  });

  it("settleClaim throws when claim not found", () => {
    expect(() => svc.settleClaim("swf_claim_9999", "0x1")).toThrow(/not found/);
  });

  it("failClaim throws when claim not found", () => {
    expect(() => svc.failClaim("swf_claim_9999")).toThrow(/not found/);
  });

  it("getClaimsForParticipant returns only that participant's claims", () => {
    const p2 = reg(svc, "did:key:claimant2").id;
    const claims = svc.getClaimsForParticipant(p2);
    expect(claims).toHaveLength(0);

    const mine = svc.getClaimsForParticipant(pId);
    expect(mine).toHaveLength(1);
  });

  it("submitClaim keeps status pending but updates chain", () => {
    const submitted = svc.submitClaim(claimId, "solana");
    expect(submitted.status).toBe("pending");
    expect(submitted.chain).toBe("solana");
  });

  it("submitClaim throws when claim already claimed", () => {
    svc.settleClaim(claimId, "0xccc");
    expect(() => svc.submitClaim(claimId)).toThrow(/not pending/);
  });
});

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

describe("Governance", () => {
  // Use minTenureForVotingDays: 0 so tests don't need to wait 30 days
  let svc: SWFService;
  let proposerId: string;
  let voter1Id: string;
  let voter2Id: string;
  let voter3Id: string;

  const newStrategy = {
    dividendPercent: 50,
    infrastructurePercent: 30,
    grantsPercent: 15,
    reservePercent: 5,
  };

  beforeEach(() => {
    svc = makeService({ minTenureForVotingDays: 0 });
    proposerId = reg(svc, "did:key:proposer").id;
    voter1Id = reg(svc, "did:key:voter1").id;
    voter2Id = reg(svc, "did:key:voter2").id;
    voter3Id = reg(svc, "did:key:voter3").id;
  });

  // ── Proposal creation

  it("creates a proposal with active status", () => {
    const prop = svc.createProposal({
      proposer: proposerId,
      title: "Boost infra",
      description: "More infra spending",
      proposedStrategy: newStrategy,
    });
    expect(prop.id).toMatch(/^swf_prop_/);
    expect(prop.status).toBe("active");
    expect(prop.proposer).toBe(proposerId);
    expect(prop.yesVotes).toBe(0);
    expect(prop.noVotes).toBe(0);
    expect(prop.totalVoters).toBe(0);
    expect(prop.quorumRequired).toBe(0.30);
  });

  it("throws when strategy does not sum to 100", () => {
    expect(() =>
      svc.createProposal({
        proposer: proposerId,
        title: "Bad strategy",
        description: "...",
        proposedStrategy: { dividendPercent: 50, infrastructurePercent: 30, grantsPercent: 10, reservePercent: 5 },
      })
    ).toThrow(/sum to 100/);
  });

  it("throws when proposer is not found", () => {
    expect(() =>
      svc.createProposal({
        proposer: "swf_part_9999",
        title: "Ghost",
        description: "...",
        proposedStrategy: newStrategy,
      })
    ).toThrow(/not found/);
  });

  it("throws when proposer is suspended", () => {
    svc.suspendParticipant(proposerId);
    expect(() =>
      svc.createProposal({
        proposer: proposerId,
        title: "Nope",
        description: "...",
        proposedStrategy: newStrategy,
      })
    ).toThrow(/not active/);
  });

  it("enforces minTenureForVotingDays", () => {
    const strictSvc = makeService({ minTenureForVotingDays: 30 });
    const newProp = reg(strictSvc, "did:key:newbie").id;
    expect(() =>
      strictSvc.createProposal({
        proposer: newProp,
        title: "Too new",
        description: "...",
        proposedStrategy: newStrategy,
      })
    ).toThrow(/tenure/);
  });

  // ── Voting

  it("casts a yes vote and updates proposal tallies", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    const vote = svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "yes" });

    expect(vote.id).toMatch(/^swf_vote_/);
    expect(vote.vote).toBe("yes");
    expect(vote.weight).toBe(1);

    const updated = svc.getProposal(prop.id)!;
    expect(updated.yesVotes).toBe(1);
    expect(updated.totalVoters).toBe(1);
  });

  it("casts a no vote", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "no" });
    expect(svc.getProposal(prop.id)!.noVotes).toBe(1);
  });

  it("casts an abstain vote — no yes/no counted but totalVoters incremented", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "abstain" });
    const p = svc.getProposal(prop.id)!;
    expect(p.yesVotes).toBe(0);
    expect(p.noVotes).toBe(0);
    expect(p.totalVoters).toBe(1);
  });

  it("respects custom vote weight", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "yes", weight: 3 });
    expect(svc.getProposal(prop.id)!.yesVotes).toBe(3);
  });

  it("prevents double voting by the same participant", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "yes" });
    expect(() =>
      svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "no" })
    ).toThrow(/already voted/);
  });

  it("throws when proposal not found for castVote", () => {
    expect(() =>
      svc.castVote({ proposalId: "swf_prop_9999", participantId: voter1Id, vote: "yes" })
    ).toThrow(/not found/);
  });

  it("throws when participant not found for castVote", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    expect(() =>
      svc.castVote({ proposalId: prop.id, participantId: "swf_part_9999", vote: "yes" })
    ).toThrow(/not found/);
  });

  it("throws when suspended participant tries to vote", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    svc.suspendParticipant(voter1Id);
    expect(() =>
      svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "yes" })
    ).toThrow(/not active/);
  });

  // ── Tally

  it("passes proposal when quorum met and yes > no", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    // 4 active participants, need 30% = 1.2 → 2 votes sufficient
    svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "yes" });
    svc.castVote({ proposalId: prop.id, participantId: voter2Id, vote: "yes" });

    const result = svc.tallyProposal(prop.id);
    expect(result.status).toBe("passed");
  });

  it("rejects proposal when quorum not met", () => {
    // Register one voter, need >30% of 5 active = 1.5 → 2 needed but only 1 votes
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "yes" });
    // Only 1/4 active = 25% < 30%
    const result = svc.tallyProposal(prop.id);
    expect(result.status).toBe("rejected");
  });

  it("rejects proposal when yes <= no even if quorum met", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "no" });
    svc.castVote({ proposalId: prop.id, participantId: voter2Id, vote: "no" });
    // 2/4 = 50% ≥ 30%, but no > yes
    const result = svc.tallyProposal(prop.id);
    expect(result.status).toBe("rejected");
  });

  it("throws when tallying non-active proposal", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "yes" });
    svc.castVote({ proposalId: prop.id, participantId: voter2Id, vote: "yes" });
    svc.tallyProposal(prop.id); // now "passed" or "rejected"
    expect(() => svc.tallyProposal(prop.id)).toThrow(/not active/);
  });

  // ── Execute

  it("executeProposal updates currentStrategy", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "yes" });
    svc.castVote({ proposalId: prop.id, participantId: voter2Id, vote: "yes" });
    svc.tallyProposal(prop.id);
    const executed = svc.executeProposal(prop.id);

    expect(executed.status).toBe("executed");

    const summary = svc.getSummary();
    expect(summary.currentAllocationStrategy.dividendPercent).toBe(50);
    expect(summary.currentAllocationStrategy.infrastructurePercent).toBe(30);
  });

  it("throws when executing non-passed proposal", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    // Not yet tallied — still active
    expect(() => svc.executeProposal(prop.id)).toThrow(/passed/);
  });

  it("getVotesForProposal returns all votes on that proposal", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "T", description: "D", proposedStrategy: newStrategy });
    svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "yes" });
    svc.castVote({ proposalId: prop.id, participantId: voter2Id, vote: "no" });

    const votes = svc.getVotesForProposal(prop.id);
    expect(votes).toHaveLength(2);
    votes.forEach((v) => expect(v.proposalId).toBe(prop.id));
  });

  it("listProposals filters by status", () => {
    const prop = svc.createProposal({ proposer: proposerId, title: "A", description: "D", proposedStrategy: newStrategy });
    svc.createProposal({ proposer: proposerId, title: "B", description: "D", proposedStrategy: newStrategy });

    // Tally prop A into passed
    svc.castVote({ proposalId: prop.id, participantId: voter1Id, vote: "yes" });
    svc.castVote({ proposalId: prop.id, participantId: voter2Id, vote: "yes" });
    svc.tallyProposal(prop.id);

    expect(svc.listProposals({ status: "active" })).toHaveLength(1);
    expect(svc.listProposals({ status: "passed" })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Summary & Dashboard
// ---------------------------------------------------------------------------

describe("Summary and dashboard", () => {
  let svc: SWFService;

  beforeEach(() => {
    svc = makeService({ minTenureForVotingDays: 0 });
  });

  it("getSummary with no data returns zeroed totals", () => {
    const summary = svc.getSummary();
    expect(summary.totalBalance).toBe("0");
    expect(summary.totalAccruedAllTime).toBe("0");
    expect(summary.totalDistributedAllTime).toBe("0");
    expect(summary.participantCount).toBe(0);
    expect(summary.activeProposals).toBe(0);
    expect(summary.currentEpochId).toBe("");
    expect(summary.chainBalances).toHaveLength(1);
  });

  it("getSummary reflects active epoch id", () => {
    const epoch = svc.createEpoch();
    const summary = svc.getSummary();
    expect(summary.currentEpochId).toBe(epoch.id);
  });

  it("getSummary reflects participant count (active only)", () => {
    const p1 = reg(svc, "did:key:summ1");
    reg(svc, "did:key:summ2");
    svc.suspendParticipant(p1.id);

    const summary = svc.getSummary();
    expect(summary.participantCount).toBe(1);
  });

  it("getSummary totals accrued across epochs", () => {
    const e1 = svc.createEpoch().id;
    svc.accrue({ sourceType: "protocol_fee", sourceId: "a1", grossAmount: 10000, epochId: e1 });
    // 10000 * 0.02 = 200

    const summary = svc.getSummary();
    expect(Number(summary.totalAccruedAllTime)).toBeCloseTo(200, 5);
  });

  it("getSummary balance = accrued - distributed", () => {
    const p = reg(svc, "did:key:bal1");
    const epochId = svc.createEpoch().id;
    svc.accrue({ sourceType: "protocol_fee", sourceId: "a1", grossAmount: 10000, epochId });
    // totalAccrued = 200

    svc.calculateContributionScores(epochId, [
      { participantId: p.id, jobCount: 10, reputation: 500, uptimeOrActivity: 80, tenureDays: 100, votedThisEpoch: false },
    ]);
    svc.distributeEpoch(epochId);
    // distributed = 200 * 60% = 120

    const summary = svc.getSummary();
    expect(Number(summary.totalDistributedAllTime)).toBeCloseTo(120, 5);
    expect(Number(summary.totalBalance)).toBeCloseTo(80, 5);
  });

  it("getSummary counts active proposals", () => {
    const proposerId = reg(svc, "did:key:prop-summ").id;
    const strat = { dividendPercent: 60, infrastructurePercent: 25, grantsPercent: 10, reservePercent: 5 };
    svc.createProposal({ proposer: proposerId, title: "P1", description: "D", proposedStrategy: strat });
    svc.createProposal({ proposer: proposerId, title: "P2", description: "D", proposedStrategy: strat });

    expect(svc.getSummary().activeProposals).toBe(2);
  });

  // ── Participant Dashboard

  it("getParticipantDashboard returns correct structure", () => {
    const p = reg(svc, "did:key:dash1");
    const dash = svc.getParticipantDashboard(p.id);

    expect(dash.participant.id).toBe(p.id);
    expect(dash.totalEarned).toBe("0");
    expect(dash.pendingDividends).toBe("0");
    expect(dash.epochCount).toBe(0);
    expect(dash.claims).toHaveLength(0);
    expect(dash.votingHistory).toHaveLength(0);
  });

  it("getParticipantDashboard throws when participant not found", () => {
    expect(() => svc.getParticipantDashboard("swf_part_9999")).toThrow(/not found/);
  });

  it("getParticipantDashboard reflects pending dividends after distribution", () => {
    const p = reg(svc, "did:key:dash2");
    const epochId = svc.createEpoch().id;
    svc.accrue({ sourceType: "protocol_fee", sourceId: "a1", grossAmount: 5000, epochId });
    // totalAccrued = 100

    svc.calculateContributionScores(epochId, [
      { participantId: p.id, jobCount: 10, reputation: 500, uptimeOrActivity: 80, tenureDays: 100, votedThisEpoch: false },
    ]);
    svc.distributeEpoch(epochId);
    // claim = 100 * 60% = 60

    const dash = svc.getParticipantDashboard(p.id);
    expect(Number(dash.pendingDividends)).toBeCloseTo(60, 5);
    expect(dash.claims).toHaveLength(1);
    expect(dash.epochCount).toBe(1);
  });

  it("getParticipantDashboard reflects totalEarned after settling claim", () => {
    const p = reg(svc, "did:key:dash3");
    const epochId = svc.createEpoch().id;
    svc.accrue({ sourceType: "protocol_fee", sourceId: "a1", grossAmount: 5000, epochId });

    svc.calculateContributionScores(epochId, [
      { participantId: p.id, jobCount: 10, reputation: 500, uptimeOrActivity: 80, tenureDays: 100, votedThisEpoch: false },
    ]);
    svc.distributeEpoch(epochId);

    const claimId = svc.getClaimsForParticipant(p.id)[0].id;
    svc.settleClaim(claimId, "0xdeadbeef");

    const dash = svc.getParticipantDashboard(p.id);
    expect(Number(dash.totalEarned)).toBeCloseTo(60, 5);
    expect(dash.pendingDividends).toBe("0");
  });

  it("getParticipantDashboard tracks voting history", () => {
    const svc2 = makeService({ minTenureForVotingDays: 0 });
    const voter = reg(svc2, "did:key:dash-voter");
    const proposer = reg(svc2, "did:key:dash-proposer");
    const strat = { dividendPercent: 60, infrastructurePercent: 25, grantsPercent: 10, reservePercent: 5 };
    const prop = svc2.createProposal({ proposer: proposer.id, title: "T", description: "D", proposedStrategy: strat });
    svc2.castVote({ proposalId: prop.id, participantId: voter.id, vote: "yes" });

    const dash = svc2.getParticipantDashboard(voter.id);
    expect(dash.votingHistory).toHaveLength(1);
    expect(dash.votingHistory[0].vote).toBe("yes");
  });
});
