/**
 * Protocol E2E Simulation
 *
 * Demonstrates the protocol system for multi-instrument workflows:
 *
 *   1. Create a ProtocolTemplate ("Serum Protein Analysis" with 4 steps)
 *   2. Register instruments in a kernel with transfer graph
 *   3. Bind template to real instruments via ProtocolEngine
 *   4. Execute the ProtocolRun through ProtocolRunner
 *   5. Track automation level progression (manual -> episodes -> VLA assisted)
 *   6. Fork the protocol (user customizes a published protocol)
 *
 * Run: npx tsx scripts/protocol-e2e-simulation.ts
 */

import {
  TransferGraphBuilder,
  ResourcePool,
  SampleTracker,
  IntraKernelOrchestrator,
  AutomationTracker,
  ProtocolEngine,
  ProtocolRunner,
  registerProtocolTemplate,
  getProtocolTemplate,
  searchProtocolTemplates,
  clearProtocolTemplates,
} from "@pcc/orchestrator";

import type {
  ProtocolTemplate,
  ProtocolStep,
  ProtocolTransfer,
  ProtocolFork,
  ProtocolEvent,
  TransferNode,
  TransferEdge,
} from "@pcc/spec";
import { ids } from "@pcc/spec";

// ── Styling ─────────────────────────────────────────────────────────

const DIVIDER = "\x1b[90m" + "═".repeat(72) + "\x1b[0m";
const SECTION = "\x1b[90m" + "─".repeat(72) + "\x1b[0m";

const COLORS: Record<string, string> = {
  SETUP:      "\x1b[35m",   // magenta
  TEMPLATE:   "\x1b[34m",   // blue
  ENGINE:     "\x1b[33m",   // yellow
  RUNNER:     "\x1b[32m",   // green
  AUTOMATION: "\x1b[36m",   // cyan
  FORK:       "\x1b[91m",   // bright red
  SYSTEM:     "\x1b[90m",   // gray
  SUCCESS:    "\x1b[92m",   // bright green
};

function log(section: string, msg: string) {
  const c = COLORS[section] ?? "\x1b[0m";
  console.log(`${c}[${section.padEnd(12)}]\x1b[0m ${msg}`);
}

