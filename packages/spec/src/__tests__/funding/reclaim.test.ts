import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeFunctionData, encodeErrorResult, getAbiItem, keccak256, parseAbi, stringToHex, toFunctionSelector, zeroHash,
  type Address, type Hex,
} from "viem";
import {
  FundingRefusal, classifyReclaim, readUnitStates, reclaimUnits, UNIT_STATE_NAMES,
  type FundingRefusalCode, type ReclaimUnitsArgs, type SendResult,
} from "../../funding/index.js";
import { ESCROW_ABI } from "../../funding/vnext.js";
import { NOW, OTHER, buildFixture, makeChain, revertWith, testPins, type FixtureOptions } from "./fixture.js";

// Copied from the Solidity declarations, independently of the SDK ABI used to make the calls.
const CONTRACT_ABI = parseAbi([
  "function payer() view returns (address)",
  "function unitCount() view returns (uint256)",
  "function unitIdAt(uint256 index) view returns (bytes32)",
  "function unitState(bytes32 unitId) view returns (uint8)",
  "function unitTerms(bytes32 unitId) view returns (uint256 milestoneIndex_, bytes32 stepId_, uint8 requestedTier_, uint256 reclaimAt_, bytes32 payoutConfigHash_, uint16 compositionSchemaVersion_, bool evidenceCommitted_)",
  "function reclaimAfterDeadline(bytes32 unitId)",
  "error UnitNotFound()",
  "error NotActive()",
  "error TooEarlyToReclaim()",
]);
const error = (errorName: "UnitNotFound" | "NotActive" | "TooEarlyToReclaim"): never =>
  revertWith(encodeErrorResult({ abi: CONTRACT_ABI, errorName }));
const hash = (s: string) => keccak256(stringToHex(s));
const TX = hash("reclaim tx");
const BLOCK = hash("reclaim block");

async function refusal(p: Promise<unknown>, code: FundingRefusalCode, detail?: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(FundingRefusal);
    expect((e as FundingRefusal).code).toBe(code);
    if (detail) expect((e as FundingRefusal).detail).toContain(detail);
    return;
  }
  throw new Error(`expected refusal ${code}`);
}

async function setup(options: FixtureOptions = {}) {
  const fx = await buildFixture({ reclaimAt: [NOW - 2n, NOW - 1n], ...options });
  const chain = makeChain(fx, { escrowCode: true });
  const states = fx.unitIds.map(() => 1);
  const indexOf = (id: unknown) => {
    const index = fx.unitIds.findIndex((known) => known.toLowerCase() === String(id).toLowerCase());
    if (index < 0) error("UnitNotFound");
    return index;
  };
  chain.on(fx.escrow, CONTRACT_ABI, "payer", () => fx.payer.address);
  chain.on(fx.escrow, CONTRACT_ABI, "unitCount", () => BigInt(fx.unitIds.length));
  chain.on(fx.escrow, CONTRACT_ABI, "unitIdAt", ([i]) => fx.unitIds[Number(i)]);
  chain.on(fx.escrow, CONTRACT_ABI, "unitState", ([id]) => states[indexOf(id)]);
  chain.on(fx.escrow, CONTRACT_ABI, "unitTerms", ([id]) => {
    const config = fx.configs[indexOf(id)]!;
    return [config.milestoneIndex, config.stepId, config.requestedTier, config.reclaimAt, zeroHash, config.compositionSchemaVersion, false];
  });
  chain.on(fx.escrow, CONTRACT_ABI, "reclaimAfterDeadline", ([id]) => {
    const i = indexOf(id);
    if (states[i] !== 1) error("NotActive");
    if (chain.state.block.timestamp < fx.configs[i]!.reclaimAt) error("TooEarlyToReclaim");
    return undefined;
  });
  const args: ReclaimUnitsArgs = { wallet: chain.wallet(), publicClient: chain.publicClient,
    chainId: fx.chainId, escrow: fx.escrow, pins: testPins(fx), unitIds: fx.unitIds, receiptTimeoutMs: 100 };
  const readArgs = { publicClient: chain.publicClient, chainId: fx.chainId, escrow: fx.escrow, pins: testPins(fx) };
  const simulated = () => chain.state.log.filter((x) => x.method === "eth_call" &&
    (x.params[0] as { from?: string }).from?.toLowerCase() === fx.payer.address.toLowerCase());
  const settle = (state = 9) => {
    chain.state.afterSend = (i) => {
      const tx = chain.state.sent[i]!;
      const decoded = decodeFunctionData({ abi: CONTRACT_ABI, data: tx.data });
      states[indexOf(decoded.args![0])] = state;
      chain.advanceBlock();
    };
  };
  return { fx, chain, states, args, readArgs, simulated, settle };
}

