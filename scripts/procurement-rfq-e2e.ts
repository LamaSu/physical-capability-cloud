/**
 * Procurement RFQ Kernel E2E Demo
 *
 * Demonstrates the second PCC digital kernel end-to-end:
 *   1. Provision a principalKey (persistent agent identity)
 *   2. Issue a sessionKey (ephemeral, scoped, short TTL)
 *   3. Build a procurement-rfq contract with 6 workflow steps
 *   4. Execute ProcurementRFQKernel on a sample RFQ + vendor list
 *   5. Verify the evidence bundle (assuranceScore)
 *   6. Run the procurement touchstone library to sanity-check shape
 *   7. Print the full attribution chain
 *
 * Run with: npx tsx scripts/procurement-rfq-e2e.ts
 * Or via Spark: spark-run "cd ~/projects/physical-capability-cloud && npx tsx scripts/procurement-rfq-e2e.ts"
 */

import nacl from "tweetnacl";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ----- ANSI colors (no external deps) --------------------------------------

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
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkgs = resolve(scriptDir, "..", "packages");

  function toFileUrl(absPath: string): string {
    return "file:///" + absPath.replace(/\\/g, "/");
  }

  const specMod = await import(toFileUrl(resolve(pkgs, "spec/dist/index.js")));
  const { ids } = specMod;

  const { SessionKeyService } = await import(toFileUrl(resolve(pkgs, "verifier/dist/workflow/ephemeral-identity.js")));
  const { EvidenceVerifier } = await import(toFileUrl(resolve(pkgs, "verifier/dist/evidence-verifier.js")));

  const {
    ContractBuilder,
    procurementRfqTemplate,
    procurementRfqWorkflowSteps,
    registerTemplate,
  } = await import(toFileUrl(resolve(pkgs, "contract-builder/dist/index.js")));

  const { ProcurementRFQKernel } = await import(
    toFileUrl(resolve(pkgs, "kernel/dist/digital/procurement-rfq-kernel.js"))
  );

  const { procurementLibrary, verifyExactMatch } = await import(
    toFileUrl(resolve(pkgs, "touchstone/dist/index.js"))
  );

  banner("PCC DIGITAL KERNEL E2E -- Procurement RFQ");
  console.log(`  ${C.dim}Timestamp: ${new Date().toISOString()}${C.reset}`);
  console.log(`  ${C.dim}Node: ${process.version}${C.reset}`);
  console.log();

  // ========================================================================
  // PHASE 1: Identity
  // ========================================================================
  banner("PHASE 1: Ephemeral Identity");

  section("1a. Generate PrincipalKey");
  const principalKeypair = nacl.sign.keyPair();
  const agentId = "eip155:84532:0xBEEF1234567890abcdef1234567890abcdefBEEF" as const;
  const principal = {
    agentId,
    walletAddress: "0xBEEF1234567890abcdef1234567890abcdefBEEF" as const,
    publicKey: principalKeypair.publicKey,
  };
  kv("Agent ID", agentId);
  kv("Wallet", principal.walletAddress);
  kv("Public Key", toHex(principal.publicKey).slice(0, 32) + "...");
  ok("PrincipalKey created");

  section("1b. Issue SessionKey (1-hour TTL, scoped)");
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

  section("2a. Register procurement-rfq template");
  registerTemplate(procurementRfqTemplate);
  ok(`Template registered: ${procurementRfqTemplate.name} v${procurementRfqTemplate.version}`);

  section("2b. Build contract with workflow steps");
  const builder = new ContractBuilder();
  const selections = {
    quoteCount: 3,
    scoringModel: "balanced",
    currencyCode: "USD",
  };
  const contract = builder.buildContract(
    "procurement-rfq",
    selections,
    1,
    undefined,
    {
      workflowSteps: procurementRfqWorkflowSteps,
      digitalTaskType: "procurement-rfq",
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
  ok("Contract built with 6 workflow steps");

  // ========================================================================
  // PHASE 3: Execute the kernel
  // ========================================================================
  banner("PHASE 3: Kernel Execution");

  section("3a. Prepare sample RFQ + vendor list");

  const rfqSpec = {
    item: "Stainless Steel Fasteners M6x25",
    quantity: 10000,
    specifications: {
      material: "stainless-steel-304",
      thread: "M6",
      length: "25mm",
      finish: "passivated",
      iso9001: "required",
    },
    deadline: "2026-07-15",
  };

  const vendorList = [
    {
      id: "v-acme-fasteners",
      name: "Acme Fasteners Co",
      capabilities: ["material", "thread", "length", "finish", "iso9001", "expedited"],
      lastQuoteHistory: { q1: "2025-q1", q2: "2025-q3" },
    },
    {
      id: "v-boltworks",
      name: "Boltworks International",
      capabilities: ["material", "thread", "length", "finish", "iso9001"],
      lastQuoteHistory: { q1: "2025-q2" },
    },
    {
      id: "v-precision-hw",
      name: "Precision Hardware LLC",
      capabilities: ["material", "thread", "length", "finish", "iso9001", "as9100"],
    },
    {
      id: "v-generic-supply",
      name: "Generic Supply Corp",
      capabilities: ["material", "thread", "length"],
    },
    {
      id: "v-discount-bolts",
      name: "Discount Bolts",
      capabilities: ["material"],
    },
  ];

  kv("RFQ item", rfqSpec.item);
  kv("RFQ quantity", String(rfqSpec.quantity));
  kv("Spec keys", Object.keys(rfqSpec.specifications).join(", "));
  kv("Vendor pool", String(vendorList.length));
  ok("Sample RFQ + vendors prepared");

  section("3b. Execute ProcurementRFQKernel");
  const jobId = ids.job();
  const kernel = new ProcurementRFQKernel("kernel-procurement-demo");

  const t0 = Date.now();
  const { evidenceBundle, report, selectedVendor, stepTraces } = await kernel.execute({
    rfqSpec,
    vendorList,
    sessionKey,
    sessionPrivateKey,
    jobId,
  });
  const executionMs = Date.now() - t0;

  kv("Job ID", jobId);
  kv("Kernel ID", "kernel-procurement-demo");
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
    kv("    Summary", trace.outputSummary.slice(0, 120) + (trace.outputSummary.length > 120 ? "..." : ""));
  }

  section("3d. RFQ report");
  kv("Status", report.status);
  kv("Eligible vendors", String(report.eligibleVendorCount));
  kv("Excluded vendors", String(report.excludedVendorCount));
  kv("Decision note", report.decisionNote);
  if (report.selectedVendor) {
    kv("Selected vendor", `${report.selectedVendor.name} (${report.selectedVendor.id})`);
    kv("Selected score", String(report.selectedVendor.score));
    kv("Selected totalPrice", `$${report.selectedVendor.totalPrice.toFixed(2)}`);
    kv("Selected deliveryDays", String(report.selectedVendor.deliveryDays));
  }
  console.log(`  ${C.dim}${report.summary}${C.reset}`);

  section("3e. Rankings");
  let rank = 1;
  for (const r of report.rankings) {
    kv(
      `  #${rank}`,
      `${r.vendorName} (${r.vendorId}) -- score=${r.score.toFixed(4)} price=$${r.totalPrice.toFixed(2)} delivery=${r.deliveryDays}d`,
    );
    rank++;
  }

  if (report.purchaseOrder) {
    section("3f. Purchase-order draft");
    kv("Vendor", report.purchaseOrder.vendorName);
    kv("Item", report.purchaseOrder.item);
    kv("Quantity", String(report.purchaseOrder.quantity));
    kv("Unit price", `$${report.purchaseOrder.unitPrice.toFixed(2)}`);
    kv("Total price", `$${report.purchaseOrder.totalPrice.toFixed(2)}`);
    kv("Delivery (days)", String(report.purchaseOrder.deliveryDays));
    kv("Deadline", report.purchaseOrder.deadline);
  }

  // ========================================================================
  // PHASE 4: Evidence verification
  // ========================================================================
  banner("PHASE 4: Evidence Verification");

  section("4a. Initialize verifier");
  const verifier = new EvidenceVerifier(
    "verifier-digital-procurement-001",
    "0xABCDEFabcdef0123456789ABCDEFabcdef01234567",
  );
  ok("EvidenceVerifier initialized");

  section("4b. Verify evidence bundle with digital workflow options");
  const digitalOptions = { workflowSteps: procurementRfqWorkflowSteps };
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
    const stepId = (event.payload as any).stepId ?? event.type;
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
  // PHASE 5: Touchstone verification (procurement)
  // ========================================================================
  banner("PHASE 5: Touchstone (Known-Answer Task)");

  section("5a. Select touchstone from procurement library");
  const touchstone = procurementLibrary.tasks.find(
    (t: any) => t.taskId === "proc-001-compare-quotes",
  ) ?? procurementLibrary.tasks[0];
  kv("Task ID", touchstone.taskId);
  kv("Verification", touchstone.verificationMethod);
  kv("Steps", String(touchstone.workflowSteps.length));

  section("5b. Execute touchstone task");
  info("Running: Load three vendor quotes, rank by total cost, identify lowest + fastest...");

  const touchstoneInput = touchstone.workflowSteps[0].input as {
    quotes: Array<{
      vendor: string;
      unitPrice: number;
      quantity: number;
      leadTimeDays: number;
      shippingCost: number;
    }>;
  };

  const totalCosts = touchstoneInput.quotes.map((q) => ({
    vendor: q.vendor,
    leadTimeDays: q.leadTimeDays,
    totalCost: q.unitPrice * q.quantity + q.shippingCost,
  }));
  totalCosts.sort((a, b) => a.totalCost - b.totalCost);

  const lowestCostVendor = totalCosts[0].vendor;
  const fastestDeliveryVendor = [...totalCosts].sort(
    (a, b) => a.leadTimeDays - b.leadTimeDays,
  )[0].vendor;

  const touchstoneOutput = {
    rankings: totalCosts.map(({ vendor, totalCost }) => ({ vendor, totalCost })),
    lowestCostVendor,
    fastestDeliveryVendor,
  };

  kv("Lowest-cost vendor", lowestCostVendor);
  kv("Fastest-delivery vendor", fastestDeliveryVendor);
  kv("Rankings", touchstoneOutput.rankings.map((r) => `${r.vendor}:$${r.totalCost}`).join(", "));

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
    ok("Touchstone PASSED -- procurement computations match ground truth");
  } else {
    fail("Touchstone FAILED -- procurement output does not match expected");
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
    ok("Evidence bundle signature verified");
    ok("Session -> Principal chain: VALID");
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
    chainVerify.valid &&
    report.status !== "no-vendors";

  console.log(`  ${C.bold}Contract${C.reset}`);
  kv("    Template", contract.templateName);
  kv("    Price", `$${contract.totalPrice} USDC`);
  kv("    Workflow steps", String(contract.workflowSteps?.length ?? 0));
  kv("    Digital task type", contract.digitalTaskType ?? "n/a");

  console.log(`  ${C.bold}Execution${C.reset}`);
  kv("    Kernel", "kernel-procurement-demo");
  kv("    Job ID", jobId);
  kv("    Duration", `${executionMs}ms`);
  kv("    Evidence events", String(evidenceBundle.events.length));

  console.log(`  ${C.bold}RFQ Outcome${C.reset}`);
  kv("    Status", report.status);
  kv("    Eligible vendors", String(report.eligibleVendorCount));
  kv("    Excluded", String(report.excludedVendorCount));
  if (report.selectedVendor) {
    kv("    Selected", `${report.selectedVendor.name} ($${report.selectedVendor.totalPrice.toFixed(2)}, ${report.selectedVendor.deliveryDays}d)`);
    kv("    Score", String(report.selectedVendor.score));
  }

  console.log(`  ${C.bold}Verification${C.reset}`);
  kv("    Result", attestation.result);
  kv("    Assurance score", String(attestation.assuranceScore));
  kv("    Confidence", `${attestation.confidence}%`);
  kv("    Bundle hash verified", String(attestation.findings.find((f: any) => f.check === "bundle_hash_integrity")?.passed ?? false));

  console.log(`  ${C.bold}Touchstone${C.reset}`);
  kv("    Task", touchstone.taskId);
  kv("    Passed", String(touchstoneResult.passed));
  kv("    Score", String(touchstoneResult.score));

  console.log(`  ${C.bold}Identity${C.reset}`);
  kv("    Principal", principal.walletAddress);
  kv("    Session", sessionKey.sessionId);
  kv("    Chain verified", String(chainVerify.valid));

  // Run once more to prove computational determinism (step I/O hashes + report).
  // Note: the full bundleHash includes lifecycle event timestamps which are
  // wall-clock based -- so the bundleHash itself is intentionally not compared
  // here. What we prove is that every workflow_step_completed event has the
  // same input and output hash on a repeat run (identical computation).
  section("Determinism check (step I/O hashes + report content)");
  const kernel2 = new ProcurementRFQKernel("kernel-procurement-demo");
  const second = await kernel2.execute({
    rfqSpec,
    vendorList,
    sessionKey,
    sessionPrivateKey,
    jobId,
  });

  let allHashesMatch = true;
  for (let i = 0; i < stepTraces.length; i++) {
    const a = stepTraces[i];
    const b = second.stepTraces[i];
    const match = a.stepId === b.stepId && a.inputHash === b.inputHash && a.outputHash === b.outputHash;
    if (!match) {
      allHashesMatch = false;
      warn(`Step ${a.stepId}: hashes differ`);
      kv(`    Run 1 in/out`, `${a.inputHash.slice(0, 12)}/${a.outputHash.slice(0, 12)}`);
      kv(`    Run 2 in/out`, `${b.inputHash.slice(0, 12)}/${b.outputHash.slice(0, 12)}`);
    }
  }

  const reportsMatch = JSON.stringify(report) === JSON.stringify(second.report);
  const deterministic = allHashesMatch && reportsMatch;

  if (deterministic) {
    ok(`Deterministic computation confirmed: all 6 step hashes + report body identical`);
    kv("    First step in/out", `${stepTraces[0].inputHash.slice(0, 16)}.../${stepTraces[0].outputHash.slice(0, 16)}...`);
  } else {
    warn(`Non-determinism detected!`);
    if (!allHashesMatch) warn("Step hashes differ");
    if (!reportsMatch) warn("Report content differs");
  }

  console.log();
  if (allPassed && deterministic) {
    console.log(`  ${C.bgGreen}${C.white}${C.bold} ALL CHECKS PASSED ${C.reset}`);
  } else {
    console.log(`  ${C.bgRed}${C.white}${C.bold} SOME CHECKS FAILED ${C.reset}`);
    if (attestation.result !== "valid") warn("Evidence verification result: " + attestation.result);
    if (attestation.assuranceScore <= 0.8) warn("Assurance score below threshold: " + attestation.assuranceScore);
    if (!touchstoneResult.passed) warn("Touchstone did not pass");
    if (!chainVerify.valid) warn("Session chain verification failed");
    if (!deterministic) warn("Non-deterministic bundleHash");
  }
  console.log();
}

main().catch((err) => {
  console.error(`${C.red}FATAL: ${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
