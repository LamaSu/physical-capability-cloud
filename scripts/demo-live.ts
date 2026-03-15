/**
 * LIVE DEMO: Slow-motion version with pauses for dashboard click-through
 *
 * Run: npx tsx scripts/demo-live.ts
 *
 * Each phase pauses for you to click the corresponding dashboard page.
 * Press ENTER to advance to the next phase.
 */

import { MessageBus } from "@pcc/a2a";
import { UserAgent } from "@pcc/agent-user";
import { BrokerAgent } from "@pcc/agent-broker";
import {
  EvidenceEmitter,
  EncryptionService,
} from "@pcc/kernel";
import {
  CommitmentService,
  ZKProofService,
  BittensorSubnetBridge,
} from "@pcc/verifier";
import { CapabilityCertificateService, RewardEngine } from "@pcc/contracts";
import { CapabilityRouter } from "@pcc/scheduler";
import type { Capability, CWM, EvidenceBundle } from "@pcc/spec";
import { ids } from "@pcc/spec";
import * as readline from "node:readline";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const WHITE = "\x1b[37m";
const BG_GREEN = "\x1b[42m";
const BG_CYAN = "\x1b[46m";
const BG_YELLOW = "\x1b[43m";
const BG_RED = "\x1b[41m";
const BG_MAGENTA = "\x1b[45m";
const BG_BLACK = "\x1b[40m";

function log(tag: string, msg: string) {
  const colors: Record<string, string> = {
    USER: CYAN, BROKER: YELLOW, KERNEL: GREEN, COURIER: BLUE,
    SYSTEM: MAGENTA, ESCROW: RED, EVIDENCE: GREEN, ENCRYPT: YELLOW,
    MERKLE: MAGENTA, ZK: BLUE, SUBNET: RED, SETTLE: GREEN,
    CERT: YELLOW, REWARD: MAGENTA, ROUTE: CYAN, BID: YELLOW,
    PRINT: CYAN, ROBOT: GREEN, FRAME: GREEN, DASH: WHITE,
  };
  console.log(`  ${(colors[tag] ?? WHITE)}[${tag.padEnd(10)}]${RESET} ${msg}`);
}

function evidence(description: string) {
  // Flash an evidence event — visual indicator
  console.log(`  ${BG_GREEN}${WHITE}${BOLD} 📸 EVIDENCE ${RESET} ${GREEN}${description}${RESET}`);
}

function table(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) => {
    const maxRow = Math.max(...rows.map(r => (r[i] ?? "").length));
    return Math.max(h.length, maxRow) + 2;
  });
  const headerLine = headers.map((h, i) => ` ${h.padEnd(widths[i] - 1)}`).join("\u2502");
  console.log(`  ${DIM}\u250C${widths.map(w => "\u2500".repeat(w)).join("\u252C")}\u2510${RESET}`);
  console.log(`  ${DIM}\u2502${RESET}${BOLD}${headerLine}${RESET}${DIM}\u2502${RESET}`);
  console.log(`  ${DIM}\u251C${widths.map(w => "\u2500".repeat(w)).join("\u253C")}\u2524${RESET}`);
  for (const row of rows) {
    const line = row.map((cell, i) => ` ${cell.padEnd(widths[i] - 1)}`).join(`${DIM}\u2502${RESET}`);
    console.log(`  ${DIM}\u2502${RESET}${line}${DIM}\u2502${RESET}`);
  }
  console.log(`  ${DIM}\u2514${widths.map(w => "\u2500".repeat(w)).join("\u2534")}\u2518${RESET}`);
}

