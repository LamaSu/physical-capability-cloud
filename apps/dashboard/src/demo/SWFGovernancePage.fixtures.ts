/**
 * Fund governance demo fixtures: sample values, not live PCC state.
 *
 * Rendered only in demo mode (lib/demo-mode.ts), under a DemoBanner, by
 * pages/SWFGovernancePage.tsx. Before implementer-delta moved them here, the
 * page showed this proposal and these votes for every proposal id in the URL,
 * against a fixed current strategy and 47 eligible participants. Outside demo
 * mode the page reads GET /api/swf/proposals/:proposalId and GET
 * /api/swf/summary.
 */

import type { SWFProposal, SWFVote, SWFAllocationStrategy } from "@pcc/spec";

export const DEMO_CURRENT_STRATEGY: SWFAllocationStrategy = {
  dividendPercent: 60,
  infrastructurePercent: 25,
  grantsPercent: 10,
  reservePercent: 5,
};

export const DEMO_ELIGIBLE_PARTICIPANTS = 47;

export const DEMO_PROPOSAL: SWFProposal = {
  id: "swf_prop_0003",
  proposer: "swf_part_0005",
  title: "Increase dividend allocation to 70%",
  description:
    "With fund reserves now healthy at $48K and growing, I propose we shift 10% from infrastructure to direct dividends. Infrastructure pools are well-funded and the network has enough capability coverage. Participants deserve a larger share of the returns.",
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
};

export const DEMO_VOTES: SWFVote[] = [
  { id: "swf_vote_0010", proposalId: "swf_prop_0003", participantId: "swf_part_0001", vote: "yes", weight: 2.1, votedAt: "2026-03-18T08:00:00Z" },
  { id: "swf_vote_0011", proposalId: "swf_prop_0003", participantId: "swf_part_0003", vote: "yes", weight: 1.8, votedAt: "2026-03-18T10:30:00Z" },
  { id: "swf_vote_0012", proposalId: "swf_prop_0003", participantId: "swf_part_0007", vote: "no", weight: 1.5, votedAt: "2026-03-18T14:15:00Z" },
  { id: "swf_vote_0013", proposalId: "swf_prop_0003", participantId: "swf_part_0002", vote: "yes", weight: 2.4, votedAt: "2026-03-19T09:00:00Z" },
  { id: "swf_vote_0014", proposalId: "swf_prop_0003", participantId: "swf_part_0012", vote: "no", weight: 0.9, votedAt: "2026-03-19T11:45:00Z" },
];
