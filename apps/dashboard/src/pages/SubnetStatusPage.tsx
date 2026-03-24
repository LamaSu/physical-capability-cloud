import React from "react";
import { GlassPanel, DataCell, StatusChip } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store";
import { useSubnetStore } from "../stores/subnet-store";

// Mock data reflecting oracle cascade system
const MOCK_METRICS = {
  totalVerifications: 1_247,
  averageScore: 0.873,
  activeOracles: 2,
  primaryOracle: "uma",
  fallbackOracles: ["chainlink", "eigenlayer"],
  recentResults: [
    { oracle: "uma", passed: true, score: 0.94, timestamp: new Date(Date.now() - 60_000).toISOString() },
    { oracle: "uma", passed: true, score: 0.88, timestamp: new Date(Date.now() - 180_000).toISOString() },
    { oracle: "chainlink", passed: true, score: 0.91, timestamp: new Date(Date.now() - 300_000).toISOString() },
    { oracle: "uma", passed: false, score: 0.41, timestamp: new Date(Date.now() - 600_000).toISOString() },
    { oracle: "uma", passed: true, score: 0.86, timestamp: new Date(Date.now() - 900_000).toISOString() },
  ],
  activeMinerCount: 2,
  lastEpochRewards: 0,
};

const MOCK_ORACLES = [
  { name: "uma", available: true, totalVerifications: 1100, averageScore: 0.872, isPrimary: true },
  { name: "chainlink", available: true, totalVerifications: 147, averageScore: 0.881, isPrimary: false },
  { name: "eigenlayer", available: false, totalVerifications: 0, averageScore: 0, isPrimary: false },
];

function oracleLabel(name: string): string {
  const labels: Record<string, string> = {
    uma: "UMA Optimistic Oracle",
    chainlink: "Chainlink Functions",
    eigenlayer: "EigenLayer AVS",
    none: "None",
  };
  return labels[name] ?? name;
}

function formatTimeAgo(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

export function SubnetStatusPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { available, metrics, oracles, setStatus, setOracles } = useSubnetStore();

  React.useEffect(() => {
    setPageMeta("Verification Oracles", "Three-tier oracle cascade: UMA Optimistic Oracle, Chainlink Functions, EigenLayer AVS");
  }, [setPageMeta]);

  // Load mock data on mount
  React.useEffect(() => {
    setStatus(true, MOCK_METRICS);
    setOracles(MOCK_ORACLES);
  }, [setStatus, setOracles]);

  return (
    <div className="space-y-6">
      {/* Oracle Status + KPIs */}
      <div className="grid grid-cols-4 gap-4">
        <GlassPanel padding="md" glow={available ? "green" : "none"}>
          <DataCell
            label="Oracle Cascade"
            value={
              <StatusChip
                status={available ? "online" : "offline"}
                label={available ? "Online" : "Offline"}
              />
            }
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Total Verifications"
            value={metrics.totalVerifications.toLocaleString()}
            mono
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Average Score"
            value={metrics.averageScore.toFixed(3)}
            mono
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Active Oracles"
            value={`${metrics.activeOracles} / 3`}
            mono
          />
        </GlassPanel>
      </div>

      {/* Oracle Status Cards */}
      <div className="grid grid-cols-3 gap-4">
        {(oracles.length > 0 ? oracles : MOCK_ORACLES).map((oracle) => (
          <GlassPanel
            key={oracle.name}
            padding="md"
            glow={oracle.available ? (oracle.isPrimary ? "green" : "none") : "none"}
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white/60 uppercase tracking-wider">
                  {oracle.isPrimary ? "Primary" : "Fallback"}
                </span>
                <StatusChip
                  status={oracle.available ? "online" : "offline"}
                  label={oracle.available ? "Active" : oracle.name === "eigenlayer" ? "Stub" : "Offline"}
                />
              </div>
              <div>
                <p className="text-sm font-medium text-white/90">{oracleLabel(oracle.name)}</p>
                <p className="text-xs text-white/40 font-mono mt-0.5">{oracle.name}</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-wide">Verifications</p>
                  <p className="text-sm font-mono text-white/70">{oracle.totalVerifications.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-wide">Avg Score</p>
                  <p className="text-sm font-mono text-white/70">
                    {oracle.totalVerifications > 0 ? oracle.averageScore.toFixed(3) : "—"}
                  </p>
                </div>
              </div>
              {oracle.name === "uma" && (
                <p className="text-[10px] text-white/30">2hr liveness · 500 USDC bond · Base Sepolia</p>
              )}
              {oracle.name === "chainlink" && (
                <p className="text-[10px] text-white/30">DON: fun-base-sepolia-1 · mock mode</p>
              )}
              {oracle.name === "eigenlayer" && (
                <p className="text-[10px] text-white/30">AVS not yet deployed · future integration</p>
              )}
            </div>
          </GlassPanel>
        ))}
      </div>

      {/* Recent Verification Results */}
      <GlassPanel padding="md">
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">
          Recent Verification Results
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 border-b border-white/[0.06]">
                <th className="text-left py-2 px-3 font-medium">Time</th>
                <th className="text-left py-2 px-3 font-medium">Oracle</th>
                <th className="text-left py-2 px-3 font-medium">Result</th>
                <th className="text-right py-2 px-3 font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {(metrics.recentResults ?? MOCK_METRICS.recentResults).map((result, idx) => (
                <tr
                  key={idx}
                  className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                >
                  <td className="py-2.5 px-3 font-mono text-white/40 text-xs">
                    {formatTimeAgo(result.timestamp)}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-emerald-400/80 text-xs">
                    {oracleLabel(result.oracle)}
                  </td>
                  <td className="py-2.5 px-3">
                    <StatusChip
                      status={result.passed ? "online" : "offline"}
                      label={result.passed ? "PASS" : "FAIL"}
                    />
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    <span
                      className={`font-mono font-medium text-sm ${
                        result.score >= 0.8
                          ? "text-emerald-400"
                          : result.score >= 0.6
                            ? "text-yellow-400"
                            : "text-red-400/70"
                      }`}
                    >
                      {result.score.toFixed(3)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassPanel>
    </div>
  );
}
