import React from "react";
import { useParams } from "react-router-dom";
import { GlassPanel, DataCell, AmountDisplay, GlowBadge } from "@pcc/ui";
import type { SWFProposal, SWFVote, SWFAllocationStrategy } from "@pcc/spec";

// ── Mock Data ───────────────────────────────────────────────────

const CURRENT_STRATEGY: SWFAllocationStrategy = {
  dividendPercent: 60,
  infrastructurePercent: 25,
  grantsPercent: 10,
  reservePercent: 5,
};

const MOCK_PROPOSAL: SWFProposal = {
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

const MOCK_VOTES: SWFVote[] = [
  { id: "swf_vote_0010", proposalId: "swf_prop_0003", participantId: "swf_part_0001", vote: "yes", weight: 2.1, votedAt: "2026-03-18T08:00:00Z" },
  { id: "swf_vote_0011", proposalId: "swf_prop_0003", participantId: "swf_part_0003", vote: "yes", weight: 1.8, votedAt: "2026-03-18T10:30:00Z" },
  { id: "swf_vote_0012", proposalId: "swf_prop_0003", participantId: "swf_part_0007", vote: "no", weight: 1.5, votedAt: "2026-03-18T14:15:00Z" },
  { id: "swf_vote_0013", proposalId: "swf_prop_0003", participantId: "swf_part_0002", vote: "yes", weight: 2.4, votedAt: "2026-03-19T09:00:00Z" },
  { id: "swf_vote_0014", proposalId: "swf_prop_0003", participantId: "swf_part_0012", vote: "no", weight: 0.9, votedAt: "2026-03-19T11:45:00Z" },
];

// ── Helpers ─────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function strategyLabel(key: string) {
  return key.replace(/Percent$/, "").replace(/([A-Z])/g, " $1").trim();
}

// ── Component ───────────────────────────────────────────────────

export function SWFGovernancePage() {
  const { proposalId } = useParams<{ proposalId: string }>();
  const proposal = MOCK_PROPOSAL; // In production: fetch by proposalId
  const votes = MOCK_VOTES;

  const totalWeight = proposal.yesVotes + proposal.noVotes;
  const yesPercent = totalWeight > 0 ? (proposal.yesVotes / totalWeight) * 100 : 0;
  const eligibleCount = 47; // In production: from summary
  const turnout = Math.round((proposal.totalVoters / eligibleCount) * 100);
  const quorumMet = proposal.totalVoters / eligibleCount >= proposal.quorumRequired;

  return (
    <div className="space-y-6 p-4">
      <div className="flex items-center gap-3">
        <a href="/swf" className="text-zinc-500 hover:text-zinc-300 text-sm">&larr; Back to Fund</a>
        <GlowBadge label={proposal.status} color={proposal.status === "active" ? "amber" : proposal.status === "passed" ? "emerald" : "red"} />
      </div>

      <h1 className="text-2xl font-bold text-emerald-300">{proposal.title}</h1>
      <p className="text-zinc-400 text-sm leading-relaxed">{proposal.description}</p>

      {/* Strategy Comparison */}
      <GlassPanel>
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Strategy Comparison</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-zinc-500 text-left">
              <th className="pb-2">Dimension</th>
              <th className="pb-2">Current</th>
              <th className="pb-2">Proposed</th>
              <th className="pb-2">Change</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(CURRENT_STRATEGY) as (keyof SWFAllocationStrategy)[]).map((key) => {
              const current = CURRENT_STRATEGY[key];
              const proposed = proposal.proposedStrategy[key];
              const diff = proposed - current;
              return (
                <tr key={key} className="border-t border-zinc-800">
                  <td className="py-2 text-zinc-300">{strategyLabel(key)}</td>
                  <td className="py-2 text-zinc-400">{current}%</td>
                  <td className="py-2 text-white font-medium">{proposed}%</td>
                  <td className={`py-2 font-medium ${diff > 0 ? "text-emerald-400" : diff < 0 ? "text-red-400" : "text-zinc-600"}`}>
                    {diff > 0 ? `+${diff}%` : diff < 0 ? `${diff}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </GlassPanel>

      {/* Vote Progress */}
      <GlassPanel>
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Vote Progress</h2>
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-emerald-400">Yes: {proposal.yesVotes.toFixed(1)} weight</span>
            <span className="text-red-400">No: {proposal.noVotes.toFixed(1)} weight</span>
          </div>
          <div className="h-3 bg-zinc-700 rounded-full overflow-hidden flex">
            <div className="h-full bg-emerald-500" style={{ width: `${yesPercent}%` }} />
            <div className="h-full bg-red-500" style={{ width: `${100 - yesPercent}%` }} />
          </div>
          <div className="flex justify-between text-xs text-zinc-500">
            <span>{turnout}% turnout ({proposal.totalVoters} of {eligibleCount})</span>
            <span>
              Quorum {Math.round(proposal.quorumRequired * 100)}%:{" "}
              <span className={quorumMet ? "text-emerald-400" : "text-amber-400"}>
                {quorumMet ? "Met" : "Not met"}
              </span>
            </span>
          </div>
          <div className="text-xs text-zinc-600">
            Voting ends {fmtDate(proposal.votingEnd)}
          </div>
        </div>
      </GlassPanel>

      {/* Individual Votes */}
      <GlassPanel>
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Votes ({votes.length})</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-zinc-500 text-left">
              <th className="pb-2">Participant</th>
              <th className="pb-2">Vote</th>
              <th className="pb-2">Weight</th>
              <th className="pb-2">Time</th>
            </tr>
          </thead>
          <tbody>
            {votes.map((v) => (
              <tr key={v.id} className="border-t border-zinc-800">
                <td className="py-2 text-zinc-300 font-mono text-xs">{v.participantId}</td>
                <td className="py-2">
                  <GlowBadge
                    label={v.vote}
                    color={v.vote === "yes" ? "emerald" : v.vote === "no" ? "red" : "zinc"}
                  />
                </td>
                <td className="py-2 text-white">{v.weight.toFixed(1)}</td>
                <td className="py-2 text-zinc-400 text-xs">{fmtDate(v.votedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </GlassPanel>
    </div>
  );
}
