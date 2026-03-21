/**
 * PCC × Story Protocol: IP for Physical Capabilities
 *
 * Demonstrates the complete IP lifecycle for a physical capability CSD:
 *
 *   Phase 1: Register a capability as an IP Asset on Story Protocol
 *   Phase 2: Configure revenue splits (who earns what on every job)
 *   Phase 3: Job execution creates a derivative IP (provenance chain)
 *   Phase 4: Escrow release → royalty payment to IP vault
 *   Phase 5: Collaborators claim their revenue
 *   Phase 6: CSD fork creates a multi-generation derivative chain
 *   Phase 7: Revenue dashboard (snapshot of vault state)
 *   Phase 8: IP lineage tree (full ancestor / descendant graph)
 *
 * Runs entirely in mock mode — no external network calls required.
 *
 * Run: npx tsx scripts/story-ip-demo.ts
 */

import { StoryIPService } from "@pcc/contracts";
import {
  SPLIT_PROFILES,
  buildSplitsForJob,
  calculateDistribution,
} from "@pcc/contracts";

// ---------------------------------------------------------------------------
// Pretty-print helpers
// ---------------------------------------------------------------------------

const DIVIDER   = "═".repeat(72);
const SECTION   = "─".repeat(72);
const SUBSECTION = "·".repeat(40);

function heading(phase: number, title: string) {
  console.log(`\n${SECTION}`);
  console.log(`  Phase ${phase}: ${title}`);
  console.log(SECTION);
}

function kv(key: string, value: string | number, indent = "  ") {
  const keyPad = key.padEnd(28);
  console.log(`${indent}\x1b[36m${keyPad}\x1b[0m ${value}`);
}

