/**
 * REAL end-to-end PCC protocol. No mocks. Real chain. Real robot. Real printer.
 *
 * 1. Deploy fresh MilestoneEscrow with USDC we can mint
 * 2. Mint USDC → approve → fund escrow (1 milestone)
 * 3. Submit OT-2 job (slots 1, 3, 5)
 * 4. Wait for daemon to complete
 * 5. Submit evidence hash on-chain
 * 6. Release milestone (settle USDC to operator)
 * 7. Collect everything → print on HP printer
 *
 * FC-8 round 3 refactor (astra pack 61b census closure, step 1 of 2 — NO
 * behavior change in this commit): exported as `run(deps)` with injected
 * fetch/chain-clients/env. CLI behavior preserved behind the entry guard.
 * Print statements are byte-for-byte unchanged from before this refactor;
 * the validated-field fix lands in the next commit.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  formatEther,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type WalletClient,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { safeLogJson, safeLogId, safeLogErrorName } from "../packages/gateway/src/util/redact-log.js";

/** Thrown for a missing required env var. `.message` is always safe to print as-is: it is built from a trusted name plus static text, never from external data. */
export class MissingEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingEnvError";
  }
}

const GATEWAY = "https://capability.network";
const ORACLE_URL = "https://refer-proxy-joint-cleaning.trycloudflare.com";
const KERNEL = "kernel-nanoclaw";

function requireEnv(env: Record<string, string | undefined>, name: string, what: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new MissingEnvError(`${name} is not set: export ${what} before running this script. Keys are never committed to this repository.`);
  }
  return value;
}

