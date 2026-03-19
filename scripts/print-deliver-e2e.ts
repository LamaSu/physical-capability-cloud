/**
 * PCC E2E: Print & Deliver via OpenClaw
 *
 * Multi-hop workflow: user asks OpenClaw to print a research paper on the
 * lab's color laser printer and have it delivered via rideshare courier.
 *
 * Phases:
 *   1.  Capability Discovery
 *   2.  Quote Request
 *   3.  Negotiation
 *   4.  Contract Build
 *   5.  Escrow Funding
 *   6.  Print Execution
 *   7.  Evidence Archival (Lit + Storacha/IPFS)
 *   8.  Courier Dispatch
 *   9.  Delivery Completion
 *   10. Bittensor Verification
 *   11. Starknet Proof Anchoring
 *   12. Settlement & DePIN Rewards
 *
 * Variants:
 *   --variant 1  (default) All phases succeed
 *   --variant 2  Print quality fails → retry with LabPrinter-002 → success
 *   --variant 3  Delivery delayed → courier reassignment → partial settlement
 *
 * Run:
 *   npx tsx scripts/print-deliver-e2e.ts
 *   npx tsx scripts/print-deliver-e2e.ts --variant 2
 *   npx tsx scripts/print-deliver-e2e.ts --variant 3
 */

import { randomBytes } from "node:crypto";

// ── PCC package imports ───────────────────────────────────────────────────
import { ids, sha256 } from "@pcc/spec";
import type { EvidenceBundle, SHA256 } from "@pcc/spec";
import {
  EvidenceEmitter,
  LitEncryptionService,
} from "@pcc/kernel";
import {
  CommitmentService,
  ZKProofService,
  BittensorSubnetBridge,
  StarknetProofAnchoringService,
} from "@pcc/verifier";
import { CapabilityCertificateService, RewardEngine } from "@pcc/contracts";

// ── ANSI helpers ─────────────────────────────────────────────────────────
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
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Inline Telemetry (mirrors PipelineTelemetryService interface) ─────────

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

interface TelemetryEvent {
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

class ScriptTelemetry {
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
      source: opts.source ?? "print-deliver-e2e",
    };
    this.events.push(ev);
    return ev;
  }

  all(): TelemetryEvent[] {
    return this.events;
  }

  countByStatus(): Record<TelemetryStatus, number> {
    const r: Record<TelemetryStatus, number> = {
      started: 0, completed: 0, failed: 0, skipped: 0,
    };
    for (const e of this.events) r[e.status]++;
    return r;
  }
}

// ── Inline StructuredLogger (mirrors StructuredLogger interface) ──────────

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  source: string;
  jobId?: string;
  metadata?: Record<string, unknown>;
}

class ScriptLogger {
  private entries: LogEntry[] = [];
  private silent: boolean;

  constructor(opts: { silent?: boolean } = {}) {
    this.silent = opts.silent ?? false;
  }

  log(level: LogLevel, message: string, ctx: Partial<Omit<LogEntry, "id" | "timestamp" | "level" | "message">> = {}): LogEntry {
    const entry: LogEntry = {
      id: randomBytes(4).toString("hex"),
      timestamp: new Date().toISOString(),
      level,
      message,
      source: ctx.source ?? "e2e",
      ...ctx,
    };
    this.entries.push(entry);
    // Only surface warn/error to console automatically (phase banners handle info)
    if (!this.silent) {
      if (level === "error") {
        // errors are surfaced by caller with explicit console output
      } else if (level === "warn") {
        // warnings likewise handled inline
      }
      // debug / info: captured silently so telemetry summary counts them
    }
    return entry;
  }

  debug(msg: string, ctx?: Partial<Omit<LogEntry, "id" | "timestamp" | "level" | "message">>): LogEntry {
    return this.log("debug", msg, ctx);
  }
  info(msg: string, ctx?: Partial<Omit<LogEntry, "id" | "timestamp" | "level" | "message">>): LogEntry {
    return this.log("info", msg, ctx);
  }
  warn(msg: string, ctx?: Partial<Omit<LogEntry, "id" | "timestamp" | "level" | "message">>): LogEntry {
    return this.log("warn", msg, ctx);
  }
  error(msg: string, ctx?: Partial<Omit<LogEntry, "id" | "timestamp" | "level" | "message">>): LogEntry {
    return this.log("error", msg, ctx);
  }

  countByLevel(): Record<LogLevel, number> {
    const r: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const e of this.entries) r[e.level]++;
    return r;
  }

  all(): LogEntry[] { return this.entries; }
}

// ── Console formatting helpers ────────────────────────────────────────────

const BOX_TOP = "╔" + "═".repeat(62) + "╗";
const BOX_BTM = "╚" + "═".repeat(62) + "╝";
const DIV = "═".repeat(65);

function boxLine(text: string, width = 62): string {
  const padded = text + " ".repeat(Math.max(0, width - text.length));
  return `║  ${padded}║`;
}

function phaseBanner(num: number, total: number, title: string): void {
  console.log();
  console.log(`${C.bold}${C.cyan}Phase ${num}/${total}: ${title}${C.reset}`);
}

function arrow(msg: string): void {
  console.log(`  ${C.dim}→${C.reset} ${msg}`);
}

function ok(msg: string, ms?: number): void {
  const dur = ms !== undefined ? ` ${C.dim}(${ms}ms)${C.reset}` : "";
  console.log(`  ${C.green}✓${C.reset} ${msg}${dur}`);
}

function warn(msg: string): void {
  console.log(`  ${C.yellow}⚠${C.reset} ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${C.red}✗${C.reset} ${msg}`);
}

