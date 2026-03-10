import type { FastifyInstance } from "fastify";
import type {
  ProtocolTemplate,
  ProtocolStep,
  ProtocolTransfer,
  ProtocolParameter,
  ProtocolFork,
  ProtocolRun,
  ProtocolRunStep,
  ProtocolRunTransfer,
  AutomationStatus,
  TransferAgent,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Mock Data — Protocol system
// ---------------------------------------------------------------------------

const KERNEL_ID = "kernel-biolab-01";
const now = new Date().toISOString();

// ── Protocol Parameters ─────────────────────────────────────────

const bioassayParameters: ProtocolParameter[] = [
  {
    key: "sample_volume",
    label: "Sample Volume",
    description: "Volume of sample to process per well",
    type: "volume",
    required: true,
    group: "Sample Prep",
    defaultValue: 100,
    min: 10,
    max: 1000,
    step: 10,
    unit: "uL",
  },
  {
    key: "dilution_factor",
    label: "Dilution Factor",
    description: "Serial dilution factor for sample preparation",
    type: "enum",
    required: true,
    group: "Sample Prep",
    defaultValue: "2x",
    options: [
      { value: "1x", label: "1x (neat)", description: "No dilution" },
      { value: "2x", label: "2x", description: "1:2 dilution" },
      { value: "5x", label: "5x", description: "1:5 dilution" },
      { value: "10x", label: "10x", description: "1:10 dilution" },
    ],
  },
  {
    key: "gradient_duration_min",
    label: "HPLC Gradient Duration",
    description: "Duration of the HPLC gradient elution program",
    type: "number",
    required: true,
    group: "Analysis",
    defaultValue: 30,
    min: 10,
    max: 60,
    step: 5,
    unit: "min",
  },
  {
    key: "detection_wavelength_nm",
    label: "Detection Wavelength",
    description: "UV detector wavelength for protein absorbance",
    type: "number",
    required: true,
    group: "Analysis",
    defaultValue: 280,
    min: 190,
    max: 800,
    step: 1,
    unit: "nm",
  },
];

// ── Protocol Steps ──────────────────────────────────────────────

const bioassaySteps: ProtocolStep[] = [
  {
    id: "pstep-prep-001",
    capabilityType: "liquid-handler",
    label: "Sample Prep",
    action: "dilute_and_dispense",
    params: { technique: "serial_dilution", target_plate: "96_well_uv" },
    parameterBindings: [
      { stepParamKey: "volume_ul", protocolParamKey: "sample_volume" },
      { stepParamKey: "dilution", protocolParamKey: "dilution_factor" },
    ],
    estimatedDurationMs: 600_000,
    requiredLabware: "plate",
    producesEvidence: true,
    dependsOn: [],
    position: { x: 100, y: 200 },
    notes: "Dilute serum samples and dispense into 96-well UV-transparent plate.",
  },
  {
    id: "pstep-centri-002",
    capabilityType: "centrifuge",
    label: "Centrifugation",
    action: "spin_separate",
    params: { rpm: 12000, duration_min: 15, temperature_c: 4 },
    parameterBindings: [],
    estimatedDurationMs: 900_000,
    requiredLabware: "plate",
    producesEvidence: true,
    dependsOn: ["pstep-prep-001"],
    position: { x: 350, y: 200 },
    notes: "Spin-separate to pellet debris; supernatant used for HPLC analysis.",
  },
  {
    id: "pstep-hplc-003",
    capabilityType: "hplc",
    label: "HPLC Analysis",
    action: "gradient_elution",
    params: { column: "C18_reverse_phase", mobile_phase_a: "water_0.1pct_tfa", mobile_phase_b: "acetonitrile_0.1pct_tfa", flow_rate_ml_min: 1.0 },
    parameterBindings: [
      { stepParamKey: "gradient_time_min", protocolParamKey: "gradient_duration_min" },
      { stepParamKey: "wavelength_nm", protocolParamKey: "detection_wavelength_nm" },
    ],
    estimatedDurationMs: 1_800_000,
    requiredLabware: "vial",
    producesEvidence: true,
    dependsOn: ["pstep-centri-002"],
    position: { x: 600, y: 200 },
    notes: "Gradient elution with UV detection. Produces chromatogram evidence bundle.",
  },
  {
    id: "pstep-inspect-004",
    capabilityType: "quality-inspection",
    label: "Inspection",
    action: "visual_and_data_review",
    params: { check_chromatogram_baseline: true, check_retention_times: true, flag_anomalies: true },
    parameterBindings: [],
    estimatedDurationMs: 300_000,
    requiredLabware: "vial",
    producesEvidence: true,
    dependsOn: ["pstep-hplc-003"],
    position: { x: 850, y: 200 },
    notes: "Visual inspection and data review. Verify chromatogram quality and flag anomalies.",
  },
];

// ── Protocol Transfers ──────────────────────────────────────────

const bioassayTransfers: ProtocolTransfer[] = [
  {
    id: "ptx-001",
    fromStepId: "pstep-prep-001",
    toStepId: "pstep-centri-002",
    labwareType: "plate",
    constraints: { maxWeightKg: 0.5, orientationRequired: true, timeConstraintMs: 60_000 },
    preferredAutomationLevel: "teleoperated",
    notes: "Plate must remain level during transfer to avoid cross-contamination.",
  },
  {
    id: "ptx-002",
    fromStepId: "pstep-centri-002",
    toStepId: "pstep-hplc-003",
    labwareType: "vial",
    constraints: { maxWeightKg: 0.2, temperatureRange: { min: 2, max: 8, unit: "C" }, timeConstraintMs: 120_000 },
    preferredAutomationLevel: "vla_assisted",
    notes: "Supernatant transferred to HPLC vials. Keep cold to prevent protein degradation.",
  },
  {
    id: "ptx-003",
    fromStepId: "pstep-hplc-003",
    toStepId: "pstep-inspect-004",
    labwareType: "vial",
    constraints: { maxWeightKg: 0.2 },
    preferredAutomationLevel: "manual",
    notes: "Post-analysis vials moved to inspection station for visual and data review.",
  },
];

// ── Protocol Templates ──────────────────────────────────────────

const mockTemplates: ProtocolTemplate[] = [
  {
    id: "ptpl_bioassay001",
    name: "Serum Protein Analysis",
    description: "End-to-end serum protein characterization workflow. Samples are diluted, centrifuged to remove debris, analyzed by reverse-phase HPLC with UV detection, and then visually inspected with data quality review. Designed for R2D3-mediated sample transfers with progressive automation.",
    version: "1.2.0",
    authorId: "user_dr_chen",
    authorName: "Dr. Sarah Chen",
    status: "published",
    tags: ["biotech", "protein", "serum", "hplc", "quality-control"],
    requiredCapabilities: ["liquid-handler", "centrifuge", "hplc", "quality-inspection"],
    steps: bioassaySteps,
    transfers: bioassayTransfers,
    parameters: bioassayParameters,
    defaultValues: {
      sample_volume: 100,
      dilution_factor: "2x",
      gradient_duration_min: 30,
      detection_wavelength_nm: 280,
    },
    estimatedTotalDurationMs: 3_600_000,
    forkCount: 1,
    runCount: 7,
    rating: 4.6,
    createdAt: "2026-01-15T09:00:00Z",
    updatedAt: "2026-02-20T14:30:00Z",
  },
  {
    id: "ptpl_3dprint_qc001",
    name: "3D Print QC",
    description: "Basic two-step quality control protocol for 3D printed parts. Print the part, then inspect for dimensional accuracy and surface quality.",
    version: "0.1.0",
    authorId: "user_machinist_mike",
    authorName: "Mike Torres",
    status: "draft",
    tags: ["3d-print", "fdm", "quality-control"],
    requiredCapabilities: ["fdm-printer", "quality-inspection"],
    steps: [
      {
        id: "pstep-print-001",
        capabilityType: "fdm-printer",
        label: "3D Print",
        action: "print_part",
        params: { material: "PLA", layer_height_mm: 0.2, infill_pct: 20 },
        parameterBindings: [],
        estimatedDurationMs: 7_200_000,
        requiredLabware: "tray",
        producesEvidence: true,
        dependsOn: [],
        position: { x: 100, y: 200 },
        notes: "Print part from uploaded G-code. Monitor for layer adhesion and stringing.",
      },
      {
        id: "pstep-inspect-002",
        capabilityType: "quality-inspection",
        label: "Visual Inspection",
        action: "dimensional_check",
        params: { measure_tolerances: true, surface_quality_check: true },
        parameterBindings: [],
        estimatedDurationMs: 600_000,
        producesEvidence: true,
        dependsOn: ["pstep-print-001"],
        position: { x: 400, y: 200 },
        notes: "Measure dimensions against spec. Check surface quality and layer adhesion.",
      },
    ],
    transfers: [
      {
        id: "ptx-qc-001",
        fromStepId: "pstep-print-001",
        toStepId: "pstep-inspect-002",
        labwareType: "tray",
        constraints: { maxWeightKg: 2.0 },
        preferredAutomationLevel: "manual",
        notes: "Remove part from build plate and transfer to inspection station.",
      },
    ],
    parameters: [],
    defaultValues: {},
    estimatedTotalDurationMs: 7_800_000,
    forkCount: 0,
    runCount: 0,
    createdAt: "2026-03-01T11:00:00Z",
  },
];

// ── Protocol Fork ───────────────────────────────────────────────

const mockForks: ProtocolFork[] = [
  {
    id: "pfork_highvol_001",
    sourceTemplateId: "ptpl_bioassay001",
    sourceTemplateVersion: "1.2.0",
    forkedBy: "user_lab_tech_j",
    parameterOverrides: {
      sample_volume: 500,
      dilution_factor: "10x",
      gradient_duration_min: 45,
    },
    name: "Serum Protein Analysis — High Volume",
    notes: "Modified for high-volume serum samples requiring greater dilution and longer gradient for better peak resolution.",
    createdAt: "2026-02-25T16:00:00Z",
  },
];

// ── Protocol Run ────────────────────────────────────────────────

const mockRunSteps: ProtocolRunStep[] = [
  {
    id: "prs-001",
    protocolStepId: "pstep-prep-001",
    nodeId: "node-liquid",
    deviceId: "dev-liquid-handler",
    action: "dilute_and_dispense",
    resolvedParams: { volume_ul: 100, dilution: "2x", technique: "serial_dilution", target_plate: "96_well_uv" },
    actualDurationMs: 580_000,
    status: "completed",
    evidenceHash: "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    startedAt: "2026-03-10T08:00:00Z",
    completedAt: "2026-03-10T08:09:40Z",
  },
  {
    id: "prs-002",
    protocolStepId: "pstep-centri-002",
    nodeId: "node-centrifuge",
    deviceId: "dev-centrifuge",
    action: "spin_separate",
    resolvedParams: { rpm: 12000, duration_min: 15, temperature_c: 4 },
    actualDurationMs: 910_000,
    status: "completed",
    evidenceHash: "sha256:b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    startedAt: "2026-03-10T08:12:00Z",
    completedAt: "2026-03-10T08:27:10Z",
  },
  {
    id: "prs-003",
    protocolStepId: "pstep-hplc-003",
    nodeId: "node-hplc",
    deviceId: "dev-hplc",
    action: "gradient_elution",
    resolvedParams: { column: "C18_reverse_phase", mobile_phase_a: "water_0.1pct_tfa", mobile_phase_b: "acetonitrile_0.1pct_tfa", flow_rate_ml_min: 1.0, gradient_time_min: 30, wavelength_nm: 280 },
    status: "running",
    startedAt: "2026-03-10T08:30:00Z",
  },
  {
    id: "prs-004",
    protocolStepId: "pstep-inspect-004",
    nodeId: "node-inspect",
    action: "visual_and_data_review",
    resolvedParams: { check_chromatogram_baseline: true, check_retention_times: true, flag_anomalies: true },
    status: "pending",
  },
];

const mockRunTransfers: ProtocolRunTransfer[] = [
  {
    id: "prt-001",
    protocolTransferId: "ptx-001",
    fromNodeId: "node-liquid",
    toNodeId: "node-centrifuge",
    transferAgentId: "tagent-r2d3-alpha",
    automationLevel: "teleoperated",
    mechanism: "robot_arm",
    episodeRecorded: true,
    episodeId: "ep-transfer-001",
    status: "completed",
    startedAt: "2026-03-10T08:10:00Z",
    completedAt: "2026-03-10T08:11:45Z",
  },
  {
    id: "prt-002",
    protocolTransferId: "ptx-002",
    fromNodeId: "node-centrifuge",
    toNodeId: "node-hplc",
    transferAgentId: "tagent-r2d3-alpha",
    automationLevel: "teleoperated",
    mechanism: "robot_arm",
    episodeRecorded: true,
    episodeId: "ep-transfer-002",
    status: "completed",
    startedAt: "2026-03-10T08:28:00Z",
    completedAt: "2026-03-10T08:29:30Z",
  },
  {
    id: "prt-003",
    protocolTransferId: "ptx-003",
    fromNodeId: "node-hplc",
    toNodeId: "node-inspect",
    automationLevel: "manual",
    mechanism: "manual",
    episodeRecorded: false,
    status: "pending",
  },
];

const mockRuns: ProtocolRun[] = [
  {
    id: "prun_active_001",
    templateId: "ptpl_bioassay001",
    templateVersion: "1.2.0",
    kernelId: KERNEL_ID,
    jobId: "job-bio-42",
    parameterValues: {
      sample_volume: 100,
      dilution_factor: "2x",
      gradient_duration_min: 30,
      detection_wavelength_nm: 280,
    },
    steps: mockRunSteps,
    transfers: mockRunTransfers,
    status: "running",
    currentStepIndex: 2,
    initiatedBy: "user_dr_chen",
    sampleIds: ["samp-001", "samp-002"],
    startedAt: "2026-03-10T08:00:00Z",
    metadata: { batchLabel: "Batch-2026-03-10-A", priority: "normal" },
    createdAt: "2026-03-10T07:55:00Z",
  },
];

// ── Automation Statuses ─────────────────────────────────────────

const mockAutomationStatuses: AutomationStatus[] = [
  {
    id: "astatus-liq-centri",
    kernelId: KERNEL_ID,
    fromNodeId: "node-liquid",
    toNodeId: "node-centrifuge",
    transferAgentId: "tagent-r2d3-alpha",
    currentLevel: "manual",
    episodeCount: 5,
    minEpisodesForTraining: 50,
    advanceThreshold: 0.85,
    lastEpisodeAt: "2026-03-09T16:30:00Z",
    metadata: { labwareType: "plate", notes: "Collecting initial demonstration episodes" },
  },
  {
    id: "astatus-centri-hplc",
    kernelId: KERNEL_ID,
    fromNodeId: "node-centrifuge",
    toNodeId: "node-hplc",
    transferAgentId: "tagent-r2d3-alpha",
    currentLevel: "teleoperated",
    episodeCount: 45,
    minEpisodesForTraining: 50,
    vlaModelName: "SmolVLA",
    advanceThreshold: 0.90,
    lastEpisodeAt: "2026-03-10T08:29:30Z",
    metadata: { labwareType: "vial", notes: "Nearly enough episodes for VLA training" },
  },
];

// ── Transfer Agents ─────────────────────────────────────────────

const mockTransferAgents: TransferAgent[] = [
  {
    id: "tagent-r2d3-alpha",
    type: "robot",
    agentRef: "robot-r2d3-001",
    label: "R2D3-Alpha",
    capabilities: ["dual_arm", "gripper_eg2_4c2", "plate_handling", "vial_handling"],
    metadata: { serial: "R2D3-2026-0042", firmware: "v2.1.3", location: "Bay A" },
  },
  {
    id: "tagent-manual-op01",
    type: "human",
    agentRef: "user_lab_tech_j",
    label: "Manual Operator",
    capabilities: ["plate_handling", "vial_handling", "tray_handling", "visual_inspection"],
    metadata: { name: "Jamie Lin", certification: "BSL-2", shift: "day" },
  },
];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function protocolRoutes(app: FastifyInstance) {
  // ── Protocol Templates ──────────────────────────────────────────

  app.get<{ Querystring: { tags?: string; capabilities?: string; search?: string; status?: string } }>(
    "/api/protocols",
    async (req) => {
      let templates = [...mockTemplates];
      if (req.query.tags) {
        const tags = req.query.tags.split(",").map((t) => t.trim().toLowerCase());
        templates = templates.filter((t) => tags.some((tag) => t.tags.includes(tag)));
      }
      if (req.query.capabilities) {
        const caps = req.query.capabilities.split(",").map((c) => c.trim().toLowerCase());
        templates = templates.filter((t) => caps.some((cap) => t.requiredCapabilities.includes(cap)));
      }
      if (req.query.search) {
        const q = req.query.search.toLowerCase();
        templates = templates.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q) ||
            t.tags.some((tag) => tag.includes(q)),
        );
      }
      if (req.query.status) {
        templates = templates.filter((t) => t.status === req.query.status);
      }
      return { templates, total: templates.length };
    },
  );

  app.get<{ Params: { id: string } }>("/api/protocols/:id", async (req, reply) => {
    const template = mockTemplates.find((t) => t.id === req.params.id);
    if (!template) return reply.code(404).send({ error: "not_found", message: "Protocol template not found" });
    return { template };
  });

  app.post("/api/protocols", async (req, reply) => {
    const body = (req.body ?? {}) as Partial<ProtocolTemplate>;
    const id = `ptpl_${Date.now().toString(36)}`;
    return reply.code(201).send({
      created: true,
      id,
      name: body.name ?? "Untitled Protocol",
      status: "draft",
      createdAt: now,
    });
  });

  app.put<{ Params: { id: string } }>("/api/protocols/:id", async (req, reply) => {
    const template = mockTemplates.find((t) => t.id === req.params.id);
    if (!template) return reply.code(404).send({ error: "not_found", message: "Protocol template not found" });
    const body = (req.body ?? {}) as Partial<ProtocolTemplate>;
    return {
      updated: true,
      id: template.id,
      name: body.name ?? template.name,
      version: body.version ?? template.version,
      updatedAt: now,
    };
  });

  app.post<{ Params: { id: string } }>("/api/protocols/:id/publish", async (req, reply) => {
    const template = mockTemplates.find((t) => t.id === req.params.id);
    if (!template) return reply.code(404).send({ error: "not_found", message: "Protocol template not found" });
    if (template.status === "published") {
      return reply.code(409).send({ error: "already_published", message: "Template is already published" });
    }
    return {
      published: true,
      id: template.id,
      name: template.name,
      status: "published",
      publishedAt: now,
    };
  });

  app.post<{ Params: { id: string } }>("/api/protocols/:id/fork", async (req, reply) => {
    const template = mockTemplates.find((t) => t.id === req.params.id);
    if (!template) return reply.code(404).send({ error: "not_found", message: "Protocol template not found" });
    const body = (req.body ?? {}) as { name?: string; parameterOverrides?: Record<string, unknown> };
    const forkId = `pfork_${Date.now().toString(36)}`;
    return reply.code(201).send({
      created: true,
      forkId,
      sourceTemplateId: template.id,
      sourceTemplateVersion: template.version,
      name: body.name ?? `${template.name} (Fork)`,
      createdAt: now,
    });
  });

  app.get<{ Params: { id: string } }>("/api/protocols/:id/forks", async (req, reply) => {
    const template = mockTemplates.find((t) => t.id === req.params.id);
    if (!template) return reply.code(404).send({ error: "not_found", message: "Protocol template not found" });
    const forks = mockForks.filter((f) => f.sourceTemplateId === req.params.id);
    return { forks, total: forks.length };
  });

  // ── Protocol Runs ───────────────────────────────────────────────

  app.get<{ Params: { id: string } }>("/api/protocols/:id/runs", async (req, reply) => {
    const template = mockTemplates.find((t) => t.id === req.params.id);
    if (!template) return reply.code(404).send({ error: "not_found", message: "Protocol template not found" });
    const runs = mockRuns.filter((r) => r.templateId === req.params.id);
    return { runs, total: runs.length };
  });

  app.get<{ Querystring: { status?: string; kernelId?: string } }>(
    "/api/protocol-runs",
    async (req) => {
      let runs = [...mockRuns];
      if (req.query.status) {
        runs = runs.filter((r) => r.status === req.query.status);
      }
      if (req.query.kernelId) {
        runs = runs.filter((r) => r.kernelId === req.query.kernelId);
      }
      return { runs, total: runs.length };
    },
  );

  app.get<{ Params: { runId: string } }>("/api/protocol-runs/:runId", async (req, reply) => {
    const run = mockRuns.find((r) => r.id === req.params.runId);
    if (!run) return reply.code(404).send({ error: "not_found", message: "Protocol run not found" });
    return { run };
  });

  app.post<{ Params: { id: string } }>("/api/protocols/:id/runs", async (req, reply) => {
    const template = mockTemplates.find((t) => t.id === req.params.id);
    if (!template) return reply.code(404).send({ error: "not_found", message: "Protocol template not found" });
    const body = (req.body ?? {}) as { kernelId?: string; parameterValues?: Record<string, unknown>; sampleIds?: string[] };
    const runId = `prun_${Date.now().toString(36)}`;
    return reply.code(202).send({
      accepted: true,
      runId,
      templateId: template.id,
      templateVersion: template.version,
      kernelId: body.kernelId ?? KERNEL_ID,
      status: "binding",
      createdAt: now,
    });
  });

  app.post<{ Params: { runId: string } }>("/api/protocol-runs/:runId/start", async (req, reply) => {
    const run = mockRuns.find((r) => r.id === req.params.runId);
    if (!run) return reply.code(404).send({ error: "not_found", message: "Protocol run not found" });
    if (run.status !== "ready" && run.status !== "binding") {
      return reply.code(409).send({ error: "invalid_state", message: `Cannot start run in status '${run.status}'` });
    }
    return { started: true, runId: run.id, status: "running", startedAt: now };
  });

  app.post<{ Params: { runId: string } }>("/api/protocol-runs/:runId/pause", async (req, reply) => {
    const run = mockRuns.find((r) => r.id === req.params.runId);
    if (!run) return reply.code(404).send({ error: "not_found", message: "Protocol run not found" });
    if (run.status !== "running") {
      return reply.code(409).send({ error: "invalid_state", message: `Cannot pause run in status '${run.status}'` });
    }
    return { paused: true, runId: run.id, status: "paused", pausedAt: now };
  });

  app.post<{ Params: { runId: string } }>("/api/protocol-runs/:runId/resume", async (req, reply) => {
    const run = mockRuns.find((r) => r.id === req.params.runId);
    if (!run) return reply.code(404).send({ error: "not_found", message: "Protocol run not found" });
    if (run.status !== "paused") {
      return reply.code(409).send({ error: "invalid_state", message: `Cannot resume run in status '${run.status}'` });
    }
    return { resumed: true, runId: run.id, status: "running", resumedAt: now };
  });

  app.post<{ Params: { runId: string } }>("/api/protocol-runs/:runId/cancel", async (req, reply) => {
    const run = mockRuns.find((r) => r.id === req.params.runId);
    if (!run) return reply.code(404).send({ error: "not_found", message: "Protocol run not found" });
    if (run.status === "completed" || run.status === "cancelled") {
      return reply.code(409).send({ error: "invalid_state", message: `Cannot cancel run in status '${run.status}'` });
    }
    return { cancelled: true, runId: run.id, status: "cancelled", cancelledAt: now };
  });

  // ── Automation Status ───────────────────────────────────────────

  app.get<{ Querystring: { kernelId?: string } }>(
    "/api/automation-status",
    async (req) => {
      let statuses = [...mockAutomationStatuses];
      if (req.query.kernelId) {
        statuses = statuses.filter((s) => s.kernelId === req.query.kernelId);
      }
      return { statuses, total: statuses.length };
    },
  );

  app.get<{ Params: { fromNodeId: string; toNodeId: string } }>(
    "/api/automation-status/:fromNodeId/:toNodeId",
    async (req, reply) => {
      const status = mockAutomationStatuses.find(
        (s) => s.fromNodeId === req.params.fromNodeId && s.toNodeId === req.params.toNodeId,
      );
      if (!status) return reply.code(404).send({ error: "not_found", message: "Automation status not found for this transfer pair" });
      return { status };
    },
  );

  app.post<{ Params: { fromNodeId: string; toNodeId: string } }>(
    "/api/automation-status/:fromNodeId/:toNodeId/episode",
    async (req, reply) => {
      const status = mockAutomationStatuses.find(
        (s) => s.fromNodeId === req.params.fromNodeId && s.toNodeId === req.params.toNodeId,
      );
      if (!status) return reply.code(404).send({ error: "not_found", message: "Automation status not found for this transfer pair" });
      const body = (req.body ?? {}) as { episodeId?: string; success?: boolean };
      const newCount = status.episodeCount + 1;
      return {
        recorded: true,
        fromNodeId: status.fromNodeId,
        toNodeId: status.toNodeId,
        episodeCount: newCount,
        currentLevel: status.currentLevel,
        minEpisodesForTraining: status.minEpisodesForTraining,
        readyForTraining: newCount >= status.minEpisodesForTraining,
        recordedAt: now,
      };
    },
  );

  app.post<{ Params: { fromNodeId: string; toNodeId: string } }>(
    "/api/automation-status/:fromNodeId/:toNodeId/advance",
    async (req, reply) => {
      const status = mockAutomationStatuses.find(
        (s) => s.fromNodeId === req.params.fromNodeId && s.toNodeId === req.params.toNodeId,
      );
      if (!status) return reply.code(404).send({ error: "not_found", message: "Automation status not found for this transfer pair" });
      const levels: string[] = ["manual", "teleoperated", "pilot_operated", "vla_assisted", "fully_autonomous"];
      const currentIndex = levels.indexOf(status.currentLevel);
      if (currentIndex === -1 || currentIndex >= levels.length - 1) {
        return reply.code(409).send({ error: "cannot_advance", message: `Already at highest automation level '${status.currentLevel}'` });
      }
      const nextLevel = levels[currentIndex + 1];
      return {
        advanced: true,
        fromNodeId: status.fromNodeId,
        toNodeId: status.toNodeId,
        previousLevel: status.currentLevel,
        newLevel: nextLevel,
        advancedAt: now,
      };
    },
  );

  // ── Transfer Agents ─────────────────────────────────────────────

  app.get<{ Querystring: { kernelId?: string } }>(
    "/api/transfer-agents",
    async (_req) => {
      return { agents: mockTransferAgents, total: mockTransferAgents.length };
    },
  );

  // ── Validation ──────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>("/api/protocols/:id/validate", async (req, reply) => {
    const template = mockTemplates.find((t) => t.id === req.params.id);
    if (!template) return reply.code(404).send({ error: "not_found", message: "Protocol template not found" });
    const body = (req.body ?? {}) as { kernelId?: string };
    const kernelId = body.kernelId ?? KERNEL_ID;

    // Mock validation: check capabilities against kernel
    const missingCapabilities: string[] = [];
    const availableCapabilities = ["liquid-handler", "centrifuge", "hplc", "quality-inspection", "fdm-printer"];
    for (const cap of template.requiredCapabilities) {
      if (!availableCapabilities.includes(cap)) {
        missingCapabilities.push(cap);
      }
    }

    const transferWarnings: Array<{ transferId: string; warning: string }> = [];
    for (const transfer of template.transfers) {
      if (transfer.preferredAutomationLevel === "vla_assisted") {
        const automationStatus = mockAutomationStatuses.find(
          (s) =>
            s.fromNodeId ===
              `node-${template.steps.find((st) => st.id === transfer.fromStepId)?.capabilityType?.replace("-", "")}` &&
            s.toNodeId ===
              `node-${template.steps.find((st) => st.id === transfer.toStepId)?.capabilityType?.replace("-", "")}`,
        );
        if (!automationStatus || automationStatus.episodeCount < automationStatus.minEpisodesForTraining) {
          transferWarnings.push({
            transferId: transfer.id,
            warning: `Preferred automation level 'vla_assisted' not yet available; insufficient training episodes. Will fall back to 'teleoperated'.`,
          });
        }
      }
    }

    return {
      valid: missingCapabilities.length === 0,
      templateId: template.id,
      kernelId,
      missingCapabilities,
      transferWarnings,
      stepCount: template.steps.length,
      transferCount: template.transfers.length,
      estimatedDurationMs: template.estimatedTotalDurationMs,
      validatedAt: now,
    };
  });
}
