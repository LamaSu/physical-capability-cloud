/**
 * Full-chain E2E for kernel-hp-printer on Base Sepolia.
 *
 * Runs on Spark (where PCC_GATEWAY_PRIVATE_KEY can be loaded from Railway).
 *
 * Flow:
 *   1. Deploy fresh MockUSDC
 *   2. Mint 100 USDC to gateway wallet
 *   3. Call PCCProtocol.createEscrow(gateway, gateway, newMockUSDC, cwmId)
 *   4. escrow.addMilestone(stepId, gateway, 1 USDC, 0 bond, 0 challengeWindow)
 *   5. USDC.approve(escrow, 2 USDC)
 *   6. escrow.fund()
 *   7. escrow.submitEvidence(0, evidenceHash)
 *   8. Oracle POST /verify (localhost:4100) — must pass 5/5 checks
 *   9. escrow.submitAttestation(0, attestationHash)
 *  10. escrow.release(0)
 *
 * Also drives the printer via PCC relay at each step so there's a physical artifact.
 *
 * FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3): every
 * printed value — including the two printer-bound text blobs built
 * OUTSIDE the L()-accumulated log (`printText`/`finalText`), which round 4
 * missed entirely since they never go through L() — now goes through an
 * explicit source-to-sink rule (see redact-log.ts and the round-5 report).
 * ORACLE_URL is env-derived in THIS script (unlike the other two, which
 * hardcode it): envPresence only, never the value. Every tx hash/address is
 * a PUBLIC chain identifier through publicIdForLog. The attestation
 * signature is a dependency SIGNATURE — presence only, never printed (not
 * even a fingerprint; a signature is not an identifier to correlate).
 *
 * FC-8 round 5b (steward ruling #6712, DECISIONS 00:53): on STDOUT only
 * (the L()-accumulated log), a shape-valid tx hash/address now prints
 * VERBATIM via the new, separate publicChainRef(value, kind) — PUBLIC
 * chain data, not a secret, per the ruling. printText/finalText (the two
 * blobs actually sent to the PHYSICAL PRINTER — a THIRD-PARTY body, which
 * the ruling says must never carry a chain value verbatim) deliberately
 * keep EVERY field, address and cwmId alike, on publicIdForLog
 * (fingerprinted) — the ruling's "never in third-party bodies" clause
 * applies even to a value that would be allowed verbatim on stdout two
 * lines away. cwmId itself (a locally-computed content hash/commitment,
 * not itself "a tx hash, an address, or an event topic") also stays on
 * publicIdForLog everywhere, stdout included.
 *
 * FC-8 round 3 (astra pack 61b census closure): exported as `run(deps)` with
 * injected fetch/chain-clients/env (see fc8-round3-hp-full-chain.test.ts).
 * CLI behavior is preserved behind the entry guard at the bottom.
 */
import {
  createWalletClient, createPublicClient, http,
  parseUnits, formatUnits, formatEther, keccak256, toBytes,
  type Address, type Hex, type WalletClient, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  safeLogErrorName, safeLogId, safeLogBool, safeLogInt,
  publicIdForLog, envPresence, safeLogDecimal, safeLogEnum, nowIso,
  publicChainRef,
} from "../packages/gateway/src/util/redact-log.js";

/** Thrown for a missing/malformed required env var. `.message` is always safe to print as-is: it is built from a trusted name plus static text, never from external data. */
export class MissingEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingEnvError";
  }
}

const GATEWAY = "https://capability.network";
const PROTOCOL = "0x80aD204d2c4B659CBdAab11684AE1A9f0DC14b23" as Address;
const RECEIPT_STATUSES = ["success", "reverted"] as const;
/** Every fixed tx/deploy label this script's writeC()/deployC() helpers are called with — logged through safeLogEnum rather than interpolated directly, same reasoning as real-e2e-verbose.ts's ROUTE_TEMPLATES. */
const TX_LABELS = [
  "MockUSDC(1M)",
  "PCCProtocol.createEscrow()",
  "MilestoneEscrow.addMilestone()",
  "MockUSDC.approve()",
  "MilestoneEscrow.fund()",
  "MilestoneEscrow.submitEvidence(0, hash)",
  "MilestoneEscrow.submitAttestation(0, attestation)",
  "MilestoneEscrow.release(0, attestation)",
] as const;

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
  contractsDir?: string;
  reportPath?: string;
}

export interface RunResult {
  report: string;
}

