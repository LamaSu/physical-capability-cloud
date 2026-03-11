import type { StoreDB } from "../connection.js";
import {
  transferGraphs,
  transferNodes,
  transferEdges,
  samples,
  sampleMovements,
  instrumentWorkflows,
  instrumentSteps,
  resourceClaims,
} from "../schema/index.js";

const KERNEL_ID = "kernel-biolab-01";
const now = new Date().toISOString();

/**
 * Seeds orchestrator data: transfer graphs, nodes, edges, samples, workflows.
 */
export function seedOrchestrator(db: StoreDB): void {
  // ── Transfer Graph ──────────────────────────────────────────────

  db.insert(transferGraphs)
    .values({
      id: "graph-biolab-01",
      kernelId: KERNEL_ID,
      createdAt: "2026-02-15T10:00:00Z",
      updatedAt: now,
    })
    .run();

  // ── Transfer Nodes ──────────────────────────────────────────────

  db.insert(transferNodes)
    .values([
      {
        id: "node-staging",
        graphId: "graph-biolab-01",
        kernelId: KERNEL_ID,
        label: "Staging Area",
        nodeType: "staging",
        capabilities: ["receive", "store"],
        position: { x: 0, y: 2 },
      },
      {
        id: "node-liquid",
        graphId: "graph-biolab-01",
        kernelId: KERNEL_ID,
        deviceId: "dev-liquid-handler",
        label: "Liquid Handler",
        nodeType: "instrument",
        capabilities: ["aspirate", "dispense", "dilute"],
        position: { x: 1, y: 1 },
      },
      {
        id: "node-centrifuge",
        graphId: "graph-biolab-01",
        kernelId: KERNEL_ID,
        deviceId: "dev-centrifuge",
        label: "Centrifuge",
        nodeType: "instrument",
        capabilities: ["spin", "pellet", "separate"],
        position: { x: 2, y: 1 },
      },
      {
        id: "node-hplc",
        graphId: "graph-biolab-01",
        kernelId: KERNEL_ID,
        deviceId: "dev-hplc",
        label: "HPLC",
        nodeType: "instrument",
        capabilities: ["analyze", "separate", "quantify"],
        position: { x: 3, y: 1 },
      },
      {
        id: "node-inspect",
        graphId: "graph-biolab-01",
        kernelId: KERNEL_ID,
        label: "Inspection Station",
        nodeType: "station",
        capabilities: ["visual_inspect", "weigh", "label"],
        position: { x: 4, y: 2 },
      },
    ])
    .run();

  // ── Transfer Edges ──────────────────────────────────────────────

  db.insert(transferEdges)
    .values([
      {
        id: "edge-1",
        graphId: "graph-biolab-01",
        fromNodeId: "node-staging",
        toNodeId: "node-liquid",
        mechanism: "robot_arm",
        transferTimeMs: 5000,
        bidirectional: true,
      },
      {
        id: "edge-2",
        graphId: "graph-biolab-01",
        fromNodeId: "node-liquid",
        toNodeId: "node-centrifuge",
        mechanism: "robot_arm",
        transferTimeMs: 3000,
        bidirectional: true,
      },
      {
        id: "edge-3",
        graphId: "graph-biolab-01",
        fromNodeId: "node-centrifuge",
        toNodeId: "node-hplc",
        mechanism: "conveyor",
        transferTimeMs: 8000,
        bidirectional: false,
      },
      {
        id: "edge-4",
        graphId: "graph-biolab-01",
        fromNodeId: "node-hplc",
        toNodeId: "node-inspect",
        mechanism: "manual",
        transferTimeMs: 15000,
        bidirectional: false,
      },
    ])
    .run();

  // ── Samples ─────────────────────────────────────────────────────

  db.insert(samples)
    .values([
      {
        id: "samp-001",
        jobId: "job-bio-42",
        label: "Serum Panel A",
        labwareType: "plate",
        currentNodeId: "node-centrifuge",
        status: "processing",
        createdAt: "2026-03-10T07:55:00Z",
      },
      {
        id: "samp-002",
        jobId: "job-bio-42",
        label: "Serum Panel B",
        labwareType: "vial",
        currentNodeId: "node-liquid",
        status: "in_transit",
        createdAt: "2026-03-10T08:00:00Z",
      },
    ])
    .run();

  // ── Sample Movements ────────────────────────────────────────────

  db.insert(sampleMovements)
    .values([
      {
        id: "mov-001a",
        sampleId: "samp-001",
        fromNodeId: "node-staging",
        toNodeId: "node-liquid",
        mechanism: "robot_arm",
        startedAt: "2026-03-10T08:00:00Z",
        completedAt: "2026-03-10T08:00:05Z",
      },
      {
        id: "mov-001b",
        sampleId: "samp-001",
        fromNodeId: "node-liquid",
        toNodeId: "node-centrifuge",
        mechanism: "robot_arm",
        startedAt: "2026-03-10T08:15:00Z",
        completedAt: "2026-03-10T08:15:03Z",
      },
      {
        id: "mov-002a",
        sampleId: "samp-002",
        fromNodeId: "node-staging",
        toNodeId: "node-liquid",
        mechanism: "robot_arm",
        startedAt: "2026-03-10T08:05:00Z",
        completedAt: "2026-03-10T08:05:05Z",
      },
    ])
    .run();

  // ── Instrument Workflows ────────────────────────────────────────

  db.insert(instrumentWorkflows)
    .values({
      id: "wf-001",
      kernelId: KERNEL_ID,
      jobId: "job-bio-42",
      status: "running",
      startedAt: "2026-03-10T08:00:00Z",
    })
    .run();

  // ── Instrument Steps ────────────────────────────────────────────

  db.insert(instrumentSteps)
    .values([
      {
        id: "istep-1",
        workflowId: "wf-001",
        nodeId: "node-liquid",
        action: "dilute_and_dispense",
        params: { volume_ul: 200, dilution: "1:10" },
        estimatedDurationMs: 600000,
        requiredLabware: "plate",
        producesEvidence: true,
        dependsOn: [],
      },
      {
        id: "istep-2",
        workflowId: "wf-001",
        nodeId: "node-centrifuge",
        action: "spin_separate",
        params: { rpm: 12000, duration_min: 15, temperature_c: 4 },
        estimatedDurationMs: 900000,
        requiredLabware: "plate",
        producesEvidence: true,
        dependsOn: ["istep-1"],
      },
      {
        id: "istep-3",
        workflowId: "wf-001",
        nodeId: "node-hplc",
        action: "run_analysis",
        params: { method: "reverse_phase_c18", runtime_min: 30 },
        estimatedDurationMs: 1800000,
        requiredLabware: "vial",
        producesEvidence: true,
        dependsOn: ["istep-2"],
      },
    ])
    .run();

  // ── Resource Claims ─────────────────────────────────────────────

  db.insert(resourceClaims)
    .values([
      {
        id: "claim-001",
        nodeId: "node-centrifuge",
        claimedBy: "wf-001",
        claimedAt: "2026-03-10T08:14:00Z",
        expiresAt: "2026-03-10T08:45:00Z",
        released: false,
      },
      {
        id: "claim-002",
        nodeId: "node-liquid",
        claimedBy: "wf-001",
        claimedAt: "2026-03-10T08:00:00Z",
        released: true,
        releasedAt: "2026-03-10T08:14:00Z",
      },
    ])
    .run();
}
