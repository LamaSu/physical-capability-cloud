import React from "react";
import {
  GlassPanel, AmountDisplay, TierBadge, GlowBadge, DataCell,
  EmptyState, LoadingShell,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useEscrows } from "../api/hooks/use-pcc-data.js";

export function EscrowPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [selectedEscrow, setSelectedEscrow] = React.useState<string | null>(null);
  React.useEffect(() => { setPageMeta("Escrow", "Milestone escrow, bonds, and challenge windows"); }, [setPageMeta]);

  const { data: escrows = [], isLoading } = useEscrows();

  if (isLoading) return <LoadingShell rows={4} />;

  const totalLocked = escrows.reduce((sum: number, e: any) => sum + parseFloat(e.totalAmount || "0"), 0);
  const activeCount = escrows.filter((e: any) => e.status === "active").length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassPanel padding="md" glow={totalLocked > 0 ? "green" : undefined}>
          <DataCell label="Total Locked" value={<AmountDisplay amount={totalLocked.toFixed(2)} size="md" />} />
        </GlassPanel>
        <GlassPanel padding="md"><DataCell label="Active Escrows" value={activeCount} sub={`of ${escrows.length} total`} mono /></GlassPanel>
        <GlassPanel padding="md"><DataCell label="Challenge Windows" value={0} sub="currently open" mono /></GlassPanel>
        <GlassPanel padding="md"><DataCell label="Total Milestones" value={escrows.reduce((s: number, e: any) => s + (e.milestones?.length ?? 0), 0)} mono /></GlassPanel>
      </div>

      {escrows.length === 0 ? (
        <GlassPanel padding="lg">
          <EmptyState
            title="No escrows yet"
            description="Escrows are created automatically when jobs are submitted with milestone-based payment. Each milestone has its own evidence requirements and release conditions."
          />
        </GlassPanel>
      ) : (
        <div className="space-y-3">
          {escrows.map((esc: any) => (
            <GlassPanel
              key={esc.id}
              hover
              padding="md"
              glow={esc.id === selectedEscrow ? "green" : undefined}
              onClick={() => setSelectedEscrow(esc.id === selectedEscrow ? null : esc.id)}
            >
              <div className="flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white/80">{esc.id}</span>
                    <GlowBadge color={esc.status === "active" ? "gold" : esc.status === "funded" ? "gray" : "green"}>
                      {esc.status}
                    </GlowBadge>
                  </div>
                </div>
                <AmountDisplay amount={esc.totalAmount ?? "0"} size="md" />
              </div>
              {selectedEscrow === esc.id && esc.milestones?.length > 0 && (
                <div className="mt-4 pt-3 border-t border-white/[0.06] space-y-2">
                  {esc.milestones.map((m: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-white/50">{m.name ?? `Milestone ${i + 1}`}</span>
                      <GlowBadge color={m.status === "fulfilled" ? "green" : m.status === "funded" ? "gold" : "gray"}>
                        {m.status}
                      </GlowBadge>
                    </div>
                  ))}
                </div>
              )}
            </GlassPanel>
          ))}
        </div>
      )}
    </div>
  );
}
