import React from "react";
import { useParams, Link } from "react-router-dom";
import {
  GlassPanel,
  DataCell,
  AmountDisplay,
  GlowBadge,
  AddressDisplay,
  EmptyState,
  Skeleton,
} from "@pcc/ui";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { useUIStore } from "../stores/ui-store";
import { apiGet, apiPost } from "../lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RevenueSnapshot {
  ipId: string;
  totalRevenue: string;
  unclaimedRevenue: string;
  holderBreakdown: Array<{
    address: string;
    tokens: string;
    claimable: string;
  }>;
}

interface RoyaltySplit {
  address: string;
  role: string;
  percentage: number;
  label: string;
}

interface DerivativeLink {
  id: string;
  parentIpId: string;
  childIpId: string;
  licenseTokenId: string;
  jobId?: string;
  evidenceBundleHash: string;
  txHash: string;
  linkedAt: string;
}

interface LineageData {
  ipId: string;
  ancestors: Array<{ ipId: string; relationship: string }>;
  descendants: Array<{ ipId: string; relationship: string; jobId?: string }>;
  derivatives: DerivativeLink[];
  splits: RoyaltySplit[];
}

// ---------------------------------------------------------------------------
// Mock data (shown when API unavailable)
// ---------------------------------------------------------------------------

const MOCK_REVENUE: RevenueSnapshot = {
  ipId: "0xf1A2b3C4d5e6F7a8B9c0D1e2F3a4b5C6d7E8f9A0",
  totalRevenue: "1240.50",
  unclaimedRevenue: "340.00",
  holderBreakdown: [
    { address: "0x1111111111111111111111111111111111111111", tokens: "60", claimable: "204.00" },
    { address: "0x2222222222222222222222222222222222222222", tokens: "25", claimable: "85.00" },
    { address: "0x3333333333333333333333333333333333333333", tokens: "10", claimable: "34.00" },
    { address: "0x4444444444444444444444444444444444444444", tokens: "5", claimable: "17.00" },
  ],
};

const MOCK_SPLITS: RoyaltySplit[] = [
  { address: "0x1111111111111111111111111111111111111111", role: "designer", percentage: 60, label: "Designer" },
  { address: "0x2222222222222222222222222222222222222222", role: "operator", percentage: 25, label: "Operator" },
  { address: "0x3333333333333333333333333333333333333333", role: "verifier", percentage: 10, label: "Verifier" },
  { address: "0x4444444444444444444444444444444444444444", role: "curator", percentage: 5, label: "Network" },
];

const MOCK_DERIVATIVES: DerivativeLink[] = [
  {
    id: "deriv-001",
    parentIpId: "0xf1A2b3C4d5e6F7a8B9c0D1e2F3a4b5C6d7E8f9A0",
    childIpId: "0xC3d4E5f6A7b8C9d0E1f2A3b4C5d6E7f8A9b0C1d2",
    licenseTokenId: "42",
    jobId: "job-abc-001",
    evidenceBundleHash: "sha256:3d8f2e1a9b4c7d0e5f2a1b8c3d9e4f7a",
    txHash: "0xeee111fff222eee111fff222eee111fff222eee1",
    linkedAt: "2026-03-05T11:00:00Z",
  },
  {
    id: "deriv-002",
    parentIpId: "0xf1A2b3C4d5e6F7a8B9c0D1e2F3a4b5C6d7E8f9A0",
    childIpId: "0xD4e5F6a7B8c9D0e1F2a3B4c5D6e7F8a9B0c1D2e3",
    licenseTokenId: "43",
    jobId: "job-def-002",
    evidenceBundleHash: "sha256:7a2c4e6f8b0d2e4a6c8e0f2a4c6e8a0c",
    txHash: "0xfff333aaa444fff333aaa444fff333aaa444fff3",
    linkedAt: "2026-03-08T14:30:00Z",
  },
];

