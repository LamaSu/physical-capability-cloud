/**
 * Hackathon Demo: "AWS for the Physical World"
 *
 * THE STORY:
 *   A user wants a custom lithophane photo printed, picked up by a courier,
 *   framed at a framing shop, and delivered to a friend's door.
 *   They post the workflow. Agents compete for each sub-task.
 *   The cheapest valid path wins. Escrow locks. Machines execute.
 *   Evidence proves it happened. Funds release. No middleman.
 *
 * Run: npx tsx scripts/hackathon-demo.ts
 */

import { MessageBus } from "@pcc/a2a";
import { UserAgent } from "@pcc/agent-user";
import { BrokerAgent } from "@pcc/agent-broker";
import { KernelAgent } from "@pcc/agent-kernel";
import {
  EvidenceEmitter,
  MockFDMAdapter,
  MockPowerMonitorAdapter,
  MockCameraAdapter,
  JobRunner,
  EncryptionService,
} from "@pcc/kernel";
import {
  CommitmentService,
  ZKProofService,
  EvidenceVerifier,
  BittensorSubnetBridge,
} from "@pcc/verifier";
import { CapabilityCertificateService, RewardEngine } from "@pcc/contracts";
import { WorkflowCompiler, CapabilityRouter } from "@pcc/scheduler";
import type { Capability, CWM, CWMStep, EvidenceBundle, SHA256 } from "@pcc/spec";
import { ids, sha256, hashEvent, hashBundle } from "@pcc/spec";

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

// ── Helpers ───────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function banner(phase: number, title: string, subtitle?: string) {
  const pad = 56;
  const line1 = `  Phase ${phase}: ${title}`;
  console.log();
  console.log(`${BOLD}${MAGENTA}${"\u2554" + "\u2550".repeat(pad) + "\u2557"}${RESET}`);
  console.log(`${BOLD}${MAGENTA}\u2551${RESET}${BOLD}${WHITE}${line1.padEnd(pad)}${RESET}${BOLD}${MAGENTA}\u2551${RESET}`);
  if (subtitle) {
    const line2 = `  ${subtitle}`;
    console.log(`${BOLD}${MAGENTA}\u2551${RESET}${DIM}${line2.padEnd(pad)}${RESET}${BOLD}${MAGENTA}\u2551${RESET}`);
  }
  console.log(`${BOLD}${MAGENTA}${"\u255A" + "\u2550".repeat(pad) + "\u255D"}${RESET}`);
  console.log();
}

function log(tag: string, msg: string) {
  const colors: Record<string, string> = {
    USER: CYAN,
    BROKER: YELLOW,
    KERNEL: GREEN,
    COURIER: BLUE,
    SYSTEM: MAGENTA,
    ESCROW: RED,
    EVIDENCE: GREEN,
    VERIFY: CYAN,
    ENCRYPT: YELLOW,
    MERKLE: MAGENTA,
    ZK: BLUE,
    SUBNET: RED,
    SETTLE: GREEN,
    CERT: YELLOW,
    REWARD: MAGENTA,
    ROUTE: CYAN,
    BID: YELLOW,
    DEMO: WHITE,
  };
  const c = colors[tag] ?? WHITE;
  console.log(`  ${c}[${tag.padEnd(10)}]${RESET} ${msg}`);
}

function table(headers: string[], rows: string[][], colWidths?: number[]) {
  const widths = colWidths ?? headers.map((h, i) => {
    const maxRow = Math.max(...rows.map(r => (r[i] ?? "").length));
    return Math.max(h.length, maxRow) + 2;
  });
  const border = widths.map(w => "\u2500".repeat(w)).join("\u253C");
  const headerLine = headers.map((h, i) => ` ${h.padEnd(widths[i] - 1)}`).join("\u2502");

  console.log(`  ${DIM}\u250C${widths.map(w => "\u2500".repeat(w)).join("\u252C")}\u2510${RESET}`);
  console.log(`  ${DIM}\u2502${RESET}${BOLD}${headerLine}${RESET}${DIM}\u2502${RESET}`);
  console.log(`  ${DIM}\u251C${border}\u2524${RESET}`);
  for (const row of rows) {
    const line = row.map((cell, i) => ` ${cell.padEnd(widths[i] - 1)}`).join(`${DIM}\u2502${RESET}`);
    console.log(`  ${DIM}\u2502${RESET}${line}${DIM}\u2502${RESET}`);
  }
  console.log(`  ${DIM}\u2514${widths.map(w => "\u2500".repeat(w)).join("\u2534")}\u2518${RESET}`);
}

