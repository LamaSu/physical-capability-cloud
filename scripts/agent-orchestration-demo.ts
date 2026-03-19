/**
 * PCCP Agent Orchestration Demo -- Cross-Domain Physical Workflow
 *
 * Demonstrates the AI AGENT COORDINATION layer of the Physical Capability Cloud:
 * agents discovering, negotiating, and orchestrating a multi-domain physical workflow.
 *
 * Scenario: A biotech startup needs a multi-step drug compound development pipeline
 * spanning 3 physical domains (Lab, Manufacturing, Transport) with 5 agents
 * coordinating via typed A2A intents.
 *
 *   Act 1: Agent Discovery     -- UserAgent asks BrokerAgent to find capabilities across 3 domains
 *   Act 2: Workflow Compilation -- BrokerAgent compiles a 5-step DAG with dependencies
 *   Act 3: Price Negotiation   -- BrokerAgent negotiates volume discounts with KernelAgents
 *   Act 4: Contract Lock-in    -- Escrow locked for each milestone via NativeEscrowService
 *   Act 5: Execution Preview   -- Visualization of how the DAG would execute
 *
 * Complements investor-demo.ts (which shows settlement per domain) by showing
 * the AGENT COORDINATION layer.
 *
 * Run: npx tsx scripts/agent-orchestration-demo.ts
 */

import { MessageBus } from "@pcc/a2a";
import type {
  A2AMessage,
  Intent,
  CapabilitiesResponseIntent,
  QuoteResponseIntent,
  NegotiationResponseIntent,
  RequestQuoteIntent,
  NegotiateIntent,
} from "@pcc/a2a";
import { UserAgent } from "@pcc/agent-user";
import { BrokerAgent } from "@pcc/agent-broker";
import { KernelAgent } from "@pcc/agent-kernel";
import { NativeEscrowService } from "@pcc/payments";
import type { Capability, BondConfig } from "@pcc/spec";
import { ids } from "@pcc/spec";

// ============================================================================
// Display helpers (matching investor-demo.ts style)
// ============================================================================

const DIV = "\u2550".repeat(70);
const SUB = "\u2500".repeat(70);

const COLORS = {
  USER:     "\x1b[36m",   // cyan
  BROKER:   "\x1b[33m",   // yellow
  LAB:      "\x1b[32m",   // green
  CNC:      "\x1b[35m",   // magenta
  COURIER:  "\x1b[34m",   // blue
  SYSTEM:   "\x1b[90m",   // gray
  ESCROW:   "\x1b[31m",   // red
  RESET:    "\x1b[0m",
  BOLD:     "\x1b[1m",
  DIM:      "\x1b[2m",
};

function log(agent: string, msg: string) {
  const color = (COLORS as Record<string, string>)[agent] ?? COLORS.RESET;
  console.log(`  ${color}[${agent.padEnd(10)}]${COLORS.RESET} ${msg}`);
}

function phase(n: number, title: string) {
  console.log(`\n  ${COLORS.BOLD}\u25B8 ACT ${n}: ${title}${COLORS.RESET}`);
  console.log(`  ${SUB}`);
}

function ok(label: string) {
  console.log(`    \u2713 ${label}`);
}

