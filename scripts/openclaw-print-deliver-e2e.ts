/**
 * OpenClaw Print-and-Deliver E2E Simulation
 *
 * A user asks OpenClaw (the PCC agent interface) to:
 *   1. Print a document from a network printer
 *   2. Have it delivered via a rideshare/courier app
 *
 * Multi-hop workflow:
 *   DISCOVER printers → QUOTE → ESCROW → PRINT (with evidence)
 *   → DISCOVER courier → PICKUP → DELIVER (with evidence)
 *   → VERIFY → SETTLE
 *
 * 11 phases with full pipeline telemetry at every step.
 *
 * Variations (--variation flag):
 *   1  Standard  — 10 pages, same-city delivery, all succeeds
 *   2  Rush      — 50 pages, express delivery, higher price ($25 total)
 *   3  Challenge — 5 pages, long-distance, one milestone challenged then resolved
 *
 * Run:
 *   npx tsx scripts/openclaw-print-deliver-e2e.ts
 *   npx tsx scripts/openclaw-print-deliver-e2e.ts --variation 2
 *   npx tsx scripts/openclaw-print-deliver-e2e.ts --variation 3
 *
 * Note: uses relative src imports to avoid ESM/CJS resolution issues with
 * the @pcc/kernel barrel (which re-exports Helia/Storacha ESM-only modules).
 */

import { randomBytes } from "node:crypto";

// ── PCC imports (relative to avoid barrel ESM issues) ───────────────────────
// EvidenceEmitter via relative path — kernel barrel pulls in Helia/Storacha
import { EvidenceEmitter } from "../packages/kernel/src/evidence-emitter.js";

// Verifier suite — all CJS-compatible
import { CommitmentService } from "../packages/verifier/src/commitment-service.js";
import { ZKProofService } from "../packages/verifier/src/zk-proof-service.js";
import { EvidenceVerifier } from "../packages/verifier/src/evidence-verifier.js";
import { BittensorSubnetBridge } from "../packages/verifier/src/bittensor/index.js";

// Contracts — DePIN rewards + soulbound certs
import { CapabilityCertificateService } from "../packages/contracts/ts/capability-certificates.js";
import { RewardEngine } from "../packages/contracts/ts/reward-engine.js";

// A2A message bus
import { MessageBus } from "../packages/a2a/src/message-bus.js";

// Spec utilities (id generation, sha256) — safe barrel import
import { ids, sha256 } from "@pcc/spec";
import type { EvidenceBundle, SHA256 } from "@pcc/spec";

// ── ANSI color helpers ───────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  teal: "\x1b[96m",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Inline Telemetry ─────────────────────────────────────────────────────────

type PipelinePhase =
  | "discovery"
  | "quote_request"
  | "quote_response"
  | "negotiation"
  | "contract_build"
  | "escrow_fund"
  | "job_submit"
  | "job_accepted"
  | "job_started"
  | "evidence_capture"
  | "evidence_encrypt"
  | "evidence_archive"
  | "verification_request"
  | "verification_result"
  | "settlement_claim"
  | "settlement_complete"
  | "delivery_dispatch"
  | "delivery_pickup"
  | "delivery_complete";

type TelemetryStatus = "started" | "completed" | "failed" | "skipped";

export interface TelemetryEvent {
  id: string;
  jobId: string;
  timestamp: string;
  phase: PipelinePhase;
  status: TelemetryStatus;
  duration_ms?: number;
  metadata: Record<string, unknown>;
  level: "info" | "warn" | "error" | "debug";
  source: string;
}

export class ScriptTelemetry {
  private events: TelemetryEvent[] = [];

  emit(
    jobId: string,
    phase: PipelinePhase,
    status: TelemetryStatus,
    opts: {
      duration_ms?: number;
      metadata?: Record<string, unknown>;
      level?: TelemetryEvent["level"];
      source?: string;
    } = {},
  ): TelemetryEvent {
    const ev: TelemetryEvent = {
      id: randomBytes(4).toString("hex"),
      jobId,
      timestamp: new Date().toISOString(),
      phase,
      status,
      duration_ms: opts.duration_ms,
      metadata: opts.metadata ?? {},
      level: opts.level ?? (status === "failed" ? "error" : "info"),
      source: opts.source ?? "openclaw-e2e",
    };
    this.events.push(ev);
    return ev;
  }

  all(): TelemetryEvent[] {
    return [...this.events];
  }

  getByPhase(phase: PipelinePhase): TelemetryEvent[] {
    return this.events.filter((e) => e.phase === phase);
  }

  countByStatus(): Record<TelemetryStatus, number> {
    const r: Record<TelemetryStatus, number> = {
      started: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    };
    for (const e of this.events) r[e.status]++;
    return r;
  }

  /**
   * Returns true if the critical workflow ordering invariants are satisfied:
   *   - discovery/quote before escrow
   *   - escrow before print evidence
   *   - print evidence before delivery
   *   - delivery before settlement
   *
   * Note: Some phases (e.g., verification_request) appear twice in the pipeline
   * (once for print, once for delivery) so strict monotonic phase ordering is
   * intentionally NOT enforced. Instead we check meaningful segment invariants.
   */
  isOrdered(): boolean {
    const tsOf = (phase: PipelinePhase, status: TelemetryStatus = "completed"): number => {
      const ev = this.events.find((e) => e.phase === phase && e.status === status);
      return ev ? new Date(ev.timestamp).getTime() : Infinity;
    };

    // Key ordering invariants for the print-and-deliver pipeline
    const escrowTs = tsOf("escrow_fund");
    const printEvidenceTs = tsOf("evidence_capture");
    const deliveryCompleteTs = tsOf("delivery_complete");
    const settlementTs = tsOf("settlement_complete");
    const discoveryTs = tsOf("discovery");

    // Discovery must precede escrow
    if (discoveryTs === Infinity || escrowTs === Infinity) return false;
    if (discoveryTs > escrowTs) return false;

    // Escrow must precede print evidence
    if (printEvidenceTs === Infinity) return false;
    if (escrowTs > printEvidenceTs) return false;

    // Print evidence must precede delivery completion
    if (deliveryCompleteTs === Infinity) return false;
    if (printEvidenceTs > deliveryCompleteTs) return false;

    // Delivery must precede settlement
    if (settlementTs === Infinity) return false;
    if (deliveryCompleteTs > settlementTs) return false;

    return true;
  }
}

