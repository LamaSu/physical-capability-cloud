import React from "react";
import { classifySettlementRead, statusPillText } from "@pcc/spec";
import { DataCell, EmptyState, GlassPanel, GlowBadge, LoadingShell } from "@pcc/ui";
import { useEscrows } from "../api/hooks/use-pcc-data.js";
import { EscrowAmount } from "../components/EscrowAmount.js";
import { StaleNotice, UnavailableState } from "../components/ReadState.js";
import { DisputeModal } from "../components/escrow/DisputeModal.js";
import { moneyToneColor } from "../lib/money-badge.js";
import { useUIStore } from "../stores/ui-store.js";

export function EscrowPage() {
  const setPageMeta = useUIStore((state) => state.setPageMeta);
  React.useEffect(() => { setPageMeta("Escrow"); }, [setPageMeta]);
  const query = useEscrows();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [dispute, setDispute] = React.useState<string | null>(null);
  const escrows = query.data;
  const milestoneTotal = escrows?.every((escrow) => typeof escrow.milestoneCount === "number")
    ? escrows.reduce((sum, escrow) => sum + escrow.milestoneCount, 0)
    : undefined;

  return (
    <div className="space-y-6">
      <p className="text-xs text-white/30">Every account's escrows, as the gateway records them.</p>
      {query.isLoading ? <LoadingShell rows={4} /> : !escrows ? (
        <GlassPanel padding="lg"><UnavailableState what="escrows" error={query.error} onRetry={() => void query.refetch()} /></GlassPanel>
      ) : (
        <>
          {query.isError && <StaleNotice what="escrows" updatedAt={query.dataUpdatedAt} onRetry={() => void query.refetch()} />}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <GlassPanel padding="md"><DataCell label="Escrows" value={escrows.length} sub="all states" mono /></GlassPanel>
            <GlassPanel padding="md"><DataCell label="Active Escrows" value={escrows.filter((escrow) => escrow.status === "active").length} sub={`of ${escrows.length} total`} mono /></GlassPanel>
            <GlassPanel padding="md"><DataCell label="Milestones" value={milestoneTotal ?? "—"} sub={milestoneTotal === undefined ? "unavailable" : "across all escrows"} mono /></GlassPanel>
          </div>
          {escrows.length === 0 ? (
            <GlassPanel padding="lg"><EmptyState title="No escrows yet" description="Escrows are created automatically when jobs are submitted with milestone-based payment. Each milestone has its own evidence requirements and release conditions." /></GlassPanel>
          ) : (
            <div className="space-y-3">
              {escrows.map((escrow) => {
                const classification = classifySettlementRead(escrow, { path: "/api/escrow", live: true });
                return (
                  <GlassPanel key={escrow.id} padding="md" hover glow={selected === escrow.id ? "gold" : undefined} onClick={() => setSelected(selected === escrow.id ? null : escrow.id)}>
                    <div className="flex items-center gap-4">
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="text-sm font-medium text-white/80">{escrow.id}</span>
                        <GlowBadge color={moneyToneColor(classification.tone)}>{classification.label ?? statusPillText(escrow.status, false, true)}</GlowBadge>
                      </div>
                      <EscrowAmount amount={escrow.totalAmount} currency={escrow.currency} size="md" />
                    </div>
                    {selected === escrow.id && (
                      <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-end">
                        <button type="button" onClick={(event) => { event.stopPropagation(); setDispute(escrow.id); }} className="px-2 py-1 rounded text-[10px] bg-red-500/10 border border-red-500/20 text-red-400/70 hover:bg-red-500/20 transition-all">File a dispute</button>
                      </div>
                    )}
                  </GlassPanel>
                );
              })}
            </div>
          )}
        </>
      )}
      {dispute && <DisputeModal escrowId={dispute} onClose={() => setDispute(null)} onFiled={() => void query.refetch()} />}
    </div>
  );
}