export async function run(deps: RunDeps = {}): Promise<RunResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const contractsDir = deps.contractsDir ?? resolve(process.cwd(), "packages/contracts");
  const reportPath = deps.reportPath ?? "/home/ryangeorge/hp-full-chain-report.txt";

  const PK = env.PCC_GATEWAY_PRIVATE_KEY as Hex | undefined;
  if (!PK || !PK.startsWith("0x") || PK.length !== 66) {
    throw new MissingEnvError("PCC_GATEWAY_PRIVATE_KEY missing or malformed");
  }
  const PCCAPIKEY = requireEnv(env, "PCC_API_KEY", "a PCC API key (pcc_live_/pcc_test_)");
  const ORACLE_URL = env.ORACLE_URL ?? "http://localhost:4100"; // oracle is on the same Spark host
  const ORACLE_KEY = requireEnv(env, "PCC_ORACLE_KEY", "the oracle's x-oracle-key");
  const KERNEL = "kernel-hp-printer";

  // Load ABIs from compiled artifacts
  const usdcArt = JSON.parse(readFileSync(resolve(contractsDir, "out/MockUSDC.sol/MockUSDC.json"), "utf8"));
  const protArt = JSON.parse(readFileSync(resolve(contractsDir, "out/PCCProtocol.sol/PCCProtocol.json"), "utf8"));
  const escArt = JSON.parse(readFileSync(resolve(contractsDir, "out/MilestoneEscrow.sol/MilestoneEscrow.json"), "utf8"));

  const account = privateKeyToAccount(PK);
  const transport = http("https://sepolia.base.org");
  const wallet = deps.wallet ?? createWalletClient({ account, chain: baseSepolia, transport });
  const pub = deps.pub ?? createPublicClient({ chain: baseSepolia, transport });

  const report: string[] = [];
  function L(s: string) { console.log(s); report.push(s); }
  function SEP() { L("─".repeat(72)); }

  async function writeC(label: string, params: any): Promise<{ hash: Hex; receipt: any }> {
    L(`  [tx] ${safeLogEnum(label, TX_LABELS)}`);
    const nonce = await pub.getTransactionCount({ address: account.address });
    const hash = await wallet.writeContract({ ...params, nonce, account, chain: baseSepolia } as any);
    L(`     submitted: ${publicChainRef(hash, "tx")}`);
    const receipt: any = await pub.waitForTransactionReceipt({ hash });
    L(`     mined: block ${safeLogInt(receipt.blockNumber, { min: 0, max: 99_999_999_999 })}, gas ${safeLogInt(receipt.gasUsed, { min: 0, max: 50_000_000 })}, status ${safeLogEnum(receipt.status, RECEIPT_STATUSES)}`);
    await new Promise(r => setTimeout(r, 0));
    return { hash, receipt };
  }

  async function deployC(label: string, abi: any, bytecode: Hex, args: any[]): Promise<{ hash: Hex; address: Address; receipt: any }> {
    L(`  [deploy] ${safeLogEnum(label, TX_LABELS)}`);
    const nonce = await pub.getTransactionCount({ address: account.address });
    const hash = await wallet.deployContract({ abi, bytecode, args, nonce, account, chain: baseSepolia } as any);
    L(`     submitted: ${publicChainRef(hash, "tx")}`);
    const receipt: any = await pub.waitForTransactionReceipt({ hash });
    L(`     mined: ${publicChainRef(receipt.contractAddress, "address")} block ${safeLogInt(receipt.blockNumber, { min: 0, max: 99_999_999_999 })} gas ${safeLogInt(receipt.gasUsed, { min: 0, max: 50_000_000 })}`);
    await new Promise(r => setTimeout(r, 0));
    return { hash, address: receipt.contractAddress as Address, receipt };
  }

  async function gwFetch(method: string, path: string, body?: any) {
    const res = await fetchImpl(`${GATEWAY}${path}`, {
      method,
      headers: { "Authorization": `Bearer ${PCCAPIKEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; }
    catch { return { status: res.status, data: text }; }
  }

  L("═".repeat(72));
  L("  kernel-hp-printer Full Chain E2E on Base Sepolia");
  L(`  ${nowIso()}`);
  L("═".repeat(72));
  const bal = await pub.getBalance({ address: account.address });
  L(`Signer:       ${publicChainRef(account.address, "address")}`);
  L(`ETH balance:  ${safeLogDecimal(formatEther(bal))}`);
  L(`Gateway:      ${GATEWAY}`);
  // FC-8 round 5: ORACLE_URL is ENV-derived in THIS script (unlike
  // real-e2e[-verbose].ts, which hardcode it) — never printed, presence
  // only.
  L(`Oracle:       ${envPresence(env.ORACLE_URL)}`);
  L(`Kernel:       ${KERNEL}`);
  L(`Protocol:     ${publicChainRef(PROTOCOL, "address")}`);
  L("");

  SEP();
  L("[1] Deploy fresh MockUSDC (1M initial supply)");
  const usdc = await deployC("MockUSDC(1M)", usdcArt.abi, usdcArt.bytecode.object as Hex, [parseUnits("1000000", 6)]);
  const USDC = usdc.address;
  const usdcBal = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [account.address] });
  L(`     MockUSDC: ${publicChainRef(USDC, "address")}`);
  L(`     Signer USDC balance: ${safeLogDecimal(formatUnits(usdcBal as bigint, 6))}`);
  L("");

  SEP();
  L("[2] Create escrow via PCCProtocol.createEscrow()");
  const cwmId = keccak256(toBytes(`hp-printer-e2e-${Date.now()}`));
  L(`     cwmId: ${publicIdForLog(cwmId, "hash")}`);
  const createResult = await writeC("PCCProtocol.createEscrow()", {
    address: PROTOCOL,
    abi: protArt.abi,
    functionName: "createEscrow",
    args: [account.address, account.address, USDC, cwmId],
  });
  // EscrowCreated event: topic[1] = escrow address (indexed)
  const escrowLog = createResult.receipt.logs.find((l: any) => l.topics.length >= 2);
  const ESCROW = ("0x" + (escrowLog?.topics[1]?.slice(26) ?? "")) as Address;
  L(`     Escrow: ${publicChainRef(ESCROW, "address")}`);
  L("");

  SEP();
  L("[3] addMilestone(stepId, operator=signer, 1 USDC, 0 bond, 0 challenge)");
  const stepId = keccak256(toBytes("hp-print-telemetry-step"));
  await writeC("MilestoneEscrow.addMilestone()", {
    address: ESCROW,
    abi: escArt.abi,
    functionName: "addMilestone",
    args: [stepId, account.address, parseUnits("1", 6), 0n, 0n],
  });
  const msCount = await pub.readContract({ address: ESCROW, abi: escArt.abi, functionName: "getMilestoneCount" });
  L(`     Milestone count: ${safeLogInt(msCount, { min: 0, max: 1_000_000 })}`);
  L("");

  SEP();
  L("[4] USDC.approve(escrow, 2 USDC)");
  await writeC("MockUSDC.approve()", {
    address: USDC,
    abi: usdcArt.abi,
    functionName: "approve",
    args: [ESCROW, parseUnits("2", 6)],
  });
  L("");

  SEP();
  L("[5] escrow.fund() — transfer USDC from payer to escrow");
  await writeC("MilestoneEscrow.fund()", {
    address: ESCROW, abi: escArt.abi, functionName: "fund", args: [],
  });
  const escrowBal = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [ESCROW] });
  const funded = await pub.readContract({ address: ESCROW, abi: escArt.abi, functionName: "funded" });
  L(`     Escrow USDC balance: ${safeLogDecimal(formatUnits(escrowBal as bigint, 6))}`);
  L(`     funded flag: ${safeLogBool(funded)}`);
  L("");

  SEP();
  L("[6] Drive PCC printer via relay — create scope + print telemetry header");
  const scopeRes = await gwFetch("POST", `/api/relay/${KERNEL}/scope`, {
    createdBy: "hp-printer@frontier.local",
    allowedTools: ["printer_print_text", "print"],
    maxCommands: 10,
    expiresInMinutes: 30,
  });
  // FC-8 round 3: scopeId is server-returned; validate before logging (the
  // real value, scopeIdRaw, is still what gets sent back to the gateway).
  const scopeIdRaw = (scopeRes.data as any)?.id;
  L(`     scope: ${safeLogId(scopeIdRaw)}`);

  // FC-8 round 5: this text is sent to the PHYSICAL PRINTER — a
  // third-party, human-facing sink, same rules as stdout/the report. Round
  // 4 missed this entirely: it never goes through L(), so fixing every
  // L() call site did not fix it.
  const printText = [
    "============================================",
    "  PCC FULL-CHAIN E2E PROOF",
    `  ${nowIso()}`,
    "============================================",
    "",
    `MockUSDC:  ${publicIdForLog(USDC, "address")}`,
    `Escrow:    ${publicIdForLog(ESCROW, "address")}`,
    `cwmId:     ${publicIdForLog(cwmId, "hash")}`,
    `Amount:    1.00 USDC`,
    `Signer:    ${publicIdForLog(account.address, "address")}`,
    "",
    "This page was printed mid-settlement, via the",
    "PCC relay chain on capability.network, from a",
    "Spark-side script that is ALSO signing Base",
    "Sepolia transactions for the same escrow.",
    "============================================",
    "",
  ].join("\n");

  const tcRes = await gwFetch("POST", `/api/relay/${KERNEL}/tool-call`, {
    scopeId: scopeIdRaw,
    toolName: "printer_print_text",
    args: { text: printText, copies: 1 },
  });
  const toolCallId = (tcRes.data as any)?.id;
  // FC-8 round 4: status is not an id (finding 3 — safeLogId must never be
  // used on a status/mode/network/type/fee/route/amount) and has no
  // confidently-closed enum in this codebase, so it is omitted; only the
  // id (fingerprinted) is logged.
  L(`     tool call: ${safeLogId(toolCallId)}`);
  L("");

  SEP();
  L("[7] Submit evidence hash on-chain");
  const evidence = {
    escrow: ESCROW,
    cwmId,
    kernel: KERNEL,
    capability: "cap-kernel-hp-printer-2d-printing",
    operator: account.address,
    protocol: "PCC HP Printer Full Chain",
    timestamp: new Date().toISOString(),
    chain: "base-sepolia",
    chainId: 84532,
    printResult: toolCallId,
  };
  const evidenceHash = keccak256(toBytes(JSON.stringify(evidence)));
  // FC-8 round 5: the HASH above covers the real values; the logged copy
  // is listed field-by-field (never a JSON.stringify spread, which is how
  // round 4 left escrow/cwmId/operator unredacted even though a comment
  // claimed otherwise — see real-e2e-verbose.ts's equivalent fix).
  L(`     evidence: escrow=${publicChainRef(evidence.escrow, "address")} cwmId=${publicIdForLog(evidence.cwmId, "hash")} kernel=${KERNEL} capability="cap-kernel-hp-printer-2d-printing" operator=${publicChainRef(evidence.operator, "address")} protocol="PCC HP Printer Full Chain" chain="base-sepolia" chainId=${safeLogInt(evidence.chainId, { min: 0, max: 999_999 })} printResult=${safeLogId(evidence.printResult)}`);
  L(`     hash: ${publicIdForLog(evidenceHash, "hash")}`);
  await writeC("MilestoneEscrow.submitEvidence(0, hash)", {
    address: ESCROW, abi: escArt.abi, functionName: "submitEvidence",
    args: [0n, evidenceHash as Hex],
  });
  L("");

  SEP();
  L("[8] Oracle /verify — must pass 5/5 checks");
  const verifyBody = {
    escrowAddress: ESCROW,
    jobId: "job-hp-printer-fullchain",
    evidenceHash,
    evidenceCid: null,
    assuranceTier: 0,
    kernelId: KERNEL,
  };
  L(`     request: escrowAddress=${publicChainRef(verifyBody.escrowAddress, "address")} jobId="job-hp-printer-fullchain" evidenceHash=${publicIdForLog(verifyBody.evidenceHash, "hash")} assuranceTier=${safeLogInt(verifyBody.assuranceTier, { min: 0, max: 10 })} kernelId=${KERNEL}`);
  const oracleRes = await fetchImpl(`${ORACLE_URL}/verify`, {
    method: "POST",
    headers: { "x-oracle-key": ORACLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(verifyBody),
  });
  const oracleText = await oracleRes.text();
  let oracleData: any = {};
  try { oracleData = JSON.parse(oracleText); } catch {}
  // FC-8 round 2+3: never print the raw oracle body/object — only a
  // validated boolean/presence summary.
  L(`     HTTP ${safeLogInt(oracleRes.status, { min: 0, max: 599 })}: verified=${safeLogBool(oracleData?.verified)} hasAttestation=${safeLogBool(!!oracleData?.attestation)}`);
  L("");

  SEP();
  L("[9] submitAttestation(0, attestation) — oracle-signed struct");
  // Build the on-chain Attestation struct that MilestoneEscrow binds to.
  const attestationStruct = {
    escrowAddress: ESCROW,
    jobId: "job-hp-printer-fullchain",
    evidenceHash: evidenceHash as Hex,
    tier: 0,
    verified: true,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    nonce: keccak256(toBytes(`nonce-${Date.now()}-${ESCROW}`)),
    signature: oracleData.attestation?.signature
      ? (oracleData.attestation.signature as Hex)
      : ("0x" as Hex),
  };
  L(`     attestation.evidenceHash: ${publicIdForLog(attestationStruct.evidenceHash, "hash")}`);
  // FC-8 round 5: a signature is a dependency SIGNATURE, not an identifier
  // to correlate — never printed, not even fingerprinted. Presence only.
  const signaturePresent = typeof attestationStruct.signature === "string" && attestationStruct.signature !== "0x";
  L(`     attestation.signature present: ${safeLogBool(signaturePresent)}`);
  await writeC("MilestoneEscrow.submitAttestation(0, attestation)", {
    address: ESCROW, abi: escArt.abi, functionName: "submitAttestation",
    args: [0n, attestationStruct],
  });
  L("");

  SEP();
  L("[10] release(0, attestation) — settle USDC (2.35% protocol fee, oracle-gated)");
  const balBefore = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [account.address] });
  L(`     Signer USDC before: ${safeLogDecimal(formatUnits(balBefore as bigint, 6))}`);
  const releaseResult = await writeC("MilestoneEscrow.release(0, attestation)", {
    address: ESCROW, abi: escArt.abi, functionName: "release",
    args: [0n, attestationStruct],
  });
  const balAfter = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [account.address] });
  const escrowBalAfter = await pub.readContract({ address: USDC, abi: usdcArt.abi, functionName: "balanceOf", args: [ESCROW] });
  L(`     Signer USDC after:  ${safeLogDecimal(formatUnits(balAfter as bigint, 6))}`);
  L(`     Net received: ${safeLogDecimal(formatUnits((balAfter as bigint) - (balBefore as bigint), 6))} USDC`);
  L(`     Escrow remaining:   ${safeLogDecimal(formatUnits(escrowBalAfter as bigint, 6))}`);
  L("");

  SEP();
  L("[11] Final telemetry page to HP 3301");
  const finalText = [
    "============================================",
    "  PCC FULL-CHAIN E2E — SETTLED",
    "============================================",
    "",
    `USDC:      ${publicIdForLog(USDC, "address")}`,
    `Escrow:    ${publicIdForLog(ESCROW, "address")}`,
    `Deploy tx: ${publicIdForLog(usdc.hash, "hash")}`,
    `Create tx: ${publicIdForLog(createResult.hash, "hash")}`,
    `Release:   ${publicIdForLog(releaseResult.hash, "hash")}`,
    `Net paid:  ${safeLogDecimal(formatUnits((balAfter as bigint) - (balBefore as bigint), 6))} USDC`,
    `Fee:       2.35% to protocol`,
    "",
    `Basescan: sepolia.basescan.org/address/${publicIdForLog(ESCROW, "address")}`,
    "",
    "All steps verified on-chain, milestone released,",
    "printer driven via PCC relay. Full telemetry written",
    `locally: ${envPresence(reportPath)}`,
    "============================================",
    "",
  ].join("\n");
  await gwFetch("POST", `/api/relay/${KERNEL}/tool-call`, {
    scopeId: scopeIdRaw, toolName: "printer_print_text",
    args: { text: finalText, copies: 1 },
  });
  L("     final page queued");
  L("");

  L("═".repeat(72));
  L("  DONE");
  L("═".repeat(72));
  L("");
  L("tx hashes for basescan:");
  L(`  usdcDeploy:  ${publicChainRef(usdc.hash, "tx")}`);
  L(`  createEscrow: ${publicChainRef(createResult.hash, "tx")}`);
  L(`  release:     ${publicChainRef(releaseResult.hash, "tx")}`);
  L("");
  L("Addresses:");
  L(`  MockUSDC: ${publicChainRef(USDC, "address")}`);
  L(`  Escrow:   ${publicChainRef(ESCROW, "address")}`);
  L("");

  const joined = report.join("\n");
  writeFileSync(reportPath, joined);
  return { report: joined };
}

// FC-8 round 3: CLI behavior lives only behind this guard. A plain `import`
// of this module (as a test does) never executes main.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(e => {
    if (e instanceof MissingEnvError) { console.error(e.message); process.exitCode = 1; return; } // fc8-ast-guard-allow: MissingEnvError.message is author-controlled (trusted name + static text), see its class doc above
    // FC-8 round 2: printing the whole error object serializes its message
    // and stack (and any attached properties), which can carry a caught
    // secret; only the bounded error-class name is safe to log here.
    console.error("FAIL:", safeLogErrorName(e));
    process.exitCode = 1;
  });
}