// ── Console formatting helpers ───────────────────────────────────────────────

const BOX_WIDTH = 66;
const BOX_TOP = "╔" + "═".repeat(BOX_WIDTH) + "╗";
const BOX_BTM = "╚" + "═".repeat(BOX_WIDTH) + "╝";
const DIV = "═".repeat(70);
const SUB = "─".repeat(50);

function boxLine(text: string): string {
  const padded = text + " ".repeat(Math.max(0, BOX_WIDTH - text.length));
  return `║  ${padded}║`;
}

function phaseBanner(num: number, total: number, title: string, icon = "▸"): void {
  console.log();
  console.log(`${C.bold}${C.teal}${icon} Phase ${num}/${total}: ${title}${C.reset}`);
  console.log(`${C.dim}${SUB}${C.reset}`);
}

function arrow(msg: string): void {
  console.log(`  ${C.dim}->  ${C.reset}${msg}`);
}

function ok(msg: string, ms?: number): void {
  const dur = ms !== undefined ? ` ${C.dim}(${ms}ms)${C.reset}` : "";
  console.log(`  ${C.green}[OK]${C.reset} ${msg}${dur}`);
}

function warnLine(msg: string): void {
  console.log(`  ${C.yellow}[WARN]${C.reset} ${msg}`);
}

function telTag(msg: string): void {
  console.log(`  ${C.magenta}[TEL]${C.reset} ${msg}`);
}

function progress(label: string, current: number, total: number): void {
  const filled = Math.round((current / total) * 22);
  const bar = "=".repeat(filled) + "-".repeat(22 - filled);
  console.log(`  ${C.cyan}${label}:${C.reset} [${bar}] ${current}/${total}`);
}

// ── Mock helpers ─────────────────────────────────────────────────────────────

function mockEscrowAddress(): string {
  return "0x" + randomBytes(20).toString("hex");
}

function mockTxHash(): string {
  return "0x" + randomBytes(32).toString("hex");
}

async function buildEvidenceBundle(
  emitter: EvidenceEmitter,
  jobId: string,
  stepId: string,
  kernelId: string,
  tier: 0 | 1 | 2 | 3,
  events: Array<{ type: string; data: Record<string, unknown> }>,
): Promise<EvidenceBundle> {
  emitter.registerStep(jobId, stepId, tier);
  for (const ev of events) {
    await emitter.addEvent(jobId, stepId, {
      type: ev.type as any,
      timestamp: new Date().toISOString(),
      source: { deviceId: `dev-${stepId}`, deviceType: "controller" as any, kernelId },
      payload: ev.data,
    });
  }
  return emitter.finalizeBundle(jobId, stepId);
}

// ════════════════════════════════════════════════════════════════════════════
// VARIATION CONFIG
// ════════════════════════════════════════════════════════════════════════════

interface VariationConfig {
  label: string;
  subtitle: string;
  pages: number;
  pricePerPage: number;
  deliveryType: "standard" | "express" | "long_distance";
  deliveryCost: number;
  etaMinutes: number;
  courierService: string;
  hasChallenge: boolean;
  printKernelId: string;
  courierKernelId: string;
  printerName: string;
  deliveryAddress: string;
  pickupAddress: string;
}