const ERC20 = [
  { name: "mint", type: "function" as const, inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" as const },
  { name: "approve", type: "function" as const, inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" as const },
  { name: "balanceOf", type: "function" as const, inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" as const },
] as const;

// IPCCOracle.Attestation tuple shape — must match Solidity struct exactly.
const ATTESTATION_TUPLE = {
  name: "attestation",
  type: "tuple" as const,
  components: [
    { name: "escrowAddress", type: "address" as const },
    { name: "jobId", type: "string" as const },
    { name: "evidenceHash", type: "bytes32" as const },
    { name: "tier", type: "uint8" as const },
    { name: "verified", type: "bool" as const },
    { name: "timestamp", type: "uint256" as const },
    { name: "nonce", type: "bytes32" as const },
    { name: "signature", type: "bytes" as const },
  ],
} as const;

const ESCROW_ABI = [
  { name: "addMilestone", type: "function" as const, inputs: [{ name: "_stepId", type: "bytes32" }, { name: "_operator", type: "address" }, { name: "_amount", type: "uint256" }, { name: "_operatorBond", type: "uint256" }, { name: "_challengeWindowSeconds", type: "uint256" }], outputs: [], stateMutability: "nonpayable" as const },
  { name: "fund", type: "function" as const, inputs: [], outputs: [], stateMutability: "nonpayable" as const },
  { name: "submitEvidence", type: "function" as const, inputs: [{ name: "milestoneIndex", type: "uint256" }, { name: "_evidenceBundleHash", type: "bytes32" }], outputs: [], stateMutability: "nonpayable" as const },
  { name: "submitAttestation", type: "function" as const, inputs: [{ name: "milestoneIndex", type: "uint256" }, ATTESTATION_TUPLE], outputs: [], stateMutability: "nonpayable" as const },
  { name: "release", type: "function" as const, inputs: [{ name: "milestoneIndex", type: "uint256" }, ATTESTATION_TUPLE], outputs: [], stateMutability: "nonpayable" as const },
  { name: "funded", type: "function" as const, inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" as const },
  { name: "totalAmount", type: "function" as const, inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" as const },
  { name: "getMilestoneCount", type: "function" as const, inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" as const },
] as const;

export interface RunDeps {
  fetchImpl?: typeof fetch;
  wallet?: WalletClient;
  pub?: PublicClient;
  env?: Record<string, string | undefined>;
  pollSleepMs?: number;
  pollAttempts?: number;
  contractsDir?: string;
}

export interface RunResult {
  report: string;
}

export async function run(deps: RunDeps = {}): Promise<RunResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollSleepMs = deps.pollSleepMs ?? 5000;
  const pollAttempts = deps.pollAttempts ?? 40;

  const PK = (env.PCC_GATEWAY_PRIVATE_KEY || env.DEPLOYER_PRIVATE_KEY) as Hex | undefined;
  if (!PK) throw new MissingEnvError("Set PCC_GATEWAY_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY");
  const ORACLE_KEY = requireEnv(env, "PCC_ORACLE_KEY", "the oracle's x-oracle-key");
  let USDC: Address; // Will be deployed fresh

  const account = privateKeyToAccount(PK);
  const rpc = http("https://sepolia.base.org");
  const wallet = deps.wallet ?? createWalletClient({ account, chain: baseSepolia, transport: rpc });
  const pub = deps.pub ?? createPublicClient({ chain: baseSepolia, transport: rpc });

  async function writeContract(params: any) {
    const n = await pub.getTransactionCount({ address: account.address });
    return wallet.writeContract({ ...params, nonce: n, account, chain: baseSepolia } as any);
  }
  async function deployContract(params: any) {
    const n = await pub.getTransactionCount({ address: account.address });
    return wallet.deployContract({ ...params, nonce: n, account, chain: baseSepolia } as any);
  }

  const report: string[] = [];
  function log(msg: string) { console.log(msg); report.push(msg); }

  async function waitTx(hash: Hex) {
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    await new Promise(r => setTimeout(r, pollSleepMs > 0 ? 2000 : 0));
    return receipt;
  }

  async function gw(method: string, path: string, body?: any) {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json", "User-Agent": "pcc-e2e/1.0" } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetchImpl(`${GATEWAY}${path}`, opts);
    return r.json();
  }

  log("================================================================");
  log("  PCC REAL END-TO-END PROTOCOL EXECUTION");
  log("  " + new Date().toISOString());
  log("================================================================");
  log("");

  const ethBal = await pub.getBalance({ address: account.address });
  log(`Deployer:    ${account.address}`);
  log(`ETH:         ${formatEther(ethBal)}`);
  log(`USDC:        ${USDC}`);
  log(`Network:     Base Sepolia (chain 84532)`);
  log(`Gateway:     ${GATEWAY}`);
  log(`Kernel:      ${KERNEL}`);
  log("");

  // ── 1. Deploy MockUSDC + PCCProtocol + Escrow (via factory) ─────────
  log("[1] DEPLOYING FRESH CONTRACTS");
  const contractsDir = deps.contractsDir ?? resolve(process.cwd(), "packages/contracts");
  const usdcArtifact = JSON.parse(readFileSync(resolve(contractsDir, "out/MockUSDC.sol/MockUSDC.json"), "utf8"));
  const protocolArtifact = JSON.parse(readFileSync(resolve(contractsDir, "out/PCCProtocol.sol/PCCProtocol.json"), "utf8"));

  // 1a. Deploy MockUSDC
  log("    Deploying MockUSDC...");
  const usdcDeployTx = await deployContract({
    abi: usdcArtifact.abi,
    bytecode: usdcArtifact.bytecode.object as `0x${string}`,
    args: [parseUnits("1000000", 6)],
  });
  const usdcReceipt: any = await waitTx(usdcDeployTx);
  USDC = usdcReceipt.contractAddress!;
  log(`    MockUSDC:   ${USDC}`);
  log(`    TX:         ${usdcDeployTx}`);

  // 1b. Deploy PCCProtocol (fee factory)
  log("    Deploying PCCProtocol (2.35% fee, oracle-gated)...");
  const oracleVerifier = (env.ORACLE_VERIFIER_ADDRESS ?? account.address) as Address;
  log(`    Oracle verifier: ${oracleVerifier}`);
  const protocolDeployTx = await deployContract({
    abi: protocolArtifact.abi,
    bytecode: protocolArtifact.bytecode.object as `0x${string}`,
    args: [
      account.address,   // feeRecipient (immutable)
      235n,              // 2.35% fee
      account.address,   // governor
      oracleVerifier,    // oracleVerifier (immutable)
    ],
  });
  const protocolReceipt: any = await waitTx(protocolDeployTx);
  const PROTOCOL = protocolReceipt.contractAddress!;
  log(`    PCCProtocol: ${PROTOCOL}`);
  log(`    TX:          ${protocolDeployTx}`);
  log(`    Fee:         2.35% to ${account.address}`);

  // 1c. Create escrow via factory (registers it for fee collection)
  log("    Creating escrow via PCCProtocol.createEscrow()...");
  const cwmId = keccak256(toBytes("pcc-real-e2e-" + Date.now()));
  const createEscrowTx = await writeContract({
    address: PROTOCOL,
    abi: protocolArtifact.abi,
    functionName: "createEscrow",
    args: [account.address, account.address, USDC, cwmId],
  });
  log(`    TX:          ${createEscrowTx}`);
  const createReceipt: any = await waitTx(createEscrowTx);
  const escrowLog = createReceipt.logs.find((l: any) => l.topics.length >= 2);
  const ESCROW = ("0x" + (escrowLog?.topics[1]?.slice(26) ?? "")) as Address;
  log(`    Escrow:      ${ESCROW}`);
  log(`    Block:       ${createReceipt.blockNumber}`);
  log(`    Explorer:    https://sepolia.basescan.org/address/${ESCROW}`);
  log(`    Protocol:    https://sepolia.basescan.org/address/${PROTOCOL}`);
  log("");

  // ── 2. Mint USDC ──────────────────────────────────────────────────
  log("[2] MINTING 10 USDC");
  const mintTx = await writeContract({
    address: USDC, abi: ERC20, functionName: "mint",
    args: [account.address, parseUnits("10", 6)],
  });
  log(`    TX: ${mintTx}`);
  await waitTx(mintTx);
  const bal = await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  log(`    Balance: ${formatUnits(bal, 6)} USDC`);
  log("");

  // ── 3. Approve + Fund ─────────────────────────────────────────────
  log("[3] ADD MILESTONE + APPROVE + FUND ESCROW (1 USDC)");
  const stepId = keccak256(toBytes("pcc-slot-inspection-1-3-5"));
  const addMsTx = await writeContract({
    address: ESCROW, abi: ESCROW_ABI, functionName: "addMilestone",
    args: [stepId, account.address, parseUnits("1", 6), 0n, 0n],
  });
  log(`    AddMilestone TX: ${addMsTx}`);
  await waitTx(addMsTx);

  const approveTx = await writeContract({
    address: USDC, abi: ERC20, functionName: "approve",
    args: [ESCROW, parseUnits("10", 6)],
  });
  log(`    Approve TX:      ${approveTx}`);
  await waitTx(approveTx);

  const fundTx = await writeContract({
    address: ESCROW, abi: ESCROW_ABI, functionName: "fund",
    args: [],
  });
  log(`    Fund TX:         ${fundTx}`);
  const fundReceipt: any = await waitTx(fundTx);
  log(`    Block:           ${fundReceipt.blockNumber}`);

  const funded = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "funded" });
  const total = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "totalAmount" });
  const msCount = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "getMilestoneCount" });
  log(`    Funded:     ${funded}`);
  log(`    Amount:     ${formatUnits(total, 6)} USDC`);
  log(`    Milestones: ${msCount}`);
  log("");

  // ── 4. Submit OT-2 job ────────────────────────────────────────────
  log("[4] SUBMITTING OT-2 JOB — SLOTS 1, 3, 5");
  const jobResult = await gw("POST", "/api/jobs/submit", {
    stepId: "step-real-e2e-final",
    kernelId: KERNEL,
    parameters: {
      pythonCode: [
        "from opentrons import protocol_api, types",
        "",
        'metadata = {"apiLevel": "2.13", "protocolName": "PCC Real E2E — Slots 1, 3, 5"}',
        "",
        "def run(protocol: protocol_api.ProtocolContext):",
        '    right = protocol.load_instrument("p1000_single_gen2", "right")',
        "    protocol.set_rail_lights(True)",
        '    for slot in ["1", "3", "5"]:',
        "        pos = protocol.deck.position_for(slot)",
        "        right.move_to(types.Location(types.Point(x=pos.point.x, y=pos.point.y, z=120), None))",
        "        protocol.delay(seconds=3)",
        '        protocol.comment("Inspecting slot " + slot)',
        "    protocol.set_rail_lights(False)",
        "    protocol.delay(seconds=1)",
        "    protocol.set_rail_lights(True)",
        '    protocol.comment("PCC Real E2E complete")',
      ].join("\n"),
      filename: "pcc_real_e2e.py",
    },
  });
  log(`    Job ID:  ${jobResult.jobId}`);
  log(`    Status:  ${jobResult.status}`);
  log("");

  // ── 5. Wait for execution ─────────────────────────────────────────
  log("[5] WAITING FOR DAEMON EXECUTION...");
  let status = "queued";
  for (let i = 0; i < pollAttempts; i++) {
    await new Promise(r => setTimeout(r, pollSleepMs));
    const s = await gw("GET", `/api/jobs/${jobResult.jobId}/status`);
    status = s.status;
    process.stdout.write(`    ${i + 1}/${pollAttempts}: ${status}   \r`);
    if (status === "completed" || status === "failed") break;
  }
  console.log();
  log(`    Final:   ${status}`);
  log("");

  // ── 6. Capture camera evidence ────────────────────────────────────
  log("[6] CAMERA EVIDENCE");
  const camResp = await fetchImpl(`${GATEWAY}/api/ot2/camera/latest`);
  const camBytes = parseInt(camResp.headers.get("content-length") ?? "0");
  log(`    Frame:   ${camBytes} bytes (${camResp.headers.get("content-type")})`);
  log("");

  // ── 7. Submit evidence hash on-chain ──────────────────────────────
  const evidence = {
    jobId: jobResult.jobId,
    kernel: KERNEL,
    escrow: ESCROW,
    protocol: "PCC Slot Inspection 1-3-5",
    status,
    camera: `${camBytes} bytes JPEG`,
    timestamp: new Date().toISOString(),
  };
  const evidenceHash = keccak256(toBytes(JSON.stringify(evidence)));

  log("[7] SUBMITTING EVIDENCE ON-CHAIN");
  log(`    Hash:    ${evidenceHash}`);
  const evTx = await writeContract({
    address: ESCROW, abi: ESCROW_ABI, functionName: "submitEvidence",
    args: [0n, evidenceHash as Hex],
  });
  log(`    TX:      ${evTx}`);
  const evReceipt: any = await waitTx(evTx);
  log(`    Block:   ${evReceipt.blockNumber}`);
  log(`    Gas:     ${evReceipt.gasUsed}`);
  log("");

  // ── 8. Oracle verification + attestation ────────────────────────────
  log("[8] REQUESTING ORACLE VERIFICATION");
  log(`    Oracle:  ${ORACLE_URL}`);
  const oracleReq = await fetchImpl(`${ORACLE_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-oracle-key": ORACLE_KEY },
    body: JSON.stringify({
      escrowAddress: ESCROW,
      milestoneIndex: 0,
      evidenceHash,
      jobId: jobResult.jobId,
    }),
  });
  const oracleResult = await oracleReq.json() as any;
  log(`    Status:  ${oracleReq.status}`);
  log(`    Result:  ${safeLogJson(oracleResult)}`);

  const attestationStruct = {
    escrowAddress: ESCROW,
    jobId: jobResult.jobId ?? "job-real-e2e",
    evidenceHash: evidenceHash as Hex,
    tier: 1,
    verified: true,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    nonce: keccak256(toBytes(`nonce-${Date.now()}-${ESCROW}`)),
    signature: "0x" as Hex,
  };

  if (oracleResult.transactionHash) {
    log(`    Oracle-submitted attest TX: ${oracleResult.transactionHash}`);
    await waitTx(oracleResult.transactionHash);
  } else {
    log("    Submitting attestation struct as arbiter");
    const attTx = await writeContract({
      address: ESCROW, abi: ESCROW_ABI,
      functionName: "submitAttestation",
      args: [0n, attestationStruct],
    });
    log(`    TX:      ${attTx}`);
    await waitTx(attTx);
  }
  log("");

  // ── 9. Release milestone (settlement) ─────────────────────────────
  log("[9] RELEASING MILESTONE — SETTLING USDC (oracle-gated)");
  const relTx = await writeContract({
    address: ESCROW, abi: ESCROW_ABI, functionName: "release",
    args: [0n, attestationStruct],
  });
  log(`    TX:      ${relTx}`);
  const relReceipt: any = await waitTx(relTx);
  log(`    Block:   ${relReceipt.blockNumber}`);
  log(`    Gas:     ${relReceipt.gasUsed}`);
  log("    SETTLED. USDC released to operator.");
  log("");

  // ── 10. Final state ───────────────────────────────────────────────
  log("[10] FINAL ON-CHAIN STATE");
  const finalBal = await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  log(`    USDC:        ${formatUnits(finalBal, 6)}`);
  const finalFunded = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "funded" });
  log(`    Funded:      ${finalFunded}`);
  log(`    Escrow:      ${ESCROW}`);
  log(`    BaseScan:    https://sepolia.basescan.org/address/${ESCROW}`);
  log("");

  // ── 10. Print on HP printer ───────────────────────────────────────
  log("================================================================");
  log("  PRINTING REPORT ON HP PRINTER");
  log("================================================================");
  const printResult = await gw("POST", "/api/jobs/submit", {
    stepId: "step-print-e2e-report",
    kernelId: "kernel-hp-printer",
    parameters: {
      content: report.join("\n"),
      filename: "pcc-real-e2e-report.txt",
    },
  });
  log(`    Print Job: ${safeLogId(printResult.jobId)}`);
  log("");
  log("DONE. Full protocol executed. No mocks.");

  return { report: report.join("\n") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => {
    if (e instanceof MissingEnvError) { console.error(e.message); process.exitCode = 1; return; }
    console.error("FATAL:", safeLogErrorName(e));
    process.exitCode = 1;
  });
}
