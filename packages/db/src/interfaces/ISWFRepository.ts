import type {
  swfParticipants,
  swfEpochs,
  swfAccruals,
  swfContributionScores,
  swfDividendClaims,
  swfProposals,
  swfVotes,
} from "../schema/index.js";

export type SWFParticipantRow = typeof swfParticipants.$inferSelect;
export type SWFParticipantInsert = typeof swfParticipants.$inferInsert;
export type SWFEpochRow = typeof swfEpochs.$inferSelect;
export type SWFEpochInsert = typeof swfEpochs.$inferInsert;
export type SWFAccrualRow = typeof swfAccruals.$inferSelect;
export type SWFAccrualInsert = typeof swfAccruals.$inferInsert;
export type SWFContributionScoreRow = typeof swfContributionScores.$inferSelect;
export type SWFContributionScoreInsert = typeof swfContributionScores.$inferInsert;
export type SWFDividendClaimRow = typeof swfDividendClaims.$inferSelect;
export type SWFDividendClaimInsert = typeof swfDividendClaims.$inferInsert;
export type SWFProposalRow = typeof swfProposals.$inferSelect;
export type SWFProposalInsert = typeof swfProposals.$inferInsert;
export type SWFVoteRow = typeof swfVotes.$inferSelect;
export type SWFVoteInsert = typeof swfVotes.$inferInsert;

export interface ISWFRepository {
  // Participants
  insertParticipant(p: SWFParticipantInsert): SWFParticipantRow | undefined;
  findParticipantById(id: string): SWFParticipantRow | undefined;
  findParticipantByDid(did: string): SWFParticipantRow | undefined;
  findParticipantByWallet(walletAddress: string): SWFParticipantRow | undefined;
  listParticipants(): SWFParticipantRow[];
  listParticipantsByRole(role: string): SWFParticipantRow[];
  listParticipantsByStatus(status: string): SWFParticipantRow[];
  updateParticipantStatus(id: string, status: string): SWFParticipantRow | undefined;
  // Epochs
  insertEpoch(e: SWFEpochInsert): SWFEpochRow | undefined;
  findEpochById(id: string): SWFEpochRow | undefined;
  findActiveEpoch(): SWFEpochRow | undefined;
  listEpochs(): SWFEpochRow[];
  updateEpochStatus(id: string, status: string): SWFEpochRow | undefined;
  // Accruals
  insertAccrual(a: SWFAccrualInsert): SWFAccrualRow | undefined;
  findAccrualsByEpoch(epochId: string): SWFAccrualRow[];
  listAccruals(): SWFAccrualRow[];
  // Contribution Scores
  insertScore(s: SWFContributionScoreInsert): SWFContributionScoreRow | undefined;
  findScoresByEpoch(epochId: string): SWFContributionScoreRow[];
  findScoresByParticipant(participantId: string): SWFContributionScoreRow[];
  // Dividend Claims
  insertClaim(c: SWFDividendClaimInsert): SWFDividendClaimRow | undefined;
  findClaimById(id: string): SWFDividendClaimRow | undefined;
  findClaimsByParticipant(participantId: string): SWFDividendClaimRow[];
  findClaimsByEpoch(epochId: string): SWFDividendClaimRow[];
  updateClaimStatus(id: string, status: string, txHash?: string, claimedAt?: string): SWFDividendClaimRow | undefined;
  // Proposals
  insertProposal(p: SWFProposalInsert): SWFProposalRow | undefined;
  findProposalById(id: string): SWFProposalRow | undefined;
  listProposals(): SWFProposalRow[];
  listProposalsByStatus(status: string): SWFProposalRow[];
  updateProposalStatus(id: string, status: string): SWFProposalRow | undefined;
  // Votes
  insertVote(v: SWFVoteInsert): SWFVoteRow | undefined;
  findVotesByProposal(proposalId: string): SWFVoteRow[];
  findVotesByParticipant(participantId: string): SWFVoteRow[];
}
