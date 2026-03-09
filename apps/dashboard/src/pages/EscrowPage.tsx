import React from "react";
import {
  GlassPanel, AmountDisplay, TierBadge, GlowBadge, DataCell,
  AddressDisplay, MilestoneTimeline, ChallengeWindowBar, BondDisplay,
} from "@pcc/ui";
import { DEFAULT_BOND_CONFIGS } from "@pcc/spec";
import type { AssuranceTier } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { mockEscrows, jobMeta } from "../api/mock-data.js";

export function EscrowPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [selectedEscrow, setSelectedEscrow] = React.useState<string | null>(null);

  React.useEffect(() => { setPageMeta("Escrow", "Milestone escrow, bonds, and challenge windows"); }, [setPageMeta]);

  const totalLocked = mockEscrows.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0);
  const activeCount = mockEscrows.filter((e) => e.status === "active").length;
  const challengeCount = mockEscrows.flatMap((e) => e.milestones).filter((m) => m.status === "releasing").length;

  const selected = mockEscrows.find((e) => e.id === selectedEscrow);

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4">
        <GlassPanel padding="md" glow="green">
          <DataCell label="Total Locked" value={<AmountDisplay amount={totalLocked.toFixed(2)} size="md" />} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Active Escrows" value={activeCount} sub={`of ${mockEscrows.length} total`} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Challenge Windows" value={challengeCount} sub="currently open" mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Total Milestones" value={mockEscrows.reduce((s, e) => s + e.milestones.length, 0)} mono />
        </GlassPanel>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Escrow list */}
        <div className="col-span-2 space-y-3">
          {mockEscrows.map((esc) => (
            <GlassPanel
              key={esc.id}
              hover
              padding="md"
              glow={esc.id === selectedEscrow ? "green" : "none"}
              onClick={() => setSelectedEscrow(esc.id === selectedEscrow ? null : esc.id)}
            >
              <div className="flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white/80">{esc.cwmId}</span>
                    <GlowBadge color={esc.status === "active" ? "gold" : esc.status === "funded" ? "gray" : "green"}>
                      {esc.status}
                    </GlowBadge>
                  </div>
                  <div className="text-xs text-white/30 font-mono mt-0.5">
                    {esc.id} · {esc.milestones.length} milestones
                  </div>
                </div>
                <AddressDisplay address={esc.contractAddress} chars={4} />
                <AmountDisplay amount={esc.totalAmount} size="md" />
              </div>

              {/* Inline milestone timeline */}
              <div className="mt-3 pt-3 border-t border-white/[0.06]">
                <MilestoneTimeline milestones={esc.milestones} />
              </div>

              {/* Challenge windows */}
              {esc.milestones
                .filter((m) => m.challengeWindowStart && m.challengeWindowEnd)
                .map((m) => (
                  <div key={m.stepId} className="mt-2">
                    <ChallengeWindowBar start={m.challengeWindowStart!} end={m.challengeWindowEnd!} />
                  </div>
                ))}
            </GlassPanel>
          ))}
        </div>

        {/* Bond configs sidebar */}
        <div className="space-y-4">
          <GlassPanel padding="md">
            <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Bond Configurations</h3>
            <div className="space-y-4">
              {DEFAULT_BOND_CONFIGS.map((config) => (
                <BondDisplay
                  key={config.tier}
                  config={config}
                  milestoneAmount={selected?.milestones[0]?.amount}
                />
              ))}
            </div>
          </GlassPanel>
        </div>
      </div>
    </div>
  );
}
