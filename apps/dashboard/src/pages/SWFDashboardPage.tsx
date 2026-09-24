import React, { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { GlassPanel, DataCell, AmountDisplay, GlowBadge, EmptyState, LoadingShell } from "@pcc/ui";
import type {
  SWFEpoch,
  SWFAccrual,
  SWFDividendClaim,
  SWFAllocationStrategy,
} from "@pcc/spec";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";
import { NotLiveState, DemoBanner } from "../components/DemoState.js";
import { isDemoMode } from "../lib/demo-mode.js";
import {
  FUND_STATE_QUERY_KEY,
  SWF_MEMORY_NOTE,
  readActiveProposals,
  readFundState,
  type FundState,
  type ProposalFields,
} from "../lib/swf-live.js";
import {
  DEMO_SWF_ACCRUALS,
  DEMO_SWF_CLAIMS,
  DEMO_SWF_EPOCHS,
  DEMO_SWF_PROPOSALS,
  DEMO_SWF_STRATEGY,
  DEMO_SWF_SUMMARY,
} from "../demo/SWFDashboardPage.fixtures.js";

/**
 * Sovereign Wealth Fund.
 *
 * Live, from the gateway's fund service (routes/swf.ts, held in its memory;
 * see lib/swf-live.ts): the active participant and proposal counts and the
 * allocation strategy (GET /api/swf/summary), and the active proposals
 * (GET /api/swf/proposals?status=active).
 *
 * Not live: the fund balance, total distributed, epochs, chain balances,
 * accruals and dividend claims. The gateway books every milestone release as
 * a fixed 1,000 USDC gross whatever was released, splits distributions by
 * randomly drawn scores (POST /api/swf/epochs/:epochId/distribute), labels
 * the ledger total as a Base USDC chain balance without reading a chain, and
 * no route lists the viewer's claims. Outside demo mode those sections say so.
 *
 * This page used to render one fixed sample fund. In demo mode
 * (lib/demo-mode.ts) that prototype renders under a DemoBanner.
 */

type Tab = "overview" | "accruals" | "claims" | "governance";

const LEDGER_NOT_LIVE =
  "The gateway's fund balance, epoch totals and chain balances come from a ledger that books every " +
  "milestone release as a fixed 1,000 USDC gross, whatever was released, and splits distributions by " +
  "randomly drawn scores. No route reads the fund's balance from a chain.";

const ACCRUALS_NOT_LIVE =
  "GET /api/swf/accruals lists one accrual per milestone release, each booked as a fixed 1,000 USDC " +
  "gross rather than the amount released.";

const CLAIMS_NOT_LIVE =
  "No gateway route lists your dividend claims, and the fund creates claims only from distributions it " +
  "scores with random numbers (POST /api/swf/epochs/:epochId/distribute).";

// ── Helpers ─────────────────────────────────────────────────────

function fmtDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function sourceLabel(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Component ───────────────────────────────────────────────────

export function SWFDashboardPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const demo = isDemoMode();

  const fundQ = useQuery({
    queryKey: FUND_STATE_QUERY_KEY,
    queryFn: readFundState,
    enabled: !demo,
    retry: 1,
  });
  const proposalsQ = useQuery({
    queryKey: ["swf", "proposals", "active"],
    queryFn: readActiveProposals,
    enabled: !demo,
    retry: 1,
  });

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-2xl font-bold text-emerald-300 tracking-tight">
        Sovereign Wealth Fund
      </h1>

      {demo ? (
        <>
          <DemoBanner what="Sovereign Wealth Fund" />
          <DemoKpis />
          <StrategyPanel strategy={DEMO_SWF_STRATEGY} />
        </>
      ) : (
        <LiveFundState query={fundQ} />
      )}

      <TabBar tab={tab} onChange={setTab} />

      {tab === "overview" &&
        (demo ? <DemoOverview /> : <NotLivePanel what="The fund ledger" detail={LEDGER_NOT_LIVE} />)}

      {tab === "accruals" &&
        (demo ? (
          <AccrualsPanel accruals={DEMO_SWF_ACCRUALS} />
        ) : (
          <NotLivePanel what="The accrual ledger" detail={ACCRUALS_NOT_LIVE} />
        ))}

      {tab === "claims" &&
        (demo ? (
          <ClaimsPanel claims={DEMO_SWF_CLAIMS} />
        ) : (
          <NotLivePanel what="Your dividend history" detail={CLAIMS_NOT_LIVE} />
        ))}

      {tab === "governance" &&
        (demo ? (
          <ProposalsPanel proposals={DEMO_SWF_PROPOSALS} eligible={DEMO_SWF_SUMMARY.participantCount} />
        ) : (
          <LiveProposals query={proposalsQ} eligible={fundQ.data?.participantCount} />
        ))}
    </div>
  );
}

// ── Live sections ───────────────────────────────────────────────

