import React, { useMemo, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { GlassPanel, GlowBadge, DataCell } from "@pcc/ui";
import type {
  ProtocolRun,
  ProtocolTemplate,
  ProtocolRunStep,
  ProtocolRunTransfer,
  ProtocolRunStepStatus,
  ProtocolRunTransferStatus,
  AutomationLevel,
} from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useProtocolLibraryStore } from "../stores/protocol-library-store.js";
import { getAuthHeaders } from "../stores/auth-store.js";

const GATEWAY = "/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STEP_STATUS_COLOR: Record<string, "green" | "gold" | "gray" | "red"> = {
  completed: "green",
  running: "gold",
  queued: "gold",
  waiting_transfer: "gold",
  pending: "gray",
  failed: "red",
  skipped: "gray",
};

const STEP_STATUS_BORDER: Record<string, string> = {
  completed: "border-green-500/60",
  running: "border-amber-400/60",
  queued: "border-amber-400/30",
  waiting_transfer: "border-amber-400/30",
  pending: "border-white/10",
  failed: "border-red-500/60",
  skipped: "border-white/10",
};

const STEP_STATUS_BG: Record<string, string> = {
  completed: "bg-green-500/5",
  running: "bg-amber-400/5",
  queued: "bg-white/[0.02]",
  waiting_transfer: "bg-white/[0.02]",
  pending: "bg-white/[0.02]",
  failed: "bg-red-500/5",
  skipped: "bg-white/[0.01]",
};

const TRANSFER_STATUS_COLOR: Record<string, "green" | "gold" | "gray" | "red"> = {
  completed: "green",
  in_progress: "gold",
  pending: "gray",
  failed: "red",
};

const RUN_STATUS_COLOR: Record<string, "green" | "gold" | "gray" | "red"> = {
  completed: "green",
  running: "gold",
  ready: "gold",
  binding: "gray",
  paused: "gold",
  failed: "red",
  cancelled: "red",
};

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// Custom Run Step Node
// ---------------------------------------------------------------------------

interface RunStepNodeData {
  label: string;
  action: string;
  status: ProtocolRunStepStatus;
  actualDurationMs?: number;
  evidenceHash?: string;
  [key: string]: unknown;
}

