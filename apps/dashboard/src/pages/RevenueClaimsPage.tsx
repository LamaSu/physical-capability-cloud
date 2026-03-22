import React from "react";
import { Link } from "react-router-dom";
import {
  GlassPanel,
  DataCell,
  AmountDisplay,
  GlowBadge,
  EmptyState,
  Skeleton,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store";
import { apiGet } from "../lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RevenueClaim {
  id: string;
  ipId: string;
  claimerAddress: string;
  amount: string;
  txHash?: string;
  claimedAt: string;
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_CLAIMS: RevenueClaim[] = [
  {
    id: "claim-001",
    ipId: "0xf1A2b3C4d5e6F7a8B9c0D1e2F3a4b5C6d7E8f9A0",
    claimerAddress: "0x1111111111111111111111111111111111111111",
    amount: "340.00",
    txHash: "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1",
    claimedAt: "2026-03-10T09:15:00Z",
  },
  {
    id: "claim-002",
    ipId: "0xA1b2C3d4E5f6A7b8C9d0E1f2A3b4C5d6E7f8A9b0",
    claimerAddress: "0x2222222222222222222222222222222222222222",
    amount: "3870.00",
    txHash: "0xdef456abc123def456abc123def456abc123def456abc123def456abc123def4",
    claimedAt: "2026-03-08T16:40:00Z",
  },
  {
    id: "claim-003",
    ipId: "0xf1A2b3C4d5e6F7a8B9c0D1e2F3a4b5C6d7E8f9A0",
    claimerAddress: "0x1111111111111111111111111111111111111111",
    amount: "900.50",
    txHash: "0x789abc456def789abc456def789abc456def789abc456def789abc456def789a",
    claimedAt: "2026-02-28T11:00:00Z",
  },
  {
    id: "claim-004",
    ipId: "0xA1b2C3d4E5f6A7b8C9d0E1f2A3b4C5d6E7f8A9b0",
    claimerAddress: "0x2222222222222222222222222222222222222222",
    amount: "1240.00",
    claimedAt: "2026-02-20T08:30:00Z",
  },
];

// Known IP IDs to fetch claims for
const KNOWN_IP_IDS = [
  "0xf1A2b3C4d5e6F7a8B9c0D1e2F3a4b5C6d7E8f9A0",
  "0xA1b2C3d4E5f6A7b8C9d0E1f2A3b4C5d6E7f8A9b0",
  "0xB2c3D4e5F6b7C8d9E0f1B2c3D4e5F6b7C8d9E0f1",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, head = 8, tail = 6): string {
  if (!s || s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RevenueClaimsPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const [claims, setClaims] = React.useState<RevenueClaim[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [filterIpId, setFilterIpId] = React.useState<string>("all");

  React.useEffect(() => {
    setPageMeta("Revenue Claims", "History of all IP revenue claims");
  }, [setPageMeta]);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        // Attempt to fetch revenue data for each known IP to find historical claims
        const allClaims: RevenueClaim[] = [];

        // Try fetching revenue snapshots for known IPs
        // The /api/ip/:ipId/revenue endpoint returns a snapshot; claims come from DB
        // We look for a /api/ip/claims endpoint or fall back to mock
        for (const ipId of KNOWN_IP_IDS) {
          try {
            const snap = await apiGet<{ claims?: RevenueClaim[] }>(
              `/api/ip/${ipId}/revenue`
            );
            if (snap.claims && Array.isArray(snap.claims)) {
              allClaims.push(...snap.claims);
            }
          } catch {
            // IP not registered — skip
          }
        }

        if (!cancelled) {
          setClaims(allClaims.length > 0 ? allClaims : MOCK_CLAIMS);
        }
      } catch {
        if (!cancelled) setClaims(MOCK_CLAIMS);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  // Unique IP IDs for filter dropdown
  const uniqueIpIds = Array.from(new Set(claims.map((c) => c.ipId)));

  const filtered =
    filterIpId === "all"
      ? claims
      : claims.filter((c) => c.ipId === filterIpId);

  const totalClaimed = claims.reduce(
    (s, c) => s + parseFloat(c.amount ?? "0"),
    0
  );
  const filteredTotal = filtered.reduce(
    (s, c) => s + parseFloat(c.amount ?? "0"),
    0
  );

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <GlassPanel padding="md" glow={totalClaimed > 0 ? "green" : undefined}>
          <DataCell
            label="Total Claimed (All IPs)"
            value={
              <AmountDisplay amount={totalClaimed.toFixed(2)} currency="USDC" size="md" />
            }
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Total Claims" value={claims.length} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="IP Assets" value={uniqueIpIds.length} mono />
        </GlassPanel>
      </div>

      {/* Filter + Table */}
      <div>
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">
            Claims History
          </h3>
          <div className="flex items-center gap-2">
            {filterIpId !== "all" && (
              <span className="text-xs text-white/40 font-mono">
                {filteredTotal.toFixed(2)} USDC filtered
              </span>
            )}
            <select
              value={filterIpId}
              onChange={(e) => setFilterIpId(e.target.value)}
              className="text-xs bg-black/40 border border-white/[0.08] rounded px-2 py-1.5 text-white/60 focus:outline-none focus:border-white/20"
            >
              <option value="all">All IP Assets</option>
              {uniqueIpIds.map((id) => (
                <option key={id} value={id}>
                  {truncate(id)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4].map((n) => (
              <GlassPanel key={n} padding="md">
                <Skeleton className="h-8" />
              </GlassPanel>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <GlassPanel padding="lg">
            <EmptyState
              title="No claims yet"
              description="Revenue claims will appear here once operators claim earnings from their Story Protocol IP Assets."
            />
          </GlassPanel>
        ) : (
          <GlassPanel padding="none">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-white/40 border-b border-white/[0.06]">
                    <th className="text-left py-2.5 px-4 font-medium">Claim ID</th>
                    <th className="text-left py-2.5 px-4 font-medium">IP Asset</th>
                    <th className="text-right py-2.5 px-4 font-medium">Amount</th>
                    <th className="text-left py-2.5 px-4 font-medium">TX Hash</th>
                    <th className="text-left py-2.5 px-4 font-medium">Date</th>
                    <th className="text-center py-2.5 px-4 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((claim) => (
                    <tr
                      key={claim.id}
                      className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="py-2.5 px-4">
                        <span className="font-mono text-xs text-white/40">
                          {claim.id}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <Link
                          to={`/ip/${claim.ipId}`}
                          className="font-mono text-xs text-sky-400/70 hover:text-sky-400 transition-colors"
                        >
                          {truncate(claim.ipId)}
                        </Link>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-emerald-400/80 font-medium">
                        {parseFloat(claim.amount).toFixed(2)} USDC
                      </td>
                      <td className="py-2.5 px-4">
                        {claim.txHash ? (
                          <span className="font-mono text-xs text-white/30">
                            {truncate(claim.txHash)}
                          </span>
                        ) : (
                          <span className="text-xs text-white/20">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-xs text-white/50">
                        {new Date(claim.claimedAt).toLocaleDateString()}{" "}
                        <span className="text-white/30">
                          {new Date(claim.claimedAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <GlowBadge color={claim.txHash ? "green" : "gray"}>
                          {claim.txHash ? "confirmed" : "pending"}
                        </GlowBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassPanel>
        )}
      </div>

      {/* Footer link */}
      <div className="flex justify-end">
        <Link
          to="/ip"
          className="text-xs text-white/30 hover:text-white/60 transition-colors"
        >
          ← Back to IP Dashboard
        </Link>
      </div>
    </div>
  );
}
