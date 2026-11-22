import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@pcc/spec/funding";
import { erc20Abi, zeroHash, type Address, type PublicClient, type WalletClient } from "viem";
import inputs from "../../../../packages/gateway/src/__tests__/fixtures/vnext-dry-run-prepare-v1.inputs.json";
import payload from "../../../../packages/gateway/src/__tests__/fixtures/vnext-dry-run-prepare-v1.payload.json";
import { buildSubject, checkOrder, fundOrder, runningFlight, type CheckOrderInput, type CheckedOrder, type FundOrderInput } from "../lib/fund-send.js";

vi.mock("@pcc/spec/funding", async (original) => {
  const real = await original<typeof sdk>();
  return Object.fromEntries(Object.entries(real).map(([name, value]) => [name,
    typeof value === "function" && name !== "FundingRefusal" ? vi.fn(value as (...args: unknown[]) => unknown) : value]));
});
const payer = inputs.payer as Address, operator = inputs.operator as Address;
const identity = { jobId: inputs.jobId, address: payer, sessionToken: "session" };
const prepared = {
  payer, operator, escrow: payload.escrow, usdc: payload.usdc, totalGross: 1_000_000n,
  expiry: BigInt(payload.expiry), reclaimAt: { earliest: 1_800_007_200n, latest: 1_800_007_200n },
  verifiedAt: { blockNumber: 42n, blockHash: zeroHash, blockTimestamp: 1_800_000_000n },
} as unknown as sdk.PreparedFunding;
const display = {
  amount: "1 test USDC", escrow: prepared.escrow, operator,
  fundBy: new Date(Number(prepared.expiry - sdk.DEFAULT_MARGIN_SECONDS) * 1000).toISOString(),
  refundableFrom: new Date(Number(prepared.reclaimAt.earliest) * 1000).toISOString(), checkedAtBlock: "42",
};
const checked: CheckedOrder = { kind: "checked", prepared, display };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { resolve, promise };
}
let readOperator: ReturnType<typeof vi.fn<[], Promise<unknown>>>;
let getChainId: ReturnType<typeof vi.fn<[], Promise<number>>>;
let getBlock: ReturnType<typeof vi.fn<[], Promise<{ timestamp: bigint }>>>;
let getCode: ReturnType<typeof vi.fn<[], Promise<string | undefined>>>;
let readContract: ReturnType<typeof vi.fn<[], Promise<bigint>>>;
let args: CheckOrderInput, send: FundOrderInput;
const ready = (create?: { kind: string }) => ({ outcome: "ready", ...(create ? { create } : {}) }) as sdk.EnsureEscrowResult;
const outcome = (value: string, alreadyFunded?: boolean) => ({ outcome: value, alreadyFunded }) as sdk.FundingResult;
const state = (kind: string) => ({ kind }) as sdk.FundedState;
beforeEach(() => {
  vi.clearAllMocks();
  readOperator = vi.fn<[], Promise<unknown>>(async () => operator);
  getChainId = vi.fn(async () => 84532);
  getBlock = vi.fn(async () => ({ timestamp: 1_800_000_000n }));
  getCode = vi.fn<[], Promise<string | undefined>>(async () => "0x1234"); readContract = vi.fn(async () => 1_000_000n);
  const walletClient = { account: { address: payer }, getChainId } as unknown as WalletClient;
  const publicClient = { getBlock, getCode, readContract } as unknown as PublicClient;
  args = { scopeId: "scope", identity, payload, walletClient, publicClient, readOperator };
  send = { scopeId: "scope", identity, checked, walletClient, publicClient };
  vi.mocked(sdk.prepareFunding).mockResolvedValue(prepared);
  vi.mocked(sdk.readFundedState).mockResolvedValue(state("unfunded"));
  vi.mocked(sdk.ensureEscrow).mockResolvedValue(ready());
  vi.mocked(sdk.approveAndFund).mockResolvedValue(outcome("committed"));
});
afterEach(() => {
  expect(runningFlight("scope")).toBeUndefined();
  vi.useRealTimers();
});

