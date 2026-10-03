import React from "react";
import {
  GlassPanel,
  DataCell,
  GlowBadge,
  AddressDisplay,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store";
import { getAuthHeaders } from "../stores/auth-store.js";
import {
  LOADING,
  UNREACHABLE,
  UNREACHABLE_REASON,
  averageOpsPerBatch,
  operationsInBatches,
  createFlushController,
  epochDetailNote,
  epochsFromResponse,
  flushConfirmation,
  flushOutcome,
  formatUsdcBaseUnits,
  statusFromResponse,
  triggerBadge,
  type EpochSummary,
  type QueueStatus,
  type Read,
} from "../lib/settlement-queue-view.js";

// Every number on this page is the gateway's (GET /api/settlement/status and /epochs). A read
// that fails shows "—" and the gateway's reason; an empty epoch history is shown as empty.

async function readJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

async function loadStatus(): Promise<Read<QueueStatus>> {
  try {
    const r = await fetch("/api/settlement/status", { headers: { ...getAuthHeaders() } });
    return statusFromResponse(r.status, await readJson(r));
  } catch {
    return UNREACHABLE;
  }
}

async function loadEpochs(): Promise<Read<EpochSummary[]>> {
  try {
    const r = await fetch("/api/settlement/epochs", { headers: { ...getAuthHeaders() } });
    return epochsFromResponse(r.status, await readJson(r));
  } catch {
    return UNREACHABLE;
  }
}

const DASH = "—";

export function SettlementPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [status, setStatus] = React.useState<Read<QueueStatus>>(LOADING);
  const [epochs, setEpochs] = React.useState<Read<EpochSummary[]>>(LOADING);
  const [flushing, setFlushing] = React.useState(false);
  const [confirmingFlush, setConfirmingFlush] = React.useState(false);
  const [flushResult, setFlushResult] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [selectedEpoch, setSelectedEpoch] = React.useState<number | null>(null);

  React.useEffect(() => {
    setPageMeta("Settlement", "ERC-4337 Batch Settlement");
  }, [setPageMeta]);

  const reload = React.useCallback(async () => {
    const [s, e] = await Promise.all([loadStatus(), loadEpochs()]);
    setStatus(s);
    setEpochs(e);
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  // Framework-free controller (M5): a synchronous in-flight guard, and `flushing` stays true
  // through the authoritative reload (not just the POST), so a second confirm mid-reload can
  // never fire another POST off a stale queue status. Built once — `reload` is itself stable.
  const [flushController] = React.useState(() =>
    createFlushController<{ ok: boolean; message: string }>({
      post: async () => {
        const r = await fetch("/api/settlement/flush", { method: "POST", headers: { ...getAuthHeaders() } });
        return flushOutcome(r.status, await readJson(r));
      },
      reload,
      onResult: (result) => setFlushResult(result),
      onError: () => setFlushResult({ ok: false, message: UNREACHABLE_REASON }),
      // The flush answered, but the queue and epochs could not be re-read: both reads say so.
      onReloadError: () => {
        setStatus(UNREACHABLE);
        setEpochs(UNREACHABLE);
      },
      onFlushingChange: (f) => {
        setFlushing(f);
        if (f) setFlushResult(null);
      },
    }),
  );

  const handleFlush = () => {
    void flushController.confirmFlush();
  };

  const q = status.state === "read" ? status.value : null;
  const list = epochs.state === "read" ? epochs.value : null;
  const statusNote = status.state === "unavailable" ? status.reason : status.state === "loading" ? "Loading…" : null;
  const epochsNote = epochs.state === "unavailable" ? epochs.reason : epochs.state === "loading" ? "Loading…" : null;

  // Operations the epochs' UserOperations carried; an epoch with no batch carried none (M3).
  const opsInBatches = list ? operationsInBatches(list) : null;
  const totalBatches = list ? list.reduce((s, e) => s + e.batches.length, 0) : null;
  const avgOpsPerBatch = list ? averageOpsPerBatch(list) : null;
  const queueValue = q ? formatUsdcBaseUnits(q.totalValue) : null;
  const canFlush = !flushing && q !== null && q.batchEnabled && q.pending > 0;

  const selected = list && selectedEpoch !== null ? list.find((e) => e.epochId === selectedEpoch) ?? null : null;

  return (
    <div className="space-y-6 p-6">
      {/* KPI Row */}
      <div className="grid grid-cols-5 gap-4">
        <GlassPanel>
          <DataCell
            label="Queue Depth"
            value={q ? q.pending.toString() : DASH}
            sub={q ? (q.autoFlush ? "auto-flush on" : "manual only") : statusNote ?? ""}
          />
        </GlassPanel>
        <GlassPanel>
          <DataCell
            label="Queue Value"
            value={queueValue !== null ? `${queueValue} USDC` : DASH}
            sub={q ? "recorded on queued operations" : statusNote ?? ""}
          />
        </GlassPanel>
        <GlassPanel>
          <DataCell
            label="Epochs Flushed"
            value={list ? list.length.toString() : DASH}
            sub={list ? `${opsInBatches} ops carried by UserOperations; since the gateway's last restart` : epochsNote ?? ""}
          />
        </GlassPanel>
        <GlassPanel>
          <DataCell
            label="Avg Ops/Batch"
            value={avgOpsPerBatch !== null ? avgOpsPerBatch.toString() : DASH}
            sub={avgOpsPerBatch !== null ? "operations per UserOperation" : list ? "no batches yet" : epochsNote ?? ""}
          />
        </GlassPanel>
        <GlassPanel>
          <DataCell
            label="Status"
            value={q ? (q.batchEnabled ? "Active" : "Disabled") : DASH}
            sub={q ? (q.batchEnabled ? "ERC-4337" : "Set PCC_BUNDLER_URL") : statusNote ?? ""}
          />
        </GlassPanel>
      </div>

      {/* Smart Account + Flush */}
      <div className="grid grid-cols-3 gap-4">
        <GlassPanel glow={q?.smartAccountAddress ? "green" : "none"} className="col-span-2">
          <div className="space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-white/40">
              Smart Account
            </p>
            {!q ? (
              <p className="text-sm text-white/50">{statusNote}</p>
            ) : q.smartAccountAddress ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <AddressDisplay address={q.smartAccountAddress} chars={10} />
                  <GlowBadge color="green">ERC-4337</GlowBadge>
                </div>
                <p className="text-xs text-white/50">
                  Agent settlements route through this smart account, batched into UserOperations
                  {avgOpsPerBatch !== null ? ` (${avgOpsPerBatch} operations per batch on average in the epochs below)` : ""}.
                </p>
              </div>
            ) : (
              <p className="text-sm text-white/50">
                No smart account configured. Set PCC_BUNDLER_URL and PCC_GATEWAY_PRIVATE_KEY to enable.
              </p>
            )}
          </div>
        </GlassPanel>

        <GlassPanel>
          <div className="space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-white/40">
              Manual Flush
            </p>
            <button
              onClick={() => setConfirmingFlush(true)}
              disabled={!canFlush || confirmingFlush}
              className={`w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-all ${
                !canFlush
                  ? "bg-white/5 text-white/30 cursor-not-allowed"
                  : "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30"
              }`}
            >
              {flushing ? "Flushing..." : q ? `Flush ${q.pending} ops` : "Flush"}
            </button>
            {confirmingFlush && q && (
              <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="text-xs text-amber-200/90">{flushConfirmation(q)}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setConfirmingFlush(false);
                      void handleFlush();
                    }}
                    disabled={!canFlush}
                    className="flex-1 rounded-lg border border-amber-500/40 bg-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/30"
                  >
                    Confirm flush
                  </button>
                  <button
                    onClick={() => setConfirmingFlush(false)}
                    className="flex-1 rounded-lg bg-white/5 px-3 py-1.5 text-xs text-white/60 hover:bg-white/10"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {flushResult && (
              <p className={`text-xs ${flushResult.ok ? "text-emerald-400/80" : "text-red-400/80"}`}>{flushResult.message}</p>
            )}
            <p className="text-[10px] text-white/40">
              {!q
                ? statusNote
                : q.autoFlush
                  ? "Auto-flush triggers on size, value, or age thresholds"
                  : "Auto-flush disabled — manual only"}
            </p>
          </div>
        </GlassPanel>
      </div>

      {/* Epoch History */}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-3">
          <p className="text-[10px] uppercase tracking-wider text-white/40">
            Epoch History (kept in the gateway's memory: since its last restart, at most the last 100)
          </p>
          {list === null && (
            <GlassPanel>
              <p className="text-sm text-white/40 text-center py-4">{epochsNote}</p>
            </GlassPanel>
          )}
          {list?.map((epoch) => {
            const badge = triggerBadge(epoch);
            return (
              <GlassPanel
                key={epoch.epochId}
                hover
                glow={selectedEpoch === epoch.epochId ? "green" : "none"}
                onClick={() =>
                  setSelectedEpoch(
                    selectedEpoch === epoch.epochId ? null : epoch.epochId,
                  )
                }
                className="cursor-pointer"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono text-emerald-400">
                      #{epoch.epochId}
                    </span>
                    <span className="text-sm text-white/80">
                      {epoch.batches.length === 0
                        ? `${epoch.totalIntents} intents; no UserOperation carried them`
                        : `${operationsInBatches([epoch])} ops in ${epoch.batches.length} batch${epoch.batches.length !== 1 ? "es" : ""}`}
                    </span>
                    <GlowBadge color={badge.color}>{badge.label}</GlowBadge>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-white/40">
                    <span>
                      {epoch.durationMs === null ? "duration unknown: the gateway's clock moved back" : `${epoch.durationMs}ms`}
                    </span>
                    <span>
                      {new Date(epoch.startedAt).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              </GlassPanel>
            );
          })}
          {list !== null && list.length === 0 && (
            <GlassPanel>
              <p className="text-sm text-white/40 text-center py-4">
                No epoch has been flushed since the gateway last started.
              </p>
            </GlassPanel>
          )}
        </div>

        {/* Selected Epoch Detail */}
        <div className="space-y-3">
          <p className="text-[10px] uppercase tracking-wider text-white/40">
            {selected ? `Epoch #${selected.epochId} Detail` : "Select an Epoch"}
          </p>
          {selected ? (
            <>
              <GlassPanel>
                <p className="text-[10px] uppercase tracking-wider text-white/40 mb-2">
                  Intents by Agent
                </p>
                <div className="space-y-1.5">
                  {Object.entries(selected.byAgent).map(([agent, count]) => (
                    <div
                      key={agent}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-white/60 font-mono text-xs truncate max-w-[140px]">
                        {agent}
                      </span>
                      <span className="text-white/80">{count}</span>
                    </div>
                  ))}
                </div>
              </GlassPanel>
              <GlassPanel>
                <p className="text-[10px] uppercase tracking-wider text-white/40 mb-2">
                  Intents by Operation
                </p>
                <div className="space-y-1.5">
                  {Object.entries(selected.byOperation).map(([op, count]) => (
                    <div
                      key={op}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-white/60">{op}</span>
                      <span className="text-white/80">{count}</span>
                    </div>
                  ))}
                </div>
              </GlassPanel>
              <GlassPanel>
                <p className="text-[10px] uppercase tracking-wider text-white/40 mb-2">
                  Batches
                </p>
                {selected.batches.map((b, i) => (
                  <div key={i} className="text-xs space-y-1">
                    <div className="font-mono text-emerald-400/80 truncate">
                      {b.userOpHash}
                    </div>
                    <div className="text-white/40">
                      {b.operationCount} ops, trigger: {b.trigger}
                    </div>
                  </div>
                ))}
              </GlassPanel>
            </>
          ) : (
            <GlassPanel>
              <p className="text-sm text-white/30 text-center py-8">
                {epochDetailNote(epochs)}
              </p>
            </GlassPanel>
          )}
        </div>
      </div>
    </div>
  );
}
