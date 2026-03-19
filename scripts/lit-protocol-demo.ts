/**
 * Lit Protocol Encryption Demo
 *
 * Demonstrates the Lit Protocol encryption layer for PCC evidence bundles:
 *
 *   Phase 1: Mock mode (local AES-256-GCM)
 *     - Builds access conditions (buyer OR verifier >= 100 rep)
 *     - Encrypts a sample evidence bundle
 *     - Decrypts and verifies the round-trip
 *     - Shows the UACC structure in detail
 *
 *   Phase 2: Factory mode (env-driven service selection)
 *     - Shows how createLitEncryptionService() picks the right implementation
 *     - Shows isRealLitEnabled() helper
 *
 *   Phase 3: Real Lit path (overview, no actual network call)
 *     - Instantiates RealLitEncryptionService
 *     - Builds access conditions (same logic, real Lit types)
 *     - Validates the condition structure
 *     - Notes what connect() + encrypt() would do against datil-test
 *
 * Run:
 *   npx tsx scripts/lit-protocol-demo.ts             # mock mode
 *   LIT_PROTOCOL_REAL=true npx tsx scripts/lit-protocol-demo.ts  # factory picks real
 */

import { LitEncryptionService } from "@pcc/kernel";
import { RealLitEncryptionService } from "@pcc/kernel";
import { createLitEncryptionService, isRealLitEnabled } from "../packages/kernel/src/lit-encryption-factory.js";
import type { LitAuthSig } from "@pcc/kernel";
import type { EvidenceBundle, SHA256, Address, Signature } from "@pcc/spec";
import { ids } from "@pcc/spec";

// ── Visual helpers ────────────────────────────────────────────────────────

const DIVIDER = "═".repeat(72);
const SUB_DIVIDER = "─".repeat(60);

