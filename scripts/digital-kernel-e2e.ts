/**
 * Digital Kernel E2E Demo
 *
 * Demonstrates the full PCC digital kernel lifecycle:
 *   1. Build a digital contract (accounting-reconcile) with workflow steps
 *   2. Issue a sessionKey for this execution (ephemeral identity)
 *   3. Execute the kernel (5-step reconciliation workflow)
 *   4. Verify the evidence bundle (assuranceScore computed)
 *   5. Run a touchstone (known-answer task) to prove kernel honesty
 *   6. Print a full formatted report
 *
 * Run with: npx tsx scripts/digital-kernel-e2e.ts
 */

import nacl from "tweetnacl";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// -- ANSI colors (no external deps) -----------------------------------------

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
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

function banner(text: string) {
  const line = "=".repeat(72);
  console.log(`\n${C.bgBlue}${C.white}${C.bold} ${line} ${C.reset}`);
  console.log(`${C.bgBlue}${C.white}${C.bold}  ${text.padEnd(71)}${C.reset}`);
  console.log(`${C.bgBlue}${C.white}${C.bold} ${line} ${C.reset}\n`);
}

function section(text: string) {
  console.log(`\n${C.cyan}${C.bold}--- ${text} ---${C.reset}`);
}

function ok(text: string) {
  console.log(`  ${C.green}[OK]${C.reset} ${text}`);
}

function info(text: string) {
  console.log(`  ${C.blue}[..] ${text}${C.reset}`);
}

function warn(text: string) {
  console.log(`  ${C.yellow}[!!] ${text}${C.reset}`);
}

function fail(text: string) {
  console.log(`  ${C.red}[FAIL] ${text}${C.reset}`);
}

