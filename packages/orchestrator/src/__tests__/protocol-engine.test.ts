import { describe, it, expect } from "vitest";
import type {
  TransferNode,
  TransferEdge,
  ProtocolTemplate,
  ProtocolStep,
  ProtocolTransfer,
} from "@pcc/spec";
import { ids } from "@pcc/spec";
import { TransferGraphBuilder } from "../transfer-graph.js";
import { ResourcePool } from "../resource-pool.js";
import { AutomationTracker } from "../automation-tracker.js";
import { ProtocolEngine } from "../protocol-engine.js";

// ── Helpers ──────────────────────────────────────────────────────────

const KERNEL_ID = "kernel_test1";

function makeNode(
  id: string,
  label: string,
  capabilities: string[],
  nodeType: TransferNode["nodeType"] = "instrument",
): Omit<TransferNode, "id"> & { id: string } {
  return { id, kernelId: KERNEL_ID, label, nodeType, capabilities };
}

function makeEdge(
  id: string,
  from: string,
  to: string,
  timeMs: number,
  bidirectional = false,
): Omit<TransferEdge, "id"> & { id: string } {
  return {
    id,
    fromNode: from,
    toNode: to,
    mechanism: "robot_arm",
    transferTimeMs: timeMs,
    bidirectional,
  };
}

function makeStep(
  id: string,
  capabilityType: string,
  label: string,
  action: string,
  dependsOn: string[] = [],
  parameterBindings?: ProtocolStep["parameterBindings"],
): ProtocolStep {
  return {
    id,
    capabilityType,
    label,
    action,
    params: { speed: 60 },
    parameterBindings,
    estimatedDurationMs: 1000,
    producesEvidence: false,
    dependsOn,
  };
}

function makeTransfer(
  id: string,
  fromStepId: string,
  toStepId: string,
): ProtocolTransfer {
  return {
    id,
    fromStepId,
    toStepId,
    labwareType: "plate",
  };
}

function makeTemplate(
  steps: ProtocolStep[],
  transfers: ProtocolTransfer[],
  requiredCapabilities: string[],
): ProtocolTemplate {
  return {
    id: ids.protocolTemplate(),
    name: "Test Protocol",
    description: "A test protocol",
    version: "1.0.0",
    authorId: "user_test",
    authorName: "Test User",
    status: "published",
    tags: ["test"],
    requiredCapabilities,
    steps,
    transfers,
    parameters: [
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        required: false,
        defaultValue: 200,
        unit: "C",
      },
    ],
    defaultValues: { temperature: 200 },
    estimatedTotalDurationMs: 5000,
    forkCount: 0,
    runCount: 0,
    createdAt: new Date().toISOString(),
  };
}

