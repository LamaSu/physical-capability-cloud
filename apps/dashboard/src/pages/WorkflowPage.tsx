import React, { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { GlassPanel, GlowBadge, TierBadge } from "@pcc/ui";
import type { CapabilityType, AssuranceTier } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useWorkflowStore, type WorkflowStep } from "../stores/workflow-store.js";

// ── Custom Step Node ──

function StepNode({ data }: { data: WorkflowStep & { selected: boolean } }) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 min-w-[200px] backdrop-blur-xl transition-all ${
        data.selected
          ? "bg-green-500/10 border-green-500/30 shadow-[0_0_15px_rgba(124,179,66,0.2)]"
          : "bg-white/[0.04] border-white/[0.08]"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-green-500/50 !border-green-400/30 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <GlowBadge color="green">{data.capability}</GlowBadge>
        <TierBadge tier={data.assuranceTier} />
      </div>
      <div className="text-sm font-medium text-white/80">{data.label}</div>
      <div className="text-[10px] text-white/30 font-mono mt-1">{data.id}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-gold-400/50 !border-gold-300/30 !w-3 !h-3" />
    </div>
  );
}

const nodeTypes: NodeTypes = { step: StepNode };

// ── Step Palette ──

const stepOptions: { type: CapabilityType; label: string; icon: string }[] = [
  { type: "fdm", label: "FDM Print", icon: "🏭" },
  { type: "sla", label: "SLA Print", icon: "💧" },
  { type: "cnc-3axis", label: "CNC Mill", icon: "⚙️" },
  { type: "laser-cut", label: "Laser Cut", icon: "✂️" },
  { type: "inspection", label: "Inspection", icon: "🔍" },
  { type: "assembly", label: "Assembly", icon: "🔧" },
  { type: "courier-pickup", label: "Courier", icon: "📦" },
];

export function WorkflowPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => {
    setPageMeta("Workflow Builder", "Design multi-step capability workflows");
  }, [setPageMeta]);

  const { steps, selectedStepId, workflowName, addStep, removeStep, updateStep, addDependency, selectStep, setWorkflowName, reset } = useWorkflowStore();

  // Convert store steps to React Flow nodes
  const flowNodes: Node[] = useMemo(() =>
    steps.map((step, i) => ({
      id: step.id,
      type: "step",
      position: { x: 250 + (i % 3) * 280, y: 100 + Math.floor(i / 3) * 180 },
      data: { ...step, selected: step.id === selectedStepId },
    })),
    [steps, selectedStepId],
  );

  // Convert dependencies to edges
  const flowEdges: Edge[] = useMemo(() =>
    steps.flatMap((step) =>
      step.dependsOn.map((dep) => ({
        id: `${dep}->${step.id}`,
        source: dep,
        target: step.id,
        animated: true,
        style: { stroke: "rgba(124, 179, 66, 0.4)", strokeWidth: 2 },
      })),
    ),
    [steps],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

  // Sync store changes to flow state
  React.useEffect(() => { setNodes(flowNodes); }, [flowNodes, setNodes]);
  React.useEffect(() => { setEdges(flowEdges); }, [flowEdges, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        addDependency(connection.source, connection.target);
        setEdges((eds) => addEdge({ ...connection, animated: true, style: { stroke: "rgba(124, 179, 66, 0.4)", strokeWidth: 2 } }, eds));
      }
    },
    [addDependency, setEdges],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    selectStep(node.id);
  }, [selectStep]);

  const selectedStep = steps.find((s) => s.id === selectedStepId);

  return (
    <div className="flex gap-4 h-[calc(100vh-160px)]">
      {/* Canvas */}
      <div className="flex-1 rounded-xl border border-white/[0.06] overflow-hidden">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          style={{ background: "rgba(10, 26, 15, 0.8)" }}
        >
          <Background color="rgba(124, 179, 66, 0.06)" gap={24} />
          <Controls
            className="!bg-white/[0.04] !border-white/[0.08] !rounded-lg [&_button]:!bg-white/[0.04] [&_button]:!border-white/[0.06] [&_button]:!fill-white/40"
          />

          {/* Workflow name */}
          <Panel position="top-left">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={workflowName}
                onChange={(e) => setWorkflowName(e.target.value)}
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:border-green-500/30"
              />
              <span className="text-xs text-white/25 font-mono">{steps.length} steps</span>
            </div>
          </Panel>

          {/* Toolbar */}
          <Panel position="top-right">
            <div className="flex gap-2">
              <button
                onClick={reset}
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-xs text-white/40 hover:text-white/60 transition-colors"
              >
                Clear
              </button>
              <button
                className="px-3 py-1.5 rounded-lg bg-green-500/20 border border-green-500/30 text-xs text-green-400 hover:bg-green-500/30 transition-colors"
              >
                Submit Workflow
              </button>
            </div>
          </Panel>

          {steps.length === 0 && (
            <Panel position="top-center">
              <div className="text-white/30 text-sm mt-24">
                Add steps from the palette on the right to build your workflow
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>

      {/* Right panel: palette + step detail */}
      <div className="w-72 space-y-4 flex-shrink-0 overflow-y-auto">
        {/* Step palette */}
        <GlassPanel padding="md">
          <h3 className="text-[10px] text-white/30 uppercase tracking-wider mb-3 font-semibold">Add Step</h3>
          <div className="grid grid-cols-2 gap-2">
            {stepOptions.map((opt) => (
              <button
                key={opt.type}
                onClick={() => addStep(opt.type, opt.label)}
                className="flex flex-col items-center gap-1 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:border-green-500/20 hover:bg-white/[0.05] transition-all text-center"
              >
                <span className="text-lg">{opt.icon}</span>
                <span className="text-[10px] text-white/50">{opt.label}</span>
              </button>
            ))}
          </div>
        </GlassPanel>

        {/* Selected step detail */}
        {selectedStep && (
          <GlassPanel padding="md" glow="green">
            <h3 className="text-[10px] text-white/30 uppercase tracking-wider mb-3 font-semibold">Step Detail</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-white/40 block mb-1">Label</label>
                <input
                  type="text"
                  value={selectedStep.label}
                  onChange={(e) => updateStep(selectedStep.id, { label: e.target.value })}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:border-green-500/30"
                />
              </div>

              <div>
                <label className="text-xs text-white/40 block mb-1">Assurance Tier</label>
                <div className="flex gap-1">
                  {([0, 1, 2, 3] as AssuranceTier[]).map((tier) => (
                    <button
                      key={tier}
                      onClick={() => updateStep(selectedStep.id, { assuranceTier: tier })}
                      className={`flex-1 py-1 rounded text-xs border transition-all ${
                        selectedStep.assuranceTier === tier
                          ? "bg-green-500/15 border-green-500/30 text-green-400"
                          : "bg-white/[0.02] border-white/[0.06] text-white/30"
                      }`}
                    >
                      T{tier}
                    </button>
                  ))}
                </div>
              </div>

              <div className="text-xs text-white/25 font-mono">
                Dependencies: {selectedStep.dependsOn.length === 0 ? "none" : selectedStep.dependsOn.join(", ")}
              </div>

              <button
                onClick={() => removeStep(selectedStep.id)}
                className="w-full py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400/60 hover:text-red-400/80 transition-colors"
              >
                Remove Step
              </button>
            </div>
          </GlassPanel>
        )}
      </div>
    </div>
  );
}