function LiveFundState({ query }: { query: UseQueryResult<FundState> }) {
  if (query.isPending) return <LoadingShell rows={1} />;

  if (!query.data) {
    return (
      <GlassPanel>
        <UnavailableState what="the fund summary" error={query.error} onRetry={() => void query.refetch()} />
      </GlassPanel>
    );
  }

  const fund = query.data;
  return (
    <>
      {query.isError && (
        <StaleNotice what="the fund summary" updatedAt={query.dataUpdatedAt} onRetry={() => void query.refetch()} />
      )}
      <div className="grid grid-cols-2 gap-4">
        <GlassPanel>
          <DataCell label="Active Participants" value={fund.participantCount} mono />
        </GlassPanel>
        <GlassPanel>
          <DataCell label="Active Proposals" value={fund.activeProposals} mono />
        </GlassPanel>
      </div>
      <StrategyPanel strategy={fund.strategy} />
      <p className="text-xs text-zinc-500">{SWF_MEMORY_NOTE}</p>
    </>
  );
}

function LiveProposals({ query, eligible }: { query: UseQueryResult<ProposalFields[]>; eligible?: number }) {
  if (query.isPending) {
    return (
      <GlassPanel>
        <p role="status" className="text-sm text-zinc-500">Loading proposals…</p>
      </GlassPanel>
    );
  }

  if (!query.data) {
    return (
      <GlassPanel>
        <UnavailableState what="proposals" error={query.error} onRetry={() => void query.refetch()} />
      </GlassPanel>
    );
  }

  return (
    <>
      {query.isError && (
        <StaleNotice what="proposals" updatedAt={query.dataUpdatedAt} onRetry={() => void query.refetch()} />
      )}
      {query.data.length === 0 ? (
        <GlassPanel>
          <EmptyState title="No active proposals" description="No allocation proposal is open for voting." />
        </GlassPanel>
      ) : (
        <ProposalsPanel proposals={query.data} eligible={eligible} />
      )}
    </>
  );
}

function NotLivePanel({ what, detail }: { what: string; detail: string }) {
  return (
    <GlassPanel>
      <NotLiveState what={what} detail={detail} hasDemo />
    </GlassPanel>
  );
}

// ── Shared sections ─────────────────────────────────────────────