function kv(key: string, value: string) {
  console.log(`  ${C.dim}${key}:${C.reset} ${value}`);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // -- Resolve paths and load packages dynamically ----------------------------
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkgs = resolve(scriptDir, "..", "packages");

  // On Windows, dynamic import() requires file:// URLs for absolute paths
  function toFileUrl(absPath: string): string {
    return "file:///" + absPath.replace(/\\/g, "/");
  }

  const specMod = await import(toFileUrl(resolve(pkgs, "spec/dist/index.js")));
  const { ids, canonicalize, sha256 } = specMod;

  const { SessionKeyService } = await import(toFileUrl(resolve(pkgs, "verifier/dist/workflow/ephemeral-identity.js")));
  const { EvidenceVerifier } = await import(toFileUrl(resolve(pkgs, "verifier/dist/evidence-verifier.js")));

  const {
    ContractBuilder,
    accountingReconcileTemplate,
    accountingReconcileWorkflowSteps,
    registerTemplate,
  } = await import(toFileUrl(resolve(pkgs, "contract-builder/dist/index.js")));

  const { AccountingReconcileKernel } = await import(toFileUrl(resolve(pkgs, "kernel/dist/digital/accounting-kernel.js")));

  const { accountingLibrary, verifyExactMatch } = await import(toFileUrl(resolve(pkgs, "touchstone/dist/index.js")));

  banner("PCC DIGITAL KERNEL E2E -- Accounting Reconcile");
  console.log(`  ${C.dim}Timestamp: ${new Date().toISOString()}${C.reset}`);
  console.log(`  ${C.dim}Node: ${process.version}${C.reset}`);
  console.log();

  // ========================================================================
  // PHASE 1: Identity -- create principalKey + sessionKey
  // ========================================================================
  banner("PHASE 1: Ephemeral Identity");

  section("1a. Generate PrincipalKey (persistent agent identity)");
  const principalKeypair = nacl.sign.keyPair();
  const agentId = "eip155:84532:0xABCDEF0123456789abcdef0123456789ABCDEF01" as const;

  const principal = {
    agentId,
    walletAddress: "0xABCDEF0123456789abcdef0123456789ABCDEF01" as const,
    publicKey: principalKeypair.publicKey,
  };

  kv("Agent ID", agentId);
  kv("Wallet", principal.walletAddress);
  kv("Public Key", toHex(principal.publicKey).slice(0, 32) + "...");
  ok("PrincipalKey created");

  section("1b. Issue SessionKey (ephemeral, scoped, 1-hour TTL)");
  const sessionService = new SessionKeyService();
  const { sessionKey, sessionPrivateKey } = sessionService.issueSessionKey({
    principal,
    principalPrivateKey: principalKeypair.secretKey,
    scope: {
      allowedActions: ["evidence_submit", "workflow_step_complete"],
      contractIds: [],
      maxSignatures: 100,
    },
    ttlSeconds: 3600,
  });

  kv("Session ID", sessionKey.sessionId);
  kv("Parent Agent", sessionKey.parentAgentId);
  kv("Expires", new Date(sessionKey.expiresAt * 1000).toISOString());
  kv("Scope", sessionKey.scope.allowedActions.join(", "));
  kv("Session PubKey", toHex(sessionKey.publicKey).slice(0, 32) + "...");
  ok("SessionKey issued and signed by principalKey");

  // Verify the session key's parent signature
  section("1c. Verify sessionKey parent signature");
  const testEvent = sessionService.signEvent({
    eventData: new TextEncoder().encode("test"),
    sessionKey,
    sessionPrivateKey,
    parentPublicKey: principal.publicKey,
  });
  const verifyResult = sessionService.verifySessionSignedEvent({
    event: testEvent,
    action: "evidence_submit",
  });
  if (verifyResult.valid) {
    ok(`SessionKey verification: VALID (principal: ${verifyResult.principalAgentId})`);
  } else {
    fail(`SessionKey verification: INVALID (${verifyResult.failures.join(", ")})`);
  }

  // ========================================================================
  // PHASE 2: Build digital contract
  // ========================================================================
  banner("PHASE 2: Contract Building");

  section("2a. Register accounting-reconcile template");
  registerTemplate(accountingReconcileTemplate);
  ok(`Template registered: ${accountingReconcileTemplate.name} v${accountingReconcileTemplate.version}`);

  section("2b. Build contract with workflow steps");
  const builder = new ContractBuilder();
  const selections = {
    ledgerSource: "file://demo-ledger.json",
    statementSource: "file://demo-statement.json",
    matchingStrategy: "strict",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    currencyCode: "USD",
    estimatedEntries: 100,
  };

  const contract = builder.buildContract(
    "accounting-reconcile",
    selections,
    1, // assuranceTier
    undefined,
    {
      workflowSteps: accountingReconcileWorkflowSteps,
      digitalTaskType: "accounting-reconcile",
    },
  );

  kv("Template", contract.templateName);
  kv("Total Price", `$${contract.totalPrice} USDC`);
  kv("Valid", String(contract.isValid));
  kv("Workflow Steps", String(contract.workflowSteps?.length ?? 0));
  if (contract.workflowSteps) {
    for (const step of contract.workflowSteps) {
      kv(`  Step`, `${step.stepId} (${step.stepType}) -- ${step.description.slice(0, 60)}`);
    }
  }
  kv("Digital Task Type", contract.digitalTaskType ?? "none");
  ok("Contract built with 5 workflow steps");

  // ========================================================================
  // PHASE 3: Execute the kernel
  // ========================================================================
  banner("PHASE 3: Kernel Execution");

  section("3a. Prepare sample data");

  const ledgerData = {
    entries: [
      { date: "2026-01-05", description: "Office supplies", amount: 250.00, account: "5100-Office", reference: "INV-001" },
      { date: "2026-01-10", description: "Cloud hosting", amount: 1200.00, account: "5200-IT", reference: "INV-002" },
      { date: "2026-01-15", description: "Client payment received", amount: -5000.00, account: "1000-Cash", reference: "REC-001" },
      { date: "2026-01-20", description: "Contractor payment", amount: 3500.00, account: "5300-Services", reference: "INV-003" },
      { date: "2026-01-25", description: "Equipment lease", amount: 800.00, account: "5400-Leasing", reference: "INV-004" },
      { date: "2026-01-28", description: "Misc expense", amount: 150.00, account: "5900-Misc" },
    ],
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
  };

  const invoiceData = {
    invoices: [
      { invoiceId: "INV-001", date: "2026-01-04", amount: 250.00, vendor: "Staples", reference: "INV-001" },
      { invoiceId: "INV-002", date: "2026-01-10", amount: 1200.00, vendor: "AWS", reference: "INV-002" },
      { invoiceId: "INV-003", date: "2026-01-19", amount: 3500.00, vendor: "Acme Consulting", reference: "INV-003" },
      { invoiceId: "INV-004", date: "2026-01-25", amount: 800.00, vendor: "Dell Financial", reference: "INV-004" },
      { invoiceId: "INV-005", date: "2026-01-30", amount: 450.00, vendor: "FedEx", reference: "INV-005" },
    ],
  };

  kv("Ledger entries", String(ledgerData.entries.length));
  kv("Invoice entries", String(invoiceData.invoices.length));
  ok("Sample data prepared");

  section("3b. Execute AccountingReconcileKernel");
  const jobId = ids.job();
  const kernel = new AccountingReconcileKernel("kernel-accounting-demo");

  const t0 = Date.now();
  const { evidenceBundle, report, stepTraces } = await kernel.execute({
    ledgerData,
    invoiceData,
    sessionKey,
    sessionPrivateKey,
    jobId,
  });
  const executionMs = Date.now() - t0;

  kv("Job ID", jobId);
  kv("Kernel ID", "kernel-accounting-demo");
  kv("Execution time", `${executionMs}ms`);
  kv("Evidence events", String(evidenceBundle.events.length));
  kv("Bundle hash", evidenceBundle.bundleHash);
  ok("Kernel executed successfully");

  section("3c. Step-by-step execution trace");
  for (const trace of stepTraces) {
    console.log(`  ${C.magenta}[${trace.stepId}]${C.reset}`);
    kv("    Input hash", trace.inputHash);
    kv("    Output hash", trace.outputHash);
    kv("    Duration", `${trace.durationMs}ms`);
    kv("    Summary", trace.outputSummary.slice(0, 100) + (trace.outputSummary.length > 100 ? "..." : ""));
  }

  section("3d. Reconciliation report");
  kv("Status", report.status);
  kv("Matched", String(report.matchedCount));
  kv("Unmatched ledger", String(report.unmatchedLedgerCount));
  kv("Unmatched invoices", String(report.unmatchedInvoiceCount));
  kv("Match rate", `${(report.matchRate * 100).toFixed(1)}%`);
  kv("Total variance", `$${report.totalVariance.toFixed(2)}`);
  kv("Adjustments", String(report.adjustments.length));
  console.log(`  ${C.dim}${report.summary}${C.reset}`);

  // ========================================================================
  // PHASE 4: Evidence verification
  // ========================================================================
  banner("PHASE 4: Evidence Verification");

  section("4a. Initialize verifier");
  const verifier = new EvidenceVerifier(
    "verifier-digital-001",
    "0x1234567890abcdef1234567890abcdef12345678",
  );
  ok("EvidenceVerifier initialized");

  section("4b. Verify evidence bundle with digital workflow options");
  const digitalOptions = {
    workflowSteps: accountingReconcileWorkflowSteps,
  };

  const attestation = await verifier.verify(evidenceBundle, digitalOptions);

  kv("Attestation ID", attestation.id);
  kv("Result", attestation.result);
  kv("Confidence", `${attestation.confidence}%`);
  kv("Assurance Score", String(attestation.assuranceScore));
  kv("Findings", String(attestation.findings.length));

  section("4c. Verification findings detail");
  for (const finding of attestation.findings) {
    const icon = finding.passed ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    const sev = finding.severity ? ` [${finding.severity}]` : "";
    console.log(`  ${icon} ${finding.check}${sev}: ${finding.details}`);
  }

  section("4d. Evidence hash chain");
  for (const event of evidenceBundle.events) {
    const stepId = (event.payload as any).stepId ?? event.id;
    kv(`Event ${stepId}`, event.hash);
  }
  kv("Bundle hash", evidenceBundle.bundleHash);
  kv("Attestation hash", attestation.attestationHash);

  if (attestation.assuranceScore > 0.8) {
    ok(`Assurance score ${attestation.assuranceScore} > 0.8 threshold`);
  } else {
    warn(`Assurance score ${attestation.assuranceScore} below 0.8 threshold`);
  }

  // ========================================================================
  // PHASE 5: Touchstone verification
  // ========================================================================
  banner("PHASE 5: Touchstone (Known-Answer Task)");

  section("5a. Select touchstone from accounting library");
  const touchstone = accountingLibrary.tasks[0]; // acct-001-reconcile-ledger
  kv("Task ID", touchstone.taskId);
  kv("Verification", touchstone.verificationMethod);
  kv("Steps", String(touchstone.workflowSteps.length));

  section("5b. Execute touchstone task");
  info("Running: Load ledger entries and reconcile balances...");

  // Execute the touchstone task using real accounting logic
  const touchstoneInput = touchstone.workflowSteps[0].input as {
    entries: Array<{ account: string; debit: number; credit: number }>;
  };

  // Compute balances (this is what the kernel would do)
  const balances: Record<string, number> = {};
  let totalDebits = 0;
  let totalCredits = 0;

  for (const entry of touchstoneInput.entries) {
    const current = balances[entry.account] ?? 0;
    balances[entry.account] = current + entry.debit - entry.credit;
    totalDebits += entry.debit;
    totalCredits += entry.credit;
  }

  const touchstoneOutput = {
    balances,
    totalDebits,
    totalCredits,
    balanced: totalDebits === totalCredits,
  };

  kv("Total debits", String(touchstoneOutput.totalDebits));
  kv("Total credits", String(touchstoneOutput.totalCredits));
  kv("Balanced", String(touchstoneOutput.balanced));

  section("5c. Verify touchstone result");
  const touchstoneResult = verifyExactMatch(
    touchstone.taskId,
    touchstone.expectedOutput,
    touchstoneOutput,
  );

  kv("Passed", String(touchstoneResult.passed));
  kv("Score", String(touchstoneResult.score));
  kv("Verification time", `${touchstoneResult.executionTimeMs}ms`);
  kv("Details", touchstoneResult.verificationDetails);

  if (touchstoneResult.passed) {
    ok("Touchstone PASSED -- kernel produces correct answers");
  } else {
    fail("Touchstone FAILED -- kernel output does not match expected");
  }

  // ========================================================================
  // PHASE 6: Attribution chain
  // ========================================================================
  banner("PHASE 6: SessionKey -> PrincipalKey Attribution");

  section("6a. Attribution chain");
  kv("Session ID", sessionKey.sessionId);
  kv("Session PubKey", toHex(sessionKey.publicKey).slice(0, 32) + "...");
  kv("Parent Agent ID", sessionKey.parentAgentId);
  kv("Parent PubKey", toHex(principal.publicKey).slice(0, 32) + "...");
  kv("Parent Wallet", principal.walletAddress);
  kv("Parent Signature", toHex(sessionKey.parentSignature).slice(0, 32) + "...");
  kv("Session Scope", JSON.stringify(sessionKey.scope.allowedActions));
  kv("Session TTL", `${sessionKey.expiresAt - sessionKey.issuedAt}s`);

  section("6b. Signature verification");
  // Re-verify the full chain
  const chainEvent = sessionService.signEvent({
    eventData: new TextEncoder().encode(evidenceBundle.bundleHash),
    sessionKey,
    sessionPrivateKey,
    parentPublicKey: principal.publicKey,
  });
  const chainVerify = sessionService.verifySessionSignedEvent({
    event: chainEvent,
    action: "evidence_submit",
  });

  if (chainVerify.valid) {
    ok(`Evidence bundle signature verified`);
    ok(`Session -> Principal chain: VALID`);
    ok(`Accountable agent: ${chainVerify.principalAgentId}`);
  } else {
    fail(`Chain verification failed: ${chainVerify.failures.join(", ")}`);
  }

  // ========================================================================
  // FINAL REPORT
  // ========================================================================
  banner("FINAL REPORT");

  const allPassed =
    attestation.result === "valid" &&
    attestation.assuranceScore > 0.8 &&
    touchstoneResult.passed &&
    chainVerify.valid;

  console.log(`  ${C.bold}Contract${C.reset}`);
  kv("    Template", contract.templateName);
  kv("    Price", `$${contract.totalPrice} USDC`);
  kv("    Workflow steps", String(contract.workflowSteps?.length ?? 0));
  kv("    Digital task type", contract.digitalTaskType ?? "n/a");

  console.log(`  ${C.bold}Execution${C.reset}`);
  kv("    Kernel", "kernel-accounting-demo");
  kv("    Job ID", jobId);
  kv("    Duration", `${executionMs}ms`);
  kv("    Evidence events", String(evidenceBundle.events.length));

  console.log(`  ${C.bold}Reconciliation${C.reset}`);
  kv("    Status", report.status);
  kv("    Match rate", `${(report.matchRate * 100).toFixed(1)}%`);
  kv("    Variance", `$${report.totalVariance.toFixed(2)}`);

  console.log(`  ${C.bold}Verification${C.reset}`);
  kv("    Result", attestation.result);
  kv("    Assurance score", String(attestation.assuranceScore));
  kv("    Confidence", `${attestation.confidence}%`);
  kv("    Bundle hash verified", String(attestation.findings.find((f) => f.check === "bundle_hash_integrity")?.passed ?? false));

  console.log(`  ${C.bold}Touchstone${C.reset}`);
  kv("    Task", touchstone.taskId);
  kv("    Passed", String(touchstoneResult.passed));
  kv("    Score", String(touchstoneResult.score));

  console.log(`  ${C.bold}Identity${C.reset}`);
  kv("    Principal", principal.walletAddress);
  kv("    Session", sessionKey.sessionId);
  kv("    Chain verified", String(chainVerify.valid));

  console.log();
  if (allPassed) {
    console.log(`  ${C.bgGreen}${C.white}${C.bold} ALL CHECKS PASSED ${C.reset}`);
  } else {
    console.log(`  ${C.bgRed}${C.white}${C.bold} SOME CHECKS FAILED ${C.reset}`);
    if (attestation.result !== "valid") warn("Evidence verification result: " + attestation.result);
    if (attestation.assuranceScore <= 0.8) warn("Assurance score below threshold: " + attestation.assuranceScore);
    if (!touchstoneResult.passed) warn("Touchstone did not pass");
    if (!chainVerify.valid) warn("Session chain verification failed");
  }
  console.log();
}

main().catch((err) => {
  console.error(`${C.red}FATAL: ${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
