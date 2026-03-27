import React from "react";
import { GlassPanel, GlowBadge, DataCell, EmptyState } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { getAuthHeaders } from "../stores/auth-store.js";

const API = import.meta.env.VITE_PCC_URL ?? "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SharedBatch {
  id: string;
  kernelId: string;
  kernelName?: string;
  capabilityType: string;
  protocolType?: string;
  totalSlots: number;
  claimedSlots: number;
  pricePerSlot: number;
  status: string;
  claims?: Array<{ agentId: string; slotCount: number }>;
}

// ---------------------------------------------------------------------------
// Slot Grid — 96-well plate visualization (8 rows x 12 cols)
// ---------------------------------------------------------------------------

function SlotGrid({ totalSlots, claimedSlots }: { totalSlots: number; claimedSlots: number }) {
  const cols = Math.min(totalSlots, 12);
  const rows = Math.ceil(totalSlots / cols);
  const rowLabels = "ABCDEFGH".split("");

  return (
    <div className="space-y-1">
      {/* Column headers */}
      <div className="flex gap-1 ml-5">
        {Array.from({ length: cols }, (_, i) => (
          <div key={i} className="w-5 h-4 flex items-center justify-center text-[8px] text-white/20 font-mono">
            {i + 1}
          </div>
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-1 items-center">
          <div className="w-4 text-[8px] text-white/20 font-mono text-right">
            {rowLabels[r] ?? r + 1}
          </div>
          {Array.from({ length: cols }, (_, c) => {
            const idx = r * cols + c;
            if (idx >= totalSlots) return <div key={c} className="w-5 h-5" />;
            const claimed = idx < claimedSlots;
            return (
              <div
                key={c}
                className={`w-5 h-5 rounded-sm border transition-all ${
                  claimed
                    ? "bg-green-500/30 border-green-500/40"
                    : "bg-white/[0.04] border-white/[0.08]"
                }`}
                title={`${rowLabels[r] ?? r + 1}${c + 1}: ${claimed ? "claimed" : "available"}`}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Batch Form
// ---------------------------------------------------------------------------

interface CreateBatchFormProps {
  onSubmit: (data: {
    kernelId: string;
    capabilityType: string;
    totalSlots: number;
    protocolType: string;
    pricePerSlot: number;
  }) => void;
  onCancel: () => void;
  submitting: boolean;
}

function CreateBatchForm({ onSubmit, onCancel, submitting }: CreateBatchFormProps) {
  const [kernelId, setKernelId] = React.useState("");
  const [capabilityType, setCapabilityType] = React.useState("");
  const [totalSlots, setTotalSlots] = React.useState(96);
  const [protocolType, setProtocolType] = React.useState("");
  const [pricePerSlot, setPricePerSlot] = React.useState(1.0);

  const canSubmit = kernelId.trim() && capabilityType.trim() && totalSlots > 0 && pricePerSlot > 0;

  return (
    <GlassPanel padding="lg" className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/80">Create Shared Batch</h3>
        <button onClick={onCancel} className="text-white/30 hover:text-white/60 text-lg leading-none">
          x
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-[10px] text-white/30 uppercase tracking-wider block mb-1">Kernel ID</label>
          <input
            type="text"
            value={kernelId}
            onChange={(e) => setKernelId(e.target.value)}
            placeholder="kern-001"
            className="w-full bg-white/[0.04] border border-white/[0.10] rounded px-3 py-2 text-sm font-mono text-white/80 outline-none focus:border-green-500/30"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/30 uppercase tracking-wider block mb-1">Capability Type</label>
          <input
            type="text"
            value={capabilityType}
            onChange={(e) => setCapabilityType(e.target.value)}
            placeholder="hplc-analysis"
            className="w-full bg-white/[0.04] border border-white/[0.10] rounded px-3 py-2 text-sm font-mono text-white/80 outline-none focus:border-green-500/30"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/30 uppercase tracking-wider block mb-1">Total Slots</label>
          <input
            type="number"
            min={1}
            max={384}
            value={totalSlots}
            onChange={(e) => setTotalSlots(parseInt(e.target.value) || 96)}
            className="w-full bg-white/[0.04] border border-white/[0.10] rounded px-3 py-2 text-sm font-mono text-white/80 outline-none focus:border-green-500/30"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/30 uppercase tracking-wider block mb-1">Protocol Type</label>
          <input
            type="text"
            value={protocolType}
            onChange={(e) => setProtocolType(e.target.value)}
            placeholder="standard-96"
            className="w-full bg-white/[0.04] border border-white/[0.10] rounded px-3 py-2 text-sm font-mono text-white/80 outline-none focus:border-green-500/30"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/30 uppercase tracking-wider block mb-1">Price Per Slot (USD)</label>
          <div className="flex items-center gap-2">
            <span className="text-white/40 text-sm">$</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={pricePerSlot}
              onChange={(e) => setPricePerSlot(parseFloat(e.target.value) || 0)}
              className="flex-1 bg-white/[0.04] border border-white/[0.10] rounded px-3 py-2 text-sm font-mono text-white/80 outline-none focus:border-green-500/30"
            />
          </div>
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          onClick={onCancel}
          className="flex-1 py-2 rounded-lg border border-white/[0.08] text-xs text-white/40 hover:text-white/60 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => canSubmit && onSubmit({ kernelId, capabilityType, totalSlots, protocolType, pricePerSlot })}
          disabled={!canSubmit || submitting}
          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
            canSubmit && !submitting
              ? "bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30"
              : "bg-white/[0.02] border border-white/[0.06] text-white/20 cursor-not-allowed"
          }`}
        >
          {submitting ? "Creating..." : "Create Batch"}
        </button>
      </div>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function BatchBoardPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const [batches, setBatches] = React.useState<SharedBatch[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // Claim state per-batch
  const [claimExpanded, setClaimExpanded] = React.useState<string | null>(null);
  const [claimCount, setClaimCount] = React.useState(1);
  const [claiming, setClaiming] = React.useState(false);

  React.useEffect(() => {
    setPageMeta("Batch Board", "Share slots on batch runs with multiple users");
  }, [setPageMeta]);

  // Fetch open batches
  const fetchBatches = React.useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${API}/api/batches/shared/open`, {
      headers: { ...getAuthHeaders() },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setBatches(data.batches ?? data ?? []);
      })
      .catch((err) => {
        setError(err.message);
        setBatches([]);
      })
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    fetchBatches();
  }, [fetchBatches]);

  // Create batch
  function handleCreate(data: {
    kernelId: string;
    capabilityType: string;
    totalSlots: number;
    protocolType: string;
    pricePerSlot: number;
  }) {
    setSubmitting(true);
    fetch(`${API}/api/batches/shared`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify(data),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(() => {
        setShowCreate(false);
        fetchBatches();
      })
      .catch((err) => setError(err.message))
      .finally(() => setSubmitting(false));
  }

  // Claim slots
  function handleClaim(batchId: string) {
    setClaiming(true);
    fetch(`${API}/api/batches/shared/${batchId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ agentId: "demo-user", slotCount: claimCount }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(() => {
        setClaimExpanded(null);
        setClaimCount(1);
        fetchBatches();
      })
      .catch((err) => setError(err.message))
      .finally(() => setClaiming(false));
  }

  const statusColor = (status: string): "green" | "gold" | "red" | "gray" => {
    switch (status) {
      case "open": return "green";
      case "filling": return "gold";
      case "full": return "gray";
      case "running": return "green";
      case "closed": return "gray";
      default: return "gold";
    }
  };

  const totalSlots = batches.reduce((s, b) => s + b.totalSlots, 0);
  const totalClaimed = batches.reduce((s, b) => s + b.claimedSlots, 0);

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassPanel padding="md" glow="green">
          <DataCell label="Open Batches" value={batches.length} sub="accepting claims" mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Total Slots" value={totalSlots} sub="across all batches" mono />
        </GlassPanel>
        <GlassPanel padding="md" glow={totalClaimed > 0 ? "gold" : undefined}>
          <DataCell label="Claimed" value={totalClaimed} sub={`${totalSlots - totalClaimed} available`} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Fill Rate"
            value={totalSlots > 0 ? `${Math.round((totalClaimed / totalSlots) * 100)}%` : "0%"}
            sub="overall utilization"
            mono
          />
        </GlassPanel>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">Shared Batches</h3>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 rounded-lg text-xs font-medium bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30 transition-all"
        >
          {showCreate ? "Cancel" : "Create Batch"}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <CreateBatchForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          submitting={submitting}
        />
      )}

      {/* Error */}
      {error && (
        <GlassPanel padding="md">
          <div className="text-xs text-red-400">Error: {error}</div>
        </GlassPanel>
      )}

      {/* Loading */}
      {loading && (
        <GlassPanel padding="lg">
          <div className="text-center py-8 text-white/30 text-sm animate-pulse">Loading batches...</div>
        </GlassPanel>
      )}

      {/* Empty state */}
      {!loading && batches.length === 0 && !error && (
        <GlassPanel padding="lg">
          <EmptyState
            title="No open batches"
            description="No open batches. Create one to let multiple users share a run."
          />
        </GlassPanel>
      )}

      {/* Batch cards */}
      {!loading && batches.map((batch) => (
        <GlassPanel key={batch.id} padding="md" hover>
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-white/80 font-mono">{batch.id}</span>
                  <GlowBadge color={statusColor(batch.status)}>{batch.status}</GlowBadge>
                </div>
                <div className="text-xs text-white/40">
                  <span className="text-white/20">Kernel:</span>{" "}
                  <span className="font-mono">{batch.kernelName ?? batch.kernelId}</span>
                </div>
                <div className="flex gap-4 text-xs text-white/40">
                  <span>
                    <span className="text-white/20">Capability:</span>{" "}
                    <span className="font-mono">{batch.capabilityType}</span>
                  </span>
                  {batch.protocolType && (
                    <span>
                      <span className="text-white/20">Protocol:</span>{" "}
                      <span className="font-mono">{batch.protocolType}</span>
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-lg font-mono text-green-400">${batch.pricePerSlot.toFixed(2)}</div>
                <div className="text-[10px] text-white/25">per slot</div>
              </div>
            </div>

            {/* Slot grid */}
            <div className="flex items-start gap-6">
              <SlotGrid totalSlots={batch.totalSlots} claimedSlots={batch.claimedSlots} />
              <div className="flex-1 space-y-2">
                <div className="text-xs text-white/40">
                  <span className="font-mono text-white/60">{batch.claimedSlots}</span>
                  <span className="text-white/20"> / </span>
                  <span className="font-mono text-white/60">{batch.totalSlots}</span>
                  <span className="text-white/25"> slots claimed</span>
                </div>
                {/* Progress bar */}
                <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500/50 rounded-full transition-all"
                    style={{ width: `${Math.round((batch.claimedSlots / batch.totalSlots) * 100)}%` }}
                  />
                </div>
                <div className="text-[10px] text-white/20">
                  {Math.round((batch.claimedSlots / batch.totalSlots) * 100)}% filled
                </div>
              </div>
            </div>

            {/* Claim action */}
            {batch.status !== "full" && batch.status !== "closed" && (
              <div>
                {claimExpanded === batch.id ? (
                  <div className="flex items-center gap-3">
                    <label className="text-[10px] text-white/30 uppercase tracking-wider">Slots:</label>
                    <input
                      type="number"
                      min={1}
                      max={batch.totalSlots - batch.claimedSlots}
                      value={claimCount}
                      onChange={(e) => setClaimCount(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-20 bg-white/[0.04] border border-white/[0.10] rounded px-2 py-1 text-sm font-mono text-white/80 outline-none focus:border-green-500/30"
                    />
                    <span className="text-[10px] text-white/25">
                      = ${(claimCount * batch.pricePerSlot).toFixed(2)}
                    </span>
                    <button
                      onClick={() => handleClaim(batch.id)}
                      disabled={claiming}
                      className="px-4 py-1.5 rounded text-xs font-medium bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30 transition-all disabled:opacity-50"
                    >
                      {claiming ? "Claiming..." : "Claim"}
                    </button>
                    <button
                      onClick={() => { setClaimExpanded(null); setClaimCount(1); }}
                      className="px-3 py-1.5 rounded text-xs text-white/30 hover:text-white/50 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setClaimExpanded(batch.id); setClaimCount(1); }}
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-green-500/15 border border-green-500/25 text-green-400 hover:bg-green-500/25 transition-all"
                  >
                    Claim Slots
                  </button>
                )}
              </div>
            )}
          </div>
        </GlassPanel>
      ))}
    </div>
  );
}
