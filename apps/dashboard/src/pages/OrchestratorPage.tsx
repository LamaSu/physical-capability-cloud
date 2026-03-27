import React from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel, GlowBadge, DataCell } from "@pcc/ui";
import type { TransferGraph, TransferNode, Sample, InstrumentWorkflow, ResourceClaim } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useOrchestratorStore } from "../stores/orchestrator-store.js";
import { getAuthHeaders } from "../stores/auth-store.js";

const GATEWAY = "/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NODE_TYPE_COLORS: Record<TransferNode["nodeType"], string> = {
  instrument: "border-green-500/40",
  station: "border-amber-500/40",
  staging: "border-white/20",
  manual: "border-red-500/40",
};

const NODE_TYPE_BADGE: Record<TransferNode["nodeType"], "green" | "gold" | "gray" | "red"> = {
  instrument: "green",
  station: "gold",
  staging: "gray",
  manual: "red",
};

const SAMPLE_STATUS_COLOR: Record<Sample["status"], "green" | "gold" | "gray" | "red"> = {
  completed: "green",
  processing: "gold",
  in_transit: "gold",
  created: "gray",
  idle: "gray",
  failed: "red",
};

const WF_STATUS_COLOR: Record<InstrumentWorkflow["status"], "green" | "gold" | "gray" | "red"> = {
  completed: "green",
  running: "gold",
  pending: "gray",
  failed: "red",
  cancelled: "red",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrchestratorPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const {
    graphs, samples, workflows, claims,
    setGraphs, setSamples, setWorkflows, setClaims,
  } = useOrchestratorStore();

  React.useEffect(() => {
    setPageMeta("Orchestrator", "Intra-kernel instrument choreography");
  }, [setPageMeta]);

  // Fetch all data
  const { data: graphData } = useQuery({
    queryKey: ["orchestrator-graphs"],
    queryFn: () => fetch(`${GATEWAY}/orchestrator/graphs`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
  });

  const { data: sampleData } = useQuery({
    queryKey: ["orchestrator-samples"],
    queryFn: () => fetch(`${GATEWAY}/orchestrator/samples`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
  });

  const { data: workflowData } = useQuery({
    queryKey: ["orchestrator-workflows"],
    queryFn: () => fetch(`${GATEWAY}/orchestrator/workflows`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
  });

  const { data: claimData } = useQuery({
    queryKey: ["orchestrator-claims"],
    queryFn: () => fetch(`${GATEWAY}/orchestrator/claims`, { headers: { ...getAuthHeaders() } }).then((r) => r.json()),
  });

  React.useEffect(() => {
    if (graphData?.graphs) setGraphs(graphData.graphs);
  }, [graphData]);

  React.useEffect(() => {
    if (sampleData?.samples) setSamples(sampleData.samples);
  }, [sampleData]);

  React.useEffect(() => {
    if (workflowData?.workflows) setWorkflows(workflowData.workflows);
  }, [workflowData]);

  React.useEffect(() => {
    if (claimData?.claims) setClaims(claimData.claims);
  }, [claimData]);

  // Build claim lookup: nodeId -> claim
  const claimByNode = React.useMemo(() => {
    const map: Record<string, ResourceClaim> = {};
    for (const c of claims) {
      if (!c.released) map[c.nodeId] = c;
    }
    return map;
  }, [claims]);

  // All nodes across all graphs
  const allNodes = React.useMemo(
    () => graphs.flatMap((g) => g.nodes),
    [graphs],
  );

  return (
    <div className="space-y-6">
      {/* Summary KPIs */}
      <div className="grid grid-cols-4 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Transfer Graphs" value={String(graphs.length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Active Samples" value={String(samples.length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Running Workflows" value={String(workflows.filter((w) => w.status === "running").length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Active Claims" value={String(claims.filter((c) => !c.released).length)} />
        </GlassPanel>
      </div>

      {/* Transfer Graphs */}
      {graphs.map((graph) => (
        <GlassPanel key={graph.id} padding="md">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-medium text-white/60">Transfer Graph</h3>
              <div className="text-xs text-white/30 mt-0.5 font-mono">{graph.kernelId}</div>
            </div>
            <button
              onClick={() => navigate(`/orchestrator/${graph.kernelId}`)}
              className="px-3 py-1.5 rounded-lg text-xs bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/20 transition-all"
            >
              View Detail
            </button>
          </div>

          {/* Node grid */}
          <div className="grid grid-cols-5 gap-3 mb-4">
            {graph.nodes.map((node) => {
              const claim = claimByNode[node.id];
              const sampleHere = samples.find((s) => s.currentNodeId === node.id);
              return (
                <div
                  key={node.id}
                  className={`p-3 rounded-lg border-2 bg-white/[0.03] ${NODE_TYPE_COLORS[node.nodeType]} transition-all`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-white/70">{node.label}</span>
                    <GlowBadge color={NODE_TYPE_BADGE[node.nodeType]}>{node.nodeType}</GlowBadge>
                  </div>
                  <div className="text-[10px] text-white/30 mb-2">
                    {node.capabilities.join(", ")}
                  </div>
                  {/* Claim status */}
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className={`w-2 h-2 rounded-full ${claim ? "bg-amber-400" : "bg-green-400"}`} />
                    <span className="text-white/40">
                      {claim ? `Claimed by ${claim.claimedBy}` : "Available"}
                    </span>
                  </div>
                  {/* Sample present */}
                  {sampleHere && (
                    <div className="mt-1.5 text-[10px] text-cyan-400/70">
                      Sample: {sampleHere.label}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Edges table */}
          <div className="text-xs text-white/40">
            <div className="grid grid-cols-5 gap-2 font-medium text-white/30 mb-1 px-2">
              <span>From</span>
              <span>To</span>
              <span>Mechanism</span>
              <span>Time</span>
              <span>Direction</span>
            </div>
            {graph.edges.map((edge) => {
              const fromLabel = graph.nodes.find((n) => n.id === edge.fromNode)?.label ?? edge.fromNode;
              const toLabel = graph.nodes.find((n) => n.id === edge.toNode)?.label ?? edge.toNode;
              return (
                <div key={edge.id} className="grid grid-cols-5 gap-2 px-2 py-1.5 bg-white/[0.02] rounded mb-1">
                  <span className="text-white/60">{fromLabel}</span>
                  <span className="text-white/60">{toLabel}</span>
                  <span className="font-mono">{edge.mechanism}</span>
                  <span>{(edge.transferTimeMs / 1000).toFixed(1)}s</span>
                  <span>{edge.bidirectional ? "Bidirectional" : "One-way"}</span>
                </div>
              );
            })}
          </div>
        </GlassPanel>
      ))}

      <div className="grid grid-cols-2 gap-6">
        {/* Active Samples */}
        <GlassPanel padding="md">
          <h3 className="text-sm font-medium text-white/60 mb-3">Active Samples</h3>
          <div className="space-y-2">
            {samples.map((sample) => {
              const nodeLabel = allNodes.find((n) => n.id === sample.currentNodeId)?.label ?? sample.currentNodeId;
              return (
                <div
                  key={sample.id}
                  className="px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-white/70">{sample.label}</span>
                    <GlowBadge color={SAMPLE_STATUS_COLOR[sample.status]}>{sample.status}</GlowBadge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 text-white/40">
                    <div>
                      <span className="text-white/20">Location:</span>{" "}
                      <span className="text-white/60">{nodeLabel}</span>
                    </div>
                    <div>
                      <span className="text-white/20">Labware:</span>{" "}
                      <span className="text-white/60">{sample.labwareType}</span>
                    </div>
                    <div>
                      <span className="text-white/20">Moves:</span>{" "}
                      <span className="text-white/60">{sample.history.length}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {samples.length === 0 && (
              <div className="text-center py-8 text-white/30 text-xs">No active samples</div>
            )}
          </div>
        </GlassPanel>

        {/* Active Workflows */}
        <GlassPanel padding="md">
          <h3 className="text-sm font-medium text-white/60 mb-3">Instrument Workflows</h3>
          <div className="space-y-2">
            {workflows.map((wf) => {
              const completedSteps = wf.steps.filter((s) =>
                // Steps with no unfinished dependsOn are "done" in running workflows
                // For simplicity show count based on workflow progress
                false
              ).length;
              return (
                <div
                  key={wf.id}
                  className="px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-white/70">{wf.id}</span>
                    <GlowBadge color={WF_STATUS_COLOR[wf.status]}>{wf.status}</GlowBadge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 text-white/40">
                    <div>
                      <span className="text-white/20">Kernel:</span>{" "}
                      <span className="text-white/60">{wf.kernelId}</span>
                    </div>
                    <div>
                      <span className="text-white/20">Job:</span>{" "}
                      <span className="text-white/60">{wf.jobId}</span>
                    </div>
                    <div>
                      <span className="text-white/20">Steps:</span>{" "}
                      <span className="text-white/60">{wf.steps.length}</span>
                    </div>
                  </div>
                  {/* Step progress bar */}
                  <div className="mt-2 flex gap-1">
                    {wf.steps.map((step, i) => (
                      <div
                        key={step.id}
                        className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden"
                        title={`${step.action} @ ${allNodes.find((n) => n.id === step.nodeId)?.label ?? step.nodeId}`}
                      >
                        <div
                          className={`h-full rounded-full ${
                            i === 0 ? "bg-green-400" : i === 1 ? "bg-amber-400 animate-pulse" : "bg-white/10"
                          }`}
                          style={{ width: i === 0 ? "100%" : i === 1 ? "60%" : "0%" }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {workflows.length === 0 && (
              <div className="text-center py-8 text-white/30 text-xs">No workflows found</div>
            )}
          </div>
        </GlassPanel>
      </div>

      {/* Instrument Status */}
      <GlassPanel padding="md">
        <h3 className="text-sm font-medium text-white/60 mb-3">Instrument Status</h3>
        <div className="grid grid-cols-5 gap-3">
          {allNodes.map((node) => {
            const claim = claimByNode[node.id];
            return (
              <div
                key={node.id}
                className="px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${claim ? "bg-amber-400 animate-pulse" : "bg-green-400"}`} />
                  <span className="text-white/70 font-medium">{node.label}</span>
                </div>
                {claim && (
                  <div className="mt-1.5 text-[10px] text-amber-400/60">
                    Claimed by <span className="font-mono">{claim.claimedBy}</span>
                    {claim.expiresAt && (
                      <span className="text-white/20"> · expires {new Date(claim.expiresAt).toLocaleTimeString()}</span>
                    )}
                  </div>
                )}
                {!claim && (
                  <div className="mt-1.5 text-[10px] text-green-400/50">Ready</div>
                )}
              </div>
            );
          })}
        </div>
      </GlassPanel>
    </div>
  );
}
