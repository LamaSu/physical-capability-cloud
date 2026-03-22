import React from "react";
import { Link } from "react-router-dom";
import {
  GlassPanel,
  DataCell,
  AmountDisplay,
  GlowBadge,
  AddressDisplay,
  StatusChip,
  EmptyState,
  Skeleton,
} from "@pcc/ui";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { useUIStore } from "../stores/ui-store";
import { apiGet, apiPost } from "../lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IPRegistration {
  ipId: string;
  nftTokenId: string;
  licenseTermsId: string;
  txHash: string;
  capabilityId?: string;
  csdUrl?: string;
  chain: string;
  registeredAt: string;
  // enriched fields (from revenue snapshot)
  totalRevenue?: string;
  unclaimedRevenue?: string;
  derivativeCount?: number;
  capabilityName?: string;
  capabilityType?: string;
  status?: "active" | "inactive";
}

interface RevenueSnapshot {
  ipId: string;
  totalRevenue: string;
  unclaimedRevenue: string;
  holderBreakdown: Array<{ address: string; tokens: string; claimable: string }>;
  derivativeCount?: number;
}

// ---------------------------------------------------------------------------
// Mock data (shown when API unavailable)
// ---------------------------------------------------------------------------

const MOCK_IP_ASSETS: IPRegistration[] = [
  {
    ipId: "0xf1A2b3C4d5e6F7a8B9c0D1e2F3a4b5C6d7E8f9A0",
    nftTokenId: "1",
    licenseTermsId: "7",
    txHash: "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1",
    capabilityId: "cap-fdm-001",
    csdUrl: "ipfs://QmCapabilityFDM001",
    chain: "story-testnet",
    registeredAt: "2026-03-01T10:00:00Z",
    capabilityName: "FDM 3D Printing",
    capabilityType: "fdm",
    totalRevenue: "1240.50",
    unclaimedRevenue: "340.00",
    derivativeCount: 8,
    status: "active",
  },
  {
    ipId: "0xA1b2C3d4E5f6A7b8C9d0E1f2A3b4C5d6E7f8A9b0",
    nftTokenId: "2",
    licenseTermsId: "7",
    txHash: "0xdef456abc123def456abc123def456abc123def456abc123def456abc123def4",
    capabilityId: "cap-cnc-002",
    csdUrl: "ipfs://QmCapabilityCNC002",
    chain: "story-testnet",
    registeredAt: "2026-02-20T14:30:00Z",
    capabilityName: "CNC 3-Axis Milling",
    capabilityType: "cnc-3axis",
    totalRevenue: "3870.00",
    unclaimedRevenue: "0",
    derivativeCount: 15,
    status: "active",
  },
  {
    ipId: "0xB2c3D4e5F6b7C8d9E0f1B2c3D4e5F6b7C8d9E0f1",
    nftTokenId: "3",
    licenseTermsId: "12",
    txHash: "0x789abc456def789abc456def789abc456def789abc456def789abc456def789a",
    capabilityId: "cap-laser-003",
    csdUrl: "ipfs://QmCapabilityLaser003",
    chain: "story-testnet",
    registeredAt: "2026-01-15T08:00:00Z",
    capabilityName: "Laser Cutting",
    capabilityType: "laser-cut",
    totalRevenue: "560.25",
    unclaimedRevenue: "560.25",
    derivativeCount: 3,
    status: "inactive",
  },
];

