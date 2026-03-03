/**
 * End-to-End Simulation
 *
 * Exercises the full lifecycle without any real blockchain or physical machines:
 *
 *   1. User submits a CWM (3D print + courier pickup)
 *   2. Scheduler compiles CWM → ExecutionPlan
 *   3. Kernel receives job, executes mock FDM print
 *   4. Evidence Emitter collects events, produces signed bundle
 *   5. Verifier verifies the bundle, produces attestation
 *   6. (Simulated) Escrow receives evidence + attestation → challenge window → release
 *   7. Dispute path: second run with a tampered bundle triggers dispute
 *
 * Run: npx tsx scripts/e2e-simulation.ts
 */

import { WorkflowCompiler } from "@pcc/scheduler";
import { CapabilityRouter } from "@pcc/scheduler";
import { EvidenceEmitter } from "@pcc/kernel";
import { MockFDMAdapter, MockPowerMonitorAdapter, MockCameraAdapter } from "@pcc/kernel";
import { JobRunner } from "@pcc/kernel";
import { VerifierMarket, EvidenceVerifier } from "@pcc/verifier";
import type { CWM, Capability, Verifier, EvidenceBundle, SHA256 } from "@pcc/spec";
import { ids } from "@pcc/spec";

const DIVIDER = "═".repeat(70);

function log(section: string, msg: string) {
  console.log(`[${section.padEnd(12)}] ${msg}`);
}

