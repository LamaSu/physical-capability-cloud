import React, { useCallback, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
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
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useProtocolBuilderStore, type StepDraft, type TransferDraft, type ParamDraft } from "../stores/protocol-builder-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// Step palette options
// ---------------------------------------------------------------------------

const capabilityOptions: { type: string; label: string }[] = [
  { type: "liquid_handler", label: "Liquid Handler" },
  { type: "centrifuge", label: "Centrifuge" },
  { type: "plate_reader", label: "Plate Reader" },
  { type: "incubator", label: "Incubator" },
  { type: "thermocycler", label: "Thermocycler" },
  { type: "mass_spec", label: "Mass Spec" },
  { type: "chromatograph", label: "Chromatograph" },
  { type: "microscope", label: "Microscope" },
  { type: "fdm", label: "FDM Print" },
  { type: "cnc-3axis", label: "CNC Mill" },
  { type: "laser-cut", label: "Laser Cut" },
  { type: "inspection", label: "Inspection" },
];

const automationLevelOptions = [
  { value: "manual", label: "Manual" },
  { value: "teleoperated", label: "Teleop" },
  { value: "pilot_operated", label: "Pilot" },
  { value: "vla_assisted", label: "VLA Assisted" },
  { value: "fully_autonomous", label: "Fully Auto" },
];

const labwareOptions = [
  "plate_96", "plate_384", "tube_rack", "flask", "vial", "trough",
  "slide", "dish", "beaker", "chip",
];

const paramTypeOptions = [
  "string", "number", "boolean", "enum", "duration", "temperature", "volume",
];

// ---------------------------------------------------------------------------
// Custom Step Node
// ---------------------------------------------------------------------------

interface BuilderStepData {
  label: string;
  capabilityType: string;
  estimatedDurationMs: number;
  producesEvidence: boolean;
  isSelected: boolean;
  [key: string]: unknown;
}

