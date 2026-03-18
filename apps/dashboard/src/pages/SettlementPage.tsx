import React from "react";
import {
  GlassPanel,
  DataCell,
  GlowBadge,
  AddressDisplay,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store";

// ── Types ───────────────────────────────────────────────────────

interface QueueStatus {
  batchEnabled: boolean;
  pending: number;
  totalValue: string;
  oldestAge: number;
  autoFlush: boolean;
  smartAccountAddress: string | null;
}

interface BatchDetail {
  userOpHash: string;
  operationCount: number;
  trigger: string;
}

interface EpochSummary {
  epochId: number;
  batches: BatchDetail[];
  totalIntents: number;
  byAgent: Record<string, number>;
  byOperation: Record<string, number>;
  startedAt: number;
  completedAt: number;
}

// ── Mock Data ───────────────────────────────────────────────────

const MOCK_STATUS: QueueStatus = {
  batchEnabled: true,
  pending: 7,
  totalValue: "342000000",
  oldestAge: 45_000,
  autoFlush: true,
  smartAccountAddress: "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985",
};

const MOCK_EPOCHS: EpochSummary[] = [
  {
    epochId: 5,
    batches: [
      { userOpHash: "0xabc123...def456", operationCount: 12, trigger: "age" },
    ],
    totalIntents: 12,
    byAgent: { "user-agent": 3, "kernel-agent-1": 5, "kernel-agent-2": 4 },
    byOperation: { submitEvidence: 5, release: 4, depositBond: 3 },
    startedAt: Date.now() - 600_000,
    completedAt: Date.now() - 599_200,
  },
  {
    epochId: 4,
    batches: [
      { userOpHash: "0x789abc...123def", operationCount: 8, trigger: "value" },
    ],
    totalIntents: 8,
    byAgent: { "user-agent": 2, "broker-agent": 1, "kernel-agent-1": 5 },
    byOperation: { submitEvidence: 3, release: 3, fund: 2 },
    startedAt: Date.now() - 1_200_000,
    completedAt: Date.now() - 1_199_500,
  },
  {
    epochId: 3,
    batches: [
      { userOpHash: "0xdef789...abc123", operationCount: 23, trigger: "size" },
    ],
    totalIntents: 23,
    byAgent: { "kernel-agent-1": 10, "kernel-agent-2": 8, "user-agent": 5 },
    byOperation: { submitEvidence: 12, release: 8, depositBond: 3 },
    startedAt: Date.now() - 2_400_000,
    completedAt: Date.now() - 2_398_100,
  },
];

// ── Component ───────────────────────────────────────────────────

export function SettlementPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [status, setStatus] = React.useState<QueueStatus>(MOCK_STATUS);
  const [epochs, setEpochs] = React.useState<EpochSummary[]>(MOCK_EPOCHS);
  const [flushing, setFlushing] = React.useState(false);
  const [selectedEpoch, setSelectedEpoch] = React.useState<number | null>(null);

  React.useEffect(() => {
    setPageMeta("Settlement", "ERC-4337 Batch Settlement");
  }, [setPageMeta]);

  // Try to fetch live data, fall back to mock
  React.useEffect(() => {
    fetch("/api/settlement/status")
      .then((r) => r.json())
      .then((data) => {
        if (data.batchEnabled !== undefined) setStatus(data);
      })
      .catch(() => {}); // keep mock

    fetch("/api/settlement/epochs")
      .then((r) => r.json())
      .then((data) => {
        if (data.epochs?.length) setEpochs(data.epochs);
      })
      .catch(() => {});
  }, []);

  const handleFlush = async () => {
    setFlushing(true);
    try {
      await fetch("/api/settlement/flush", { method: "POST" });
      // Refresh status
      const r = await fetch("/api/settlement/status");
      const data = await r.json();
      if (data.batchEnabled !== undefined) setStatus(data);
    } catch {
      // Ignore
    } finally {
      setFlushing(false);
    }
  };

  const totalSettled = epochs.reduce((s, e) => s + e.totalIntents, 0);
  const totalBatches = epochs.reduce((s, e) => s + e.batches.length, 0);
  const avgOpsPerBatch = totalBatches > 0
    ? Math.round(totalSettled / totalBatches)
    : 0;

  const selected = selectedEpoch !== null
    ? epochs.find((e) => e.epochId === selectedEpoch)
    : null;

  return (
    <div className="space-y-6 p-6">
      {/* KPI Row */}
      <div className="grid grid-cols-5 gap-4">
        <GlassPanel>
          <DataCell
            label="Queue Depth"
            value={status.pending.toString()}
            sub={status.autoFlush ? "auto-flush on" : "manual only"}
          />
        </GlassPanel>
        <GlassPanel>
          <DataCell
            label="Queue Value"
            value={`$${(parseInt(status.totalValue) / 1_000_000).toFixed(2)}`}
            sub="USDC pending"
          />
        </GlassPanel>
        <GlassPanel>
          <DataCell
            label="Epochs Settled"
            value={epochs.length.toString()}
            sub={`${totalSettled} total ops`}
          />
        </GlassPanel>
        <GlassPanel>
          <DataCell
            label="Avg Ops/Batch"
            value={avgOpsPerBatch.toString()}
            sub={`${avgOpsPerBatch}x throughput`}
          />
        </GlassPanel>
        <GlassPanel>
          <DataCell
            label="Status"
            value={status.batchEnabled ? "Active" : "Disabled"}
            sub={status.batchEnabled ? "ERC-4337" : "Set PCC_BUNDLER_URL"}
          />
        </GlassPanel>
      </div>

      {/* Smart Account + Flush */}
      <div className="grid grid-cols-3 gap-4">
        <GlassPanel glow="green" className="col-span-2">
          <div className="space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-white/40">
              Smart Account
            </p>
            {status.smartAccountAddress ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <AddressDisplay address={status.smartAccountAddress} chars={10} />
                  <GlowBadge color="green">ERC-4337</GlowBadge>
                </div>
                <p className="text-xs text-white/50">
                  All agent settlements route through this smart account.
                  Operations are batched into single UserOperations for {avgOpsPerBatch}x throughput.
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
              onClick={handleFlush}
              disabled={flushing || status.pending === 0}
              className={`w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-all ${
                flushing || status.pending === 0
                  ? "bg-white/5 text-white/30 cursor-not-allowed"
                  : "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30"
              }`}
            >
              {flushing ? "Flushing..." : `Flush ${status.pending} ops`}
            </button>
            <p className="text-[10px] text-white/40">
              {status.autoFlush
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
            Epoch History
          </p>
          {epochs.map((epoch) => (
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
                    {epoch.totalIntents} ops in{" "}
                    {epoch.batches.length} batch{epoch.batches.length !== 1 ? "es" : ""}
                  </span>
                  <GlowBadge
                    color={
                      epoch.batches[0]?.trigger === "size"
                        ? "teal"
                        : epoch.batches[0]?.trigger === "value"
                          ? "gold"
                          : "gray"
                    }
                  >
                    {epoch.batches[0]?.trigger ?? "manual"}
                  </GlowBadge>
                </div>
                <div className="flex items-center gap-4 text-xs text-white/40">
                  <span>
                    {(epoch.completedAt - epoch.startedAt).toFixed(0)}ms
                  </span>
                  <span>
                    {new Date(epoch.startedAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            </GlassPanel>
          ))}
          {epochs.length === 0 && (
            <GlassPanel>
              <p className="text-sm text-white/40 text-center py-4">
                No epochs yet. Submit settlements and flush to see history.
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
                  By Agent
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
                  By Operation
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
                Click an epoch to see breakdown
              </p>
            </GlassPanel>
          )}
        </div>
      </div>
    </div>
  );
}
