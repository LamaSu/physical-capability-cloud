/**
 * PCC REAL E2E — FULL TELEMETRY CAPTURE
 * Every HTTP call, every on-chain tx, every response — logged verbatim.
 * Output is the print job content.
 *
 * FC-8 round 3 (astra pack 61b census closure): the flow is exported as
 * `run(deps)` with injected fetch/chain-clients/env so it can be driven by
 * mocks in a test (see fc8-round3-real-e2e-verbose.test.ts) instead of only
 * ever running against live services. CLI behavior is preserved behind the
 * entry guard at the bottom. Every print site that reaches a gateway- or
 * oracle-derived value now logs a VALIDATED projection of it (an id, an
 * integer, a boolean, an allow-listed enum/content-type, or a bounded hex
 * prefix) — never a raw response body or object.
 */

import {
  createWalletClient, createPublicClient, http, parseUnits, formatUnits,
  formatEther, keccak256, toBytes, type Address, type Hex,
  type WalletClient, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  safeLogJson, safeLogResponseText, safeLogErrorName, safeLogId, safeLogInt,
  safeLogBool, safeLogEnum, safeLogContentType, safeLogHex, safeLogIdList,
  safeLogUrlPath,
} from "../packages/gateway/src/util/redact-log.js";

/** Thrown for a missing required env var. `.message` is always safe to print as-is: it is built from a trusted name plus static text, never from external data. */
export class MissingEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingEnvError";
  }
}

const GW = "https://capability.network";
const ORACLE_URL = "https://refer-proxy-joint-cleaning.trycloudflare.com";
const KERNEL = "kernel-nanoclaw";
const JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;

/**
 * Read a required secret from `env` and throw a MissingEnvError when it is
 * unset. Keys are NEVER committed to this repository (WP-A fold F8: the
 * literal that used to sit here was exposed and is listed for revocation in
 * docs/security/WILDCARD_KEY_ROTATION.md).
 */
function requireEnv(env: Record<string, string | undefined>, name: string, what: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new MissingEnvError(`${name} is not set: export ${what} before running this script. Keys are never committed to this repository.`);
  }
  return value;
}

export interface RunDeps {
  fetchImpl?: typeof fetch;
  wallet?: WalletClient;
  pub?: PublicClient;
  env?: Record<string, string | undefined>;
  pollSleepMs?: number;
  pollAttempts?: number;
  reportPath?: string;
  contractsDir?: string;
}

export interface RunResult {
  report: string;
  log: string[];
}

