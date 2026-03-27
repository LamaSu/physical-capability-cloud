import React, { useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
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
import type { ProtocolTemplate, ProtocolStep, ProtocolTransfer, ProtocolFork, ProtocolRun } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { getAuthHeaders } from "../stores/auth-store.js";

const GATEWAY = "/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<string, "green" | "gold" | "gray" | "red"> = {
  published: "green",
  draft: "gold",
  deprecated: "red",
  archived: "gray",
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
// Custom Step Node
// ---------------------------------------------------------------------------

interface StepNodeData {
  label: string;
  capabilityType: string;
  estimatedDurationMs: number;
  producesEvidence: boolean;
  [key: string]: unknown;
}

function StepNode({ data }: { data: StepNodeData }) {
  return (
    <div className="rounded-xl border px-4 py-3 min-w-[200px] bg-white/[0.04] border-white/[0.08] backdrop-blur-xl">
      <Handle type="target" position={Position.Top} className="!bg-green-500/50 !border-green-400/30 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <GlowBadge color="green">{data.capabilityType}</GlowBadge>
        {data.producesEvidence && (
          <span className="text-[9px] text-cyan-400/60 bg-cyan-400/10 px-1.5 py-0.5 rounded">evidence</span>
        )}
      </div>
      <div className="text-sm font-medium text-white/80">{data.label}</div>
      <div className="text-[10px] text-white/30 mt-1">{formatDuration(data.estimatedDurationMs)}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-amber-400/50 !border-amber-300/30 !w-3 !h-3" />
    </div>
  );
}

const nodeTypes: NodeTypes = { protocolStep: StepNode };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProtocolDetailPage() {
  const { templateId } = useParams<{ templateId: string }>();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [activeTab, setActiveTab] = useState<"params" | "forks" | "runs">("params");
  const [showForkForm, setShowForkForm] = useState(false);
  const [forkName, setForkName] = useState("");

  React.useEffect(() => {
    setPageMeta("Protocol Detail", templateId ?? "");
  }, [setPageMeta, templateId]);

  // Fetch template
  const { data: templateData } = useQuery({
    queryKey: ["protocol-template", templateId],
    queryFn: () => fetch(`${GATEWAY}/protocols/${templateId}`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
    enabled: !!templateId,
  });

  // Fetch forks
  const { data: forksData } = useQuery({
    queryKey: ["protocol-forks", templateId],
    queryFn: () => fetch(`${GATEWAY}/protocols/${templateId}/forks`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
    enabled: !!templateId,
  });

  // Fetch runs for this template
  const { data: runsData } = useQuery({
    queryKey: ["protocol-runs-for-template", templateId],
    queryFn: () => fetch(`${GATEWAY}/protocol-runs?templateId=${templateId}`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
    enabled: !!templateId,
  });

  const template: ProtocolTemplate | null = templateData?.template ?? null;
  const forks: ProtocolFork[] = forksData?.forks ?? [];
  const runs: ProtocolRun[] = runsData?.runs ?? [];

  // Build React Flow nodes from steps
  const flowNodes: Node[] = useMemo(() => {
    if (!template) return [];
    return template.steps.map((step, i) => ({
      id: step.id,
      type: "protocolStep",
      position: step.position ?? { x: 250 + (i % 3) * 280, y: 100 + Math.floor(i / 3) * 200 },
      data: {
        label: step.label,
        capabilityType: step.capabilityType,
        estimatedDurationMs: step.estimatedDurationMs,
        producesEvidence: step.producesEvidence,
      } satisfies StepNodeData,
      draggable: false,
    }));
  }, [template]);

  // Build edges from transfers
  const flowEdges: Edge[] = useMemo(() => {
    if (!template) return [];
    return template.transfers.map((t) => ({
      id: t.id,
      source: t.fromStepId,
      target: t.toStepId,
      animated: true,
      label: `${t.labwareType}${t.preferredAutomationLevel ? ` (${t.preferredAutomationLevel})` : ""}`,
      labelStyle: { fill: "rgba(255,255,255,0.3)", fontSize: 10 },
      style: { stroke: "rgba(124, 179, 66, 0.4)", strokeWidth: 2 },
    }));
  }, [template]);

  if (!template) {
    return (
      <div className="space-y-6">
        <Link
          to="/protocols"
          className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-green-400 transition-colors"
        >
          &larr; Back to Protocol Library
        </Link>
        <GlassPanel padding="lg">
          <div className="text-center py-16 text-white/30 text-sm">Loading protocol...</div>
        </GlassPanel>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        to="/protocols"
        className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-green-400 transition-colors"
      >
        &larr; Back to Protocol Library
      </Link>

      {/* Header */}
      <GlassPanel padding="md">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-lg font-semibold text-white/90">{template.name}</h2>
              <span className="text-xs font-mono text-white/30">v{template.version}</span>
              <GlowBadge color={STATUS_COLOR[template.status] ?? "gray"}>{template.status}</GlowBadge>
            </div>
            <p className="text-sm text-white/40 mb-2">{template.description}</p>
            <div className="flex flex-wrap gap-1.5">
              {template.tags.map((tag) => (
                <span key={tag} className="text-[10px] text-white/25 bg-white/[0.03] px-1.5 py-0.5 rounded">
                  {tag}
                </span>
              ))}
            </div>
            <div className="text-xs text-white/25 mt-2">by {template.authorName}</div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowForkForm(!showForkForm)}
              className="px-3 py-1.5 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-white/50 hover:text-white/70 transition-colors"
            >
              Fork Protocol
            </button>
            <button
              onClick={() => navigate(`/protocols/${template.id}/edit`)}
              className="px-3 py-1.5 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-white/50 hover:text-white/70 transition-colors"
            >
              Edit
            </button>
            <button
              className="px-3 py-1.5 rounded-lg text-xs bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30 transition-colors"
            >
              Run Protocol
            </button>
          </div>
        </div>

        {/* Fork form */}
        {showForkForm && (
          <div className="mt-4 p-4 rounded-lg bg-white/[0.03] border border-white/[0.06]">
            <h4 className="text-xs font-medium text-white/50 mb-2">Fork this protocol</h4>
            <input
              type="text"
              placeholder="Fork name..."
              value={forkName}
              onChange={(e) => setForkName(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:border-green-500/30 mb-2"
            />
            <button
              className="px-3 py-1.5 rounded-lg text-xs bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30 transition-colors"
            >
              Create Fork
            </button>
          </div>
        )}
      </GlassPanel>

      {/* KPI cards */}
      <div className="grid grid-cols-6 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Steps" value={String(template.steps.length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Transfers" value={String(template.transfers.length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Parameters" value={String(template.parameters.length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Est. Duration" value={formatDuration(template.estimatedTotalDurationMs)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Forks" value={String(template.forkCount)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Runs" value={String(template.runCount)} />
        </GlassPanel>
      </div>

      {/* DAG Visualization */}
      <GlassPanel padding="md">
        <h3 className="text-sm font-medium text-white/60 mb-3">Protocol DAG</h3>
        <div className="h-[400px] rounded-xl border border-white/[0.06] overflow-hidden">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
            style={{ background: "rgba(10, 26, 15, 0.8)" }}
          >
            <Background color="rgba(124, 179, 66, 0.06)" gap={24} />
            <Controls
              className="!bg-white/[0.04] !border-white/[0.08] !rounded-lg [&_button]:!bg-white/[0.04] [&_button]:!border-white/[0.06] [&_button]:!fill-white/40"
            />
          </ReactFlow>
        </div>
      </GlassPanel>

      {/* Tabs: Parameters | Forks | Runs */}
      <div className="flex gap-1 border-b border-white/[0.06] pb-0">
        {(["params", "forks", "runs"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-xs font-medium rounded-t-lg transition-all ${
              activeTab === tab
                ? "bg-white/[0.04] text-green-400 border border-white/[0.08] border-b-transparent"
                : "text-white/30 hover:text-white/50"
            }`}
          >
            {tab === "params" ? `Parameters (${template.parameters.length})` : tab === "forks" ? `Forks (${forks.length})` : `Runs (${runs.length})`}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "params" && (
        <GlassPanel padding="md">
          <div className="space-y-2">
            {template.parameters.map((param) => (
              <div
                key={param.key}
                className="px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs"
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white/70">{param.label}</span>
                    <span className="font-mono text-white/25">{param.key}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <GlowBadge color="gray">{param.type}</GlowBadge>
                    {param.required && <GlowBadge color="gold">required</GlowBadge>}
                  </div>
                </div>
                {param.description && (
                  <div className="text-white/30 mb-1">{param.description}</div>
                )}
                <div className="flex gap-4 text-white/25">
                  {param.group && <span>Group: {param.group}</span>}
                  {param.defaultValue != null && <span>Default: {String(param.defaultValue)}</span>}
                  {param.unit && <span>Unit: {param.unit}</span>}
                  {param.min != null && <span>Min: {param.min}</span>}
                  {param.max != null && <span>Max: {param.max}</span>}
                  {param.options && param.options.length > 0 && (
                    <span>Options: {param.options.map((o) => o.label).join(", ")}</span>
                  )}
                </div>
              </div>
            ))}
            {template.parameters.length === 0 && (
              <div className="text-center py-8 text-white/30 text-xs">No parameters defined</div>
            )}
          </div>
        </GlassPanel>
      )}

      {activeTab === "forks" && (
        <GlassPanel padding="md">
          <div className="space-y-2">
            {forks.map((fork) => (
              <div
                key={fork.id}
                className="px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-white/70">{fork.name}</span>
                  <span className="font-mono text-white/25">{fork.id}</span>
                </div>
                <div className="flex gap-4 text-white/30">
                  <span>From v{fork.sourceTemplateVersion}</span>
                  <span>By: {fork.forkedBy}</span>
                  <span>Overrides: {Object.keys(fork.parameterOverrides).length}</span>
                </div>
                {fork.notes && <div className="text-white/25 mt-1">{fork.notes}</div>}
              </div>
            ))}
            {forks.length === 0 && (
              <div className="text-center py-8 text-white/30 text-xs">No forks yet</div>
            )}
          </div>
        </GlassPanel>
      )}

      {activeTab === "runs" && (
        <GlassPanel padding="md">
          <div className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                onClick={() => navigate(`/protocol-runs/${run.id}`)}
                className="w-full px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs text-left hover:border-white/[0.12] transition-all"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-white/70">{run.id}</span>
                  <GlowBadge color={RUN_STATUS_COLOR[run.status] ?? "gray"}>{run.status}</GlowBadge>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2 text-white/40">
                  <div>
                    <span className="text-white/20">Kernel:</span>{" "}
                    <span className="text-white/60">{run.kernelId}</span>
                  </div>
                  <div>
                    <span className="text-white/20">Steps:</span>{" "}
                    <span className="text-white/60">{run.steps.filter((s) => s.status === "completed").length}/{run.steps.length}</span>
                  </div>
                  <div>
                    <span className="text-white/20">Initiated:</span>{" "}
                    <span className="text-white/60">{run.initiatedBy}</span>
                  </div>
                </div>
              </button>
            ))}
            {runs.length === 0 && (
              <div className="text-center py-8 text-white/30 text-xs">No runs yet</div>
            )}
          </div>
        </GlassPanel>
      )}
    </div>
  );
}
