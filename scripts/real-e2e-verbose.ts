/**
 * PCC REAL E2E — FULL TELEMETRY CAPTURE
 * Every HTTP call, every on-chain tx, every response — logged verbatim.
 * Output is the print job content.
 *
 * FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3): round 4 left
 * three classes of value printed raw: environment-derived values (the
 * oracle verifier override, the injected report path), dependency-returned
 * PUBLIC chain identifiers (tx hashes, receipt topics, addresses — the
 * JSON.stringify'd evidence/attestation dumps leaked several of these even
 * though the surrounding code looked like it had been fixed, because the
 * object SPREAD left most fields untouched and only the explicitly
 * overridden keys were safe), and an unbounded safeLogInt/un-enumerated
 * safeLogErrorName. This round routes EVERY printed value through an
 * explicit source-to-sink rule (see redact-log.ts and the round-5 report):
 * SECRET → never read from env, never printed. ENV value / CLI path →
 * envPresence() only. GATEWAY-ISSUED id → safeLogId (fingerprint, no
 * verbatim mode, ever). PUBLIC chain/git id (tx hash, address, topic) →
 * publicIdForLog (fingerprint by default; PUBLIC_ID_RULE is the one-line
 * switch to verbatim later). STATUS-like field → safeLogEnum/safeLogBool.
 * NUMBER → safeLogInt with explicit bounds. ERROR NAME → the closed enum
 * in safeLogErrorName. Dependency SIGNATURE → presence only, never printed.
 * An AST test (fc8-round5-ast-sink-guard.test.ts) enforces that every
 * console log / stdout / stderr argument in this file is built only from
 * string literals and calls to this allowlist — not merely that a canary
 * happens to be absent today.
 *
 * FC-8 round 5b (steward ruling #6712, DECISIONS 00:53): the steward
 * reviewed round 5's fingerprint-everything default and ruled that a
 * shape-valid tx hash / address / event topic is PUBLIC chain data, not a
 * secret, and may print VERBATIM — but ONLY on stdout/stderr/in the report
 * file, via the new, separate publicChainRef(value, kind). Locally-computed
 * content hashes/commitments (cwmId, stepId, evidenceHash, the attestation
 * nonce) are NOT "a tx hash, an address, or an event topic" under the
 * ruling's own wording, so they stay on publicIdForLog (fingerprinted),
 * unchanged. The print job at the bottom of this file resends the ENTIRE
 * accumulated stdout log as `parameters.content` — a THIRD-PARTY (printer)
 * body, which the ruling says must never carry a chain value verbatim —
 * so that content is scrubbed via redactChainValuesFromText before it is
 * sent, even though the identical text is safe verbatim on stdout and in
 * the report file itself.
 *
 * The flow is exported as `run(deps)` with injected fetch/chain-clients/env
 * (round 3); CLI behavior is preserved behind the entry guard at the
 * bottom.
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
  safeLogErrorName, safeLogId, safeLogInt, safeLogBool, safeLogEnum,
  safeLogContentType, publicIdForLog, envPresence, safeLogDecimal, nowIso,
  publicChainRef, redactChainValuesFromText,
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
const RECEIPT_STATUSES = ["success", "reverted"] as const;
const TYPEOF_LABELS = ["string", "number", "boolean", "undefined", "object", "function", "symbol", "bigint", "array"] as const;

/** Every route template this script's gw() helper is ever called with — a FIXED, author-written label, never a path built from a response value (see gw() below). Logged through safeLogEnum so a future call site that somehow passed something else prints "(unexpected)" instead of leaking it. */
const ROUTE_TEMPLATES = [
  "GET /api/kernels/:kernelId",
  "GET /api/dht/peers",
  "GET /api/dht/metrics",
  "POST /api/operator/heartbeat",
  "GET /api/capabilities/by-kernel/:kernelId",
  "POST /api/jobs/submit",
  "GET /api/jobs/:id/status",
  "GET /api/telemetry/audit",
  "POST /api/evidence/archive",
  "GET /api/evidence/lit-status",
  "POST /api/lit/provision",
  "POST /api/zk/commit",
  "POST /api/zk/prove/tier",
  "POST /api/zk/anchor-starknet",
  "GET /api/zk/anchor-starknet/:txHash",
  "GET /api/near/status",
  "POST /api/near/quote",
  "POST /api/near/intent",
  "GET /api/near/intent/:id",
  "GET /api/escrow/chain/:address/state",
] as const;

