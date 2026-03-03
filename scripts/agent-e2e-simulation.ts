/**
 * Agent-to-Agent E2E Simulation
 *
 * Demonstrates the full conversational lifecycle between AI agents:
 *
 *   1. User Agent asks Broker: "What can do 3D printing in PLA?"
 *   2. Broker discovers matching kernels, returns capabilities
 *   3. User Agent requests a quote for FDM printing
 *   4. Broker quotes from best kernel, returns price/timeline/options
 *   5. User Agent negotiates for a lower price
 *   6. Broker accepts counter-offer (within 20%)
 *   7. User Agent submits a full CWM workflow
 *   8. Broker compiles workflow, returns escrow details
 *   9. Broker dispatches job to Kernel Agent
 *  10. Kernel Agent executes the job (mock FDM print)
 *  11. Kernel Agent produces evidence bundle
 *  12. Kernel Agent reports completion to Broker
 *  13. Broker relays completion to User Agent
 *  14. User Agent checks final status
 *
 * This is what happens when a user says to their AI:
 *   "3D print this bracket in PLA and deliver it to me"
 *
 * Run: npx tsx scripts/agent-e2e-simulation.ts
 */

import { MessageBus } from "@pcc/a2a";
import { UserAgent } from "@pcc/agent-user";
import { BrokerAgent } from "@pcc/agent-broker";
import { KernelAgent } from "@pcc/agent-kernel";
import type { Capability, CWM } from "@pcc/spec";
import { ids } from "@pcc/spec";

const DIVIDER = "═".repeat(72);
const SECTION = "─".repeat(72);

function log(agent: string, msg: string) {
  const color = {
    USER: "\x1b[36m",    // cyan
    BROKER: "\x1b[33m",  // yellow
    KERNEL: "\x1b[32m",  // green
    SYSTEM: "\x1b[35m",  // magenta
    BUS: "\x1b[90m",     // gray
  }[agent] ?? "\x1b[0m";
  const reset = "\x1b[0m";
  console.log(`${color}[${agent.padEnd(8)}]${reset} ${msg}`);
}

