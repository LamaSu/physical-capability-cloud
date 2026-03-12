import React from "react";
import { GlassPanel, DataCell, StatusChip } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store";
import { useSubnetStore } from "../stores/subnet-store";

// Mock data matching gateway /api/verification/* shapes
const MOCK_METRICS = {
  totalVerifications: 1_247,
  averageScore: 0.873,
  activeMinerCount: 8,
  lastEpochRewards: 42.5,
};

const MOCK_MINERS = [
  { uid: 0, hotkey: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", stake: 1200, trust: 0.95, incentive: 0.42 },
  { uid: 1, hotkey: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty", stake: 980, trust: 0.91, incentive: 0.35 },
  { uid: 2, hotkey: "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y", stake: 750, trust: 0.88, incentive: 0.28 },
  { uid: 3, hotkey: "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy", stake: 620, trust: 0.82, incentive: 0.21 },
  { uid: 4, hotkey: "5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw", stake: 510, trust: 0.79, incentive: 0.18 },
  { uid: 5, hotkey: "5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSneWj6VRmhk", stake: 390, trust: 0.74, incentive: 0.14 },
  { uid: 6, hotkey: "5GNJqTPyNqANBkUVMN1LPPrxXnFouWA2MRQg3gKrUYgw6Rh5", stake: 280, trust: 0.68, incentive: 0.09 },
  { uid: 7, hotkey: "5HpG9w8EBLe5XCrbczpwq5TSXvedjrBGCwqxK1iQ7qUsSWFc", stake: 150, trust: 0.55, incentive: 0.04 },
];

function truncateHotkey(hotkey: string): string {
  if (hotkey.length <= 12) return hotkey;
  return `${hotkey.slice(0, 6)}...${hotkey.slice(-4)}`;
}

export function SubnetStatusPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { available, metrics, miners, setStatus, setMiners } = useSubnetStore();

  React.useEffect(() => {
    setPageMeta("Bittensor Subnet", "Decentralized verification subnet status and miner leaderboard");
  }, [setPageMeta]);

  // Load mock data on mount
  React.useEffect(() => {
    setStatus(true, MOCK_METRICS);
    setMiners(MOCK_MINERS);
  }, [setStatus, setMiners]);

  return (
    <div className="space-y-6">
      {/* Subnet Status + KPIs */}
      <div className="grid grid-cols-5 gap-4">
        <GlassPanel padding="md" glow={available ? "green" : "none"}>
          <DataCell
            label="Subnet Status"
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
            label="Active Miners"
            value={metrics.activeMinerCount}
            mono
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Last Epoch Rewards"
            value={`${metrics.lastEpochRewards.toFixed(1)} TAO`}
            mono
          />
        </GlassPanel>
      </div>

      {/* Miner Leaderboard */}
      <GlassPanel padding="md">
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">
          Miner Leaderboard
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 border-b border-white/[0.06]">
                <th className="text-left py-2 px-3 font-medium">Rank</th>
                <th className="text-left py-2 px-3 font-medium">UID</th>
                <th className="text-left py-2 px-3 font-medium">Hotkey</th>
                <th className="text-right py-2 px-3 font-medium">Stake (TAO)</th>
                <th className="text-right py-2 px-3 font-medium">Trust</th>
                <th className="text-right py-2 px-3 font-medium">Incentive</th>
              </tr>
            </thead>
            <tbody>
              {[...miners]
                .sort((a, b) => b.incentive - a.incentive)
                .map((miner, idx) => (
                  <tr
                    key={miner.uid}
                    className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="py-2.5 px-3 text-white/60">#{idx + 1}</td>
                    <td className="py-2.5 px-3 font-mono text-emerald-400/80">
                      {miner.uid}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-white/50" title={miner.hotkey}>
                      {truncateHotkey(miner.hotkey)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-white/70">
                      {miner.stake.toLocaleString()}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-white/70">
                      {miner.trust.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <span
                        className={`font-mono font-medium ${
                          miner.incentive >= 0.3
                            ? "text-emerald-400"
                            : miner.incentive >= 0.15
                              ? "text-yellow-400"
                              : "text-white/50"
                        }`}
                      >
                        {miner.incentive.toFixed(3)}
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