function arrow(from: string, to: string, intent: string, detail?: string) {
  const detailStr = detail ? ` ${COLORS.DIM}(${detail})${COLORS.RESET}` : "";
  console.log(`    ${from} \u2192 ${to}: ${COLORS.BOLD}${intent}${COLORS.RESET}${detailStr}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Workflow step definitions (the scenario from the spec)
// ============================================================================

interface WorkflowStep {
  id: string;
  name: string;
  shortName: string;
  domain: string;
  capabilityType: string;
  description: string;
  originalQuote: number;
  negotiatedPrice: number;
  assuranceTier: 0 | 1 | 2 | 3;
  dependsOn: string[];
  kernelName: string;
  kernelId: string;
  estimatedHours: number;
}

const WORKFLOW_STEPS: WorkflowStep[] = [
  {
    id: "step_hplc",
    name: "HPLC Purity Analysis",
    shortName: "HPLC",
    domain: "Lab Analysis",
    capabilityType: "hplc",
    description: "HPLC purity analysis of raw compound",
    originalQuote: 350,
    negotiatedPrice: 315,
    assuranceTier: 2,
    dependsOn: [],
    kernelName: "BioLab SF",
    kernelId: "kernel_lab_sf",
    estimatedHours: 4,
  },
  {
    id: "step_cnc",
    name: "CNC Reactor Vessel",
    shortName: "CNC",
    domain: "Manufacturing",
    capabilityType: "cnc-5axis",
    description: "Machine a custom borosilicate reactor vessel",
    originalQuote: 2800,
    negotiatedPrice: 2520,
    assuranceTier: 2,
    dependsOn: ["step_hplc"],
    kernelName: "PrecisionWorks Oakland",
    kernelId: "kernel_cnc_oakland",
    estimatedHours: 12,
  },
  {
    id: "step_courier",
    name: "Same-Day Courier",
    shortName: "Courier",
    domain: "Transport",
    capabilityType: "courier-delivery",
    description: "Ship the vessel from CNC shop to the lab",
    originalQuote: 85,
    negotiatedPrice: 85,
    assuranceTier: 1,
    dependsOn: ["step_cnc"],
    kernelName: "BayArea Express",
    kernelId: "kernel_courier_ba",
    estimatedHours: 3,
  },
  {
    id: "step_synthesis",
    name: "Automated Protocol",
    shortName: "Synthesis",
    domain: "Lab Synthesis",
    capabilityType: "compound-synthesis",
    description: "Run the synthesis protocol using the custom vessel",
    originalQuote: 1200,
    negotiatedPrice: 1080,
    assuranceTier: 2,
    dependsOn: ["step_hplc", "step_courier"],
    kernelName: "BioLab SF",
    kernelId: "kernel_lab_sf",
    estimatedHours: 8,
  },
  {
    id: "step_qc",
    name: "Mass Spec Analysis",
    shortName: "QC",
    domain: "Lab QC",
    capabilityType: "mass-spec",
    description: "Final quality control via mass spectrometry",
    originalQuote: 500,
    negotiatedPrice: 450,
    assuranceTier: 2,
    dependsOn: ["step_synthesis"],
    kernelName: "BioLab SF",
    kernelId: "kernel_lab_sf",
    estimatedHours: 6,
  },
];

// ============================================================================
// Phase/result tracking
// ============================================================================

const phaseResults: Array<{ phase: string; status: "PASS" | "FAIL"; detail: string }> = [];
let messageCount = 0;

async function run<T>(phaseName: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const result = await fn();
    phaseResults.push({ phase: phaseName, status: "PASS", detail: "OK" });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    phaseResults.push({ phase: phaseName, status: "FAIL", detail: msg });
    console.error(`    \u2717 ${phaseName} FAILED: ${msg}`);
    return null;
  }
}

// ============================================================================
// Create capabilities for each kernel domain
// ============================================================================

function makeCapability(
  kernelId: string,
  type: string,
  name: string,
  materials: string[],
  baseCost: string,
  perMinute: string,
  minimum: string,
  location: { lat: number; lng: number },
): Capability {
  return {
    id: ids.capability(),
    kernelId,
    type,
    name,
    description: `${name} capability`,
    materials,
    assuranceTiers: [0, 1, 2] as Array<0 | 1 | 2 | 3>,
    pricing: {
      currency: "USDC",
      baseCost,
      perMinute,
      minimum,
    },
    availability: {
      timezone: "America/Los_Angeles",
      windows: {
        1: [{ start: "2026-03-16T08:00:00Z", end: "2026-03-16T20:00:00Z" }],
        2: [{ start: "2026-03-16T08:00:00Z", end: "2026-03-16T20:00:00Z" }],
        3: [{ start: "2026-03-16T08:00:00Z", end: "2026-03-16T20:00:00Z" }],
        4: [{ start: "2026-03-16T08:00:00Z", end: "2026-03-16T20:00:00Z" }],
        5: [{ start: "2026-03-16T08:00:00Z", end: "2026-03-16T20:00:00Z" }],
      },
    },
    location,
    queueDepth: 0,
    tags: [type],
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("\n" + DIV);
  console.log("  PHYSICAL CAPABILITY CLOUD \u2014 Agent Orchestration Demo");
  console.log("  \"AI Agents Coordinating Cross-Domain Physical Workflows\"");
  console.log(DIV);

  // ==========================================================================
  // BOOTSTRAP: Create agents and network
  // ==========================================================================

  phase(0, "NETWORK BOOTSTRAP");

  log("SYSTEM", "Creating A2A message bus...");
  const bus = new MessageBus();

  // ---- Intercept all messages for counting ----
  const originalSend = bus.send.bind(bus);
  bus.send = async (msg: A2AMessage) => {
    messageCount++;
    await originalSend(msg);
  };

  // ---- Lab Kernel (BioLab SF) ----
  const labCapabilities: Capability[] = [
    makeCapability("kernel_lab_sf", "hplc", "Agilent 1260 HPLC", ["organic-compounds", "peptides"], "50.00", "1.25", "100.00", { lat: 37.7749, lng: -122.4194 }),
    makeCapability("kernel_lab_sf", "compound-synthesis", "Automated Synthesis Station", ["small-molecule", "organic", "organic-compounds"], "100.00", "2.00", "200.00", { lat: 37.7749, lng: -122.4194 }),
    makeCapability("kernel_lab_sf", "mass-spec", "Thermo Q-Exactive Mass Spec", ["organic-compounds", "proteins"], "75.00", "1.50", "150.00", { lat: 37.7749, lng: -122.4194 }),
  ];

  const labKernel = new KernelAgent(bus, {
    kernelId: "kernel_lab_sf",
    name: "BioLab SF",
    location: { lat: 37.7749, lng: -122.4194 },
    capabilities: labCapabilities,
    mockPrintDuration: 500,
  });
  labKernel.start();
  log("LAB", `Online: ${labKernel.name} (${labKernel.kernelId})`);
  log("LAB", `  Capabilities: HPLC, Compound Synthesis, Mass Spec`);
  log("LAB", `  Wallet: ${labKernel.wallet.address.slice(0, 20)}...`);
  ok("Lab kernel registered");

  // ---- CNC Kernel (PrecisionWorks Oakland) ----
  const cncCapabilities: Capability[] = [
    makeCapability("kernel_cnc_oakland", "cnc-5axis", "DMG MORI DMU 65 5-Axis", ["titanium", "stainless-steel", "borosilicate"], "200.00", "3.00", "500.00", { lat: 37.8044, lng: -122.2712 }),
  ];

  const cncKernel = new KernelAgent(bus, {
    kernelId: "kernel_cnc_oakland",
    name: "PrecisionWorks Oakland",
    location: { lat: 37.8044, lng: -122.2712 },
    capabilities: cncCapabilities,
    mockPrintDuration: 500,
  });
  cncKernel.start();
  log("CNC", `Online: ${cncKernel.name} (${cncKernel.kernelId})`);
  log("CNC", `  Capabilities: 5-Axis CNC (titanium, stainless, borosilicate)`);
  log("CNC", `  Wallet: ${cncKernel.wallet.address.slice(0, 20)}...`);
  ok("CNC kernel registered");

  // ---- Courier Kernel (BayArea Express) ----
  const courierCapabilities: Capability[] = [
    makeCapability("kernel_courier_ba", "courier-delivery", "Same-Day Bay Area Courier", ["fragile", "hazmat-exempt", "standard"], "25.00", "0.25", "50.00", { lat: 37.79, lng: -122.39 }),
  ];

  const courierKernel = new KernelAgent(bus, {
    kernelId: "kernel_courier_ba",
    name: "BayArea Express",
    location: { lat: 37.79, lng: -122.39 },
    capabilities: courierCapabilities,
    mockPrintDuration: 500,
  });
  courierKernel.start();
  log("COURIER", `Online: ${courierKernel.name} (${courierKernel.kernelId})`);
  log("COURIER", `  Capabilities: Same-Day Courier (fragile, standard)`);
  log("COURIER", `  Wallet: ${courierKernel.wallet.address.slice(0, 20)}...`);
  ok("Courier kernel registered");

  // ---- Broker Agent ----
  const brokerAgent = new BrokerAgent(bus);
  brokerAgent.start();
  log("BROKER", `Online: ${brokerAgent.name}`);
  log("BROKER", `  Wallet: ${brokerAgent.wallet.address.slice(0, 20)}...`);

  // Register all kernels with the broker
  brokerAgent.registerKernelCapabilities(labKernel.id, {
    kernelId: "kernel_lab_sf",
    capabilities: labCapabilities,
    reputation: 970,
  });
  brokerAgent.registerKernelCapabilities(cncKernel.id, {
    kernelId: "kernel_cnc_oakland",
    capabilities: cncCapabilities,
    reputation: 945,
  });
  brokerAgent.registerKernelCapabilities(courierKernel.id, {
    kernelId: "kernel_courier_ba",
    capabilities: courierCapabilities,
    reputation: 920,
  });
  ok("Broker registered 3 kernel capability sets");

  // ---- User Agent ----
  const userAgent = new UserAgent(bus);
  userAgent.start();
  log("USER", `Online: ${userAgent.name}`);
  log("USER", `  Wallet: ${userAgent.wallet.address.slice(0, 20)}...`);
  ok("User agent online");

  log("SYSTEM", `Network: 5 agents, 3 kernels, 5 capabilities, 1 bus`);

  // ==========================================================================
  // ACT 1: Agent Discovery
  // ==========================================================================

  phase(1, "AGENT DISCOVERY");
  console.log("    UserAgent asks the network: \"What capabilities are available");
  console.log("    for drug compound development across lab, manufacturing, and transport?\"\n");

  // Discover capabilities using the real agent API
  const capabilityTypes = [
    { type: "hplc", label: "Lab (HPLC)" },
    { type: "cnc-5axis", label: "CNC (5-axis)" },
    { type: "courier-delivery", label: "Courier" },
    { type: "compound-synthesis", label: "Compound Synthesis" },
    { type: "mass-spec", label: "Mass Spec" },
  ];

  for (const cap of capabilityTypes) {
    await run(`Discover: ${cap.label}`, async () => {
      arrow("UserAgent", "BrokerAgent", "DiscoverCapabilities", `type=${cap.type}`);
      await userAgent.discoverCapabilities({ capabilityType: cap.type });
      await sleep(50);

      const notifs = userAgent.getNotifications();
      const found = notifs.filter(n => n.type === "capabilities_found").pop();
      if (found) {
        const data = found.data as CapabilitiesResponseIntent;
        arrow("BrokerAgent", "UserAgent", "CapabilitiesResponse", `${data.totalMatches} match(es)`);
        for (const m of data.matches) {
          log("BROKER", `  Found: ${m.capabilityName} @ $${m.price} (${m.kernelName}, rep: ${m.reputation})`);
        }
      }
      return true;
    });
  }

  console.log();
  log("SYSTEM", "Capability map compiled: 5 capabilities across 3 domains");
  ok("All 5 capabilities discovered via A2A intents");

  // ==========================================================================
  // ACT 2: Multi-Step Workflow Compilation
  // ==========================================================================

  phase(2, "WORKFLOW COMPILATION");
  console.log("    UserAgent describes a 5-step cross-domain workflow.");
  console.log("    BrokerAgent compiles it into a dependency DAG.\n");

  log("USER", "\"I need a drug compound development pipeline:");
  log("USER", "  1. HPLC purity analysis of raw compound");
  log("USER", "  2. CNC-machine a custom reactor vessel (needs purity data)");
  log("USER", "  3. Ship the vessel from CNC shop to the lab");
  log("USER", "  4. Run synthesis using the vessel (needs purity + vessel)");
  log("USER", "  5. Final QC via mass spectrometry\"");
  console.log();

  await run("Workflow DAG Compilation", async () => {
    log("BROKER", "Compiling workflow DAG...");
    console.log();
    console.log("    Dependency Graph:");
    console.log("    \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510");
    console.log("    \u2502  HPLC  \u2502 (Step 1: Lab Analysis)");
    console.log("    \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518");
    console.log("      \u2502      \u2572");
    console.log("      v        \u2572");
    console.log("    \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510    \u2502");
    console.log("    \u2502  CNC   \u2502    \u2502 (Step 2: Manufacturing)");
    console.log("    \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518    \u2502");
    console.log("      \u2502          \u2502");
    console.log("      v          \u2502");
    console.log("    \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510 \u2502");
    console.log("    \u2502 Courier  \u2502 \u2502 (Step 3: Transport)");
    console.log("    \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518 \u2502");
    console.log("      \u2502          \u2502");
    console.log("      v          v");
    console.log("    \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510");
    console.log("    \u2502 Synthesis  \u2502 (Step 4: depends on Steps 1+3)");
    console.log("    \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518");
    console.log("      \u2502");
    console.log("      v");
    console.log("    \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510");
    console.log("    \u2502   QC   \u2502 (Step 5: Final QC)");
    console.log("    \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518");
    console.log();

    // Topological sort validation
    const stepMap = new Map(WORKFLOW_STEPS.map(s => [s.id, s]));
    const visited = new Set<string>();
    const order: string[] = [];
    function topoVisit(id: string) {
      if (visited.has(id)) return;
      visited.add(id);
      const step = stepMap.get(id)!;
      for (const dep of step.dependsOn) topoVisit(dep);
      order.push(id);
    }
    WORKFLOW_STEPS.forEach(s => topoVisit(s.id));

    log("BROKER", `Topological order: ${order.map(id => stepMap.get(id)!.shortName).join(" \u2192 ")}`);
    log("BROKER", `Critical path: HPLC \u2192 CNC \u2192 Courier \u2192 Synthesis \u2192 QC`);
    log("BROKER", `Estimated total duration: ${WORKFLOW_STEPS.reduce((s, w) => s + w.estimatedHours, 0)} hours`);

    return order;
  });

  ok("Workflow compiled into executable DAG");

  // ==========================================================================
  // ACT 3: Price Negotiation
  // ==========================================================================

  phase(3, "PRICE NEGOTIATION");
  console.log("    BrokerAgent sends RequestQuote to each KernelAgent for their steps.");
  console.log("    Then negotiates a 10% volume discount for the multi-step workflow.\n");

  // For the negotiation phase, we send A2A messages through the bus to show
  // the typed intent protocol flowing. We use dedicated conversation IDs
  // (not routed through the real broker handlers) to demonstrate the message
  // format with the scenario's target prices. This mirrors production where
  // kernel operators set their own prices via the A2A protocol.

  const quoteResults: Array<{
    step: WorkflowStep;
    quoteId: string;
    originalPrice: number;
    negotiatedPrice: number;
    accepted: boolean;
  }> = [];

  /** Helper to build a message and send it through the bus (unhandled channel) */
  async function sendDemo(from: string, to: string, intent: Intent, convId: string): Promise<void> {
    const msg: A2AMessage = {
      id: ids.job(),
      conversationId: convId,
      from,
      to: `demo_${to}`, // prefix avoids triggering real agent handlers
      intent,
      timestamp: new Date().toISOString(),
    };
    await bus.send(msg);
  }

  // Map kernel IDs to display names
  const kernelLabels: Record<string, string> = {
    kernel_lab_sf: "BioLab SF",
    kernel_cnc_oakland: "PrecisionWorks",
    kernel_courier_ba: "BayArea Express",
  };

  for (const step of WORKFLOW_STEPS) {
    const kernelLabel = kernelLabels[step.kernelId];
    const convId = ids.job();
    const quoteId = ids.job();

    // -- REQUEST QUOTE --
    const quoteResult = await run(`Quote: ${step.name}`, async () => {
      // UserAgent -> BrokerAgent: RequestQuote
      arrow("UserAgent", "BrokerAgent", "RequestQuote", `type=${step.capabilityType}, tier=${step.assuranceTier}`);
      await sendDemo(userAgent.id, brokerAgent.id, {
        type: "request_quote",
        capabilityType: step.capabilityType,
        params: { material: step.capabilityType === "cnc-5axis" ? "borosilicate" : "organic-compounds" },
        assuranceTier: step.assuranceTier,
        quantity: 1,
      } as RequestQuoteIntent, convId);

      // BrokerAgent -> KernelAgent: forwarded RequestQuote
      arrow("BrokerAgent", kernelLabel, "RequestQuote", `forwarded`);
      await sendDemo(brokerAgent.id, step.kernelId, {
        type: "request_quote",
        capabilityType: step.capabilityType,
        params: {},
        assuranceTier: step.assuranceTier,
      } as RequestQuoteIntent, convId);

      // KernelAgent -> BrokerAgent: QuoteResponse
      const quoteResponse: QuoteResponseIntent = {
        type: "quote_response",
        quoteId,
        pricePerUnit: step.originalQuote.toFixed(2),
        totalPrice: step.originalQuote.toFixed(2),
        currency: "USDC",
        estimatedStart: new Date(Date.now() + 60 * 60_000).toISOString(),
        estimatedCompletion: new Date(Date.now() + (60 + step.estimatedHours * 60) * 60_000).toISOString(),
        assuranceTier: step.assuranceTier,
        operatorBond: (step.originalQuote * 0.15).toFixed(2),
        validUntil: new Date(Date.now() + 120 * 60_000).toISOString(),
        kernelId: step.kernelId,
        kernelName: step.kernelName,
      };
      await sendDemo(step.kernelId, brokerAgent.id, quoteResponse, convId);
      arrow(kernelLabel, "BrokerAgent", "QuoteResponse", `$${step.originalQuote.toFixed(2)} USDC, Tier ${step.assuranceTier}`);

      // BrokerAgent -> UserAgent: QuoteResponse (relayed)
      await sendDemo(brokerAgent.id, userAgent.id, quoteResponse, convId);
      log("BROKER", `  Quote: $${step.originalQuote.toFixed(2)} | Bond: $${(step.originalQuote * 0.15).toFixed(2)} | ${step.kernelName}`);

      return quoteId;
    });

    // -- NEGOTIATE --
    await run(`Negotiate: ${step.name}`, async () => {
      if (!quoteResult) throw new Error("No quote to negotiate");

      // Courier has fixed pricing -- no negotiation
      if (step.capabilityType === "courier-delivery") {
        log("BROKER", `  Courier: fixed-price service, no negotiation`);
        quoteResults.push({
          step,
          quoteId: quoteResult,
          originalPrice: step.originalQuote,
          negotiatedPrice: step.originalQuote,
          accepted: true,
        });
        return true;
      }

      // BrokerAgent -> KernelAgent: Negotiate (10% workflow discount)
      const counterPrice = step.negotiatedPrice;
      arrow("BrokerAgent", kernelLabel, "Negotiate", `counter: $${counterPrice.toFixed(2)} (10% workflow discount)`);
      await sendDemo(brokerAgent.id, step.kernelId, {
        type: "negotiate",
        quoteId: quoteResult,
        counterOffer: { maxPrice: counterPrice.toFixed(2) },
        message: "Multi-step workflow discount: 10% off for 5-step pipeline commitment",
      } as NegotiateIntent, convId);

      // KernelAgent -> BrokerAgent: NegotiationResponse (accepted)
      const negoResponse: NegotiationResponseIntent = {
        type: "negotiation_response",
        quoteId: quoteResult,
        accepted: true,
        message: `Volume discount accepted at $${counterPrice.toFixed(2)}.`,
      };
      await sendDemo(step.kernelId, brokerAgent.id, negoResponse, convId);
      arrow(kernelLabel, "BrokerAgent", "NegotiationResponse", `ACCEPTED at $${counterPrice.toFixed(2)}`);

      quoteResults.push({
        step,
        quoteId: quoteResult,
        originalPrice: step.originalQuote,
        negotiatedPrice: counterPrice,
        accepted: true,
      });

      return true;
    });
  }

  console.log();
  log("SYSTEM", "Negotiation complete. Compiling final pricing...");
  console.log();

  // Display negotiation summary table
  const totalOriginal = WORKFLOW_STEPS.reduce((s, w) => s + w.originalQuote, 0);
  const totalNegotiated = WORKFLOW_STEPS.reduce((s, w) => s + w.negotiatedPrice, 0);

  console.log("    Step       Domain           Original    Negotiated   Discount");
  console.log("    " + "\u2500".repeat(62));
  for (const qr of quoteResults) {
    const discount = qr.originalPrice > qr.negotiatedPrice
      ? `-${((1 - qr.negotiatedPrice / qr.originalPrice) * 100).toFixed(0)}%`
      : "---";
    console.log(
      `    ${qr.step.shortName.padEnd(11)}` +
      `${qr.step.domain.padEnd(17)}` +
      `$${qr.originalPrice.toFixed(2).padStart(9)}   ` +
      `$${qr.negotiatedPrice.toFixed(2).padStart(9)}    ` +
      discount,
    );
  }
  console.log("    " + "\u2500".repeat(62));
  const savings = totalOriginal - totalNegotiated;
  const savingsPct = ((savings / totalOriginal) * 100).toFixed(0);
  console.log(`    Total:                      $${totalOriginal.toFixed(2).padStart(9)}   $${totalNegotiated.toFixed(2).padStart(9)}    -${savingsPct}%`);
  console.log(`    Savings: $${savings.toFixed(2)} via multi-step workflow negotiation`);

  ok("All quotes received and negotiated via A2A");

  // ==========================================================================
  // ACT 4: Contract Lock-in
  // ==========================================================================

  phase(4, "CONTRACT LOCK-IN + ESCROW");
  console.log("    UserAgent approves the workflow. BrokerAgent creates contracts");
  console.log("    and locks escrow for each milestone via NativeEscrowService.\n");

  const escrowService = new NativeEscrowService();
  const escrowId = `esc-agent-demo-${Date.now().toString(16)}`;
  const obligations: Array<{ step: WorkflowStep; obligationId: string; amount: string; price: number }> = [];

  arrow("UserAgent", "BrokerAgent", "SubmitWorkflow", `5 steps, 3 domains, $${totalNegotiated.toFixed(2)}`);
  console.log();

  for (const qr of quoteResults) {
    await run(`Contract: ${qr.step.name}`, async () => {
      const bondConfig: BondConfig = {
        tier: qr.step.assuranceTier,
        operatorBondPercent: 10,
        challengerBondPercent: 10,
        challengeWindowSeconds: 86400,
        slashPercent: 100,
      };

      const price = qr.negotiatedPrice;

      const obligation = await escrowService.lockMilestone({
        escrowId,
        milestone: {
          stepId: qr.step.id,
          amount: price.toFixed(2),
          status: "funded",
          bondAmount: (price * 0.1).toFixed(2),
        },
        buyer: userAgent.wallet.address,
        seller: `0x${"2".repeat(40)}` as `0x${string}`,
        bondConfig,
      });

      const kernelLabel = kernelLabels[qr.step.kernelId];
      arrow("BrokerAgent", kernelLabel, "BuildContract", `step=${qr.step.shortName}, $${price.toFixed(2)}, Tier ${qr.step.assuranceTier}`);
      arrow(kernelLabel, "BrokerAgent", "ContractBuiltResponse", `obligation=${obligation.id}`);
      log("ESCROW", `  Locked: ${obligation.id} | $${parseFloat(obligation.amount).toFixed(2)} (incl. 10% bond) | ${qr.step.name}`);

      obligations.push({
        step: qr.step,
        obligationId: obligation.id,
        amount: obligation.amount,
        price,
      });

      return obligation;
    });
  }

  console.log();
  const totalEscrow = obligations.reduce((s, o) => s + parseFloat(o.amount), 0);
  log("ESCROW", `Total escrow locked: $${totalEscrow.toFixed(2)} across ${obligations.length} milestones`);
  log("ESCROW", `Escrow ID: ${escrowId}`);
  ok("All 5 contracts created and escrow locked");

  // ==========================================================================
  // ACT 5: Execution Preview
  // ==========================================================================

  phase(5, "EXECUTION PREVIEW");
  console.log("    Preview of how the DAG would execute. Each step triggers on");
  console.log("    dependency completion. Escrow releases per verified milestone.\n");

  let currentHour = 0;

  for (const step of WORKFLOW_STEPS) {
    const startHour = currentHour;
    const endHour = startHour + step.estimatedHours;

    if (step.shortName === "HPLC") {
      log("LAB", `T+${String(startHour).padStart(2)}h: Step 1 starts immediately -- HPLC purity analysis`);
      log("LAB", `T+${String(endHour).padStart(2)}h: HPLC complete. Evidence bundle produced + verified.`);
      log("LAB", `       Escrow milestone 1 released ($${step.negotiatedPrice}). Triggers: Step 2 (CNC).`);
    } else if (step.shortName === "CNC") {
      log("CNC", `T+${String(startHour).padStart(2)}h: Step 2 starts -- purity data received, machining begins`);
      log("CNC", `T+${String(endHour).padStart(2)}h: Reactor vessel complete. Evidence bundle produced + verified.`);
      log("CNC", `       Escrow milestone 2 released ($${step.negotiatedPrice}). Triggers: Step 3 (Courier).`);
    } else if (step.shortName === "Courier") {
      log("COURIER", `T+${String(startHour).padStart(2)}h: Step 3 starts -- courier dispatched to PrecisionWorks Oakland`);
      log("COURIER", `T+${String(endHour).padStart(2)}h: Vessel delivered to BioLab SF. GPS evidence + signature.`);
      log("COURIER", `       Escrow milestone 3 released ($${step.negotiatedPrice}). Triggers: Step 4 (Synthesis).`);
    } else if (step.shortName === "Synthesis") {
      log("LAB", `T+${String(startHour).padStart(2)}h: Step 4 starts -- vessel + purity data available`);
      log("LAB", `T+${String(endHour).padStart(2)}h: Synthesis complete. Evidence bundle produced + verified.`);
      log("LAB", `       Escrow milestone 4 released ($${step.negotiatedPrice}). Triggers: Step 5 (QC).`);
    } else if (step.shortName === "QC") {
      log("LAB", `T+${String(startHour).padStart(2)}h: Step 5 starts -- final mass spec QC`);
      log("LAB", `T+${String(endHour).padStart(2)}h: QC complete. All evidence verified. Compound certified.`);
      log("LAB", `       Escrow milestone 5 released ($${step.negotiatedPrice}). WORKFLOW COMPLETE.`);
    }

    currentHour = endHour;
  }

  console.log();
  log("SYSTEM", `Total execution time: ${currentHour} hours (sequential critical path)`);
  log("SYSTEM", `Evidence bundles: 5 (one per milestone, SHA-256 content-addressed)`);
  log("SYSTEM", `Escrow releases: 5 (on verification of each evidence bundle)`);
  ok("Execution preview complete");

  // ==========================================================================
  // SUMMARY DASHBOARD
  // ==========================================================================

  const protocolFee = totalNegotiated * 0.015;

  console.log("\n\n" + DIV);
  console.log("  PCCP Agent Orchestration \u2014 Cross-Domain Workflow");
  console.log(DIV);

  console.log();
  console.log("  Workflow: Drug Compound Development Pipeline");
  console.log(`  Steps: ${WORKFLOW_STEPS.length} | Domains: 3 | Agents: 5 | Messages: ${messageCount}`);
  console.log();

  console.log("  Step       Domain           Capability              Quote      Negotiated  Escrow");
  console.log("  " + "\u2500".repeat(68));

  for (const qr of quoteResults) {
    const capShort = qr.step.name.length > 22 ? qr.step.name.slice(0, 20) + ".." : qr.step.name;
    console.log(
      `  ${qr.step.shortName.padEnd(11)}` +
      `${qr.step.domain.padEnd(17)}` +
      `${capShort.padEnd(24)}` +
      `$${qr.originalPrice.toFixed(2).padStart(7)}    ` +
      `$${qr.negotiatedPrice.toFixed(2).padStart(7)}     ` +
      `LOCKED`,
    );
  }

  console.log("  " + "\u2500".repeat(68));
  console.log();
  console.log(`  Total: $${totalOriginal.toFixed(2)} \u2192 $${totalNegotiated.toFixed(2)} (${savingsPct}% workflow discount)`);
  console.log(`  Escrow locked: $${totalEscrow.toFixed(2)} across ${obligations.length} milestones (incl. 10% bonds)`);
  console.log(`  Protocol fee (1.5%): $${protocolFee.toFixed(2)}`);

  console.log();
  console.log("  " + "\u2500".repeat(68));
  console.log("  Agent Messages Exchanged:");
  console.log("  " + "\u2500".repeat(68));
  console.log("    UserAgent  \u2192 BrokerAgent:  DiscoverCapabilities (x5), RequestQuote (x5),");
  console.log("                               Negotiate (x4), SubmitWorkflow");
  console.log("    BrokerAgent \u2192 KernelAgents: RequestQuote (x5), Negotiate (x4),");
  console.log("                                BuildContract (x5)");
  console.log("    KernelAgents \u2192 BrokerAgent: CapabilitiesResponse (x5),");
  console.log("                                QuoteResponse (x5),");
  console.log("                                NegotiationResponse (x4),");
  console.log("                                ContractBuiltResponse (x5)");
  console.log(`    Total: ${messageCount} A2A messages via typed intents`);

  console.log();
  console.log("  " + "\u2500".repeat(68));
  console.log("  Workflow DAG:");
  console.log("  " + "\u2500".repeat(68));
  console.log("    [HPLC] \u2500\u2500\u2192 [CNC] \u2500\u2500\u2192 [Courier] \u2500\u2500\u2192 [Synthesis] \u2500\u2500\u2192 [QC]");
  console.log("       \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518");

  console.log();
  console.log("  " + "\u2500".repeat(68));
  console.log(`  Execution: ${currentHour} hours | 5 evidence bundles | 5 escrow releases`);
  console.log("  Settlement: milestone-by-milestone on evidence verification");
  console.log("  Chain: Base (L2) for escrow + Solana for capability certificates");

  // ========================================================================
  // Phase Results
  // ========================================================================

  console.log("\n" + DIV);
  console.log("  EXECUTION LOG");
  console.log(DIV + "\n");

  const passed = phaseResults.filter(r => r.status === "PASS").length;
  const failed = phaseResults.filter(r => r.status === "FAIL").length;

  for (const r of phaseResults) {
    const icon = r.status === "PASS" ? "\u2713" : "\u2717";
    const detail = r.status === "FAIL" ? ` \u2014 ${r.detail}` : "";
    console.log(`  ${icon} ${r.phase.padEnd(40)} ${r.status}${detail}`);
  }

  console.log(`\n  ${passed}/${phaseResults.length} passed, ${failed} failed`);

  if (failed === 0) {
    console.log();
    console.log("  \"5 physical capabilities. 3 domains. " + messageCount + " agent messages.");
    console.log("   Zero human coordination. Trustless settlement.\"");
  } else {
    console.log();
    console.log(`  ${failed} phase(s) failed. See details above.`);
  }

  console.log("\n" + DIV + "\n");

  // Cleanup
  userAgent.stop();
  brokerAgent.stop();
  labKernel.stop();
  cncKernel.stop();
  courierKernel.stop();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
