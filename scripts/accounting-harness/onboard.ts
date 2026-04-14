/**
 * Accounting-Reconcile Onboarding CLI
 *
 * Ralph-loop-friendly CLI that a real customer can run with a single command:
 *
 *   npx tsx scripts/accounting-harness/onboard.ts --dry-run
 *
 * Flow (see C:\Users\globa\physical-capability-cloud\CLAUDE.md for the gateway API):
 *   1. Preflight    -- hit /api/health and sanity-check env.
 *   2. Identity     -- generate Ed25519 principalKey locally (private never leaves).
 *   3. Provision    -- POST /api/auth/provision with email+name (skipped on --dry-run).
 *   4. Import CSV   -- parse ledger via import-csv.ts (auto-detects format).
 *   5. Summary      -- print entries, accounts, date range.
 *   6. Contract     -- build via accounting-reconcile template.
 *   7. Escrow       -- show USDC funding instructions (skipped on --dry-run).
 *   8. Execute      -- run AccountingReconcileKernel.execute() locally.
 *   9. Verify       -- EvidenceVerifier -> assuranceScore.
 *  10. Report       -- entries reconciled, adjustments, bundleHash, escrow tx.
 *
 * In --dry-run mode:
 *   - Uses sample CSV (or --csv override).
 *   - Mocks API responses for provisioning + escrow.
 *   - Freezes time so bundleHash is deterministic.
 *   - Must exit 0 with assuranceScore >= 0.8 in < 30s.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import nacl from "tweetnacl";

import { importCsvFile, type CsvImportResult, type ImportStats } from "./import-csv.js";
import type { LedgerEntry } from "@pcc/kernel/dist/digital/accounting-kernel.js";

// ---------------------------------------------------------------------------
// ANSI colour helpers (no external deps)
// ---------------------------------------------------------------------------
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgBlue: "\x1b[44m",
  white: "\x1b[37m",
};

function banner(text: string) {
  const line = "=".repeat(72);
  console.log(`\n${C.bgBlue}${C.white}${C.bold} ${line} ${C.reset}`);
  console.log(`${C.bgBlue}${C.white}${C.bold}  ${text.padEnd(71)}${C.reset}`);
  console.log(`${C.bgBlue}${C.white}${C.bold} ${line} ${C.reset}\n`);
}
function section(text: string) { console.log(`\n${C.cyan}${C.bold}--- ${text} ---${C.reset}`); }
function ok(text: string) { console.log(`  ${C.green}[OK]${C.reset} ${text}`); }
function info(text: string) { console.log(`  ${C.blue}[..] ${text}${C.reset}`); }
function warn(text: string) { console.log(`  ${C.yellow}[!!] ${text}${C.reset}`); }
function fail(text: string) { console.log(`  ${C.red}[FAIL] ${text}${C.reset}`); }
function kv(key: string, value: string) { console.log(`  ${C.dim}${key}:${C.reset} ${value}`); }

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
interface CliArgs {
  dryRun: boolean;
  csv?: string;
  tier: 0 | 1 | 2 | 3;
  email?: string;
  name?: string;
  gatewayUrl: string;
  skipPreflight: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    tier: 1,
    gatewayUrl: process.env.PCC_URL ?? process.env.PCC_BASE ?? "https://capability.network",
    skipPreflight: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
      case "-d":
        args.dryRun = true;
        args.skipPreflight = true;
        break;
      case "--csv":
        args.csv = argv[++i];
        break;
      case "--tier":
        args.tier = Math.max(0, Math.min(3, Number(argv[++i]) || 1)) as 0 | 1 | 2 | 3;
        break;
      case "--email":
        args.email = argv[++i];
        break;
      case "--name":
        args.name = argv[++i];
        break;
      case "--gateway":
        args.gatewayUrl = argv[++i]!;
        break;
      case "--skip-preflight":
        args.skipPreflight = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
${C.bold}PCC Accounting Reconcile -- Onboarding CLI${C.reset}

Usage:
  npx tsx scripts/accounting-harness/onboard.ts [options]

Options:
  --dry-run, -d        Use sample CSV, mock API + escrow, deterministic output.
  --csv <path>         Path to your ledger CSV (otherwise prompts).
  --tier <0-3>         Assurance tier (default: 1).
  --email <addr>       Email for API key provisioning.
  --name <name>        Shop name for API key provisioning.
  --gateway <url>      Override gateway URL (default: $PCC_URL or capability.network).
  --skip-preflight     Skip the /api/health ping.
  --help, -h           Show this help.

Examples:
  # Offline dry-run against the Quickbooks sample:
  npx tsx scripts/accounting-harness/onboard.ts --dry-run \\
    --csv scripts/accounting-harness/samples/quickbooks-sample.csv

  # Real onboarding (writes an evidence bundle on-chain):
  npx tsx scripts/accounting-harness/onboard.ts --csv ./my-books.csv \\
    --email ops@myco.com --name "My Co" --tier 1
`);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (ans) => {
      rl.close();
      res(ans.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Time freezing for deterministic dry-run bundleHash
// ---------------------------------------------------------------------------
const DRY_RUN_FROZEN_ISO = "2026-04-14T00:00:00.000Z";
const DRY_RUN_FROZEN_MS = new Date(DRY_RUN_FROZEN_ISO).getTime();

function freezeTime(): () => void {
  const OriginalDate = Date;
  let counter = 0;
  class FrozenDate extends OriginalDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) {
        // Each construction advances by 1ms so event timestamps are distinct
        // but still deterministic across runs.
        super(DRY_RUN_FROZEN_MS + counter++);
      } else {
        // @ts-expect-error spread into Date ctor is type-widened
        super(...args);
      }
    }
    static now(): number {
      return DRY_RUN_FROZEN_MS + counter++;
    }
  }
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  return () => {
    globalThis.Date = OriginalDate;
  };
}

// Deterministic ID generator replaces ids.* for dry-run so bundleHash is stable.
// The kernel pulls IDs from @pcc/spec; we monkey-patch the module after import.
function freezeIds(idsObj: Record<string, () => string>) {
  const counters: Record<string, number> = {};
  for (const key of Object.keys(idsObj)) {
    const prefix = key;
    counters[key] = 0;
    idsObj[key] = () => {
      const n = ++counters[key]!;
      return `${prefix}_dry${n.toString().padStart(4, "0")}`;
    };
  }
}

// ---------------------------------------------------------------------------
// Dynamic imports (same pattern as digital-kernel-e2e.ts for Windows)
// ---------------------------------------------------------------------------
async function loadPackages(scriptDir: string) {
  const pkgs = resolve(scriptDir, "..", "..", "packages");
  const toFileUrl = (absPath: string): string =>
    "file:///" + absPath.replace(/\\/g, "/");

  const specMod = await import(toFileUrl(resolve(pkgs, "spec/dist/index.js")));
  const sessionMod = await import(
    toFileUrl(resolve(pkgs, "verifier/dist/workflow/ephemeral-identity.js"))
  );
  const verifierMod = await import(
    toFileUrl(resolve(pkgs, "verifier/dist/evidence-verifier.js"))
  );
  const builderMod = await import(
    toFileUrl(resolve(pkgs, "contract-builder/dist/index.js"))
  );
  const kernelMod = await import(
    toFileUrl(resolve(pkgs, "kernel/dist/digital/accounting-kernel.js"))
  );

  return { specMod, sessionMod, verifierMod, builderMod, kernelMod };
}

// ---------------------------------------------------------------------------
// Onboarding flow
// ---------------------------------------------------------------------------
async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const args = parseArgs(process.argv);

  banner("PCC ACCOUNTING-RECONCILE -- ONBOARDING");
  kv("Mode", args.dryRun ? "DRY-RUN" : "LIVE");
  kv("Tier", String(args.tier));
  kv("Gateway", args.gatewayUrl);
  kv("Timestamp", args.dryRun ? DRY_RUN_FROZEN_ISO : new Date().toISOString());

  // Freeze time FIRST in dry-run so all downstream Date.now() calls are stable.
  let restoreTime: (() => void) | undefined;
  if (args.dryRun) {
    restoreTime = freezeTime();
  }

  // Load packages after freezing time.
  const { specMod, sessionMod, verifierMod, builderMod, kernelMod } = await loadPackages(scriptDir);

  if (args.dryRun) {
    freezeIds(specMod.ids as Record<string, () => string>);
  }

  try {
    // =====================================================================
    // STEP 1: Preflight
    // =====================================================================
    if (!args.skipPreflight) {
      section("1. Preflight");
      try {
        const res = await fetch(`${args.gatewayUrl}/api/health`, { method: "GET" }).catch(() =>
          fetch(`${args.gatewayUrl}/health`, { method: "GET" }),
        );
        if (res && res.ok) {
          ok(`Gateway healthy: ${args.gatewayUrl}`);
        } else {
          warn(`Gateway returned ${res?.status ?? "no response"}. Continuing -- non-fatal.`);
        }
      } catch (err) {
        warn(`Gateway unreachable (${(err as Error).message}). Continuing -- non-fatal.`);
      }
    } else {
      section("1. Preflight (skipped)");
      info("Skipping /api/health in dry-run mode.");
    }

    // =====================================================================
    // STEP 2: Identity -- generate principalKey LOCALLY
    // =====================================================================
    section("2. Identity");
    let principalKeypair: nacl.SignKeyPair;
    let walletAddress: `0x${string}`;

    if (args.dryRun) {
      // Seeded keypair so publicKey + signatures are identical across runs.
      const seed = new Uint8Array(32);
      for (let i = 0; i < 32; i++) seed[i] = i + 1;
      principalKeypair = nacl.sign.keyPair.fromSeed(seed);
    } else {
      principalKeypair = nacl.sign.keyPair();
    }
    walletAddress = `0x${toHex(principalKeypair.publicKey).slice(0, 40)}` as `0x${string}`;
    const agentId = `eip155:84532:${walletAddress}` as const;

    kv("Agent ID", agentId);
    kv("Wallet", walletAddress);
    kv("Public Key", toHex(principalKeypair.publicKey).slice(0, 32) + "...");
    ok("PrincipalKey generated locally (private key never leaves this machine)");

    // =====================================================================
    // STEP 3: Provision API key
    // =====================================================================
    section("3. Provision API key");
    let apiKey = "";
    if (args.dryRun) {
      apiKey = "pcc_dry_RUN_MOCK_1234567890abcdef";
      ok("Mock API key generated (dry-run)");
    } else {
      const email = args.email ?? (await prompt("Email: "));
      const name = args.name ?? (await prompt("Shop name: "));
      if (!email) {
        fail("Email is required for provisioning");
        process.exit(2);
      }
      try {
        const res = await fetch(`${args.gatewayUrl}/api/auth/provision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            name: name || "Accounting Harness",
            capability: "accounting-reconcile",
          }),
        });
        if (!res.ok) {
          fail(`Provisioning failed: ${res.status} ${await res.text()}`);
          process.exit(2);
        }
        const body = (await res.json()) as { api_key: string };
        apiKey = body.api_key;
        ok(`API key provisioned: ${apiKey.slice(0, 16)}...`);
        warn("Save this key -- it will not be shown again.");
      } catch (err) {
        fail(`Provisioning error: ${(err as Error).message}`);
        process.exit(2);
      }
    }
    kv("API key", apiKey.slice(0, 16) + "...");

    // =====================================================================
    // STEP 4: Import CSV
    // =====================================================================
    section("4. Import CSV");
    let csvPath = args.csv;
    if (!csvPath && args.dryRun) {
      csvPath = resolve(scriptDir, "samples", "quickbooks-sample.csv");
      info(`Dry-run default: ${csvPath}`);
    }
    if (!csvPath) {
      csvPath = await prompt("Path to ledger CSV: ");
    }
    if (!csvPath || !existsSync(csvPath)) {
      fail(`CSV not found: ${csvPath}`);
      process.exit(2);
    }
    const imported: CsvImportResult = importCsvFile(csvPath);
    const entries: LedgerEntry[] = imported.entries;
    const stats: ImportStats = imported.stats;

    ok(`Imported ${stats.rows} entries (${imported.format} format)`);
    kv("Accounts", String(stats.accounts));
    kv("Date range", `${stats.dateRange.start ?? "?"} -> ${stats.dateRange.end ?? "?"}`);
    kv("Total debits", `$${stats.totalDebits.toFixed(2)}`);
    kv("Total credits", `$${stats.totalCredits.toFixed(2)}`);

    // =====================================================================
    // STEP 5: Summary
    // =====================================================================
    section("5. Ledger summary");
    const accountTotals: Record<string, number> = {};
    for (const e of entries) {
      accountTotals[e.account] = (accountTotals[e.account] ?? 0) + e.amount;
    }
    for (const [acct, total] of Object.entries(accountTotals).sort()) {
      kv(acct, `$${total.toFixed(2)}`);
    }

    // =====================================================================
    // STEP 6: Build contract
    // =====================================================================
    section("6. Contract");
    builderMod.registerTemplate(builderMod.accountingReconcileTemplate);
    const builder = new builderMod.ContractBuilder();
    const selections = {
      ledgerSource: `file://${csvPath.replace(/\\/g, "/")}`,
      statementSource: "file://none",
      matchingStrategy: "strict",
      periodStart: stats.dateRange.start ?? "2026-01-01",
      periodEnd: stats.dateRange.end ?? "2026-01-31",
      currencyCode: "USD",
      estimatedEntries: stats.rows,
    };
    const contract = builder.buildContract(
      "accounting-reconcile",
      selections,
      args.tier,
      undefined,
      {
        workflowSteps: builderMod.accountingReconcileWorkflowSteps,
        digitalTaskType: "accounting-reconcile",
      },
    );
    kv("Template", contract.templateName);
    kv("Price", `$${contract.totalPrice} USDC`);
    kv("Workflow steps", String(contract.workflowSteps?.length ?? 0));
    ok("Contract built");

    // =====================================================================
    // STEP 7: Escrow funding
    // =====================================================================
    section("7. Escrow funding");
    if (args.dryRun) {
      kv("Escrow address", "0xDRYRUN00000000000000000000000000000DEAD");
      kv("Amount", `$${contract.totalPrice} USDC`);
      ok("Mock escrow (dry-run)");
    } else {
      const escrowContract = process.env.ESCROW_CONTRACT_ADDRESS ?? "(not set)";
      kv("Network", "Base Sepolia");
      kv("Escrow contract", escrowContract);
      kv("Amount to fund", `$${contract.totalPrice} USDC`);
      info("Fund the escrow before execution to enable automatic settlement:");
      info(`  curl -X POST ${args.gatewayUrl}/api/escrow/fund \\`);
      info(`    -H "Authorization: Bearer ${apiKey.slice(0, 12)}..." \\`);
      info(`    -d '{"capabilityType":"accounting-reconcile","amount":"${contract.totalPrice}"}'`);
      warn("Escrow funding is user-controlled. Continuing without waiting for on-chain confirmation.");
    }

    // =====================================================================
    // STEP 8: Issue sessionKey + execute kernel
    // =====================================================================
    section("8. Execute AccountingReconcileKernel");
    const sessionService = new sessionMod.SessionKeyService();
    const { sessionKey, sessionPrivateKey } = sessionService.issueSessionKey({
      principal: {
        agentId,
        walletAddress,
        publicKey: principalKeypair.publicKey,
      },
      principalPrivateKey: principalKeypair.secretKey,
      scope: {
        allowedActions: ["evidence_submit", "workflow_step_complete"],
        contractIds: [],
        maxSignatures: 100,
      },
      ttlSeconds: 3600,
    });
    kv("Session ID", sessionKey.sessionId);

    const kernel = new kernelMod.AccountingReconcileKernel(
      args.dryRun ? "kernel_dry_ACCT_0001" : undefined,
    );
    const jobId = args.dryRun ? "job_dry_ACCT_0001" : specMod.ids.job();
    const t0 = Date.now();
    const { evidenceBundle, report, stepTraces } = await kernel.execute({
      ledgerData: {
        entries,
        periodStart: stats.dateRange.start,
        periodEnd: stats.dateRange.end,
      },
      invoiceData: { invoices: [] },
      sessionKey,
      sessionPrivateKey,
      jobId,
    });
    const executionMs = Date.now() - t0;
    kv("Job ID", jobId);
    kv("Events", String(evidenceBundle.events.length));
    kv("Bundle hash", evidenceBundle.bundleHash);
    kv("Duration", `${executionMs}ms`);
    ok("Kernel execution complete");

    section("8b. Step traces");
    for (const trace of stepTraces) {
      console.log(`  ${C.magenta}[${trace.stepId}]${C.reset} ${trace.durationMs}ms`);
      kv("    output", trace.outputSummary.slice(0, 100));
    }

    // =====================================================================
    // STEP 9: Verify bundle
    // =====================================================================
    section("9. Evidence verification");
    const verifier = new verifierMod.EvidenceVerifier(
      "verifier-harness-001",
      "0x0000000000000000000000000000000000000001",
    );
    const attestation = await verifier.verify(evidenceBundle, {
      workflowSteps: builderMod.accountingReconcileWorkflowSteps,
    });
    kv("Attestation ID", attestation.id);
    kv("Result", attestation.result);
    kv("Confidence", `${attestation.confidence}%`);
    kv("Assurance score", String(attestation.assuranceScore));
    for (const f of attestation.findings) {
      const icon = f.passed ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
      console.log(`  ${icon} ${f.check}: ${f.details}`);
    }

    // =====================================================================
    // STEP 10: Final report
    // =====================================================================
    banner("RECONCILIATION REPORT");
    kv("Status", report.status);
    kv("Entries reconciled", String(report.matchedCount));
    kv("Unmatched (ledger)", String(report.unmatchedLedgerCount));
    kv("Unmatched (invoices)", String(report.unmatchedInvoiceCount));
    kv("Match rate", `${(report.matchRate * 100).toFixed(1)}%`);
    kv("Adjustments found", String(report.adjustments.length));
    kv("Total variance", `$${report.totalVariance.toFixed(2)}`);
    kv("Bundle ID", evidenceBundle.id);
    kv("Bundle hash", evidenceBundle.bundleHash);
    kv("Assurance score", String(attestation.assuranceScore));
    if (!args.dryRun) {
      kv("Escrow tx", "(pending funding confirmation)");
    }
    console.log();
    console.log(`  ${C.dim}${report.summary}${C.reset}`);
    console.log();

    // JSON report for smoke.sh to grep.
    const jsonReport = {
      mode: args.dryRun ? "dry-run" : "live",
      jobId,
      bundleId: evidenceBundle.id,
      bundleHash: evidenceBundle.bundleHash,
      assuranceScore: attestation.assuranceScore,
      verificationResult: attestation.result,
      entriesImported: stats.rows,
      accountsCount: stats.accounts,
      adjustmentsFound: report.adjustments.length,
      matchRate: report.matchRate,
      totalVariance: report.totalVariance,
      reportStatus: report.status,
    };
    console.log(`REPORT_JSON:${JSON.stringify(jsonReport)}`);

    const passThreshold = 0.8;
    if (attestation.assuranceScore >= passThreshold && attestation.result === "valid") {
      console.log(`  ${C.bgGreen}${C.white}${C.bold} ONBOARDING OK (assuranceScore=${attestation.assuranceScore}) ${C.reset}`);
      process.exitCode = 0;
    } else {
      console.log(
        `  ${C.bgRed}${C.white}${C.bold} ASSURANCE BELOW THRESHOLD (got ${attestation.assuranceScore}, need >=${passThreshold}) ${C.reset}`,
      );
      process.exitCode = 3;
    }
  } finally {
    if (restoreTime) restoreTime();
  }
}

main().catch((err) => {
  console.error(`${C.red}FATAL: ${(err as Error).message}${C.reset}`);
  if (process.env.DEBUG) console.error((err as Error).stack);
  process.exit(1);
});
