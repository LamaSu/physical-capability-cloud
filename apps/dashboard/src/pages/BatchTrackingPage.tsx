import React from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import type { BatchManifest, SampleSlot } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useBatchTrackerStore } from "../stores/batch-tracker-store.js";
import { getAuthHeaders } from "../stores/auth-store.js";

const GATEWAY = "/api";

const STATUS_COLORS: Record<SampleSlot["status"], string> = {
  pending: "bg-white/10",
  queued: "bg-blue-500/20 border-blue-500/30",
  injecting: "bg-cyan-500/20 border-cyan-500/30",
  acquiring: "bg-blue-500/30 border-blue-500/40 animate-pulse",
  processing: "bg-amber-500/20 border-amber-500/30",
  completed: "bg-green-500/20 border-green-500/30",
  failed: "bg-red-500/20 border-red-500/30",
};

const STATUS_BADGE_COLORS: Record<BatchManifest["status"], "green" | "gold" | "red" | "gray"> = {
  assembling: "gold",
  sealed: "gold",
  running: "green",
  completed: "green",
  failed: "red",
  partial: "gold",
};

export function BatchTrackingPage() {
  const { batchId } = useParams<{ batchId?: string }>();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { batches, selectedBatchId, slotFilter, setBatches, selectBatch, setFilter } = useBatchTrackerStore();

  React.useEffect(() => {
    setPageMeta("Batch Tracking", batchId ? `Batch: ${batchId}` : "Monitor batch instrument runs");
  }, [setPageMeta, batchId]);

  // Fetch batches
  const { data: batchData } = useQuery({
    queryKey: ["batches"],
    queryFn: () => fetch(`${GATEWAY}/batches`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
  });

  React.useEffect(() => {
    if (batchData?.batches) {
      setBatches(batchData.batches);
      if (batchId) selectBatch(batchId);
    }
  }, [batchData, batchId]);

  const selectedBatch = batches.find((b) => b.id === (batchId ?? selectedBatchId));

  const filteredSlots = selectedBatch?.slots.filter(
    (s) => slotFilter === "all" || s.status === slotFilter,
  ) ?? [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-6">
        {/* Batch list */}
        <div className="col-span-1">
          <GlassPanel padding="md">
            <h3 className="text-sm font-medium text-white/60 mb-3">Batches</h3>
            <div className="space-y-2">
              {batches.map((batch) => (
                <button
                  key={batch.id}
                  onClick={() => selectBatch(batch.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-xs border transition-all ${
                    (batchId ?? selectedBatchId) === batch.id
                      ? "bg-green-500/15 border-green-500/30"
                      : "bg-white/[0.03] border-white/[0.06] hover:border-white/[0.12]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-white/70">{batch.id}</span>
                    <GlowBadge color={STATUS_BADGE_COLORS[batch.status]}>{batch.status}</GlowBadge>
                  </div>
                  <div className="text-[10px] text-white/30 mt-1">
                    {batch.slots.length} slots · {batch.methodId ?? "unknown method"}
                  </div>
                </button>
              ))}
              {batches.length === 0 && (
                <div className="text-center py-8 text-white/30 text-xs">No batches found</div>
              )}
            </div>
          </GlassPanel>
        </div>

        {/* Batch detail */}
        <div className="col-span-2 space-y-4">
          {selectedBatch ? (
            <>
              {/* Batch info */}
              <GlassPanel padding="md">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-white/60">
                    {selectedBatch.id}
                  </h3>
                  <GlowBadge color={STATUS_BADGE_COLORS[selectedBatch.status]}>
                    {selectedBatch.status}
                  </GlowBadge>
                </div>
                <div className="grid grid-cols-3 gap-4 text-xs text-white/40">
                  <div>
                    <span className="text-white/20">Kernel:</span>{" "}
                    <span className="text-white/60">{selectedBatch.kernelId}</span>
                  </div>
                  <div>
                    <span className="text-white/20">Device:</span>{" "}
                    <span className="text-white/60">{selectedBatch.deviceId}</span>
                  </div>
                  <div>
                    <span className="text-white/20">Method:</span>{" "}
                    <span className="text-white/60">{selectedBatch.methodId ?? "—"}</span>
                  </div>
                </div>
              </GlassPanel>

              {/* Slot filters */}
              <div className="flex gap-2">
                {(["all", "pending", "queued", "acquiring", "completed", "failed"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-3 py-1 rounded-lg text-xs border transition-all ${
                      slotFilter === f
                        ? "bg-green-500/15 border-green-500/30 text-green-400"
                        : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>

              {/* Slot grid (autosampler tray layout) */}
              <GlassPanel padding="md">
                <h3 className="text-sm font-medium text-white/60 mb-3">
                  Slot Grid ({filteredSlots.length} slots)
                </h3>
                <div className="grid grid-cols-6 gap-2">
                  {filteredSlots.map((slot) => (
                    <div
                      key={slot.id}
                      className={`p-3 rounded-lg border text-xs transition-all ${STATUS_COLORS[slot.status]}`}
                    >
                      <div className="font-mono text-white/70 font-medium">{slot.position}</div>
                      <div className="text-white/40 mt-1 truncate">{slot.sampleLabel}</div>
                      <div className="text-[10px] text-white/25 mt-0.5">{slot.status}</div>
                      {slot.resultHash && (
                        <div className="text-[10px] text-green-400/60 mt-1 truncate font-mono">
                          {slot.resultHash.slice(0, 16)}...
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </GlassPanel>
            </>
          ) : (
            <GlassPanel padding="lg">
              <div className="text-center py-16 text-white/30 text-sm">
                Select a batch to view details
              </div>
            </GlassPanel>
          )}
        </div>
      </div>
    </div>
  );
}