describe("independent order check", () => {
  it("C23: exact call shape and independent intent, even with hostile served fields", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_900_000_000_000);
    const hostile = { ...payload, totalGross: "2000000", operator: "0x2222222222222222222222222222222222222222",
      typedData: { ...payload.typedData, message: { ...payload.typedData.message,
        operator: "0x2222222222222222222222222222222222222222", payer: "0x3333333333333333333333333333333333333333" } } };
    const result = await checkOrder({ ...args, payload: hostile });
    expect(result).toEqual(checked);
    const call = vi.mocked(sdk.prepareFunding).mock.calls[0]![0];
    expect(Object.keys(call).sort()).toEqual(["expect", "payload", "publicClient", "quote", "wallet"]);
    expect(call.payload).toBe(hostile);
    expect(call).toMatchObject({ payload: hostile, wallet: args.walletClient, publicClient: args.publicClient, quote: { maxTotalGross: 1_000_000n } });
    expect(sdk.dryRunUnitTestnetExpectation).toHaveBeenCalledWith({ jobId: identity.jobId, operator,
      fundingWallet: payer, latestBlockTimestamp: 1_800_000_000n, subject: buildSubject(payer, operator), bindings: [] });
    expect(vi.mocked(sdk.dryRunUnitTestnetExpectation).mock.calls[0]![0].subject.payer).toBe(sdk.dryRunUnitPrincipalWord(payer));
    expect(readOperator.mock.invocationCallOrder[0]).toBeLessThan(getChainId.mock.invocationCallOrder[0]!);
    expect(getChainId.mock.invocationCallOrder[0]).toBeLessThan(getBlock.mock.invocationCallOrder[0]!);
    expect(getCode).toHaveBeenCalledWith({ address: prepared.escrow, blockTag: "latest" });
    expect(readContract).toHaveBeenCalledWith({ address: prepared.usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer], blockTag: "latest" });
    expect(sdk.ensureEscrow).not.toHaveBeenCalled(); expect(sdk.approveAndFund).not.toHaveBeenCalled();
  });
  it("C23: explicit e2e inputs are used as given, and skip block and builder", async () => {
    getChainId.mockResolvedValue(31337);
    const expectInput = { jobId: "e2e" } as sdk.FundingExpectations;
    const pins = { "31337": { factory: operator, usdc: payer } };
    expect(await checkOrder({ ...args, chainId: 31337, pins, expect: expectInput })).toEqual(checked);
    expect(sdk.prepareFunding).toHaveBeenCalledWith({ payload, wallet: args.walletClient, publicClient: args.publicClient,
      quote: { maxTotalGross: 1_000_000n }, expect: expectInput, pins });
    expect(vi.mocked(sdk.prepareFunding).mock.calls[0]![0].expect).toBe(expectInput);
    expect(getBlock).not.toHaveBeenCalled(); expect(sdk.dryRunUnitTestnetExpectation).not.toHaveBeenCalled();
    expect(await checkOrder({ ...args, chainId: 84532 })).toEqual({ kind: "label", label: "L16" });
  });
  it("operator rejection is preserved, invalid operator and read failures stop in order", async () => {
    const reason = { own: "read reason" };
    readOperator.mockRejectedValueOnce(reason);
    expect(await checkOrder(args)).toEqual({ kind: "read_failed", reason }); expect(getChainId).not.toHaveBeenCalled();
    readOperator.mockResolvedValueOnce("0x123");
    expect(await checkOrder(args)).toEqual({ kind: "label", label: "L23" }); expect(getChainId).not.toHaveBeenCalled();
    getChainId.mockRejectedValueOnce(new Error("hidden"));
    expect(await checkOrder(args)).toEqual({ kind: "label", label: "L15" }); expect(getBlock).not.toHaveBeenCalled();
    getBlock.mockRejectedValueOnce(new Error("hidden"));
    expect(await checkOrder(args)).toEqual({ kind: "label", label: "L15" }); expect(sdk.prepareFunding).not.toHaveBeenCalled();
    readContract.mockRejectedValueOnce(new Error("hidden"));
    expect(await checkOrder(args)).toEqual({ kind: "label", label: "L15" });
  });
  it("C25: no code skips the funded read and reaches the balance; a code failure stops", async () => {
    for (const code of [undefined, "0x"]) {
      getCode.mockResolvedValueOnce(code);
      expect(await checkOrder(args)).toEqual(checked);
      expect(sdk.readFundedState).not.toHaveBeenCalled();
    }
    expect(readContract).toHaveBeenCalledTimes(2);
    getCode.mockRejectedValueOnce(new Error("hidden"));
    expect(await checkOrder(args)).toEqual({ kind: "label", label: "L15" });
    expect(readContract).toHaveBeenCalledTimes(2);
  });
  it.each([["unfunded", null], ["funded_ours", "L18"], ["other", "L2"], ["unreadable", "L15"]])(
    "C25: with code, %s", async (kind, label) => {
      vi.mocked(sdk.readFundedState).mockResolvedValue(state(kind!));
      expect(await checkOrder(args)).toEqual(label ? { kind: "label", label } : checked);
      expect(sdk.readFundedState).toHaveBeenCalledWith({ publicClient: args.publicClient, prepared });
      expect(readContract).toHaveBeenCalledTimes(label ? 0 : 1);
    },
  );
  it("C25: a funded read throw uses the refusal map", async () => {
    vi.mocked(sdk.readFundedState).mockRejectedValue(new sdk.FundingRefusal("PAYER_NOT_SIGNER", "hidden"));
    expect(await checkOrder(args)).toEqual({ kind: "label", label: "L5" }); expect(readContract).not.toHaveBeenCalled();
  });
  it("C36: a short balance fills both test-USDC amounts and cannot send", async () => {
    readContract.mockResolvedValue(123456n);
    expect(await checkOrder(args)).toEqual({ kind: "label", label: "L29", held: "0.123456", needed: "1" });
    expect(sdk.ensureEscrow).not.toHaveBeenCalled(); expect(sdk.approveAndFund).not.toHaveBeenCalled();
  });
});

