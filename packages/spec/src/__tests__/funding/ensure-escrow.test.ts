import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import { approveAndFund, classifyEscrowCreation, ensureEscrow, prepareFunding, type SendResult } from "../../funding/index.js";
import { ESCROW_ABI, policySalt, prePolicyRoot, predictEscrow } from "../../funding/vnext.js";
import { DAY, FACTORY_CREATE_ABI, FACTORY_PREDICT_ABI, IMPLEMENTATION, NOW, OTHER, buildFixture, cloneRuntime,
  makeChain, newAccount, revertWith, testExpect, testPins, type FixtureOptions } from "./fixture.js";

async function setup(o: FixtureOptions = {}, escrowCode = false) {
  const fx = await buildFixture(o);
  const chain = makeChain(fx, { escrowCode });
  const prepared = await prepareFunding({ payload: fx.wire(), expect: testExpect(fx), wallet: chain.wallet(),
    publicClient: chain.publicClient, quote: { maxTotalGross: fx.totalGross }, pins: testPins(fx) });
  const args = { prepared, wallet: chain.wallet(), publicClient: chain.publicClient };
  return { fx, chain, prepared, args };
}
const simulations = (log: ReturnType<typeof makeChain>["state"]["log"]) => log.filter(x => x.method === "eth_call" && (x.params[0] as { from?: string }).from);
const createKey = (factory: string) => `${factory.toLowerCase()}:0x886deb02`;

