import React, { useState } from "react";
import { GlassPanel, DataCell, AmountDisplay, GlowBadge } from "@pcc/ui";
import type {
  SWFSummary,
  SWFEpoch,
  SWFAccrual,
  SWFDividendClaim,
  SWFProposal,
  SWFAllocationStrategy,
} from "@pcc/spec";

// ── Mock Data ───────────────────────────────────────────────────

const MOCK_STRATEGY: SWFAllocationStrategy = {
  dividendPercent: 60,
  infrastructurePercent: 25,
  grantsPercent: 10,
  reservePercent: 5,
};

const MOCK_SUMMARY: SWFSummary = {
  totalBalance: "48250.00",
  totalDistributedAllTime: "124780.50",
  totalAccruedAllTime: "173030.50",
  currentEpochId: "swf_epoch_0012",
  currentAllocationStrategy: MOCK_STRATEGY,
  participantCount: 47,
  activeProposals: 2,
  lastDistributionAt: "2026-03-14T00:00:00Z",
  chainBalances: [
    { chain: "base", currency: "USDC", amount: "38250.00" },
    { chain: "solana", currency: "USDC", amount: "10000.00" },
  ],
};

const MOCK_EPOCHS: SWFEpoch[] = [
  {
    id: "swf_epoch_0012",
    epochNumber: 12,
    startTime: "2026-03-14T00:00:00Z",
    endTime: "2026-03-21T00:00:00Z",
    totalAccrued: "4280.00",
    totalDistributed: "0",
    allocationStrategy: MOCK_STRATEGY,
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
    allocationStrategy: MOCK_STRATEGY,
    status: "completed",
    participantCount: 45,
    scores: [],
  },
];

const MOCK_ACCRUALS: SWFAccrual[] = [
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

const MOCK_CLAIMS: SWFDividendClaim[] = [
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

const MOCK_PROPOSALS: SWFProposal[] = [
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

// ── Helpers ─────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function sourceLabel(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Component ───────────────────────────────────────────────────

export function SWFDashboardPage() {
  const [tab, setTab] = useState<"overview" | "accruals" | "claims" | "governance">("overview");

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-2xl font-bold text-emerald-300 tracking-tight">
        Sovereign Wealth Fund
      </h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassPanel>
          <DataCell label="Fund Balance">
            <AmountDisplay amount={MOCK_SUMMARY.totalBalance} currency="USDC" />
          </DataCell>
        </GlassPanel>
        <GlassPanel>
          <DataCell label="Total Distributed">
            <AmountDisplay amount={MOCK_SUMMARY.totalDistributedAllTime} currency="USDC" />
          </DataCell>
        </GlassPanel>
        <GlassPanel>
          <DataCell label="Participants">
            <span className="text-xl font-semibold text-white">{MOCK_SUMMARY.participantCount}</span>
          </DataCell>
        </GlassPanel>
        <GlassPanel>
          <DataCell label="Active Proposals">
            <span className="text-xl font-semibold text-amber-400">{MOCK_SUMMARY.activeProposals}</span>
          </DataCell>
        </GlassPanel>
      </div>

      {/* Allocation Strategy */}
      <GlassPanel>
        <h2 className="text-sm font-medium text-zinc-400 mb-3">Current Allocation Strategy</h2>
        <div className="flex gap-3">
          {Object.entries(MOCK_STRATEGY).map(([key, val]) => (
            <div key={key} className="flex-1 bg-zinc-800/50 rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-emerald-300">{val}%</div>
              <div className="text-xs text-zinc-500 mt-1">
                {key.replace(/Percent$/, "").replace(/([A-Z])/g, " $1").trim()}
              </div>
            </div>
          ))}
        </div>
      </GlassPanel>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-zinc-700 pb-1">
        {(["overview", "accruals", "claims", "governance"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
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

      {/* Tab Content */}
      {tab === "overview" && (
        <div className="space-y-4">
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
                {MOCK_EPOCHS.map((e) => (
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
                      <GlowBadge
                        label={e.status}
                        color={e.status === "active" ? "emerald" : e.status === "completed" ? "blue" : "amber"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassPanel>

          <GlassPanel>
            <h3 className="text-sm font-medium text-zinc-400 mb-2">Chain Balances</h3>
            <div className="flex gap-4">
              {MOCK_SUMMARY.chainBalances.map((cb) => (
                <div key={cb.chain} className="bg-zinc-800/50 rounded-lg p-3">
                  <div className="text-xs text-zinc-500 uppercase">{cb.chain}</div>
                  <AmountDisplay amount={cb.amount} currency={cb.currency} />
                </div>
              ))}
            </div>
          </GlassPanel>
        </div>
      )}

      {tab === "accruals" && (
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
              {MOCK_ACCRUALS.map((a) => (
                <tr key={a.id} className="border-t border-zinc-800">
                  <td className="py-2">
                    <GlowBadge label={sourceLabel(a.sourceType)} color="cyan" />
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
      )}

      {tab === "claims" && (
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
              {MOCK_CLAIMS.map((c) => (
                <tr key={c.id} className="border-t border-zinc-800">
                  <td className="py-2 text-zinc-300">{c.epochId}</td>
                  <td className="py-2">
                    <AmountDisplay amount={c.amount} currency="USDC" />
                  </td>
                  <td className="py-2">
                    <GlowBadge
                      label={c.status}
                      color={c.status === "claimed" ? "emerald" : c.status === "pending" ? "amber" : "red"}
                    />
                  </td>
                  <td className="py-2 text-zinc-400">{c.claimedAt ? fmtDate(c.claimedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </GlassPanel>
      )}

      {tab === "governance" && (
        <GlassPanel>
          <h3 className="text-sm font-medium text-zinc-400 mb-3">Active Proposals</h3>
          {MOCK_PROPOSALS.map((p) => (
            <div key={p.id} className="bg-zinc-800/50 rounded-lg p-4 mb-3">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h4 className="text-white font-medium">{p.title}</h4>
                  <p className="text-zinc-500 text-xs mt-1">{p.description}</p>
                </div>
                <GlowBadge label={p.status} color="amber" />
              </div>
              <div className="flex gap-4 mt-3">
                <div className="text-sm">
                  <span className="text-emerald-400">Yes: {p.yesVotes.toFixed(1)}</span>
                  <span className="text-zinc-600 mx-2">|</span>
                  <span className="text-red-400">No: {p.noVotes.toFixed(1)}</span>
                </div>
                <div className="text-sm text-zinc-500">
                  {p.totalVoters} voters ({Math.round((p.totalVoters / MOCK_SUMMARY.participantCount) * 100)}% turnout)
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
      )}
    </div>
  );
}