const MOCK_REVENUE_HISTORY = [
  { month: "Jan", revenue: 420 },
  { month: "Feb", revenue: 890 },
  { month: "Mar", revenue: 1540 },
  { month: "Apr", revenue: 1240 },
  { month: "May", revenue: 2100 },
  { month: "Jun", revenue: 1870 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function ipStatusColor(status?: string): "green" | "gray" {
  return status === "active" ? "green" : "gray";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IPDashboardPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const [assets, setAssets] = React.useState<IPRegistration[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [claimingId, setClaimingId] = React.useState<string | null>(null);
  const [claimResult, setClaimResult] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    setPageMeta("IP Assets", "Story Protocol IP registrations, revenue, and lineage");
  }, [setPageMeta]);

  // Fetch IP registrations — try the DB-backed list via CSD route, fall back to mock
  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        // Try to fetch all CSD-linked IPs via the story ip registrations
        // The gateway exposes /api/ip/capability/:capabilityId so we fetch known caps
        const capsRes = await apiGet<{ capabilities?: any[] }>("/api/csd");
        const caps: any[] = capsRes?.capabilities ?? [];

        if (caps.length === 0) throw new Error("no capabilities");

        const enriched: IPRegistration[] = [];
        for (const cap of caps) {
          try {
            const { registration } = await apiGet<{ registration: IPRegistration }>(
              `/api/ip/capability/${cap.id}`
            );
            if (!registration) continue;

            // Enrich with revenue snapshot
            try {
              const snap = await apiGet<RevenueSnapshot>(
                `/api/ip/${registration.ipId}/revenue`
              );
              enriched.push({
                ...registration,
                capabilityName: cap.name ?? cap.capabilityType ?? registration.capabilityId,
                capabilityType: cap.capabilityType ?? cap.type,
                totalRevenue: snap.totalRevenue,
                unclaimedRevenue: snap.unclaimedRevenue,
                derivativeCount: snap.derivativeCount ?? 0,
                status: "active",
              });
            } catch {
              enriched.push({
                ...registration,
                capabilityName: cap.name ?? cap.capabilityType ?? registration.capabilityId,
                capabilityType: cap.capabilityType ?? cap.type,
                status: "active",
              });
            }
          } catch {
            // IP not registered for this capability — skip
          }
        }

        if (!cancelled) {
          setAssets(enriched.length > 0 ? enriched : MOCK_IP_ASSETS);
        }
      } catch {
        if (!cancelled) setAssets(MOCK_IP_ASSETS);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  async function handleClaim(ipId: string) {
    setClaimingId(ipId);
    try {
      const result = await apiPost<{ claimed: string; txHash?: string }>(
        `/api/ip/${ipId}/claim`,
        {}
      );
      setClaimResult((prev) => ({ ...prev, [ipId]: result.claimed }));
      // Optimistically zero unclaimed
      setAssets((prev) =>
        prev.map((a) => (a.ipId === ipId ? { ...a, unclaimedRevenue: "0" } : a))
      );
    } catch (err) {
      setClaimResult((prev) => ({
        ...prev,
        [ipId]: `Error: ${err instanceof Error ? err.message : "claim failed"}`,
      }));
    } finally {
      setClaimingId(null);
    }
  }

  // KPI aggregates
  const totalAssets = assets.length;
  const totalRevenue = assets.reduce(
    (s, a) => s + parseFloat(a.totalRevenue ?? "0"),
    0
  );
  const totalUnclaimed = assets.reduce(
    (s, a) => s + parseFloat(a.unclaimedRevenue ?? "0"),
    0
  );
  const totalDerivatives = assets.reduce(
    (s, a) => s + (a.derivativeCount ?? 0),
    0
  );

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Total IP Assets" value={totalAssets} mono />
        </GlassPanel>
        <GlassPanel padding="md" glow={totalRevenue > 0 ? "green" : undefined}>
          <DataCell
            label="Total Revenue"
            value={
              <AmountDisplay amount={totalRevenue.toFixed(2)} currency="USDC" size="md" />
            }
          />
        </GlassPanel>
        <GlassPanel padding="md" glow={totalUnclaimed > 0 ? "gold" : undefined}>
          <DataCell
            label="Unclaimed Revenue"
            value={
              <AmountDisplay amount={totalUnclaimed.toFixed(2)} currency="USDC" size="md" />
            }
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Active Derivatives" value={totalDerivatives} mono />
        </GlassPanel>
      </div>

      {/* Revenue chart */}
      <GlassPanel padding="md">
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">
          Revenue Over Time (USDC)
        </h3>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={MOCK_REVENUE_HISTORY}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="month"
                tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }}
                axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
              />
              <YAxis
                tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }}
                axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
              />
              <Tooltip
                contentStyle={{
                  background: "rgba(0,0,0,0.85)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "6px",
                  color: "#fff",
                  fontSize: "12px",
                }}
              />
              <Line
                type="monotone"
                dataKey="revenue"
                stroke="#34d399"
                strokeWidth={2}
                dot={{ fill: "#34d399", r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </GlassPanel>

      {/* IP Asset list */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">
          Registered IP Assets
        </h3>

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((n) => (
              <GlassPanel key={n} padding="md">
                <Skeleton className="h-16" />
              </GlassPanel>
            ))}
          </div>
        ) : assets.length === 0 ? (
          <GlassPanel padding="lg">
            <EmptyState
              title="No IP Assets registered yet"
              description="Register a capability as a Story Protocol IP Asset to start earning royalties from derivative use. Go to a capability and click Register as IP."
            />
          </GlassPanel>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-white/40 border-b border-white/[0.06]">
                  <th className="text-left py-2.5 px-3 font-medium">Capability</th>
                  <th className="text-left py-2.5 px-3 font-medium">IP ID</th>
                  <th className="text-right py-2.5 px-3 font-medium">Total Revenue</th>
                  <th className="text-right py-2.5 px-3 font-medium">Unclaimed</th>
                  <th className="text-right py-2.5 px-3 font-medium">Derivatives</th>
                  <th className="text-center py-2.5 px-3 font-medium">Status</th>
                  <th className="text-right py-2.5 px-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => {
                  const unclaimed = parseFloat(asset.unclaimedRevenue ?? "0");
                  const isClaiming = claimingId === asset.ipId;
                  const claimMsg = claimResult[asset.ipId];

                  return (
                    <tr
                      key={asset.ipId}
                      className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="py-2.5 px-3">
                        <div className="font-medium text-white/80">
                          {asset.capabilityName ?? asset.capabilityId ?? "—"}
                        </div>
                        {asset.capabilityType && (
                          <div className="text-xs text-white/40 mt-0.5">
                            {asset.capabilityType}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <AddressDisplay address={asset.ipId} />
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-emerald-400/80">
                        {asset.totalRevenue
                          ? parseFloat(asset.totalRevenue).toFixed(2)
                          : "—"}{" "}
                        USDC
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono">
                        <span
                          className={
                            unclaimed > 0
                              ? "text-yellow-400/80"
                              : "text-white/30"
                          }
                        >
                          {asset.unclaimedRevenue
                            ? parseFloat(asset.unclaimedRevenue).toFixed(2)
                            : "—"}{" "}
                          USDC
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-white/60">
                        {asset.derivativeCount ?? 0}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <GlowBadge color={ipStatusColor(asset.status)}>
                          {asset.status ?? "active"}
                        </GlowBadge>
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {unclaimed > 0 && (
                            <button
                              onClick={() => handleClaim(asset.ipId)}
                              disabled={isClaiming}
                              className="px-2.5 py-1 text-xs rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-50 transition-colors border border-emerald-500/30"
                            >
                              {isClaiming ? "Claiming…" : "Claim"}
                            </button>
                          )}
                          <Link
                            to={`/ip/${asset.ipId}`}
                            className="px-2.5 py-1 text-xs rounded bg-white/[0.06] text-white/60 hover:bg-white/[0.10] hover:text-white/80 transition-colors border border-white/[0.08]"
                          >
                            View
                          </Link>
                        </div>
                        {claimMsg && (
                          <div className="text-xs text-white/40 mt-1 text-right">
                            {claimMsg}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