function telTag(msg: string): void {
  console.log(`  ${C.magenta}📊 Telemetry:${C.reset} ${msg}`);
}

function logTag(msg: string): void {
  console.log(`  ${C.blue}📝 Log:${C.reset} ${msg}`);
}

function progress(label: string, current: number, total: number): void {
  const filled = Math.round((current / total) * 20);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  console.log(`  ${C.cyan}${label}:${C.reset} ${bar} ${current}/${total}`);
}

// ── Mock helpers ──────────────────────────────────────────────────────────

function mockEscrowAddress(): string {
  return "0x" + randomBytes(20).toString("hex");
}

function mockTxHash(): string {
  return "0x" + randomBytes(32).toString("hex");
}

async function createMockBundle(
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
// MAIN
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ── Parse --variant flag ─────────────────────────────────────────────────
  const variantArg = process.argv.find((a) => a.startsWith("--variant"));
  const variant: 1 | 2 | 3 = variantArg
    ? (parseInt(variantArg.split("=")[1] ?? variantArg.split(" ")[1] ?? "1", 10) as 1 | 2 | 3)
    : 1;

  // Also support --variant 2 (space-separated)
  const variantIdx = process.argv.indexOf("--variant");
  const variantNum: 1 | 2 | 3 = variantIdx >= 0
    ? (parseInt(process.argv[variantIdx + 1] ?? "1", 10) as 1 | 2 | 3)
    : variant;

  const VARIANT = variantNum;
  const TOTAL_PHASES = 12;

  // ── Telemetry + Logger ───────────────────────────────────────────────────
  const telemetry = new ScriptTelemetry();
  const logger = new ScriptLogger();

  const globalStart = Date.now();

  // ── Header ───────────────────────────────────────────────────────────────
  console.log();
  console.log(`${C.bold}${C.cyan}${BOX_TOP}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${boxLine("PCC E2E: Print & Deliver via OpenClaw")}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${boxLine("Multi-hop workflow with full telemetry")}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${boxLine("")}${C.reset}`);
  if (VARIANT === 1) {
    console.log(`${C.bold}${C.cyan}${boxLine("Variant 1: Standard flow — all phases succeed")}${C.reset}`);
  } else if (VARIANT === 2) {
    console.log(`${C.bold}${C.cyan}${boxLine("Variant 2: Print quality fail → retry → success")}${C.reset}`);
  } else {
    console.log(`${C.bold}${C.cyan}${boxLine("Variant 3: Delivery delayed → reassign → partial settlement")}${C.reset}`);
  }
  console.log(`${C.bold}${C.cyan}${BOX_BTM}${C.reset}`);
  console.log();

  // ── Job / session IDs ────────────────────────────────────────────────────
  const jobId = ids.job();
  const printStepId = "step_print";
  const deliverStepId = "step_deliver";

  logger.debug("E2E session started", { source: "main", metadata: { jobId, variant: VARIANT } });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 1: Capability Discovery
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(1, TOTAL_PHASES, "Capability Discovery");
  const p1Start = Date.now();
  telemetry.emit(jobId, "discovery", "started", { source: "user-agent" });
  logger.info("Discovery started", { source: "user-agent", jobId });

  await sleep(80);

  arrow("Searching network for 'color_laser_print' capability...");
  logger.debug("Discovery query: color_laser_print", { source: "user-agent", jobId });

  const printerKernelId = "kernel_sf_lab";
  const printerCapId = ids.capability();
  const printerName = VARIANT === 2 ? "LabPrinter-001" : "LabPrinter-001";

  arrow(`Found: ${C.green}LabPrinter-001${C.reset} at ${printerKernelId} (Tier 2, $0.15/page)`);
  logger.info("Found printer capability", { source: "discovery", jobId, metadata: { kernelId: printerKernelId, tier: 2 } });

  await sleep(40);

  arrow("Searching network for 'courier_delivery' capability...");
  logger.debug("Discovery query: courier_delivery", { source: "user-agent", jobId });

  const courierKernelId = "kernel_courier_sf";
  const courierCapId = ids.capability();

  arrow(`Found: ${C.green}RideShare-Express${C.reset} at ${courierKernelId} (Tier 1, $8.50 flat)`);
  logger.info("Found courier capability", { source: "discovery", jobId, metadata: { kernelId: courierKernelId, tier: 1 } });

  const p1Ms = Date.now() - p1Start;
  telemetry.emit(jobId, "discovery", "completed", {
    duration_ms: p1Ms,
    metadata: { capabilitiesFound: 2, printerKernelId, courierKernelId },
    source: "user-agent",
  });

  ok(`Discovery complete`, p1Ms);
  telTag(`2 events emitted`);

  // ════════════════════════════════════════════════════════════════════════
  // Phase 2: Quote Request
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(2, TOTAL_PHASES, "Quote Request");
  const p2Start = Date.now();
  telemetry.emit(jobId, "quote_request", "started", { source: "user-agent" });
  logger.info("Quote request started", { source: "user-agent", jobId });

  await sleep(30);
  arrow("User Agent → Broker Agent: RequestQuoteIntent");
  logger.debug("Sending RequestQuoteIntent to broker", { source: "user-agent", jobId });

  await sleep(25);
  arrow("Broker Agent → Kernel Agent (printer): RequestQuoteIntent");
  logger.debug("Broker forwarding to printer kernel", { source: "broker-agent", jobId });

  await sleep(20);
  arrow("Broker Agent → Kernel Agent (courier): RequestQuoteIntent");
  logger.debug("Broker forwarding to courier kernel", { source: "broker-agent", jobId });

  const printPages = 42;
  const printPricePerPage = 0.15;
  const printTotal = parseFloat((printPages * printPricePerPage).toFixed(2));
  const deliverPrice = 8.50;
  const totalPrice = parseFloat((printTotal + deliverPrice).toFixed(2));

  await sleep(14);
  arrow(`Quote: Print ${printPages} pages = $${printTotal.toFixed(2)} | Delivery = $${deliverPrice.toFixed(2)} | Total = $${totalPrice.toFixed(2)}`);
  logger.info("Quote received", { source: "broker-agent", jobId, metadata: { printTotal, deliverPrice, totalPrice } });

  const p2Ms = Date.now() - p2Start;
  telemetry.emit(jobId, "quote_response", "completed", {
    duration_ms: p2Ms,
    metadata: { printTotal, deliverPrice, totalPrice, currency: "USDC" },
    source: "broker-agent",
  });

  ok(`Quotes received`, p2Ms);

  // ════════════════════════════════════════════════════════════════════════
  // Phase 3: Negotiation
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(3, TOTAL_PHASES, "Negotiation");
  const p3Start = Date.now();
  telemetry.emit(jobId, "negotiation", "started", { source: "user-agent" });
  logger.info("Negotiation started", { source: "user-agent", jobId });

  const userBudget = 20.00;
  await sleep(20);
  arrow(`User Agent: max budget $${userBudget.toFixed(2)}`);
  logger.debug(`User budget check: $${totalPrice} vs $${userBudget}`, { source: "user-agent", jobId });

  await sleep(14);

  if (totalPrice <= userBudget) {
    arrow(`Counter-offer accepted: $${totalPrice.toFixed(2)} (within budget)`);
    logger.info("Quote accepted without counter-offer", { source: "user-agent", jobId });
  } else {
    warn(`Total $${totalPrice} exceeds budget $${userBudget} — negotiating...`);
    logger.warn("Budget exceeded, counter-offer needed", { source: "user-agent", jobId });
  }

  const p3Ms = Date.now() - p3Start;
  telemetry.emit(jobId, "negotiation", "completed", {
    duration_ms: p3Ms,
    metadata: { accepted: true, finalPrice: totalPrice },
    source: "user-agent",
  });
  ok(`Negotiation complete`, p3Ms);

  // ════════════════════════════════════════════════════════════════════════
  // Phase 4: Contract Build
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(4, TOTAL_PHASES, "Contract Build");
  const p4Start = Date.now();
  telemetry.emit(jobId, "contract_build", "started", { source: "broker-agent" });
  logger.info("Contract build started", { source: "broker-agent", jobId });

  await sleep(12);

  arrow("Multi-milestone contract:");
  console.log(`    ${C.cyan}Milestone 1:${C.reset} Print Job (${printPages} pages, color, A4, duplex)`);
  console.log(`    ${C.cyan}Milestone 2:${C.reset} Courier Delivery (pickup: SF Lab → delivery: 123 Market St)`);
  logger.debug("Contract milestones defined", { source: "broker-agent", jobId, metadata: { milestones: 2 } });
  arrow("Assurance Tier: 2 (evidence + bonds)");
  logger.debug("Assurance tier set to 2", { source: "broker-agent", jobId });

  const p4Ms = Date.now() - p4Start;
  telemetry.emit(jobId, "contract_build", "completed", {
    duration_ms: p4Ms,
    metadata: { milestones: 2, assuranceTier: 2, totalPrice },
    source: "broker-agent",
  });
  ok(`Contract built`, p4Ms);

  // ════════════════════════════════════════════════════════════════════════
  // Phase 5: Escrow Funding
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(5, TOTAL_PHASES, "Escrow Funding");
  const p5Start = Date.now();
  telemetry.emit(jobId, "escrow_fund", "started", { source: "user-agent" });
  logger.info("Escrow funding started", { source: "user-agent", jobId });

  await sleep(120);

  const escrowAddr = mockEscrowAddress();
  const escrowTx = mockTxHash();

  arrow(`Locking $${totalPrice.toFixed(2)} in milestone escrow`);
  arrow(`Milestone 1 (Print): $${printTotal.toFixed(2)} locked`);
  arrow(`Milestone 2 (Delivery): $${deliverPrice.toFixed(2)} locked`);
  arrow(`Escrow address: ${escrowAddr.slice(0, 10)}...${escrowAddr.slice(-4)} (Base Sepolia)`);
  logger.info("Escrow funded", {
    source: "escrow",
    jobId,
    metadata: { escrowAddr, escrowTx, printTotal, deliverPrice, totalPrice },
  });

  const p5Ms = Date.now() - p5Start;
  telemetry.emit(jobId, "escrow_fund", "completed", {
    duration_ms: p5Ms,
    metadata: { escrowAddr, txHash: escrowTx, totalAmount: totalPrice, chain: "base-sepolia" },
    source: "escrow",
  });
  ok(`Escrow funded`, p5Ms);

  // ════════════════════════════════════════════════════════════════════════
  // Phase 6: Print Execution
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(6, TOTAL_PHASES, "Print Execution");
  const p6Start = Date.now();
  telemetry.emit(jobId, "job_started", "started", {
    metadata: { device: "LabPrinter-001", kernelId: printerKernelId },
    source: "kernel-agent",
  });
  logger.info("Print job started", { source: "kernel-agent", jobId, metadata: { printerKernelId, pages: printPages } });

  arrow("Job submitted to LabPrinter-001");

  let printBundle: EvidenceBundle | null = null;
  let printQualityScore = VARIANT === 2 ? 0.52 : 0.97;
  let printKernelId = printerKernelId;
  let printRetried = false;

  // Simulate printing progress
  for (let p = 0; p <= printPages; p += Math.ceil(printPages / 6)) {
    await sleep(80);
    const shown = Math.min(p, printPages);
    progress("Printing", shown, printPages);
  }
  await sleep(80);
  progress("Printing", printPages, printPages);

  // Variant 2: first attempt fails quality
  if (VARIANT === 2 && printQualityScore < 0.7) {
    fail(`Print quality check: score ${printQualityScore} < 0.70 threshold`);
    logger.warn("Print quality below threshold, initiating retry", {
      source: "kernel-agent",
      jobId,
      metadata: { qualityScore: printQualityScore, threshold: 0.7, printer: "LabPrinter-001" },
    });
    telemetry.emit(jobId, "evidence_capture", "failed", {
      metadata: { qualityScore: printQualityScore, printer: "LabPrinter-001", reason: "quality_below_threshold" },
      source: "kernel-agent",
      level: "warn",
    });

    warn("Quality below threshold (0.52 < 0.70) — fallback to LabPrinter-002");
    await sleep(40);
    arrow("Dispatching print job to LabPrinter-002...");
    logger.info("Retrying on LabPrinter-002", { source: "kernel-agent", jobId });
    telemetry.emit(jobId, "job_submit", "started", {
      metadata: { printer: "LabPrinter-002", retry: true },
      source: "kernel-agent",
    });

    printKernelId = "kernel_sf_lab_b";
    printQualityScore = 0.96;
    printRetried = true;

    for (let p = 0; p <= printPages; p += Math.ceil(printPages / 4)) {
      await sleep(60);
      const shown = Math.min(p, printPages);
      progress("Retry print", shown, printPages);
    }
    await sleep(60);
    progress("Retry print", printPages, printPages);

    logger.info("Retry print succeeded", { source: "kernel-agent", jobId, metadata: { qualityScore: printQualityScore, printer: "LabPrinter-002" } });
    telemetry.emit(jobId, "job_submit", "completed", {
      metadata: { printer: "LabPrinter-002", qualityScore: printQualityScore },
      source: "kernel-agent",
    });
  }

  // Build evidence bundle for the successful print
  const printEmitter = new EvidenceEmitter(printKernelId);
  printBundle = await createMockBundle(
    printEmitter,
    jobId,
    printStepId,
    printKernelId,
    2,
    [
      { type: "gcode_hash_verified", data: { fileHash: `sha256:research_paper_${jobId.slice(0, 8)}`, format: "PDF", pages: printPages, dpi: 1200 } },
      { type: "execution_started", data: { printer: printRetried ? "LabPrinter-002" : "LabPrinter-001", media: "A4-color-duplex", colorMode: "CMYK" } },
      { type: "sensor_data_summary", data: { channel: "temperature_c", readings: 3, avg: 42.1, note: "fuser_unit" } },
      { type: "sensor_data_summary", data: { channel: "humidity_pct", readings: 3, avg: 38.2 } },
      { type: "power_profile_summary", data: { totalWh: 4.7, printTime: `${printPages * 4}s` } },
      { type: "camera_snapshot", data: { photo: `sha256:print_qc_${jobId.slice(0, 8)}`, colorAccuracy: "deltaE < 1.5" } },
      { type: "cv_inspection_result", data: { pass: true, qualityScore: printQualityScore, inkUsageMl: 12.3, tonerLevelPct: 78 } },
      { type: "execution_completed", data: { pages: printPages, copies: 1, quality: printQualityScore >= 0.9 ? "excellent" : "good", duplex: true } },
    ],
  );

  const inkUsage = 12.3;
  const tonerLevel = 78;
  const p6Ms = Date.now() - p6Start;

  console.log(`  ${C.dim}Evidence: ink_usage=${inkUsage}ml, toner_level=${tonerLevel}%, quality_score=${printQualityScore}${C.reset}`);
  arrow("Sensor readings: 3 temperature, 3 humidity captures");
  logger.info("Print evidence captured", {
    source: "kernel-agent",
    jobId,
    metadata: { bundleId: printBundle.id, events: printBundle.events.length, inkUsage, tonerLevel, qualityScore: printQualityScore },
  });
  logger.debug(`Print bundle hash: ${printBundle.bundleHash}`, { source: "kernel-agent", jobId });

  telemetry.emit(jobId, "evidence_capture", "completed", {
    duration_ms: p6Ms,
    metadata: {
      bundleId: printBundle.id,
      events: printBundle.events.length,
      inkUsageMl: inkUsage,
      tonerLevelPct: tonerLevel,
      qualityScore: printQualityScore,
      retried: printRetried,
    },
    source: "kernel-agent",
  });

  if (printRetried) {
    ok(`Print complete (${C.yellow}via LabPrinter-002 after retry${C.reset})`, p6Ms);
    telTag(`${VARIANT === 2 ? "5" : "3"} events emitted (includes retry)`);
  } else {
    ok(`Print complete`, p6Ms);
    telTag("3 events emitted");
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase 7: Evidence Archival
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(7, TOTAL_PHASES, "Evidence Archival");
  const p7Start = Date.now();
  telemetry.emit(jobId, "evidence_encrypt", "started", {
    metadata: { bundleId: printBundle.id },
    source: "evidence-service",
  });
  logger.info("Evidence archival started", { source: "evidence-service", jobId, metadata: { bundleId: printBundle.id } });

  // ── Lit Protocol encryption ──────────────────────────────────────────────
  arrow("Encrypting evidence bundle via Lit Protocol (mock mode)");
  logger.debug("Creating Lit encryption service", { source: "evidence-service", jobId });

  const litSvc = new LitEncryptionService({ mock: true });
  await litSvc.connect();

  logger.debug("Lit service connected", { source: "evidence-service", jobId });
  arrow("Access conditions: buyer OR verifier with rep >= 100");

  const litEncrypted = await litSvc.encryptBundle(
    printBundle,
    escrowAddr as `0x${string}`,
    jobId,
  );

  logger.info("Lit encryption complete", {
    source: "evidence-service",
    jobId,
    metadata: {
      encryptedId: litEncrypted.id,
      ciphertextLen: litEncrypted.ciphertext.length,
      accessConditions: litEncrypted.accessControlConditions?.length ?? 0,
    },
  });

  telemetry.emit(jobId, "evidence_encrypt", "completed", {
    metadata: { encryptedBundleId: litEncrypted.id, ciphertextLen: litEncrypted.ciphertext.length },
    source: "evidence-service",
  });

  // ── Storacha/IPFS archival ───────────────────────────────────────────────
  telemetry.emit(jobId, "evidence_archive", "started", {
    metadata: { backend: "storacha" },
    source: "evidence-service",
  });

  arrow("Archiving to IPFS via Storacha");
  logger.debug("Creating Storacha storage service", { source: "evidence-service", jobId });

  // StorachaStorageService is in the kernel subpath export (compiled in dist)
  const { StorachaStorageService } = await import("../packages/kernel/src/storacha-storage.js");
  const storage = new StorachaStorageService({ mock: true });
  await storage.init();
  logger.debug("Storacha storage initialized", { source: "evidence-service", jobId });

  const archiveResult = await storage.archiveBundle(printBundle);
  logger.info("Bundle archived", {
    source: "evidence-service",
    jobId,
    metadata: { cid: archiveResult.cid, metadataCid: archiveResult.metadataCid },
  });

  const metaResult = await storage.archiveEncryptedBundle(litEncrypted as any);
  logger.info("Encrypted bundle archived", {
    source: "evidence-service",
    jobId,
    metadata: { encryptedCid: metaResult.cid, encMetaCid: metaResult.metadataCid },
  });

  const p7Ms = Date.now() - p7Start;
  telemetry.emit(jobId, "evidence_archive", "completed", {
    duration_ms: p7Ms,
    metadata: {
      cid: archiveResult.cid,
      metadataCid: archiveResult.metadataCid,
      encryptedCid: metaResult.cid,
      backend: "storacha",
    },
    source: "evidence-service",
  });

  arrow(`Evidence CID: ${archiveResult.cid.slice(0, 24)}...`);
  arrow(`Metadata CID: ${archiveResult.metadataCid.slice(0, 24)}...`);
  logger.debug("Evidence archival complete", { source: "evidence-service", jobId });

  await storage.stop();
  ok(`Evidence archived`, p7Ms);

  // ════════════════════════════════════════════════════════════════════════
  // Phase 8: Courier Dispatch
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(8, TOTAL_PHASES, "Courier Dispatch");
  const p8Start = Date.now();
  telemetry.emit(jobId, "delivery_dispatch", "started", {
    metadata: { courierKernelId, pickup: "SF Lab, Building A, Room 201", delivery: "123 Market St, Suite 400" },
    source: "courier-agent",
  });
  logger.info("Courier dispatch started", { source: "courier-agent", jobId, metadata: { courierKernelId } });

  await sleep(50);
  arrow("Dispatching RideShare-Express courier");
  arrow("Pickup: SF Lab, Building A, Room 201");
  arrow("Delivery: 123 Market St, Suite 400");

  const etaMinutes = VARIANT === 3 ? 45 : 25;
  arrow(`ETA: ${etaMinutes} minutes`);

  const driverId = "Agent_Courier_001";
  arrow(`Driver: ${driverId}`);
  logger.debug(`Courier assigned: ${driverId}`, { source: "courier-agent", jobId, metadata: { etaMinutes } });
  logger.info("Courier dispatched successfully", { source: "courier-agent", jobId });

  const p8Ms = Date.now() - p8Start;
  telemetry.emit(jobId, "delivery_dispatch", "completed", {
    duration_ms: p8Ms,
    metadata: { driver: driverId, etaMinutes, courierService: "RideShare-Express" },
    source: "courier-agent",
  });
  ok(`Courier dispatched`, p8Ms);

  // ════════════════════════════════════════════════════════════════════════
  // Phase 9: Delivery Completion
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(9, TOTAL_PHASES, "Delivery Completion");
  const p9Start = Date.now();
  telemetry.emit(jobId, "delivery_pickup", "started", { source: "courier-agent" });
  logger.info("Delivery phase started", { source: "courier-agent", jobId });

  let deliveryMinutes: number;
  let deliverySucceeded = true;
  let deliveryPenalty = 0;
  let deliverBundle: EvidenceBundle | null = null;

  if (VARIANT === 3) {
    // First courier times out
    arrow("GPS tracking: en route → [TIMEOUT — courier unresponsive after 35 minutes]");
    logger.warn("Primary courier timed out, initiating reassignment", { source: "courier-agent", jobId, metadata: { driver: driverId } });
    telemetry.emit(jobId, "delivery_pickup", "failed", {
      metadata: { driver: driverId, reason: "courier_timeout", elapsedMinutes: 35 },
      source: "courier-agent",
      level: "warn",
    });

    fail("Primary courier Agent_Courier_001 timed out (35 min, no pickup)");

    await sleep(30);
    arrow("Dispatching backup courier: Agent_Courier_002");
    logger.info("Backup courier dispatched", { source: "courier-agent", jobId, metadata: { driver: "Agent_Courier_002" } });
    telemetry.emit(jobId, "delivery_dispatch", "started", {
      metadata: { driver: "Agent_Courier_002", retry: true },
      source: "courier-agent",
    });

    await sleep(30);
    arrow("GPS tracking: backup → picked up → en route → delivered");
    logger.debug("Backup courier status: delivered", { source: "courier-agent", jobId });

    deliveryMinutes = 52; // Late
    deliveryPenalty = 0.10;
    const penaltyAmount = parseFloat((deliverPrice * deliveryPenalty).toFixed(2));
    warn(`Delivery late (${deliveryMinutes} min, SLA: ${etaMinutes} min) — 10% penalty applied`);
    logger.warn("Late delivery penalty applied", {
      source: "courier-agent",
      jobId,
      metadata: { deliveryMinutes, slaSec: etaMinutes, penaltyPct: 10, penaltyAmount },
    });
    telemetry.emit(jobId, "delivery_dispatch", "completed", {
      metadata: { driver: "Agent_Courier_002", late: true, penaltyPct: 10 },
      source: "courier-agent",
    });
  } else {
    arrow("GPS tracking: en route → arrived at pickup → en route to delivery → delivered");
    logger.debug("GPS status: delivered", { source: "courier-agent", jobId });
    deliveryMinutes = 22;
  }

  // Build delivery evidence bundle
  const deliverEmitter = new EvidenceEmitter(courierKernelId);
  deliverBundle = await createMockBundle(
    deliverEmitter,
    jobId,
    deliverStepId,
    courierKernelId,
    1,
    [
      { type: "gcode_hash_verified", data: { item: "research-paper-printed", condition: "mint", pages: printPages } },
      { type: "execution_started", data: { origin: "SF Lab, Building A, Room 201", destination: "123 Market St, Suite 400" } },
      { type: "sensor_data_summary", data: { channel: "gps_track", waypoints: 12, distanceMiles: 2.4 } },
      { type: "camera_snapshot", data: { photo: `sha256:pickup_photo_${jobId.slice(0, 8)}`, location: "SF Lab" } },
      { type: "courier_pickup_confirmed", data: { driver: VARIANT === 3 ? "Agent_Courier_002" : driverId, timestamp: new Date().toISOString() } },
      { type: "courier_delivery_confirmed", data: { recipient: "123 Market St, Suite 400", signed: true, photo: `sha256:delivery_photo_${jobId.slice(0, 8)}` } },
      { type: "execution_completed", data: { delivered: true, deliveryMinutes, onTime: deliveryMinutes <= etaMinutes } },
    ],
  );

  logger.info("Delivery evidence captured", {
    source: "courier-agent",
    jobId,
    metadata: { bundleId: deliverBundle.id, events: deliverBundle.events.length, deliveryMinutes },
  });

  const p9Ms = Date.now() - p9Start;
  telemetry.emit(jobId, "delivery_complete", "completed", {
    duration_ms: p9Ms,
    metadata: {
      bundleId: deliverBundle.id,
      deliveryMinutes,
      onTime: deliveryMinutes <= etaMinutes,
      penaltyPct: deliveryPenalty * 100,
      evidence: ["photo_proof", "gps_track", "signature"],
    },
    source: "courier-agent",
  });

  arrow(`Delivery evidence: photo_proof, gps_track, signature`);
  arrow(`Delivery time: ${deliveryMinutes} minutes`);

  if (VARIANT === 3) {
    ok(`Delivery complete (${C.yellow}via backup courier, ${deliveryMinutes} min, 10% late penalty${C.reset})`, p9Ms);
  } else {
    ok(`Delivery complete`, p9Ms);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase 10: Bittensor Verification
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(10, TOTAL_PHASES, "Bittensor Verification");
  const p10Start = Date.now();
  telemetry.emit(jobId, "verification_request", "started", {
    metadata: { bundleHash: printBundle.bundleHash, requiredTier: 2 },
    source: "verifier",
  });
  logger.info("Bittensor verification started", { source: "verifier", jobId, metadata: { bundleHash: printBundle.bundleHash } });

  arrow("Submitting to verification subnet");

  const bridge = new BittensorSubnetBridge();
  const metrics = bridge.getMetrics();
  logger.debug(`Bittensor: ${metrics.activeMinerCount} active miners`, { source: "verifier", jobId });

  const subnetResult = await bridge.submitForVerification(
    printBundle.bundleHash,
    JSON.stringify(printBundle),
    2,
  );

  // Log miner scores
  const leaderboard = bridge.getMinerLeaderboard();
  const shown = leaderboard.slice(0, 3);
  for (let i = 0; i < shown.length; i++) {
    const m = shown[i];
    const quality = m.trust > 0.9 ? "perfect" : "good";
    arrow(`Miner ${i + 1} (quality: ${quality}): score ${m.incentive.toFixed(2)}`);
    logger.debug(`Miner ${m.uid} score: ${m.incentive.toFixed(2)}`, { source: "verifier", jobId, metadata: { uid: m.uid, trust: m.trust } });
  }

  const threshold = 0.7;
  const passed = subnetResult.passed;
  const score = subnetResult.consensusScore;

  arrow(
    `Yuma Consensus: weighted score ${score.toFixed(2)} (${passed ? "PASS" : "FAIL"}, threshold: ${threshold})`,
  );
  logger.info("Bittensor consensus reached", {
    source: "verifier",
    jobId,
    metadata: { consensusScore: score, passed, tierCompliant: subnetResult.tierCompliant, minerCount: subnetResult.minerCount },
  });

  const p10Ms = Date.now() - p10Start;
  telemetry.emit(jobId, "verification_result", "completed", {
    duration_ms: p10Ms,
    metadata: {
      consensusScore: score,
      passed,
      tierCompliant: subnetResult.tierCompliant,
      minerCount: subnetResult.minerCount,
      defects: subnetResult.defects,
      threshold,
    },
    source: "verifier",
  });
  ok(`Verification ${passed ? "passed" : "failed"}`, p10Ms);

  // ════════════════════════════════════════════════════════════════════════
  // Phase 11: Starknet Proof Anchoring
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(11, TOTAL_PHASES, "Starknet Proof Anchoring");
  const p11Start = Date.now();
  logger.info("Starknet proof anchoring started", { source: "proof-service", jobId });

  // Build a Merkle commitment tree from both evidence bundles
  arrow("Generating Merkle commitment (2 evidence bundles)");
  const commitService = new CommitmentService();
  const zkService = new ZKProofService();

  const printCommit = await commitService.createCommitment(printBundle.bundleHash);
  const deliverCommit = await commitService.createCommitment(deliverBundle.bundleHash);
  const tree = await commitService.buildTree([printCommit, deliverCommit]);

  logger.debug(`Merkle tree built: depth=${tree.depth}, leaves=${tree.leafCount}`, { source: "proof-service", jobId });

  // Generate ZK inclusion proof for the print bundle
  const zkProof = await zkService.proveEvidenceInclusion(tree, 0, printBundle.bundleHash);
  const zkValid = await zkService.verifyProof(zkProof);
  logger.debug(`ZK proof generated: ${zkProof.id}, valid=${zkValid}`, { source: "proof-service", jobId });

  arrow(`Merkle root: ${tree.root.slice(0, 24)}...`);

  // Anchor the Merkle root on Starknet
  const starknet = new StarknetProofAnchoringService({ mock: true });
  const anchor = await starknet.anchorMerkleRoot(tree.root, tree.depth);

  // Poll status (mock needs 2 checks to flip to accepted)
  await starknet.getAnchorStatus(anchor.txHash);
  const anchorStatus = await starknet.getAnchorStatus(anchor.txHash);

  logger.info("Starknet anchor submitted", {
    source: "proof-service",
    jobId,
    metadata: { txHash: anchor.txHash, blockNumber: anchor.blockNumber, status: anchorStatus, chain: anchor.chain },
  });

  arrow(`Anchoring to Starknet Sepolia`);
  arrow(`Tx hash: ${anchor.txHash.slice(0, 14)}...`);
  arrow(`Anchor status: ${anchorStatus}`);

  const p11Ms = Date.now() - p11Start;
  telemetry.emit(jobId, "settlement_claim", "completed", {
    duration_ms: p11Ms,
    metadata: {
      starknetTxHash: anchor.txHash,
      blockNumber: anchor.blockNumber,
      anchorStatus,
      merkleRoot: tree.root.slice(0, 20) + "...",
      zkProofId: zkProof.id,
      evidenceBundles: 2,
    },
    source: "proof-service",
  });
  ok(`Proof anchored`, p11Ms);

  // ════════════════════════════════════════════════════════════════════════
  // Phase 12: Settlement & DePIN Rewards
  // ════════════════════════════════════════════════════════════════════════

  phaseBanner(12, TOTAL_PHASES, "Settlement & Rewards");
  const p12Start = Date.now();
  telemetry.emit(jobId, "settlement_complete", "started", {
    metadata: { milestones: 2 },
    source: "settlement",
  });
  logger.info("Settlement started", { source: "settlement", jobId });

  await sleep(80);

  // Compute actual payout for delivery (with penalty if variant 3)
  const actualDeliverPayout = VARIANT === 3
    ? parseFloat((deliverPrice * (1 - deliveryPenalty)).toFixed(2))
    : deliverPrice;
  const actualTotal = parseFloat((printTotal + actualDeliverPayout).toFixed(2));

  arrow(`Milestone 1 (Print): $${printTotal.toFixed(2)} released to ${printerKernelId}`);
  logger.info("Print milestone settled", { source: "settlement", jobId, metadata: { amount: printTotal, kernelId: printerKernelId } });

  if (VARIANT === 3) {
    arrow(`Milestone 2 (Delivery): $${actualDeliverPayout.toFixed(2)} released to ${courierKernelId} (10% late penalty)`);
    logger.warn("Delivery milestone settled with penalty", {
      source: "settlement",
      jobId,
      metadata: { amount: actualDeliverPayout, originalAmount: deliverPrice, penaltyPct: 10, kernelId: courierKernelId },
    });
  } else {
    arrow(`Milestone 2 (Delivery): $${deliverPrice.toFixed(2)} released to ${courierKernelId}`);
    logger.info("Delivery milestone settled", { source: "settlement", jobId, metadata: { amount: deliverPrice, kernelId: courierKernelId } });
  }

  await sleep(50);

  // DePIN rewards
  const rewardEngine = new RewardEngine();
  const epoch = rewardEngine.createEpoch(1, "2026-03-01T00:00:00Z", "2026-03-07T23:59:59Z", "1000.000000");

  const completedEpoch = rewardEngine.completeEpoch(epoch.id, [
    {
      kernelId: printerKernelId,
      kernelDid: `did:pcc:kernel:${printerKernelId}`,
      jobsCompleted: 1,
      qualityScore: printQualityScore,
      uptimePercent: 99.5,
      capabilityDiversity: 1,
      scarcityBonus: 0.85,
    },
    {
      kernelId: courierKernelId,
      kernelDid: `did:pcc:kernel:${courierKernelId}`,
      jobsCompleted: 1,
      qualityScore: VARIANT === 3 ? 0.72 : 0.91,
      uptimePercent: 98.0,
      capabilityDiversity: 1,
      scarcityBonus: 0.70,
    },
  ]);

  const printerScore = completedEpoch.kernelScores[0];
  const courierScore = completedEpoch.kernelScores[1];

  arrow(`DePIN reward: ${printerScore.rewardAmount} PCC tokens to printer operator`);
  arrow(`DePIN reward: ${courierScore.rewardAmount} PCC tokens to courier operator`);

  logger.info("DePIN rewards distributed", {
    source: "depin",
    jobId,
    metadata: {
      printerReward: printerScore.rewardAmount,
      courierReward: courierScore.rewardAmount,
      epochId: epoch.id,
    },
  });

  // Mint soulbound cNFT for print capability
  const certService = new CapabilityCertificateService();
  const cert = await certService.mintCapabilityCertificate({
    kernelDid: `did:pcc:kernel:${printKernelId}`,
    capabilityType: "color_laser_print",
    assuranceTier: 2,
    metadata: {
      pages: printPages,
      inkUsageMl: inkUsage,
      qualityScore: printQualityScore.toString(),
      printCompletedAt: new Date().toISOString(),
    },
  });

  arrow(`Soulbound cNFT minted: ${cert.id.slice(0, 12)}... → ${printKernelId}`);
  logger.info("Soulbound cNFT minted", { source: "depin", jobId, metadata: { certId: cert.id, kernelId: printKernelId } });

  const totalRewards = parseFloat(printerScore.rewardAmount) + parseFloat(courierScore.rewardAmount);

  const p12Ms = Date.now() - p12Start;
  telemetry.emit(jobId, "settlement_complete", "completed", {
    duration_ms: p12Ms,
    metadata: {
      printPayout: printTotal,
      deliverPayout: actualDeliverPayout,
      totalPayout: actualTotal,
      printerReward: printerScore.rewardAmount,
      courierReward: courierScore.rewardAmount,
      totalRewards: totalRewards.toFixed(1),
      certId: cert.id,
      penaltyApplied: VARIANT === 3,
    },
    source: "settlement",
  });

  ok(`Settlement complete`, p12Ms);

  // ════════════════════════════════════════════════════════════════════════
  // PIPELINE TELEMETRY SUMMARY
  // ════════════════════════════════════════════════════════════════════════

  const totalMs = Date.now() - globalStart;
  const allEvents = telemetry.all();
  const byStatus = telemetry.countByStatus();
  const logCounts = logger.countByLevel();
  const logAll = logger.all();

  console.log();
  console.log(`${C.bold}${DIV}${C.reset}`);
  console.log(`${C.bold}PIPELINE TELEMETRY SUMMARY${C.reset}`);
  console.log(`${C.bold}${DIV}${C.reset}`);
  console.log(`Total events:       ${allEvents.length}`);
  console.log(`Total duration:     ${totalMs.toLocaleString()}ms`);
  console.log(`Phases completed:   ${TOTAL_PHASES}/${TOTAL_PHASES}`);
  console.log(`Events by status:`);
  console.log(`  completed:  ${byStatus.completed}`);
  console.log(`  started:    ${byStatus.started}`);
  console.log(`  failed:     ${byStatus.failed}`);
  console.log(`  skipped:    ${byStatus.skipped}`);
  console.log(`Evidence bundles:   2 (print + delivery)`);
  console.log(`Verifications:      1 (Bittensor, ${passed ? "PASSED" : "FAILED"})`);
  console.log(`Proofs anchored:    1 (Starknet Sepolia)`);
  console.log(`Settlement:         $${actualTotal.toFixed(2)} distributed`);
  console.log(`DePIN rewards:      ${totalRewards.toFixed(1)} PCC tokens`);
  if (printRetried) {
    console.log(`${C.yellow}Print retry:        1 (LabPrinter-001 → LabPrinter-002)${C.reset}`);
  }
  if (VARIANT === 3) {
    console.log(`${C.yellow}Courier reassign:   1 (timeout → backup courier)${C.reset}`);
    console.log(`${C.yellow}Late penalty:       10% on delivery milestone${C.reset}`);
  }

  console.log();
  console.log(`${C.bold}${DIV}${C.reset}`);
  console.log(`${C.bold}STRUCTURED LOG SUMMARY${C.reset}`);
  console.log(`${C.bold}${DIV}${C.reset}`);
  console.log(`  DEBUG: ${logCounts.debug.toString().padStart(3)} entries`);
  console.log(`  INFO:  ${logCounts.info.toString().padStart(3)} entries`);
  console.log(`  WARN:  ${logCounts.warn.toString().padStart(3)} entries`);
  console.log(`  ERROR: ${logCounts.error.toString().padStart(3)} entries`);
  console.log(`  TOTAL: ${logAll.length.toString().padStart(3)} entries`);

  // Sample of structured log entries for visibility
  console.log();
  console.log(`${C.dim}Sample log entries (most recent 5):${C.reset}`);
  for (const entry of logAll.slice(-5)) {
    const lvlColor = entry.level === "error" ? C.red
      : entry.level === "warn" ? C.yellow
        : entry.level === "info" ? C.cyan
          : C.dim;
    const lvlStr = entry.level.toUpperCase().padEnd(5);
    const ts = entry.timestamp.slice(11, 23);
    console.log(`  ${C.dim}${ts}${C.reset} ${lvlColor}${lvlStr}${C.reset} [${entry.source}] ${entry.message}`);
  }

  console.log();
  console.log(`${C.bold}${DIV}${C.reset}`);
  console.log(`${C.bold}${C.green}E2E COMPLETE — Variant ${VARIANT} — ${totalMs.toLocaleString()}ms${C.reset}`);
  console.log(`${C.bold}${DIV}${C.reset}`);
  console.log();
}

// ── Entry point ───────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`${C.red}E2E simulation failed:${C.reset}`, err);
  process.exit(1);
});
