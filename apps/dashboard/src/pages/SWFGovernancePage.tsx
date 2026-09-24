import React from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel, GlowBadge, EmptyState, LoadingShell } from "@pcc/ui";
import type { SWFAllocationStrategy } from "@pcc/spec";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";
import { DemoBanner } from "../components/DemoState.js";
import { isDemoMode } from "../lib/demo-mode.js";
import {
  FUND_STATE_QUERY_KEY,
  SWF_MEMORY_NOTE,
  readFundState,
  readProposal,
  type ProposalFields,
  type VoteFields,
} from "../lib/swf-live.js";
import {
  DEMO_CURRENT_STRATEGY,
  DEMO_ELIGIBLE_PARTICIPANTS,
  DEMO_PROPOSAL,
  DEMO_VOTES,
} from "../demo/SWFGovernancePage.fixtures.js";

/**
 * One fund governance proposal: strategy comparison, vote progress and votes.
 *
 * Live: GET /api/swf/proposals/:proposalId (the proposal and its votes) and
 * GET /api/swf/summary (the fund's current strategy, and the active
 * participant count the gateway divides by for quorum). The gateway holds
 * both in memory; lib/swf-live.ts says what that service records and what it
 * invents. The route's 404 is "Proposal not found"; any other failure is
 * Unavailable, or Stale with a time. Vote weights are shown as the gateway
 * recorded them.
 *
 * This page used to show one fixed sample proposal and five sample votes for
 * every proposal id, against a fixed strategy and 47 eligible participants.
 * In demo mode (lib/demo-mode.ts) that prototype renders under a DemoBanner.
 */

// ── Helpers ─────────────────────────────────────────────────────

function fmtDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function strategyLabel(key: string) {
  return key.replace(/Percent$/, "").replace(/([A-Z])/g, " $1").trim();
}

const STRATEGY_KEYS: (keyof SWFAllocationStrategy)[] = [
  "dividendPercent",
  "infrastructurePercent",
  "grantsPercent",
  "reservePercent",
];

// ── Component ───────────────────────────────────────────────────

export function SWFGovernancePage() {
  const { proposalId } = useParams<{ proposalId: string }>();
  const demo = isDemoMode();

  const proposalQ = useQuery({
    queryKey: ["swf", "proposal", proposalId],
    queryFn: () => readProposal(proposalId ?? ""),
    enabled: !demo && Boolean(proposalId),
    retry: 1,
  });
  const fundQ = useQuery({
    queryKey: FUND_STATE_QUERY_KEY,
    queryFn: readFundState,
    enabled: !demo,
    retry: 1,
  });

  if (demo) {
    return (
      <div className="space-y-6 p-4">
        <DemoBanner what="Fund governance" />
        <ProposalView
          proposal={DEMO_PROPOSAL}
          votes={DEMO_VOTES}
          current={DEMO_CURRENT_STRATEGY}
          eligible={DEMO_ELIGIBLE_PARTICIPANTS}
        />
      </div>
    );
  }

  const back = (
    <a href="/swf" className="text-zinc-500 hover:text-zinc-300 text-sm">&larr; Back to Fund</a>
  );

  if (!proposalId) {
    return (
      <div className="space-y-6 p-4">
        {back}
        <GlassPanel>
          <EmptyState title="No proposal selected" description="Open a proposal from the fund's governance tab." />
        </GlassPanel>
      </div>
    );
  }

  if (proposalQ.isPending) return <LoadingShell rows={3} />;

  if (proposalQ.data === null) {
    return (
      <div className="space-y-6 p-4">
        {back}
        <GlassPanel>
          <EmptyState
            title="Proposal not found"
            description={`The gateway has no proposal ${proposalId}. ${SWF_MEMORY_NOTE}`}
          />
        </GlassPanel>
      </div>
    );
  }

  if (proposalQ.data === undefined) {
    return (
      <div className="space-y-6 p-4">
        {back}
        <GlassPanel>
          <UnavailableState what="this proposal" error={proposalQ.error} onRetry={() => void proposalQ.refetch()} />
        </GlassPanel>
      </div>
    );
  }

  const { proposal, votes } = proposalQ.data;
  const fund = fundQ.data;
  const fundNotice = fund ? undefined : fundQ.isPending ? (
    <p role="status" className="text-xs text-zinc-500 mb-3">Loading the fund's current strategy…</p>
  ) : (
    <UnavailableState what="the fund's current strategy and participant count" error={fundQ.error} onRetry={() => void fundQ.refetch()} />
  );

  return (
    <div className="space-y-6 p-4">
      {proposalQ.isError && (
        <StaleNotice what="this proposal" updatedAt={proposalQ.dataUpdatedAt} onRetry={() => void proposalQ.refetch()} />
      )}
      {fund && fundQ.isError && (
        <StaleNotice what="the fund summary" updatedAt={fundQ.dataUpdatedAt} onRetry={() => void fundQ.refetch()} />
      )}
      <ProposalView
        proposal={proposal}
        votes={votes}
        current={fund?.strategy}
        eligible={fund?.participantCount}
        fundNotice={fundNotice}
        note={SWF_MEMORY_NOTE}
      />
    </div>
  );
}