// ── Mock evidence helper for non-FDM steps ────────────────────
async function createMockBundle(
  emitter: EvidenceEmitter,
  jobId: string,
  stepId: string,
  kernelId: string,
  tier: 0 | 1 | 2 | 3,
  eventTypes: Array<{ type: string; data: Record<string, unknown> }>,
): Promise<EvidenceBundle> {
  emitter.registerStep(jobId, stepId, tier);
  for (const evt of eventTypes) {
    await emitter.addEvent(jobId, stepId, {
      type: evt.type as any,
      timestamp: new Date().toISOString(),
      source: {
        deviceId: `dev-${stepId}`,
        deviceType: "controller" as any,
        kernelId,
      },
      payload: evt.data,
    });
  }
  return emitter.finalizeBundle(jobId, stepId);
}

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();

  console.log();
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);
  console.log(`${BOLD}${WHITE}    PHYSICAL CAPABILITY CLOUD${RESET}`);
  console.log(`${BOLD}${WHITE}    "AWS for the Physical World"${RESET}`);
  console.log(`${DIM}    Hackathon Demo - Funding the Commons SF${RESET}`);
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);
  console.log();
  console.log(`${DIM}  Story: A lithophane photo gift, printed, picked up,${RESET}`);
  console.log(`${DIM}  framed, and delivered -- orchestrated by agents,${RESET}`);
  console.log(`${DIM}  verified by evidence, settled on-chain.${RESET}`);
  console.log(`${DIM}  No middleman. No trust required.${RESET}`);

  // ════════════════════════════════════════════════════════════════
  // Phase 1: THE REQUEST
  // ════════════════════════════════════════════════════════════════

  banner(1, "THE REQUEST", "User posts a multi-step manufacturing workflow");

  const bus = new MessageBus();

  log("SYSTEM", "Creating message bus...");
  log("SYSTEM", "User agent comes online with a wallet...");

  const userAgent = new UserAgent(bus);
  userAgent.start();
  log("USER", `Online: ${userAgent.name}`);
  log("USER", `Wallet: ${userAgent.wallet.address}`);

  // Build the CWM
  const cwm: CWM = {
    version: "1.0",
    id: ids.cwm(),
    name: "Lithophane Photo Gift",
    description: "Print a lithophane, pick up, frame it, deliver to friend",
    steps: [
      {
        id: "step_print",
        capability: "fdm",
        params: { material: "pla", infill: 40, layerHeight: 0.2 },
        assuranceTier: 1,
        dependsOn: [],
        estimatedDuration: 90, // minutes
        maxPrice: "25.00",
      },
      {
        id: "step_pickup",
        capability: "courier-pickup",
        params: { handling: "fragile" },
        assuranceTier: 0,
        dependsOn: ["step_print"],
        estimatedDuration: 30,
        maxPrice: "15.00",
      },
      {
        id: "step_frame",
        capability: "assembly",
        params: { assemblyType: "frame", frameSize: "8x10", frameMaterial: "walnut" },
        assuranceTier: 1,
        dependsOn: ["step_pickup"],
        estimatedDuration: 45,
        maxPrice: "20.00",
      },
      {
        id: "step_deliver",
        capability: "courier-delivery",
        params: { handling: "fragile", priority: "standard" },
        assuranceTier: 0,
        dependsOn: ["step_frame"],
        estimatedDuration: 60,
        maxPrice: "20.00",
      },
    ],
    settlement: {
      currency: "USDC",
      maxBudget: "75.00",
      payer: userAgent.wallet.address,
    },
    submitter: userAgent.wallet.address,
    createdAt: new Date().toISOString(),
    tags: ["lithophane", "gift", "fdm", "courier", "assembly"],
  } as any;

  log("USER", `CWM created: "${cwm.name}"`);
  log("USER", `  ID: ${cwm.id}`);
  log("USER", `  Budget: $${(cwm.settlement as any).maxBudget} USDC`);
  console.log();
  log("USER", "Workflow steps:");

  table(
    ["Step", "Capability", "Params", "Tier", "Depends On"],
    [
      ["1. Print", "fdm", "PLA, 40% infill, 0.2mm", "T1", "--"],
      ["2. Pickup", "courier-pickup", "fragile handling", "T0", "Print"],
      ["3. Frame", "assembly", "walnut 8x10 frame", "T1", "Pickup"],
      ["4. Deliver", "courier-delivery", "standard, fragile", "T0", "Frame"],
    ],
  );

  console.log();
  log("USER", `Workflow graph: Print --> Pickup --> Frame --> Deliver`);

  // ════════════════════════════════════════════════════════════════
  // Phase 2: THE MARKETPLACE
  // ════════════════════════════════════════════════════════════════

  banner(2, "THE MARKETPLACE", "Agents come online with their capabilities");

  // Kernel 1: MakerSpace NYC
  const fdmCapNYC: Capability = {
    id: ids.capability(),
    kernelId: "kernel_nyc_001",
    type: "fdm",
    name: "Prusa MK4 (NYC)",
    description: "Professional FDM, 0.1mm resolution",
    materials: ["pla", "petg", "abs"],
    assuranceTiers: [0, 1, 2],
    pricing: { currency: "USDC", baseCost: "8.00", perMinute: "0.11", minimum: "18.00" },
    availability: { timezone: "America/New_York", windows: {} },
    location: { lat: 40.7128, lng: -74.006 },
    queueDepth: 2,
  };

  const kernelNYC = new KernelAgent(bus, {
    kernelId: "kernel_nyc_001",
    name: "MakerSpace NYC",
    location: { lat: 40.7128, lng: -74.006 },
    capabilities: [fdmCapNYC],
    mockPrintDuration: 1500,
  });
  kernelNYC.start();
  log("KERNEL", `Online: ${GREEN}MakerSpace NYC${RESET} -- FDM (Prusa MK4) -- $18/print`);

  // Kernel 2: PrintFarm LA
  const fdmCapLA: Capability = {
    id: ids.capability(),
    kernelId: "kernel_la_002",
    type: "fdm",
    name: "Bambu X1 Carbon (LA)",
    materials: ["pla", "petg", "tpu"],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "5.00", perMinute: "0.08", minimum: "12.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 34.0522, lng: -118.2437 },
    queueDepth: 0,
  };

  const kernelLA = new KernelAgent(bus, {
    kernelId: "kernel_la_002",
    name: "PrintFarm LA",
    location: { lat: 34.0522, lng: -118.2437 },
    capabilities: [fdmCapLA],
    mockPrintDuration: 1500,
  });
  kernelLA.start();
  log("KERNEL", `Online: ${GREEN}PrintFarm LA${RESET} -- FDM (Bambu X1) -- $12/print`);

  // Kernel 3: BioLab SF (FDM + assembly)
  const fdmCapSF: Capability = {
    id: ids.capability(),
    kernelId: "kernel_sf_003",
    type: "fdm",
    name: "Prusa XL (SF)",
    materials: ["pla", "petg"],
    assuranceTiers: [0, 1, 2],
    pricing: { currency: "USDC", baseCost: "10.00", perMinute: "0.13", minimum: "22.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.7749, lng: -122.4194 },
    queueDepth: 1,
  };

  const assemblyCapSF: Capability = {
    id: ids.capability(),
    kernelId: "kernel_sf_003",
    type: "assembly",
    name: "Manual Assembly (SF)",
    materials: ["wood", "metal", "acrylic"],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "15.00", perMinute: "0.00", minimum: "15.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.7749, lng: -122.4194 },
    queueDepth: 0,
  };

  const kernelSF = new KernelAgent(bus, {
    kernelId: "kernel_sf_003",
    name: "BioLab SF",
    location: { lat: 37.7749, lng: -122.4194 },
    capabilities: [fdmCapSF, assemblyCapSF],
    mockPrintDuration: 1500,
  });
  kernelSF.start();
  log("KERNEL", `Online: ${GREEN}BioLab SF${RESET} -- FDM ($22) + Assembly ($15)`);

  console.log();

  // Courier capabilities (we model these as kernels with courier-type capabilities)
  const courierPickupSwift: Capability = {
    id: ids.capability(),
    kernelId: "courier_swift_001",
    type: "courier-pickup",
    name: "SwiftShip Pickup",
    materials: [],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "8.00", perMinute: "0.00", minimum: "8.00" },
    availability: { timezone: "America/New_York", windows: {} },
    location: { lat: 40.7128, lng: -74.006 },
    queueDepth: 0,
    tags: ["NYC", "SF"],
  };

  const courierDeliverySwift: Capability = {
    id: ids.capability(),
    kernelId: "courier_swift_001",
    type: "courier-delivery",
    name: "SwiftShip Delivery",
    materials: [],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "12.00", perMinute: "0.00", minimum: "12.00" },
    availability: { timezone: "America/New_York", windows: {} },
    location: { lat: 40.7128, lng: -74.006 },
    queueDepth: 0,
    tags: ["NYC", "SF"],
  };

  log("COURIER", `Online: ${BLUE}SwiftShip${RESET} -- Pickup $8, Delivery $12 (NYC+SF)`);

  const courierPickupQuick: Capability = {
    id: ids.capability(),
    kernelId: "courier_quick_002",
    type: "courier-pickup",
    name: "QuickRun Pickup",
    materials: [],
    assuranceTiers: [0],
    pricing: { currency: "USDC", baseCost: "6.00", perMinute: "0.00", minimum: "6.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 34.0522, lng: -118.2437 },
    queueDepth: 0,
    tags: ["LA", "SF", "NYC"],
  };

  const courierDeliveryQuick: Capability = {
    id: ids.capability(),
    kernelId: "courier_quick_002",
    type: "courier-delivery",
    name: "QuickRun Delivery",
    materials: [],
    assuranceTiers: [0],
    pricing: { currency: "USDC", baseCost: "15.00", perMinute: "0.00", minimum: "15.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 34.0522, lng: -118.2437 },
    queueDepth: 0,
    tags: ["LA", "SF", "NYC"],
  };

  log("COURIER", `Online: ${BLUE}QuickRun${RESET} -- Pickup $6, Delivery $15 (LA+SF+NYC)`);

  // Independent framer
  const assemblyCapIndie: Capability = {
    id: ids.capability(),
    kernelId: "kernel_indie_framer",
    type: "assembly",
    name: "Indie Framer (SF)",
    materials: ["wood", "metal"],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "10.00", perMinute: "0.00", minimum: "10.00" },
    availability: { timezone: "America/Los_Angeles", windows: {} },
    location: { lat: 37.78, lng: -122.41 },
    queueDepth: 0,
  };

  log("KERNEL", `Online: ${GREEN}Indie Framer SF${RESET} -- Assembly $10`);

  // Broker
  const brokerAgent = new BrokerAgent(bus);
  brokerAgent.start();
  log("BROKER", `Online: ${YELLOW}${brokerAgent.name}${RESET}`);

  // Register all capabilities with broker
  brokerAgent.registerKernelCapabilities(kernelNYC.id, {
    kernelId: "kernel_nyc_001", capabilities: [fdmCapNYC], reputation: 950,
  });
  brokerAgent.registerKernelCapabilities(kernelLA.id, {
    kernelId: "kernel_la_002", capabilities: [fdmCapLA], reputation: 920,
  });
  brokerAgent.registerKernelCapabilities(kernelSF.id, {
    kernelId: "kernel_sf_003", capabilities: [fdmCapSF, assemblyCapSF], reputation: 880,
  });
  brokerAgent.registerKernelCapabilities("courier_swift_001", {
    kernelId: "courier_swift_001", capabilities: [courierPickupSwift, courierDeliverySwift], reputation: 900,
  });
  brokerAgent.registerKernelCapabilities("courier_quick_002", {
    kernelId: "courier_quick_002", capabilities: [courierPickupQuick, courierDeliveryQuick], reputation: 870,
  });
  brokerAgent.registerKernelCapabilities("kernel_indie_framer", {
    kernelId: "kernel_indie_framer", capabilities: [assemblyCapIndie], reputation: 910,
  });

  log("BROKER", "All 6 operators registered. Marketplace ready.");

  console.log();
  table(
    ["Operator", "Location", "Capabilities", "Rep"],
    [
      ["MakerSpace NYC", "NYC", "FDM ($18)", "950"],
      ["PrintFarm LA", "LA", "FDM ($12)", "920"],
      ["BioLab SF", "SF", "FDM ($22) + Assembly ($15)", "880"],
      ["SwiftShip", "NYC+SF", "Pickup ($8) + Delivery ($12)", "900"],
      ["QuickRun", "LA+SF+NYC", "Pickup ($6) + Delivery ($15)", "870"],
      ["Indie Framer", "SF", "Assembly ($10)", "910"],
    ],
  );

  // ════════════════════════════════════════════════════════════════
  // Phase 3: THE AUCTION
  // ════════════════════════════════════════════════════════════════

  banner(3, "THE AUCTION", "Agents bid on each workflow step");

  // Use CapabilityRouter to find all matches per step
  const router = new CapabilityRouter();
  router.registerKernel({ kernelId: "kernel_nyc_001", capabilities: [fdmCapNYC], reputation: 950 });
  router.registerKernel({ kernelId: "kernel_la_002", capabilities: [fdmCapLA], reputation: 920 });
  router.registerKernel({ kernelId: "kernel_sf_003", capabilities: [fdmCapSF, assemblyCapSF], reputation: 880 });
  router.registerKernel({ kernelId: "courier_swift_001", capabilities: [courierPickupSwift, courierDeliverySwift], reputation: 900 });
  router.registerKernel({ kernelId: "courier_quick_002", capabilities: [courierPickupQuick, courierDeliveryQuick], reputation: 870 });
  router.registerKernel({ kernelId: "kernel_indie_framer", capabilities: [assemblyCapIndie], reputation: 910 });

  const stepNames: Record<string, string> = {
    step_print: "FDM Print",
    step_pickup: "Courier Pickup",
    step_frame: "Assembly/Frame",
    step_deliver: "Courier Delivery",
  };

  const allBids: Record<string, Array<{ operator: string; price: string }>> = {};

  for (const step of cwm.steps) {
    const matches = await router.findAllMatches(step);
    log("BID", `${BOLD}${stepNames[step.id]}${RESET} -- ${matches.length} bids:`);
    allBids[step.id] = [];
    for (const m of matches) {
      const opName = {
        kernel_nyc_001: "MakerSpace NYC",
        kernel_la_002: "PrintFarm LA",
        kernel_sf_003: "BioLab SF",
        courier_swift_001: "SwiftShip",
        courier_quick_002: "QuickRun",
        kernel_indie_framer: "Indie Framer",
      }[m.kernelId] ?? m.kernelId;
      log("BID", `    ${opName}: $${m.quotedPrice}`);
      allBids[step.id].push({ operator: opName, price: m.quotedPrice });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Phase 4: ROUTE OPTIMIZATION
  // ════════════════════════════════════════════════════════════════

  banner(4, "ROUTE OPTIMIZATION", "Broker finds the cheapest valid path");

  // Define 3 candidate routes manually for narrative purposes
  interface Route {
    name: string;
    steps: Array<{ step: string; operator: string; price: number }>;
    total: number;
    note: string;
  }

  const routes: Route[] = [
    {
      name: "Route A (NYC start)",
      steps: [
        { step: "Print", operator: "MakerSpace NYC", price: 18 },
        { step: "Pickup", operator: "SwiftShip", price: 8 },
        { step: "Frame", operator: "BioLab SF", price: 15 },
        { step: "Deliver", operator: "SwiftShip", price: 12 },
      ],
      total: 53,
      note: "Cross-country shipping NYC->SF",
    },
    {
      name: "Route B (LA start)",
      steps: [
        { step: "Print", operator: "PrintFarm LA", price: 12 },
        { step: "Pickup", operator: "QuickRun", price: 6 },
        { step: "Frame", operator: "Indie Framer SF", price: 10 },
        { step: "Deliver", operator: "QuickRun", price: 15 },
      ],
      total: 43,
      note: "Short hop LA->SF",
    },
    {
      name: "Route C (SF only)",
      steps: [
        { step: "Print", operator: "BioLab SF", price: 22 },
        { step: "Pickup", operator: "SwiftShip", price: 8 },
        { step: "Frame", operator: "Indie Framer SF", price: 10 },
        { step: "Deliver", operator: "SwiftShip", price: 12 },
      ],
      total: 52,
      note: "Same city, fewer logistics",
    },
  ];

  for (const route of routes) {
    const isWinner = route.total === 43;
    const marker = isWinner ? `${GREEN}${BOLD} ** WINNER **${RESET}` : "";
    log("ROUTE", `${BOLD}${route.name}${RESET} = $${route.total}${marker}`);
    for (const s of route.steps) {
      log("ROUTE", `  ${s.step}: ${s.operator} ($${s.price})`);
    }
    log("ROUTE", `  ${DIM}${route.note}${RESET}`);
    console.log();
  }

  console.log();
  table(
    ["Route", "Print", "Pickup", "Frame", "Deliver", "TOTAL"],
    [
      ["A: NYC", "$18", "$8", "$15", "$12", "$53"],
      [`${BOLD}B: LA${RESET}`, `${BOLD}$12${RESET}`, `${BOLD}$6${RESET}`, `${BOLD}$10${RESET}`, `${BOLD}$15${RESET}`, `${GREEN}${BOLD}$43${RESET}`],
      ["C: SF", "$22", "$8", "$10", "$12", "$52"],
    ],
  );

  console.log();
  log("ROUTE", `${GREEN}${BOLD}Winner: Route B -- $43 USDC (cheapest valid path)${RESET}`);

  // ════════════════════════════════════════════════════════════════
  // Phase 5: ESCROW LOCKS
  // ════════════════════════════════════════════════════════════════

  banner(5, "ESCROW LOCKS", "Funds locked in milestone escrow");

  const escrowAddress = `0x${"E5CR0W".padStart(40, "0")}` as `0x${string}`;
  const milestones = [
    { step: "step_print", operator: "PrintFarm LA", amount: "12.00", bond: "0.60" },
    { step: "step_pickup", operator: "QuickRun", amount: "6.00", bond: "0.30" },
    { step: "step_frame", operator: "Indie Framer", amount: "10.00", bond: "0.50" },
    { step: "step_deliver", operator: "QuickRun", amount: "15.00", bond: "0.75" },
  ];

  log("ESCROW", `Contract: ${escrowAddress}`);
  log("ESCROW", `Total locked: ${GREEN}$43.00 USDC${RESET}`);
  log("ESCROW", `Milestones: 4`);
  console.log();

  table(
    ["#", "Step", "Operator", "Amount", "Bond (5%)"],
    milestones.map((m, i) => [
      `${i + 1}`,
      m.step.replace("step_", ""),
      m.operator,
      `$${m.amount}`,
      `$${m.bond}`,
    ]),
  );

  console.log();
  log("ESCROW", `${DIM}Challenge window: 24h (Tier 1) / 12h (Tier 0)${RESET}`);

  // ════════════════════════════════════════════════════════════════
  // Phase 6: EXECUTION -- THE PRINT
  // ════════════════════════════════════════════════════════════════

  banner(6, "EXECUTION -- THE PRINT", "PrintFarm LA runs the FDM job");

  const KERNEL_LA = "kernel_la_002";
  const fdm = new MockFDMAdapter("dev-fdm-la", KERNEL_LA, 1_500);
  const power = new MockPowerMonitorAdapter("dev-power-la", KERNEL_LA);
  const camera = new MockCameraAdapter("dev-cam-la", KERNEL_LA, 1.0);
  const emitter = new EvidenceEmitter(KERNEL_LA);

  let printBundle: EvidenceBundle | null = null;
  emitter.onBundle((b) => { printBundle = b; });

  const runner = new JobRunner(fdm, [power], camera, emitter);
  const printJobId = ids.job();

  log("KERNEL", `PrintFarm LA executing FDM print...`);
  log("KERNEL", `  Material: PLA | Infill: 40% | Layer: 0.2mm`);
  log("KERNEL", `  G-code hash: sha256:litho_gcode_abc123...`);
  log("KERNEL", `  Printer: Bambu X1 Carbon`);

  const printResult = await runner.run({
    jobId: printJobId,
    stepId: "step_print",
    gcodeHash: "sha256:litho_gcode_abc123def456" as SHA256,
    assuranceTier: 1,
    gcodeData: "G28\nG1 X50 Y50 Z0.2 F3000\nG1 X150 E10\n; lithophane layer 1\n",
  });

  log("KERNEL", `${GREEN}Print complete!${RESET}`);
  log("EVIDENCE", `Success: ${printResult.success}`);
  log("EVIDENCE", `Duration: ${printResult.durationMs}ms`);
  log("EVIDENCE", `Bundle: ${printResult.bundleId}`);
  log("EVIDENCE", `Hash: ${printResult.bundleHash?.slice(0, 40)}...`);

  if (printBundle) {
    const b = printBundle as EvidenceBundle;
    log("EVIDENCE", `Events collected: ${b.events.length}`);
    for (const e of b.events) {
      log("EVIDENCE", `  ${DIM}${e.type}${RESET}`);
    }
  }

  log("ESCROW", `Milestone 1 (print) evidence submitted. Challenge window open.`);

  // ════════════════════════════════════════════════════════════════
  // Phase 7: EXECUTION -- THE JOURNEY
  // ════════════════════════════════════════════════════════════════

  banner(7, "EXECUTION -- THE JOURNEY", "Courier pickup -> Frame -> Deliver");

  // Step 2: Courier pickup
  log("COURIER", `${BLUE}QuickRun${RESET} dispatched to PrintFarm LA...`);
  await sleep(300);

  const pickupEmitter = new EvidenceEmitter("courier_quick_002");
  const pickupBundle = await createMockBundle(pickupEmitter, printJobId, "step_pickup", "courier_quick_002", 0, [
    { type: "courier_pickup_confirmed", data: { location: "PrintFarm LA", timestamp: new Date().toISOString(), photo_hash: "sha256:pickup_photo_001" } },
    { type: "custody_handoff_confirmed", data: { from: "PrintFarm LA", to: "QuickRun", item: "lithophane_print" } },
    { type: "execution_completed", data: { status: "picked_up" } },
    { type: "gcode_hash_verified", data: { verified: true } },
  ]);

  log("COURIER", `${GREEN}Picked up from PrintFarm LA${RESET}`);
  log("EVIDENCE", `Pickup bundle: ${pickupBundle.id}`);
  log("EVIDENCE", `  Events: ${pickupBundle.events.map(e => e.type).join(", ")}`);
  log("ESCROW", `Milestone 2 (pickup) evidence submitted.`);

  await sleep(300);

  // Step 3: Assembly/framing
  log("KERNEL", `${GREEN}Indie Framer SF${RESET} begins walnut frame assembly...`);
  await sleep(400);

  const frameEmitter = new EvidenceEmitter("kernel_indie_framer");
  const frameBundle = await createMockBundle(frameEmitter, printJobId, "step_frame", "kernel_indie_framer", 1, [
    { type: "gcode_hash_verified", data: { verified: true, item: "lithophane_received" } },
    { type: "execution_started", data: { task: "walnut_frame_assembly", operator: "human" } },
    { type: "camera_snapshot", data: { photo_hash: "sha256:frame_progress_001", stage: "mid_assembly" } },
    { type: "cv_inspection_result", data: { pass: true, confidence: 0.96, defects: [] } },
    { type: "execution_completed", data: { task: "framing_complete", quality: "excellent" } },
    { type: "power_profile_summary", data: { totalWh: 0.5, note: "hand tools only" } },
  ]);

  log("KERNEL", `${GREEN}Frame assembly complete!${RESET}`);
  log("EVIDENCE", `Frame bundle: ${frameBundle.id}`);
  log("EVIDENCE", `  Events: ${frameBundle.events.length} (incl. camera + CV inspection)`);
  log("EVIDENCE", `  Human-verified: photo evidence + CV pass (96% confidence)`);
  log("ESCROW", `Milestone 3 (frame) evidence submitted.`);

  await sleep(300);

  // Step 4: Courier delivery
  log("COURIER", `${BLUE}QuickRun${RESET} picks up framed piece, en route to delivery...`);
  await sleep(400);

  const deliverEmitter = new EvidenceEmitter("courier_quick_002");
  const deliverBundle = await createMockBundle(deliverEmitter, printJobId, "step_deliver", "courier_quick_002", 0, [
    { type: "custody_handoff_confirmed", data: { from: "Indie Framer SF", to: "QuickRun", item: "framed_lithophane" } },
    { type: "courier_delivery_confirmed", data: { recipient: "friend_address_sf", signed: true, timestamp: new Date().toISOString() } },
    { type: "execution_completed", data: { status: "delivered" } },
    { type: "gcode_hash_verified", data: { verified: true } },
  ]);

  log("COURIER", `${GREEN}Delivered to recipient!${RESET}`);
  log("EVIDENCE", `Delivery bundle: ${deliverBundle.id}`);
  log("EVIDENCE", `  Recipient signed: yes`);
  log("ESCROW", `Milestone 4 (delivery) evidence submitted.`);

  console.log();
  log("SYSTEM", "Evidence trail for entire workflow:");
  table(
    ["Step", "Events", "Key Evidence"],
    [
      ["Print", `${printBundle ? (printBundle as EvidenceBundle).events.length : 0}`, "gcode_verified, power_profile, cv_inspection"],
      ["Pickup", `${pickupBundle.events.length}`, "courier_pickup, custody_handoff"],
      ["Frame", `${frameBundle.events.length}`, "camera_snapshot, cv_inspection (96%)"],
      ["Deliver", `${deliverBundle.events.length}`, "courier_delivery, recipient_signed"],
    ],
  );

  // ════════════════════════════════════════════════════════════════
  // Phase 8: SOVEREIGN VERIFICATION
  // ════════════════════════════════════════════════════════════════

  banner(8, "SOVEREIGN VERIFICATION", "Encrypt, commit, prove, verify");

  // Encrypt all 4 bundles
  const encService = new EncryptionService();
  const allBundles = [printBundle!, pickupBundle, frameBundle, deliverBundle];

  log("ENCRYPT", `Encrypting ${allBundles.length} evidence bundles (AES-256-GCM)...`);
  const encryptedBundles = [];
  for (const bundle of allBundles) {
    const encrypted = await encService.encryptBundle(bundle, [
      userAgent.wallet.address,
      "0x0000000000000000000000000000000000000002" as `0x${string}`,
    ]);
    encryptedBundles.push(encrypted);
    log("ENCRYPT", `  ${DIM}${bundle.stepId}: ciphertext ${encrypted.ciphertext.length} chars, ${encrypted.capsules.length} recipients${RESET}`);
  }

  // IPFS archival (mocked -- Helia is ESM-only)
  console.log();
  log("SYSTEM", `${DIM}IPFS archival: [skipped -- Helia ESM-only in tsx]${RESET}`);
  log("SYSTEM", `${DIM}In production: each bundle gets a content-addressed CID on IPFS${RESET}`);

  // Merkle tree
  console.log();
  const commitService = new CommitmentService();

  const commitments = [];
  for (const bundle of allBundles) {
    const commitment = await commitService.createCommitment(bundle.bundleHash);
    commitments.push(commitment);
  }
  const tree = await commitService.buildTree(commitments);

  log("MERKLE", `Tree built from ${allBundles.length} evidence bundles`);
  log("MERKLE", `  Root:   ${tree.root.slice(0, 40)}...`);
  log("MERKLE", `  Depth:  ${tree.depth}`);
  log("MERKLE", `  Leaves: ${tree.leafCount}`);

  // ZK proof for the print step
  console.log();
  const zkService = new ZKProofService();
  log("ZK", "Generating ZK inclusion proof for print step...");

  const inclusionProof = await zkService.proveEvidenceInclusion(tree, 0, printBundle!.bundleHash);
  log("ZK", `  Proof ID:    ${inclusionProof.id}`);
  log("ZK", `  Type:        ${inclusionProof.proofType}`);
  log("ZK", `  Inputs:      ${inclusionProof.publicInputs.length}`);

  const proofValid = await zkService.verifyProof(inclusionProof);
  log("ZK", `  ${proofValid ? `${GREEN}Verified!${RESET}` : `${RED}INVALID${RESET}`}`);

  // Tier compliance proof
  const tierProof = await zkService.proveTierCompliance(printBundle!, 1);
  const tierValid = await zkService.verifyProof(tierProof);
  log("ZK", `  Tier 1 compliance: ${tierValid ? `${GREEN}Verified!${RESET}` : `${RED}INVALID${RESET}`}`);

  // Bittensor subnet
  console.log();
  const bridge = new BittensorSubnetBridge();
  log("SUBNET", `Bittensor subnet: ${bridge.isAvailable() ? `${GREEN}ONLINE${RESET}` : `${RED}OFFLINE${RESET}`}`);
  log("SUBNET", `Active miners: ${bridge.getMetrics().activeMinerCount}`);
  log("SUBNET", "Submitting print evidence for decentralized verification...");

  const subnetResult = await bridge.submitForVerification(
    printBundle!.bundleHash,
    JSON.stringify(printBundle),
    1,
  );

  log("SUBNET", `  Consensus score: ${subnetResult.consensusScore}`);
  log("SUBNET", `  Miners queried:  ${subnetResult.minerCount}`);
  log("SUBNET", `  Tier compliant:  ${subnetResult.tierCompliant ? `${GREEN}yes${RESET}` : `${RED}no${RESET}`}`);
  log("SUBNET", `  Defects:         ${subnetResult.defects.length === 0 ? "none" : subnetResult.defects.join(", ")}`);
  log("SUBNET", `  Verdict:         ${subnetResult.passed ? `${GREEN}PASSED${RESET}` : `${RED}FAILED${RESET}`}`);

  // ════════════════════════════════════════════════════════════════
  // Phase 9: SETTLEMENT
  // ════════════════════════════════════════════════════════════════

  banner(9, "SETTLEMENT", "Evidence verified -- funds released to operators");

  const settlements = [
    { operator: "PrintFarm LA", amount: "$12.00", wallet: kernelLA.wallet.address },
    { operator: "QuickRun", amount: "$21.00", wallet: "QuickRun_wallet_0xQR..." },
    { operator: "Indie Framer", amount: "$10.00", wallet: "IndieFr_wallet_0xIF..." },
  ];

  for (const s of settlements) {
    log("SETTLE", `${GREEN}Released${RESET} ${s.amount} to ${s.operator}`);
  }

  console.log();

  // cNFT for PrintFarm LA
  const certService = new CapabilityCertificateService();
  log("CERT", "Minting soulbound capability certificate for PrintFarm LA...");

  const cert = certService.mintCapabilityCertificate({
    kernelDid: "did:pcc:kernel:kernel_la_002",
    capabilityType: "fdm",
    assuranceTier: 1,
    metadata: {
      materials: ["PLA"],
      jobCompleted: printJobId,
      qualityScore: "0.96",
    },
  });

  log("CERT", `  Certificate: ${cert.id}`);
  log("CERT", `  Capability:  fdm (Tier 1)`);
  log("CERT", `  Soulbound:   ${cert.soulbound ? `${GREEN}yes${RESET}` : "no"}`);
  log("CERT", `  Status:      ${cert.status}`);

  // DePIN reward epoch
  console.log();
  const rewardEngine = new RewardEngine();
  const epoch = rewardEngine.createEpoch(1, "2026-03-01T00:00:00Z", "2026-03-14T00:00:00Z", "500.000000");

  log("REWARD", `DePIN epoch #1 created: ${epoch.totalRewards} PCC tokens`);

  const completedEpoch = rewardEngine.completeEpoch(epoch.id, [
    {
      kernelId: KERNEL_LA,
      kernelDid: "did:pcc:kernel:kernel_la_002",
      jobsCompleted: 1,
      qualityScore: 0.96,
      uptimePercent: 99.8,
      capabilityDiversity: 1,
      scarcityBonus: 0.7,
    },
  ]);

  const score = completedEpoch.kernelScores[0];
  log("REWARD", `  PrintFarm LA score: ${score.totalScore.toFixed(4)}`);
  log("REWARD", `  Reward: ${score.rewardAmount} PCC tokens`);

  // ════════════════════════════════════════════════════════════════
  // Phase 10: THE BIG PICTURE
  // ════════════════════════════════════════════════════════════════

  banner(10, "THE BIG PICTURE", "What just happened");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalEvents = allBundles.reduce((sum, b) => sum + b.events.length, 0);

  console.log();
  table(
    ["Metric", "Value"],
    [
      ["Workflow steps", "4 (print -> pickup -> frame -> deliver)"],
      ["Operators involved", "3 (PrintFarm LA, QuickRun, Indie Framer)"],
      ["Cities", "2 (Los Angeles, San Francisco)"],
      ["Total cost", "$43.00 USDC"],
      ["Real-world time", "~4 hours (simulated)"],
      ["Demo time", `${elapsed} seconds`],
      ["Evidence events", `${totalEvents}`],
      ["Encrypted bundles", "4 (AES-256-GCM)"],
      ["Merkle commitments", "4"],
      ["ZK proofs", "2 (inclusion + tier compliance)"],
      ["Bittensor miners", `${subnetResult.minerCount} (consensus: ${subnetResult.consensusScore})`],
      ["Soulbound cNFTs", "1 (PrintFarm LA)"],
      ["DePIN rewards", `${score.rewardAmount} PCC tokens`],
      ["Middlemen", `${RED}${BOLD}ZERO${RESET}`],
    ],
  );

  console.log();
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);
  console.log();
  console.log(`  ${BOLD}${WHITE}This is AWS for the physical world.${RESET}`);
  console.log();
  console.log(`  ${CYAN}Any task.${RESET} ${GREEN}Any city.${RESET} ${YELLOW}Any operator.${RESET}`);
  console.log(`  ${MAGENTA}Verified.${RESET} ${BLUE}Settled.${RESET} ${RED}Trustless.${RESET}`);
  console.log();
  console.log(`  ${DIM}Capabilities are the compute units.${RESET}`);
  console.log(`  ${DIM}Shop Kernels are the availability zones.${RESET}`);
  console.log(`  ${DIM}Evidence bundles are the receipts.${RESET}`);
  console.log(`  ${DIM}Escrow is the settlement layer.${RESET}`);
  console.log(`  ${DIM}Agents are the API.${RESET}`);
  console.log();
  console.log(`  ${BOLD}${WHITE}No platform. No middleman. Just physics + math + money.${RESET}`);
  console.log();
  console.log(`${BOLD}${MAGENTA}${"=".repeat(60)}${RESET}`);
  console.log();

  // Cleanup
  userAgent.stop();
  brokerAgent.stop();
  kernelNYC.stop();
  kernelLA.stop();
  kernelSF.stop();
}

main().catch((err) => {
  console.error("\nDemo failed:", err);
  process.exit(1);
});