async function pause(dashPage: string, instruction: string) {
  console.log();
  console.log(`  ${BG_CYAN}${WHITE}${BOLD} DASHBOARD ${RESET} ${CYAN}Navigate to: ${BOLD}${dashPage}${RESET}`);
  console.log(`  ${DIM}${instruction}${RESET}`);
  console.log(`  ${DIM}Press ENTER to continue...${RESET}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>(resolve => rl.question("", () => { rl.close(); resolve(); }));
  console.log();
}

async function createMockBundle(
  emitter: EvidenceEmitter, jobId: string, stepId: string,
  kernelId: string, tier: 0 | 1 | 2 | 3,
  eventTypes: Array<{ type: string; data: Record<string, unknown> }>,
): Promise<EvidenceBundle> {
  emitter.registerStep(jobId, stepId, tier);
  for (const evt of eventTypes) {
    await emitter.addEvent(jobId, stepId, {
      type: evt.type as any, timestamp: new Date().toISOString(),
      source: { deviceId: `dev-${stepId}`, deviceType: "controller" as any, kernelId },
      payload: evt.data,
    });
  }
  return emitter.finalizeBundle(jobId, stepId);
}

async function main() {
  console.clear();
  console.log();
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);
  console.log(`${BOLD}${WHITE}    PHYSICAL CAPABILITY CLOUD — LIVE DEMO${RESET}`);
  console.log(`${BOLD}${WHITE}    "AWS for the Physical World"${RESET}`);
  console.log(`${DIM}    Split-screen: Terminal (left) + Dashboard (right)${RESET}`);
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);

  await pause("http://localhost:5173/", "Show the Command Center dashboard — KPIs, active jobs, kernels online");

  // ═══════════════════════════════════════════════════════════
  // PHASE 1: DISCOVER
  // ═══════════════════════════════════════════════════════════
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log(`${BOLD}${WHITE}  PHASE 1: DISCOVER — What capabilities exist?${RESET}`);
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log();

  const bus = new MessageBus();
  const userAgent = new UserAgent(bus);
  userAgent.start();
  const brokerAgent = new BrokerAgent(bus);
  brokerAgent.start();

  log("USER", `Agent online: ${userAgent.wallet.address}`);
  log("USER", `"I need a poster printed, framed, and delivered to Frontier Tower."`);

  const router = new CapabilityRouter();
  const printCap: Capability = { id: ids.capability(), kernelId: "kernel_quickprint", type: "2d-print", name: "QuickPrint SOMA", materials: ["glossy", "matte"], assuranceTiers: [0, 1], pricing: { currency: "USDC", baseCost: "14.00", perMinute: "0.00", minimum: "14.00" }, availability: { timezone: "America/Los_Angeles", windows: {} }, location: { lat: 37.7785, lng: -122.3960 }, queueDepth: 0 };
  const frameCap: Capability = { id: ids.capability(), kernelId: "kernel_roboframe", type: "assembly", name: "RoboFrame Lab", materials: ["aluminum", "wood"], assuranceTiers: [0, 1, 2], pricing: { currency: "USDC", baseCost: "15.00", perMinute: "0.00", minimum: "15.00" }, availability: { timezone: "America/Los_Angeles", windows: {} }, location: { lat: 37.7760, lng: -122.4100 }, queueDepth: 0, tags: ["robot-arm", "vision-guided"] };
  const courierPickup: Capability = { id: ids.capability(), kernelId: "courier_dash", type: "courier-pickup", name: "DashRun", materials: [], assuranceTiers: [0, 1], pricing: { currency: "USDC", baseCost: "7.00", perMinute: "0.00", minimum: "7.00" }, availability: { timezone: "America/Los_Angeles", windows: {} }, location: { lat: 37.7749, lng: -122.4194 }, queueDepth: 0 };
  const courierDeliver: Capability = { id: ids.capability(), kernelId: "courier_dash", type: "courier-delivery", name: "DashRun", materials: [], assuranceTiers: [0, 1], pricing: { currency: "USDC", baseCost: "9.00", perMinute: "0.00", minimum: "9.00" }, availability: { timezone: "America/Los_Angeles", windows: {} }, location: { lat: 37.7749, lng: -122.4194 }, queueDepth: 0 };

  router.registerKernel({ kernelId: "kernel_quickprint", capabilities: [printCap], reputation: 920 });
  router.registerKernel({ kernelId: "kernel_roboframe", capabilities: [frameCap], reputation: 950 });
  router.registerKernel({ kernelId: "courier_dash", capabilities: [courierPickup, courierDeliver], reputation: 900 });

  log("BROKER", "3 operators discovered:");
  table(["Operator", "Capability", "Price"], [
    ["QuickPrint SOMA", "2d-print (large format)", "$14"],
    ["RoboFrame Lab", "assembly (robot-assisted)", "$15"],
    ["DashRun", "courier (pickup + delivery)", "$7 + $9"],
  ]);

  await pause("http://localhost:5173/discover", "Show Capability Discovery — filter by 2d-print, assembly, courier");

  // ═══════════════════════════════════════════════════════════
  // PHASE 2: BUILD CONTRACT + ESCROW
  // ═══════════════════════════════════════════════════════════
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log(`${BOLD}${WHITE}  PHASE 2: CONTRACT — Agents negotiate, escrow locks${RESET}`);
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log();

  log("BROKER", `${GREEN}${BOLD}Route optimized: $45 USDC${RESET}`);
  log("BROKER", "  Print ($14) → Pickup ($7) → Frame ($15) → Deliver ($9)");
  console.log();

  log("ESCROW", `${RED}${BOLD}$45.00 USDC locked in milestone escrow${RESET}`);
  table(["Step", "Operator", "Amount", "Bond"], [
    ["print", "QuickPrint SOMA", "$14.00", "$0.70"],
    ["pickup", "DashRun", "$7.00", "$0.35"],
    ["frame", "RoboFrame Lab", "$15.00", "$0.75"],
    ["deliver", "DashRun", "$9.00", "$0.45"],
  ]);

  await pause("http://localhost:5173/escrow", "Show Escrow Dashboard — milestones, bonds, challenge windows");

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: EXECUTE — PRINT
  // ═══════════════════════════════════════════════════════════
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log(`${BOLD}${WHITE}  PHASE 3: EXECUTE — Print the poster${RESET}`);
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log();

  const jobId = ids.job();
  const printEmitter = new EvidenceEmitter("kernel_quickprint");

  log("PRINT", `${CYAN}QuickPrint SOMA${RESET} receives print job`);
  log("PRINT", "  24x36\" glossy poster, 300 DPI");

  evidence("File hash verified: sha256:poster_design_001");
  evidence("Printer started: Epson SureColor P900");
  evidence("Power draw: 12 Wh over 4 minutes");
  evidence("Color QC: deltaE < 2 — photo-grade match");
  evidence("CV inspection: edges clean, no bleed, 98% match");
  evidence("Print complete: 1 copy, photo-grade quality");

  const printBundle = await createMockBundle(printEmitter, jobId, "step_print", "kernel_quickprint", 1, [
    { type: "gcode_hash_verified", data: { fileHash: "sha256:poster_design_001", dpi: 300 } },
    { type: "execution_started", data: { printer: "Epson SureColor P900" } },
    { type: "power_profile_summary", data: { totalWh: 12, printTime: "4min" } },
    { type: "camera_snapshot", data: { photo: "sha256:print_qc_snap", colorAccuracy: "deltaE < 2" } },
    { type: "cv_inspection_result", data: { pass: true, colorMatch: 0.98 } },
    { type: "execution_completed", data: { copies: 1, quality: "photo-grade" } },
  ]);

  log("ESCROW", `Milestone 1 (print) evidence submitted — ${printBundle.events.length} events`);

  await pause("http://localhost:5173/jobs", "Show Jobs page — active print job with progress");

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: EXECUTE — PICKUP + FRAME
  // ═══════════════════════════════════════════════════════════
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log(`${BOLD}${WHITE}  PHASE 4: EXECUTE — Courier + Robot Framing${RESET}`);
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log();

  log("COURIER", `${BLUE}DashRun${RESET} dispatched to QuickPrint SOMA`);
  evidence("Courier pickup confirmed — photo proof");
  evidence("Chain of custody signed: QuickPrint → DashRun");

  const pickupEmitter = new EvidenceEmitter("courier_dash");
  const pickupBundle = await createMockBundle(pickupEmitter, jobId, "step_pickup", "courier_dash", 0, [
    { type: "gcode_hash_verified", data: { item: "poster-24x36" } },
    { type: "courier_pickup_confirmed", data: { photo: "sha256:pickup_poster" } },
    { type: "custody_handoff_confirmed", data: { from: "QuickPrint SOMA", to: "DashRun" } },
    { type: "execution_completed", data: { status: "picked_up" } },
  ]);
  log("ESCROW", `Milestone 2 (pickup) — ${pickupBundle.events.length} events`);

  console.log();
  log("ROBOT", `${GREEN}RoboFrame Lab${RESET} receives poster`);
  log("ROBOT", "  Robot arm: 7-DOF, vacuum-cup gripper");
  log("ROBOT", "  Frame: black aluminum, 24x36\"");

  evidence("Pre-frame alignment photo — camera check");
  evidence("Force-torque: avg 2.1N, max 3.8N — gentle handling");
  evidence("CV alignment: 0.3mm offset — 97% confidence");
  evidence("Final frame photo — quality: excellent");
  evidence("Robot cycle complete: 1 cycle, 0 human intervention");

  const frameEmitter = new EvidenceEmitter("kernel_roboframe");
  const frameBundle = await createMockBundle(frameEmitter, jobId, "step_frame", "kernel_roboframe", 1, [
    { type: "gcode_hash_verified", data: { frameSpec: "black-aluminum-24x36" } },
    { type: "execution_started", data: { method: "robot-assisted", armModel: "R2D3-7DOF" } },
    { type: "camera_snapshot", data: { photo: "sha256:align_check", stage: "pre-frame" } },
    { type: "sensor_data_summary", data: { channel: "force_torque", avgN: 2.1, maxN: 3.8 } },
    { type: "cv_inspection_result", data: { pass: true, alignment: "0.3mm", confidence: 0.97 } },
    { type: "camera_snapshot", data: { photo: "sha256:final_frame", stage: "complete" } },
    { type: "execution_completed", data: { quality: "excellent", humanIntervention: false } },
    { type: "power_profile_summary", data: { totalWh: 8.5, armActiveTime: "45s" } },
  ]);
  log("ESCROW", `Milestone 3 (frame) — ${frameBundle.events.length} events`);

  await pause("http://localhost:5173/sensors", "Show Sensor Dashboard — force-torque readings from robot arm");

  // ═══════════════════════════════════════════════════════════
  // PHASE 5: DELIVERY
  // ═══════════════════════════════════════════════════════════
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log(`${BOLD}${WHITE}  PHASE 5: DELIVER — To Frontier Tower, 4th floor${RESET}`);
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log();

  log("COURIER", `${BLUE}DashRun${RESET} en route to 995 Market St`);
  evidence("Delivery confirmed — recipient signed");
  evidence("Photo proof of delivery at Frontier Tower 4F");

  const deliverEmitter = new EvidenceEmitter("courier_dash");
  const deliverBundle = await createMockBundle(deliverEmitter, jobId, "step_deliver", "courier_dash", 0, [
    { type: "gcode_hash_verified", data: { item: "framed-poster" } },
    { type: "courier_delivery_confirmed", data: { recipient: "Frontier Tower 4F", signed: true } },
    { type: "execution_completed", data: { delivered: true } },
  ]);
  log("ESCROW", `Milestone 4 (delivery) — ${deliverBundle.events.length} events`);

  await pause("http://localhost:5173/evidence", "Show Evidence Explorer — all 4 bundles with encrypted data");

  // ═══════════════════════════════════════════════════════════
  // PHASE 6: VERIFY — SOVEREIGN STACK
  // ═══════════════════════════════════════════════════════════
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log(`${BOLD}${WHITE}  PHASE 6: VERIFY — Sovereign Infrastructure${RESET}`);
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log();

  const encService = new EncryptionService();
  const allBundles = [printBundle, pickupBundle, frameBundle, deliverBundle];

  log("ENCRYPT", `4 bundles encrypted (AES-256-GCM, per-recipient keys)`);
  for (const b of allBundles) {
    await encService.encryptBundle(b, [userAgent.wallet.address, "0x0000000000000000000000000000000000000002" as `0x${string}`]);
  }

  const commitService = new CommitmentService();
  const commitments = [];
  for (const b of allBundles) commitments.push(await commitService.createCommitment(b.bundleHash));
  const tree = await commitService.buildTree(commitments);
  log("MERKLE", `Tree: 4 leaves → root: ${tree.root.slice(0, 40)}...`);

  const zkService = new ZKProofService();
  const proof = await zkService.proveEvidenceInclusion(tree, 2, frameBundle.bundleHash);
  const valid = await zkService.verifyProof(proof);
  log("ZK", `Inclusion proof: ${valid ? `${GREEN}VERIFIED${RESET}` : `${RED}INVALID${RESET}`}`);

  const tierProof = await zkService.proveTierCompliance(frameBundle, 1);
  const tierValid = await zkService.verifyProof(tierProof);
  log("ZK", `Tier compliance: ${tierValid ? `${GREEN}VERIFIED${RESET}` : `${RED}INVALID${RESET}`}`);

  const bridge = new BittensorSubnetBridge();
  const result = await bridge.submitForVerification(frameBundle.bundleHash, JSON.stringify(frameBundle), 1);
  log("SUBNET", `Bittensor: ${result.minerCount} miners, consensus ${result.consensusScore} — ${result.passed ? `${GREEN}PASSED${RESET}` : `${RED}FAILED${RESET}`}`);

  await pause("http://localhost:5173/subnet", "Show Bittensor Subnet — miner leaderboard, consensus scores");

  // ═══════════════════════════════════════════════════════════
  // PHASE 7: SETTLE
  // ═══════════════════════════════════════════════════════════
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log(`${BOLD}${WHITE}  PHASE 7: SETTLE — Funds released${RESET}`);
  console.log(`${BOLD}${MAGENTA}${"━".repeat(60)}${RESET}`);
  console.log();

  log("SETTLE", `${GREEN}Released${RESET} $14.00 → QuickPrint SOMA`);
  log("SETTLE", `${GREEN}Released${RESET} $16.00 → DashRun`);
  log("SETTLE", `${GREEN}Released${RESET} $15.00 → RoboFrame Lab`);

  console.log();
  const certService = new CapabilityCertificateService();
  const cert = certService.mintCapabilityCertificate({
    kernelDid: "did:pcc:kernel:kernel_roboframe",
    capabilityType: "assembly", assuranceTier: 1,
    metadata: { method: "robot-assisted", qualityScore: "0.97" },
  });
  log("CERT", `Soulbound cNFT: ${cert.id} → RoboFrame Lab`);

  const rewardEngine = new RewardEngine();
  const epoch = rewardEngine.createEpoch(1, "2026-03-01T00:00:00Z", "2026-03-15T00:00:00Z", "500.000000");
  const completed = rewardEngine.completeEpoch(epoch.id, [{
    kernelId: "kernel_roboframe", kernelDid: "did:pcc:kernel:kernel_roboframe",
    jobsCompleted: 1, qualityScore: 0.97, uptimePercent: 99.5, capabilityDiversity: 1, scarcityBonus: 0.9,
  }]);
  log("REWARD", `DePIN: ${completed.kernelScores[0].rewardAmount} PCC tokens → RoboFrame Lab`);

  await pause("http://localhost:5173/depin", "Show DePIN Dashboard — rewards, certificates, treasury");

  // ═══════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════
  const totalEvents = allBundles.reduce((sum, b) => sum + b.events.length, 0);
  console.log();
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);
  console.log();
  table(["", ""], [
    ["Workflow", "print → pickup → frame → deliver"],
    ["Operators", "3 (QuickPrint, DashRun, RoboFrame)"],
    ["Total cost", `${GREEN}$45.00 USDC${RESET}`],
    ["Evidence events", `${totalEvents}`],
    ["ZK proofs", "2 (inclusion + compliance)"],
    ["Bittensor consensus", `${result.consensusScore}`],
    ["Robot arm", "1 cycle, 0 human intervention"],
    ["Middlemen", `${RED}${BOLD}ZERO${RESET}`],
  ]);
  console.log();
  console.log(`  ${BOLD}${WHITE}Any task. Any operator. Verified. Settled. This is PCC.${RESET}`);
  console.log();
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);

  userAgent.stop();
  brokerAgent.stop();
}

main().catch((err) => { console.error("\nDemo failed:", err); process.exit(1); });