const COLORS = {
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  magenta: "\x1b[35m",
  blue:    "\x1b[34m",
  red:     "\x1b[91m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  reset:   "\x1b[0m",
};

function c(color: keyof typeof COLORS, text: string): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function log(tag: string, msg: string, color: keyof typeof COLORS = "cyan") {
  const padded = tag.padEnd(10);
  console.log(`${c(color, `[${padded}]`)} ${msg}`);
}

function phase(title: string) {
  console.log(`\n${c("bold", DIVIDER)}`);
  console.log(`  ${c("bold", title)}`);
  console.log(`${c("bold", DIVIDER)}\n`);
}

function section(title: string) {
  console.log(`\n${c("dim", SUB_DIVIDER)}`);
  console.log(`  ${c("yellow", title)}`);
  console.log(`${c("dim", SUB_DIVIDER)}`);
}

function ok(msg: string) {
  log("OK", msg, "green");
}

function info(msg: string) {
  log("INFO", msg, "blue");
}

function warn(msg: string) {
  log("WARN", msg, "yellow");
}

// ── Sample data ───────────────────────────────────────────────────────────

const ESCROW_ADDRESS = "0xEscrow0000000000000000000000000000000001" as Address;
const JOB_ID = ids.job();

function makeEvidenceBundle(): EvidenceBundle {
  return {
    id: ids.bundle(),
    jobId: JOB_ID,
    stepId: "step-fdm-print",
    kernelId: "kernel-demo-sf",
    assuranceTier: 2,
    events: [
      {
        id: ids.evidence(),
        type: "layer_completed",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev-prusa-01", deviceType: "controller", kernelId: "kernel-demo-sf" },
        payload: { layer: 42, progress: 0.84, nozzleTemp: 215.2, bedTemp: 60.1 },
        hash: "sha256:evidence_hash_placeholder_aaaa111111111111111111111111111111111111" as SHA256,
      },
      {
        id: ids.evidence(),
        type: "execution_completed",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev-prusa-01", deviceType: "controller", kernelId: "kernel-demo-sf" },
        payload: { success: true, totalLayers: 50, duration: 1800 },
        hash: "sha256:evidence_hash_placeholder_bbbb222222222222222222222222222222222222" as SHA256,
      },
    ],
    bundleHash: "sha256:bundle_hash_placeholder_cccc333333333333333333333333333333333333" as SHA256,
    kernelSignature: {
      signer: "0x0000000000000000000000000000000000000000" as Address,
      algorithm: "secp256k1",
      value: "demo-kernel-sig",
    } as Signature,
    createdAt: new Date().toISOString(),
  };
}

function makeAuthSig(): LitAuthSig {
  return {
    sig: "0x" + "a1b2c3d4".repeat(16),
    derivedVia: "web3.eth.personal.sign",
    signedMessage: "I am proving identity for Lit Protocol decryption\nNonce: " + Date.now(),
    address: "0xBuyer000000000000000000000000000000000001",
  };
}

// ── Phase 1: Mock mode ────────────────────────────────────────────────────

async function runMockPhase() {
  phase("Phase 1: Mock Mode — AES-256-GCM with in-process key storage");

  const svc = new LitEncryptionService({
    network: "datil-test",
    chain: "baseSepolia",
    mock: true,
  });

  // Connect
  section("1a. Connect");
  await svc.connect();
  ok(`Connected (mock). isConnected = ${svc.isConnected()}`);
  info("Mock mode: no network — AES-256-GCM runs locally, keys stored in-process");

  // Build access conditions
  section("1b. Build Unified Access Control Conditions (UACC)");
  const conditions = svc.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);

  info(`Access condition chain has ${conditions.length} elements:`);
  console.log();

  const [buyerCond, orOp, verifierCond] = conditions as any[];
  console.log(`  ${c("green", "Condition 1")} (buyer gate):`);
  console.log(`    type:       ${buyerCond.conditionType}`);
  console.log(`    contract:   ${buyerCond.contractAddress}`);
  console.log(`    chain:      ${buyerCond.chain}`);
  console.log(`    function:   ${buyerCond.functionName}(${buyerCond.functionParams?.join(", ")})`);
  console.log(`    test:       returnValue ${buyerCond.returnValueTest.comparator} ${buyerCond.returnValueTest.value}`);

  console.log();
  console.log(`  ${c("yellow", "Operator")}:  ${orOp.operator.toUpperCase()}`);
  console.log();

  console.log(`  ${c("green", "Condition 2")} (verifier reputation gate):`);
  console.log(`    type:       ${verifierCond.conditionType}`);
  console.log(`    contract:   ${verifierCond.contractAddress}`);
  console.log(`    chain:      ${verifierCond.chain}`);
  console.log(`    function:   ${verifierCond.functionName}(${verifierCond.functionParams?.join(", ")})`);
  console.log(`    test:       returnValue ${verifierCond.returnValueTest.comparator} ${verifierCond.returnValueTest.value}`);

  // Validate
  console.log();
  const validation = svc.validateAccessConditions(conditions);
  ok(`UACC validation: valid=${validation.valid}, errors=${validation.errors.length}`);

  // Encrypt
  section("1c. Encrypt evidence bundle");
  const bundle = makeEvidenceBundle();
  info(`Bundle ID: ${bundle.id}`);
  info(`Job ID:    ${bundle.jobId}`);
  info(`Events:    ${bundle.events.length} (layer_completed, execution_completed)`);

  const encrypted = await svc.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID);

  console.log();
  ok("Bundle encrypted successfully");
  console.log(`  litCiphertext (first 32 chars):  ${encrypted.litCiphertext?.slice(0, 32)}...`);
  console.log(`  litDataToEncryptHash:            ${encrypted.litDataToEncryptHash?.slice(0, 32)}...`);
  console.log(`  litNetwork:                      ${encrypted.litNetwork}`);
  console.log(`  litAccessConditions count:       ${encrypted.litAccessConditions?.length}`);
  console.log(`  bundleHash:                      ${encrypted.bundleHash}`);
  console.log(`  encryptedAt:                     ${encrypted.encryptedAt}`);
  console.log(`  capsules (Lit uses conditions):  ${encrypted.capsules?.length} (empty)`);

  // Decrypt
  section("1d. Decrypt evidence bundle (round-trip)");
  const authSig = makeAuthSig();
  info(`Using authSig from address: ${authSig.address}`);

  const decrypted = await svc.decryptBundle(encrypted, authSig);

  ok("Round-trip decrypt successful");
  console.log(`  Recovered bundle ID:    ${decrypted.id}`);
  console.log(`  Recovered job ID:       ${decrypted.jobId}`);
  console.log(`  Recovered event count:  ${decrypted.events.length}`);
  console.log(`  ID match:               ${decrypted.id === bundle.id ? "PASS" : "FAIL"}`);

  // getAccessConditions
  section("1e. Get access conditions from encrypted bundle");
  const retrieved = svc.getAccessConditions(encrypted);
  ok(`Retrieved ${retrieved?.length} access conditions from encrypted bundle`);

  await svc.disconnect();
  ok("Disconnected (mock key store cleared)");
}