interface ProposalViewProps {
  proposal: ProposalFields;
  votes: VoteFields[];
  /** The fund's current strategy; undefined when it couldn't be read. */
  current?: SWFAllocationStrategy;
  /** Active participants, the quorum's denominator; undefined when it couldn't be read. */
  eligible?: number;
  /** Shown in the comparison panel while the fund summary is loading or unavailable. */
  fundNotice?: React.ReactNode;
  /** A line under the votes. */
  note?: string;
}

function ProposalView({ proposal, votes, current, eligible, fundNotice, note }: ProposalViewProps) {
  const totalWeight = proposal.yesVotes + proposal.noVotes;
  // With no weighted votes the bar is empty, not all "no".
  const yesPercent = totalWeight > 0 ? (proposal.yesVotes / totalWeight) * 100 : 0;
  const noPercent = totalWeight > 0 ? 100 - yesPercent : 0;
  const quorumPercent = Math.round(proposal.quorumRequired * 100);
  // The gateway's own rule (SWFService.tallyProposal): voters / active participants >= quorum.
  const quorumMet = eligible !== undefined && eligible > 0 && proposal.totalVoters / eligible >= proposal.quorumRequired;

  let turnoutText: string;
  if (eligible === undefined) turnoutText = `${proposal.totalVoters} voters (turnout unavailable)`;
  else if (eligible === 0) turnoutText = `${proposal.totalVoters} voters, no active participants`;
  else turnoutText = `${Math.round((proposal.totalVoters / eligible) * 100)}% turnout (${proposal.totalVoters} of ${eligible})`;

  return (
    <>
      <div className="flex items-center gap-3">
        <a href="/swf" className="text-zinc-500 hover:text-zinc-300 text-sm">&larr; Back to Fund</a>
        <GlowBadge color={proposal.status === "active" ? "gold" : proposal.status === "passed" ? "green" : "red"}>{proposal.status}</GlowBadge>
      </div>

      <h1 className="text-2xl font-bold text-emerald-300">{proposal.title}</h1>
      <p className="text-zinc-400 text-sm leading-relaxed">{proposal.description}</p>

      {/* Strategy Comparison */}
      <GlassPanel>
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Strategy Comparison</h2>
        {fundNotice}
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
            {STRATEGY_KEYS.map((key) => {
              const proposed = proposal.proposedStrategy[key];
              const now = current?.[key];
              const diff = now === undefined ? undefined : proposed - now;
              return (
                <tr key={key} className="border-t border-zinc-800">
                  <td className="py-2 text-zinc-300">{strategyLabel(key)}</td>
                  <td className="py-2 text-zinc-400">{now === undefined ? "—" : `${now}%`}</td>
                  <td className="py-2 text-white font-medium">{proposed}%</td>
                  <td
                    className={`py-2 font-medium ${
                      diff !== undefined && diff > 0 ? "text-emerald-400" : diff !== undefined && diff < 0 ? "text-red-400" : "text-zinc-600"
                    }`}
                  >
                    {diff === undefined || diff === 0 ? "—" : diff > 0 ? `+${diff}%` : `${diff}%`}
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
            <div className="h-full bg-red-500" style={{ width: `${noPercent}%` }} />
          </div>
          <div className="flex justify-between text-xs text-zinc-500">
            <span>{turnoutText}</span>
            <span>
              Quorum {quorumPercent}%:{" "}
              {eligible === undefined ? (
                <span className="text-zinc-500">unknown</span>
              ) : (
                <span className={quorumMet ? "text-emerald-400" : "text-amber-400"}>
                  {quorumMet ? "Met" : "Not met"}
                </span>
              )}
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
        {votes.length === 0 ? (
          <EmptyState title="No votes yet" description="No participant has voted on this proposal." />
        ) : (
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
                    <GlowBadge color={v.vote === "yes" ? "green" : v.vote === "no" ? "red" : "gray"}>
                      {v.vote}
                    </GlowBadge>
                  </td>
                  <td className="py-2 text-white">{v.weight.toFixed(1)}</td>
                  <td className="py-2 text-zinc-400 text-xs">{fmtDate(v.votedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {note && <p className="mt-3 text-xs text-zinc-500">{note}</p>}
      </GlassPanel>
    </>
  );
}
