import React from "react";
import {
  GlassPanel, AmountDisplay, TierBadge, GlowBadge, DataCell,
  EmptyState, LoadingShell,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useEscrows } from "../api/hooks/use-pcc-data.js";
import { DisputeModal } from "../components/escrow/DisputeModal.js";

interface DisputeContext {
  escrowId: string;
  milestoneStepId?: string;
}

export function EscrowPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [selectedEscrow, setSelectedEscrow] = React.useState<string | null>(null);
  const [dispute, setDispute] = React.useState<DisputeContext | null>(null);
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
                    {/* money honesty: exact map, gray DEFAULT -- refunded/disputed/created/unknown must NOT render green (was green-by-default). Matches MilestoneTimeline + read-route contract rule 1. */}
                    <GlowBadge color={esc.status === "completed" ? "green" : esc.status === "disputed" ? "red" : esc.status === "active" ? "gold" : "gray"}>
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
                      <div className="flex items-center gap-2">
                        <GlowBadge color={m.status === "fulfilled" ? "green" : m.status === "funded" ? "gold" : "gray"}>
                          {m.status}
                        </GlowBadge>
                        {/* T2.8 — file dispute (open per-milestone modal) */}
                        {m.status !== "disputed" && m.status !== "refunded" && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDispute({ escrowId: esc.id, milestoneStepId: m.stepId ?? m.step_id ?? m.id });
                            }}
                            className="px-2 py-0.5 rounded text-[10px] bg-red-500/10 border border-red-500/20 text-red-400/70 hover:bg-red-500/20 transition-all"
                          >
                            Dispute
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {selectedEscrow === esc.id && (!esc.milestones || esc.milestones.length === 0) && (
                <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-end">
                  {/* T2.8 — escrow-level dispute when there are no milestones */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDispute({ escrowId: esc.id });
                    }}
                    className="px-2 py-1 rounded text-[10px] bg-red-500/10 border border-red-500/20 text-red-400/70 hover:bg-red-500/20 transition-all"
                  >
                    File a dispute
                  </button>
                </div>
              )}
            </GlassPanel>
          ))}
        </div>
      )}

      {/* T2.8 — dispute modal */}
      {dispute && (
        <DisputeModal
          escrowId={dispute.escrowId}
          milestoneStepId={dispute.milestoneStepId}
          onClose={() => setDispute(null)}
          onFiled={() => {
            // Real refetch is wave-4 — for now the modal closes itself and
            // the user sees pre-refetch data until the next page tick.
          }}
        />
      )}
    </div>
  );
}