describe("ensureEscrow", () => {
  it("T6 already there: ready without simulation or send", async () => {
    const { chain, args } = await setup({}, true);
    const result = await ensureEscrow(args);
    expect(result.outcome).toBe("ready");
    expect(result.create).toBeUndefined();
    expect(simulations(chain.state.log)).toEqual([]);
    expect(chain.sends()).toEqual([]);
  });

  it("T7 creates it with exactly the recomputed identity at the pinned block", async () => {
    const { fx, chain, prepared, args } = await setup();
    const blockHash = chain.state.block.hash;
    const result = await ensureEscrow(args);
    expect(chain.state.sent).toHaveLength(1);
    const [sent] = chain.state.sent;
    expect(sent!.to.toLowerCase()).toBe(prepared.factory.toLowerCase());
    const decoded = decodeFunctionData({ abi: FACTORY_CREATE_ABI, data: sent!.data });
    expect(decoded.functionName).toBe("createEscrow");
    expect(decoded.args![0]).toEqual({ payer: fx.payer.address, operator: fx.operator.address,
      jobIdHash: fx.message.jobIdHash, termsHash: fx.message.termsHash, policyNonce: fx.message.policyNonce,
      prePolicyRoot: prePolicyRoot(fx.configs), acceptedPolicyDigest: fx.message.acceptedPolicyDigest });
    const simulated = simulations(chain.state.log);
    expect(simulated).toHaveLength(1);
    expect(simulated[0]!.params).toEqual([{ from: prepared.payer, to: prepared.factory, data: sent!.data },
      { blockHash, requireCanonical: true }]);
    const sendIndex = chain.state.log.findIndex(x => x.method === "eth_sendRawTransaction");
    expect(chain.state.log.indexOf(simulated[0]!)).toBeLessThan(sendIndex);
    expect(result).toMatchObject({ outcome: "ready", create: { kind: "mined", status: "success", blockHash },
      createTx: sent!.hash, code: { kind: "clone", blockNumber: chain.state.block.number, blockHash } });
    expect(chain.state.log.filter(x => x.method === "eth_getCode").at(-1)!.params[1]).toEqual({ blockHash, requireCanonical: true });
  });

  it("T8 front-run: reverted send with the clone there is ready", async () => {
    const { fx, chain, args } = await setup();
    chain.state.receipts = ["reverted"];
    chain.state.afterSend = () => chain.state.code.set(fx.escrow.toLowerCase(), cloneRuntime(IMPLEMENTATION));
    expect(await ensureEscrow(args)).toMatchObject({ outcome: "ready", create: { kind: "mined", status: "reverted" }, code: { kind: "clone" } });
    expect(chain.sends()).toHaveLength(1);
  });

  it("T9 reverted with no clone is absent and resolves", async () => {
    const { chain, args } = await setup();
    chain.state.receipts = ["reverted"];
    expect(await ensureEscrow(args)).toMatchObject({ outcome: "absent", create: { kind: "mined", status: "reverted" }, code: { kind: "absent" } });
    expect(chain.sends()).toHaveLength(1);
  });

  it("T10 no receipt is indeterminate and a pending retry sends nothing more", async () => {
    const { chain, args } = await setup();
    chain.state.receipts = ["none"];
    expect(await ensureEscrow({ ...args, receiptTimeoutMs: 200 })).toMatchObject({ outcome: "indeterminate", create: { kind: "unknown" } });
    await expect(ensureEscrow(args)).rejects.toMatchObject({ code: "PAYER_TX_PENDING" });
    expect(chain.sends()).toHaveLength(1);
  });

  it("T11 code decides, including absent and other code after a successful receipt", async () => {
    const before = await setup();
    before.chain.state.code.set(before.fx.escrow.toLowerCase(), "0x6080");
    await expect(ensureEscrow(before.args)).rejects.toMatchObject({ code: "DEPLOYMENT_MISMATCH" });
    expect(before.chain.sends()).toEqual([]);
    for (const [code, kind] of [["0x6080", "other"], ["0x", "absent"]] as const) {
      const { fx, chain, args } = await setup();
      chain.state.afterSend = () => code === "0x" ? chain.state.code.delete(fx.escrow.toLowerCase()) : chain.state.code.set(fx.escrow.toLowerCase(), code);
      expect(await ensureEscrow(args)).toMatchObject({ outcome: "indeterminate", create: { kind: "mined", status: "success" }, code: { kind } });
    }
  });

  it.each([
    ["NOT_PREPARED", "copy"], ["PAYER_NOT_SIGNER", "signer"], ["CHAIN_MISMATCH", "walletChain"],
    ["CHAIN_MISMATCH", "readChain"], ["EXPIRY_TOO_SOON", "expiry"], ["RECLAIM_WINDOW", "reclaim"],
    ["ALREADY_FUNDED", "funded"], ["PAYER_TX_PENDING", "pending"], ["SIMULATION_REVERTED", "revert"],
    ["DEPLOYMENT_MISMATCH", "emptyReturn"], ["ESCROW_NOT_PREDICTED", "wrongReturn"],
    ["LIVE_CHECK_FAILED", "failCode"], ["LIVE_CHECK_FAILED", "failBlocks"],
  ])("T12 pre-send refusal %s (%s) sends nothing", async (code, scenario) => {
    const { fx, chain, args } = await setup(scenario === "reclaim" ? { expiry: NOW + 40n * DAY, reclaimAt: [NOW + 30n * DAY] } : {});
    switch (scenario) {
      case "copy": args.prepared = { ...args.prepared }; break;
      case "signer": args.wallet = chain.wallet(newAccount()); break;
      case "walletChain": chain.state.walletChainId = 1; break;
      case "readChain": chain.state.chainId = 1; break;
      case "expiry": chain.state.block.timestamp = fx.expiry - 300n + 1n; break;
      case "reclaim": chain.state.block.timestamp = NOW + 20n * DAY + 1n; break;
      case "funded": chain.state.fundedEscrow = OTHER; break;
      case "pending": chain.state.mempool = 1; break;
      case "revert": chain.on(fx.factory, FACTORY_CREATE_ABI, "createEscrow", () => revertWith(encodeErrorResult({ abi: parseAbi(["error CloneCreationFailed()"]), errorName: "CloneCreationFailed" }))); break;
      case "emptyReturn": chain.state.handlers.set(createKey(fx.factory), () => "0x"); break;
      case "wrongReturn": chain.state.handlers.set(createKey(fx.factory), () => encodeFunctionResult({ abi: FACTORY_CREATE_ABI, functionName: "createEscrow", result: OTHER })); break;
      case "failCode": chain.state.failCode = true; break;
      case "failBlocks": chain.state.failBlocks = true; break;
    }
    await expect(ensureEscrow(args)).rejects.toMatchObject({ code });
    expect(chain.sends()).toEqual([]);
  });

  const hash = keccak256(stringToHex("ns5:transaction"));
  const sends: Array<[string, SendResult | undefined]> = [
    ["undefined", undefined], ["not_sent", { kind: "not_sent", reason: "refused" }],
    ["unknown with hash", { kind: "unknown", txHash: hash, reason: "timeout" }],
    ["unknown without hash", { kind: "unknown", reason: "transport" }],
    ["mined success", { kind: "mined", txHash: hash, status: "success", blockHash: hash }],
    ["mined reverted", { kind: "mined", txHash: hash, status: "reverted", blockHash: hash }],
  ];
  const table = [
    ["ready", "absent", "indeterminate", "indeterminate"],
    ["ready", "absent", "indeterminate", "indeterminate"],
    ["ready", "indeterminate", "indeterminate", "indeterminate"],
    ["ready", "indeterminate", "indeterminate", "indeterminate"],
    ["ready", "indeterminate", "indeterminate", "indeterminate"],
    ["ready", "absent", "indeterminate", "indeterminate"],
  ];
  it.each(sends.flatMap(([label, send], i) => (["clone", "absent", "other", "unreadable"] as const)
    .map((kind, j) => ({ label, send, kind, expected: table[i]![j] }))))("T13 classify $label / $kind", ({ send, kind, expected }) => {
    expect(classifyEscrowCreation(send, kind)).toBe(expected);
  });

  it("T14 prepare, ensure, approve and fund in that order", async () => {
    const { fx, chain, prepared, args } = await setup();
    expect((await ensureEscrow(args)).outcome).toBe("ready");
    chain.state.afterSend = index => {
      if (index === 2) {
        chain.on(fx.escrow, ESCROW_ABI, "policy", () => [fx.operator.address, 1n, prepared.prePolicyRoot, prepared.jobPolicyHash, fx.message.acceptedPolicyDigest]);
        chain.state.fundedEscrow = fx.escrow;
      }
    };
    expect((await approveAndFund(args)).outcome).toBe("committed");
    expect(chain.state.sent.map(x => x.to.toLowerCase())).toEqual([fx.factory, fx.usdc, fx.escrow].map(x => x.toLowerCase()));
    expect(chain.state.sent.map(x => x.data.slice(0, 10))).toEqual(["0x886deb02", "0x095ea7b3", "0x7976bcc7"]);
  });

  it("T15 a failed code read after send resolves indeterminate", async () => {
    const { chain, args } = await setup();
    chain.state.afterSend = () => { chain.state.failCode = true; };
    expect(await ensureEscrow(args)).toMatchObject({ outcome: "indeterminate", code: { kind: "unreadable" } });
    expect(chain.sends()).toHaveLength(1);
  });

  it("T16 the frozen identity is exactly what predictEscrow received", async () => {
    const { fx, chain, prepared } = await setup();
    expect(Object.isFrozen(prepared.identity)).toBe(true);
    const call = chain.state.log.find(x => x.method === "eth_call" && (x.params[0] as { data: Hex }).data.startsWith("0xa5b0de55"))!;
    const [identity] = decodeFunctionData({ abi: FACTORY_PREDICT_ABI, data: (call.params[0] as { data: Hex }).data }).args!;
    expect(prepared.identity).toEqual(identity);
    expect(predictEscrow(fx.factory, IMPLEMENTATION, policySalt(prepared.identity)).toLowerCase()).toBe(prepared.escrow.toLowerCase());
  });
});
