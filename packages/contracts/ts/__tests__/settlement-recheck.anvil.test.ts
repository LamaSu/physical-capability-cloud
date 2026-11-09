/**
 * Opt-in real-contract replay cells A0-A7. SPEC must be built first:
 * pnpm --filter @pcc/spec build
 * VNEXT_ANVIL_E2E=1 pnpm --filter @pcc/contracts exec vitest run ts/__tests__/settlement-recheck.anvil.test.ts
 * Uses PreflightAnvilFixture, FOUNDRY_BIN and a local anvil only. No deployment record is written.
 * Event coverage uses the fixture's existing MockToken artifact in a reverted local snapshot to force claims;
 * all six event payloads come from transactions executing the real escrow, never fabricated log encodings.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, decodeFunctionResult, encodeFunctionData, http, keccak256, parseAbi, stringToHex, toEventSelector, zeroHash, type Abi, type Address, type Chain, type Hex, type PrivateKeyAccount, type TransactionReceipt } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KIT_ABI, type RecheckDeployment } from "@pcc/spec/recheck";
import { httpRpc, recheckSettlementReplies, type RecheckReport } from "@pcc/spec/recheck/replay";
import { VNextSettlementEscrowABI, VNextSettlementEscrowFactoryABI, buildUnitConfig, compileVNextPolicy, jobIdHashOf, type CompiledVNextPolicy } from "../vnext/index.js";

const RUN = process.env.VNEXT_ANVIL_E2E === "1";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = join(ROOT, "test/fixtures/vnext-anvil/PreflightAnvilFixture.s.sol") + ":PreflightAnvilFixture";
const SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const bin = (name: string) => { const p = join(process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin"), name); return existsSync(p) ? p : name; };
const freePort = () => new Promise<number>((resolve, reject) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => a && typeof a === "object" ? resolve(a.port) : reject(new Error("no free port"))); }); });
const tokenAbi = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function setTransferMode(uint8)", "function setTransferFromMode(uint8)"]);
const oracleAbi = parseAbi(["function setAssertion(bytes32,(bytes32 assertionId,bytes32 feeScheduleHash,bytes32 compositionRoot,bytes32 evidenceBundleHash,address escrow,uint64 assertedAt,uint8 achievedTier,uint8 requestedTier,uint8 decision,address feeRecipient,uint64 oracleAuthEpoch,uint16 feeBps))", "function setAdjudication(bytes32,uint8,address,uint64,(bytes32 adjudicationId,bytes32 reviewedAssertionId,address escrow,uint64 decidedAt,uint8 role,uint8 outcome))"]);
const kitEscrow = parseAbi(KIT_ABI.escrow), kitFactory = parseAbi(KIT_ABI.factory);
const lower = (a: Address) => a.toLowerCase() as Address;

describe.skipIf(!RUN)("settlement recheck against PreflightAnvilFixture", () => {
  let anvil: ChildProcess | undefined;
  let rpcUrl: string, chain: Chain;
  let pub: ReturnType<typeof createPublicClient>, test: ReturnType<typeof createTestClient>;
  let fixtureEscrowAbi: Abi;
  let buyer: PrivateKeyAccount, operator: PrivateKeyAccount;
  let deployed: { FACTORY: Address; IMPL: Address; TOKEN: Address; ORACLE: Address };
  let compiled: CompiledVNextPolicy, deployment: RecheckDeployment, funding: TransactionReceipt;
  let p1: any[], p2: any[], preReclaim: Hex, reclaim: TransactionReceipt;
  let lag = 0n;
  const gross = 1_000_000_003n, net = 976_500_003n, fee = 23_500_000n;
  let feeSink: Address, reclaimAt: bigint;
  const observed = new Set<string>();
  const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(rpcUrl) });
  const read = (functionName: string, args: readonly unknown[] = []) => {
    const abi = kitEscrow.some(x => x.type === "function" && x.name === functionName) ? kitEscrow : fixtureEscrowAbi;
    return pub.readContract({ address: compiled.escrow, abi, functionName, args } as never) as Promise<any>;
  };
  const send = async (account: PrivateKeyAccount, request: any) => {
    const tx = await wallet(account).writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash: tx });
    expect(receipt.status).toBe("success");
    if (compiled) for (const log of receipt.logs.filter(l => lower(l.address) === lower(compiled.escrow))) {
      const item = kitEscrow.find(x => x.type === "event" && toEventSelector(x) === log.topics[0]);
      if (!item || item.type !== "event") continue;
      const kit = decodeEventLog({ abi: kitEscrow, topics: log.topics, data: log.data });
      const realAbi = VNextSettlementEscrowABI.some(x => x.type === "event" && toEventSelector(x) === log.topics[0]) ? VNextSettlementEscrowABI : fixtureEscrowAbi;
      const real = decodeEventLog({ abi: realAbi, topics: log.topics, data: log.data });
      expect(kit.args).toEqual(real.args);
      observed.add(`event:${kit.eventName}`);
    }
    return receipt;
  };
  const escrowSend = (functionName: string, args: readonly unknown[] = []) => {
    const abi = VNextSettlementEscrowABI.some(x => x.type === "function" && x.name === functionName) ? VNextSettlementEscrowABI : fixtureEscrowAbi;
    return send(buyer, { address: compiled.escrow, abi, functionName, args });
  };
  const finalizeBlock = async (number: bigint) => {
    for (let i = 0; i < 128; i++) {
      const finalized = await pub.getBlock({ blockTag: "finalized" });
      if (finalized.number !== null && finalized.number >= number) return;
      await test.mine({ blocks: Number(lag + 1n) });
    }
    throw new Error("funding/reclaim block did not become finalized");
  };
  function replies(block: { number: bigint; hash: Hex }, state: 1 | 9, finalizedBlock?: bigint): any[] {
    const common = { chainId: 31337, escrow: lower(compiled.escrow), unitId: compiled.unitIds[0], deployment: { chainId: 31337, factory: deployment.factory, implementation: deployment.implementation, recordSha256: deployment.recordSha256 }, asOfBlock: block.number.toString(), asOfBlockHash: block.hash, finality: "finalized", logCompleteness: "complete" };
    const sourced = (value: string) => ({ value, source: "log", chain: "eip155:31337", contractOrRegistryId: lower(compiled.escrow), blockNumber: common.asOfBlock, blockHash: common.asOfBlockHash, finality: "finalized", completeness: "complete" });
    return [
      { ...common, unitState: state, phase: state === 1 ? "active" : "settled", finalState: state === 1 ? null : "SETTLED_REFUNDED", isTerminal: state === 9, isAllocated: false, windowEndsAt: null },
      { ...common, phase: state === 1 ? "active" : "settled", finalState: state === 1 ? null : "SETTLED_REFUNDED", isAllocated: false, network: { chainId: 31337 }, assetReality: { value: "test", source: "registry", contractOrRegistryId: "anvil-fixture", revision: 1, attests: "identity-not-liveness" }, economics: { amount: net.toString(), feeAmount: fee.toString(), recipient: lower(operator.address), token: deployment.usdc, assuranceTier: 1 }, refundReason: state === 9 ? sourced("DEADLINE_RECLAIM") : null, finalizedBlock: finalizedBlock === undefined ? null : sourced(finalizedBlock.toString()) },
      { ...common, provenanceAvailability: "UNANCHORED" },
    ];
  }
  const replay = (replies: any[]) => recheckSettlementReplies({ replies, rpc: httpRpc(rpcUrl), knownDeployments: [deployment] });
  const allMatch = (report: RecheckReport) => { expect(report.verdicts.filter(x => x.verdict === "UNVERIFIED" || x.verdict === "MISMATCH")).toEqual([]); expect(report.outcome).toBe("ALL_MATCH"); };

  beforeAll(async () => {
    console.log("A0", execFileSync(bin("anvil"), ["--version"], { encoding: "utf8" }).trim());
    const port = await freePort(); rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(bin("anvil"), ["--port", String(port), "--silent"], { stdio: "ignore" });
    chain = { id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
    pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 100 });
    test = createTestClient({ mode: "anvil", chain, transport: http(rpcUrl) });
    for (let i = 0; ; i++) { try { await pub.getChainId(); break; } catch { if (i > 80) throw new Error("anvil did not start"); await new Promise(r => setTimeout(r, 250)); } }
    // Measure away from genesis, where a lagging finalized tag can be clamped to block zero.
    await test.mine({ blocks: 128 });
    lag = (await pub.getBlock()).number! - (await pub.getBlock({ blockTag: "finalized" })).number!;
    console.log(`A0 latest-to-finalized lag: ${lag} blocks`);
    const out = execFileSync(bin("forge"), ["script", FIXTURE, "--root", ROOT, "--offline", "--rpc-url", rpcUrl, "--broadcast", "--slow", "--unlocked", "--sender", SENDER], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, timeout: 300_000 });
    // Fixture stdout is reviewable evidence; no JSON is written under deployments/.
    console.log(out);
    // The frozen compiler-facing ABI omits some kit reads and fixture operations.
    fixtureEscrowAbi = JSON.parse(readFileSync(join(ROOT, "out/VNextSettlementEscrow.sol/VNextSettlementEscrow.json"), "utf8")).abi;
    const grab = (label: string) => { const m = out.match(new RegExp(`${label} (0x[0-9a-fA-F]{40})`)); if (!m?.[1]) throw new Error(`missing fixture ${label}`); return lower(m[1] as Address); };
    deployed = { FACTORY: grab("FACTORY"), IMPL: grab("IMPL"), TOKEN: grab("TOKEN"), ORACLE: grab("ORACLE") };
    buyer = privateKeyToAccount(generatePrivateKey()); operator = privateKeyToAccount(generatePrivateKey()); feeSink = privateKeyToAccount(generatePrivateKey()).address;
    for (const a of [buyer, operator]) await test.setBalance({ address: a.address, value: 10n ** 20n });
    const now = (await pub.getBlock()).timestamp; reclaimAt = now + 45n * 86_400n;
    compiled = compileVNextPolicy({ chainId: 31337n, factory: deployed.FACTORY, implementation: deployed.IMPL, token: deployed.TOKEN, payer: buyer.address, operator: operator.address, jobIdHash: jobIdHashOf("pcc:recheck-anvil"), termsHash: keccak256(stringToHex("terms")), policyNonce: 1n, acceptedPolicyDigest: keccak256(stringToHex("accepted")), expiry: now + 86_400n, fundingTime: now, units: [buildUnitConfig({ milestoneIndex: 0n, stepId: keccak256(stringToHex("step")), requiredTier: 1, g: gross, feeBps: 235, feeRecipient: feeSink, reclaimAt, compositionSchemaVersion: 0, compositionRoot: zeroHash, payouts: [{ recipient: operator.address, amount: net }] })] });
    await send(buyer, { address: deployed.FACTORY, abi: VNextSettlementEscrowFactoryABI, functionName: "createEscrow", args: [compiled.identity] });
    await send(buyer, { address: deployed.TOKEN, abi: tokenAbi, functionName: "mint", args: [buyer.address, gross * 2n] });
    await send(buyer, { address: deployed.TOKEN, abi: tokenAbi, functionName: "approve", args: [compiled.escrow, gross] });
    funding = await escrowSend("fund", [compiled.configs, { expiry: compiled.expiry, payerSignature: "0x", operatorSignature: await operator.sign({ hash: compiled.digest }) }]);
    deployment = { network: "anvil", chainId: 31337, factory: deployed.FACTORY, implementation: deployed.IMPL, recordSha256: createHash("sha256").update(JSON.stringify(deployed)).digest("hex"), implementationCodehash: keccak256((await pub.getCode({ address: deployed.IMPL }))!), usdc: deployed.TOKEN, recordBlockNumber: Number(funding.blockNumber), scheduleId: "local-fixture", scheduleTestnetOnly: true, challengeWindowSec: 600, appealWindowSec: 1500, backupWindowSec: 600, emergencyReviewWindowSec: 1500, readSurface: "vnext-read-v1" };
    await finalizeBlock(funding.blockNumber);
    p1 = replies({ number: funding.blockNumber, hash: funding.blockHash }, 1);
  }, 600_000);
  afterAll(() => { anvil?.kill(); });

  it("A0/A1 fixture funded one single-leg unit", async () => { expect(lag).toBeGreaterThanOrEqual(0n); expect(await read("unitState", [compiled.unitIds[0]])).toBe(1); expect((await read("unitCounters", [compiled.unitIds[0]]))[1]).toBe(1n); });
  it("A2 honest P1 and every KIT_ABI function decode against real contract returns", async () => {
    allMatch(await replay(p1));
    for (const [kind, kit, real, target] of [["escrow", kitEscrow, VNextSettlementEscrowABI, compiled.escrow], ["factory", kitFactory, VNextSettlementEscrowFactoryABI, deployed.FACTORY]] as const) {
      for (const item of kit.filter(x => x.type === "function")) {
        if (item.type !== "function") continue;
        const args = item.inputs.map(x => x.type === "bytes32" ? compiled.unitIds[0] : 0n);
        const data = encodeFunctionData({ abi: kit, functionName: item.name, args } as never);
        const raw = await pub.request({ method: "eth_call", params: [{ to: target, data }, { blockHash: funding.blockHash, requireCanonical: true }] } as never) as Hex;
        const realAbi = real.some(x => x.type === "function" && x.name === item.name) ? real : fixtureEscrowAbi;
        expect(decodeFunctionResult({ abi: kit, functionName: item.name, data: raw } as never)).toEqual(decodeFunctionResult({ abi: realAbi, functionName: item.name, data: raw } as never));
        observed.add(`${kind}:${item.name}`);
      }
    }
    // A reverted fault-injection snapshot supplies real ReleaseAllocated, EscalationResolved and deferred-claim logs.
    const snapshot = await test.snapshot();
    try {
      const artifact = JSON.parse(readFileSync(join(ROOT, "out/VNextSettlementEscrow.t.sol/MockToken.json"), "utf8"));
      const runtime = artifact.deployedBytecode.object as Hex;
      await test.setCode({ address: deployed.TOKEN, bytecode: runtime.startsWith("0x") ? runtime : `0x${runtime}` });
      await send(buyer, { address: deployed.TOKEN, abi: tokenAbi, functionName: "setTransferMode", args: [2] });
      await send(buyer, { address: deployed.TOKEN, abi: tokenAbi, functionName: "setTransferFromMode", args: [0] });
      await send(buyer, { address: deployed.TOKEN, abi: tokenAbi, functionName: "mint", args: [compiled.escrow, gross] });
      await send(buyer, { address: deployed.TOKEN, abi: tokenAbi, functionName: "mint", args: [buyer.address, gross] });
      await send(operator, { address: compiled.escrow, abi: VNextSettlementEscrowABI, functionName: "submitEvidence", args: [compiled.unitIds[0], keccak256(stringToHex("package"))] });
      const assertion = keccak256(stringToHex("assertion"));
      await send(buyer, { address: deployed.ORACLE, abi: oracleAbi, functionName: "setAssertion", args: [compiled.unitIds[0], { assertionId: assertion, feeScheduleHash: await read("feeScheduleHashOf", [compiled.unitIds[0]]), compositionRoot: zeroHash, evidenceBundleHash: await read("evidenceBundleHashOf", [compiled.unitIds[0]]), escrow: compiled.escrow, assertedAt: (await pub.getBlock()).timestamp, achievedTier: 1, requestedTier: 1, decision: 1, feeRecipient: feeSink, oracleAuthEpoch: 1n, feeBps: 235 }] });
      await escrowSend("acceptAssertion", [compiled.unitIds[0]]);
      await escrowSend("challenge", [compiled.unitIds[0]]);
      const anchor = await read("challengedAtOf", [compiled.unitIds[0]]);
      const escalation = await read("escalationAttester") as Address;
      await send(buyer, { address: escalation, abi: oracleAbi, functionName: "setAdjudication", args: [compiled.unitIds[0], 1, compiled.escrow, anchor, { adjudicationId: keccak256(stringToHex("appeal")), reviewedAssertionId: assertion, escrow: compiled.escrow, decidedAt: (await pub.getBlock()).timestamp, role: 1, outcome: 1 }] });
      const allocated = await escrowSend("resolveEscalation", [compiled.unitIds[0], 1]);
      const claims = allocated.logs.filter(l => l.topics[0] === toEventSelector(kitEscrow.find(x => x.type === "event" && x.name === "ClaimCreated")! as any));
      expect(claims.length).toBeGreaterThanOrEqual(2);
      await send(buyer, { address: deployed.TOKEN, abi: tokenAbi, functionName: "setTransferMode", args: [0] });
      for (const log of claims) { const decoded = decodeEventLog({ abi: kitEscrow, topics: log.topics, data: log.data }); await escrowSend("dischargeClaim", [(decoded.args as any).claimId]); }
    } finally { await test.revert({ id: snapshot }); }
  }, 120_000);
  it("A3 tampered net amount mismatches", async () => { const bad = structuredClone(p1); bad[1].economics.amount = gross.toString(); const r = await replay(bad); expect(r.verdicts.find(x => x.pointer === "/economics/amount")?.verdict).toBe("MISMATCH"); });
  it("A4 reclaim at P2 witnesses DEADLINE_RECLAIM and its actual block", async () => {
    preReclaim = await test.snapshot();
    await test.setNextBlockTimestamp({ timestamp: reclaimAt + 1n });
    reclaim = await escrowSend("reclaimAfterDeadline", [compiled.unitIds[0]]);
    await finalizeBlock(reclaim.blockNumber);
    p2 = replies({ number: reclaim.blockNumber, hash: reclaim.blockHash }, 9, reclaim.blockNumber);
    allMatch(await replay(p2));
  }, 120_000);
  it("A5 P1 is still readable after settlement at P2", async () => { allMatch(await replay(p1)); });
  it("A6 replacing P2 makes its pin NOT_CANONICAL", async () => {
    await test.revert({ id: preReclaim });
    const head = (await pub.getBlock()).number!;
    await test.mine({ blocks: Number(reclaim.blockNumber + lag + 4n - head) });
    await finalizeBlock(reclaim.blockNumber);
    const r = await replay(p2); expect(r.pin.status).toBe("NOT_CANONICAL"); expect(r.exitCode).toBe(1);
  }, 120_000);
  it("A7 explicit fixture deployment is UNOFFICIAL; every KIT_ABI item was decoded", async () => {
    expect((await replay(p1)).deploymentStatus).toBe("UNOFFICIAL");
    for (const item of kitEscrow) expect(observed.has(item.type === "event" ? `event:${item.name}` : `escrow:${item.name}`)).toBe(true);
    for (const item of kitFactory) expect(observed.has(`factory:${item.name}`)).toBe(true);
  });
});