describe("buyer reclaim and unit reads", () => {
  it("R1 refuses at reclaimAt minus one before any simulation or send", async () => {
    const { args, chain, simulated } = await setup({ reclaimAt: [NOW + 1n] });
    await refusal(reclaimUnits(args), "NOT_RECLAIMABLE", `${NOW + 1n}`);
    expect(chain.sends()).toHaveLength(0);
    expect(simulated()).toHaveLength(0);
  });

  it.each([0, 2, 3, 4, 5, 6, 7, 8, 9])("R2 refuses non-active state %s", async (state) => {
    const { args, chain, states } = await setup();
    states[0] = state;
    await refusal(reclaimUnits(args), "UNIT_NOT_ACTIVE", UNIT_STATE_NAMES[state]);
    expect(chain.sends()).toHaveLength(0);
  });

  it("R3 past reclaimAt, one transaction per unit, outcomes per unit", async () => {
    const { args, chain, fx, simulated, settle } = await setup();
    settle();
    const pin = { ...chain.state.block };
    const unitIds = [...fx.unitIds].reverse();
    const result = await reclaimUnits({ ...args, unitIds });
    expect(result.checkedAt).toEqual({ blockNumber: pin.number, blockHash: pin.hash, blockTimestamp: pin.timestamp });
    expect(chain.sends()).toHaveLength(2);
    expect(simulated()).toHaveLength(2);
    const firstSend = chain.state.log.findIndex((x) => x.method === "eth_sendRawTransaction");
    for (const call of simulated()) {
      expect(chain.state.log.indexOf(call)).toBeLessThan(firstSend);
      expect(call.params[1]).toEqual({ blockHash: pin.hash, requireCanonical: true });
      expect((call.params[0] as { from: Address }).from.toLowerCase()).toBe(fx.payer.address.toLowerCase());
    }
    for (let i = 0; i < 2; i++) {
      const tx = chain.state.sent[i]!;
      expect(tx.to.toLowerCase()).toBe(fx.escrow.toLowerCase());
      expect(decodeFunctionData({ abi: CONTRACT_ABI, data: tx.data })).toEqual({ functionName: "reclaimAfterDeadline", args: [unitIds[i]] });
      expect((simulated()[i]!.params[0] as { data: Hex }).data).toBe(tx.data);
      expect(result.results[i]).toMatchObject({ unitId: unitIds[i], outcome: "reclaimed", refunded: true,
        txHash: tx.hash, send: { kind: "mined", status: "success", blockHash: tx.block.hash },
        readBack: { state: 9, stateName: "SETTLED_REFUNDED", blockNumber: tx.block.number, blockHash: tx.block.hash } });
      const sendIndex = chain.state.log.indexOf(chain.sends()[i]!);
      const read = chain.state.log.slice(sendIndex + 1).find((x) => x.method === "eth_call" &&
        (x.params[0] as { data: Hex }).data === toFunctionSelector("unitState(bytes32)") + unitIds[i]!.slice(2));
      expect(read?.params[1]).toEqual({ blockHash: tx.block.hash, requireCanonical: true });
    }
    expect(result.results[0]!.readBack.blockHash).not.toBe(result.results[1]!.readBack.blockHash);
  });

  it("R4 equality with reclaimAt is reclaimable", async () => {
    const { args, chain, settle } = await setup({ reclaimAt: [NOW] });
    settle();
    expect((await reclaimUnits(args)).results[0]).toMatchObject({ outcome: "reclaimed", refunded: true });
    expect(chain.sends()).toHaveLength(1);
  });

  it("R5 one unit too early refuses the whole call", async () => {
    const { args, chain, simulated } = await setup({ reclaimAt: [NOW - 1n, NOW + 1n] });
    await refusal(reclaimUnits(args), "NOT_RECLAIMABLE");
    expect(chain.sends()).toHaveLength(0);
    expect(simulated()).toHaveLength(0);
  });

  it("R6 an id outside unitIdAt membership refuses before sending", async () => {
    const { args, chain } = await setup();
    await refusal(reclaimUnits({ ...args, unitIds: [hash("unknown unit")] }), "UNIT_NOT_ACTIVE");
    expect(chain.sends()).toHaveLength(0);
  });

  it.each([
    ["another payer", "PAYER_NOT_SIGNER"], ["no code", "ESCROW_NOT_CREATED"],
    ["other code", "DEPLOYMENT_MISMATCH"], ["no factory pin", "FACTORY_NOT_PINNED"],
    ["accountless wallet", "PAYER_NOT_SIGNER"],
  ] as const)("R7 hostile target: %s", async (row, code) => {
    const { args, chain, fx } = await setup();
    if (row === "another payer") chain.on(fx.escrow, CONTRACT_ABI, "payer", () => OTHER);
    if (row === "no code") chain.state.code.delete(fx.escrow.toLowerCase());
    if (row === "other code") chain.state.code.set(fx.escrow.toLowerCase(), "0x6080");
    if (row === "no factory pin") args.pins = undefined;
    if (row === "accountless wallet") args.wallet = chain.accountless();
    await refusal(reclaimUnits(args), code);
    expect(chain.sends()).toHaveLength(0);
  });

  it.each([
    ["wallet chain", "CHAIN_MISMATCH"], ["read chain", "CHAIN_MISMATCH"],
    ["pending nonce", "PAYER_TX_PENDING"], ["simulation", "SIMULATION_REVERTED"],
    ["failBlocks", "LIVE_CHECK_FAILED"], ["failCalls", "LIVE_CHECK_FAILED"],
    ["failCode", "LIVE_CHECK_FAILED"], ["failChainId", "LIVE_CHECK_FAILED"], ["failNonce", "LIVE_CHECK_FAILED"],
    ["too many escrow units", "LIVE_CHECK_FAILED"],
    ["empty ids", "BAD_EXPECTATION"], ["duplicate ids", "BAD_EXPECTATION"],
    ["sparse ids", "BAD_EXPECTATION"],
    ["case duplicate ids", "BAD_EXPECTATION"], ["31 byte id", "BAD_EXPECTATION"], ["17 ids", "BAD_EXPECTATION"],
    ["zero confirmations", "BAD_EXPECTATION"], ["fractional confirmations", "BAD_EXPECTATION"],
    ["null confirmations", "BAD_EXPECTATION"], ["null timeout", "BAD_EXPECTATION"],
    ["zero timeout", "BAD_EXPECTATION"], ["infinite timeout", "BAD_EXPECTATION"],
    ["invalid chainId", "BAD_EXPECTATION"], ["invalid escrow", "BAD_EXPECTATION"], ["invalid pin", "PIN_INVALID"],
  ] as const)("R8 other pre-send refusal: %s", async (row, code) => {
    const { args, chain, fx } = await setup();
    if (row === "wallet chain") chain.state.walletChainId++;
    if (row === "read chain") chain.state.chainId++;
    if (row === "pending nonce") chain.state.mempool = 1;
    if (row === "simulation") chain.on(fx.escrow, CONTRACT_ABI, "reclaimAfterDeadline", () => error("TooEarlyToReclaim"));
    if (row === "failBlocks" || row === "failCalls" || row === "failCode" || row === "failChainId" || row === "failNonce") chain.state[row] = true;
    if (row === "too many escrow units") chain.on(fx.escrow, CONTRACT_ABI, "unitCount", () => 17n);
    if (row === "empty ids") args.unitIds = [];
    if (row === "sparse ids") args.unitIds = new Array(1);
    if (row === "duplicate ids") args.unitIds = [fx.unitIds[0]!, fx.unitIds[0]!];
    if (row === "case duplicate ids") args.unitIds = [fx.unitIds[0]!, `0x${fx.unitIds[0]!.slice(2).toUpperCase()}`];
    if (row === "31 byte id") args.unitIds = [`0x${"ab".repeat(31)}`];
    if (row === "17 ids") args.unitIds = Array.from({ length: 17 }, (_, i) => hash(`unit ${i}`));
    if (row === "zero confirmations") args.confirmations = 0;
    if (row === "fractional confirmations") args.confirmations = 1.5;
    if (row === "null confirmations") args.confirmations = null as never;
    if (row === "null timeout") args.receiptTimeoutMs = null as never;
    if (row === "zero timeout") args.receiptTimeoutMs = 0;
    if (row === "infinite timeout") args.receiptTimeoutMs = Infinity;
    if (row === "invalid chainId") args.chainId = 0n;
    if (row === "invalid escrow") args.escrow = "0x1234";
    if (row === "invalid pin") args.pins = { [fx.chainId.toString()]: { factory: "0x1234" } };
    await refusal(reclaimUnits(args), code, row === "simulation" ? "TooEarlyToReclaim" : undefined);
    expect(chain.sends()).toHaveLength(0);
    if (code === "BAD_EXPECTATION" || code === "PIN_INVALID") expect(chain.state.log).toHaveLength(0);
    if (row === "pending nonce") {
      expect(chain.state.log.filter((x) => x.method === "eth_getTransactionCount").map((x) => x.params[1])).toEqual(["pending", "latest"]);
    }
  });

  it("R9 an unresolved send stops later sends and a retry refuses while pending", async () => {
    const { args, chain } = await setup();
    chain.state.receipts = ["none"];
    const result = await reclaimUnits(args);
    expect(result.results[0]).toMatchObject({ outcome: "indeterminate", send: { kind: "unknown" }, refunded: false });
    expect(result.results[1]).toMatchObject({ outcome: "unchanged", refunded: false, send: { kind: "not_sent",
      reason: "not sent: an earlier reclaim in this call is unresolved" }, readBack: { state: 1, blockHash: chain.state.block.hash } });
    expect(chain.sends()).toHaveLength(1);
    await refusal(reclaimUnits(args), "PAYER_TX_PENDING");
    expect(chain.sends()).toHaveLength(1);
  });

  it.each([[1, "unchanged"], [9, "reclaimed"]] as const)("R10 reverted receipt with read state %s is %s", async (state, outcome) => {
    const { args, chain, settle } = await setup({ reclaimAt: [NOW - 1n] });
    chain.state.receipts = ["reverted"];
    settle(state);
    expect((await reclaimUnits(args)).results[0]).toMatchObject({ outcome, refunded: state === 9, send: { kind: "mined", status: "reverted" } });
    expect(chain.sends()).toHaveLength(1);
  });

  it("R9 a wallet chain change after the first send returns the later refusal", async () => {
    const { args, chain, states } = await setup();
    chain.state.afterSend = () => { states[0] = 9; chain.state.walletChainId++; };
    const result = await reclaimUnits(args);
    expect(result.results[0]).toMatchObject({ outcome: "reclaimed", refunded: true });
    expect(result.results[1]).toMatchObject({ outcome: "unchanged", send: { kind: "not_sent" }, readBack: { state: 1 } });
    expect(chain.sends()).toHaveLength(1);
  });

  it("R9 unreadable state after broadcast is returned as indeterminate", async () => {
    const { args, chain } = await setup({ reclaimAt: [NOW - 1n] });
    chain.state.afterSend = () => { chain.state.failCalls = true; };
    const result = await reclaimUnits(args);
    expect(result.results[0]).toMatchObject({ outcome: "indeterminate", refunded: false,
      send: { kind: "mined", status: "success" }, readBack: { state: null, stateName: null } });
    expect(chain.sends()).toHaveLength(1);
  });

  it("R11 an allocated claim is reclaimed but not yet refunded", async () => {
    const { args, settle } = await setup({ reclaimAt: [NOW - 1n] });
    settle(7);
    expect((await reclaimUnits(args)).results[0]).toMatchObject({ outcome: "reclaimed", refunded: false,
      readBack: { state: 7, stateName: "REFUND_ALLOCATED" } });
  });

  const sends: Record<string, SendResult> = {
    not_sent: { kind: "not_sent", reason: "not sent" }, unknown: { kind: "unknown", txHash: TX, reason: "no receipt" },
    success: { kind: "mined", txHash: TX, status: "success", blockHash: BLOCK },
    reverted: { kind: "mined", txHash: TX, status: "reverted", blockHash: BLOCK },
  };
  it.each([
    ["not_sent", 1, "unchanged"], ["not_sent", 7, "reclaimed"], ["not_sent", 9, "reclaimed"],
    ["not_sent", 2, "indeterminate"], ["not_sent", "unreadable", "indeterminate"],
    ["unknown", 1, "indeterminate"], ["unknown", 7, "reclaimed"], ["unknown", 9, "reclaimed"],
    ["unknown", 2, "indeterminate"], ["unknown", "unreadable", "indeterminate"],
    ["success", 1, "indeterminate"], ["success", 7, "reclaimed"], ["success", 9, "reclaimed"],
    ["success", 2, "indeterminate"], ["success", "unreadable", "indeterminate"],
    ["reverted", 1, "unchanged"], ["reverted", 7, "reclaimed"], ["reverted", 9, "reclaimed"],
    ["reverted", 2, "indeterminate"], ["reverted", "unreadable", "indeterminate"],
  ] as const)("R12 classify %s + %s -> %s", (send, state, outcome) => {
    expect(classifyReclaim(sends[send]!, state)).toBe(outcome);
  });

  it("R13 reads every unit and its deadline at one hash, including unknown states", async () => {
    const { readArgs, chain, fx, states } = await setup({ reclaimAt: [NOW, NOW + 1n, NOW - 1n] });
    states[2] = 12;
    const pin = { ...chain.state.block };
    chain.advanceBlock();
    const read = await readUnitStates({ ...readArgs, blockHash: pin.hash });
    expect(read).toEqual({ kind: "read", escrow: fx.escrow, payer: fx.payer.address,
      blockNumber: pin.number, blockHash: pin.hash, blockTimestamp: pin.timestamp,
      units: [
        { unitId: fx.unitIds[0], state: 1, stateName: "FUNDED_ACTIVE", reclaimAt: NOW, reclaimable: true },
        { unitId: fx.unitIds[1], state: 1, stateName: "FUNDED_ACTIVE", reclaimAt: NOW + 1n, reclaimable: false },
        { unitId: fx.unitIds[2], state: 12, stateName: "UNKNOWN", reclaimAt: NOW - 1n, reclaimable: false },
      ] });
    const calls = chain.state.log.filter((x) => x.method === "eth_call" || x.method === "eth_getCode");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.params[1]).toEqual({ blockHash: pin.hash, requireCanonical: true });
    chain.state.failCalls = true;
    await expect(readUnitStates(readArgs)).resolves.toMatchObject({ kind: "unreadable" });
    expect(chain.sends()).toHaveLength(0);
  });

  it.each(["failBlocks", "failCode", "failCalls", "too many units"] as const)("R13 unreadable RPC or count: %s", async (row) => {
    const { readArgs, chain, fx } = await setup();
    if (row === "too many units") chain.on(fx.escrow, CONTRACT_ABI, "unitCount", () => 17n);
    else chain.state[row] = true;
    await expect(readUnitStates(readArgs)).resolves.toMatchObject({ kind: "unreadable", escrow: fx.escrow,
      blockNumber: row === "failBlocks" ? null : chain.state.block.number,
      blockHash: row === "failBlocks" ? null : chain.state.block.hash });
  });

  it.each([
    ["bad chain", "BAD_EXPECTATION"], ["bad escrow", "BAD_EXPECTATION"], ["bad block hash", "BAD_EXPECTATION"],
    ["no factory pin", "FACTORY_NOT_PINNED"], ["bad pin", "PIN_INVALID"], ["wrong chain", "CHAIN_MISMATCH"],
    ["chain unavailable", "LIVE_CHECK_FAILED"], ["no code", "ESCROW_NOT_CREATED"], ["other code", "DEPLOYMENT_MISMATCH"],
  ] as const)("R13 deterministic refusal: %s", async (row, code) => {
    const { readArgs, chain, fx } = await setup();
    let blockHash: Hex | undefined;
    if (row === "bad chain") readArgs.chainId = 0n;
    if (row === "bad escrow") readArgs.escrow = "0x1234";
    if (row === "bad block hash") blockHash = "0x1234";
    if (row === "no factory pin") readArgs.pins = undefined as never;
    if (row === "bad pin") readArgs.pins = { [fx.chainId.toString()]: { factory: "0x1234" as Address } } as never;
    if (row === "wrong chain") chain.state.chainId++;
    if (row === "chain unavailable") chain.state.failChainId = true;
    if (row === "no code") chain.state.code.delete(fx.escrow.toLowerCase());
    if (row === "other code") chain.state.code.set(fx.escrow.toLowerCase(), "0x6080");
    await refusal(readUnitStates({ ...readArgs, blockHash }), code);
    if (["BAD_EXPECTATION", "FACTORY_NOT_PINNED", "PIN_INVALID"].includes(code)) expect(chain.state.log).toHaveLength(0);
  });

  it("R14 SDK selectors equal the frozen golden vectors", () => {
    const contracts = new URL("../../../../contracts/", import.meta.url);
    const golden = JSON.parse(readFileSync(new URL("test/fixtures/vnext-golden/vnext-golden-vectors.json", contracts), "utf8"));
    expect(toFunctionSelector(getAbiItem({ abi: ESCROW_ABI, name: "reclaimAfterDeadline" })))
      .toBe(golden.selectors["reclaimAfterDeadline(bytes32)"]);
    expect(toFunctionSelector(getAbiItem({ abi: ESCROW_ABI, name: "unitTerms" })))
      .toBe(golden.selectors["unitTerms(bytes32)"]);
  });
});
