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
import { isDemoRoutesOn, markDemo } from "../config/demo-routes.js";

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
// Demo gate (board N34, the server side of PX-3)
// ---------------------------------------------------------------------------
//
// Every route in this plugin answers from the fixtures above: one made-up lab kernel
// ("kernel-biolab-01") with five instruments, two samples, a running workflow and its
// resource claims. Nothing is read from the kernels, devices or jobs this gateway records.
// GET /graphs/:kernelId answered { error: "not_found" } with HTTP 200 for every real
// kernel, and POST /workflows said accepted: true and recorded nothing. Served as live
// data, that is plausible fiction. So outside demo mode the WHOLE plugin fails closed: the
// onRequest hook in orchestratorRoutes answers 501 not_available before the body is parsed
// and before any handler runs, so nothing is read from a fixture or accepted. A route added
// to this plugin later is refused by default. Both hooks are encapsulated: server.ts
// registers this plugin with app.register and no fastify-plugin wrapper, so no other
// plugin sees them, including the other /api/orchestrator/* plugins (the template
// directory and the data-product session routes).
//
// With PCC_DEMO_ROUTES=true the fixtures are served as before, and every response says
// so: the x-pcc-demo: true header, plus mock: true, demo: true on object bodies.

const DEMO_HEADER = "x-pcc-demo";

const exampleOnly = (what: string) =>
  `${what} is not recorded on this gateway, so nothing is returned rather than an example.`;

/**
 * The refusal for each route, keyed "METHOD /pattern" as registered (HEAD answers as GET).
 * `see` lists real routes on this gateway that hold the real version of the data, if any.
 */
const REFUSALS: Record<string, { message: string; see: string[] }> = {
  "GET /api/orchestrator/graphs": {
    message: exampleOnly("Instrument transfer-graph data"),
    see: ["GET /api/kernels", "GET /api/kernels/:kernelId/devices"],
  },
  "GET /api/orchestrator/graphs/:kernelId": {
    message: exampleOnly("Instrument transfer-graph data"),
    see: ["GET /api/kernels/:kernelId/devices"],
  },
  "GET /api/orchestrator/samples": { message: exampleOnly("Sample location and movement data"), see: [] },
  "GET /api/orchestrator/samples/:sampleId": { message: exampleOnly("Sample location and movement data"), see: [] },
  "GET /api/orchestrator/claims": { message: exampleOnly("Instrument resource-claim data"), see: [] },
  "POST /api/orchestrator/workflows": {
    message: "Instrument workflow data is not recorded on this gateway, so no workflow was accepted or started.",
    see: ["POST /api/jobs/submit"],
  },
  "GET /api/orchestrator/workflows": { message: exampleOnly("Instrument workflow data"), see: ["GET /api/jobs"] },
  "GET /api/orchestrator/workflows/:workflowId": {
    message: exampleOnly("Instrument workflow data"),
    see: ["GET /api/jobs/:jobId"],
  },
};
/** For a route added later without its own line above: still refused, never served. */
const FALLBACK_REFUSAL = { message: exampleOnly("Instrument orchestration data"), see: [] as string[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function orchestratorRoutes(app: FastifyInstance) {
  // Demo gate (see above). Refuses before parsing, so nothing below runs outside demo mode.
  app.addHook("onRequest", async (req, reply) => {
    if (isDemoRoutesOn()) {
      reply.header(DEMO_HEADER, "true");
      return;
    }
    const method = req.method === "HEAD" ? "GET" : req.method;
    const refusal = REFUSALS[`${method} ${req.routeOptions.url ?? ""}`] ?? FALLBACK_REFUSAL;
    return reply.code(501).send({ error: "not_available", message: refusal.message, see: refusal.see });
  });
  // A demo response's object body says so too; the header above covers any other shape.
  app.addHook("preSerialization", async (_req, reply, payload: unknown) =>
    reply.getHeader(DEMO_HEADER) === "true" && isPlainObject(payload) ? markDemo("demo", payload) : payload,
  );

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