const refusals: [sdk.FundingRefusalCode, string][] = [
  ["PAYER_NOT_SIGNER", "L5"], ["CHAIN_MISMATCH", "L16"], ["LIVE_CHECK_FAILED", "L15"],
  ["EXPIRY_TOO_SOON", "L10a"], ["RECLAIM_WINDOW", "L10a"],
  ...(["AMOUNT_EXCEEDS_QUOTE", "DEPLOYMENT_MISMATCH", "DOMAIN_MISMATCH", "ESCROW_NOT_PREDICTED", "FACTORY_NOT_PINNED", "INTENT_MISMATCH",
    "OPERATOR_SIGNATURE_INVALID", "PIN_INVALID", "POLICY_ROOT_MISMATCH", "SIGNATURE_NOT_CANONICAL", "TOKEN_NOT_PINNED", "TOTAL_GROSS_MISMATCH",
    "TYPED_DATA_MISMATCH", "ALREADY_FUNDED"] as sdk.FundingRefusalCode[]).map((code): [sdk.FundingRefusalCode, string] => [code, "L2"]),
  ["PAYER_TX_PENDING", "L31"], ["SIMULATION_REVERTED", "L34"],
  ...(["APPROVE_AMOUNT_NOT_TOTAL", "APPROVE_SPENDER_NOT_ESCROW", "BAD_EXPECTATION", "BAD_PAYLOAD", "ESCROW_NOT_CREATED", "FUND_ARGS_MISMATCH",
    "NOT_PREPARED", "NOT_RECLAIMABLE", "UNIT_NOT_ACTIVE", "X402_REFUSED"] as sdk.FundingRefusalCode[]).map((code): [sdk.FundingRefusalCode, string] => [code, "L30"]),
];
it.each(refusals)("C24: prepare refusal %s is %s", async (code, label) => {
  expect(refusals).toHaveLength(31);
  vi.mocked(sdk.prepareFunding).mockRejectedValue(new sdk.FundingRefusal(code, "hidden"));
  expect(await checkOrder(args)).toEqual({ kind: "label", label }); expect(getCode).not.toHaveBeenCalled();
});
it.each([new Error("hidden"), new sdk.FundingRefusal("FUTURE" as sdk.FundingRefusalCode, "hidden"), "hidden", null])(
  "C24: unknown thrown value %# is L30", async (error) => {
    vi.mocked(sdk.prepareFunding).mockRejectedValue(error);
    expect(await checkOrder(args)).toEqual({ kind: "label", label: "L30" });
  },
);

describe("wallet send outcomes", () => {
  it.each([["absent", "L32"], ["indeterminate", "L1"]])("ensure %s", async (value, label) => {
    vi.mocked(sdk.ensureEscrow).mockResolvedValue({ outcome: value } as sdk.EnsureEscrowResult);
    expect(await fundOrder(send)).toEqual({ kind: "label", label }); expect(sdk.approveAndFund).not.toHaveBeenCalled();
  });
  it.each([["committed", false, "L18"], ["committed", true, "L18"], ["unchanged", false, "L33"], ["indeterminate", false, "L1"]])(
    "approve outcome %s, already funded %s", async (value, already, label) => {
      vi.mocked(sdk.approveAndFund).mockResolvedValue(outcome(value as string, already as boolean));
      expect(await fundOrder(send)).toEqual({ kind: "label", label });
      const expected = { prepared, wallet: send.walletClient, publicClient: send.publicClient };
      expect(sdk.ensureEscrow).toHaveBeenCalledTimes(1); expect(sdk.ensureEscrow).toHaveBeenCalledWith(expected);
      expect(sdk.approveAndFund).toHaveBeenCalledTimes(1); expect(sdk.approveAndFund).toHaveBeenCalledWith(expected);
      expect(sdk.prepareFunding).not.toHaveBeenCalled();
    },
  );
  it("ensure throw uses the refusal map", async () => {
    vi.mocked(sdk.ensureEscrow).mockRejectedValue(new sdk.FundingRefusal("PAYER_TX_PENDING", "hidden"));
    expect(await fundOrder(send)).toEqual({ kind: "label", label: "L31" }); expect(sdk.approveAndFund).not.toHaveBeenCalled();
  });
  const afterCreate = ["PAYER_NOT_SIGNER", "LIVE_CHECK_FAILED", "ESCROW_NOT_CREATED", "DEPLOYMENT_MISMATCH", "ALREADY_FUNDED",
    "EXPIRY_TOO_SOON", "RECLAIM_WINDOW", "PAYER_TX_PENDING", "SIMULATION_REVERTED", "CHAIN_MISMATCH", "error"];
  it.each(afterCreate)("C27: post-create throw %s", async (code) => {
    const error = code === "error" ? new Error("hidden") : new sdk.FundingRefusal(code as sdk.FundingRefusalCode, "hidden");
    vi.mocked(sdk.approveAndFund).mockRejectedValue(error);
    for (const kind of ["mined", "unknown", "not_sent", undefined]) {
      vi.mocked(sdk.ensureEscrow).mockResolvedValue(ready(kind ? { kind } : undefined));
      const label = kind === "mined" || kind === "unknown" ? "L37" : refusals.find(([value]) => value === code)?.[1] ?? "L30";
      expect(await fundOrder(send)).toEqual({ kind: "label", label });
    }
  });
});