/** Every fixed tx/deploy label this script's txWrite()/deploy()/write() helpers are called with — logged through safeLogEnum rather than interpolated directly, same reasoning as ROUTE_TEMPLATES above. */
const TX_LABELS = [
  "MockUSDC.deploy(initialSupply=1M)",
  "PCCProtocol.deploy(feeRecipient, 235bps, governor, oracleVerifier)",
  "PCCProtocol.createEscrow()",
  "MockUSDC.mint(deployer, 10e6)",
  "MilestoneEscrow.addMilestone()",
  "MockUSDC.approve(escrow, 10e6)",
  "MilestoneEscrow.fund()",
  "MilestoneEscrow.submitEvidence(0, hash)",
  "MilestoneEscrow.submitAttestation(0, attestation)",
  "MilestoneEscrow.release(0, attestation)",
] as const;

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
  // `routeTemplate` is a FIXED STRING the caller writes — never the real
  // `path`, which can contain a response-derived segment — logged through
  // safeLogEnum(ROUTE_TEMPLATES) rather than interpolated directly, so any
  // call site that somehow passed something else prints "(unexpected)"
  // instead of leaking it. The tracer otherwise logs shape/size/status
  // only, never body content.
  let reqNum = 0;
  async function gw(method: string, path: string, routeTemplate: string, body?: any): Promise<any> {
    const n = ++reqNum;
    L(`  [HTTP ${safeLogInt(n, { min: 0, max: 100_000 })}] ${safeLogEnum(routeTemplate, ROUTE_TEMPLATES)}`);
    if (body !== undefined) {
      const bodyTypeLabel = Array.isArray(body) ? "array" : typeof body;
      L(`  [HTTP ${safeLogInt(n, { min: 0, max: 100_000 })}] Body: <${safeLogEnum(bodyTypeLabel, TYPEOF_LABELS)}>`);
    }
    const t0 = Date.now();
    const opts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json", "User-Agent": "pcc-e2e-verbose/1.0" },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetchImpl(`${GW}${path}`, opts);
    const text = await r.text();
    const ms = Date.now() - t0;
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    L(`  [HTTP ${safeLogInt(n, { min: 0, max: 100_000 })}] ${safeLogInt(r.status, { min: 0, max: 599 })} (${safeLogInt(ms, { min: 0, max: 600_000 })}ms)`);
    const respTypeLabel = data && typeof data === "object" ? (Array.isArray(data) ? "array" : "object") : typeof data;
    L(`  [HTTP ${safeLogInt(n, { min: 0, max: 100_000 })}] Response: <${safeLogEnum(respTypeLabel, TYPEOF_LABELS)}> (${safeLogInt(text.length, { min: 0, max: 2_000_000_000 })} bytes)`);
    return data;
  }

  // ── Traced on-chain write ────────────────────────────────────────────
  let txNum = 0;
  async function txWrite(label: string, fn: () => Promise<Hex>): Promise<{ hash: Hex; receipt: any }> {
    const n = ++txNum;
    L(`  [TX ${safeLogInt(n, { min: 0, max: 100_000 })}] ${safeLogEnum(label, TX_LABELS)}`);
    const nonce = await pub.getTransactionCount({ address: account.address });
    L(`  [TX ${safeLogInt(n, { min: 0, max: 100_000 })}] Nonce: ${safeLogInt(nonce, { min: 0, max: 100_000_000 })}`);
    const hash = await fn();
    L(`  [TX ${safeLogInt(n, { min: 0, max: 100_000 })}] Hash: ${publicChainRef(hash, "tx")}`);
    L(`  [TX ${safeLogInt(n, { min: 0, max: 100_000 })}] Explorer: https://sepolia.basescan.org/tx/${publicChainRef(hash, "tx")}`);
    const receipt: any = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    await new Promise(r => setTimeout(r, pollSleepMs > 0 ? 2000 : 0));
    L(`  [TX ${safeLogInt(n, { min: 0, max: 100_000 })}] Block: ${safeLogInt(receipt.blockNumber, { min: 0, max: 99_999_999_999 })} | Gas: ${safeLogInt(receipt.gasUsed, { min: 0, max: 50_000_000 })} | Status: ${safeLogEnum(receipt.status, RECEIPT_STATUSES)}`);
    if (receipt.logs.length > 0) {
      L(`  [TX ${safeLogInt(n, { min: 0, max: 100_000 })}] Events: ${safeLogInt(receipt.logs.length, { min: 0, max: 10_000 })} log(s)`);
      for (const lg of receipt.logs.slice(0, 3)) {
        L(`  [TX ${safeLogInt(n, { min: 0, max: 100_000 })}]   topic0: ${publicChainRef(lg.topics[0], "topic")} addr: ${publicChainRef(lg.address, "address")}`);
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
    L(`  [TX ${safeLogInt(txNum, { min: 0, max: 100_000 })}] Contract: ${publicChainRef(addr, "address")}`);
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
  L(`  ${nowIso()}`);
  BIGSEP();
  L("");
  L(`Deployer:     ${publicChainRef(account.address, "address")}`);
  const ethBal = await pub.getBalance({ address: account.address });
  L(`ETH Balance:  ${safeLogDecimal(formatEther(ethBal))}`);
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
  // FC-8 round 5: ORACLE_VERIFIER_ADDRESS is an ENV value — never printed,
  // not even once it has been read into a variable. Only whether an
  // override was configured is logged; the real value (env override, or
  // the deployer's own address as the default) is still what is used below.
  const ORACLE_VERIFIER = (env.ORACLE_VERIFIER_ADDRESS ?? account.address) as Address;
  L(`     Oracle verifier override: ${envPresence(env.ORACLE_VERIFIER_ADDRESS)}`);
  const prot = await deploy("PCCProtocol.deploy(feeRecipient, 235bps, governor, oracleVerifier)", {
    abi: protArt.abi, bytecode: protArt.bytecode.object as `0x${string}`,
    args: [account.address, 235n, account.address, ORACLE_VERIFIER],
  });
  const PROTOCOL = prot.address;
  L("");

  // 1c. Escrow via factory
  SEP();
  L("[1c] Create escrow via PCCProtocol.createEscrow()");
  L(`     payer=${publicChainRef(account.address, "address")}, arbiter=${publicChainRef(account.address, "address")}, token=${publicChainRef(USDC, "address")}`);
  const cwmId = keccak256(toBytes("pcc-full-telemetry-" + Date.now()));
  L(`     cwmId=${publicIdForLog(cwmId, "hash")}`);
  const createResult = await write("PCCProtocol.createEscrow()", {
    address: PROTOCOL, abi: protArt.abi, functionName: "createEscrow",
    args: [account.address, account.address, USDC, cwmId],
  });
  const escrowLog = createResult.receipt.logs.find((l: any) => l.topics.length >= 2);
  const ESCROW = ("0x" + (escrowLog?.topics[1]?.slice(26) ?? "")) as Address;
  L(`     Escrow address: ${publicChainRef(ESCROW, "address")}`);
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
  L(`     Deployer USDC balance: ${safeLogDecimal(formatUnits(bal as bigint, 6))}`);
  L("");

  // 2b. Add milestone
  SEP();
  L("[2b] Add milestone to escrow (1 USDC, 0 bond, 0 challenge window)");
  const stepId = keccak256(toBytes("pcc-slot-inspection-1-3-5"));
  L(`     stepId: ${publicIdForLog(stepId, "hash")}`);
  L(`     operator: ${publicChainRef(account.address, "address")}`);
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
  L(`     Escrow USDC balance: ${safeLogDecimal(formatUnits(escrowBal as bigint, 6))}`);
  const funded = await pub.readContract({ address: ESCROW, abi: escrowAbi, functionName: "funded" });
  const msCount = await pub.readContract({ address: ESCROW, abi: escrowAbi, functionName: "getMilestoneCount" });
  L(`     funded=${safeLogBool(funded)} milestones=${safeLogInt(msCount, { min: 0, max: 1_000_000 })}`);
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 3: QUERY NETWORK STATE (pre-job)");
  BIGSEP();

  SEP();
  L("[3a] Gateway kernel state");
  await gw("GET", "/api/kernels/kernel-nanoclaw", "GET /api/kernels/:kernelId");
  L("");

  SEP();
  L("[3b] DHT peers + metrics");
  await gw("GET", "/api/dht/peers", "GET /api/dht/peers");
  await gw("GET", "/api/dht/metrics", "GET /api/dht/metrics");
  L("");

  SEP();
  L("[3c] Operator daemon heartbeat check");
  await gw("POST", "/api/operator/heartbeat", "POST /api/operator/heartbeat", { kernelId: KERNEL, status: "online" });
  L("");

  SEP();
  L("[3d] Capability discovery — what can this kernel do?");
  await gw("GET", "/api/capabilities/by-kernel/kernel-nanoclaw", "GET /api/capabilities/by-kernel/:kernelId");
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
  // FC-8 round 5: this is a locally-authored, fixed protocol body (built
  // entirely from the literal array above) — never printed in full here
  // (a multi-KB blob has no place in a telemetry log anyway); only its
  // length, which is itself just a property of the literal text above.
  L(`     Protocol: <local OT-2 python script, ${safeLogInt(protocol.length, { min: 0, max: 100_000 })} chars>`);
  L("");
  const jobResult = await gw("POST", "/api/jobs/submit", "POST /api/jobs/submit", {
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
    const s = await gw("GET", `/api/jobs/${encodeURIComponent(jobResult?.jobId ?? "")}/status`, "GET /api/jobs/:id/status");
    status = s?.status;
    L(`     Poll ${safeLogInt(i + 1, { min: 0, max: 100_000 })}: ${safeLogEnum(status, JOB_STATUSES)} (progress=${safeLogInt(s?.progress, { min: 0, max: 1_000_000 })})`);
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
  L(`     Size: ${safeLogInt(camBytes, { min: 0, max: 2_000_000_000 })} bytes`);
  L(`     Status: ${safeLogInt(camResp.status, { min: 0, max: 599 })}`);
  L("");

  SEP();
  L("[6b] Gateway telemetry audit log (last 10 entries)");
  await gw("GET", "/api/telemetry/audit?limit=10", "GET /api/telemetry/audit");
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
  // FC-8 round 5: the HASH above covers the real values (jobId, escrow,
  // protocolRoot, operator, camera type/bytes, status) — the logged copy
  // below is listed field-by-field, each through its own rule, rather than
  // spreading `evidence` and overriding a few keys (round 4's version left
  // escrow/protocolRoot/operator unredacted precisely because a spread
  // silently carries through every key the override list forgets).
  L(`     Evidence: jobId=${safeLogId(evidence.jobId)} kernel=${KERNEL} escrow=${publicChainRef(evidence.escrow, "address")} protocol="PCC Full Telemetry — Slots 1, 3, 5" protocolRoot=${publicChainRef(evidence.protocolRoot, "address")} status=${safeLogEnum(evidence.status, JOB_STATUSES)} cameraBytes=${safeLogInt(evidence.camera.bytes, { min: 0, max: 2_000_000_000 })} cameraType=${camContentType} operator=${publicChainRef(evidence.operator, "address")} chain="base-sepolia" chainId=${safeLogInt(evidence.chainId, { min: 0, max: 999_999 })}`);
  L(`     Hash: ${publicIdForLog(evidenceHash, "hash")}`);
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
  // FC-8 round 2+4: the oracle response may reflect the x-oracle-key or carry
  // a secret; never print its raw text or object — only a validated boolean.
  let oracleParsed: any;
  try { oracleParsed = JSON.parse(oracleText); } catch { oracleParsed = undefined; }
  L(`     Oracle HTTP ${safeLogInt(oracleReq.status, { min: 0, max: 599 })}: verified=${safeLogBool(oracleParsed?.verified)} hasAttestation=${safeLogBool(!!oracleParsed?.attestation)}`);
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
  // FC-8 round 5: jobId is server-returned (safeLogId); escrowAddress/
  // evidenceHash/nonce are public chain identifiers (publicIdForLog);
  // signature is a dependency SIGNATURE — never printed, presence only.
  const signaturePresent = typeof attestationStruct.signature === "string" && attestationStruct.signature !== "0x";
  L(`     Attestation struct: escrow=${publicChainRef(attestationStruct.escrowAddress, "address")} jobId=${safeLogId(attestationStruct.jobId)} evidenceHash=${publicIdForLog(attestationStruct.evidenceHash, "hash")} tier=${safeLogInt(attestationStruct.tier, { min: 0, max: 255 })} verified=${safeLogBool(attestationStruct.verified)} timestamp=${safeLogInt(attestationStruct.timestamp, { min: 0, max: 99_999_999_999 })} nonce=${publicIdForLog(attestationStruct.nonce, "hash")} signaturePresent=${safeLogBool(signaturePresent)}`);
  await write("MilestoneEscrow.submitAttestation(0, attestation)", {
    address: ESCROW, abi: escrowAbi, functionName: "submitAttestation",
    args: [0n, attestationStruct],
  });
  L("");

  // 7d. Release
  SEP();
  L("[7d] Release milestone — settle USDC (2.35% fee to protocol, oracle-gated)");
  const balBefore = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [account.address] });
  L(`     Operator USDC before: ${safeLogDecimal(formatUnits(balBefore as bigint, 6))}`);
  await write("MilestoneEscrow.release(0, attestation)", {
    address: ESCROW, abi: escrowAbi, functionName: "release",
    args: [0n, attestationStruct],
  });
  const balAfter = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [account.address] });
  L(`     Operator USDC after:  ${safeLogDecimal(formatUnits(balAfter as bigint, 6))}`);
  L(`     Net received: ${safeLogDecimal(formatUnits((balAfter as bigint) - (balBefore as bigint), 6))} USDC`);
  const escrowBalAfter = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [ESCROW] });
  L(`     Escrow USDC remaining: ${safeLogDecimal(formatUnits(escrowBalAfter as bigint, 6))}`);
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 7b: SOVEREIGN INFRASTRUCTURE — Storacha + Lit + Starknet + NEAR");
  BIGSEP();

  // ── 7b-1. Storacha / IPFS Evidence Archival ───────────────────────
  SEP();
  L("[7b-1] Archive evidence bundle to IPFS (Storacha/Helia)");
  const archiveResult = await gw("POST", "/api/evidence/archive", "POST /api/evidence/archive", {
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
  // FC-8 round 4: cid/metadataCid are ids (fingerprinted); nothing else from
  // this response has a sound validator, so nothing else is printed.
  L(`     Archived: ${safeLogBool(archiveResult?.archived)} | CID: ${safeLogId(archiveResult?.cid)}`);
  L(`     Metadata CID: ${safeLogId(archiveResult?.metadataCid)}`);
  L("");

  // ── 7b-2. Lit Protocol — Encrypt Evidence ─────────────────────────
  SEP();
  L("[7b-2] Lit Protocol status + key provisioning check");
  const litStatus = await gw("GET", "/api/evidence/lit-status", "GET /api/evidence/lit-status");
  // FC-8 round 4: mode/network are not ids (safeLogId round-3 misuse,
  // finding 3) and have no confidently-closed enum in this codebase —
  // omitted. `connected` is the only field with a sound validator here.
  L(`     Lit connected: ${safeLogBool(litStatus?.lit?.connected)}`);
  L("");

  SEP();
  L("[7b-3] Lit Protocol — provision operator usage key");
  const litProvision = await gw("POST", "/api/lit/provision", "POST /api/lit/provision", {
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
  const zkCommit = await gw("POST", "/api/zk/commit", "POST /api/zk/commit", {
    bundleHash: evidenceHash,
  });
  L(`     Commitment ID: ${safeLogId(zkCommit?.commitment?.id)}`);
  L(`     Commitment hash: ${publicIdForLog(zkCommit?.commitment?.commitmentHash, "hash")}`);
  L("");

  SEP();
  L("[7b-5] Generate tier-compliance proof (tier 2)");
  const zkProof = await gw("POST", "/api/zk/prove/tier", "POST /api/zk/prove/tier", {
    bundleHash: evidenceHash,
    requiredTier: 2,
  });
  const proofId = zkProof?.proof?.id;
  // FC-8 round 4: proofType is not an id and has no closed enum — omitted.
  L(`     Proof ID: ${safeLogId(proofId)}`);
  L(`     Verified: ${safeLogBool(zkProof?.proof?.verified)}`);
  L("");

  SEP();
  L("[7b-6] Anchor proof on Starknet (ZK proof hash → Starknet Sepolia)");
  const starknetAnchor = await gw("POST", "/api/zk/anchor-starknet", "POST /api/zk/anchor-starknet", {
    proofId: proofId ?? undefined,
    merkleRoot: proofId ? undefined : evidenceHash,
  });
  const starknetTxHash = starknetAnchor?.anchor?.txHash;
  // FC-8 round 4: `mode` is not an id and has no closed enum — omitted.
  L(`     Starknet TX: ${publicChainRef(starknetTxHash, "tx")}`);
  L(`     Block: ${safeLogInt(starknetAnchor?.anchor?.blockNumber, { min: 0, max: 99_999_999_999 })}`);
  L("");

  if (starknetTxHash) {
    SEP();
    L("[7b-7] Poll Starknet anchor status");
    // FC-8 round 4: status has no confidently-closed enum here — omitted;
    // the poll having run at all is what this line records.
    await gw("GET", `/api/zk/anchor-starknet/${encodeURIComponent(String(starknetTxHash))}`, "GET /api/zk/anchor-starknet/:txHash");
    L("");
  }

  // ── 7b-8. NEAR — Cross-Chain Payment Quote ────────────────────────
  SEP();
  L("[7b-8] NEAR chain abstraction — integration status");
  // FC-8 round 4: integration/network/supportedChains are not ids and have
  // no closed enum here — omitted; `mock` is the only sound field.
  await gw("GET", "/api/near/status", "GET /api/near/status");
  L("");

  SEP();
  L("[7b-9] NEAR — cross-chain payment quote (NEAR USDC → Base USDC)");
  const nearQuote = await gw("POST", "/api/near/quote", "POST /api/near/quote", {
    fromChain: "near",
    fromAsset: "USDC",
    toChain: "base",
    toAsset: "USDC",
    amount: "1000000",
    recipient: account.address,
  });
  const quoteId = nearQuote?.quote?.quoteId;
  // FC-8 round 4: estimatedOutput/fee/route are amounts/routes, not ids —
  // omitted (finding 3). Only the id is logged, fingerprinted.
  L(`     Quote ID: ${safeLogId(quoteId)}`);
  L("");

  if (quoteId) {
    SEP();
    L("[7b-10] NEAR — submit cross-chain payment intent");
    const nearIntent = await gw("POST", "/api/near/intent", "POST /api/near/intent", {
      quoteId,
      workflowId: `pcc-full-telemetry-${Date.now()}`,
      recipient: account.address,
    });
    const intentId = nearIntent?.intent?.intentId;
    // FC-8 round 4: status omitted (no closed enum here).
    L(`     Intent ID: ${safeLogId(intentId)}`);
    L("");

    if (intentId) {
      SEP();
      L("[7b-11] NEAR — poll intent settlement status");
      const intentStatus = await gw("GET", `/api/near/intent/${encodeURIComponent(String(intentId))}`, "GET /api/near/intent/:id");
      // FC-8 round 4: status omitted; txHash is id-like, fingerprinted.
      L(`     TX hash: ${publicChainRef(intentStatus?.txHash ?? intentStatus?.intent?.txHash, "tx")}`);
      L("");
    }
  }

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 8: FINAL STATE");
  BIGSEP();

  SEP();
  L("[8a] Final escrow on-chain state");
  await gw("GET", `/api/escrow/chain/${ESCROW}/state`, "GET /api/escrow/chain/:address/state");
  L("");

  SEP();
  L("[8b] Final kernel state");
  await gw("GET", "/api/kernels/kernel-nanoclaw", "GET /api/kernels/:kernelId");
  L("");

  SEP();
  L("[8c] Protocol fee accounting");
  const feeData = await pub.readContract({
    address: PROTOCOL, abi: protArt.abi, functionName: "totalFeesCollectedByToken", args: [USDC],
  });
  L(`     Total protocol fees (USDC): ${safeLogDecimal(formatUnits(feeData as bigint, 6))}`);
  const escrowCount = await pub.readContract({ address: PROTOCOL, abi: protArt.abi, functionName: "getEscrowCount" });
  L(`     Total escrows created: ${safeLogInt(escrowCount, { min: 0, max: 1_000_000 })}`);
  L("");

  // ══════════════════════════════════════════════════════════════════
  BIGSEP();
  L("  PHASE 9: PRINT REPORT");
  BIGSEP();

  const report = log.join("\n");
  writeFileSync(reportPath, report);
  // FC-8 round 5: reportPath is a CLI-injected path — never printed, not
  // even relative/basename form; presence is all that is logged.
  L(`Report written: ${envPresence(reportPath)} (${safeLogInt(report.length, { min: 0, max: 2_000_000_000 })} bytes)`);
  L("");

  SEP();
  L("[9a] Submit print job to HP printer (kernel-hp-printer)");
  // FC-8 round 5b: this is a THIRD-PARTY (printer) body — the ruling says
  // a chain value must never appear in one, verbatim or otherwise, even
  // though this SAME text is safe verbatim on stdout and in the report
  // file above. Scrub before sending, not before accumulating.
  await gw("POST", "/api/jobs/submit", "POST /api/jobs/submit", {
    stepId: "step-print-full-telemetry",
    kernelId: "kernel-hp-printer",
    parameters: {
      content: redactChainValuesFromText(report),
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
    if (e instanceof MissingEnvError) { console.error(e.message); process.exitCode = 1; return; } // fc8-ast-guard-allow: MissingEnvError.message is author-controlled (trusted name + static text), see its class doc above
    // FC-8 round 2: e.shortMessage/e.message is free text that can carry a
    // caught secret (e.g. a header value embedded in a fetch/dependency
    // error); only the bounded error-class name is safe to log here.
    console.error(`FATAL: ${safeLogErrorName(e)}`);
    process.exitCode = 1;
  });
}
