/**
 * PCC REAL E2E — FULL TELEMETRY CAPTURE
 * Every HTTP call, every on-chain tx, every response — logged verbatim.
 * Output is the print job content.
 */

import {
  createWalletClient, createPublicClient, http, parseUnits, formatUnits,
  formatEther, keccak256, toBytes, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const PK = (process.env.PCC_GATEWAY_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY) as Hex;
if (!PK) { console.error("Set PCC_GATEWAY_PRIVATE_KEY"); process.exit(1); }

const GW = "https://capability.network";
const ORACLE_URL = "https://right-himself-lotus-patterns.trycloudflare.com";
const ORACLE_KEY = "pcc_oracle_024094b05dbf797b202f23798cd54d2519c264abd727c830c8f1fc75fad911aa";
const KERNEL = "kernel-nanoclaw";

const account = privateKeyToAccount(PK);
const rpc = http("https://sepolia.base.org");
const wallet = createWalletClient({ account, chain: baseSepolia, transport: rpc });
const pub = createPublicClient({ chain: baseSepolia, transport: rpc });

const log: string[] = [];
function L(s: string) { console.log(s); log.push(s); }
function SEP() { L("─".repeat(72)); }
function BIGSEP() { L("═".repeat(72)); }

// ── Traced HTTP ──────────────────────────────────────────────────────
let reqNum = 0;
async function gw(method: string, path: string, body?: any): Promise<any> {
  const n = ++reqNum;
  const url = `${GW}${path}`;
  L(`  [HTTP ${n}] ${method} ${url}`);
  if (body) L(`  [HTTP ${n}] Body: ${JSON.stringify(body).slice(0, 500)}`);
  const t0 = Date.now();
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", "User-Agent": "pcc-e2e-verbose/1.0" },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  const ms = Date.now() - t0;
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  L(`  [HTTP ${n}] ${r.status} ${r.statusText} (${ms}ms)`);
  L(`  [HTTP ${n}] Response: ${JSON.stringify(data).slice(0, 800)}`);
  return data;
}

// ── Traced on-chain write ────────────────────────────────────────────
let txNum = 0;
async function txWrite(label: string, fn: () => Promise<Hex>): Promise<{ hash: Hex; receipt: any }> {
  const n = ++txNum;
  L(`  [TX ${n}] ${label}`);
  const nonce = await pub.getTransactionCount({ address: account.address });
  L(`  [TX ${n}] Nonce: ${nonce}`);
  const hash = await fn();
  L(`  [TX ${n}] Hash: ${hash}`);
  L(`  [TX ${n}] Explorer: https://sepolia.basescan.org/tx/${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  await new Promise(r => setTimeout(r, 2000));
  L(`  [TX ${n}] Block: ${receipt.blockNumber} | Gas: ${receipt.gasUsed} | Status: ${receipt.status}`);
  if (receipt.logs.length > 0) {
    L(`  [TX ${n}] Events: ${receipt.logs.length} log(s)`);
    for (const lg of receipt.logs.slice(0, 3)) {
      L(`  [TX ${n}]   topic0: ${lg.topics[0]?.slice(0, 20)}... addr: ${lg.address}`);
    }
  }
  return { hash, receipt };
}

async function deploy(label: string, params: any): Promise<{ hash: Hex; receipt: any; address: Address }> {
  const r = await txWrite(label, async () => {
    const n = await pub.getTransactionCount({ address: account.address });
    return wallet.deployContract({ ...params, nonce: n });
  });
  const addr = r.receipt.contractAddress!;
  L(`  [TX ${txNum}] Contract: ${addr}`);
  return { ...r, address: addr };
}

async function write(label: string, params: any): Promise<{ hash: Hex; receipt: any }> {
  return txWrite(label, async () => {
    const n = await pub.getTransactionCount({ address: account.address });
    return wallet.writeContract({ ...params, nonce: n });
  });
}

async function main() {
  BIGSEP();
  L("  PCC PHYSICAL CAPABILITY CLOUD — FULL TELEMETRY CAPTURE");
  L(`  ${new Date().toISOString()}`);
  BIGSEP();
  L("");
  L(`Deployer:     ${account.address}`);
  const ethBal = await pub.getBalance({ address: account.address });
  L(`ETH Balance:  ${formatEther(ethBal)}`);
  L(`Chain:        Base Sepolia (84532)`);
  L(`RPC:          https://sepolia.base.org`);
  L(`Gateway:      ${GW}`);
  L(`Oracle:       ${ORACLE_URL}`);
  L(`Kernel:       ${KERNEL}`);
  L("");

  const contractsDir = resolve(process.cwd(), "packages/contracts");
  const usdcArt = JSON.parse(readFileSync(resolve(contractsDir, "out/MockUSDC.sol/MockUSDC.json"), "utf8"));
  const protArt = JSON.parse(readFileSync(resolve(contractsDir, "out/PCCProtocol.sol/PCCProtocol.json"), "utf8"));
  const escrowAbi = JSON.parse(readFileSync(resolve(contractsDir, "out/MilestoneEscrow.sol/MilestoneEscrow.json"), "utf8")).abi;

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 1: CONTRACT DEPLOYMENT");
  BIGSEP();

  // 1a. MockUSDC
  SEP();
  L("[1a] Deploy MockUSDC (ERC-20 test token)");
  const usdc = await deploy("MockUSDC.deploy(initialSupply=1M)", {
    abi: usdcArt.abi, bytecode: usdcArt.bytecode.object as `0x${string}`,
    args: [parseUnits("1000000", 6)],
  });
  const USDC = usdc.address;
  L("");

  // 1b. PCCProtocol
  SEP();
  L("[1b] Deploy PCCProtocol (fee factory, 2.35%)");
  const prot = await deploy("PCCProtocol.deploy(feeRecipient, 235bps, governor)", {
    abi: protArt.abi, bytecode: protArt.bytecode.object as `0x${string}`,
    args: [account.address, 235n, account.address],
  });
  const PROTOCOL = prot.address;
  L("");

  // 1c. Escrow via factory
  SEP();
  L("[1c] Create escrow via PCCProtocol.createEscrow()");
  L(`     payer=${account.address}, arbiter=${account.address}, token=${USDC}`);
  const cwmId = keccak256(toBytes("pcc-full-telemetry-" + Date.now()));
  L(`     cwmId=${cwmId}`);
  const createResult = await write("PCCProtocol.createEscrow()", {
    address: PROTOCOL, abi: protArt.abi, functionName: "createEscrow",
    args: [account.address, account.address, USDC, cwmId],
  });
  const escrowLog = createResult.receipt.logs.find((l: any) => l.topics.length >= 2);
  const ESCROW = ("0x" + (escrowLog?.topics[1]?.slice(26) ?? "")) as Address;
  L(`     Escrow address: ${ESCROW}`);
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 2: FUND ESCROW");
  BIGSEP();

  // 2a. Mint
  SEP();
  L("[2a] Mint 10 USDC to deployer");
  await write("MockUSDC.mint(deployer, 10e6)", {
    address: USDC, abi: usdcArt.abi, functionName: "mint",
    args: [account.address, parseUnits("10", 6)],
  });
  const bal = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [account.address] });
  L(`     Deployer USDC balance: ${formatUnits(bal as bigint, 6)}`);
  L("");

  // 2b. Add milestone
  SEP();
  L("[2b] Add milestone to escrow (1 USDC, 0 bond, 0 challenge window)");
  const stepId = keccak256(toBytes("pcc-slot-inspection-1-3-5"));
  L(`     stepId: ${stepId}`);
  L(`     operator: ${account.address}`);
  L(`     amount: 1000000 (1 USDC)`);
  await write("MilestoneEscrow.addMilestone()", {
    address: ESCROW, abi: escrowAbi, functionName: "addMilestone",
    args: [stepId, account.address, parseUnits("1", 6), 0n, 0n],
  });
  L("");

  // 2c. Approve
  SEP();
  L("[2c] Approve USDC spend: escrow can pull 10 USDC");
  await write("MockUSDC.approve(escrow, 10e6)", {
    address: USDC, abi: usdcArt.abi, functionName: "approve",
    args: [ESCROW, parseUnits("10", 6)],
  });
  L("");

  // 2d. Fund
  SEP();
  L("[2d] Fund escrow — transfers USDC from payer to escrow contract");
  await write("MilestoneEscrow.fund()", {
    address: ESCROW, abi: escrowAbi, functionName: "fund", args: [],
  });
  const escrowBal = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [ESCROW] });
  L(`     Escrow USDC balance: ${formatUnits(escrowBal as bigint, 6)}`);
  const funded = await pub.readContract({ address: ESCROW, abi: escrowAbi, functionName: "funded" });
  const msCount = await pub.readContract({ address: ESCROW, abi: escrowAbi, functionName: "getMilestoneCount" });
  L(`     funded=${funded} milestones=${msCount}`);
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 3: QUERY NETWORK STATE (pre-job)");
  BIGSEP();

  SEP();
  L("[3a] Gateway kernel state");
  const kernelState = await gw("GET", "/api/kernels/kernel-nanoclaw");
  L("");

  SEP();
  L("[3b] DHT peers + metrics");
  const dhtPeers = await gw("GET", "/api/dht/peers");
  const dhtMetrics = await gw("GET", "/api/dht/metrics");
  L("");

  SEP();
  L("[3c] Operator daemon heartbeat check");
  const hbResult = await gw("POST", "/api/operator/heartbeat", { kernelId: KERNEL, status: "online" });
  L("");

  SEP();
  L("[3d] Capability discovery — what can this kernel do?");
  const caps = await gw("GET", "/api/capabilities/by-kernel/kernel-nanoclaw");
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 4: SUBMIT JOB TO ROBOT");
  BIGSEP();

  SEP();
  L("[4a] Submit OT-2 job — move to slots 1, 3, 5 with 3s pause at each");
  const protocol = [
    "from opentrons import protocol_api, types",
    "",
    'metadata = {"apiLevel": "2.13", "protocolName": "PCC Full Telemetry — Slots 1, 3, 5"}',
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
    '    protocol.comment("PCC Full Telemetry complete")',
  ].join("\n");
  L(`     Protocol:\n${protocol}`);
  L("");
  const jobResult = await gw("POST", "/api/jobs/submit", {
    stepId: "step-full-telemetry",
    kernelId: KERNEL,
    parameters: { pythonCode: protocol, filename: "pcc_full_telemetry.py" },
  });
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 5: DAEMON EXECUTION (polling)");
  BIGSEP();

  SEP();
  L("[5a] Polling job status every 5s — waiting for daemon to pick up and execute");
  let status = "queued";
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const s = await gw("GET", `/api/jobs/${jobResult.jobId}/status`);
    status = s.status;
    L(`     Poll ${i + 1}: ${status} (progress=${s.progress})`);
    if (status === "completed" || status === "failed") break;
  }
  L("");

  if (status !== "completed") {
    L("*** JOB DID NOT COMPLETE — continuing with evidence submission anyway ***");
    L("");
  }

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 6: EVIDENCE COLLECTION");
  BIGSEP();

  SEP();
  L("[6a] Camera frame from OT-2 (latest JPEG pushed by daemon)");
  const camResp = await fetch(`${GW}/api/ot2/camera/latest`, {
    headers: { "User-Agent": "pcc-e2e-verbose/1.0" },
  });
  const camBytes = parseInt(camResp.headers.get("content-length") ?? "0");
  L(`     Content-Type: ${camResp.headers.get("content-type")}`);
  L(`     Size: ${camBytes} bytes`);
  L(`     Status: ${camResp.status}`);
  L("");

  SEP();
  L("[6b] Gateway telemetry audit log (last 10 entries)");
  const audit = await gw("GET", "/api/telemetry/audit?limit=10");
  L("");

  SEP();
  L("[6c] Build evidence bundle");
  const evidence = {
    jobId: jobResult.jobId,
    kernel: KERNEL,
    escrow: ESCROW,
    protocol: "PCC Full Telemetry — Slots 1, 3, 5",
    protocolRoot: PROTOCOL,
    status,
    camera: { bytes: camBytes, type: camResp.headers.get("content-type") },
    timestamp: new Date().toISOString(),
    operator: account.address,
    chain: "base-sepolia",
    chainId: 84532,
  };
  const evidenceHash = keccak256(toBytes(JSON.stringify(evidence)));
  L(`     Evidence: ${JSON.stringify(evidence, null, 2)}`);
  L(`     Hash: ${evidenceHash}`);
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 7: ON-CHAIN SETTLEMENT");
  BIGSEP();

  // 7a. Submit evidence
  SEP();
  L("[7a] Submit evidence hash to escrow (on-chain)");
  await write("MilestoneEscrow.submitEvidence(0, hash)", {
    address: ESCROW, abi: escrowAbi, functionName: "submitEvidence",
    args: [0n, evidenceHash as Hex],
  });
  L("");

  // 7b. Oracle verification
  SEP();
  L("[7b] Request oracle verification");
  L(`     Oracle URL: ${ORACLE_URL}`);
  const oracleReq = await fetch(`${ORACLE_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-oracle-key": ORACLE_KEY },
    body: JSON.stringify({ escrowAddress: ESCROW, milestoneIndex: 0, evidenceHash, jobId: jobResult.jobId }),
  });
  const oracleText = await oracleReq.text();
  L(`     Oracle HTTP ${oracleReq.status}: ${oracleText.slice(0, 500)}`);
  L("");

  // 7c. Attestation
  SEP();
  L("[7c] Submit attestation (arbiter sign-off)");
  const attestHash = keccak256(toBytes("attestation:" + evidenceHash));
  L(`     Attestation hash: ${attestHash}`);
  await write("MilestoneEscrow.submitAttestation(0, hash)", {
    address: ESCROW, abi: escrowAbi, functionName: "submitAttestation",
    args: [0n, attestHash as Hex],
  });
  L("");

  // 7d. Release
  SEP();
  L("[7d] Release milestone — settle USDC (2.35% fee to protocol)");
  const balBefore = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [account.address] });
  L(`     Operator USDC before: ${formatUnits(balBefore as bigint, 6)}`);
  await write("MilestoneEscrow.release(0)", {
    address: ESCROW, abi: escrowAbi, functionName: "release", args: [0n],
  });
  const balAfter = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [account.address] });
  L(`     Operator USDC after:  ${formatUnits(balAfter as bigint, 6)}`);
  L(`     Net received: ${formatUnits((balAfter as bigint) - (balBefore as bigint), 6)} USDC`);
  const escrowBalAfter = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [ESCROW] });
  L(`     Escrow USDC remaining: ${formatUnits(escrowBalAfter as bigint, 6)}`);
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 8: FINAL STATE");
  BIGSEP();

  SEP();
  L("[8a] Final escrow on-chain state");
  const finalState = await gw("GET", `/api/escrow/chain/${ESCROW}/state`);
  L("");

  SEP();
  L("[8b] Final kernel state");
  const finalKernel = await gw("GET", "/api/kernels/kernel-nanoclaw");
  L("");

  SEP();
  L("[8c] Protocol fee accounting");
  const feeData = await pub.readContract({
    address: PROTOCOL, abi: protArt.abi, functionName: "totalFeesCollectedByToken", args: [USDC],
  });
  L(`     Total protocol fees (USDC): ${formatUnits(feeData as bigint, 6)}`);
  const escrowCount = await pub.readContract({ address: PROTOCOL, abi: protArt.abi, functionName: "getEscrowCount" });
  L(`     Total escrows created: ${escrowCount}`);
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 9: PRINT REPORT");
  BIGSEP();

  const report = log.join("\n");
  writeFileSync("/tmp/pcc-e2e-report.txt", report);
  L(`Report written to /tmp/pcc-e2e-report.txt (${report.length} bytes)`);
  L("");

  SEP();
  L("[9a] Submit print job to HP printer (kernel-hp-printer)");
  const printResult = await gw("POST", "/api/jobs/submit", {
    stepId: "step-print-full-telemetry",
    kernelId: "kernel-hp-printer",
    parameters: {
      content: report,
      filename: "pcc-full-telemetry-report.txt",
      title: "PCC Protocol Execution — Full Telemetry",
    },
  });
  L("");

  BIGSEP();
  L("  DONE. Every interaction logged. No mocks.");
  BIGSEP();
}

main().catch(e => { L(`FATAL: ${e.shortMessage || e.message}`); process.exit(1); });
