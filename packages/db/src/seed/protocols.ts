import type { StoreDB } from "../connection.js";
import {
  protocolTemplates,
  protocolSteps,
  protocolTransfers,
  protocolForks,
  protocolRuns,
  protocolRunSteps,
  protocolRunTransfers,
  automationStatuses,
  transferAgents,
} from "../schema/index.js";

const KERNEL_ID = "kernel-biolab-01";

/**
 * Seeds protocol templates, runs, automation statuses, and transfer agents.
 */
export function seedProtocols(db: StoreDB): void {
  // ── Protocol Templates ──────────────────────────────────────────

  db.insert(protocolTemplates)
    .values([
      {
        id: "ptpl_bioassay001",
        name: "Serum Protein Analysis",
        description:
          "End-to-end serum protein characterization workflow. Samples are diluted, centrifuged to remove debris, analyzed by reverse-phase HPLC with UV detection, and then visually inspected with data quality review. Designed for R2D3-mediated sample transfers with progressive automation.",
        version: "1.2.0",
        authorId: "user_dr_chen",
        authorName: "Dr. Sarah Chen",
        status: "published",
        tags: ["biotech", "protein", "serum", "hplc", "quality-control"],
        requiredCapabilities: ["liquid-handler", "centrifuge", "hplc", "quality-inspection"],
        parameters: [
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
        ],
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
        description:
          "Basic two-step quality control protocol for 3D printed parts. Print the part, then inspect for dimensional accuracy and surface quality.",
        version: "0.1.0",
        authorId: "user_machinist_mike",
        authorName: "Mike Torres",
        status: "draft",
        tags: ["3d-print", "fdm", "quality-control"],
        requiredCapabilities: ["fdm-printer", "quality-inspection"],
        parameters: [],
        defaultValues: {},
        estimatedTotalDurationMs: 7_800_000,
        forkCount: 0,
        runCount: 0,
        createdAt: "2026-03-01T11:00:00Z",
      },
    ])
    .run();

  // ── Protocol Steps ──────────────────────────────────────────────

  db.insert(protocolSteps)
    .values([
      // Bioassay steps
      {
        id: "pstep-prep-001",
        templateId: "ptpl_bioassay001",
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
        templateId: "ptpl_bioassay001",
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
        templateId: "ptpl_bioassay001",
        capabilityType: "hplc",
        label: "HPLC Analysis",
        action: "gradient_elution",
        params: {
          column: "C18_reverse_phase",
          mobile_phase_a: "water_0.1pct_tfa",
          mobile_phase_b: "acetonitrile_0.1pct_tfa",
          flow_rate_ml_min: 1.0,
        },
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
        templateId: "ptpl_bioassay001",
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
      // 3D Print QC steps
      {
        id: "pstep-print-001",
        templateId: "ptpl_3dprint_qc001",
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
        templateId: "ptpl_3dprint_qc001",
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
    ])
    .run();

  // ── Protocol Transfers ──────────────────────────────────────────

  db.insert(protocolTransfers)
    .values([
      // Bioassay transfers
      {
        id: "ptx-001",
        templateId: "ptpl_bioassay001",
        fromStepId: "pstep-prep-001",
        toStepId: "pstep-centri-002",
        labwareType: "plate",
        constraints: { maxWeightKg: 0.5, orientationRequired: true, timeConstraintMs: 60_000 },
        preferredAutomationLevel: "teleoperated",
        notes: "Plate must remain level during transfer to avoid cross-contamination.",
      },
      {
        id: "ptx-002",
        templateId: "ptpl_bioassay001",
        fromStepId: "pstep-centri-002",
        toStepId: "pstep-hplc-003",
        labwareType: "vial",
        constraints: {
          maxWeightKg: 0.2,
          temperatureRange: { min: 2, max: 8, unit: "C" },
          timeConstraintMs: 120_000,
        },
        preferredAutomationLevel: "vla_assisted",
        notes: "Supernatant transferred to HPLC vials. Keep cold to prevent protein degradation.",
      },
      {
        id: "ptx-003",
        templateId: "ptpl_bioassay001",
        fromStepId: "pstep-hplc-003",
        toStepId: "pstep-inspect-004",
        labwareType: "vial",
        constraints: { maxWeightKg: 0.2 },
        preferredAutomationLevel: "manual",
        notes: "Post-analysis vials moved to inspection station for visual and data review.",
      },
      // 3D Print QC transfer
      {
        id: "ptx-qc-001",
        templateId: "ptpl_3dprint_qc001",
        fromStepId: "pstep-print-001",
        toStepId: "pstep-inspect-002",
        labwareType: "tray",
        constraints: { maxWeightKg: 2.0 },
        preferredAutomationLevel: "manual",
        notes: "Remove part from build plate and transfer to inspection station.",
      },
    ])
    .run();

  // ── Protocol Forks ──────────────────────────────────────────────

  db.insert(protocolForks)
    .values({
      id: "pfork_highvol_001",
      sourceTemplateId: "ptpl_bioassay001",
      sourceTemplateVersion: "1.2.0",
      forkedBy: "user_lab_tech_j",
      parameterOverrides: {
        sample_volume: 500,
        dilution_factor: "10x",
        gradient_duration_min: 45,
      },
      name: "Serum Protein Analysis \u2014 High Volume",
      notes: "Modified for high-volume serum samples requiring greater dilution and longer gradient for better peak resolution.",
      createdAt: "2026-02-25T16:00:00Z",
    })
    .run();

  // ── Protocol Runs ───────────────────────────────────────────────

  db.insert(protocolRuns)
    .values({
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
      status: "running",
      currentStepIndex: 2,
      initiatedBy: "user_dr_chen",
      sampleIds: ["samp-001", "samp-002"],
      startedAt: "2026-03-10T08:00:00Z",
      metadata: { batchLabel: "Batch-2026-03-10-A", priority: "normal" },
      createdAt: "2026-03-10T07:55:00Z",
    })
    .run();

  // ── Protocol Run Steps ──────────────────────────────────────────

  db.insert(protocolRunSteps)
    .values([
      {
        id: "prs-001",
        runId: "prun_active_001",
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
        runId: "prun_active_001",
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
        runId: "prun_active_001",
        protocolStepId: "pstep-hplc-003",
        nodeId: "node-hplc",
        deviceId: "dev-hplc",
        action: "gradient_elution",
        resolvedParams: {
          column: "C18_reverse_phase",
          mobile_phase_a: "water_0.1pct_tfa",
          mobile_phase_b: "acetonitrile_0.1pct_tfa",
          flow_rate_ml_min: 1.0,
          gradient_time_min: 30,
          wavelength_nm: 280,
        },
        status: "running",
        startedAt: "2026-03-10T08:30:00Z",
      },
      {
        id: "prs-004",
        runId: "prun_active_001",
        protocolStepId: "pstep-inspect-004",
        nodeId: "node-inspect",
        action: "visual_and_data_review",
        resolvedParams: { check_chromatogram_baseline: true, check_retention_times: true, flag_anomalies: true },
        status: "pending",
      },
    ])
    .run();

  // ── Protocol Run Transfers ──────────────────────────────────────

  db.insert(protocolRunTransfers)
    .values([
      {
        id: "prt-001",
        runId: "prun_active_001",
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
        runId: "prun_active_001",
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
        runId: "prun_active_001",
        protocolTransferId: "ptx-003",
        fromNodeId: "node-hplc",
        toNodeId: "node-inspect",
        automationLevel: "manual",
        mechanism: "manual",
        episodeRecorded: false,
        status: "pending",
      },
    ])
    .run();

  // ── Automation Statuses ─────────────────────────────────────────

  db.insert(automationStatuses)
    .values([
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
        advanceThreshold: 0.9,
        lastEpisodeAt: "2026-03-10T08:29:30Z",
        metadata: { labwareType: "vial", notes: "Nearly enough episodes for VLA training" },
      },
    ])
    .run();

  // ── Transfer Agents ─────────────────────────────────────────────

  db.insert(transferAgents)
    .values([
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
    ])
    .run();
}