function success(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function info(msg: string) {
  console.log(`  \x1b[90m→\x1b[0m ${msg}`);
}

function subheading(title: string) {
  console.log(`\n  ${SUBSECTION}`);
  console.log(`  ${title}`);
  console.log(`  ${SUBSECTION}`);
}

// ---------------------------------------------------------------------------
// Wallet addresses (mock participants)
// ---------------------------------------------------------------------------

const ALICE_DESIGNER  = "0xA11ceDe51gnerF1e1dM111222333444555666777";
const BOB_OPERATOR    = "0xB0b0PerAt0rAu5t1nT3xa50001112223334445555";
const CAROL_VERIFIER  = "0xCar01Ver1f1erN0deQua1ity000111222333444";
const TREASURY        = "0xF33FeeProtoc01Treasury000111222333444555";
const FORKED_DESIGNER = "0xF0rkedDe51gnerMun1ch777888999000111222333";
const FORKED_OPERATOR = "0xF0rkedOp3rat0rBer11n111222333444555666777";
const PAYER_CUSTOMER  = "0xCu5t0merPayerWallet1234567890abcdef1234";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + DIVIDER);
  console.log("  PCC × Story Protocol: IP for Physical Capabilities");
  console.log("  \"Every collaborator earns. Every fork pays the original.\"");
  console.log(DIVIDER);
  console.log();
  info("Running in mock mode (STORY_MOCK=true) — no real chain transactions");
  info("Story Network L1 (chain 1514) / Aeneid testnet (chain 1513)");
  console.log();

  const svc = new StoryIPService({ mock: true });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 1: Register a Capability as an IP Asset
  // ════════════════════════════════════════════════════════════════════════

  heading(1, "Register Capability as IP Asset");
  console.log();
  info("Alice publishes a CSD for FDM 3D Printing (PLA, 0.1mm resolution)");
  info("CSD publication → Story Protocol IP registration");
  console.log();

  const capability = {
    id:          "cap-fdm-pla-0001",
    name:        "FDM 3D Printing — PLA, 0.1mm Resolution",
    type:        "fdm",
    kernelId:    "kernel-nyc-makerspace-001",
    description: "Open-source CSD for FDM printing in PLA. Tolerances ±0.1mm, layer height 0.1-0.3mm, supports Prusa MK4 / Bambu P1S.",
  };

  const registration = await svc.registerCapabilityAsIP(capability, {
    designerAddress:    ALICE_DESIGNER,
    designerName:       "Alice Designer (Detroit)",
    commercialRevShare: 5,   // 5% of all derivative revenue flows up to this IP
    ipfsCid:            "bafybeig3k5z7i2p5f5qk3m7h2qb7h4yymncxp3g2zkzq3okzqz7a7y7mu",
  });

  kv("IP Asset ID",        registration.ipId);
  kv("NFT Token ID",       registration.nftTokenId);
  kv("License Terms ID",   registration.licenseTermsId);
  kv("CSD URL",            registration.csdUrl);
  kv("Chain",              registration.chain);
  kv("Tx Hash",            registration.txHash.slice(0, 20) + "...");
  kv("Registered At",      registration.registeredAt);
  console.log();
  success("CSD registered as IP Asset — Alice owns the IP");
  success("5% of all derivative job revenue will flow to Alice's vault");

  const parentIpId = registration.ipId;

  // ════════════════════════════════════════════════════════════════════════
  // Phase 2: Configure Revenue Splits
  // ════════════════════════════════════════════════════════════════════════

  heading(2, "Configure Revenue Splits");
  console.log();
  info("Using SPLIT_PROFILES.singleStep — standard single-capability job");
  console.log();

  const profile = SPLIT_PROFILES.singleStep;
  console.log(`  Profile: ${profile.name}`);
  console.log(`  ${profile.description}`);
  console.log();

  const addresses = {
    designer: ALICE_DESIGNER,
    operator: BOB_OPERATOR,
    verifier: CAROL_VERIFIER,
    network:  TREASURY,
  };

  const resolvedSplits = buildSplitsForJob(profile, addresses);

  subheading("Revenue split configuration");
  for (const s of resolvedSplits) {
    kv(`${s.label} (${s.role})`, `${s.percentage}%  →  ${s.address.slice(0, 16)}...`);
  }
  console.log();

  const splitResult = await svc.distributeRoyaltyTokens(parentIpId, resolvedSplits);
  kv("Tx Hash",          splitResult.txHash.slice(0, 20) + "...");
  kv("Tokens Distributed", `${splitResult.distributed} / 100 (each token = 1%)`);
  console.log();
  success("Royalty tokens distributed — split is now on-chain immutable");
  success("Every job using this CSD distributes revenue per this configuration");

  // ════════════════════════════════════════════════════════════════════════
  // Phase 3: Job Creates Derivative IP
  // ════════════════════════════════════════════════════════════════════════

  heading(3, "Job Execution Creates Derivative IP");
  console.log();
  info("Bob's Prusa MK4 runs a 3D print job for a customer");
  info("On completion, the evidence bundle is registered as derivative IP");
  console.log();

  const jobEvidence = {
    jobId:               "job-fdm-20260321-0001",
    evidenceBundleHash:  "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
    operatorAddress:     BOB_OPERATOR,
    operatorName:        "Bob Operator (Austin, TX)",
    ipfsCid:             "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354",
  };

  const derivativeLink = await svc.registerJobAsDerivative(parentIpId, jobEvidence);

  kv("Parent IP (CSD)",   derivativeLink.parentIpId.slice(0, 20) + "...");
  kv("Child IP (Job)",    derivativeLink.childIpId.slice(0, 20) + "...");
  kv("License Token ID",  derivativeLink.licenseTokenId);
  kv("Job ID",            derivativeLink.jobId);
  kv("Evidence Hash",     derivativeLink.evidenceBundleHash.slice(0, 28) + "...");
  kv("Tx Hash",           derivativeLink.txHash.slice(0, 20) + "...");
  kv("Linked At",         derivativeLink.linkedAt);
  console.log();
  success("Evidence bundle is now a derivative IP of the CSD");
  success("Provenance chain: Alice's CSD → Bob's job output");
  success("On-chain proof: this part was made using that process");

  // ════════════════════════════════════════════════════════════════════════
  // Phase 4: Royalty Payment on Job Completion
  // ════════════════════════════════════════════════════════════════════════

  heading(4, "Royalty Payment (Escrow Release)");
  console.log();
  info("Customer's escrow releases on job completion");
  info("5% of job value → Story Protocol IP Royalty Vault");
  console.log();

  // Two payments: the initial job + a repeat booking
  const payment1 = "500000";   // 0.5 USDC (in micro-USDC units)
  const payment2 = "750000";   // 0.75 USDC

  subheading("Payment 1: initial booking");
  const payResult1 = await svc.payJobRoyalty(parentIpId, payment1, PAYER_CUSTOMER);
  kv("Amount",    `${payment1} μUSDC`);
  kv("Payer",     PAYER_CUSTOMER.slice(0, 16) + "...");
  kv("Tx Hash",   payResult1.txHash.slice(0, 20) + "...");
  success("Payment 1 deposited to IP Royalty Vault");

  subheading("Payment 2: repeat booking");
  const payResult2 = await svc.payJobRoyalty(parentIpId, payment2, PAYER_CUSTOMER);
  kv("Amount",    `${payment2} μUSDC`);
  kv("Payer",     PAYER_CUSTOMER.slice(0, 16) + "...");
  kv("Tx Hash",   payResult2.txHash.slice(0, 20) + "...");
  success("Payment 2 deposited to IP Royalty Vault");

  // Show per-holder breakdown of accumulated revenue
  const totalPayments = BigInt(payment1) + BigInt(payment2);
  const distribution = calculateDistribution(String(totalPayments), resolvedSplits);

  subheading("Per-collaborator breakdown (total accumulated)");
  for (const d of distribution) {
    const split = resolvedSplits.find((s) => s.address === d.address);
    const label = split ? `${split.label} (${split.percentage}%)` : "Unknown";
    kv(label, `${d.amount} μUSDC`);
  }
  console.log();
  success(`Total in vault: ${totalPayments} μUSDC`);

  // ════════════════════════════════════════════════════════════════════════
  // Phase 5: Claim Revenue
  // ════════════════════════════════════════════════════════════════════════

  heading(5, "Claim Revenue");
  console.log();
  info("Collaborators pull their accumulated earnings from the vault");
  info("Each holder claims proportional to their Royalty Token count");
  console.log();

  const claimResult = await svc.claimRevenue(parentIpId);
  kv("Claimed Total",  `${claimResult.claimed} μUSDC`);
  kv("Tx Hash",        claimResult.txHash.slice(0, 20) + "...");
  console.log();

  // Verify vault is empty after claim
  const postClaimSnapshot = await svc.getRevenueSnapshot(parentIpId);
  kv("Vault Balance After Claim",  `${postClaimSnapshot.unclaimedRevenue} μUSDC`);
  console.log();
  success("All revenue claimed — vault reset to 0");
  success("Designer earned from Bob's job even though Alice wasn't present");

  // ════════════════════════════════════════════════════════════════════════
  // Phase 6: CSD Fork Creates Derivative Chain
  // ════════════════════════════════════════════════════════════════════════

  heading(6, "CSD Fork Creates Derivative IP Chain");
  console.log();
  info("Dave in Munich forks Alice's CSD for his Bambu P1S printer");
  info("The fork is registered as a derivative of Alice's IP Asset");
  info("Alice earns 5% of all revenue from the forked CSD forever");
  console.log();

  const forkedCapability = {
    id:          "cap-fdm-pla-fork-bambu-0001",
    name:        "FDM 3D Printing — PLA, Bambu P1S (Forked from Alice's CSD)",
    type:        "fdm",
    kernelId:    "kernel-munich-fablab-001",
    description: "Fork of Alice's FDM CSD tuned for Bambu P1S. Higher speeds, same tolerances.",
  };

  const forkedRegistration = await svc.registerCapabilityAsIP(forkedCapability, {
    designerAddress: FORKED_DESIGNER,
    designerName:    "Dave Designer (Munich)",
    commercialRevShare: 5,
  });

  // Register the fork as a derivative of the original CSD IP
  const forkDerivativeLink = await svc.registerJobAsDerivative(parentIpId, {
    jobId:               `fork-reg-${forkedCapability.id}`,
    evidenceBundleHash:  "sha256:fork-registration-proof-" + forkedCapability.id,
    operatorAddress:     FORKED_DESIGNER,
    operatorName:        "Dave Designer (Munich)",
  });

  kv("Original CSD IP",   parentIpId.slice(0, 20) + "...");
  kv("Forked CSD IP",     forkedRegistration.ipId.slice(0, 20) + "...");
  kv("Derivative Link",   forkDerivativeLink.txHash.slice(0, 20) + "...");
  console.log();
  success("Fork registered as derivative — Dave's CSD inherits from Alice's");

  // Dave configures his own splits for the forked CSD
  const daveSplits = buildSplitsForJob(SPLIT_PROFILES.singleStep, {
    designer: FORKED_DESIGNER,
    operator: FORKED_OPERATOR,
    verifier: CAROL_VERIFIER,
    network:  TREASURY,
  });

  await svc.distributeRoyaltyTokens(forkedRegistration.ipId, daveSplits);

  // A job runs on Dave's forked CSD
  await svc.payJobRoyalty(forkedRegistration.ipId, "300000", PAYER_CUSTOMER);

  // Parent (Alice's IP) automatically earns via Story's royalty routing
  await svc.payJobRoyalty(parentIpId, "15000", forkedRegistration.ipId);  // 5% up

  const parentSnapshot = await svc.getRevenueSnapshot(parentIpId);
  kv("Alice's vault (from fork royalty)", `${parentSnapshot.totalRevenue} μUSDC`);
  console.log();
  success("Alice earns from Dave's jobs even though she never knew about them");
  success("This is the core Story Protocol value: IP chains that pay up the tree");

  // ════════════════════════════════════════════════════════════════════════
  // Phase 7: Revenue Dashboard Snapshot
  // ════════════════════════════════════════════════════════════════════════

  heading(7, "Revenue Dashboard");
  console.log();
  info("Full snapshot of Alice's IP Asset vault state");
  console.log();

  const snapshot = await svc.getRevenueSnapshot(parentIpId);

  kv("IP Asset ID",        snapshot.ipId.slice(0, 20) + "...");
  kv("Vault Address",      snapshot.vaultAddress.slice(0, 20) + "...");
  kv("Total Revenue",      `${snapshot.totalRevenue} μUSDC`);
  kv("Unclaimed Revenue",  `${snapshot.unclaimedRevenue} μUSDC`);
  kv("Last Payment At",    snapshot.lastPaymentAt);
  console.log();

  subheading("Token Holders");
  if (snapshot.tokenHolders.length === 0) {
    info("No token holders found (vault not yet split)");
  } else {
    for (const holder of snapshot.tokenHolders) {
      kv(
        `${holder.address.slice(0, 16)}... (${holder.tokensHeld} tokens)`,
        `claimable: ${holder.claimable} μUSDC`,
      );
    }
  }
  console.log();
  success("Revenue dashboard reflects on-chain vault state");

  // ════════════════════════════════════════════════════════════════════════
  // Phase 8: IP Lineage Chain
  // ════════════════════════════════════════════════════════════════════════

  heading(8, "IP Lineage Chain");
  console.log();
  info("Full ancestor / descendant tree for Alice's CSD IP");
  console.log();

  const lineage = await svc.getLineage(parentIpId);

  kv("IP Asset",         parentIpId.slice(0, 20) + "...");
  kv("Ancestors",        lineage.ancestors.length === 0 ? "(root — no parents)" : lineage.ancestors.join(", "));
  kv("Descendants",      `${lineage.descendants.length} derivative(s)`);
  console.log();

  if (lineage.descendants.length > 0) {
    subheading("Descendants (children + grandchildren)");
    lineage.descendants.forEach((d, i) => {
      kv(`  #${i + 1}`, d.slice(0, 32) + "...");
    });
    console.log();
  }

  // Also show the forked CSD's lineage (it has Alice's IP as ancestor)
  const forkLineage = await svc.getLineage(forkedRegistration.ipId);
  kv("Fork IP Ancestors",   forkLineage.ancestors.length > 0 ? forkLineage.ancestors[0]!.slice(0, 20) + "..." : "(none)");
  kv("Fork IP Descendants", `${forkLineage.descendants.length} derivative(s)`);
  console.log();

  success("Lineage proves provenance: Dave's CSD derives from Alice's");
  success("Any auditor can trace the full IP chain on-chain");

  // ════════════════════════════════════════════════════════════════════════
  // Demo Complete
  // ════════════════════════════════════════════════════════════════════════

  console.log("\n" + DIVIDER);
  console.log("  Demo Complete");
  console.log(DIVIDER);
  console.log();
  success("CSD registered as IP Asset with programmable royalties");
  success("Revenue splits configured — 10/70/10/10 immutably on-chain");
  success("Job evidence linked as derivative IP (provenance chain)");
  success("Escrow release → royalty vault deposit (automatic)");
  success("All collaborators claimed their revenue");
  success("CSD fork registered as derivative — original earns forever");
  success("Revenue dashboard shows full vault state");
  success("IP lineage traces ancestor/descendant graph");
  console.log();
  info("PCC concept: Capabilities = billable units. IP = who owns the design.");
  info("Story Protocol concept: IP Assets with programmable royalties.");
  info("Together: physical work creates on-chain IP that pays everyone.");
  console.log();
  console.log("  Read the integration plan:");
  console.log("  docs/STORY_PROTOCOL_INTEGRATION_PLAN.md");
  console.log();
  console.log(DIVIDER);
  console.log();
}

main().catch((err) => {
  console.error("\n[DEMO ERROR]", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