async function main() {
  console.log("\n" + DIVIDER);
  console.log("  PHYSICAL CAPABILITY CLOUD — End-to-End Simulation");
  console.log(DIVIDER + "\n");

  // ── Setup ──────────────────────────────────────────────────────────

  log("SETUP", "Initializing mock shop kernel...");

  const KERNEL_ID = "kernel_sim_001";
  const fdm = new MockFDMAdapter("dev_fdm_sim", KERNEL_ID, 3_000);
  const power = new MockPowerMonitorAdapter("dev_power_sim", KERNEL_ID);
  const camera = new MockCameraAdapter("dev_cam_sim", KERNEL_ID, 1.0); // 100% pass for happy path
  const emitter = new EvidenceEmitter(KERNEL_ID);

  const mockCapability: Capability = {
    id: "cap_sim_fdm",
    kernelId: KERNEL_ID,
    type: "fdm",
    name: "Simulated Prusa MK4",
    materials: ["pla", "petg"],
    assuranceTiers: [0, 1, 2],
    pricing: { currency: "USDC", baseCost: "2.00", perMinute: "0.05", minimum: "5.00" },
    availability: { timezone: "UTC", windows: {} },
    location: { lat: 40.7128, lng: -74.006 },
    queueDepth: 0,
  };

  // Register kernel with router
  const router = new CapabilityRouter();
  router.registerKernel({
    kernelId: KERNEL_ID,
    capabilities: [mockCapability],
    reputation: 850,
  });

  // Register a courier kernel (mock)
  router.registerKernel({
    kernelId: "kernel_courier_sim",
    capabilities: [{
      ...mockCapability,
      id: "cap_courier_sim",
      kernelId: "kernel_courier_sim",
      type: "courier-pickup",
      name: "Uber Direct Courier (Simulated)",
      materials: [],
      pricing: { currency: "USDC", baseCost: "8.00", minimum: "8.00" },
    }],
    reputation: 700,
  });

  const compiler = new WorkflowCompiler(router);

  // Register verifiers
  const verifierMarket = new VerifierMarket();
  const mockVerifier: Verifier = {
    id: "ver_sim_001",
    address: "0x1111111111111111111111111111111111111111",
    name: "SimVerifier Alpha",
    supportedCapabilityTypes: ["fdm"],
    maxTier: 2,
    stakedAmount: "1000",
    reputation: 900,
    totalVerifications: 500,
    disputesLost: 2,
    guildMember: false,
    registeredAt: new Date().toISOString(),
    status: "active",
  };
  verifierMarket.registerVerifier(mockVerifier);

  const evidenceVerifier = new EvidenceVerifier(
    "ver_sim_001",
    "0x1111111111111111111111111111111111111111",
  );

  log("SETUP", "Done.\n");

  // ── Step 1: Submit CWM ─────────────────────────────────────────────

  console.log("━━━ STEP 1: Submit Capability Workflow Manifest ━━━\n");

  const cwm: CWM = {
    version: "1.0",
    id: ids.cwm(),
    name: "Print & Deliver Test Part",
    description: "3D print a test bracket and deliver via courier",
    steps: [
      {
        id: "step_print",
        capability: "fdm",
        params: { material: "pla", infill: 20, layerHeight: 0.2 },
        inputs: [{
          fileHash: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" as SHA256,
          mimeType: "application/x-gcode",
          storageRef: "ipfs://QmSimulatedGcode",
          filename: "bracket.gcode",
        }],
        assuranceTier: 1,
        dependsOn: [],
        estimatedDuration: 5, // 5 minutes (short for sim)
      },
      {
        id: "step_courier",
        capability: "courier-pickup",
        params: {},
        courier: {
          from: { stepId: "step_print" },
          to: { address: "456 User Ave, New York, NY", location: { lat: 40.7580, lng: -73.9855 } },
          priority: "standard",
        },
        assuranceTier: 0,
        dependsOn: ["step_print"],
        estimatedDuration: 30,
      },
    ],
    settlement: {
      currency: "USDC",
      maxBudget: "50.00",
      payer: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
    },
    createdAt: new Date().toISOString(),
    submitter: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
  };

  log("USER", `CWM submitted: ${cwm.id}`);
  log("USER", `  Steps: ${cwm.steps.map((s) => `${s.id} (${s.capability})`).join(" → ")}`);
  log("USER", `  Budget: $${cwm.settlement.maxBudget} ${cwm.settlement.currency}`);

  // ── Step 2: Compile to ExecutionPlan ──────────────────────────────

  console.log("\n━━━ STEP 2: Compile CWM → Execution Plan ━━━\n");

  const plan = await compiler.compile(cwm);
  log("SCHEDULER", `Plan created: ${plan.id}`);
  log("SCHEDULER", `  Total cost: $${plan.totalCost} ${cwm.settlement.currency}`);
  for (const a of plan.assignments) {
    log("SCHEDULER", `  ${a.stepId} → kernel ${a.kernelId} @ $${a.quotedPrice}`);
  }

  // ── Step 3: Execute Print Job ─────────────────────────────────────

  console.log("\n━━━ STEP 3: Execute Print Job on Kernel ━━━\n");

  const printAssignment = plan.assignments.find((a) => a.stepId === "step_print")!;
  const jobId = ids.job();

  log("KERNEL", `Starting job ${jobId} on ${printAssignment.capabilityId}`);

  const runner = new JobRunner(fdm, [power], camera, emitter);
  const result = await runner.run({
    jobId,
    stepId: "step_print",
    gcodeHash: cwm.steps[0].inputs![0].fileHash,
    assuranceTier: 1,
  });

  if (result.success) {
    log("KERNEL", `Job completed in ${result.durationMs}ms`);
    log("KERNEL", `  Bundle ID: ${result.bundleId}`);
    log("KERNEL", `  Bundle Hash: ${result.bundleHash}`);
  } else {
    log("KERNEL", `Job FAILED: ${result.error}`);
    return;
  }

  // ── Step 4: Verify Evidence Bundle ────────────────────────────────

  console.log("\n━━━ STEP 4: Verify Evidence Bundle ━━━\n");

  // Get the bundle from the emitter
  const events = emitter.getEvents(jobId, "step_print");
  log("VERIFIER", `Evidence events collected: ${events.length}`);
  for (const ev of events) {
    log("VERIFIER", `  ${ev.type} @ ${ev.timestamp}`);
  }

  // Build the bundle for verification
  const { hashBundle: computeHash } = await import(
    "../packages/spec/dist/util/canonical.js"
  );
  const bundleHash = await computeHash(events);
  const bundle: EvidenceBundle = {
    id: result.bundleId!,
    jobId,
    stepId: "step_print",
    kernelId: KERNEL_ID,
    assuranceTier: 1 as const,
    events,
    bundleHash,
    kernelSignature: {
      signer: "0x0000000000000000000000000000000000000000" as const,
      algorithm: "secp256k1" as const,
      value: "mock_signature",
    },
    createdAt: new Date().toISOString(),
  };

  // Select verifier
  const selectedVerifiers = verifierMarket.selectVerifiers(1);
  log("VERIFIER", `Selected verifier(s): ${selectedVerifiers.join(", ")}`);

  // Run verification
  const attestation = await evidenceVerifier.verify(bundle);
  log("VERIFIER", `Attestation result: ${attestation.result}`);
  log("VERIFIER", `  Confidence: ${attestation.confidence}%`);
  log("VERIFIER", `  Findings:`);
  for (const f of attestation.findings) {
    log("VERIFIER", `    ${f.passed ? "PASS" : "FAIL"} ${f.check}: ${f.details}`);
  }

  // ── Step 5: Settlement (Simulated) ────────────────────────────────

  console.log("\n━━━ STEP 5: Settlement (Simulated) ━━━\n");

  if (attestation.result === "valid") {
    log("ESCROW", "Evidence attested as VALID");
    log("ESCROW", "Challenge window opened (simulated: 4 hours for Tier 1)");
    log("ESCROW", "... (no disputes filed) ...");
    log("ESCROW", "Challenge window expired");
    log("ESCROW", `Payment RELEASED: $${printAssignment.quotedPrice} USDC → operator`);
    log("ESCROW", "Operator bond returned");
  } else {
    log("ESCROW", "Evidence attested as INVALID — funds held");
  }

  // ── Step 6: Courier Handoff (Simulated) ───────────────────────────

  console.log("\n━━━ STEP 6: Courier Handoff (Simulated) ━━━\n");

  log("CUSTODY", "Item sealed with tamper-evident packaging");
  log("CUSTODY", "Courier (Uber Direct) dispatched");
  log("CUSTODY", "Courier arrived at shop kernel location");
  log("CUSTODY", "Handoff to courier confirmed (photo proof + GPS)");
  log("CUSTODY", "In transit...");
  log("CUSTODY", "Courier arrived at destination");
  log("CUSTODY", "Recipient confirmed delivery");
  log("CUSTODY", `Courier payment RELEASED: $${plan.assignments[1]?.quotedPrice ?? "8.00"} USDC`);

  // ── Summary ───────────────────────────────────────────────────────

  console.log("\n" + DIVIDER);
  console.log("  SIMULATION COMPLETE — HAPPY PATH");
  console.log(DIVIDER);
  console.log(`
  Workflow:     ${cwm.name}
  CWM ID:       ${cwm.id}
  Plan ID:      ${plan.id}
  Total Cost:   $${plan.totalCost} USDC
  Evidence:     ${events.length} events in 1 bundle
  Verification: ${attestation.result} (${attestation.confidence}% confidence)
  Settlement:   Released to operator + courier
  `);

  // ── Dispute Path Demo ─────────────────────────────────────────────

  console.log(DIVIDER);
  console.log("  DISPUTE PATH DEMO");
  console.log(DIVIDER + "\n");

  // Create a tampered bundle (wrong bundle hash)
  const tamperedBundle: EvidenceBundle = {
    ...bundle,
    bundleHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as SHA256,
  };

  const disputeAttestation = await evidenceVerifier.verify(tamperedBundle);
  log("VERIFIER", `Tampered bundle result: ${disputeAttestation.result}`);
  log("VERIFIER", `  Confidence: ${disputeAttestation.confidence}%`);
  const failures = disputeAttestation.findings.filter((f) => !f.passed);
  for (const f of failures) {
    log("VERIFIER", `  FAIL: ${f.check} — ${f.details}`);
  }

  if (disputeAttestation.result !== "valid") {
    log("ESCROW", "Evidence attested as INVALID — dispute triggered");
    log("ESCROW", "Challenger stakes bond (10% of milestone)");
    log("ESCROW", "Arbiter reviews evidence...");
    log("ESCROW", "Arbiter rules: challenger wins");
    log("ESCROW", "Operator bond SLASHED");
    log("ESCROW", "Payer REFUNDED");
    log("ESCROW", "Challenger bond returned + operator bond awarded");
  }

  console.log("\n" + DIVIDER);
  console.log("  ALL PATHS COMPLETE");
  console.log(DIVIDER + "\n");
}

main().catch(console.error);
