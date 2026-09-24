import React from "react";
import {
  GlassPanel, AmountDisplay, TierBadge, GlowBadge, DataCell,
  EmptyState, LoadingShell,
} from "@pcc/ui";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";
import { useUIStore } from "../stores/ui-store.js";
import { useEscrows } from "../api/hooks/use-pcc-data.js";
import { DisputeModal } from "../components/escrow/DisputeModal.js";
import { moneyBadgeColor } from "../lib/money-badge.js";

interface DisputeContext {
  escrowId: string;
  milestoneStepId?: string;
}

export function EscrowPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [selectedEscrow, setSelectedEscrow] = React.useState<string | null>(null);
  const [dispute, setDispute] = React.useState<DisputeContext | null>(null);
  React.useEffect(() => { setPageMeta("Escrow", "Milestone escrow, bonds, and challenge windows"); }, [setPageMeta]);

  const escrowsQ = useEscrows();

  if (escrowsQ.isLoading) return <LoadingShell rows={4} />;
  const escrows = escrowsQ.data;
  if (!escrows) {
    return (
      <GlassPanel padding="lg">
        <UnavailableState what="escrows" error={escrowsQ.error} onRetry={() => void escrowsQ.refetch()} />
      </GlassPanel>
    );
  }

  // No money totals here: summing totalAmount across every state would count
  // refunded and released escrows as locked. Funds-held totals need the exact
  // money-state map (#313) or a server read model.
  const activeCount = escrows.filter((e) => e.status === "active").length;
  const milestoneTotal = escrows.every((e) => typeof e.milestoneCount === "number")
    ? escrows.reduce((s, e) => s + e.milestoneCount, 0)
    : undefined;

  return (
    <div className="space-y-6">
      {escrowsQ.isError && (
        <StaleNotice what="escrows" updatedAt={escrowsQ.dataUpdatedAt} onRetry={() => void escrowsQ.refetch()} />
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <GlassPanel padding="md"><DataCell label="Escrows" value={escrows.length} sub="all states" mono /></GlassPanel>
        <GlassPanel padding="md"><DataCell label="Active Escrows" value={activeCount} sub={`of ${escrows.length} total`} mono /></GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Milestones" value={milestoneTotal ?? "—"} sub={milestoneTotal === undefined ? "unavailable" : "across all escrows"} mono />
        </GlassPanel>
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
              glow={esc.id === selectedEscrow ? "gold" : undefined}
              onClick={() => setSelectedEscrow(esc.id === selectedEscrow ? null : esc.id)}
            >
              <div className="flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white/80">{esc.id}</span>
                    {/* money honesty: the ONE canonical @pcc/spec map. On this page green is reserved for settlement (a bare escrow status is never green); selection and totals use neutral accents. */}
                    <GlowBadge color={moneyBadgeColor(esc.status)}>
                      {esc.status}
                    </GlowBadge>
                  </div>
                </div>
                {esc.totalAmount != null ? <AmountDisplay amount={esc.totalAmount} size="md" /> : <span className="text-white/40">—</span>}
              </div>
              {selectedEscrow === esc.id && esc.milestones?.length > 0 && (
                <div className="mt-4 pt-3 border-t border-white/[0.06] space-y-2">
                  {esc.milestones.map((m: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-white/50">{m.name ?? `Milestone ${i + 1}`}</span>
                      <div className="flex items-center gap-2">
                        <GlowBadge color={moneyBadgeColor(m.status)}>
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
            // Re-read so the list shows the escrow's state after the dispute.
            void escrowsQ.refetch();
          }}
        />
      )}
    </div>
  );
}