const MOCK_ANCESTORS = [
  { ipId: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA01", relationship: "license-parent" },
];

const SPLIT_COLORS = ["#34d399", "#60a5fa", "#f59e0b", "#a78bfa", "#fb7185"];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SplitPieChart({ splits }: { splits: RoyaltySplit[] }) {
  const data = splits.map((s) => ({ name: s.label, value: s.percentage }));
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={75}
            paddingAngle={2}
            dataKey="value"
          >
            {data.map((_, i) => (
              <Cell key={i} fill={SPLIT_COLORS[i % SPLIT_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: "rgba(0,0,0,0.85)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "6px",
              color: "#fff",
              fontSize: "12px",
            }}
            formatter={(val: number) => `${val}%`}
          />
          <Legend
            formatter={(value) => (
              <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 11 }}>{value}</span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

interface LineageTreeProps {
  ancestors: Array<{ ipId: string; relationship: string }>;
  currentIpId: string;
  descendants: Array<{ ipId: string; relationship: string; jobId?: string }>;
}

function LineageTree({ ancestors, currentIpId, descendants }: LineageTreeProps) {
  return (
    <div className="space-y-1 font-mono text-xs">
      {ancestors.map((a, i) => (
        <div key={i} className="flex items-center gap-2 text-white/40">
          <span className="text-white/20">↑</span>
          <Link
            to={`/ip/${a.ipId}`}
            className="text-sky-400/70 hover:text-sky-400 transition-colors"
          >
            {a.ipId.slice(0, 8)}…{a.ipId.slice(-6)}
          </Link>
          <span className="text-white/20">({a.relationship})</span>
        </div>
      ))}
      <div className="flex items-center gap-2 pl-2 border-l border-emerald-500/30 text-white/80">
        <span className="text-emerald-400/60">●</span>
        <span className="text-white/60">
          {currentIpId.slice(0, 8)}…{currentIpId.slice(-6)}
        </span>
        <GlowBadge color="green">current</GlowBadge>
      </div>
      {descendants.map((d, i) => (
        <div key={i} className="flex items-center gap-2 pl-4 text-white/40">
          <span className="text-white/20">↓</span>
          <Link
            to={`/ip/${d.ipId}`}
            className="text-violet-400/70 hover:text-violet-400 transition-colors"
          >
            {d.ipId.slice(0, 8)}…{d.ipId.slice(-6)}
          </Link>
          {d.jobId && (
            <Link to={`/jobs/${d.jobId}`} className="text-white/30 hover:text-white/60">
              [{d.jobId}]
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function IPDetailPage() {
  const { ipId } = useParams<{ ipId: string }>();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const [revenue, setRevenue] = React.useState<RevenueSnapshot | null>(null);
  const [splits, setSplits] = React.useState<RoyaltySplit[]>([]);
  const [derivatives, setDerivatives] = React.useState<DerivativeLink[]>([]);
  const [ancestors, setAncestors] = React.useState<
    Array<{ ipId: string; relationship: string }>
  >([]);
  const [descendants, setDescendants] = React.useState<
    Array<{ ipId: string; relationship: string; jobId?: string }>
  >([]);
  const [loading, setLoading] = React.useState(true);
  const [claiming, setClaiming] = React.useState(false);
  const [claimMsg, setClaimMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPageMeta(
      "IP Detail",
      ipId ? `${ipId.slice(0, 8)}…${ipId.slice(-6)}` : "IP Asset"
    );
  }, [setPageMeta, ipId]);

  React.useEffect(() => {
    if (!ipId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        // Fetch revenue snapshot
        const snap = await apiGet<RevenueSnapshot>(`/api/ip/${ipId}/revenue`);
        if (!cancelled) setRevenue(snap);
      } catch {
        if (!cancelled) setRevenue(MOCK_REVENUE);
      }

      try {
        // Fetch lineage (includes derivatives, ancestors, descendants, splits)
        const lineage = await apiGet<LineageData>(`/api/ip/${ipId}/lineage`);
        if (!cancelled) {
          setDerivatives(lineage.derivatives ?? []);
          setAncestors(lineage.ancestors ?? []);
          setDescendants(lineage.descendants ?? []);
          setSplits(lineage.splits ?? []);
        }
      } catch {
        if (!cancelled) {
          setDerivatives(MOCK_DERIVATIVES);
          setAncestors(MOCK_ANCESTORS);
          setDescendants(
            MOCK_DERIVATIVES.map((d) => ({
              ipId: d.childIpId,
              relationship: "derivative",
              jobId: d.jobId,
            }))
          );
          setSplits(MOCK_SPLITS);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [ipId]);

  async function handleClaimAll() {
    if (!ipId) return;
    setClaiming(true);
    setClaimMsg(null);
    try {
      const result = await apiPost<{ claimed: string; txHash?: string }>(
        `/api/ip/${ipId}/claim`,
        {}
      );
      setClaimMsg(`Claimed ${result.claimed} USDC${result.txHash ? ` · TX: ${result.txHash.slice(0, 10)}…` : ""}`);
      setRevenue((prev) => prev ? { ...prev, unclaimedRevenue: "0" } : prev);
    } catch (err) {
      setClaimMsg(`Error: ${err instanceof Error ? err.message : "claim failed"}`);
    } finally {
      setClaiming(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        {[1, 2, 3].map((n) => (
          <GlassPanel key={n} padding="md">
            <Skeleton className="h-24" />
          </GlassPanel>
        ))}
      </div>
    );
  }

  const unclaimed = parseFloat(revenue?.unclaimedRevenue ?? "0");

  return (
    <div className="space-y-6">
      {/* Header */}
      <GlassPanel padding="md">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="text-xs text-white/40 mb-1">IP Asset ID</div>
            <div className="font-mono text-sm text-white/80 break-all">{ipId}</div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/ip"
              className="px-3 py-1.5 text-xs rounded bg-white/[0.06] text-white/60 hover:bg-white/[0.10] hover:text-white/80 transition-colors border border-white/[0.08]"
            >
              ← Back to IP Assets
            </Link>
            <Link
              to="/ip/claims"
              className="px-3 py-1.5 text-xs rounded bg-white/[0.06] text-white/60 hover:bg-white/[0.10] hover:text-white/80 transition-colors border border-white/[0.08]"
            >
              Claims History
            </Link>
          </div>
        </div>
      </GlassPanel>

      {/* Revenue section */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">
          Revenue
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <GlassPanel padding="md" glow={revenue && parseFloat(revenue.totalRevenue) > 0 ? "green" : undefined}>
            <DataCell
              label="Total Revenue"
              value={
                <AmountDisplay
                  amount={revenue?.totalRevenue ?? "0"}
                  currency="USDC"
                  size="md"
                />
              }
            />
          </GlassPanel>
          <GlassPanel padding="md" glow={unclaimed > 0 ? "gold" : undefined}>
            <DataCell
              label="Unclaimed"
              value={
                <AmountDisplay
                  amount={revenue?.unclaimedRevenue ?? "0"}
                  currency="USDC"
                  size="md"
                />
              }
            />
          </GlassPanel>
          <GlassPanel padding="md">
            <DataCell
              label="Token Holders"
              value={revenue?.holderBreakdown?.length ?? 0}
              mono
            />
          </GlassPanel>
          <GlassPanel padding="md">
            <DataCell
              label="Derivatives"
              value={derivatives.length}
              mono
            />
          </GlassPanel>
        </div>

        {/* Claim All */}
        {unclaimed > 0 && (
          <GlassPanel padding="md" glow="gold">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="text-sm font-medium text-white/80">
                  {unclaimed.toFixed(2)} USDC available to claim
                </div>
                {claimMsg && (
                  <div className="text-xs text-white/50 mt-1">{claimMsg}</div>
                )}
              </div>
              <button
                onClick={handleClaimAll}
                disabled={claiming}
                className="px-4 py-2 text-sm rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-50 transition-colors border border-emerald-500/30 font-medium"
              >
                {claiming ? "Claiming…" : "Claim All"}
              </button>
            </div>
          </GlassPanel>
        )}

        {/* Per-holder breakdown */}
        {revenue?.holderBreakdown && revenue.holderBreakdown.length > 0 && (
          <div className="mt-3">
            <h4 className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2">
              Holder Breakdown
            </h4>
            <GlassPanel padding="md">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-white/40 border-b border-white/[0.06]">
                    <th className="text-left py-2 px-3 font-medium">Address</th>
                    <th className="text-right py-2 px-3 font-medium">Tokens</th>
                    <th className="text-right py-2 px-3 font-medium">Claimable</th>
                  </tr>
                </thead>
                <tbody>
                  {revenue.holderBreakdown.map((h, i) => (
                    <tr
                      key={i}
                      className="border-b border-white/[0.04] hover:bg-white/[0.02]"
                    >
                      <td className="py-2 px-3">
                        <AddressDisplay address={h.address} />
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-white/60">
                        {h.tokens}%
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-emerald-400/80">
                        {parseFloat(h.claimable).toFixed(2)} USDC
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </GlassPanel>
          </div>
        )}
      </div>

      {/* Splits section */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">
          Revenue Splits
        </h3>
        {splits.length === 0 ? (
          <GlassPanel padding="md">
            <EmptyState
              title="No splits configured"
              description="Revenue splits define how royalties are distributed between designers, operators, verifiers, and the network."
            />
          </GlassPanel>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <GlassPanel padding="md">
              <SplitPieChart splits={splits} />
            </GlassPanel>
            <GlassPanel padding="md">
              <div className="space-y-2">
                {splits.map((s, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ background: SPLIT_COLORS[i % SPLIT_COLORS.length] }}
                      />
                      <div>
                        <div className="text-sm text-white/70">{s.label}</div>
                        <AddressDisplay address={s.address} />
                      </div>
                    </div>
                    <div className="text-sm font-mono font-medium text-white/80">
                      {s.percentage}%
                    </div>
                  </div>
                ))}
              </div>
            </GlassPanel>
          </div>
        )}
      </div>

      {/* Derivatives section */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">
          Derivatives ({derivatives.length})
        </h3>
        {derivatives.length === 0 ? (
          <GlassPanel padding="md">
            <EmptyState
              title="No derivatives yet"
              description="When jobs use this capability's IP license, they are registered as derivative IP assets here."
            />
          </GlassPanel>
        ) : (
          <div className="space-y-2">
            {derivatives.map((d) => (
              <GlassPanel key={d.id} padding="md" hover>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white/40">Child IP</span>
                      <Link
                        to={`/ip/${d.childIpId}`}
                        className="font-mono text-xs text-violet-400/70 hover:text-violet-400"
                      >
                        {d.childIpId.slice(0, 8)}…{d.childIpId.slice(-6)}
                      </Link>
                    </div>
                    {d.jobId && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-white/40">Job</span>
                        <Link
                          to={`/jobs/${d.jobId}`}
                          className="text-xs text-sky-400/70 hover:text-sky-400"
                        >
                          {d.jobId}
                        </Link>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white/40">Evidence</span>
                      <span className="font-mono text-xs text-white/30">
                        {d.evidenceBundleHash.slice(0, 20)}…
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-white/30">
                      {new Date(d.linkedAt).toLocaleDateString()}
                    </div>
                    <div className="font-mono text-xs text-white/20 mt-0.5">
                      License #{d.licenseTokenId}
                    </div>
                  </div>
                </div>
              </GlassPanel>
            ))}
          </div>
        )}
      </div>

      {/* Lineage section */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">
          Lineage
        </h3>
        <GlassPanel padding="md">
          {ancestors.length === 0 && descendants.length === 0 ? (
            <div className="text-xs text-white/30 text-center py-2">
              This is a root IP asset — no ancestors or descendants yet.
            </div>
          ) : (
            <LineageTree
              ancestors={ancestors}
              currentIpId={ipId ?? ""}
              descendants={descendants}
            />
          )}
        </GlassPanel>
      </div>
    </div>
  );
}
