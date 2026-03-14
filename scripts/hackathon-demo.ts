/**
 * Hackathon Demo: "AWS for the Physical World"
 *
 * THE STORY:
 *   Someone needs a poster printed, framed, and delivered to Frontier Tower.
 *   They post the workflow to PCC. Agents bid on each step. Cheapest valid
 *   path wins. Escrow locks. Operators execute. Evidence proves it happened.
 *   Funds release. No middleman.
 *
 *   If the robot arms are working: the framing step is done by a robot arm
 *   with vision-guided pick-and-place. Full physical AI loop.
 *
 * Run: npx tsx scripts/hackathon-demo.ts
 */

import { MessageBus } from "@pcc/a2a";
import { UserAgent } from "@pcc/agent-user";
import { BrokerAgent } from "@pcc/agent-broker";
import { KernelAgent } from "@pcc/agent-kernel";
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
import type { Capability, CWM, EvidenceBundle, SHA256 } from "@pcc/spec";
import { ids } from "@pcc/spec";

// ── ANSI colors ───────────────────────────────────────────────
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

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function banner(phase: number, title: string, subtitle?: string) {
  const pad = 56;
  console.log();
  console.log(`${BOLD}${MAGENTA}\u2554${"\u2550".repeat(pad)}\u2557${RESET}`);
  console.log(`${BOLD}${MAGENTA}\u2551${RESET}${BOLD}${WHITE}  Phase ${phase}: ${title}${" ".repeat(Math.max(0, pad - title.length - 12))}${RESET}${BOLD}${MAGENTA}\u2551${RESET}`);
  if (subtitle) console.log(`${BOLD}${MAGENTA}\u2551${RESET}${DIM}  ${subtitle}${" ".repeat(Math.max(0, pad - subtitle.length - 2))}${RESET}${BOLD}${MAGENTA}\u2551${RESET}`);
  console.log(`${BOLD}${MAGENTA}\u255A${"\u2550".repeat(pad)}\u255D${RESET}`);
  console.log();
}