function BuilderStepNode({ data }: { data: BuilderStepData }) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 min-w-[200px] backdrop-blur-xl transition-all ${
        data.isSelected
          ? "bg-green-500/10 border-green-500/30 shadow-[0_0_15px_rgba(124,179,66,0.2)]"
          : "bg-white/[0.04] border-white/[0.08]"
      }`}
    >
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

const nodeTypes: NodeTypes = { builderStep: BuilderStepNode };

// ---------------------------------------------------------------------------
// Sidebar panels
// ---------------------------------------------------------------------------

type SidebarTab = "palette" | "step" | "transfer" | "params";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProtocolBuilderPage() {
  const { templateId } = useParams<{ templateId: string }>();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const isEdit = !!templateId;

  const {
    name, description, version, tags,
    steps, selectedStepId,
    transfers, selectedTransferId,
    parameters,
    setMeta, addStep, removeStep, updateStep, selectStep,
    addTransfer, removeTransfer, updateTransfer, selectTransfer,
    addParameter, removeParameter, updateParameter,
    reset,
  } = useProtocolBuilderStore();

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("palette");
  const [tagInput, setTagInput] = useState("");

  React.useEffect(() => {
    setPageMeta(
      isEdit ? "Edit Protocol" : "Protocol Builder",
      isEdit ? `Editing ${templateId}` : "Design a new protocol DAG",
    );
  }, [setPageMeta, isEdit, templateId]);

  // Convert store steps to React Flow nodes
  const flowNodes: Node[] = useMemo(
    () =>
      steps.map((step) => ({
        id: step.id,
        type: "builderStep",
        position: step.position,
        data: {
          label: step.label,
          capabilityType: step.capabilityType,
          estimatedDurationMs: step.estimatedDurationMs,
          producesEvidence: step.producesEvidence,
          isSelected: step.id === selectedStepId,
        } satisfies BuilderStepData,
      })),
    [steps, selectedStepId],
  );

  // Convert transfers to edges
  const flowEdges: Edge[] = useMemo(
    () =>
      transfers.map((t) => ({
        id: t.id,
        source: t.fromStepId,
        target: t.toStepId,
        animated: true,
        label: t.labwareType,
        labelStyle: { fill: "rgba(255,255,255,0.3)", fontSize: 10 },
        style: {
          stroke: t.id === selectedTransferId ? "rgba(124, 179, 66, 0.8)" : "rgba(124, 179, 66, 0.4)",
          strokeWidth: t.id === selectedTransferId ? 3 : 2,
        },
      })),
    [transfers, selectedTransferId],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

  // Sync store changes to flow state
  React.useEffect(() => { setNodes(flowNodes); }, [flowNodes, setNodes]);
  React.useEffect(() => { setEdges(flowEdges); }, [flowEdges, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        const id = addTransfer(connection.source, connection.target);
        setEdges((eds) =>
          addEdge(
            {
              ...connection,
              id,
              animated: true,
              style: { stroke: "rgba(124, 179, 66, 0.4)", strokeWidth: 2 },
            },
            eds,
          ),
        );
        selectTransfer(id);
        setSidebarTab("transfer");
      }
    },
    [addTransfer, setEdges, selectTransfer],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      selectStep(node.id);
      setSidebarTab("step");
    },
    [selectStep],
  );

  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      selectTransfer(edge.id);
      setSidebarTab("transfer");
    },
    [selectTransfer],
  );

  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, node: Node) => {
      updateStep(node.id, { position: { x: node.position.x, y: node.position.y } });
    },
    [updateStep],
  );

  const handleAddStep = (capType: string, label: string) => {
    const count = steps.length;
    addStep(capType, label, { x: 250 + (count % 3) * 280, y: 100 + Math.floor(count / 3) * 200 });
    setSidebarTab("step");
  };

  const handleAddTag = () => {
    const trimmed = tagInput.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setMeta({ tags: [...tags, trimmed] });
      setTagInput("");
    }
  };

  const handleRemoveTag = (tag: string) => {
    setMeta({ tags: tags.filter((t) => t !== tag) });
  };

  const selectedStep = steps.find((s) => s.id === selectedStepId);
  const selectedTransfer = transfers.find((t) => t.id === selectedTransferId);

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-160px)]">
      {/* Header */}
      <GlassPanel padding="md">
        <div className="flex items-center gap-4">
          <input
            type="text"
            value={name}
            onChange={(e) => setMeta({ name: e.target.value })}
            className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:border-green-500/30 flex-1"
            placeholder="Protocol name"
          />
          <input
            type="text"
            value={version}
            onChange={(e) => setMeta({ version: e.target.value })}
            className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:border-green-500/30 w-24 font-mono"
            placeholder="0.1.0"
          />
          <div className="flex items-center gap-1.5">
            {tags.map((tag) => (
              <button
                key={tag}
                onClick={() => handleRemoveTag(tag)}
                className="text-[10px] text-white/40 bg-white/[0.04] px-2 py-0.5 rounded hover:bg-red-500/10 hover:text-red-400 transition-colors"
                title="Remove tag"
              >
                {tag} x
              </button>
            ))}
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
              className="bg-white/[0.04] border border-white/[0.08] rounded px-2 py-0.5 text-[10px] text-white/60 outline-none w-16"
              placeholder="+ tag"
            />
          </div>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={reset}
              className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-xs text-white/40 hover:text-white/60 transition-colors"
            >
              Clear
            </button>
            <button
              className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-white/50 hover:text-white/70 transition-colors"
            >
              Save Draft
            </button>
            <button
              className="px-3 py-1.5 rounded-lg bg-green-500/20 border border-green-500/30 text-xs text-green-400 hover:bg-green-500/30 transition-colors"
            >
              Publish
            </button>
          </div>
        </div>
        {/* Description */}
        <textarea
          value={description}
          onChange={(e) => setMeta({ description: e.target.value })}
          className="w-full mt-2 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-white/60 outline-none focus:border-green-500/30 resize-none h-12"
          placeholder="Protocol description..."
        />
      </GlassPanel>

      {/* Main area: canvas + sidebar */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Canvas */}
        <div className="flex-1 rounded-xl border border-white/[0.06] overflow-hidden">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
            style={{ background: "rgba(10, 26, 15, 0.8)" }}
          >
            <Background color="rgba(124, 179, 66, 0.06)" gap={24} />
            <Controls
              className="!bg-white/[0.04] !border-white/[0.08] !rounded-lg [&_button]:!bg-white/[0.04] [&_button]:!border-white/[0.06] [&_button]:!fill-white/40"
            />
            <MiniMap
              nodeColor={() => "rgba(124, 179, 66, 0.3)"}
              maskColor="rgba(0, 0, 0, 0.6)"
              className="!bg-white/[0.04] !border-white/[0.08] !rounded-lg"
            />

            <Panel position="top-left">
              <span className="text-xs text-white/25 font-mono">{steps.length} steps, {transfers.length} transfers</span>
            </Panel>

            {steps.length === 0 && (
              <Panel position="top-center">
                <div className="text-white/30 text-sm mt-24">
                  Add steps from the palette on the right to build your protocol
                </div>
              </Panel>
            )}
          </ReactFlow>
        </div>

        {/* Right sidebar */}
        <div className="w-72 flex-shrink-0 flex flex-col gap-3 overflow-y-auto">
          {/* Tab buttons */}
          <div className="flex gap-1">
            {(
              [
                { key: "palette", label: "Palette" },
                { key: "step", label: "Step" },
                { key: "transfer", label: "Transfer" },
                { key: "params", label: "Params" },
              ] as { key: SidebarTab; label: string }[]
            ).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setSidebarTab(tab.key)}
                className={`flex-1 py-1.5 text-[10px] rounded-lg transition-all ${
                  sidebarTab === tab.key
                    ? "bg-green-500/15 border border-green-500/30 text-green-400"
                    : "bg-white/[0.02] border border-white/[0.06] text-white/30"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Palette */}
          {sidebarTab === "palette" && (
            <GlassPanel padding="md">
              <h3 className="text-[10px] text-white/30 uppercase tracking-wider mb-3 font-semibold">Add Step</h3>
              <div className="grid grid-cols-2 gap-2">
                {capabilityOptions.map((opt) => (
                  <button
                    key={opt.type}
                    onClick={() => handleAddStep(opt.type, opt.label)}
                    className="flex flex-col items-center gap-1 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:border-green-500/20 hover:bg-white/[0.05] transition-all text-center"
                  >
                    <span className="text-[10px] text-white/50">{opt.label}</span>
                    <span className="text-[9px] text-white/20 font-mono">{opt.type}</span>
                  </button>
                ))}
              </div>
            </GlassPanel>
          )}

          {/* Step editor */}
          {sidebarTab === "step" && selectedStep && (
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
                  <label className="text-xs text-white/40 block mb-1">Action</label>
                  <input
                    type="text"
                    value={selectedStep.action}
                    onChange={(e) => updateStep(selectedStep.id, { action: e.target.value })}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:border-green-500/30"
                    placeholder="e.g. dilute_and_dispense"
                  />
                </div>

                <div>
                  <label className="text-xs text-white/40 block mb-1">Est. Duration (min)</label>
                  <input
                    type="number"
                    value={Math.round(selectedStep.estimatedDurationMs / 60_000)}
                    onChange={(e) => updateStep(selectedStep.id, { estimatedDurationMs: Number(e.target.value) * 60_000 })}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:border-green-500/30"
                    min={1}
                  />
                </div>

                <div>
                  <label className="text-xs text-white/40 block mb-1">Required Labware</label>
                  <select
                    value={selectedStep.requiredLabware}
                    onChange={(e) => updateStep(selectedStep.id, { requiredLabware: e.target.value })}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:border-green-500/30"
                  >
                    {labwareOptions.map((lw) => (
                      <option key={lw} value={lw} className="bg-gray-900">{lw}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedStep.producesEvidence}
                    onChange={(e) => updateStep(selectedStep.id, { producesEvidence: e.target.checked })}
                    className="rounded border-white/[0.08] bg-white/[0.04]"
                  />
                  <label className="text-xs text-white/40">Produces evidence</label>
                </div>

                <div>
                  <label className="text-xs text-white/40 block mb-1">Notes</label>
                  <textarea
                    value={selectedStep.notes}
                    onChange={(e) => updateStep(selectedStep.id, { notes: e.target.value })}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-white/60 outline-none focus:border-green-500/30 resize-none h-16"
                    placeholder="Operator instructions..."
                  />
                </div>

                <div className="text-xs text-white/25 font-mono">
                  Dependencies: {selectedStep.dependsOn.length === 0 ? "none" : selectedStep.dependsOn.join(", ")}
                </div>

                <button
                  onClick={() => { removeStep(selectedStep.id); setSidebarTab("palette"); }}
                  className="w-full py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400/60 hover:text-red-400/80 transition-colors"
                >
                  Remove Step
                </button>
              </div>
            </GlassPanel>
          )}

          {sidebarTab === "step" && !selectedStep && (
            <GlassPanel padding="md">
              <div className="text-center py-8 text-white/30 text-xs">Click a step node to edit it</div>
            </GlassPanel>
          )}

          {/* Transfer editor */}
          {sidebarTab === "transfer" && selectedTransfer && (
            <GlassPanel padding="md" glow="green">
              <h3 className="text-[10px] text-white/30 uppercase tracking-wider mb-3 font-semibold">Transfer Detail</h3>
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs text-white/40">
                  <span className="font-mono">{selectedTransfer.fromStepId}</span>
                  <span className="text-white/20">&rarr;</span>
                  <span className="font-mono">{selectedTransfer.toStepId}</span>
                </div>

                <div>
                  <label className="text-xs text-white/40 block mb-1">Labware Type</label>
                  <select
                    value={selectedTransfer.labwareType}
                    onChange={(e) => updateTransfer(selectedTransfer.id, { labwareType: e.target.value })}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:border-green-500/30"
                  >
                    {labwareOptions.map((lw) => (
                      <option key={lw} value={lw} className="bg-gray-900">{lw}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-white/40 block mb-1">Preferred Automation</label>
                  <select
                    value={selectedTransfer.preferredAutomationLevel}
                    onChange={(e) => updateTransfer(selectedTransfer.id, { preferredAutomationLevel: e.target.value })}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:border-green-500/30"
                  >
                    {automationLevelOptions.map((opt) => (
                      <option key={opt.value} value={opt.value} className="bg-gray-900">{opt.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-white/40 block mb-1">Notes</label>
                  <textarea
                    value={selectedTransfer.notes}
                    onChange={(e) => updateTransfer(selectedTransfer.id, { notes: e.target.value })}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-white/60 outline-none focus:border-green-500/30 resize-none h-16"
                    placeholder="Transfer notes..."
                  />
                </div>

                <button
                  onClick={() => { removeTransfer(selectedTransfer.id); setSidebarTab("palette"); }}
                  className="w-full py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400/60 hover:text-red-400/80 transition-colors"
                >
                  Remove Transfer
                </button>
              </div>
            </GlassPanel>
          )}

          {sidebarTab === "transfer" && !selectedTransfer && (
            <GlassPanel padding="md">
              <div className="text-center py-8 text-white/30 text-xs">Click an edge to edit a transfer</div>
            </GlassPanel>
          )}

          {/* Parameters editor */}
          {sidebarTab === "params" && (
            <GlassPanel padding="md">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">Parameters</h3>
                <button
                  onClick={addParameter}
                  className="text-[10px] text-green-400 hover:text-green-300 transition-colors"
                >
                  + Add
                </button>
              </div>
              <div className="space-y-3">
                {parameters.map((param) => (
                  <div
                    key={param.key}
                    className="p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-white/30">{param.key}</span>
                      <button
                        onClick={() => removeParameter(param.key)}
                        className="text-[10px] text-red-400/50 hover:text-red-400 transition-colors"
                      >
                        remove
                      </button>
                    </div>
                    <input
                      type="text"
                      value={param.label}
                      onChange={(e) => updateParameter(param.key, { label: e.target.value })}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-xs text-white/70 outline-none focus:border-green-500/30"
                      placeholder="Label"
                    />
                    <div className="flex gap-2">
                      <select
                        value={param.type}
                        onChange={(e) => updateParameter(param.key, { type: e.target.value })}
                        className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-xs text-white/70 outline-none focus:border-green-500/30"
                      >
                        {paramTypeOptions.map((pt) => (
                          <option key={pt} value={pt} className="bg-gray-900">{pt}</option>
                        ))}
                      </select>
                      <div className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={param.required}
                          onChange={(e) => updateParameter(param.key, { required: e.target.checked })}
                          className="rounded border-white/[0.08] bg-white/[0.04]"
                        />
                        <span className="text-[10px] text-white/30">req</span>
                      </div>
                    </div>
                    <input
                      type="text"
                      value={param.group}
                      onChange={(e) => updateParameter(param.key, { group: e.target.value })}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-[10px] text-white/50 outline-none focus:border-green-500/30"
                      placeholder="Group"
                    />
                    <input
                      type="text"
                      value={param.defaultValue}
                      onChange={(e) => updateParameter(param.key, { defaultValue: e.target.value })}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-[10px] text-white/50 outline-none focus:border-green-500/30"
                      placeholder="Default value"
                    />
                    {(param.type === "number" || param.type === "temperature" || param.type === "volume" || param.type === "duration") && (
                      <div className="flex gap-2">
                        <input
                          type="number"
                          value={param.min ?? ""}
                          onChange={(e) => updateParameter(param.key, { min: e.target.value ? Number(e.target.value) : undefined })}
                          className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-[10px] text-white/50 outline-none"
                          placeholder="Min"
                        />
                        <input
                          type="number"
                          value={param.max ?? ""}
                          onChange={(e) => updateParameter(param.key, { max: e.target.value ? Number(e.target.value) : undefined })}
                          className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-[10px] text-white/50 outline-none"
                          placeholder="Max"
                        />
                        <input
                          type="text"
                          value={param.unit ?? ""}
                          onChange={(e) => updateParameter(param.key, { unit: e.target.value || undefined })}
                          className="w-14 bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-[10px] text-white/50 outline-none"
                          placeholder="Unit"
                        />
                      </div>
                    )}
                  </div>
                ))}
                {parameters.length === 0 && (
                  <div className="text-center py-4 text-white/25 text-[10px]">No parameters yet</div>
                )}
              </div>
            </GlassPanel>
          )}
        </div>
      </div>
    </div>
  );
}