function StrategyPanel({ strategy }: { strategy: SWFAllocationStrategy }) {
  return (
    <GlassPanel>
      <h2 className="text-sm font-medium text-zinc-400 mb-3">Current Allocation Strategy</h2>
      <div className="flex gap-3">
        {Object.entries(strategy).map(([key, val]) => (
          <div key={key} className="flex-1 bg-zinc-800/50 rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-emerald-300">{val}%</div>
            <div className="text-xs text-zinc-500 mt-1">
              {key.replace(/Percent$/, "").replace(/([A-Z])/g, " $1").trim()}
            </div>
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <div className="flex gap-2 border-b border-zinc-700 pb-1">
      {(["overview", "accruals", "claims", "governance"] as const).map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-3 py-1.5 text-sm rounded-t transition-colors ${
            tab === t
              ? "bg-emerald-500/20 text-emerald-300 border-b-2 border-emerald-400"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {t.charAt(0).toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}

/** Active proposals. Turnout is shown only when the active participant count is known. */
function ProposalsPanel({ proposals, eligible }: { proposals: ProposalFields[]; eligible?: number }) {
  return (
    <GlassPanel>
      <h3 className="text-sm font-medium text-zinc-400 mb-3">Active Proposals</h3>
      {proposals.map((p) => (
        <div key={p.id} className="bg-zinc-800/50 rounded-lg p-4 mb-3">
          <div className="flex justify-between items-start mb-2">
            <div>
              <h4 className="text-white font-medium">{p.title}</h4>
              <p className="text-zinc-500 text-xs mt-1">{p.description}</p>
            </div>
            <GlowBadge color="gold">{p.status}</GlowBadge>
          </div>
          <div className="flex gap-4 mt-3">
            <div className="text-sm">
              <span className="text-emerald-400">Yes: {p.yesVotes.toFixed(1)}</span>
              <span className="text-zinc-600 mx-2">|</span>
              <span className="text-red-400">No: {p.noVotes.toFixed(1)}</span>
            </div>
            <div className="text-sm text-zinc-500">
              {p.totalVoters} voters
              {eligible !== undefined && eligible > 0 &&
                ` (${Math.round((p.totalVoters / eligible) * 100)}% turnout)`}
            </div>
          </div>
          <div className="mt-2 h-2 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full"
              style={{
                width: `${(p.yesVotes / (p.yesVotes + p.noVotes || 1)) * 100}%`,
              }}
            />
          </div>
          <div className="mt-2 text-xs text-zinc-600">
            Voting ends {fmtDate(p.votingEnd)} | Quorum: {Math.round(p.quorumRequired * 100)}%
          </div>
        </div>
      ))}
    </GlassPanel>
  );
}

// ── Demo-only sections (sample values from src/demo/) ───────────

function DemoKpis() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <GlassPanel>
        <DataCell label="Fund Balance" value={<AmountDisplay amount={DEMO_SWF_SUMMARY.totalBalance} currency="USDC" />} />
      </GlassPanel>
      <GlassPanel>
        <DataCell label="Total Distributed" value={<AmountDisplay amount={DEMO_SWF_SUMMARY.totalDistributedAllTime} currency="USDC" />} />
      </GlassPanel>
      <GlassPanel>
        <DataCell label="Participants" value={DEMO_SWF_SUMMARY.participantCount} mono />
      </GlassPanel>
      <GlassPanel>
        <DataCell label="Active Proposals" value={DEMO_SWF_SUMMARY.activeProposals} mono />
      </GlassPanel>
    </div>
  );
}

function DemoOverview() {
  return (
    <div className="space-y-4">
      <EpochsPanel epochs={DEMO_SWF_EPOCHS} />
      <GlassPanel>
        <h3 className="text-sm font-medium text-zinc-400 mb-2">Chain Balances</h3>
        <div className="flex gap-4">
          {DEMO_SWF_SUMMARY.chainBalances.map((cb) => (
            <div key={cb.chain} className="bg-zinc-800/50 rounded-lg p-3">
              <div className="text-xs text-zinc-500 uppercase">{cb.chain}</div>
              <AmountDisplay amount={cb.amount} currency={cb.currency} />
            </div>
          ))}
        </div>
      </GlassPanel>
    </div>
  );
}

function EpochsPanel({ epochs }: { epochs: SWFEpoch[] }) {
  return (
    <GlassPanel>
      <h3 className="text-sm font-medium text-zinc-400 mb-3">Recent Epochs</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 text-left">
            <th className="pb-2">Epoch</th>
            <th className="pb-2">Period</th>
            <th className="pb-2">Accrued</th>
            <th className="pb-2">Distributed</th>
            <th className="pb-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {epochs.map((e) => (
            <tr key={e.id} className="border-t border-zinc-800">
              <td className="py-2 text-white">#{e.epochNumber}</td>
              <td className="py-2 text-zinc-400">
                {fmtDate(e.startTime)} — {fmtDate(e.endTime)}
              </td>
              <td className="py-2">
                <AmountDisplay amount={e.totalAccrued} currency="USDC" />
              </td>
              <td className="py-2">
                <AmountDisplay amount={e.totalDistributed} currency="USDC" />
              </td>
              <td className="py-2">
                <GlowBadge color={e.status === "active" ? "green" : e.status === "completed" ? "cyan" : "gold"}>
                  {e.status}
                </GlowBadge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </GlassPanel>
  );
}

function AccrualsPanel({ accruals }: { accruals: SWFAccrual[] }) {
  return (
    <GlassPanel>
      <h3 className="text-sm font-medium text-zinc-400 mb-3">Recent Accruals</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 text-left">
            <th className="pb-2">Source</th>
            <th className="pb-2">Gross</th>
            <th className="pb-2">Accrued (2%)</th>
            <th className="pb-2">Date</th>
          </tr>
        </thead>
        <tbody>
          {accruals.map((a) => (
            <tr key={a.id} className="border-t border-zinc-800">
              <td className="py-2">
                <GlowBadge color="cyan">{sourceLabel(a.sourceType)}</GlowBadge>
              </td>
              <td className="py-2">
                <AmountDisplay amount={a.grossAmount} currency={a.currency} />
              </td>
              <td className="py-2 text-emerald-300 font-medium">
                +<AmountDisplay amount={a.accrualAmount} currency={a.currency} />
              </td>
              <td className="py-2 text-zinc-400">{fmtDate(a.accruedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </GlassPanel>
  );
}

function ClaimsPanel({ claims }: { claims: SWFDividendClaim[] }) {
  return (
    <GlassPanel>
      <h3 className="text-sm font-medium text-zinc-400 mb-3">Your Dividend Claims</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 text-left">
            <th className="pb-2">Epoch</th>
            <th className="pb-2">Amount</th>
            <th className="pb-2">Status</th>
            <th className="pb-2">Date</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((c) => (
            <tr key={c.id} className="border-t border-zinc-800">
              <td className="py-2 text-zinc-300">{c.epochId}</td>
              <td className="py-2">
                <AmountDisplay amount={c.amount} currency="USDC" />
              </td>
              <td className="py-2">
                <GlowBadge color={c.status === "claimed" ? "green" : c.status === "pending" ? "gold" : "red"}>
                  {c.status}
                </GlowBadge>
              </td>
              <td className="py-2 text-zinc-400">{c.claimedAt ? fmtDate(c.claimedAt) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </GlassPanel>
  );
}
