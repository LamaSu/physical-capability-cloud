import React from "react";
import { useNavigate } from "react-router-dom";
import {
  GlassPanel,
  GlowBadge,
  AmountDisplay,
  DataCell,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store";
import { apiGet, apiPost } from "../lib/api";

// ── Types ───────────────────────────────────────────────────────

interface IPAsset {
  ipId: string;
  name: string;
  totalRevenue: string;
  unclaimed: string;
  derivatives: number;
  splitDesigner?: number;
  splitOperator?: number;
  splitVerifier?: number;
  splitNetwork?: number;
}

interface RevenuePoint {
  date: string;
  revenue: number;
}

interface RoyaltySlice {
  address: string;
  percentage: number;
  label: string;
}

interface IPLineageNode {
  ipId: string;
  name: string;
  children?: IPLineageNode[];
}

// ── Mock Data ────────────────────────────────────────────────────

const MOCK_IP_ASSETS: IPAsset[] = [
  { ipId: "0xip001abc", name: "FDM 3D Printing",        totalRevenue: "1,250.00", unclaimed: "340.00", derivatives: 12, splitDesigner: 10, splitOperator: 70, splitVerifier: 10, splitNetwork: 10 },
  { ipId: "0xip002def", name: "2D Document Printing",   totalRevenue: "89.50",    unclaimed: "89.50",  derivatives: 3,  splitDesigner: 10, splitOperator: 70, splitVerifier: 10, splitNetwork: 10 },
  { ipId: "0xip003ghi", name: "CNC 3-Axis Milling",     totalRevenue: "4,780.00", unclaimed: "0.00",   derivatives: 28, splitDesigner: 5,  splitOperator: 75, splitVerifier: 10, splitNetwork: 10 },
];

const MOCK_REVENUE_HISTORY: RevenuePoint[] = [
  { date: "Mar 1",  revenue: 210 },
  { date: "Mar 5",  revenue: 390 },
  { date: "Mar 8",  revenue: 520 },
  { date: "Mar 12", revenue: 680 },
  { date: "Mar 15", revenue: 830 },
  { date: "Mar 18", revenue: 1050 },
  { date: "Mar 21", revenue: 1250 },
];

const MOCK_ROYALTY_SLICES: RoyaltySlice[] = [
  { address: "0xOp...001", percentage: 70, label: "Operator" },
  { address: "0xDs...002", percentage: 15, label: "CSD Author" },
  { address: "0xVr...003", percentage: 10, label: "Verifier" },
  { address: "0xPr...004", percentage: 5,  label: "Protocol" },
];

const MOCK_LINEAGE: IPLineageNode = {
  ipId: "0xip000",
  name: "Physical Capability Base",
  children: [
    {
      ipId: "0xip001",
      name: "FDM 3D Printing",
      children: [
        { ipId: "0xip011", name: "PLA Print v1.2" },
        { ipId: "0xip012", name: "PETG Print v2.0" },
        { ipId: "0xip013", name: "Flexible TPU v1.0" },
      ],
    },
    {
      ipId: "0xip002",
      name: "2D Document Printing",
      children: [
        { ipId: "0xip021", name: "Poster Large Format" },
      ],
    },
    {
      ipId: "0xip003",
      name: "CNC 3-Axis Milling",
      children: [
        { ipId: "0xip031", name: "Aluminum Profile Cut" },
        { ipId: "0xip032", name: "Steel Bracket v3" },
      ],
    },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────

const ROYALTY_COLORS = [
  "bg-green-500",
  "bg-blue-500",
  "bg-purple-500",
  "bg-gray-500",
  "bg-yellow-500",
];

const ROYALTY_TEXT_COLORS = [
  "text-green-400",
  "text-blue-400",
  "text-purple-400",
  "text-gray-400",
  "text-yellow-400",
];

function formatRevenue(val: string): number {
  return parseFloat(val.replace(/,/g, ""));
}

// ── Sub-components ───────────────────────────────────────────────

function MiniBarChart({ data }: { data: RevenuePoint[] }) {
  const max = Math.max(...data.map((d) => d.revenue));
  return (
    <div className="flex items-end gap-1 h-16 w-full">
      {data.map((point, i) => {
        const height = max > 0 ? (point.revenue / max) * 100 : 0;
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1 group" title={`${point.date}: $${point.revenue}`}>
            <div
              className="w-full rounded-t bg-emerald-500/30 group-hover:bg-emerald-500/50 transition-colors"
              style={{ height: `${height}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

function RoyaltyPie({ slices }: { slices: RoyaltySlice[] }) {
  // Simple horizontal stacked bar (no external chart lib needed)
  return (
    <div className="space-y-3">
      <div className="h-4 rounded-full overflow-hidden flex bg-white/[0.05]">
        {slices.map((s, i) => (
          <div
            key={i}
            className={`h-full transition-all duration-300 ${ROYALTY_COLORS[i % ROYALTY_COLORS.length]}`}
            style={{ width: `${s.percentage}%` }}
            title={`${s.label}: ${s.percentage}%`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${ROYALTY_COLORS[i % ROYALTY_COLORS.length]}`} />
            <span className={`text-xs ${ROYALTY_TEXT_COLORS[i % ROYALTY_TEXT_COLORS.length]}`}>
              {s.label}
            </span>
            <span className="text-xs text-white/30 font-mono">{s.percentage}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineageTree({ node, depth = 0 }: { node: IPLineageNode; depth?: number }) {
  const [expanded, setExpanded] = React.useState(depth < 1);
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div style={{ paddingLeft: depth > 0 ? "1.25rem" : 0 }}>
      <div
        className={`flex items-center gap-2 py-1 text-xs group ${hasChildren ? "cursor-pointer" : ""}`}
        onClick={() => hasChildren && setExpanded((e) => !e)}
      >
        {hasChildren && (
          <span className="text-white/30 w-3 text-center select-none">
            {expanded ? "▾" : "▸"}
          </span>
        )}
        {!hasChildren && <span className="w-3" />}
        <span className="font-mono text-white/30 text-[10px]">{node.ipId}</span>
        <span className="text-white/70 group-hover:text-white/90 transition-colors">{node.name}</span>
        {hasChildren && (
          <span className="text-white/20 text-[10px]">
            {node.children!.length} {node.children!.length === 1 ? "child" : "children"}
          </span>
        )}
      </div>
      {expanded && hasChildren && (
        <div className="border-l border-white/[0.06] ml-1.5">
          {node.children!.map((child) => (
            <LineageTree key={child.ipId} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────

export function IPRevenuePage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const navigate = useNavigate();

  const [assets, setAssets] = React.useState<IPAsset[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [claimingId, setClaimingId] = React.useState<string | null>(null);
  const [claimedIds, setClaimedIds] = React.useState<Set<string>>(new Set());
  const [selectedAssetId, setSelectedAssetId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPageMeta("IP Revenue", "Story Protocol IP assets, royalties, and lineage");
  }, [setPageMeta]);

  // Try to load from API, fall back to mock data
  React.useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiGet<{ assets: IPAsset[] }>("/ip/assets")
      .then((res) => { if (mounted) { setAssets(res.assets); setLoading(false); } })
      .catch(() => {
        if (mounted) {
          setAssets(MOCK_IP_ASSETS);
          setLoading(false);
        }
      });
    return () => { mounted = false; };
  }, []);

  async function handleClaim(ipId: string) {
    setClaimingId(ipId);
    try {
      await apiPost(`/ip/${ipId}/claim`, {});
    } catch {
      // mock success in demo mode
    }
    setClaimedIds((prev) => new Set([...prev, ipId]));
    setAssets((prev) =>
      prev.map((a) => (a.ipId === ipId ? { ...a, unclaimed: "0.00" } : a)),
    );
    setClaimingId(null);
  }

  const totalRevenue = assets.reduce((acc, a) => acc + formatRevenue(a.totalRevenue), 0);
  const totalUnclaimed = assets.reduce((acc, a) => acc + formatRevenue(a.unclaimed), 0);
  const totalDerivatives = assets.reduce((acc, a) => acc + a.derivatives, 0);

  const selectedAsset = selectedAssetId
    ? assets.find((a) => a.ipId === selectedAssetId) ?? null
    : null;

  return (
    <div className="space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassPanel padding="md" glow="green">
          <DataCell
            label="Total IP Revenue"
            value={<AmountDisplay amount={totalRevenue.toFixed(2)} currency="USD" size="md" />}
            sub="all time"
          />
        </GlassPanel>
        <GlassPanel padding="md" glow="gold">
          <DataCell
            label="Unclaimed"
            value={<AmountDisplay amount={totalUnclaimed.toFixed(2)} currency="USD" size="md" />}
            sub="ready to claim"
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="IP Assets" value={assets.length} sub="registered on Story" mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Derivatives" value={totalDerivatives} sub="child IPs created" mono />
        </GlassPanel>
      </div>

      {/* IP Asset Cards */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">
          IP Assets
        </h3>
        {loading ? (
          <div className="grid grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <GlassPanel key={i} padding="md">
                <div className="animate-pulse space-y-3">
                  <div className="h-3 bg-white/[0.06] rounded w-3/4" />
                  <div className="h-8 bg-white/[0.04] rounded" />
                  <div className="h-3 bg-white/[0.04] rounded w-1/2" />
                </div>
              </GlassPanel>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {assets.map((asset) => {
              const unclaimed = formatRevenue(asset.unclaimed);
              const hasClaimed = claimedIds.has(asset.ipId);
              const isSelected = selectedAssetId === asset.ipId;

              return (
                <GlassPanel
                  key={asset.ipId}
                  padding="md"
                  hover
                  glow={isSelected ? "green" : "none"}
                  onClick={() => setSelectedAssetId(isSelected ? null : asset.ipId)}
                >
                  <div className="space-y-3">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-white/30">{asset.ipId}</span>
                      <GlowBadge color={unclaimed > 0 && !hasClaimed ? "gold" : "green"}>
                        {hasClaimed ? "claimed" : unclaimed > 0 ? "unclaimed" : "settled"}
                      </GlowBadge>
                    </div>

                    {/* Name */}
                    <div className="text-sm font-medium text-white/80">{asset.name}</div>

                    {/* Revenue figures */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <div className="text-white/30">Total Revenue</div>
                        <div className="font-mono text-emerald-400/80 text-sm">
                          ${asset.totalRevenue}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/30">Unclaimed</div>
                        <div className={`font-mono text-sm ${unclaimed > 0 && !hasClaimed ? "text-yellow-400/80" : "text-white/40"}`}>
                          ${hasClaimed ? "0.00" : asset.unclaimed}
                        </div>
                      </div>
                    </div>

                    {/* Derivatives */}
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-white/30">Derivatives</span>
                      <span className="font-mono text-white/50">{asset.derivatives} child IPs</span>
                    </div>

                    {/* Revenue split bar */}
                    {(asset.splitOperator !== undefined) && (
                      <div>
                        <div className="text-[10px] text-white/25 uppercase tracking-wider mb-1">Revenue Split</div>
                        <div className="h-2 rounded-full overflow-hidden flex bg-white/[0.05]">
                          <div className="h-full bg-green-500 transition-all" style={{ width: `${asset.splitOperator}%` }} title={`Operator: ${asset.splitOperator}%`} />
                          <div className="h-full bg-blue-500 transition-all"  style={{ width: `${asset.splitDesigner ?? 0}%` }} title={`Designer: ${asset.splitDesigner}%`} />
                          <div className="h-full bg-purple-500 transition-all" style={{ width: `${asset.splitVerifier ?? 0}%` }} title={`Verifier: ${asset.splitVerifier}%`} />
                          <div className="h-full bg-gray-500 transition-all"  style={{ width: `${asset.splitNetwork ?? 0}%` }} title={`Network: ${asset.splitNetwork}%`} />
                        </div>
                        <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1">
                          {[
                            { label: "Op", pct: asset.splitOperator, color: "bg-green-500" },
                            { label: "Ds", pct: asset.splitDesigner ?? 0, color: "bg-blue-500" },
                            { label: "Vr", pct: asset.splitVerifier ?? 0, color: "bg-purple-500" },
                            { label: "Net", pct: asset.splitNetwork ?? 0, color: "bg-gray-500" },
                          ].map((seg) => (
                            <div key={seg.label} className="flex items-center gap-0.5">
                              <div className={`w-1.5 h-1.5 rounded-full ${seg.color}`} />
                              <span className="text-[9px] text-white/30">{seg.label} {seg.pct}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Claim button */}
                    {unclaimed > 0 && !hasClaimed && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleClaim(asset.ipId);
                        }}
                        disabled={claimingId === asset.ipId}
                        className={`w-full py-2 rounded-lg text-xs font-medium transition-all ${
                          claimingId === asset.ipId
                            ? "bg-white/[0.04] border border-white/[0.08] text-white/30 cursor-wait"
                            : "bg-yellow-500/15 border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/25"
                        }`}
                      >
                        {claimingId === asset.ipId ? "Claiming…" : `Claim $${asset.unclaimed}`}
                      </button>
                    )}
                  </div>
                </GlassPanel>
              );
            })}
          </div>
        )}
      </div>

      {/* Revenue Chart + Royalty Distribution row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Revenue over time */}
        <GlassPanel padding="lg">
          <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-4">
            Revenue Over Time
            {selectedAsset && (
              <span className="ml-2 text-emerald-400/70 normal-case font-normal">
                — {selectedAsset.name}
              </span>
            )}
          </h3>
          <MiniBarChart data={MOCK_REVENUE_HISTORY} />
          <div className="flex items-center justify-between mt-2 text-[10px] text-white/25">
            {MOCK_REVENUE_HISTORY.map((d) => (
              <span key={d.date}>{d.date.replace("Mar ", "")}</span>
            ))}
          </div>
        </GlassPanel>

        {/* Royalty token distribution */}
        <GlassPanel padding="lg">
          <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-4">
            Royalty Token Distribution
          </h3>
          <RoyaltyPie slices={MOCK_ROYALTY_SLICES} />
          <div className="mt-4 space-y-1.5">
            {MOCK_ROYALTY_SLICES.map((s, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${ROYALTY_COLORS[i % ROYALTY_COLORS.length]}`} />
                  <span className="text-white/50">{s.label}</span>
                </div>
                <span className="font-mono text-white/30 text-[10px]">{s.address}</span>
                <span className={`font-mono text-xs ${ROYALTY_TEXT_COLORS[i % ROYALTY_TEXT_COLORS.length]}`}>
                  {s.percentage}%
                </span>
              </div>
            ))}
          </div>
        </GlassPanel>
      </div>

      {/* IP Lineage */}
      <GlassPanel padding="lg">
        <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-4">
          IP Lineage
        </h3>
        <div className="text-[10px] text-white/25 mb-3">
          Click a node to expand / collapse children.
        </div>
        <LineageTree node={MOCK_LINEAGE} />
      </GlassPanel>

      {/* Quick link to DePIN */}
      <div className="flex justify-end">
        <button
          onClick={() => navigate("/depin")}
          className="text-xs text-white/30 hover:text-white/60 transition-colors"
        >
          View DePIN Rewards →
        </button>
      </div>
    </div>
  );
}