// ── Phase 2: Factory mode ─────────────────────────────────────────────────

async function runFactoryPhase() {
  phase("Phase 2: Factory Mode — env-driven service selection");

  section("2a. isRealLitEnabled() helper");
  const realEnabled = isRealLitEnabled();
  info(`LIT_PROTOCOL_REAL env var: ${process.env.LIT_PROTOCOL_REAL ?? "(not set)"}`);
  info(`isRealLitEnabled():        ${realEnabled}`);

  section("2b. createLitEncryptionService() with no options (default)");
  const defaultSvc = createLitEncryptionService();
  const defaultType = defaultSvc.constructor.name;
  info(`Selected: ${c("green", defaultType)}`);
  ok(`Factory returned the ${realEnabled ? "real" : "mock"} service (matches env)`);

  section("2c. createLitEncryptionService({ mock: true }) — explicit override");
  const explicitMock = createLitEncryptionService({ mock: true });
  info(`Selected: ${c("green", explicitMock.constructor.name)}`);
  ok("options.mock=true overrides env — always mock");

  section("2d. createLitEncryptionService({ mock: false }) — force real");
  const explicitReal = createLitEncryptionService({ mock: false });
  info(`Selected: ${c("green", explicitReal.constructor.name)}`);
  ok("options.mock=false overrides env — always real (instantiation only, no network call)");

  section("2e. Factory with options forwarding");
  const factorySvc = createLitEncryptionService({ network: "datil-test", chain: "baseSepolia" });
  await factorySvc.connect();
  ok(`Factory-created service connected. isConnected: ${factorySvc.isConnected()}`);
  await factorySvc.disconnect();
  ok("Disconnected factory service");
}

// ── Phase 3: Real Lit path overview ───────────────────────────────────────