function log(tag: string, msg: string) {
  const colors: Record<string, string> = {
    USER: CYAN, BROKER: YELLOW, KERNEL: GREEN, COURIER: BLUE,
    SYSTEM: MAGENTA, ESCROW: RED, EVIDENCE: GREEN, ENCRYPT: YELLOW,
    MERKLE: MAGENTA, ZK: BLUE, SUBNET: RED, SETTLE: GREEN,
    CERT: YELLOW, REWARD: MAGENTA, ROUTE: CYAN, BID: YELLOW,
    PRINT: CYAN, ROBOT: GREEN, FRAME: GREEN,
  };
  console.log(`  ${(colors[tag] ?? WHITE)}[${tag.padEnd(10)}]${RESET} ${msg}`);
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

// ══════════════════════════════════════════════════════════════════
async function main() {
  const startTime = Date.now();

  console.log();
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);
  console.log(`${BOLD}${WHITE}    PHYSICAL CAPABILITY CLOUD${RESET}`);
  console.log(`${BOLD}${WHITE}    "AWS for the Physical World"${RESET}`);
  console.log(`${DIM}    Hackathon Demo — Frontier Tower, SF${RESET}`);
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);
  console.log();
  console.log(`${DIM}  A poster gets printed, picked up, framed, and delivered${RESET}`);
  console.log(`${DIM}  to Frontier Tower — orchestrated by agents, verified by${RESET}`);
  console.log(`${DIM}  evidence, settled on-chain. No middleman. No trust needed.${RESET}`);

  // ═══════════════════════════════════════════════════════════
  // Phase 1: THE REQUEST
  // ═══════════════════════════════════════════════════════════

  banner(1, "THE REQUEST", "User posts a multi-step workflow");

  const bus = new MessageBus();
  const userAgent = new UserAgent(bus);
  userAgent.start();

  log("SYSTEM", "Message bus online.");
  log("USER", `Online: User Agent`);
  log("USER", `Wallet: ${userAgent.wallet.address}`);

  const cwm: CWM = {
    version: "1.0", id: ids.cwm(),
    name: "Print, Frame & Deliver",
    description: "Print a poster, pick it up, frame it, deliver to Frontier Tower",
    steps: [
      { id: "step_print", capability: "2d-print",
        params: { size: "24x36in", paper: "glossy-premium", copies: 1, content: "presentation-poster" },
        assuranceTier: 1, dependsOn: [], estimatedDuration: 15, maxPrice: "25.00" },
      { id: "step_pickup", capability: "courier-pickup",
        params: { handling: "standard" },
        assuranceTier: 0, dependsOn: ["step_print"], estimatedDuration: 30, maxPrice: "15.00" },
      { id: "step_frame", capability: "assembly",
        params: { assemblyType: "frame", frameSize: "24x36", frameMaterial: "black-aluminum" },
        assuranceTier: 1, dependsOn: ["step_pickup"], estimatedDuration: 30, maxPrice: "30.00" },
      { id: "step_deliver", capability: "courier-delivery",
        params: { destination: "Frontier Tower, 995 Market St, 4th floor", handling: "fragile" },
        assuranceTier: 0, dependsOn: ["step_frame"], estimatedDuration: 30, maxPrice: "15.00" },
    ],
    settlement: { currency: "USDC", maxBudget: "85.00", payer: userAgent.wallet.address },
    submitter: userAgent.wallet.address, createdAt: new Date().toISOString(),
    tags: ["poster", "print", "frame", "delivery"],
  } as any;

  log("USER", `CWM: "${cwm.name}"`);
  log("USER", `Budget: $${(cwm.settlement as any).maxBudget} USDC`);
  console.log();

  table(
    ["Step", "Capability", "Details", "Tier", "Depends On"],
    [
      ["1. Print", "2d-print", "24x36\" glossy poster", "T1", "--"],
      ["2. Pickup", "courier-pickup", "standard handling", "T0", "Print"],
      ["3. Frame", "assembly", "black aluminum 24x36", "T1", "Pickup"],
      ["4. Deliver", "courier-delivery", "fragile → Frontier Tower", "T0", "Frame"],
    ],
  );

  console.log();
  log("USER", `Print --> Pickup --> Frame --> Deliver`);

  // ═══════════════════════════════════════════════════════════
  // Phase 2: THE MARKETPLACE
  // ═══════════════════════════════════════════════════════════

  banner(2, "THE MARKETPLACE", "Operators come online in SF");

  // Print shops
  const printCap1: Capability = {
    id: ids.capability(), kernelId: "kernel_quickprint",
    type: "2d-print", name: "QuickPrint SOMA",
    materials: ["glossy", "matte", "canvas"], assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "14.00", perMinute: "0.00", minimum: "14.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.7785, lng: -122.3960 }, queueDepth: 0,
  };
  const printCap2: Capability = {
    id: ids.capability(), kernelId: "kernel_fedex",
    type: "2d-print", name: "FedEx Office Market St",
    materials: ["glossy", "matte", "bond"], assuranceTiers: [0],
    pricing: { currency: "USDC", baseCost: "20.00", perMinute: "0.00", minimum: "20.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.7836, lng: -122.4089 }, queueDepth: 1,
  };
  const printCap3: Capability = {
    id: ids.capability(), kernelId: "kernel_printlab",
    type: "2d-print", name: "PrintLab Dogpatch",
    materials: ["glossy", "matte", "fine-art", "canvas"], assuranceTiers: [0, 1, 2],
    pricing: { currency: "USDC", baseCost: "18.00", perMinute: "0.00", minimum: "18.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.7580, lng: -122.3870 }, queueDepth: 0,
  };

  log("PRINT", `Online: ${CYAN}QuickPrint SOMA${RESET} — $14/poster`);
  log("PRINT", `Online: ${CYAN}FedEx Office${RESET} — $20/poster (0.2mi from Frontier Tower)`);
  log("PRINT", `Online: ${CYAN}PrintLab Dogpatch${RESET} — $18/poster (fine art capable)`);
  console.log();

  // Framers
  const frameCap1: Capability = {
    id: ids.capability(), kernelId: "kernel_frameup",
    type: "assembly", name: "FrameUp SF",
    materials: ["aluminum", "wood", "acrylic"], assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "22.00", perMinute: "0.00", minimum: "22.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.7749, lng: -122.4194 }, queueDepth: 0,
  };
  const frameCap2: Capability = {
    id: ids.capability(), kernelId: "kernel_roboframe",
    type: "assembly", name: "RoboFrame Lab (robot-assisted)",
    materials: ["aluminum", "wood"], assuranceTiers: [0, 1, 2],
    pricing: { currency: "USDC", baseCost: "15.00", perMinute: "0.00", minimum: "15.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.7760, lng: -122.4100 }, queueDepth: 0,
    tags: ["robot-arm", "vision-guided", "automated"],
  };

  log("FRAME", `Online: ${GREEN}FrameUp SF${RESET} — Manual framing — $22`);
  log("FRAME", `Online: ${GREEN}RoboFrame Lab${RESET} — Robot-assisted — $15 ${DIM}(vision-guided pick & place)${RESET}`);
  console.log();

  // Couriers
  const courierPickup1: Capability = {
    id: ids.capability(), kernelId: "courier_dash",
    type: "courier-pickup", name: "DashRun Pickup", materials: [],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "7.00", perMinute: "0.00", minimum: "7.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.7749, lng: -122.4194 }, queueDepth: 0,
  };
  const courierDeliver1: Capability = {
    id: ids.capability(), kernelId: "courier_dash",
    type: "courier-delivery", name: "DashRun Delivery", materials: [],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "9.00", perMinute: "0.00", minimum: "9.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.7749, lng: -122.4194 }, queueDepth: 0,
  };
  const courierPickup2: Capability = {
    id: ids.capability(), kernelId: "courier_swift",
    type: "courier-pickup", name: "SwiftShip Pickup", materials: [],
    assuranceTiers: [0],
    pricing: { currency: "USDC", baseCost: "10.00", perMinute: "0.00", minimum: "10.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.7749, lng: -122.4194 }, queueDepth: 0,
  };
  const courierDeliver2: Capability = {
    id: ids.capability(), kernelId: "courier_swift",
    type: "courier-delivery", name: "SwiftShip Delivery", materials: [],
    assuranceTiers: [0],
    pricing: { currency: "USDC", baseCost: "12.00", perMinute: "0.00", minimum: "12.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.7749, lng: -122.4194 }, queueDepth: 0,
  };

  log("COURIER", `Online: ${BLUE}DashRun${RESET} — $7 pickup / $9 delivery`);
  log("COURIER", `Online: ${BLUE}SwiftShip${RESET} — $10 pickup / $12 delivery`);

  // Register all with broker + router
  console.log();
  const brokerAgent = new BrokerAgent(bus);
  brokerAgent.start();

  const router = new CapabilityRouter();
  const allCaps = [
    { kernelId: "kernel_quickprint", capabilities: [printCap1], reputation: 920 },
    { kernelId: "kernel_fedex", capabilities: [printCap2], reputation: 850 },
    { kernelId: "kernel_printlab", capabilities: [printCap3], reputation: 940 },
    { kernelId: "kernel_frameup", capabilities: [frameCap1], reputation: 910 },
    { kernelId: "kernel_roboframe", capabilities: [frameCap2], reputation: 950 },
    { kernelId: "courier_dash", capabilities: [courierPickup1, courierDeliver1], reputation: 900 },
    { kernelId: "courier_swift", capabilities: [courierPickup2, courierDeliver2], reputation: 870 },
  ];
  for (const c of allCaps) { router.registerKernel(c); brokerAgent.registerKernelCapabilities(c.kernelId, c); }

  log("BROKER", `${YELLOW}PCC Broker${RESET} online. 7 operators registered.`);

  console.log();
  table(
    ["Operator", "Type", "Price", "Rep"],
    [
      ["QuickPrint SOMA", "2d-print", "$14", "920"],
      ["FedEx Office", "2d-print", "$20", "850"],
      ["PrintLab Dogpatch", "2d-print", "$18", "940"],
      ["FrameUp SF", "assembly (manual)", "$22", "910"],
      ["RoboFrame Lab", "assembly (robot)", "$15", "950"],
      ["DashRun", "courier", "$7/$9", "900"],
      ["SwiftShip", "courier", "$10/$12", "870"],
    ],
  );

  // ═══════════════════════════════════════════════════════════
  // Phase 3: THE AUCTION
  // ═══════════════════════════════════════════════════════════

  banner(3, "THE AUCTION", "Agents bid on each step");

  const opNames: Record<string, string> = {
    kernel_quickprint: "QuickPrint SOMA", kernel_fedex: "FedEx Office",
    kernel_printlab: "PrintLab Dogpatch", kernel_frameup: "FrameUp SF",
    kernel_roboframe: "RoboFrame Lab", courier_dash: "DashRun", courier_swift: "SwiftShip",
  };

  for (const step of cwm.steps) {
    const matches = await router.findAllMatches(step);
    const label = { step_print: "2D Print", step_pickup: "Courier Pickup", step_frame: "Framing", step_deliver: "Delivery" }[step.id] ?? step.id;
    log("BID", `${BOLD}${label}${RESET} — ${matches.length} bids:`);
    for (const m of matches) {
      log("BID", `    ${opNames[m.kernelId] ?? m.kernelId}: $${m.quotedPrice}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 4: ROUTE OPTIMIZATION
  // ═══════════════════════════════════════════════════════════

  banner(4, "ROUTE OPTIMIZATION", "Broker picks the cheapest valid path");

  const routes = [
    { name: "Route A (cheapest)", print: ["QuickPrint", 14], pickup: ["DashRun", 7], frame: ["RoboFrame", 15], deliver: ["DashRun", 9], total: 45, note: "Robot-assisted framing, fastest" },
    { name: "Route B (premium)", print: ["PrintLab", 18], pickup: ["DashRun", 7], frame: ["FrameUp", 22], deliver: ["DashRun", 9], total: 56, note: "Fine art print, hand framing" },
    { name: "Route C (convenient)", print: ["FedEx", 20], pickup: ["SwiftShip", 10], frame: ["FrameUp", 22], deliver: ["SwiftShip", 12], total: 64, note: "Closest to Frontier Tower" },
  ];

  for (const r of routes) {
    const winner = r.total === 45;
    log("ROUTE", `${BOLD}${r.name}${RESET} = $${r.total}${winner ? ` ${GREEN}${BOLD}** WINNER **${RESET}` : ""}`);
    log("ROUTE", `  Print: ${r.print[0]} ($${r.print[1]}) → Pickup: ${r.pickup[0]} ($${r.pickup[1]}) → Frame: ${r.frame[0]} ($${r.frame[1]}) → Deliver: ${r.deliver[0]} ($${r.deliver[1]})`);
    log("ROUTE", `  ${DIM}${r.note}${RESET}`);
  }

  console.log();
  table(
    ["Route", "Print", "Pickup", "Frame", "Deliver", "TOTAL"],
    [
      [`${BOLD}A: Cheapest${RESET}`, `${BOLD}$14${RESET}`, `${BOLD}$7${RESET}`, `${BOLD}$15${RESET}`, `${BOLD}$9${RESET}`, `${GREEN}${BOLD}$45${RESET}`],
      ["B: Premium", "$18", "$7", "$22", "$9", "$56"],
      ["C: Convenient", "$20", "$10", "$22", "$12", "$64"],
    ],
  );

  console.log();
  log("ROUTE", `${GREEN}${BOLD}Winner: Route A — $45 USDC${RESET}`);
  log("ROUTE", `${DIM}RoboFrame Lab wins framing — robot arm + vision = cheaper & faster${RESET}`);

  // ═══════════════════════════════════════════════════════════
  // Phase 5: ESCROW LOCKS
  // ═══════════════════════════════════════════════════════════

  banner(5, "ESCROW LOCKS", "Funds locked in milestone escrow");

  log("ESCROW", `Total locked: ${GREEN}$45.00 USDC${RESET}`);
  console.log();
  table(
    ["#", "Step", "Operator", "Amount", "Bond"],
    [
      ["1", "print", "QuickPrint SOMA", "$14.00", "$0.70 (5%)"],
      ["2", "pickup", "DashRun", "$7.00", "$0.35 (5%)"],
      ["3", "frame", "RoboFrame Lab", "$15.00", "$0.75 (5%)"],
      ["4", "deliver", "DashRun", "$9.00", "$0.45 (5%)"],
    ],
  );

  // ═══════════════════════════════════════════════════════════
  // Phase 6: EXECUTION — PRINT
  // ═══════════════════════════════════════════════════════════

  banner(6, "EXECUTION — PRINT", "QuickPrint SOMA prints the poster");

  const jobId = ids.job();

  log("PRINT", `${CYAN}QuickPrint SOMA${RESET} receives print job...`);
  log("PRINT", `  Size: 24x36\" | Paper: glossy-premium | Copies: 1`);
  await sleep(400);

  const printEmitter = new EvidenceEmitter("kernel_quickprint");
  const printBundle = await createMockBundle(printEmitter, jobId, "step_print", "kernel_quickprint", 1, [
    { type: "gcode_hash_verified", data: { fileHash: "sha256:poster_design_001", format: "PDF", dpi: 300 } },
    { type: "execution_started", data: { printer: "Epson SureColor P900", media: "glossy-premium-24x36" } },
    { type: "power_profile_summary", data: { totalWh: 12, printTime: "4min" } },
    { type: "camera_snapshot", data: { photo: "sha256:print_qc_snap", colorAccuracy: "deltaE < 2" } },
    { type: "cv_inspection_result", data: { pass: true, edgeBleed: false, colorMatch: 0.98 } },
    { type: "execution_completed", data: { copies: 1, quality: "photo-grade" } },
  ]);

  log("PRINT", `${GREEN}Poster printed!${RESET} Photo-grade quality.`);
  log("EVIDENCE", `Bundle: ${printBundle.id} (${printBundle.events.length} events)`);
  log("ESCROW", `Milestone 1 (print) evidence submitted.`);

  // ═══════════════════════════════════════════════════════════
  // Phase 7: EXECUTION — PICKUP & FRAME
  // ═══════════════════════════════════════════════════════════

  banner(7, "EXECUTION — PICKUP & FRAME", "DashRun picks up → RoboFrame frames it");

  log("COURIER", `${BLUE}DashRun${RESET} picks up poster from QuickPrint SOMA...`);
  await sleep(300);

  const pickupEmitter = new EvidenceEmitter("courier_dash");
  const pickupBundle = await createMockBundle(pickupEmitter, jobId, "step_pickup", "courier_dash", 0, [
    { type: "gcode_hash_verified", data: { item: "poster-24x36", condition: "mint" } },
    { type: "execution_started", data: { origin: "QuickPrint SOMA" } },
    { type: "courier_pickup_confirmed", data: { photo: "sha256:pickup_poster", location: "SOMA" } },
    { type: "custody_handoff_confirmed", data: { from: "QuickPrint SOMA", to: "DashRun" } },
    { type: "execution_completed", data: { status: "picked_up" } },
  ]);

  log("COURIER", `${GREEN}Picked up!${RESET} En route to RoboFrame Lab...`);
  log("ESCROW", `Milestone 2 (pickup) evidence submitted.`);
  await sleep(300);

  // FRAMING — robot-assisted
  log("ROBOT", `${GREEN}RoboFrame Lab${RESET} receives poster...`);
  log("ROBOT", `  Frame: black aluminum, 24x36\"`);
  log("ROBOT", `  ${DIM}Robot arm: vision-guided pick & place${RESET}`);
  log("ROBOT", `  ${DIM}Camera: alignment verification${RESET}`);
  await sleep(500);

  const frameEmitter = new EvidenceEmitter("kernel_roboframe");
  const frameBundle = await createMockBundle(frameEmitter, jobId, "step_frame", "kernel_roboframe", 1, [
    { type: "gcode_hash_verified", data: { frameSpec: "black-aluminum-24x36", posterReceived: true } },
    { type: "execution_started", data: { method: "robot-assisted", armModel: "R2D3-7DOF", gripper: "vacuum-cup" } },
    { type: "camera_snapshot", data: { photo: "sha256:align_check_001", stage: "pre-frame-alignment" } },
    { type: "sensor_data_summary", data: { channel: "force_torque", avgN: 2.1, maxN: 3.8, note: "gentle handling" } },
    { type: "cv_inspection_result", data: { pass: true, alignment: "0.3mm offset", glass: "clean", confidence: 0.97 } },
    { type: "camera_snapshot", data: { photo: "sha256:final_frame_001", stage: "completed-frame" } },
    { type: "execution_completed", data: { quality: "excellent", robotCycles: 1, humanIntervention: false } },
    { type: "power_profile_summary", data: { totalWh: 8.5, armActiveTime: "45s" } },
  ]);

  log("ROBOT", `${GREEN}Framing complete!${RESET} Robot arm: 1 cycle, 0 human intervention.`);
  log("EVIDENCE", `Bundle: ${frameBundle.id} (${frameBundle.events.length} events)`);
  log("EVIDENCE", `  ${DIM}CV inspection: 0.3mm alignment, 97% confidence${RESET}`);
  log("ESCROW", `Milestone 3 (frame) evidence submitted.`);

  // ═══════════════════════════════════════════════════════════
  // Phase 8: EXECUTION — DELIVERY
  // ═══════════════════════════════════════════════════════════

  banner(8, "EXECUTION — DELIVERY", "DashRun delivers to Frontier Tower");

  log("COURIER", `${BLUE}DashRun${RESET} picks up framed poster, headed to Frontier Tower...`);
  await sleep(400);

  const deliverEmitter = new EvidenceEmitter("courier_dash");
  const deliverBundle = await createMockBundle(deliverEmitter, jobId, "step_deliver", "courier_dash", 0, [
    { type: "gcode_hash_verified", data: { item: "framed-poster-24x36", condition: "excellent" } },
    { type: "execution_started", data: { origin: "RoboFrame Lab", destination: "995 Market St, 4th floor" } },
    { type: "courier_delivery_confirmed", data: { recipient: "Frontier Tower 4F", signed: true, photo: "sha256:delivery_ft" } },
    { type: "execution_completed", data: { delivered: true } },
  ]);

  log("COURIER", `${GREEN}Delivered to Frontier Tower, 4th floor!${RESET}`);
  log("EVIDENCE", `Recipient signed. Bundle: ${deliverBundle.id}`);
  log("ESCROW", `Milestone 4 (delivery) evidence submitted.`);

  console.log();
  log("SYSTEM", "Evidence trail:");
  table(
    ["Step", "Events", "Key Evidence"],
    [
      ["Print", `${printBundle.events.length}`, "file hash, color QC (deltaE<2), CV pass"],
      ["Pickup", `${pickupBundle.events.length}`, "photo, custody handoff signed"],
      ["Frame", `${frameBundle.events.length}`, "robot arm telemetry, CV alignment (0.3mm)"],
      ["Deliver", `${deliverBundle.events.length}`, "delivery photo, recipient signed"],
    ],
  );

  // ═══════════════════════════════════════════════════════════
  // Phase 9: SOVEREIGN VERIFICATION
  // ═══════════════════════════════════════════════════════════

  banner(9, "SOVEREIGN VERIFICATION", "Encrypt → Commit → Prove → Verify");

  const encService = new EncryptionService();
  const allBundles = [printBundle, pickupBundle, frameBundle, deliverBundle];

  log("ENCRYPT", `${allBundles.length} bundles encrypted (AES-256-GCM)`);

  for (const bundle of allBundles) {
    await encService.encryptBundle(bundle, [
      userAgent.wallet.address,
      "0x0000000000000000000000000000000000000002" as `0x${string}`,
    ]);
  }

  const commitService = new CommitmentService();
  const commitments = [];
  for (const b of allBundles) commitments.push(await commitService.createCommitment(b.bundleHash));
  const tree = await commitService.buildTree(commitments);

  log("MERKLE", `Tree: ${tree.leafCount} leaves → root: ${tree.root.slice(0, 40)}...`);

  const zkService = new ZKProofService();
  const proof1 = await zkService.proveEvidenceInclusion(tree, 2, frameBundle.bundleHash);
  const v1 = await zkService.verifyProof(proof1);
  log("ZK", `Frame inclusion proof: ${v1 ? `${GREEN}Verified${RESET}` : `${RED}INVALID${RESET}`}`);

  const proof2 = await zkService.proveTierCompliance(frameBundle, 1);
  const v2 = await zkService.verifyProof(proof2);
  log("ZK", `Tier 1 compliance:    ${v2 ? `${GREEN}Verified${RESET}` : `${RED}INVALID${RESET}`}`);

  const bridge = new BittensorSubnetBridge();
  log("SUBNET", `Bittensor: ${bridge.getMetrics().activeMinerCount} miners online`);
  const subnetResult = await bridge.submitForVerification(frameBundle.bundleHash, JSON.stringify(frameBundle), 1);
  log("SUBNET", `Consensus: ${subnetResult.consensusScore} — ${subnetResult.passed ? `${GREEN}PASSED${RESET}` : `${RED}FAILED${RESET}`}`);

  // ═══════════════════════════════════════════════════════════
  // Phase 10: SETTLEMENT
  // ═══════════════════════════════════════════════════════════

  banner(10, "SETTLEMENT", "Funds released to operators");

  for (const s of [
    { op: "QuickPrint SOMA", amt: "$14.00", role: "poster printing" },
    { op: "DashRun", amt: "$16.00", role: "pickup + delivery" },
    { op: "RoboFrame Lab", amt: "$15.00", role: "robot-assisted framing" },
  ]) {
    log("SETTLE", `${GREEN}Released${RESET} ${s.amt} to ${s.op} (${s.role})`);
  }

  console.log();
  const certService = new CapabilityCertificateService();
  const cert = certService.mintCapabilityCertificate({
    kernelDid: "did:pcc:kernel:kernel_roboframe",
    capabilityType: "assembly",
    assuranceTier: 1,
    metadata: { method: "robot-assisted", armModel: "R2D3-7DOF", qualityScore: "0.97" },
  });
  log("CERT", `Soulbound cNFT: ${cert.id} → RoboFrame Lab (assembly Tier 1)`);

  const rewardEngine = new RewardEngine();
  const epoch = rewardEngine.createEpoch(1, "2026-03-01T00:00:00Z", "2026-03-15T00:00:00Z", "500.000000");
  const completed = rewardEngine.completeEpoch(epoch.id, [{
    kernelId: "kernel_roboframe", kernelDid: "did:pcc:kernel:kernel_roboframe",
    jobsCompleted: 1, qualityScore: 0.97, uptimePercent: 99.5, capabilityDiversity: 1, scarcityBonus: 0.9,
  }]);
  log("REWARD", `DePIN: ${completed.kernelScores[0].rewardAmount} PCC tokens → RoboFrame Lab`);

  // ═══════════════════════════════════════════════════════════
  // THE BIG PICTURE
  // ═══════════════════════════════════════════════════════════

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalEvents = allBundles.reduce((sum, b) => sum + b.events.length, 0);

  console.log();
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);
  console.log();

  table(
    ["", ""],
    [
      ["Workflow", "print → pickup → frame → deliver"],
      ["Operators", "3 (QuickPrint, DashRun, RoboFrame)"],
      ["Total cost", `${GREEN}$45.00 USDC${RESET}`],
      ["Evidence events", `${totalEvents}`],
      ["Encrypted bundles", "4 (AES-256-GCM)"],
      ["ZK proofs", "2 (inclusion + compliance)"],
      ["Bittensor consensus", `${subnetResult.consensusScore}`],
      ["Robot arm", "1 framing cycle, 0 human intervention"],
      ["Demo time", `${elapsed}s`],
      ["Middlemen", `${RED}${BOLD}ZERO${RESET}`],
    ],
  );

  console.log();
  console.log(`  ${BOLD}${WHITE}This is PCC. Any task. Any operator. Verified. Settled.${RESET}`);
  console.log(`  ${DIM}Print a poster. Frame it with a robot. Deliver it.${RESET}`);
  console.log(`  ${DIM}Every step has cryptographic evidence. Every operator gets paid.${RESET}`);
  console.log(`  ${DIM}No platform takes a cut. No trust required.${RESET}`);
  console.log();
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);
  console.log();

  userAgent.stop();
  brokerAgent.stop();
}

main().catch((err) => { console.error("\nDemo failed:", err); process.exit(1); });