/** Build a graph: staging -> fdm -> cnc -> qc (linear with capabilities) */
function buildLabGraph(): TransferGraphBuilder {
  const builder = new TransferGraphBuilder();
  builder.addNode(makeNode("staging", "Staging Area", ["staging"], "staging"));
  builder.addNode(makeNode("fdm", "FDM Printer", ["fdm_printing", "3d_printing"]));
  builder.addNode(makeNode("cnc", "CNC Mill", ["cnc_milling", "subtractive"]));
  builder.addNode(makeNode("qc", "QC Station", ["quality_inspection", "measurement"]));

  builder.addEdge(makeEdge("e1", "staging", "fdm", 30, true));
  builder.addEdge(makeEdge("e2", "fdm", "cnc", 60, true));
  builder.addEdge(makeEdge("e3", "cnc", "qc", 45, true));
  builder.addEdge(makeEdge("e4", "staging", "qc", 90)); // Direct path

  return builder;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ProtocolEngine", () => {
  it("finds candidate nodes by capability type", () => {
    const builder = buildLabGraph();
    const pool = new ResourcePool();
    const autoTracker = new AutomationTracker();
    const engine = new ProtocolEngine(builder, pool, autoTracker);

    const fdmNodes = engine.findCandidateNodes("fdm_printing");
    expect(fdmNodes).toHaveLength(1);
    expect(fdmNodes[0].id).toBe("fdm");

    const printNodes = engine.findCandidateNodes("3d_printing");
    expect(printNodes).toHaveLength(1);
    expect(printNodes[0].id).toBe("fdm");

    const noNodes = engine.findCandidateNodes("laser_cutting");
    expect(noNodes).toHaveLength(0);
  });

  it("binds a simple 2-step protocol to instruments", () => {
    const builder = buildLabGraph();
    const pool = new ResourcePool();
    const autoTracker = new AutomationTracker();
    const engine = new ProtocolEngine(builder, pool, autoTracker);

    const step1 = makeStep("ps1", "fdm_printing", "Print Part", "fdm_print");
    const step2 = makeStep("ps2", "quality_inspection", "Inspect", "measure", ["ps1"]);
    const transfer = makeTransfer("pt1", "ps1", "ps2");

    const template = makeTemplate(
      [step1, step2],
      [transfer],
      ["fdm_printing", "quality_inspection"],
    );

    const run = engine.bindProtocol(template, KERNEL_ID, { temperature: 210 }, "user_test");

    expect(run.id).toMatch(/^prun_/);
    expect(run.templateId).toBe(template.id);
    expect(run.status).toBe("ready");
    expect(run.steps).toHaveLength(2);
    expect(run.transfers).toHaveLength(1);

    // Steps bound to correct nodes
    expect(run.steps[0].nodeId).toBe("fdm");
    expect(run.steps[1].nodeId).toBe("qc");

    // Transfer has correct from/to
    expect(run.transfers[0].fromNodeId).toBe("fdm");
    expect(run.transfers[0].toNodeId).toBe("qc");
  });

  it("resolves parameter bindings via substitution", () => {
    const builder = buildLabGraph();
    const pool = new ResourcePool();
    const autoTracker = new AutomationTracker();
    const engine = new ProtocolEngine(builder, pool, autoTracker);

    const step = makeStep("ps1", "fdm_printing", "Print", "fdm_print", [], [
      { stepParamKey: "nozzle_temp", protocolParamKey: "temperature" },
    ]);

    const resolved = engine.resolveParams(step, { temperature: 215 });
    expect(resolved.nozzle_temp).toBe(215);
    expect(resolved.speed).toBe(60); // Original param preserved
  });

  it("validates a valid protocol (passes)", () => {
    const builder = buildLabGraph();
    const pool = new ResourcePool();
    const autoTracker = new AutomationTracker();
    const engine = new ProtocolEngine(builder, pool, autoTracker);

    const step1 = makeStep("ps1", "fdm_printing", "Print", "fdm_print");
    const step2 = makeStep("ps2", "quality_inspection", "QC", "measure", ["ps1"]);
    const transfer = makeTransfer("pt1", "ps1", "ps2");

    const template = makeTemplate(
      [step1, step2],
      [transfer],
      ["fdm_printing", "quality_inspection"],
    );

    const result = engine.validateBinding(template);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validates a protocol with missing capability (fails)", () => {
    const builder = buildLabGraph();
    const pool = new ResourcePool();
    const autoTracker = new AutomationTracker();
    const engine = new ProtocolEngine(builder, pool, autoTracker);

    const step1 = makeStep("ps1", "laser_cutting", "Cut", "laser_cut");
    const template = makeTemplate(
      [step1],
      [],
      ["laser_cutting"],
    );

    const result = engine.validateBinding(template);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("laser_cutting"))).toBe(true);
  });

  it("validates a protocol with unreachable transfer path (fails)", () => {
    // Create a disconnected graph
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("fdm", "FDM", ["fdm_printing"]));
    builder.addNode(makeNode("iso", "Isolated QC", ["quality_inspection"]));
    // No edge between them

    const pool = new ResourcePool();
    const autoTracker = new AutomationTracker();
    const engine = new ProtocolEngine(builder, pool, autoTracker);

    const step1 = makeStep("ps1", "fdm_printing", "Print", "fdm_print");
    const step2 = makeStep("ps2", "quality_inspection", "QC", "measure", ["ps1"]);
    const transfer = makeTransfer("pt1", "ps1", "ps2");
    const template = makeTemplate(
      [step1, step2],
      [transfer],
      ["fdm_printing", "quality_inspection"],
    );

    const result = engine.validateBinding(template);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("No transfer path"))).toBe(true);
  });

  it("bind protocol assigns automation level from tracker", () => {
    const builder = buildLabGraph();
    const pool = new ResourcePool();
    const autoTracker = new AutomationTracker();
    const engine = new ProtocolEngine(builder, pool, autoTracker);

    // Register automation at vla_assisted level
    autoTracker.register(KERNEL_ID, "fdm", "qc", "tagent_r2d3", "vla_assisted");

    const step1 = makeStep("ps1", "fdm_printing", "Print", "fdm_print");
    const step2 = makeStep("ps2", "quality_inspection", "QC", "measure", ["ps1"]);
    const transfer = makeTransfer("pt1", "ps1", "ps2");

    const template = makeTemplate(
      [step1, step2],
      [transfer],
      ["fdm_printing", "quality_inspection"],
    );

    const run = engine.bindProtocol(template, KERNEL_ID, {}, "user_test");

    expect(run.transfers[0].automationLevel).toBe("vla_assisted");
    expect(run.transfers[0].mechanism).toBe("robot_autonomous");
  });

  it("prefers nodes near previous step for binding", () => {
    // Build graph with two FDM printers at different distances from staging
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("staging", "Staging", ["staging"], "staging"));
    builder.addNode(makeNode("fdm_near", "FDM Near", ["fdm_printing"]));
    builder.addNode(makeNode("fdm_far", "FDM Far", ["fdm_printing"]));
    builder.addNode(makeNode("qc", "QC", ["quality_inspection"]));

    builder.addEdge(makeEdge("e1", "staging", "fdm_near", 10));
    builder.addEdge(makeEdge("e2", "staging", "fdm_far", 500));
    builder.addEdge(makeEdge("e3", "fdm_near", "qc", 20));
    builder.addEdge(makeEdge("e4", "fdm_far", "qc", 20));

    const pool = new ResourcePool();
    const autoTracker = new AutomationTracker();
    const engine = new ProtocolEngine(builder, pool, autoTracker);

    // Find FDM candidates near the QC station
    const candidates = engine.findCandidateNodes("fdm_printing", "qc");
    expect(candidates).toHaveLength(2);
    // fdm_near is closer to qc (20ms) than fdm_far (20ms) — both same distance from qc.
    // But from staging: fdm_near is closer (10ms vs 500ms)
    // We'll test preference from staging instead
    const fromStaging = engine.findCandidateNodes("fdm_printing", "staging");
    expect(fromStaging[0].id).toBe("fdm_near");
  });
});