async function runRealPhase() {
  phase("Phase 3: Real Lit Protocol Path — RealLitEncryptionService Overview");

  section("3a. Instantiate RealLitEncryptionService");
  const realSvc = new RealLitEncryptionService({
    network: "datil-test",
    chain: "baseSepolia",
  });

  ok("RealLitEncryptionService instantiated");
  info(`isConnected (before connect): ${realSvc.isConnected()}`);
  warn("connect() requires live network — skipped in demo to avoid blocking");
  info("In production: await realSvc.connect() bootstraps threshold keys from datil-test nodes");

  section("3b. Access conditions (same logic, real Lit SDK types)");
  const conditions = realSvc.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
  const validation = realSvc.validateAccessConditions(conditions);

  ok(`UACC built: ${conditions.length} elements`);
  ok(`Validation: valid=${validation.valid}, errors=${validation.errors.length}`);

  const buyer = conditions[0] as any;
  const verifier = conditions[2] as any;
  info(`Buyer condition: ${buyer.functionName}(${buyer.functionParams?.join(", ")}) ${buyer.returnValueTest.comparator} :userAddress`);
  info(`Verifier condition: ${verifier.functionName}(:userAddress) >= ${verifier.returnValueTest.value}`);

  section("3c. encryptBundle() — what it does against datil-test");
  info("1. Serializes bundle with canonicalize() for deterministic hash");
  info("2. Calls client.encrypt({ dataToEncrypt, unifiedAccessControlConditions })");
  info("3. Lit nodes respond with ciphertext + dataToEncryptHash");
  info("4. Keys are threshold-split across Lit nodes — NEVER stored locally");
  info("5. Returns EncryptedEvidenceBundle with litCiphertext, litDataToEncryptHash");

  section("3d. decryptBundle() — what it does against datil-test");
  info("1. Requires SessionSigs (SIWE-based) or AuthSig from caller");
  info("2. Calls client.decrypt({ ciphertext, dataToEncryptHash, unifiedAccessControlConditions, sessionSigs })");
  info("3. Lit nodes check access conditions on-chain (Base Sepolia):");
  info("   - Is caller the escrow buyer? (getBuyer(jobId) == :userAddress)");
  info("   - OR does caller have >= 100 verifier reputation?");
  info("4. If conditions pass, nodes release decryption shares");
  info("5. Client reconstructs key and decrypts — returns EvidenceBundle");

  section("3e. Error handling for missing fields");
  // Test the connected flag check without actually connecting
  (realSvc as any).connected = true;
  const badBundle1 = { litCiphertext: "abc" } as any;
  const badBundle2 = { litDataToEncryptHash: "abc" } as any;
  const authSig = { sig: "0x", derivedVia: "v", signedMessage: "m", address: "0xabc" };

  try {
    await realSvc.decryptBundle(badBundle1, authSig);
  } catch (e: any) {
    ok(`Missing litDataToEncryptHash rejected: "${e.message}"`);
  }

  try {
    await realSvc.decryptBundle(badBundle2, authSig);
  } catch (e: any) {
    ok(`Missing litCiphertext rejected: "${e.message}"`);
  }

  section("3f. Toggle to real mode");
  info("To activate the real Lit Protocol path:");
  console.log();
  console.log(`  ${c("green", "# Gateway")}:`);
  console.log(`  export LIT_PROTOCOL_REAL=true`);
  console.log(`  pnpm dev`);
  console.log();
  console.log(`  ${c("green", "# Demo script")}:`);
  console.log(`  LIT_PROTOCOL_REAL=true npx tsx scripts/lit-protocol-demo.ts`);
  console.log();
  console.log(`  ${c("green", "# Integration tests (requires datil-test access)")}:`);
  console.log(`  LIT_PROTOCOL_REAL=true pnpm --filter @pcc/kernel test`);
  console.log();
  info("The gateway services.ts already checks USE_REAL_LIT and picks the right service.");
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + c("bold", DIVIDER));
  console.log(`  ${c("bold", "Lit Protocol Encryption Demo")}`);
  console.log(`  ${c("dim", "Physical Capability Cloud — Evidence Bundle Encryption")}`);
  console.log(c("bold", DIVIDER));

  console.log();
  info(`Timestamp: ${new Date().toISOString()}`);
  info(`LIT_PROTOCOL_REAL: ${process.env.LIT_PROTOCOL_REAL ?? "(not set) → mock mode"}`);

  await runMockPhase();
  await runFactoryPhase();
  await runRealPhase();

  console.log("\n" + c("bold", DIVIDER));
  console.log(`  ${c("green", "Demo complete.")}`);
  console.log(c("bold", DIVIDER) + "\n");
}

main().catch((err) => {
  console.error(c("red", "\n[FATAL] Demo failed:"), err);
  process.exit(1);
});