function heading(title: string) {
  console.log(`\n${SECTION}`);
  console.log(`  ${title}`);
  console.log(SECTION);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("\n" + DIVIDER);
  console.log("  PHYSICAL CAPABILITY CLOUD — Agent-to-Agent Simulation");
  console.log("  \"The AWS for the Physical World\"");
  console.log(DIVIDER);

  // ══════════════════════════════════════════════════════════════════
  // PHASE 1: Bootstrap the network
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 1: Bootstrap Network");

  log("SYSTEM", "Creating message bus (in-memory)...");
  const bus = new MessageBus();

  // ── Create Kernel Agent (a physical shop with an FDM printer) ────
  log("SYSTEM", "Starting Kernel Agent (NYC MakerSpace)...");

  const fdmCapability: Capability = {
    id: ids.capability(),
    kernelId: "kernel_nyc_001",
    type: "fdm",
    name: "Prusa MK4 FDM Printer",
    description: "Professional FDM printer, 0.1mm layer resolution",
    materials: ["pla", "petg", "abs", "tpu"],
    tolerances: { linear: "±0.1mm", surface: "Ra 12.5" },
    envelope: { x: 250, y: 210, z: 210, unit: "mm" },
    assuranceTiers: [0, 1, 2],
    pricing: {
      currency: "USDC",
      baseCost: "2.00",
      perMinute: "0.05",
      perGram: "0.03",
      minimum: "5.00",
    },
    availability: {
      timezone: "America/New_York",
      windows: {
        "1": [{ start: "2026-03-02T08:00:00Z", end: "2026-03-02T22:00:00Z" }],
        "2": [{ start: "2026-03-02T08:00:00Z", end: "2026-03-02T22:00:00Z" }],
        "3": [{ start: "2026-03-02T08:00:00Z", end: "2026-03-02T22:00:00Z" }],
        "4": [{ start: "2026-03-02T08:00:00Z", end: "2026-03-02T22:00:00Z" }],
        "5": [{ start: "2026-03-02T08:00:00Z", end: "2026-03-02T22:00:00Z" }],
      },
    },
    location: { lat: 40.7128, lng: -74.006 },
    queueDepth: 0,
    tags: ["fdm", "prototyping", "pla"],
  };

  const kernelAgent = new KernelAgent(bus, {
    kernelId: "kernel_nyc_001",
    name: "NYC MakerSpace",
    location: { lat: 40.7128, lng: -74.006 },
    capabilities: [fdmCapability],
    mockPrintDuration: 3000, // 3 second mock print
  });
  kernelAgent.start();
  log("KERNEL", `Online: ${kernelAgent.name} (${kernelAgent.kernelId})`);
  log("KERNEL", `Wallet: ${kernelAgent.wallet.address}`);
  log("KERNEL", `Capabilities: ${kernelAgent.capabilities.map((c) => `${c.type} (${c.materials.join(",")})`).join("; ")}`);

  // ── Create Broker Agent ──────────────────────────────────────────
  log("SYSTEM", "Starting Broker Agent...");
  const brokerAgent = new BrokerAgent(bus);
  brokerAgent.start();
  log("BROKER", `Online: ${brokerAgent.name}`);
  log("BROKER", `Wallet: ${brokerAgent.wallet.address}`);

  // Register kernel's capabilities with the broker
  brokerAgent.registerKernelCapabilities(kernelAgent.id, {
    kernelId: "kernel_nyc_001",
    capabilities: [fdmCapability],
    reputation: 950,
  });
  log("BROKER", "Registered NYC MakerSpace capabilities");

  // ── Create User Agent ────────────────────────────────────────────
  log("SYSTEM", "Starting User Agent...");
  const userAgent = new UserAgent(bus);

  // Listen for all notifications from the user agent
  userAgent.onNotification((n) => {
    const actionTag = n.requiresAction ? " [ACTION NEEDED]" : "";
    log("USER", `📬 Notification (${n.type})${actionTag}: ${n.summary}`);
  });

  userAgent.start();
  log("USER", `Online: ${userAgent.name}`);
  log("USER", `Wallet: ${userAgent.wallet.address}`);

  log("SYSTEM", "All agents online. Network ready.\n");

  // ══════════════════════════════════════════════════════════════════
  // PHASE 2: Discovery — "What can do 3D printing?"
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 2: Capability Discovery");

  log("USER", "Asking broker: \"What FDM printers support PLA?\"");
  const discoverResult = await userAgent.discoverCapabilities({
    capabilityType: "fdm",
    material: "pla",
  });
  log("USER", `Discovery conversation started: ${discoverResult.conversationId}`);
  await sleep(100); // let bus process

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3: Quoting — "How much to print in PLA?"
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 3: Quote Request");

  log("USER", "Requesting quote for FDM printing in PLA...");
  const quoteResult = await userAgent.requestQuote({
    capabilityType: "fdm",
    params: { material: "pla" },
    assuranceTier: 1,
    quantity: 1,
  });
  log("USER", `Quote conversation started: ${quoteResult.conversationId}`);
  await sleep(100);

  // Get the pending quote
  const notifications = userAgent.getNotifications();
  const quoteNotif = notifications.find((n) => n.type === "quote_received");
  if (quoteNotif) {
    const quoteData = quoteNotif.data as any;
    log("USER", `Got quote ${quoteData.quoteId}: $${quoteData.totalPrice} ${quoteData.currency}`);
    log("USER", `  Tier ${quoteData.assuranceTier}, Bond: $${quoteData.operatorBond}`);
    log("USER", `  Available: ${new Date(quoteData.estimatedStart).toLocaleString()}`);
    if (quoteData.options?.length) {
      log("USER", `  Options: ${quoteData.options.map((o: any) => `${o.name} (+$${o.additionalCost})`).join(", ")}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // PHASE 4: Negotiation — "Can you do $4?"
    // ══════════════════════════════════════════════════════════════════

    heading("PHASE 4: Negotiation");

    const originalPrice = parseFloat(quoteData.totalPrice);
    const counterPrice = (originalPrice * 0.85).toFixed(2); // 15% discount ask
    log("USER", `Negotiating: counter-offer $${counterPrice} (was $${quoteData.totalPrice})`);

    await userAgent.negotiate(quoteData.quoteId, {
      maxPrice: counterPrice,
    });
    await sleep(100);

    const negoNotif = notifications.find((n) => n.type === "message" && (n.data as any)?.quoteId);
    if (negoNotif) {
      log("USER", `Negotiation result: ${negoNotif.summary}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 5: Workflow Submission — "Print this and deliver it"
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 5: Workflow Submission");

  const cwm: CWM = {
    id: ids.cwm(),
    version: "1.0",
    submittedBy: userAgent.wallet.address,
    steps: [
      {
        id: "step_print_bracket",
        capability: "fdm",
        params: {
          material: "pla",
          infill: 20,
          layerHeight: 0.2,
          supports: true,
        },
        assuranceTier: 1,
        dependsOn: [],
      },
    ],
    settlement: {
      currency: "USDC",
      maxBudget: "50.00",
      escrowAddress: `0x${"E5C80".padEnd(40, "0")}` as `0x${string}`,
    },
    metadata: {
      name: "Bracket Print Job",
      description: "3D print a mounting bracket in PLA",
      tags: ["bracket", "pla", "fdm"],
    },
    createdAt: new Date().toISOString(),
  };

  log("USER", `Submitting workflow: "${cwm.metadata?.name}"`);
  log("USER", `  Step: ${cwm.steps.map((s) => `${s.id} (${s.capability})`).join(" → ")}`);
  log("USER", `  Budget: $${cwm.settlement.maxBudget} ${cwm.settlement.currency}`);

  const workflowResult = await userAgent.submitWorkflow(cwm);
  log("USER", `Workflow conversation: ${workflowResult.conversationId}`);
  await sleep(100);

  const workflowNotif = userAgent.getNotifications().find((n) => n.type === "workflow_accepted");
  if (workflowNotif) {
    const wd = workflowNotif.data as any;
    log("USER", `Workflow ACCEPTED! Plan: ${wd.planId}`);
    log("USER", `  Escrow needed: $${wd.totalEscrowAmount} → ${wd.escrowAddress}`);
    log("USER", `  Milestones: ${wd.milestones.length}`);
    wd.milestones.forEach((m: any) => {
      log("USER", `    ${m.stepId}: $${m.amount} on ${m.kernelId}`);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 6: Job Execution — Kernel runs the print
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 6: Job Execution on Kernel");

  log("BROKER", "Dispatching job to kernel agent...");

  // Broker sends execute_job to kernel
  await brokerAgent.send(kernelAgent.id, {
    type: "execute_job" as any,
    jobId: ids.job(),
    stepId: "step_print_bracket",
    capabilityType: "fdm",
    params: { material: "pla", infill: 20, layerHeight: 0.2 },
    assuranceTier: 1,
  });

  log("KERNEL", "Job received. Executing mock FDM print...");
  log("KERNEL", "  Loading G-code...");
  log("KERNEL", "  Starting power monitor...");
  log("KERNEL", "  Printing... (3s mock duration)");

  // Wait for the kernel to finish the job
  await sleep(5000);

  log("KERNEL", "Print complete! Evidence bundle produced.");

  // Check kernel's active jobs
  const kernelJobs = kernelAgent.getActiveJobs();
  const completedJob = kernelJobs.find((j) => j.status === "completed");
  if (completedJob) {
    log("KERNEL", `Job ${completedJob.jobId}: ${completedJob.status}`);
    if (completedJob.evidenceBundle) {
      log("KERNEL", `  Evidence bundle: ${completedJob.evidenceBundle.id}`);
      log("KERNEL", `  Bundle hash: ${completedJob.evidenceBundle.bundleHash.slice(0, 32)}...`);
      log("KERNEL", `  Events: ${completedJob.evidenceBundle.events.length}`);
      completedJob.evidenceBundle.events.forEach((e) => {
        const dataStr = e.data ? JSON.stringify(e.data).slice(0, 60) : "(no data)";
        log("KERNEL", `    ${e.type}: ${dataStr}`);
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 7: Status Check — User checks on their job
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 7: Status Check");

  log("USER", "Checking job status...");
  await userAgent.checkStatus();
  await sleep(100);

  // ══════════════════════════════════════════════════════════════════
  // PHASE 8: Natural Language — Chat with broker
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 8: Natural Language Chat");

  log("USER", "Chatting with broker: \"Can you find me CNC shops near NYC?\"");
  await userAgent.chat("Can you find me CNC shops near NYC?");
  await sleep(100);

  log("USER", "Chatting with broker: \"What services do you offer?\"");
  await userAgent.chat("What services do you offer?");
  await sleep(100);

  // ══════════════════════════════════════════════════════════════════
  // PHASE 9: Tool Definitions — What LLMs can call
  // ══════════════════════════════════════════════════════════════════

  heading("PHASE 9: LLM Tool Definitions");

  log("SYSTEM", "User Agent tools (for Claude/GPT tool-use):");
  userAgent.getToolDefinitions().forEach((tool) => {
    log("USER", `  ${tool.name}: ${tool.description}`);
    log("USER", `    params: ${JSON.stringify(tool.input_schema.properties)}`);
  });

  console.log();
  log("SYSTEM", "Broker Agent tools:");
  brokerAgent.getToolDefinitions().forEach((tool) => {
    log("BROKER", `  ${tool.name}: ${tool.description}`);
  });

  console.log();
  log("SYSTEM", "Kernel Agent tools:");
  kernelAgent.getToolDefinitions().forEach((tool) => {
    log("KERNEL", `  ${tool.name}: ${tool.description}`);
  });

  // ══════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════

  heading("SIMULATION COMPLETE");

  const allNotifications = userAgent.getNotifications();
  console.log();
  log("SYSTEM", `Total notifications received by user: ${allNotifications.length}`);
  allNotifications.forEach((n, i) => {
    const icon = {
      capabilities_found: "🔍",
      quote_received: "💰",
      workflow_accepted: "✅",
      payment_needed: "💳",
      job_update: "🔄",
      job_completed: "🎉",
      message: "💬",
      error: "❌",
    }[n.type] ?? "📌";
    log("SYSTEM", `  ${i + 1}. ${icon} ${n.type}: ${n.summary.slice(0, 80)}${n.summary.length > 80 ? "..." : ""}`);
  });

  console.log();
  log("SYSTEM", "Agent wallet addresses:");
  log("USER", `  User:   ${userAgent.wallet.address}`);
  log("BROKER", `  Broker: ${brokerAgent.wallet.address}`);
  log("KERNEL", `  Kernel: ${kernelAgent.wallet.address}`);

  console.log();
  console.log(DIVIDER);
  console.log("  This simulation demonstrates:");
  console.log("    • Agent-to-agent communication via typed intents");
  console.log("    • Capability discovery across the network");
  console.log("    • Price quoting and negotiation");
  console.log("    • Workflow compilation and escrow planning");
  console.log("    • Physical job execution with evidence collection");
  console.log("    • Natural language routing to structured actions");
  console.log("    • LLM tool definitions for Claude/GPT integration");
  console.log("    • Wallet-per-agent with signing capability");
  console.log(DIVIDER);
  console.log();

  // Cleanup
  userAgent.stop();
  brokerAgent.stop();
  kernelAgent.stop();
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
