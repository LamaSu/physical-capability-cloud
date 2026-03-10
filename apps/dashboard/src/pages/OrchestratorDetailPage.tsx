import React from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel, GlowBadge, DataCell } from "@pcc/ui";
import type { TransferGraph, TransferNode, Sample, InstrumentWorkflow, ResourceClaim } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useOrchestratorStore } from "../stores/orchestrator-store.js";

const GATEWAY = "/api";

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

export function OrchestratorDetailPage() {
  const { kernelId } = useParams<{ kernelId: string }>();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { setSamples, setWorkflows, setClaims } = useOrchestratorStore();

  React.useEffect(() => {
    setPageMeta("Orchestrator", kernelId ? `Kernel: ${kernelId}` : "Kernel detail");
  }, [setPageMeta, kernelId]);

  // Fetch graph for kernel
  const { data: graphData } = useQuery({
    queryKey: ["orchestrator-graph", kernelId],
    queryFn: () => fetch(`${GATEWAY}/orchestrator/graphs/${kernelId}`).then((r) => r.json()),
    enabled: !!kernelId,
  });

  // Fetch samples for kernel
  const { data: sampleData } = useQuery({
    queryKey: ["orchestrator-samples", kernelId],
    queryFn: () => fetch(`${GATEWAY}/orchestrator/samples?kernelId=${kernelId}`).then((r) => r.json()),
    enabled: !!kernelId,
  });

  // Fetch workflows
  const { data: workflowData } = useQuery({
    queryKey: ["orchestrator-workflows"],
    queryFn: () => fetch(`${GATEWAY}/orchestrator/workflows`).then((r) => r.json()),
  });

  // Fetch claims
  const { data: claimData } = useQuery({
    queryKey: ["orchestrator-claims"],
    queryFn: () => fetch(`${GATEWAY}/orchestrator/claims`).then((r) => r.json()),
  });

  const graph: TransferGraph | null = graphData?.graph ?? null;
  const samples: Sample[] = sampleData?.samples ?? [];
  const allWorkflows: InstrumentWorkflow[] = workflowData?.workflows ?? [];
  const claims: ResourceClaim[] = claimData?.claims ?? [];

  // Filter workflows to this kernel
  const workflows = allWorkflows.filter((w) => w.kernelId === kernelId);

  React.useEffect(() => {
    if (samples.length) setSamples(samples);
  }, [sampleData]);

  React.useEffect(() => {
    if (workflows.length) setWorkflows(workflows);
  }, [workflowData]);

  React.useEffect(() => {
    if (claims.length) setClaims(claims);
  }, [claimData]);

  // Claim lookup
  const claimByNode = React.useMemo(() => {
    const map: Record<string, ResourceClaim> = {};
    for (const c of claims) {
      if (!c.released) map[c.nodeId] = c;
    }
    return map;
  }, [claims]);

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        to="/orchestrator"
        className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-green-400 transition-colors"
      >
        &larr; Back to Orchestrator
      </Link>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Kernel" value={kernelId ?? "—"} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Nodes" value={String(graph?.nodes.length ?? 0)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Samples" value={String(samples.length)} />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Workflows" value={String(workflows.length)} />
        </GlassPanel>
      </div>

      {/* Full transfer graph */}
      {graph && (
        <GlassPanel padding="md">
          <h3 className="text-sm font-medium text-white/60 mb-4">Transfer Graph — {graph.kernelId}</h3>

          {/* Nodes */}
          <div className="grid grid-cols-5 gap-3 mb-4">
            {graph.nodes.map((node) => {
              const claim = claimByNode[node.id];
              const sampleHere = samples.find((s) => s.currentNodeId === node.id);
              return (
                <div
                  key={node.id}
                  className={`p-3 rounded-lg border-2 bg-white/[0.03] ${NODE_TYPE_COLORS[node.nodeType]}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-white/70">{node.label}</span>
                    <GlowBadge color={NODE_TYPE_BADGE[node.nodeType]}>{node.nodeType}</GlowBadge>
                  </div>
                  <div className="text-[10px] text-white/30 mb-2">{node.capabilities.join(", ")}</div>
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className={`w-2 h-2 rounded-full ${claim ? "bg-amber-400" : "bg-green-400"}`} />
                    <span className="text-white/40">
                      {claim ? `Claimed by ${claim.claimedBy}` : "Available"}
                    </span>
                  </div>
                  {sampleHere && (
                    <div className="mt-1.5 text-[10px] text-cyan-400/70">
                      Sample: {sampleHere.label}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Edges */}
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
      )}

      {!graph && (
        <GlassPanel padding="lg">
          <div className="text-center py-16 text-white/30 text-sm">
            No transfer graph found for kernel {kernelId}
          </div>
        </GlassPanel>
      )}

      <div className="grid grid-cols-2 gap-6">
        {/* Samples */}
        <GlassPanel padding="md">
          <h3 className="text-sm font-medium text-white/60 mb-3">Samples</h3>
          <div className="space-y-2">
            {samples.map((sample) => {
              const nodeLabel = graph?.nodes.find((n) => n.id === sample.currentNodeId)?.label ?? sample.currentNodeId;
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
                  {/* Movement history */}
                  {sample.history.length > 0 && (
                    <div className="mt-2 border-t border-white/[0.06] pt-2 space-y-1">
                      {sample.history.map((mov) => {
                        const from = graph?.nodes.find((n) => n.id === mov.fromNodeId)?.label ?? mov.fromNodeId;
                        const to = graph?.nodes.find((n) => n.id === mov.toNodeId)?.label ?? mov.toNodeId;
                        return (
                          <div key={mov.id} className="text-[10px] text-white/30">
                            {from} &rarr; {to}
                            <span className="text-white/20"> via {mov.mechanism}</span>
                            {mov.completedAt && (
                              <span className="text-green-400/40 ml-1">done</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {samples.length === 0 && (
              <div className="text-center py-8 text-white/30 text-xs">No samples for this kernel</div>
            )}
          </div>
        </GlassPanel>

        {/* Workflows */}
        <GlassPanel padding="md">
          <h3 className="text-sm font-medium text-white/60 mb-3">Workflows</h3>
          <div className="space-y-2">
            {workflows.map((wf) => (
              <div
                key={wf.id}
                className="px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-white/70">{wf.id}</span>
                  <GlowBadge color={WF_STATUS_COLOR[wf.status]}>{wf.status}</GlowBadge>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2 text-white/40">
                  <div>
                    <span className="text-white/20">Job:</span>{" "}
                    <span className="text-white/60">{wf.jobId}</span>
                  </div>
                  <div>
                    <span className="text-white/20">Steps:</span>{" "}
                    <span className="text-white/60">{wf.steps.length}</span>
                  </div>
                </div>
                {/* Step detail */}
                <div className="mt-2 space-y-1">
                  {wf.steps.map((step, i) => {
                    const nodeLabel = graph?.nodes.find((n) => n.id === step.nodeId)?.label ?? step.nodeId;
                    return (
                      <div key={step.id} className="flex items-center gap-2 text-[10px] text-white/30">
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          i === 0 ? "bg-green-400" : i === 1 ? "bg-amber-400 animate-pulse" : "bg-white/20"
                        }`} />
                        <span className="text-white/50">{step.action}</span>
                        <span className="text-white/20">@</span>
                        <span>{nodeLabel}</span>
                        <span className="text-white/15">· {(step.estimatedDurationMs / 60000).toFixed(0)}min</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {workflows.length === 0 && (
              <div className="text-center py-8 text-white/30 text-xs">No workflows for this kernel</div>
            )}
          </div>
        </GlassPanel>
      </div>
    </div>
  );
}
