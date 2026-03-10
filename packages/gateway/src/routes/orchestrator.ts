import type { FastifyInstance } from "fastify";
import type {
  TransferGraph,
  TransferNode,
  TransferEdge,
  Sample,
  SampleMovement,
  InstrumentWorkflow,
  InstrumentStep,
  ResourceClaim,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Mock Data — Biotech lab kernel topology
// ---------------------------------------------------------------------------

const KERNEL_ID = "kernel-biolab-01";
const now = new Date().toISOString();

const mockNodes: TransferNode[] = [
  { id: "node-staging", kernelId: KERNEL_ID, label: "Staging Area", nodeType: "staging", capabilities: ["receive", "store"], position: { x: 0, y: 2 } },
  { id: "node-liquid", kernelId: KERNEL_ID, deviceId: "dev-liquid-handler", label: "Liquid Handler", nodeType: "instrument", capabilities: ["aspirate", "dispense", "dilute"], position: { x: 1, y: 1 } },
  { id: "node-centrifuge", kernelId: KERNEL_ID, deviceId: "dev-centrifuge", label: "Centrifuge", nodeType: "instrument", capabilities: ["spin", "pellet", "separate"], position: { x: 2, y: 1 } },
  { id: "node-hplc", kernelId: KERNEL_ID, deviceId: "dev-hplc", label: "HPLC", nodeType: "instrument", capabilities: ["analyze", "separate", "quantify"], position: { x: 3, y: 1 } },
  { id: "node-inspect", kernelId: KERNEL_ID, label: "Inspection Station", nodeType: "station", capabilities: ["visual_inspect", "weigh", "label"], position: { x: 4, y: 2 } },
];

const mockEdges: TransferEdge[] = [
  { id: "edge-1", fromNode: "node-staging", toNode: "node-liquid", mechanism: "robot_arm", transferTimeMs: 5000, bidirectional: true },
  { id: "edge-2", fromNode: "node-liquid", toNode: "node-centrifuge", mechanism: "robot_arm", transferTimeMs: 3000, bidirectional: true },
  { id: "edge-3", fromNode: "node-centrifuge", toNode: "node-hplc", mechanism: "conveyor", transferTimeMs: 8000, bidirectional: false },
  { id: "edge-4", fromNode: "node-hplc", toNode: "node-inspect", mechanism: "manual", transferTimeMs: 15000, bidirectional: false },
];

const mockGraph: TransferGraph = {
  id: "graph-biolab-01",
  kernelId: KERNEL_ID,
  nodes: mockNodes,
  edges: mockEdges,
  createdAt: "2026-02-15T10:00:00Z",
  updatedAt: now,
};

const mockSamples: Sample[] = [
  {
    id: "samp-001",
    jobId: "job-bio-42",
    label: "Serum Panel A",
    labwareType: "plate",
    currentNodeId: "node-centrifuge",
    status: "processing",
    history: [
      { id: "mov-001a", sampleId: "samp-001", fromNodeId: "node-staging", toNodeId: "node-liquid", mechanism: "robot_arm", startedAt: "2026-03-10T08:00:00Z", completedAt: "2026-03-10T08:00:05Z" },
      { id: "mov-001b", sampleId: "samp-001", fromNodeId: "node-liquid", toNodeId: "node-centrifuge", mechanism: "robot_arm", startedAt: "2026-03-10T08:15:00Z", completedAt: "2026-03-10T08:15:03Z" },
    ],
    createdAt: "2026-03-10T07:55:00Z",
  },
  {
    id: "samp-002",
    jobId: "job-bio-42",
    label: "Serum Panel B",
    labwareType: "vial",
    currentNodeId: "node-liquid",
    status: "in_transit",
    history: [
      { id: "mov-002a", sampleId: "samp-002", fromNodeId: "node-staging", toNodeId: "node-liquid", mechanism: "robot_arm", startedAt: "2026-03-10T08:05:00Z", completedAt: "2026-03-10T08:05:05Z" },
    ],
    createdAt: "2026-03-10T08:00:00Z",
  },
];

const mockWorkflowSteps: InstrumentStep[] = [
  { id: "step-1", nodeId: "node-liquid", action: "dilute_and_dispense", params: { volume_ul: 200, dilution: "1:10" }, estimatedDurationMs: 600000, requiredLabware: "plate", producesEvidence: true, dependsOn: [] },
  { id: "step-2", nodeId: "node-centrifuge", action: "spin_separate", params: { rpm: 12000, duration_min: 15, temperature_c: 4 }, estimatedDurationMs: 900000, requiredLabware: "plate", producesEvidence: true, dependsOn: ["step-1"] },
  { id: "step-3", nodeId: "node-hplc", action: "run_analysis", params: { method: "reverse_phase_c18", runtime_min: 30 }, estimatedDurationMs: 1800000, requiredLabware: "vial", producesEvidence: true, dependsOn: ["step-2"] },
];

const mockWorkflows: InstrumentWorkflow[] = [
  {
    id: "wf-001",
    kernelId: KERNEL_ID,
    jobId: "job-bio-42",
    steps: mockWorkflowSteps,
    status: "running",
    startedAt: "2026-03-10T08:00:00Z",
  },
];

const mockClaims: ResourceClaim[] = [
  { id: "claim-001", nodeId: "node-centrifuge", claimedBy: "wf-001", claimedAt: "2026-03-10T08:14:00Z", expiresAt: "2026-03-10T08:45:00Z", released: false },
  { id: "claim-002", nodeId: "node-liquid", claimedBy: "wf-001", claimedAt: "2026-03-10T08:00:00Z", released: true, releasedAt: "2026-03-10T08:14:00Z" },
];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function orchestratorRoutes(app: FastifyInstance) {
  // --- Transfer Graphs ---

  app.get("/api/orchestrator/graphs", async () => {
    return { graphs: [mockGraph] };
  });

  app.get<{ Params: { kernelId: string } }>("/api/orchestrator/graphs/:kernelId", async (req) => {
    if (req.params.kernelId === mockGraph.kernelId) {
      return { graph: mockGraph };
    }
    return { error: "not_found" };
  });

  // --- Samples ---

  app.get<{ Querystring: { kernelId?: string; jobId?: string } }>(
    "/api/orchestrator/samples",
    async (req) => {
      let samples = [...mockSamples];
      if (req.query.jobId) {
        samples = samples.filter((s) => s.jobId === req.query.jobId);
      }
      // kernelId filter: match samples whose currentNodeId belongs to a node in that kernel
      if (req.query.kernelId) {
        const kernelNodeIds = mockNodes
          .filter((n) => n.kernelId === req.query.kernelId)
          .map((n) => n.id);
        samples = samples.filter((s) => kernelNodeIds.includes(s.currentNodeId));
      }
      return { samples };
    },
  );

  app.get<{ Params: { sampleId: string } }>("/api/orchestrator/samples/:sampleId", async (req) => {
    const sample = mockSamples.find((s) => s.id === req.params.sampleId);
    if (!sample) return { error: "not_found" };
    return { sample };
  });

  // --- Resource Claims ---

  app.get("/api/orchestrator/claims", async () => {
    return { claims: mockClaims.filter((c) => !c.released) };
  });

  // --- Instrument Workflows ---

  app.post("/api/orchestrator/workflows", async (req, reply) => {
    const body = (req.body ?? {}) as {
      kernelId?: string;
      jobId?: string;
      steps?: InstrumentStep[];
    };
    const id = `wf-${Date.now().toString(36)}`;
    return reply.code(202).send({
      accepted: true,
      workflowId: id,
      kernelId: body.kernelId ?? KERNEL_ID,
      jobId: body.jobId ?? "job-unknown",
      stepCount: body.steps?.length ?? 0,
    });
  });

  app.get<{ Querystring: { status?: string } }>(
    "/api/orchestrator/workflows",
    async (req) => {
      let workflows = [...mockWorkflows];
      if (req.query.status) {
        workflows = workflows.filter((w) => w.status === req.query.status);
      }
      return { workflows };
    },
  );

  app.get<{ Params: { workflowId: string } }>("/api/orchestrator/workflows/:workflowId", async (req) => {
    const workflow = mockWorkflows.find((w) => w.id === req.params.workflowId);
    if (!workflow) return { error: "not_found" };
    return { workflow };
  });
}
