import { eq } from "drizzle-orm";
import {
  swfParticipants,
  swfEpochs,
  swfAccruals,
  swfContributionScores,
  swfDividendClaims,
  swfProposals,
  swfVotes,
} from "../schema/index.js";
import type { StoreDB } from "../connection.js";

export class SWFRepository {
  constructor(private db: StoreDB) {}

  // ── Participants ────────────────────────────────────────────────

  insertParticipant(p: typeof swfParticipants.$inferInsert) {
    return this.db.insert(swfParticipants).values(p).returning().get();
  }

  findParticipantById(id: string) {
    return this.db
      .select()
      .from(swfParticipants)
      .where(eq(swfParticipants.id, id))
      .get();
  }

  findParticipantByDid(did: string) {
    return this.db
      .select()
      .from(swfParticipants)
      .where(eq(swfParticipants.did, did))
      .get();
  }

  findParticipantByWallet(walletAddress: string) {
    return this.db
      .select()
      .from(swfParticipants)
      .where(eq(swfParticipants.walletAddress, walletAddress))
      .get();
  }

  listParticipants() {
    return this.db.select().from(swfParticipants).all();
  }

  listParticipantsByRole(role: string) {
    return this.db
      .select()
      .from(swfParticipants)
      .where(eq(swfParticipants.role, role))
      .all();
  }

  listParticipantsByStatus(status: string) {
    return this.db
      .select()
      .from(swfParticipants)
      .where(eq(swfParticipants.status, status))
      .all();
  }

  updateParticipantStatus(id: string, status: string) {
    return this.db
      .update(swfParticipants)
      .set({ status })
      .where(eq(swfParticipants.id, id))
      .returning()
      .get();
  }

  // ── Epochs ──────────────────────────────────────────────────────

  insertEpoch(e: typeof swfEpochs.$inferInsert) {
    return this.db.insert(swfEpochs).values(e).returning().get();
  }

  findEpochById(id: string) {
    return this.db
      .select()
      .from(swfEpochs)
      .where(eq(swfEpochs.id, id))
      .get();
  }

  findActiveEpoch() {
    return this.db
      .select()
      .from(swfEpochs)
      .where(eq(swfEpochs.status, "active"))
      .get();
  }

  listEpochs() {
    return this.db.select().from(swfEpochs).all();
  }

  updateEpochStatus(id: string, status: string) {
    return this.db
      .update(swfEpochs)
      .set({ status })
      .where(eq(swfEpochs.id, id))
      .returning()
      .get();
  }

  // ── Accruals ────────────────────────────────────────────────────

  insertAccrual(a: typeof swfAccruals.$inferInsert) {
    return this.db.insert(swfAccruals).values(a).returning().get();
  }

  findAccrualsByEpoch(epochId: string) {
    return this.db
      .select()
      .from(swfAccruals)
      .where(eq(swfAccruals.epochId, epochId))
      .all();
  }

  listAccruals() {
    return this.db.select().from(swfAccruals).all();
  }

  // ── Contribution Scores ─────────────────────────────────────────

  insertScore(s: typeof swfContributionScores.$inferInsert) {
    return this.db.insert(swfContributionScores).values(s).returning().get();
  }

  findScoresByEpoch(epochId: string) {
    return this.db
      .select()
      .from(swfContributionScores)
      .where(eq(swfContributionScores.epochId, epochId))
      .all();
  }

  findScoresByParticipant(participantId: string) {
    return this.db
      .select()
      .from(swfContributionScores)
      .where(eq(swfContributionScores.participantId, participantId))
      .all();
  }

  // ── Dividend Claims ─────────────────────────────────────────────

  insertClaim(c: typeof swfDividendClaims.$inferInsert) {
    return this.db.insert(swfDividendClaims).values(c).returning().get();
  }

  findClaimById(id: string) {
    return this.db
      .select()
      .from(swfDividendClaims)
      .where(eq(swfDividendClaims.id, id))
      .get();
  }

  findClaimsByParticipant(participantId: string) {
    return this.db
      .select()
      .from(swfDividendClaims)
      .where(eq(swfDividendClaims.participantId, participantId))
      .all();
  }

  findClaimsByEpoch(epochId: string) {
    return this.db
      .select()
      .from(swfDividendClaims)
      .where(eq(swfDividendClaims.epochId, epochId))
      .all();
  }

  updateClaimStatus(id: string, status: string, txHash?: string, claimedAt?: string) {
    return this.db
      .update(swfDividendClaims)
      .set({ status, txHash, claimedAt })
      .where(eq(swfDividendClaims.id, id))
      .returning()
      .get();
  }

  // ── Proposals ───────────────────────────────────────────────────

  insertProposal(p: typeof swfProposals.$inferInsert) {
    return this.db.insert(swfProposals).values(p).returning().get();
  }

  findProposalById(id: string) {
    return this.db
      .select()
      .from(swfProposals)
      .where(eq(swfProposals.id, id))
      .get();
  }

  listProposals() {
    return this.db.select().from(swfProposals).all();
  }

  listProposalsByStatus(status: string) {
    return this.db
      .select()
      .from(swfProposals)
      .where(eq(swfProposals.status, status))
      .all();
  }

  updateProposalStatus(id: string, status: string) {
    return this.db
      .update(swfProposals)
      .set({ status })
      .where(eq(swfProposals.id, id))
      .returning()
      .get();
  }

  // ── Votes ───────────────────────────────────────────────────────

  insertVote(v: typeof swfVotes.$inferInsert) {
    return this.db.insert(swfVotes).values(v).returning().get();
  }

  findVotesByProposal(proposalId: string) {
    return this.db
      .select()
      .from(swfVotes)
      .where(eq(swfVotes.proposalId, proposalId))
      .all();
  }

  findVotesByParticipant(participantId: string) {
    return this.db
      .select()
      .from(swfVotes)
      .where(eq(swfVotes.participantId, participantId))
      .all();
  }
}