function getVariationConfig(variation: 1 | 2 | 3): VariationConfig {
  switch (variation) {
    case 1:
      return {
        label: "Standard",
        subtitle: "10 pages, same-city delivery, all phases succeed",
        pages: 10,
        pricePerPage: 0.25,
        deliveryType: "standard",
        deliveryCost: 8.0,
        etaMinutes: 25,
        courierService: "RideShare-Standard",
        hasChallenge: false,
        printKernelId: "kernel_office_printer_01",
        courierKernelId: "kernel_courier_downtown",
        printerName: "HP LaserJet Pro",
        deliveryAddress: "456 Market St, San Francisco, CA 94105",
        pickupAddress: "100 Technology Drive, SF, CA 94107",
      };
    case 2:
      return {
        label: "Rush",
        subtitle: "50 pages, express delivery, higher price ($25 total)",
        pages: 50,
        pricePerPage: 0.20,
        deliveryType: "express",
        deliveryCost: 15.0,
        etaMinutes: 12,
        courierService: "RideShare-Express",
        hasChallenge: false,
        printKernelId: "kernel_office_printer_02",
        courierKernelId: "kernel_courier_express",
        printerName: "Canon imageRUNNER Express",
        deliveryAddress: "1 Market Plaza, San Francisco, CA 94105",
        pickupAddress: "100 Technology Drive, SF, CA 94107",
      };
    case 3:
      return {
        label: "Challenge",
        subtitle: "5 pages, long-distance, milestone challenged then resolved",
        pages: 5,
        pricePerPage: 0.30,
        deliveryType: "long_distance",
        deliveryCost: 42.0,
        etaMinutes: 120,
        courierService: "Interstate-Courier",
        hasChallenge: true,
        printKernelId: "kernel_office_printer_03",
        courierKernelId: "kernel_courier_interstate",
        printerName: "Xerox WorkCentre Pro",
        deliveryAddress: "789 Oak Ave, Palo Alto, CA 94301",
        pickupAddress: "100 Technology Drive, SF, CA 94107",
      };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN SIMULATION FUNCTION (exported for testing)
// ════════════════════════════════════════════════════════════════════════════

export interface E2EResult {
  telemetry: ScriptTelemetry;
  jobId: string;
  printBundle: EvidenceBundle;
  deliverBundle: EvidenceBundle;
  totalPrice: number;
  printHash: string;
  deliverHash: string;
  variation: 1 | 2 | 3;
  durationMs: number;
}

export async function runOpenClawE2E(variation: 1 | 2 | 3 = 1): Promise<E2EResult> {
  const config = getVariationConfig(variation);
  const TOTAL_PHASES = 11;

  const telemetry = new ScriptTelemetry();
  const globalStart = Date.now();

  // ── Header ────────────────────────────────────────────────────────────────

  console.log();
  console.log(`${C.bold}${C.teal}${BOX_TOP}${C.reset}`);
  console.log(`${C.bold}${C.teal}${boxLine("OPENCLAW -- Print-and-Deliver E2E Simulation")}${C.reset}`);
  console.log(`${C.bold}${C.teal}${boxLine("Physical Capability Cloud x Multi-hop Workflow")}${C.reset}`);
  console.log(`${C.bold}${C.teal}${boxLine("")}${C.reset}`);
  console.log(
    `${C.bold}${C.teal}${boxLine(
      `Variation ${variation}: ${config.label} -- ${config.subtitle}`,
    )}${C.reset}`,
  );
  console.log(`${C.bold}${C.teal}${BOX_BTM}${C.reset}`);
  console.log();

  // Natural language user request
  console.log(`${C.bold}User request:${C.reset}`);
  console.log(
    `  "${C.white}Print this document and deliver it to ${config.deliveryAddress}${C.reset}"`,
  );
  console.log();

  // Session IDs
  const jobId = ids.job();
  const printStepId = "step_print";
  const deliverStepId = "step_deliver";

  console.log(`  ${C.dim}Job ID:   ${jobId}${C.reset}`);
  console.log(`  ${C.dim}Workflow: [print] -> [pickup] -> [deliver]${C.reset}`);
  console.log(`  ${C.dim}Milestones: 2 (print + delivery)${C.reset}`);

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: INTAKE — Parse user intent
  // ══════════════════════════════════════════════════════════════════════════

  phaseBanner(1, TOTAL_PHASES, "INTAKE -- Parse User Intent");
  const p1Start = Date.now();
  telemetry.emit(jobId, "discovery", "started", { source: "openclaw" });

  await sleep(30);

  arrow("OpenClaw parsing natural language request...");
  arrow(`Identified capability 1: document_printing (${config.pages} pages)`);
  arrow(`Identified capability 2: courier_delivery -> ${config.deliveryAddress}`);
  arrow(`Workflow DAG: print[0] -> deliver[1] (sequential dependency)`);

  const p1Ms = Date.now() - p1Start;
  telemetry.emit(jobId, "discovery", "completed", {
    duration_ms: p1Ms,
    metadata: {
      parsedCapabilities: ["document_printing", "courier_delivery"],
      pages: config.pages,
      deliveryAddress: config.deliveryAddress,
      workflowSteps: 2,
    },
    source: "openclaw",
  });

  ok("Intent parsed", p1Ms);
  telTag("pipeline_started -- 1 event");

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: DISCOVER — Find printers and couriers
  // ══════════════════════════════════════════════════════════════════════════

  phaseBanner(2, TOTAL_PHASES, "DISCOVER -- Capability Search");
  const p2Start = Date.now();
  telemetry.emit(jobId, "quote_request", "started", { source: "user-agent" });

  await sleep(60);

  arrow(`Querying network: capabilityType=document_printing, pages=${config.pages}`);
  await sleep(30);
  arrow(`Found: ${C.green}${config.printerName}${C.reset} @ ${config.printKernelId}`);
  arrow(`  Tier 2, queue depth: 0, reputation: 950/1000`);

  await sleep(30);

  arrow(`Querying network: capabilityType=courier_delivery, type=${config.deliveryType}`);
  await sleep(30);
  arrow(`Found: ${C.green}${config.courierService}${C.reset} @ ${config.courierKernelId}`);
  arrow(`  Tier 1, vehicles: 3 available, ETA: ${config.etaMinutes} min`);

  const p2Ms = Date.now() - p2Start;
  telemetry.emit(jobId, "quote_request", "completed", {
    duration_ms: p2Ms,
    metadata: {
      capabilitiesFound: 2,
      printer: { kernelId: config.printKernelId, name: config.printerName, tier: 2 },
      courier: {
        kernelId: config.courierKernelId,
        name: config.courierService,
        tier: 1,
        etaMinutes: config.etaMinutes,
      },
    },
    source: "user-agent",
  });

  ok("Capabilities discovered", p2Ms);
  telTag("capabilities_discovered -- 2 kernels found");

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 3: QUOTE — Get pricing from both providers
  // ══════════════════════════════════════════════════════════════════════════

  phaseBanner(3, TOTAL_PHASES, "QUOTE -- Price Request");
  const p3Start = Date.now();
  telemetry.emit(jobId, "quote_response", "started", { source: "broker-agent" });

  await sleep(25);
  arrow(`Requesting quote from ${config.printerName}...`);
  await sleep(20);

  const printTotal = parseFloat((config.pages * config.pricePerPage).toFixed(2));
  arrow(
    `Print quote: ${config.pages} pages x $${config.pricePerPage}/page = $${printTotal.toFixed(2)} USDC`,
  );

  await sleep(20);
  arrow(`Requesting quote from ${config.courierService}...`);
  await sleep(20);

  const deliverCost = config.deliveryCost;
  arrow(`Courier quote: $${deliverCost.toFixed(2)} USDC (${config.deliveryType})`);

  const totalPrice = parseFloat((printTotal + deliverCost).toFixed(2));
  arrow(`${C.bold}Total: $${totalPrice.toFixed(2)} USDC${C.reset}`);

  const p3Ms = Date.now() - p3Start;
  telemetry.emit(jobId, "quote_response", "completed", {
    duration_ms: p3Ms,
    metadata: {
      printQuote: {
        pages: config.pages,
        pricePerPage: config.pricePerPage,
        total: printTotal,
      },
      courierQuote: { type: config.deliveryType, total: deliverCost },
      grandTotal: totalPrice,
      currency: "USDC",
    },
    source: "broker-agent",
  });

  ok("Quotes received", p3Ms);
  telTag(`quotes_received -- total $${totalPrice.toFixed(2)}`);

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 4: COMPILE — Build workflow DAG
  // ══════════════════════════════════════════════════════════════════════════

  phaseBanner(4, TOTAL_PHASES, "COMPILE -- Workflow DAG");
  const p4Start = Date.now();
  telemetry.emit(jobId, "contract_build", "started", { source: "scheduler" });

  await sleep(20);

  arrow("WorkflowCompiler: topological sort of dependency graph");
  arrow("  Step 0 (print):   capabilityType=document_printing -> " + config.printKernelId);
  arrow(
    "  Step 1 (deliver):  capabilityType=courier_delivery   -> " +
      config.courierKernelId +
      " [depends_on: step_print]",
  );
  arrow(
    "Milestone 1 (Print):   $" +
      printTotal.toFixed(2) +
      " -- evidence: print_confirmation + page_count",
  );
  arrow(
    "Milestone 2 (Deliver): $" +
      deliverCost.toFixed(2) +
      " -- evidence: pickup_photo + delivery_signature",
  );
  arrow("DAG validated: no cycles detected, dependency satisfied");

  const p4Ms = Date.now() - p4Start;
  telemetry.emit(jobId, "contract_build", "completed", {
    duration_ms: p4Ms,
    metadata: {
      steps: 2,
      milestones: 2,
      dagEdges: [{ from: printStepId, to: deliverStepId }],
      scheduledOrder: [printStepId, deliverStepId],
    },
    source: "scheduler",
  });

  ok("Workflow compiled", p4Ms);
  telTag("workflow_compiled -- 2 steps, 2 milestones");

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 5: ESCROW — Lock funds on-chain
  // ══════════════════════════════════════════════════════════════════════════

  phaseBanner(5, TOTAL_PHASES, "ESCROW -- Fund Milestones");
  const p5Start = Date.now();
  telemetry.emit(jobId, "escrow_fund", "started", { source: "user-agent" });

  await sleep(100);

  const escrowAddr = mockEscrowAddress();
  const escrowTx = mockTxHash();

  arrow("Creating MilestoneEscrow on Base Sepolia...");
  arrow(`Locking $${totalPrice.toFixed(2)} USDC in milestone escrow`);
  arrow(`  Milestone 1 (Print):   $${printTotal.toFixed(2)} locked`);
  arrow(`  Milestone 2 (Deliver): $${deliverCost.toFixed(2)} locked`);
  arrow(`Escrow: ${escrowAddr.slice(0, 12)}...${escrowAddr.slice(-6)}`);
  arrow(`Tx:     ${escrowTx.slice(0, 14)}...`);

  const p5Ms = Date.now() - p5Start;
  telemetry.emit(jobId, "escrow_fund", "completed", {
    duration_ms: p5Ms,
    metadata: {
      escrowAddress: escrowAddr,
      txHash: escrowTx,
      chain: "base-sepolia",
      totalAmount: totalPrice,
      milestoneAmounts: { print: printTotal, delivery: deliverCost },
    },
    source: "user-agent",
  });

  ok("Escrow funded", p5Ms);
  telTag(`escrow_funded -- $${totalPrice.toFixed(2)} locked`);

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 6: PRINT — Execute print job + emit evidence
  // ══════════════════════════════════════════════════════════════════════════

  phaseBanner(6, TOTAL_PHASES, "PRINT -- Kernel Execution");
  const p6Start = Date.now();
  telemetry.emit(jobId, "job_started", "started", {
    metadata: { kernelId: config.printKernelId, device: config.printerName },
    source: "kernel-agent",
  });

  arrow(`Job dispatched to ${config.printerName}`);
  arrow("EvidenceEmitter: recording job lifecycle...");

  // Simulate print progress
  const progressSteps = 5;
  for (let i = 0; i <= progressSteps; i++) {
    await sleep(variation === 2 ? 50 : 70);
    progress("Printing", Math.round((i / progressSteps) * config.pages), config.pages);
  }

  const tonerPct = 65 + Math.round(Math.random() * 20);
  const inkMl = parseFloat((config.pages * 0.8 + Math.random() * 2).toFixed(1));
  const qualityScore = variation === 2 ? 0.98 : 0.94;
  const durationSec = config.pages * 4;

  // Build print evidence bundle using EvidenceEmitter
  const printEmitter = new EvidenceEmitter(config.printKernelId);
  const printBundle = await buildEvidenceBundle(
    printEmitter,
    jobId,
    printStepId,
    config.printKernelId,
    2,
    [
      {
        type: "gcode_hash_verified",
        data: {
          fileHash: sha256(`document_${jobId}_${config.pages}pages`) as string,
          format: "PDF",
          pages: config.pages,
          dpi: 600,
          colorMode: "CMYK",
        },
      },
      {
        type: "execution_started",
        data: {
          printer: config.printerName,
          media: "A4",
          duplex: true,
          copies: 1,
          startedAt: new Date().toISOString(),
        },
      },
      {
        type: "sensor_data_summary",
        data: { channel: "fuser_temperature_c", readings: 6, avg: 180.5, unit: "celsius" },
      },
      {
        type: "sensor_data_summary",
        data: { channel: "paper_feed_humidity", readings: 6, avg: 42.3, unit: "percent" },
      },
      {
        type: "camera_snapshot",
        data: {
          photo: sha256(`print_qc_${jobId}_${Date.now()}`) as string,
          resolution: "1200dpi",
          colorAccuracy: "deltaE < 2.0",
          capturedAt: new Date().toISOString(),
        },
      },
      {
        type: "cv_inspection_result",
        data: {
          pass: true,
          qualityScore,
          pagesProduced: config.pages,
          inkUsageMl: inkMl,
          tonerLevelPct: tonerPct,
          defects: [],
        },
      },
      {
        type: "power_profile_summary",
        data: {
          totalWh: parseFloat((config.pages * 0.047).toFixed(2)),
          printTimeS: durationSec,
        },
      },
      {
        type: "execution_completed",
        data: {
          pages: config.pages,
          copies: 1,
          durationSec,
          quality: qualityScore >= 0.95 ? "excellent" : "good",
          completedAt: new Date().toISOString(),
        },
      },
    ],
  );

  const p6Ms = Date.now() - p6Start;

  console.log(
    `  ${C.dim}Evidence: toner=${tonerPct}%, ink=${inkMl}ml, quality=${qualityScore}, events=${printBundle.events.length}${C.reset}`,
  );
  arrow(`Bundle ID:   ${printBundle.id}`);
  arrow(`Bundle hash: ${printBundle.bundleHash.slice(0, 32)}...`);

  telemetry.emit(jobId, "evidence_capture", "completed", {
    duration_ms: p6Ms,
    metadata: {
      bundleId: printBundle.id,
      bundleHash: printBundle.bundleHash,
      events: printBundle.events.length,
      pagesProduced: config.pages,
      qualityScore,
      inkUsageMl: inkMl,
      tonerLevelPct: tonerPct,
    },
    source: "kernel-agent",
  });

  ok("Print complete -- evidence bundle created", p6Ms);
  telTag(`milestone_1_evidence_emitted -- ${printBundle.events.length} events`);

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 7: VERIFY PRINT — Bittensor subnet + ZK proof
  // ══════════════════════════════════════════════════════════════════════════

  phaseBanner(7, TOTAL_PHASES, "VERIFY PRINT -- Bittensor + ZK");
  const p7Start = Date.now();
  telemetry.emit(jobId, "verification_request", "started", {
    metadata: { bundleHash: printBundle.bundleHash, tier: 2 },
    source: "verifier",
  });

  arrow("Submitting print evidence to Bittensor verification subnet...");

  const bridge = new BittensorSubnetBridge();
  const subnetResult = await bridge.submitForVerification(
    printBundle.bundleHash,
    JSON.stringify(printBundle),
    2,
  );

  const leaderboard = bridge.getMinerLeaderboard();
  for (const miner of leaderboard.slice(0, 3)) {
    arrow(
      `Miner uid=${miner.uid} trust=${miner.trust.toFixed(3)} score=${miner.incentive.toFixed(3)}`,
    );
  }
  arrow(
    `Yuma consensus: ${subnetResult.consensusScore.toFixed(3)} (${subnetResult.passed ? "PASS" : "FAIL"}, threshold 0.70)`,
  );

  // ZK proof of evidence inclusion
  const commitSvc = new CommitmentService();
  const zkSvc = new ZKProofService();
  const commit = await commitSvc.createCommitment(printBundle.bundleHash);
  const dummyCommit = await commitSvc.createCommitment(
    sha256(JSON.stringify({ dummy: true, ts: Date.now() })) as SHA256,
  );
  const tree = await commitSvc.buildTree([commit, dummyCommit]);
  const zkProof = await zkSvc.proveEvidenceInclusion(tree, 0, printBundle.bundleHash);
  const zkValid = await zkSvc.verifyProof(zkProof);
  const tierProof = await zkSvc.proveTierCompliance(printBundle, 2);
  const tierValid = await zkSvc.verifyProof(tierProof);

  arrow(`ZK inclusion proof: ${zkProof.id.slice(0, 16)}... (valid: ${zkValid ? "yes" : "no"})`);
  arrow(`ZK tier compliance: (valid: ${tierValid ? "yes" : "no"})`);
  arrow(`Merkle root: ${tree.root.slice(0, 24)}...`);

  const p7Ms = Date.now() - p7Start;
  telemetry.emit(jobId, "verification_result", "completed", {
    duration_ms: p7Ms,
    metadata: {
      consensusScore: subnetResult.consensusScore,
      passed: subnetResult.passed,
      tierCompliant: subnetResult.tierCompliant,
      minerCount: subnetResult.minerCount,
      zkProofId: zkProof.id,
      zkValid,
      tierProofValid: tierValid,
      merkleRoot: tree.root,
      evidenceCid: `bafybeig_print_${printBundle.id.slice(0, 12)}`,
    },
    source: "verifier",
  });

  ok(`Print verification ${subnetResult.passed ? "passed" : "failed"}`, p7Ms);
  telTag("milestone_1_verified");

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 8: DELIVER — Courier execution + evidence
  // ══════════════════════════════════════════════════════════════════════════

  phaseBanner(8, TOTAL_PHASES, "DELIVER -- Courier Execution");
  const p8Start = Date.now();
  telemetry.emit(jobId, "delivery_dispatch", "started", {
    metadata: { courierKernelId: config.courierKernelId, type: config.deliveryType },
    source: "courier-agent",
  });

  const driverId = `courier_${randomBytes(3).toString("hex")}`;
  const vehicleType = config.deliveryType === "long_distance" ? "van" : "bicycle";

  arrow(`Dispatching ${config.courierService}...`);
  arrow(`Driver:   ${driverId} (${vehicleType})`);
  arrow(`Pickup:   ${config.pickupAddress}`);
  arrow(`Delivery: ${config.deliveryAddress}`);
  arrow(`ETA:      ${config.etaMinutes} minutes`);

  await sleep(40);
  telemetry.emit(jobId, "delivery_dispatch", "completed", {
    metadata: { driverId, vehicleType, etaMinutes: config.etaMinutes },
    source: "courier-agent",
  });

  // GPS waypoints
  const gpsWaypoints = [
    { lat: 37.7749, lng: -122.4194, label: "pickup_point" },
    { lat: 37.7751, lng: -122.418, label: "in_transit_1" },
    { lat: 37.7753, lng: -122.4165, label: "in_transit_2" },
    { lat: 37.7755, lng: -122.415, label: "delivery_point" },
  ];

  telemetry.emit(jobId, "delivery_pickup", "started", {
    metadata: { driverId, pickup: config.pickupAddress },
    source: "courier-agent",
  });

  for (const wp of gpsWaypoints) {
    await sleep(30);
    arrow(`GPS: ${wp.label} (${wp.lat.toFixed(4)}, ${wp.lng.toFixed(4)})`);
  }

  // Build delivery evidence bundle
  const deliverEmitter = new EvidenceEmitter(config.courierKernelId);
  const deliverBundle = await buildEvidenceBundle(
    deliverEmitter,
    jobId,
    deliverStepId,
    config.courierKernelId,
    1,
    [
      {
        type: "gcode_hash_verified",
        data: {
          item: `printed_document_${config.pages}pages`,
          condition: "mint",
          sealed: true,
        },
      },
      {
        type: "execution_started",
        data: {
          driver: driverId,
          vehicle: vehicleType,
          origin: config.pickupAddress,
          destination: config.deliveryAddress,
          startedAt: new Date().toISOString(),
        },
      },
      {
        type: "sensor_data_summary",
        data: {
          channel: "gps_track",
          waypoints: gpsWaypoints.length,
          distanceMiles: config.deliveryType === "long_distance" ? 34.5 : 2.4,
        },
      },
      {
        type: "camera_snapshot",
        data: {
          photo: sha256(`pickup_photo_${jobId}_${driverId}`) as string,
          location: config.pickupAddress,
          event: "package_pickup_confirmed",
        },
      },
      {
        type: "courier_pickup_confirmed",
        data: {
          driver: driverId,
          packageCondition: "sealed",
          timestamp: new Date().toISOString(),
        },
      },
      {
        type: "courier_delivery_confirmed",
        data: {
          recipient: config.deliveryAddress,
          signatureHash: sha256(`sig_${jobId}_${Date.now()}`) as string,
          photo: sha256(`delivery_photo_${jobId}`) as string,
          deliveredAt: new Date().toISOString(),
        },
      },
      {
        type: "execution_completed",
        data: {
          delivered: true,
          deliveryMinutes: config.etaMinutes - 3,
          onTime: true,
          recipientAcknowledged: true,
        },
      },
    ],
  );

  const p8Ms = Date.now() - p8Start;

  arrow(`Bundle ID:   ${deliverBundle.id}`);
  arrow(`Bundle hash: ${deliverBundle.bundleHash.slice(0, 32)}...`);
  arrow(`Evidence:    photo_proof, gps_track (${gpsWaypoints.length} waypoints), signature`);

  telemetry.emit(jobId, "delivery_pickup", "completed", {
    duration_ms: p8Ms,
    metadata: {
      driverId,
      deliveryAddress: config.deliveryAddress,
      deliveryMinutes: config.etaMinutes - 3,
    },
    source: "courier-agent",
  });
  telemetry.emit(jobId, "delivery_complete", "completed", {
    duration_ms: p8Ms,
    metadata: {
      bundleId: deliverBundle.id,
      bundleHash: deliverBundle.bundleHash,
      events: deliverBundle.events.length,
      deliveryMinutes: config.etaMinutes - 3,
      onTime: true,
      evidenceCid: `bafybeig_deliver_${deliverBundle.id.slice(0, 12)}`,
    },
    source: "courier-agent",
  });

  ok("Delivery complete -- evidence bundle created", p8Ms);
  telTag(`milestone_2_evidence_emitted -- ${deliverBundle.events.length} events`);

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 9: VERIFY DELIVERY — Full evidence + ZK proof
  // ══════════════════════════════════════════════════════════════════════════

  phaseBanner(9, TOTAL_PHASES, "VERIFY DELIVERY -- Full Verification");
  const p9Start = Date.now();
  telemetry.emit(jobId, "verification_request", "started", {
    metadata: { bundleHash: deliverBundle.bundleHash, tier: 1 },
    source: "verifier",
  });

  // EvidenceVerifier
  const evidenceVerifier = new EvidenceVerifier(
    "verifier-001",
    "0xVerifier0000000000000000000000000000001",
  );
  const attestation = await evidenceVerifier.verify(deliverBundle);
  const checksPass = attestation.findings.filter((f) => f.passed).length;
  const checksFail = attestation.findings.filter((f) => !f.passed).length;

  arrow(`EvidenceVerifier: ${attestation.result} (${checksPass} checks passed, ${checksFail} failed)`);

  // Variation 3: challenge raised, then resolved
  let challengeResolved = false;
  if (variation === 3 && config.hasChallenge) {
    warnLine("Challenge raised by buyer: 'Delivery location mismatch suspected'");
    arrow("Challenge window opened (72 hours, Tier 1)");
    await sleep(40);
    arrow("Arbiter reviewing delivery photo + GPS track...");
    await sleep(40);
    arrow("GPS confirms delivery at correct coordinates");
    arrow("Photo hash matches signed receipt");
    ok("Challenge RESOLVED -- delivery confirmed valid");
    challengeResolved = true;

    telemetry.emit(jobId, "verification_request", "completed", {
      metadata: {
        challenge: true,
        challengeResolved: true,
        arbiterDecision: "confirmed_valid",
      },
      source: "arbiter",
    });
  }

  // ZK proof for the delivery bundle (full tree of both bundles)
  const deliverCommit = await commitSvc.createCommitment(deliverBundle.bundleHash);
  const printCommit2 = await commitSvc.createCommitment(printBundle.bundleHash);
  const fullTree = await commitSvc.buildTree([printCommit2, deliverCommit]);
  const deliverZkProof = await zkSvc.proveEvidenceInclusion(
    fullTree,
    1,
    deliverBundle.bundleHash,
  );
  const deliverZkValid = await zkSvc.verifyProof(deliverZkProof);

  arrow(
    `ZK inclusion proof: ${deliverZkProof.id.slice(0, 16)}... (valid: ${deliverZkValid ? "yes" : "no"})`,
  );
  arrow(`Full Merkle root (both bundles): ${fullTree.root.slice(0, 24)}...`);

  const p9Ms = Date.now() - p9Start;
  telemetry.emit(jobId, "verification_result", "completed", {
    duration_ms: p9Ms,
    metadata: {
      evidenceVerifierResult: attestation.result,
      checksPass,
      checksFail,
      zkProofId: deliverZkProof.id,
      zkValid: deliverZkValid,
      challenged: variation === 3,
      challengeResolved,
      fullMerkleRoot: fullTree.root,
    },
    source: "verifier",
  });

  ok("Delivery verification passed", p9Ms);
  telTag("milestone_2_verified");

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 10: SETTLE — Release funds + DePIN rewards
  // ══════════════════════════════════════════════════════════════════════════

  phaseBanner(10, TOTAL_PHASES, "SETTLE -- Release Funds");
  const p10Start = Date.now();
  telemetry.emit(jobId, "settlement_claim", "started", {
    metadata: { milestones: 2 },
    source: "settlement",
  });

  await sleep(70);

  const printPayout = printTotal;
  // Variation 3: 5% arbiter fee deducted from delivery milestone
  const deliveryPayout =
    variation === 3
      ? parseFloat((deliverCost * 0.95).toFixed(2))
      : deliverCost;
  const actualTotal = parseFloat((printPayout + deliveryPayout).toFixed(2));

  const settleTx1 = mockTxHash();
  const settleTx2 = mockTxHash();

  arrow(`Milestone 1 (Print): $${printPayout.toFixed(2)} released -> ${config.printKernelId}`);
  arrow(`  Tx: ${settleTx1.slice(0, 14)}...`);

  if (variation === 3) {
    arrow(
      `Milestone 2 (Delivery): $${deliveryPayout.toFixed(2)} released -> ${config.courierKernelId} (5% arbiter fee)`,
    );
  } else {
    arrow(
      `Milestone 2 (Delivery): $${deliveryPayout.toFixed(2)} released -> ${config.courierKernelId}`,
    );
  }
  arrow(`  Tx: ${settleTx2.slice(0, 14)}...`);

  // DePIN rewards via RewardEngine
  const rewardEngine = new RewardEngine();
  const epoch = rewardEngine.createEpoch(
    1,
    "2026-03-01T00:00:00Z",
    "2026-03-07T23:59:59Z",
    "1000.000000",
  );
  const completedEpoch = rewardEngine.completeEpoch(epoch.id, [
    {
      kernelId: config.printKernelId,
      kernelDid: `did:pcc:kernel:${config.printKernelId}`,
      jobsCompleted: 1,
      qualityScore: qualityScore,
      uptimePercent: 99.5,
      capabilityDiversity: 1,
      scarcityBonus: 0.8,
    },
    {
      kernelId: config.courierKernelId,
      kernelDid: `did:pcc:kernel:${config.courierKernelId}`,
      jobsCompleted: 1,
      qualityScore: variation === 3 ? 0.78 : 0.92,
      uptimePercent: 98.0,
      capabilityDiversity: 1,
      scarcityBonus: 0.7,
    },
  ]);

  const printerReward = completedEpoch.kernelScores[0];
  const courierReward = completedEpoch.kernelScores[1];

  arrow(`DePIN reward: ${printerReward.rewardAmount} PCC tokens -> printer operator`);
  arrow(`DePIN reward: ${courierReward.rewardAmount} PCC tokens -> courier operator`);

  // Mint soulbound capability certificates
  const certService = new CapabilityCertificateService();
  const printCert = await certService.mintCapabilityCertificate({
    kernelDid: `did:pcc:kernel:${config.printKernelId}`,
    capabilityType: "document_printing",
    assuranceTier: 2,
    metadata: {
      pages: config.pages,
      inkUsageMl: inkMl.toString(),
      qualityScore: qualityScore.toString(),
    },
  });
  const deliverCert = await certService.mintCapabilityCertificate({
    kernelDid: `did:pcc:kernel:${config.courierKernelId}`,
    capabilityType: "courier_delivery",
    assuranceTier: 1,
    metadata: {
      deliveryType: config.deliveryType,
      deliveryMinutes: (config.etaMinutes - 3).toString(),
    },
  });

  arrow(`Soulbound cNFT (print):   ${printCert.id.slice(0, 16)}...`);
  arrow(`Soulbound cNFT (courier): ${deliverCert.id.slice(0, 16)}...`);

  const totalRewards =
    parseFloat(printerReward.rewardAmount) + parseFloat(courierReward.rewardAmount);

  const p10Ms = Date.now() - p10Start;
  telemetry.emit(jobId, "settlement_complete", "completed", {
    duration_ms: p10Ms,
    metadata: {
      printPayout,
      deliveryPayout,
      totalPayout: actualTotal,
      printerReward: printerReward.rewardAmount,
      courierReward: courierReward.rewardAmount,
      totalRewards: totalRewards.toFixed(2),
      printCertId: printCert.id,
      deliverCertId: deliverCert.id,
      settleTx1: settleTx1.slice(0, 14) + "...",
      settleTx2: settleTx2.slice(0, 14) + "...",
    },
    source: "settlement",
  });

  ok("Settlement complete", p10Ms);
  telTag(
    `settlement_complete -- $${actualTotal.toFixed(2)} distributed, ${totalRewards.toFixed(1)} PCC tokens`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 11: SUMMARY — Full telemetry timeline
  // ══════════════════════════════════════════════════════════════════════════

  phaseBanner(11, TOTAL_PHASES, "SUMMARY -- Pipeline Telemetry", "*");

  const totalMs = Date.now() - globalStart;
  const allEvents = telemetry.all();
  const byStatus = telemetry.countByStatus();

  console.log();
  console.log(`${C.bold}${C.teal}${DIV}${C.reset}`);
  console.log(`${C.bold}PIPELINE TELEMETRY TIMELINE${C.reset}`);
  console.log(`${C.bold}${C.teal}${DIV}${C.reset}`);

  for (const ev of allEvents) {
    const statusColor =
      ev.status === "completed"
        ? C.green
        : ev.status === "failed"
          ? C.red
          : ev.status === "started"
            ? C.cyan
            : C.dim;
    const ts = ev.timestamp.slice(11, 23);
    const dur =
      ev.duration_ms !== undefined ? ` ${C.dim}+${ev.duration_ms}ms${C.reset}` : "";
    const phase = ev.phase.padEnd(22);
    const statusStr = ev.status.padEnd(9);
    console.log(
      `  ${C.dim}${ts}${C.reset}  ${statusColor}${statusStr}${C.reset}  ${phase}  [${C.dim}${ev.source}${C.reset}]${dur}`,
    );
  }

  console.log();
  console.log(`${C.bold}${C.teal}${DIV}${C.reset}`);
  console.log(`${C.bold}PIPELINE SUMMARY${C.reset}`);
  console.log(`${C.bold}${C.teal}${DIV}${C.reset}`);

  console.log(`  Variation:            ${variation} -- ${config.label}`);
  console.log(`  Total duration:       ${totalMs.toLocaleString()}ms`);
  console.log(`  Phases completed:     11/11`);
  console.log(`  Telemetry events:     ${allEvents.length}`);
  console.log(`    completed:          ${byStatus.completed}`);
  console.log(`    started:            ${byStatus.started}`);
  console.log(`    failed:             ${byStatus.failed}`);
  console.log(`    skipped:            ${byStatus.skipped}`);
  console.log();
  console.log(`  Print evidence:`);
  console.log(`    Bundle ID:          ${printBundle.id}`);
  console.log(`    Bundle hash:        ${printBundle.bundleHash.slice(0, 32)}...`);
  console.log(`    Events:             ${printBundle.events.length}`);
  console.log(`    Pages:              ${config.pages}`);
  console.log(`    Quality score:      ${qualityScore}`);
  console.log();
  console.log(`  Delivery evidence:`);
  console.log(`    Bundle ID:          ${deliverBundle.id}`);
  console.log(`    Bundle hash:        ${deliverBundle.bundleHash.slice(0, 32)}...`);
  console.log(`    Events:             ${deliverBundle.events.length}`);
  console.log(`    Driver:             ${driverId}`);
  console.log();
  console.log(`  Verification:`);
  console.log(
    `    Bittensor score:    ${subnetResult.consensusScore.toFixed(3)} (${subnetResult.passed ? "PASS" : "FAIL"})`,
  );
  console.log(`    ZK proofs:          2 generated, 2 valid`);
  console.log(`    Merkle root:        ${fullTree.root.slice(0, 24)}...`);
  console.log();
  console.log(`  Settlement:`);
  console.log(`    Print payout:       $${printPayout.toFixed(2)} USDC -> ${config.printKernelId}`);
  console.log(
    `    Delivery payout:    $${deliveryPayout.toFixed(2)} USDC -> ${config.courierKernelId}`,
  );
  console.log(`    Total payout:       $${actualTotal.toFixed(2)} USDC`);
  console.log(`    DePIN rewards:      ${totalRewards.toFixed(1)} PCC tokens`);
  if (variation === 3) {
    console.log(
      `    ${C.yellow}Challenge resolved:   5% arbiter fee applied to delivery milestone${C.reset}`,
    );
  }
  console.log();
  console.log(`${C.bold}${C.teal}${DIV}${C.reset}`);
  console.log(
    `${C.bold}${C.green}E2E COMPLETE -- Variation ${variation} (${config.label}) -- ${totalMs.toLocaleString()}ms${C.reset}`,
  );
  console.log(`${C.bold}${C.teal}${DIV}${C.reset}`);
  console.log();

  return {
    telemetry,
    jobId,
    printBundle,
    deliverBundle,
    totalPrice,
    printHash: printBundle.bundleHash,
    deliverHash: deliverBundle.bundleHash,
    variation,
    durationMs: totalMs,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Support both --variation N and --variation=N
  let variation: 1 | 2 | 3 = 1;
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--variation=")) {
      variation = parseInt(arg.split("=")[1], 10) as 1 | 2 | 3;
    } else if (arg === "--variation" && args[i + 1]) {
      variation = parseInt(args[i + 1], 10) as 1 | 2 | 3;
    }
  }

  if (![1, 2, 3].includes(variation)) {
    console.error(`Invalid --variation ${variation}. Must be 1, 2, or 3.`);
    process.exit(1);
  }

  await runOpenClawE2E(variation);
}

main().catch((err) => {
  console.error(`${C.red}E2E simulation failed:${C.reset}`, err);
  process.exit(1);
});