function RunStepNode({ data }: { data: RunStepNodeData }) {
  const status = data.status as string;
  return (
    <div
      className={`rounded-xl border-2 px-4 py-3 min-w-[200px] backdrop-blur-xl transition-all ${
        STEP_STATUS_BORDER[status] ?? "border-white/10"
      } ${STEP_STATUS_BG[status] ?? "bg-white/[0.02]"} ${
        status === "running" ? "animate-pulse" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-green-500/50 !border-green-400/30 !w-3 !h-3" />
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-white/80">{data.label}</span>
        <GlowBadge color={STEP_STATUS_COLOR[status] ?? "gray"}>{status}</GlowBadge>
      </div>
      <div className="text-[10px] text-white/30 font-mono">{data.action}</div>
      {data.actualDurationMs != null && (
        <div className="text-[10px] text-white/25 mt-1">{formatDuration(data.actualDurationMs)}</div>
      )}
      {data.evidenceHash && (
        <div className="text-[9px] text-cyan-400/40 mt-1 truncate" title={data.evidenceHash}>
          Evidence: {data.evidenceHash.slice(0, 12)}...
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-amber-400/50 !border-amber-300/30 !w-3 !h-3" />
    </div>
  );
}

const nodeTypes: NodeTypes = { runStep: RunStepNode };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProtocolRunPage() {
  const { runId } = useParams<{ runId: string }>();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { setRuns } = useProtocolLibraryStore();
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedTransferId, setSelectedTransferId] = useState<string | null>(null);

  React.useEffect(() => {
    setPageMeta("Protocol Run", runId ?? "Active runs");
  }, [setPageMeta, runId]);

  // Fetch run
  const { data: runData } = useQuery({
    queryKey: ["protocol-run", runId],
    queryFn: () => fetch(`${GATEWAY}/protocol-runs/${runId}`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
    enabled: !!runId,
    refetchInterval: 5000, // Poll for live updates
  });

  // Fetch all runs (for list view when no runId)
  const { data: allRunsData } = useQuery({
    queryKey: ["protocol-runs-all"],
    queryFn: () => fetch(`${GATEWAY}/protocol-runs`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
    enabled: !runId,
  });

  // Fetch template for context
  const run: ProtocolRun | null = runData?.run ?? null;
  const allRuns: ProtocolRun[] = allRunsData?.runs ?? [];

  const { data: templateData } = useQuery({
    queryKey: ["protocol-template", run?.templateId],
    queryFn: () => fetch(`${GATEWAY}/protocols/${run?.templateId}`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
    enabled: !!run?.templateId,
  });

  const template: ProtocolTemplate | null = templateData?.template ?? null;

  React.useEffect(() => {
    if (allRuns.length) setRuns(allRuns);
  }, [allRunsData]);

  // Build step label lookup from template
  const stepLabelMap = useMemo(() => {
    const map: Record<string, { label: string; capabilityType: string; position?: { x: number; y: number } }> = {};
    if (template) {
      for (const step of template.steps) {
        map[step.id] = { label: step.label, capabilityType: step.capabilityType, position: step.position };
      }
    }
    return map;
  }, [template]);

  // Build React Flow nodes from run steps
  const flowNodes: Node[] = useMemo(() => {
    if (!run) return [];
    return run.steps.map((step, i) => {
      const templateStep = stepLabelMap[step.protocolStepId];
      return {
        id: step.id,
        type: "runStep",
        position: templateStep?.position ?? { x: 250 + (i % 3) * 280, y: 100 + Math.floor(i / 3) * 200 },
        data: {
          label: templateStep?.label ?? step.action,
          action: step.action,
          status: step.status,
          actualDurationMs: step.actualDurationMs,
          evidenceHash: step.evidenceHash,
        } satisfies RunStepNodeData,
        draggable: false,
      };
    });
  }, [run, stepLabelMap]);

  // Build edges from run transfers
  const flowEdges: Edge[] = useMemo(() => {
    if (!run) return [];
    // Map run steps by protocolStepId to run step id
    const protoToRunStep: Record<string, string> = {};
    for (const step of run.steps) {
      protoToRunStep[step.protocolStepId] = step.id;
    }

    return run.transfers.map((t) => {
      const isActive = t.status === "in_progress";
      const isDone = t.status === "completed";
      return {
        id: t.id,
        source: protoToRunStep[t.fromNodeId] ?? t.fromNodeId,
        target: protoToRunStep[t.toNodeId] ?? t.toNodeId,
        animated: isActive,
        label: `${t.automationLevel}${t.episodeRecorded ? " [ep]" : ""}`,
        labelStyle: {
          fill: isActive ? "rgba(251, 191, 36, 0.6)" : isDone ? "rgba(74, 222, 128, 0.5)" : "rgba(255,255,255,0.2)",
          fontSize: 10,
        },
        style: {
          stroke: isActive
            ? "rgba(251, 191, 36, 0.5)"
            : isDone
            ? "rgba(74, 222, 128, 0.4)"
            : t.status === "failed"
            ? "rgba(239, 68, 68, 0.4)"
            : "rgba(255, 255, 255, 0.1)",
          strokeWidth: isActive ? 3 : 2,
        },
      };
    });
  }, [run]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedStepId(node.id);
    setSelectedTransferId(null);
  }, []);

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedTransferId(edge.id);
    setSelectedStepId(null);
  }, []);

  const selectedRunStep = run?.steps.find((s) => s.id === selectedStepId);
  const selectedRunTransfer = run?.transfers.find((t) => t.id === selectedTransferId);

  const handleAction = async (action: "pause" | "resume" | "cancel") => {
    if (!run) return;
    await fetch(`${GATEWAY}/protocol-runs/${run.id}/${action}`, { method: "POST", headers: { ...getAuthHeaders() } });
  };

  // ---------------------------------------------------------------------------
  // List view (no runId)
  // ---------------------------------------------------------------------------

  if (!runId) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-3 gap-4">
          <GlassPanel padding="md">
            <DataCell label="Total Runs" value={String(allRuns.length)} />
          </GlassPanel>
          <GlassPanel padding="md">
            <DataCell label="Running" value={String(allRuns.filter((r) => r.status === "running").length)} />
          </GlassPanel>
          <GlassPanel padding="md">
            <DataCell label="Completed" value={String(allRuns.filter((r) => r.status === "completed").length)} />
          </GlassPanel>
        </div>

        <GlassPanel padding="md">
          <h3 className="text-sm font-medium text-white/60 mb-3">Protocol Runs</h3>
          <div className="space-y-2">
            {allRuns.map((r) => {
              const done = r.steps.filter((s) => s.status === "completed").length;
              const total = r.steps.length;
              return (
                <Link
                  key={r.id}
                  to={`/protocol-runs/${r.id}`}
                  className="block px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs hover:border-white/[0.12] transition-all"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-white/70">{r.id}</span>
                    <GlowBadge color={RUN_STATUS_COLOR[r.status] ?? "gray"}>{r.status}</GlowBadge>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mt-2 text-white/40">
                    <div>
                      <span className="text-white/20">Template:</span>{" "}
                      <span className="text-white/60">{r.templateId}</span>
                    </div>
                    <div>
                      <span className="text-white/20">Kernel:</span>{" "}
                      <span className="text-white/60">{r.kernelId}</span>
                    </div>
                    <div>
                      <span className="text-white/20">Progress:</span>{" "}
                      <span className="text-white/60">{done}/{total}</span>
                    </div>
                    <div>
                      <span className="text-white/20">Samples:</span>{" "}
                      <span className="text-white/60">{r.sampleIds.length}</span>
                    </div>
                  </div>
                  {total > 0 && (
                    <div className="mt-2 flex gap-1">
                      {r.steps.map((step) => (
                        <div
                          key={step.id}
                          className="flex-1 h-1.5 rounded-full overflow-hidden"
                        >
                          <div
                            className={`h-full rounded-full ${
                              step.status === "completed"
                                ? "bg-green-400"
                                : step.status === "running"
                                ? "bg-amber-400 animate-pulse"
                                : step.status === "failed"
                                ? "bg-red-400"
                                : "bg-white/10"
                            }`}
                            style={{ width: step.status === "pending" || step.status === "queued" ? "0%" : "100%" }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </Link>
              );
            })}
            {allRuns.length === 0 && (
              <div className="text-center py-8 text-white/30 text-xs">No protocol runs</div>
            )}
          </div>
        </GlassPanel>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Detail view (with runId)
  // ---------------------------------------------------------------------------

  if (!run) {
    return (
      <div className="space-y-6">
        <Link
          to="/protocol-runs"
          className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-green-400 transition-colors"
        >
          &larr; Back to Protocol Runs
        </Link>
        <GlassPanel padding="lg">
          <div className="text-center py-16 text-white/30 text-sm">Loading run...</div>
        </GlassPanel>
      </div>
    );
  }

  const completedSteps = run.steps.filter((s) => s.status === "completed").length;
  const totalSteps = run.steps.length;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        to="/protocol-runs"
        className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-green-400 transition-colors"
      >
        &larr; Back to Protocol Runs
      </Link>

      {/* Header */}
      <GlassPanel padding="md">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span className="font-mono text-white/70 text-sm">{run.id}</span>
              {template && <span className="text-sm text-white/40">{template.name}</span>}
              <GlowBadge color={RUN_STATUS_COLOR[run.status] ?? "gray"}>{run.status}</GlowBadge>
            </div>
            <div className="flex gap-4 text-xs text-white/30">
              <span>Kernel: <span className="text-white/50 font-mono">{run.kernelId}</span></span>
              <span>Initiated by: <span className="text-white/50">{run.initiatedBy}</span></span>
              <span>Template: <span className="text-white/50 font-mono">v{run.templateVersion}</span></span>
            </div>
          </div>
          <div className="flex gap-2">
            {run.status === "running" && (
              <button
                onClick={() => handleAction("pause")}
                className="px-3 py-1.5 rounded-lg text-xs bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-all"
              >
                Pause
              </button>
            )}
            {run.status === "paused" && (
              <button
                onClick={() => handleAction("resume")}
                className="px-3 py-1.5 rounded-lg text-xs bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/20 transition-all"
              >
                Resume
              </button>
            )}
            {(run.status === "running" || run.status === "paused") && (
              <button
                onClick={() => handleAction("cancel")}
                className="px-3 py-1.5 rounded-lg text-xs bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-all"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </GlassPanel>

      {/* KPI cards */}
      <div className="grid grid-cols-5 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Progress" value={`${completedSteps}/${totalSteps}`} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Transfers" value={String(run.transfers.length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Samples" value={String(run.sampleIds.length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Episodes" value={String(run.transfers.filter((t) => t.episodeRecorded).length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Current Step" value={String(run.currentStepIndex + 1)} />
        </GlassPanel>
      </div>

      {/* DAG + sidebar */}
      <div className="flex gap-4 h-[450px]">
        {/* DAG */}
        <div className="flex-1 rounded-xl border border-white/[0.06] overflow-hidden">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            style={{ background: "rgba(10, 26, 15, 0.8)" }}
          >
            <Background color="rgba(124, 179, 66, 0.06)" gap={24} />
            <Controls
              className="!bg-white/[0.04] !border-white/[0.08] !rounded-lg [&_button]:!bg-white/[0.04] [&_button]:!border-white/[0.06] [&_button]:!fill-white/40"
            />
          </ReactFlow>
        </div>

        {/* Sidebar: step or transfer detail */}
        <div className="w-72 flex-shrink-0 overflow-y-auto space-y-3">
          {selectedRunStep && (
            <GlassPanel padding="md" glow="green">
              <h3 className="text-[10px] text-white/30 uppercase tracking-wider mb-3 font-semibold">Step Detail</h3>
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-white/70">
                    {stepLabelMap[selectedRunStep.protocolStepId]?.label ?? selectedRunStep.action}
                  </span>
                  <GlowBadge color={STEP_STATUS_COLOR[selectedRunStep.status] ?? "gray"}>
                    {selectedRunStep.status}
                  </GlowBadge>
                </div>
                <div className="space-y-1.5 text-white/40">
                  <div>
                    <span className="text-white/20">Action:</span>{" "}
                    <span className="font-mono text-white/60">{selectedRunStep.action}</span>
                  </div>
                  <div>
                    <span className="text-white/20">Node:</span>{" "}
                    <span className="font-mono text-white/60">{selectedRunStep.nodeId}</span>
                  </div>
                  {selectedRunStep.deviceId && (
                    <div>
                      <span className="text-white/20">Device:</span>{" "}
                      <span className="font-mono text-white/60">{selectedRunStep.deviceId}</span>
                    </div>
                  )}
                  {selectedRunStep.actualDurationMs != null && (
                    <div>
                      <span className="text-white/20">Duration:</span>{" "}
                      <span className="text-white/60">{formatDuration(selectedRunStep.actualDurationMs)}</span>
                    </div>
                  )}
                  {selectedRunStep.evidenceHash && (
                    <div>
                      <span className="text-white/20">Evidence:</span>{" "}
                      <span className="font-mono text-cyan-400/50 text-[10px]">{selectedRunStep.evidenceHash}</span>
                    </div>
                  )}
                  {selectedRunStep.error && (
                    <div className="text-red-400/70 bg-red-500/5 rounded p-2 mt-1">
                      {selectedRunStep.error}
                    </div>
                  )}
                </div>

                {/* Resolved params */}
                {Object.keys(selectedRunStep.resolvedParams).length > 0 && (
                  <div className="mt-2 border-t border-white/[0.06] pt-2">
                    <div className="text-[10px] text-white/25 mb-1 uppercase tracking-wider">Resolved Params</div>
                    {Object.entries(selectedRunStep.resolvedParams).map(([k, v]) => (
                      <div key={k} className="flex justify-between text-[10px]">
                        <span className="text-white/30">{k}</span>
                        <span className="text-white/50 font-mono">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </GlassPanel>
          )}

          {selectedRunTransfer && (
            <GlassPanel padding="md" glow="green">
              <h3 className="text-[10px] text-white/30 uppercase tracking-wider mb-3 font-semibold">Transfer Detail</h3>
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-white/50">{selectedRunTransfer.fromNodeId}</span>
                    <span className="text-white/20">&rarr;</span>
                    <span className="font-mono text-white/50">{selectedRunTransfer.toNodeId}</span>
                  </div>
                  <GlowBadge color={TRANSFER_STATUS_COLOR[selectedRunTransfer.status] ?? "gray"}>
                    {selectedRunTransfer.status}
                  </GlowBadge>
                </div>
                <div className="space-y-1.5 text-white/40">
                  <div>
                    <span className="text-white/20">Automation:</span>{" "}
                    <span className="text-white/60">{selectedRunTransfer.automationLevel}</span>
                  </div>
                  <div>
                    <span className="text-white/20">Mechanism:</span>{" "}
                    <span className="font-mono text-white/60">{selectedRunTransfer.mechanism}</span>
                  </div>
                  {selectedRunTransfer.transferAgentId && (
                    <div>
                      <span className="text-white/20">Agent:</span>{" "}
                      <span className="font-mono text-white/60">{selectedRunTransfer.transferAgentId}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-white/20">Episode Recorded:</span>
                    <GlowBadge color={selectedRunTransfer.episodeRecorded ? "green" : "gray"}>
                      {selectedRunTransfer.episodeRecorded ? "yes" : "no"}
                    </GlowBadge>
                  </div>
                  {selectedRunTransfer.episodeId && (
                    <div>
                      <span className="text-white/20">Episode ID:</span>{" "}
                      <span className="font-mono text-white/60 text-[10px]">{selectedRunTransfer.episodeId}</span>
                    </div>
                  )}
                </div>
              </div>
            </GlassPanel>
          )}

          {!selectedRunStep && !selectedRunTransfer && (
            <GlassPanel padding="md">
              <div className="text-center py-8 text-white/30 text-xs">
                Click a step or transfer in the DAG to view details
              </div>
            </GlassPanel>
          )}
        </div>
      </div>

      {/* Sample tracking */}
      <GlassPanel padding="md">
        <h3 className="text-sm font-medium text-white/60 mb-3">Sample Tracking</h3>
        <div className="flex flex-wrap gap-2">
          {run.sampleIds.map((sampleId) => (
            <div
              key={sampleId}
              className="px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs"
            >
              <span className="font-mono text-white/60">{sampleId}</span>
            </div>
          ))}
          {run.sampleIds.length === 0 && (
            <div className="text-white/30 text-xs">No samples tracked</div>
          )}
        </div>
      </GlassPanel>

      {/* Step list */}
      <GlassPanel padding="md">
        <h3 className="text-sm font-medium text-white/60 mb-3">All Steps</h3>
        <div className="space-y-1.5">
          {run.steps.map((step, i) => {
            const templateStep = stepLabelMap[step.protocolStepId];
            return (
              <button
                key={step.id}
                onClick={() => { setSelectedStepId(step.id); setSelectedTransferId(null); }}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs text-left transition-all ${
                  step.id === selectedStepId
                    ? "bg-green-500/10 border border-green-500/20"
                    : "bg-white/[0.02] border border-white/[0.04] hover:border-white/[0.08]"
                }`}
              >
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                  step.status === "completed" ? "bg-green-400" :
                  step.status === "running" ? "bg-amber-400 animate-pulse" :
                  step.status === "failed" ? "bg-red-400" :
                  "bg-white/20"
                }`} />
                <span className="text-white/30 w-4">{i + 1}</span>
                <span className="text-white/60 font-medium flex-1">{templateStep?.label ?? step.action}</span>
                <span className="text-white/20 font-mono">{step.action}</span>
                <GlowBadge color={STEP_STATUS_COLOR[step.status] ?? "gray"}>{step.status}</GlowBadge>
              </button>
            );
          })}
        </div>
      </GlassPanel>

      {/* Transfer list */}
      <GlassPanel padding="md">
        <h3 className="text-sm font-medium text-white/60 mb-3">Transfers</h3>
        <div className="space-y-1.5">
          {run.transfers.map((transfer) => (
            <button
              key={transfer.id}
              onClick={() => { setSelectedTransferId(transfer.id); setSelectedStepId(null); }}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs text-left transition-all ${
                transfer.id === selectedTransferId
                  ? "bg-green-500/10 border border-green-500/20"
                  : "bg-white/[0.02] border border-white/[0.04] hover:border-white/[0.08]"
              }`}
            >
              <span className="font-mono text-white/40">{transfer.fromNodeId}</span>
              <span className="text-white/20">&rarr;</span>
              <span className="font-mono text-white/40">{transfer.toNodeId}</span>
              <span className="text-white/25 flex-1">{transfer.automationLevel}</span>
              {transfer.episodeRecorded && (
                <span className="text-[9px] text-cyan-400/50 bg-cyan-400/10 px-1.5 py-0.5 rounded">episode</span>
              )}
              <GlowBadge color={TRANSFER_STATUS_COLOR[transfer.status] ?? "gray"}>{transfer.status}</GlowBadge>
            </button>
          ))}
          {run.transfers.length === 0 && (
            <div className="text-center py-4 text-white/30 text-xs">No transfers</div>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}