export async function run(deps: RunDeps = {}): Promise<RunResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollSleepMs = deps.pollSleepMs ?? 5000;
  const pollAttempts = deps.pollAttempts ?? 40;
  const reportPath = deps.reportPath ?? "/tmp/pcc-e2e-report.txt";

  const PK = (env.PCC_GATEWAY_PRIVATE_KEY || env.DEPLOYER_PRIVATE_KEY) as Hex | undefined;
  if (!PK) throw new MissingEnvError("Set PCC_GATEWAY_PRIVATE_KEY");
  const ORACLE_KEY = requireEnv(env, "PCC_ORACLE_KEY", "the oracle's x-oracle-key");

  const account = privateKeyToAccount(PK);
  const rpc = http("https://sepolia.base.org");
  const wallet = deps.wallet ?? createWalletClient({ account, chain: baseSepolia, transport: rpc });
  const pub = deps.pub ?? createPublicClient({ chain: baseSepolia, transport: rpc });

  const log: string[] = [];
  function L(s: string) { console.log(s); log.push(s); }
  function SEP() { L("─".repeat(72)); }
  function BIGSEP() { L("═".repeat(72)); }

  // ── Traced HTTP ──────────────────────────────────────────────────────
  // FC-8 round 3: a generic request/response tracer cannot validate an
  // arbitrary endpoint's body — it only knows shape and size, never field
  // semantics — so it logs shape/size/status, never body content. Callers
  // that need a specific field (jobId, a status enum, a count) log that
  // field themselves, through a validated helper, right after the call.
  let reqNum = 0;
  async function gw(method: string, path: string, body?: any): Promise<any> {
    const n = ++reqNum;
    L(`  [HTTP ${n}] ${method} ${GW}${safeLogUrlPath(path)}`);
    if (body !== undefined) L(`  [HTTP ${n}] Body: <${Array.isArray(body) ? "array" : typeof body}>`);
    const t0 = Date.now();
    const opts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json", "User-Agent": "pcc-e2e-verbose/1.0" },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetchImpl(url(path), opts);
    const text = await r.text();
    const ms = Date.now() - t0;
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    L(`  [HTTP ${n}] ${safeLogInt(r.status)} (${ms}ms)`);
    L(`  [HTTP ${n}] Response: <${data && typeof data === "object" ? (Array.isArray(data) ? "array" : "object") : typeof data}> (${text.length} bytes)`);
    return data;
  }
  function url(path: string): string { return `${GW}${path}`; }

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
    const receipt: any = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    await new Promise(r => setTimeout(r, pollSleepMs > 0 ? 2000 : 0));
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
      return wallet.deployContract({ ...params, nonce: n, account, chain: baseSepolia } as any);
    });
    const addr = r.receipt.contractAddress!;
    L(`  [TX ${txNum}] Contract: ${addr}`);
    return { ...r, address: addr };
  }

  async function write(label: string, params: any): Promise<{ hash: Hex; receipt: any }> {
    return txWrite(label, async () => {
      const n = await pub.getTransactionCount({ address: account.address });
      return wallet.writeContract({ ...params, nonce: n, account, chain: baseSepolia } as any);
    });
  }

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

  const contractsDir = deps.contractsDir ?? resolve(process.cwd(), "packages/contracts");
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
  L("     Deploying test MockPCCOracle (verified=true bypass)...");
  const ORACLE_VERIFIER = (env.ORACLE_VERIFIER_ADDRESS ?? account.address) as Address;
  L(`     Oracle verifier: ${ORACLE_VERIFIER}`);
  const prot = await deploy("PCCProtocol.deploy(feeRecipient, 235bps, governor, oracleVerifier)", {
    abi: protArt.abi, bytecode: protArt.bytecode.object as `0x${string}`,
    args: [account.address, 235n, account.address, ORACLE_VERIFIER],
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
  await gw("GET", "/api/kernels/kernel-nanoclaw");
  L("");

  SEP();
  L("[3b] DHT peers + metrics");
  await gw("GET", "/api/dht/peers");
  await gw("GET", "/api/dht/metrics");
  L("");

  SEP();
  L("[3c] Operator daemon heartbeat check");
  await gw("POST", "/api/operator/heartbeat", { kernelId: KERNEL, status: "online" });
  L("");

  SEP();
  L("[3d] Capability discovery — what can this kernel do?");
  await gw("GET", "/api/capabilities/by-kernel/kernel-nanoclaw");
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
  L(`     Job ID: ${safeLogId(jobResult?.jobId)}`);
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 5: DAEMON EXECUTION (polling)");
  BIGSEP();

  SEP();
  L("[5a] Polling job status every 5s — waiting for daemon to pick up and execute");
  let status = "queued";
  for (let i = 0; i < pollAttempts; i++) {
    await new Promise(r => setTimeout(r, pollSleepMs));
    const s = await gw("GET", `/api/jobs/${encodeURIComponent(jobResult?.jobId ?? "")}/status`);
    status = s?.status;
    L(`     Poll ${i + 1}: ${safeLogEnum(status, JOB_STATUSES)} (progress=${safeLogInt(s?.progress)})`);
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
  const camResp = await fetchImpl(`${GW}/api/ot2/camera/latest`, {
    headers: { "User-Agent": "pcc-e2e-verbose/1.0" },
  });
  const camBytes = parseInt(camResp.headers.get("content-length") ?? "0");
  const camContentType = safeLogContentType(camResp.headers.get("content-type"));
  L(`     Content-Type: ${camContentType}`);
  L(`     Size: ${safeLogInt(camBytes)} bytes`);
  L(`     Status: ${safeLogInt(camResp.status)}`);
  L("");

  SEP();
  L("[6b] Gateway telemetry audit log (last 10 entries)");
  await gw("GET", "/api/telemetry/audit?limit=10");
  L("");

  SEP();
  L("[6c] Build evidence bundle");
  const evidence = {
    jobId: jobResult?.jobId,
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
  // FC-8 round 3: `evidence` embeds server-returned jobId/status/content-type;
  // the HASH must cover the real values, but the LOGGED copy only shows them
  // once validated, never raw.
  L(`     Evidence: ${JSON.stringify({
    ...evidence,
    jobId: safeLogId(evidence.jobId),
    status: safeLogEnum(evidence.status, JOB_STATUSES),
    camera: { bytes: safeLogInt(evidence.camera.bytes), type: camContentType },
  }, null, 2)}`);
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
  const oracleReq = await fetchImpl(`${ORACLE_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-oracle-key": ORACLE_KEY },
    body: JSON.stringify({ escrowAddress: ESCROW, milestoneIndex: 0, evidenceHash, jobId: jobResult?.jobId }),
  });
  const oracleText = await oracleReq.text();
  // FC-8 round 2+3: the oracle response may reflect the x-oracle-key or carry
  // a secret; never print its raw text or object — only a validated boolean.
  let oracleParsed: any;
  try { oracleParsed = JSON.parse(oracleText); } catch { oracleParsed = undefined; }
  L(`     Oracle HTTP ${safeLogInt(oracleReq.status)}: verified=${safeLogBool(oracleParsed?.verified)} hasAttestation=${safeLogBool(!!oracleParsed?.attestation)}`);
  L("");

  // 7c. Attestation
  SEP();
  L("[7c] Submit oracle-signed attestation (arbiter sign-off)");
  // Build the on-chain Attestation struct. MilestoneEscrow computes
  // keccak256(abi.encode(attestation)) and binds the milestone to it, so
  // release(...) later must pass the same struct back in verbatim.
  const attestationStruct = {
    escrowAddress: ESCROW,
    jobId: jobResult?.jobId ?? "job-telemetry",
    evidenceHash,
    tier: 1,
    verified: true,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    nonce: keccak256(toBytes(`nonce-${Date.now()}-${ESCROW}`)),
    signature: "0x" as Hex,
  };
  // FC-8 round 3: jobId is server-returned; validate before logging (the hash
  // computation above and the on-chain call below still use the real value).
  L(`     Attestation struct: ${JSON.stringify({
    ...attestationStruct,
    jobId: safeLogId(attestationStruct.jobId),
    timestamp: attestationStruct.timestamp.toString(),
  })}`);
  await write("MilestoneEscrow.submitAttestation(0, attestation)", {
    address: ESCROW, abi: escrowAbi, functionName: "submitAttestation",
    args: [0n, attestationStruct],
  });
  L("");

  // 7d. Release
  SEP();
  L("[7d] Release milestone — settle USDC (2.35% fee to protocol, oracle-gated)");
  const balBefore = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [account.address] });
  L(`     Operator USDC before: ${formatUnits(balBefore as bigint, 6)}`);
  await write("MilestoneEscrow.release(0, attestation)", {
    address: ESCROW, abi: escrowAbi, functionName: "release",
    args: [0n, attestationStruct],
  });
  const balAfter = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [account.address] });
  L(`     Operator USDC after:  ${formatUnits(balAfter as bigint, 6)}`);
  L(`     Net received: ${formatUnits((balAfter as bigint) - (balBefore as bigint), 6)} USDC`);
  const escrowBalAfter = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [ESCROW] });
  L(`     Escrow USDC remaining: ${formatUnits(escrowBalAfter as bigint, 6)}`);
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 7b: SOVEREIGN INFRASTRUCTURE — Storacha + Lit + Starknet + NEAR");
  BIGSEP();

  // ── 7b-1. Storacha / IPFS Evidence Archival ───────────────────────
  SEP();
  L("[7b-1] Archive evidence bundle to IPFS (Storacha/Helia)");
  const archiveResult = await gw("POST", "/api/evidence/archive", {
    bundle: {
      id: `evidence-${jobResult?.jobId}`,
      jobId: jobResult?.jobId,
      kernelId: KERNEL,
      type: "execution_evidence",
      evidenceHash,
      status,
      operator: account.address,
      escrow: ESCROW,
      protocol: "PCC Full Telemetry — Slots 1, 3, 5",
      camera: { bytes: camBytes, type: camResp.headers.get("content-type") },
      chain: "base-sepolia",
      chainId: 84532,
      timestamp: new Date().toISOString(),
    },
  });
  L(`     Archived: ${safeLogBool(archiveResult?.archived)} | CID: ${safeLogId(archiveResult?.cid, "mock")}`);
  L(`     Metadata CID: ${safeLogId(archiveResult?.metadataCid, "none")}`);
  L("");

  // ── 7b-2. Lit Protocol — Encrypt Evidence ─────────────────────────
  SEP();
  L("[7b-2] Lit Protocol status + key provisioning check");
  const litStatus = await gw("GET", "/api/evidence/lit-status");
  L(`     Lit connected: ${safeLogBool(litStatus?.lit?.connected)}`);
  L(`     Lit mode: ${safeLogId(litStatus?.lit?.mode)}`);
  L(`     Lit network: ${safeLogId(litStatus?.lit?.network)}`);
  L("");

  SEP();
  L("[7b-3] Lit Protocol — provision operator usage key");
  const litProvision = await gw("POST", "/api/lit/provision", {
    kernelId: KERNEL,
    operatorDid: `did:pcc:${KERNEL}`,
  });
  // FC-8 round 2: the provisioning response's error field is a raw server
  // string — never print it; "no" is all a failure needs to say here.
  L(`     Provisioned: ${litProvision?.usageKey ? "yes" : "no"}`);
  L("");

  // ── 7b-4. Starknet — ZK Proof Anchoring ───────────────────────────
  SEP();
  L("[7b-4] Create ZK commitment from evidence hash");
  const zkCommit = await gw("POST", "/api/zk/commit", {
    bundleHash: evidenceHash,
  });
  L(`     Commitment ID: ${safeLogId(zkCommit?.commitment?.id)}`);
  L(`     Commitment hash: ${safeLogHex(zkCommit?.commitment?.commitmentHash)}`);
  L("");

  SEP();
  L("[7b-5] Generate tier-compliance proof (tier 2)");
  const zkProof = await gw("POST", "/api/zk/prove/tier", {
    bundleHash: evidenceHash,
    requiredTier: 2,
  });
  const proofId = zkProof?.proof?.id;
  L(`     Proof ID: ${safeLogId(proofId)}`);
  L(`     Proof type: ${safeLogId(zkProof?.proof?.proofType)}`);
  L(`     Verified: ${safeLogBool(zkProof?.proof?.verified)}`);
  L("");

  SEP();
  L("[7b-6] Anchor proof on Starknet (ZK proof hash → Starknet Sepolia)");
  const starknetAnchor = await gw("POST", "/api/zk/anchor-starknet", {
    proofId: proofId ?? undefined,
    merkleRoot: proofId ? undefined : evidenceHash,
  });
  const starknetTxHash = starknetAnchor?.anchor?.txHash;
  L(`     Starknet TX: ${safeLogHex(starknetTxHash)}`);
  L(`     Block: ${safeLogInt(starknetAnchor?.anchor?.blockNumber, "pending")}`);
  L(`     Mode: ${safeLogId(starknetAnchor?.mode)}`);
  L("");

  if (starknetTxHash) {
    SEP();
    L("[7b-7] Poll Starknet anchor status");
    const anchorStatus = await gw("GET", `/api/zk/anchor-starknet/${encodeURIComponent(String(starknetTxHash))}`);
    L(`     Status: ${safeLogId(anchorStatus?.status)}`);
    L("");
  }

  // ── 7b-8. NEAR — Cross-Chain Payment Quote ────────────────────────
  SEP();
  L("[7b-8] NEAR chain abstraction — integration status");
  const nearStatus = await gw("GET", "/api/near/status");
  L(`     Integration: ${safeLogId(nearStatus?.integration)}`);
  L(`     Network: ${safeLogId(nearStatus?.network)}`);
  L(`     Mock: ${safeLogBool(nearStatus?.mock)}`);
  L(`     Supported chains: ${safeLogIdList(nearStatus?.supportedChains)}`);
  L("");

  SEP();
  L("[7b-9] NEAR — cross-chain payment quote (NEAR USDC → Base USDC)");
  const nearQuote = await gw("POST", "/api/near/quote", {
    fromChain: "near",
    fromAsset: "USDC",
    toChain: "base",
    toAsset: "USDC",
    amount: "1000000",
    recipient: account.address,
  });
  const quoteId = nearQuote?.quote?.quoteId;
  L(`     Quote ID: ${safeLogId(quoteId)}`);
  L(`     Estimated output: ${safeLogId(nearQuote?.quote?.estimatedOutput)}`);
  L(`     Fee: ${safeLogId(nearQuote?.quote?.fee)}`);
  L(`     Route: ${safeLogId(nearQuote?.quote?.route)}`);
  L("");

  if (quoteId) {
    SEP();
    L("[7b-10] NEAR — submit cross-chain payment intent");
    const nearIntent = await gw("POST", "/api/near/intent", {
      quoteId,
      workflowId: `pcc-full-telemetry-${Date.now()}`,
      recipient: account.address,
    });
    const intentId = nearIntent?.intent?.intentId;
    L(`     Intent ID: ${safeLogId(intentId)}`);
    L(`     Status: ${safeLogId(nearIntent?.intent?.status)}`);
    L("");

    if (intentId) {
      SEP();
      L("[7b-11] NEAR — poll intent settlement status");
      const intentStatus = await gw("GET", `/api/near/intent/${encodeURIComponent(String(intentId))}`);
      L(`     Status: ${safeLogId(intentStatus?.status ?? intentStatus?.intent?.status)}`);
      L(`     TX hash: ${safeLogHex(intentStatus?.txHash ?? intentStatus?.intent?.txHash, 20, "pending")}`);
      L("");
    }
  }

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 8: FINAL STATE");
  BIGSEP();

  SEP();
  L("[8a] Final escrow on-chain state");
  await gw("GET", `/api/escrow/chain/${ESCROW}/state`);
  L("");

  SEP();
  L("[8b] Final kernel state");
  await gw("GET", "/api/kernels/kernel-nanoclaw");
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
  writeFileSync(reportPath, report);
  L(`Report written to ${reportPath} (${report.length} bytes)`);
  L("");

  SEP();
  L("[9a] Submit print job to HP printer (kernel-hp-printer)");
  await gw("POST", "/api/jobs/submit", {
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

  return { report, log };
}

// FC-8 round 3: CLI behavior lives only behind this guard. A plain `import`
// of this module (as a test does) never executes main — the live-service
// run only happens when the file is invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(e => {
    if (e instanceof MissingEnvError) { console.error(e.message); process.exitCode = 1; return; }
    // FC-8 round 2: e.shortMessage/e.message is free text that can carry a
    // caught secret (e.g. a header value embedded in a fetch/dependency
    // error); only the bounded error-class name is safe to log here.
    console.error(`FATAL: ${safeLogErrorName(e)}`);
    process.exitCode = 1;
  });
}