function heading(title: string) {
  console.log(`\n${SECTION}`);
  console.log(`  \x1b[1m${title}\x1b[0m`);
  console.log(SECTION);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + DIVIDER);
  console.log("  \x1b[1mPHYSICAL CAPABILITY CLOUD — Protocol E2E Simulation\x1b[0m");
  console.log("  Multi-instrument workflow with progressive automation");
  console.log(DIVIDER);

  const KERNEL_ID = "kernel_biolab_001";
  let artifactCount = 0;

  // ══════════════════════════════════════════════════════════════════
  // PHASE 1: Setup kernel instruments & transfer graph
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 1: Setup Lab Kernel — Instruments & Transfer Graph");

  const graphBuilder = new TransferGraphBuilder();

  // Add instrument nodes
  const liquidHandler = graphBuilder.addNode({
    kernelId: KERNEL_ID,
    deviceId: "dev_liquid_handler_01",
    label: "Hamilton STAR Liquid Handler",
    nodeType: "instrument",
    capabilities: ["liquid_handling", "sample_prep", "dilution"],
    position: { x: 0, y: 0 },
  });
  log("SETUP", `Node: ${liquidHandler.label} [${liquidHandler.capabilities.join(", ")}]`);

  const centrifuge = graphBuilder.addNode({
    kernelId: KERNEL_ID,
    deviceId: "dev_centrifuge_01",
    label: "Beckman Optima Ultracentrifuge",
    nodeType: "instrument",
    capabilities: ["centrifugation", "spin_separation"],
    position: { x: 2, y: 0 },
  });
  log("SETUP", `Node: ${centrifuge.label} [${centrifuge.capabilities.join(", ")}]`);

  const hplc = graphBuilder.addNode({
    kernelId: KERNEL_ID,
    deviceId: "dev_hplc_01",
    label: "Agilent 1290 Infinity II HPLC",
    nodeType: "instrument",
    capabilities: ["chromatography", "protein_analysis", "hplc"],
    position: { x: 4, y: 0 },
  });
  log("SETUP", `Node: ${hplc.label} [${hplc.capabilities.join(", ")}]`);

  const spectrometer = graphBuilder.addNode({
    kernelId: KERNEL_ID,
    deviceId: "dev_spec_01",
    label: "Thermo NanoDrop UV-Vis Spectrometer",
    nodeType: "instrument",
    capabilities: ["spectroscopy", "uv_vis", "concentration_measurement"],
    position: { x: 6, y: 0 },
  });
  log("SETUP", `Node: ${spectrometer.label} [${spectrometer.capabilities.join(", ")}]`);

  const staging = graphBuilder.addNode({
    kernelId: KERNEL_ID,
    label: "Central Staging Area",
    nodeType: "staging",
    capabilities: [],
    position: { x: 3, y: 2 },
  });
  log("SETUP", `Node: ${staging.label} (staging)`);

  // Add transfer edges (robot-mediated transfers via staging)
  const edges: TransferEdge[] = [];
  for (const node of [liquidHandler, centrifuge, hplc, spectrometer]) {
    const edge = graphBuilder.addEdge({
      fromNode: node.id,
      toNode: staging.id,
      mechanism: "robot_arm",
      transferTimeMs: 15000,
      bidirectional: true,
    });
    edges.push(edge);
  }
  log("SETUP", `Edges: ${edges.length} bidirectional robot-arm transfers via staging`);

  const graph = graphBuilder.build(KERNEL_ID);
  const validation = graphBuilder.validate();
  log("SETUP", `Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, valid=${validation.valid}`);
  artifactCount += graph.nodes.length + graph.edges.length;

  // ══════════════════════════════════════════════════════════════════
  // PHASE 2: Create Protocol Template
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 2: Create Protocol Template — Serum Protein Analysis");

  clearProtocolTemplates();

  const step1Id = ids.protocolStep();
  const step2Id = ids.protocolStep();
  const step3Id = ids.protocolStep();
  const step4Id = ids.protocolStep();

  const template: ProtocolTemplate = {
    id: ids.protocolTemplate(),
    name: "Serum Protein Analysis — SEC-HPLC",
    description:
      "Size-exclusion chromatography analysis of serum proteins. " +
      "Dilute sample, spin to remove particulates, run SEC-HPLC, " +
      "quantify total protein by UV-Vis.",
    version: "1.0.0",
    authorId: "author_biolab_protocol_team",
    authorName: "BioLab Protocol Team",
    status: "published",
    tags: ["protein", "serum", "sec-hplc", "clinical", "bioanalysis"],
    requiredCapabilities: [
      "liquid_handling",
      "centrifugation",
      "chromatography",
      "spectroscopy",
    ],
    steps: [
      {
        id: step1Id,
        capabilityType: "liquid_handling",
        label: "Sample Dilution",
        action: "dilute_and_dispense",
        params: { bufferType: "PBS", targetVolumeMl: 0.5 },
        parameterBindings: [
          { stepParamKey: "dilutionFactor", protocolParamKey: "dilution_ratio" },
        ],
        estimatedDurationMs: 120_000,
        requiredLabware: "plate",
        producesEvidence: true,
        dependsOn: [],
        notes: "Dilute serum sample in PBS to working concentration",
      },
      {
        id: step2Id,
        capabilityType: "centrifugation",
        label: "Clarification Spin",
        action: "spin_separate",
        params: { mode: "clarification" },
        parameterBindings: [
          { stepParamKey: "rpmTarget", protocolParamKey: "centrifuge_rpm" },
          { stepParamKey: "durationMin", protocolParamKey: "spin_time_min" },
        ],
        estimatedDurationMs: 600_000,
        requiredLabware: "tube",
        producesEvidence: true,
        dependsOn: [step1Id],
        notes: "Remove particulates and cell debris",
      },
      {
        id: step3Id,
        capabilityType: "chromatography",
        label: "SEC-HPLC Run",
        action: "run_chromatography",
        params: {
          columnType: "SEC",
          mobilePhase: "PBS pH 7.4",
          flowRateMlPerMin: 0.35,
        },
        parameterBindings: [
          { stepParamKey: "injectionVolumeUl", protocolParamKey: "injection_volume_ul" },
          { stepParamKey: "runTimeMi", protocolParamKey: "run_time_min" },
        ],
        estimatedDurationMs: 1_800_000,
        requiredLabware: "vial",
        producesEvidence: true,
        dependsOn: [step2Id],
        notes: "Size-exclusion chromatography with UV detection at 280nm",
      },
      {
        id: step4Id,
        capabilityType: "spectroscopy",
        label: "UV-Vis Quantification",
        action: "measure_absorbance",
        params: { wavelengthNm: 280, pathlengthMm: 1.0 },
        parameterBindings: [],
        estimatedDurationMs: 30_000,
        requiredLabware: "plate",
        producesEvidence: true,
        dependsOn: [step2Id],
        notes: "Independent total protein quantification via UV-Vis A280",
      },
    ],
    transfers: [
      {
        id: ids.protocolTransfer(),
        fromStepId: step1Id,
        toStepId: step2Id,
        labwareType: "tube",
        constraints: { maxWeightKg: 0.5, temperatureRange: { min: 2, max: 8, unit: "C" } },
        preferredAutomationLevel: "manual",
        notes: "Transfer diluted sample to centrifuge tubes",
      },
      {
        id: ids.protocolTransfer(),
        fromStepId: step2Id,
        toStepId: step3Id,
        labwareType: "vial",
        constraints: { timeConstraintMs: 300_000 },
        preferredAutomationLevel: "manual",
        notes: "Transfer clarified supernatant to HPLC vial",
      },
      {
        id: ids.protocolTransfer(),
        fromStepId: step2Id,
        toStepId: step4Id,
        labwareType: "plate",
        preferredAutomationLevel: "manual",
        notes: "Aliquot supernatant to UV-Vis plate",
      },
    ],
    parameters: [
      {
        key: "dilution_ratio",
        label: "Dilution Ratio",
        description: "Serum dilution factor (e.g. 10 = 1:10 dilution)",
        type: "number",
        required: true,
        group: "Sample Prep",
        defaultValue: 10,
        min: 2,
        max: 100,
        step: 1,
        unit: "x",
      },
      {
        key: "centrifuge_rpm",
        label: "Centrifuge Speed",
        description: "RPM for clarification spin",
        type: "number",
        required: true,
        group: "Centrifugation",
        defaultValue: 14000,
        min: 1000,
        max: 100000,
        step: 500,
        unit: "rpm",
      },
      {
        key: "spin_time_min",
        label: "Spin Duration",
        description: "Duration of centrifugation",
        type: "number",
        required: true,
        group: "Centrifugation",
        defaultValue: 10,
        min: 1,
        max: 60,
        step: 1,
        unit: "min",
      },
      {
        key: "injection_volume_ul",
        label: "Injection Volume",
        description: "Volume injected onto HPLC column",
        type: "number",
        required: true,
        group: "Chromatography",
        defaultValue: 20,
        min: 1,
        max: 100,
        step: 1,
        unit: "uL",
      },
      {
        key: "run_time_min",
        label: "HPLC Run Time",
        description: "Total chromatography run time",
        type: "number",
        required: true,
        group: "Chromatography",
        defaultValue: 30,
        min: 5,
        max: 120,
        step: 5,
        unit: "min",
      },
    ],
    defaultValues: {
      dilution_ratio: 10,
      centrifuge_rpm: 14000,
      spin_time_min: 10,
      injection_volume_ul: 20,
      run_time_min: 30,
    },
    estimatedTotalDurationMs: 2_550_000,
    forkCount: 0,
    runCount: 0,
    rating: 4.8,
    createdAt: new Date().toISOString(),
  };

  registerProtocolTemplate(template);
  artifactCount++;

  log("TEMPLATE", `Created: "${template.name}" (${template.id})`);
  log("TEMPLATE", `  Version: ${template.version} | Status: ${template.status}`);
  log("TEMPLATE", `  Steps: ${template.steps.length}`);
  for (const step of template.steps) {
    const deps = step.dependsOn.length > 0 ? ` (after ${step.dependsOn.length} dep)` : " (root)";
    log("TEMPLATE", `    ${step.label}: ${step.capabilityType}${deps}`);
  }
  log("TEMPLATE", `  Transfers: ${template.transfers.length}`);
  log("TEMPLATE", `  Parameters: ${template.parameters.length}`);
  for (const param of template.parameters) {
    log("TEMPLATE", `    ${param.label}: ${param.type} [${param.min}-${param.max} ${param.unit}] default=${param.defaultValue}`);
  }
  log("TEMPLATE", `  Tags: ${template.tags.join(", ")}`);

  // Search for the template
  const searchResults = searchProtocolTemplates({ capabilities: ["chromatography"] });
  log("TEMPLATE", `Search "chromatography": found ${searchResults.length} template(s)`);

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3: Bind protocol to kernel instruments
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 3: Bind Protocol to Kernel Instruments");

  const pool = new ResourcePool();
  const automationTracker = new AutomationTracker();

  // Register automation statuses for each transfer pair
  const robotAgentId = ids.transferAgent();
  for (const edge of graph.edges) {
    automationTracker.register(
      KERNEL_ID,
      edge.fromNode,
      edge.toNode,
      robotAgentId,
      "manual",
    );
  }
  log("ENGINE", `Registered ${graph.edges.length} transfer automation statuses (all "manual")`);

  const engine = new ProtocolEngine(graphBuilder, pool, automationTracker);

  // Validate binding first
  const bindingCheck = engine.validateBinding(template);
  log("ENGINE", `Validation: valid=${bindingCheck.valid}`);
  if (bindingCheck.warnings.length > 0) {
    for (const w of bindingCheck.warnings) {
      log("ENGINE", `  Warning: ${w}`);
    }
  }
  if (bindingCheck.errors.length > 0) {
    for (const e of bindingCheck.errors) {
      log("ENGINE", `  Error: ${e}`);
    }
    process.exit(1);
  }

  // Bind with user-selected parameter values
  const parameterValues = {
    dilution_ratio: 20,       // 1:20 instead of default 1:10
    centrifuge_rpm: 16000,    // Higher speed
    spin_time_min: 15,        // Longer spin
    injection_volume_ul: 10,  // Smaller injection
    run_time_min: 45,         // Longer run for better separation
  };

  const run = engine.bindProtocol(
    template,
    KERNEL_ID,
    parameterValues,
    "user_researcher_001",
  );
  artifactCount++;

  log("ENGINE", `Protocol Run created: ${run.id}`);
  log("ENGINE", `  Status: ${run.status}`);
  log("ENGINE", `  Steps bound to instruments:`);
  for (const runStep of run.steps) {
    const templateStep = template.steps.find((s) => s.id === runStep.protocolStepId);
    const node = graphBuilder.getNode(runStep.nodeId);
    log("ENGINE", `    ${templateStep?.label ?? runStep.action} -> ${node?.label ?? runStep.nodeId}`);
    log("ENGINE", `      Params: ${JSON.stringify(runStep.resolvedParams)}`);
  }
  log("ENGINE", `  Transfers:`);
  for (const transfer of run.transfers) {
    const fromNode = graphBuilder.getNode(transfer.fromNodeId);
    const toNode = graphBuilder.getNode(transfer.toNodeId);
    log("ENGINE", `    ${fromNode?.label ?? "?"} -> ${toNode?.label ?? "?"}: ${transfer.automationLevel} (${transfer.mechanism})`);
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4: Execute the protocol run
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 4: Execute Protocol Run");

  const sampleTracker = new SampleTracker();
  const orchestrator = new IntraKernelOrchestrator(graph, pool, sampleTracker);
  const runner = new ProtocolRunner(orchestrator, automationTracker, sampleTracker);

  // Collect protocol events
  const protocolEvents: ProtocolEvent[] = [];
  runner.onEvent((event) => {
    protocolEvents.push(event);
    log("RUNNER", `Event: ${event.type}${event.stepId ? ` (step ${event.stepId.slice(0, 20)}...)` : ""}`);
  });

  log("RUNNER", "Starting protocol execution...");
  await runner.executeRun(run);

  const completedRun = runner.getRun(run.id);
  log("RUNNER", `Run completed: status=${completedRun?.status}`);
  log("RUNNER", `  Duration: ${completedRun?.startedAt} -> ${completedRun?.completedAt}`);
  log("RUNNER", `  Events emitted: ${protocolEvents.length}`);
  log("RUNNER", `  Samples tracked: ${completedRun?.sampleIds.length}`);
  artifactCount += protocolEvents.length;

  // Show step results
  if (completedRun) {
    for (const step of completedRun.steps) {
      const templateStep = template.steps.find((s) => s.id === step.protocolStepId);
      log("RUNNER", `  Step "${templateStep?.label}": ${step.status} (${step.actualDurationMs ?? "?"}ms)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 5: Automation Level Progression
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 5: Automation Level Progression");

  // Pick the first transfer pair (liquid handler -> staging)
  const fromId = liquidHandler.id;
  const toId = staging.id;

  log("AUTOMATION", `Tracking: ${liquidHandler.label} -> ${staging.label}`);

  let status = automationTracker.getStatus(fromId, toId)!;
  log("AUTOMATION", `  Current level: ${status.currentLevel}`);
  log("AUTOMATION", `  Episodes: ${status.episodeCount}/${status.minEpisodesForTraining}`);

  // Record demonstration episodes
  log("AUTOMATION", "Recording 10 demonstration episodes...");
  for (let i = 0; i < 10; i++) {
    automationTracker.recordEpisode(fromId, toId, ids.protocolEvent());
  }
  status = automationTracker.getStatus(fromId, toId)!;
  log("AUTOMATION", `  Episodes now: ${status.episodeCount}`);
  artifactCount += 10;

  // Simulate VLA training result
  log("AUTOMATION", "Training VLA model on collected episodes...");
  automationTracker.updateVLAModel(
    fromId,
    toId,
    "model_smolvla_transfer_001",
    "SmolVLA (liquid_handler -> staging)",
    0.92,
  );
  status = automationTracker.getStatus(fromId, toId)!;
  log("AUTOMATION", `  VLA Model: ${status.vlaModelName}`);
  log("AUTOMATION", `  Success Rate: ${((status.vlaSuccessRate ?? 0) * 100).toFixed(0)}%`);

  // Check advancement
  const advancement = automationTracker.checkAdvancement(fromId, toId);
  log("AUTOMATION", `  Should advance: ${advancement.shouldAdvance}`);
  log("AUTOMATION", `  Next level: ${advancement.nextLevel}`);

  if (advancement.shouldAdvance) {
    automationTracker.advanceLevel(fromId, toId);
    status = automationTracker.getStatus(fromId, toId)!;
    log("AUTOMATION", `  ADVANCED to: ${status.currentLevel}`);
  }

  // Show the full progression
  log("AUTOMATION", "\n  Automation Progression:");
  log("AUTOMATION", "    manual          [x] Human carries labware");
  log("AUTOMATION", `    teleoperated    [${status.currentLevel === "teleoperated" ? "x" : " "}] Human controls robot remotely`);
  log("AUTOMATION", "    pilot_operated  [ ] Trained pilot supervises");
  log("AUTOMATION", "    vla_assisted    [ ] VLA executes, human monitors");
  log("AUTOMATION", "    fully_autonomous[ ] VLA executes without supervision");

  // ══════════════════════════════════════════════════════════════════
  // PHASE 6: Protocol Forking
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 6: Protocol Forking — User Customizes Published Protocol");

  const fork: ProtocolFork = {
    id: ids.protocolFork(),
    sourceTemplateId: template.id,
    sourceTemplateVersion: template.version,
    forkedBy: "user_pharma_researcher_042",
    parameterOverrides: {
      dilution_ratio: 50,          // Much higher dilution for concentrated samples
      centrifuge_rpm: 20000,       // Ultracentrifugation
      spin_time_min: 30,           // Extended spin
      injection_volume_ul: 5,     // Micro-injection
      run_time_min: 60,           // Extended run for complex mixtures
    },
    stepOverrides: [
      {
        action: "modify",
        stepId: step3Id,
        modifications: {
          params: {
            columnType: "SEC",
            mobilePhase: "Tris-HCl pH 7.5 + 150mM NaCl",  // Different buffer
            flowRateMlPerMin: 0.25,  // Slower flow
          },
        },
      },
    ],
    name: "Serum Protein Analysis — High-Conc Pharma Variant",
    notes: "Modified for concentrated biologic samples. Uses Tris buffer with salt for better separation of aggregates.",
    createdAt: new Date().toISOString(),
  };
  artifactCount++;

  log("FORK", `Fork created: ${fork.id}`);
  log("FORK", `  Source: ${fork.sourceTemplateId} v${fork.sourceTemplateVersion}`);
  log("FORK", `  By: ${fork.forkedBy}`);
  log("FORK", `  Name: "${fork.name}"`);
  log("FORK", `  Parameter overrides:`);
  for (const [key, value] of Object.entries(fork.parameterOverrides)) {
    const original = template.defaultValues[key];
    log("FORK", `    ${key}: ${original} -> ${value}`);
  }
  if (fork.stepOverrides) {
    log("FORK", `  Step overrides: ${fork.stepOverrides.length}`);
    for (const override of fork.stepOverrides) {
      const step = template.steps.find((s) => s.id === override.stepId);
      log("FORK", `    ${override.action} step "${step?.label ?? override.stepId}"`);
    }
  }
  log("FORK", `  Notes: "${fork.notes}"`);

  // Bind the forked version
  const forkedRun = engine.bindProtocol(
    template,
    KERNEL_ID,
    fork.parameterOverrides,
    fork.forkedBy,
  );
  artifactCount++;

  log("FORK", `\n  Forked run bound: ${forkedRun.id}`);
  log("FORK", `  Resolved parameters:`);
  for (const step of forkedRun.steps) {
    const templateStep = template.steps.find((s) => s.id === step.protocolStepId);
    log("FORK", `    ${templateStep?.label}: ${JSON.stringify(step.resolvedParams)}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════

  heading("SIMULATION COMPLETE");

  const allStatuses = automationTracker.getAllStatuses(KERNEL_ID);
  const allSamples = sampleTracker.getAllSamples();

  console.log(`
  \x1b[1mProtocol Template:\x1b[0m   "${template.name}"
  \x1b[1mSteps:\x1b[0m               ${template.steps.length} (liquid_handling -> centrifugation -> chromatography + spectroscopy)
  \x1b[1mTransfers:\x1b[0m           ${template.transfers.length} robot-mediated
  \x1b[1mParameters:\x1b[0m          ${template.parameters.length} user-configurable

  \x1b[1mProtocol Run:\x1b[0m        ${completedRun?.status ?? "unknown"}
  \x1b[1mEvents Emitted:\x1b[0m      ${protocolEvents.length}
  \x1b[1mSamples Tracked:\x1b[0m     ${allSamples.length}
  \x1b[1mAutomation Statuses:\x1b[0m ${allStatuses.length}
  \x1b[1mEpisodes Recorded:\x1b[0m   ${status.episodeCount}
  \x1b[1mVLA Model:\x1b[0m           ${status.vlaModelName ?? "none"}
  \x1b[1mFork:\x1b[0m                "${fork.name}"

  \x1b[1mTotal Artifacts:\x1b[0m     ${artifactCount}
  `);

  console.log(DIVIDER);
  console.log(`  \x1b[92mSUCCESS\x1b[0m — Protocol E2E simulation completed`);
  console.log(DIVIDER + "\n");
}

main().catch((err) => {
  console.error("\x1b[31mSimulation failed:\x1b[0m", err);
  process.exit(1);
});