it("C31: a send is shared only by kind and full identity, and never replayed", async () => {
  const held = deferred<sdk.EnsureEscrowResult>(); vi.mocked(sdk.ensureEscrow).mockReturnValueOnce(held.promise);
  const one = fundOrder(send), two = fundOrder(send);
  expect(one).toBe(two);
  expect(runningFlight("scope")).toMatchObject({ kind: "send", identity, display });
  for (const change of [{ jobId: "other" }, { address: operator }, { sessionToken: "other" }]) {
    expect(await fundOrder({ ...send, identity: { ...identity, ...change } })).toEqual({ kind: "busy" });
  }
  expect(await checkOrder(args)).toEqual({ kind: "busy" }); expect(sdk.prepareFunding).not.toHaveBeenCalled();
  await Promise.resolve(); expect(sdk.ensureEscrow).toHaveBeenCalledTimes(1);
  held.resolve(ready());
  expect(await one).toBe(await two); expect(sdk.approveAndFund).toHaveBeenCalledTimes(1);
  expect(runningFlight("scope")).toBeUndefined();
  await fundOrder(send); expect(sdk.ensureEscrow).toHaveBeenCalledTimes(2); expect(sdk.approveAndFund).toHaveBeenCalledTimes(2);
});
it("C31: checks use the same flight rules", async () => {
  const held = deferred<Address>(); readOperator.mockReturnValueOnce(held.promise);
  const one = checkOrder(args), two = checkOrder(args);
  expect(one).toBe(two); expect(runningFlight("scope")).toMatchObject({ kind: "check", identity });
  for (const change of [{ jobId: "other" }, { address: operator }, { sessionToken: "other" }]) {
    expect(await checkOrder({ ...args, identity: { ...identity, ...change } })).toEqual({ kind: "busy" });
  }
  expect(await fundOrder(send)).toEqual({ kind: "busy" }); expect(sdk.ensureEscrow).not.toHaveBeenCalled();
  held.resolve(operator); expect(await one).toBe(await two); expect(readOperator).toHaveBeenCalledTimes(1);
  expect(sdk.prepareFunding).toHaveBeenCalledTimes(1); expect(runningFlight("scope")).toBeUndefined();
  await checkOrder(args); expect(readOperator).toHaveBeenCalledTimes(2); expect(sdk.prepareFunding).toHaveBeenCalledTimes(2);
});

it("C26: browser subject and expectation equal the gateway golden without Node builtins", async () => {
  const { computeSubjectBlockHash } = await import("@pcc/spec");
  const expectedHash = computeSubjectBlockHash(inputs.subject as Parameters<typeof computeSubjectBlockHash>[0]);
  vi.resetModules(); vi.doUnmock("@pcc/spec/funding");
  const processWithBuiltin = globalThis.process as unknown as { getBuiltinModule?: unknown };
  const original = Object.getOwnPropertyDescriptor(processWithBuiltin, "getBuiltinModule");
  try {
    delete processWithBuiltin.getBuiltinModule;
    const real = await import("../lib/fund-send.js");
    expect(real.buildSubject(payer, operator)).toEqual(inputs.subject);
    const result = real.buildExpectation({ jobId: inputs.jobId, operator, fundingWallet: payer, latestBlockTimestamp: BigInt(inputs.latestBlockTimestamp) });
    expect(result.acceptedPolicyDigest).toEqual({ subjectBlockHash: expectedHash,
      bindingsRoot: "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd" });
  } finally {
    if (original) Object.defineProperty(processWithBuiltin, "getBuiltinModule", original);
  }
});
