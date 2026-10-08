/**
 * approveAndFund's pre-send refusals, the funding read-back, and the three-outcome rule (implementer-bravo, pcc-adk).
 * The sends, receipts and read-backs against real contracts are in packages/contracts/ts/__tests__/
 * buyer-funding.anvil.test.ts.
 */
import { describe, expect, it } from "vitest";
import { encodeErrorResult, keccak256, stringToHex, type Hex } from "viem";
import {
  FundingRefusal,
  approveAndFund,
  classifyFunding,
  prepareFunding,
  readFundedState,
  type FundedStateKind,
  type FundingRefusalCode,
  type SendResult,
} from "../../funding/index.js";
import { ERC20_ABI, ESCROW_ABI, FACTORY_ABI } from "../../funding/vnext.js";
import { DAY, NOW, OTHER, buildFixture, makeChain, newAccount, revertWith, testPins, type FixtureOptions } from "./fixture.js";

const MARGIN = 300n;
const TX = keccak256(stringToHex("tx")) as Hex;
const BLOCK = keccak256(stringToHex("block")) as Hex;

async function refusal(p: Promise<unknown>): Promise<FundingRefusalCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FundingRefusal) return e.code;
    throw e;
  }
  throw new Error("expected a FundingRefusal, but the call succeeded");
}

async function setup(o: FixtureOptions = {}, chainOptions = { escrowCode: true }) {
  const fx = await buildFixture(o);
  const chain = makeChain(fx, chainOptions);
  const prepared = await prepareFunding({
    payload: fx.wire(),
    wallet: chain.wallet(),
    publicClient: chain.publicClient,
    quote: { maxTotalGross: fx.totalGross },
    pins: testPins(fx),
  });
  const fund = (wallet = chain.wallet(), p = prepared) => approveAndFund({ prepared: p, wallet, publicClient: chain.publicClient });
  const fundedAs = (policyHash: Hex) =>
    chain.on(fx.escrow, ESCROW_ABI, "policy", () => [fx.operator.address, 1n, fx.message.prePolicyRoot, policyHash, fx.message.acceptedPolicyDigest]);
  /** eth_call selectors the SDK simulated (approve / fund), as opposed to reads. */
  const simulated = () =>
    chain.state.log
      .filter((x) => x.method === "eth_call" && (x.params as unknown[])[1] === "latest")
      .map((x) => ((x.params as [{ data: Hex }])[0].data as string).slice(0, 10));
  return { fx, chain, prepared, fund, fundedAs, simulated };
}

describe("classifyFunding: committed / unchanged / indeterminate", () => {
  const sends: Array<[string, SendResult]> = [
    ["never broadcast", { kind: "not_sent", reason: "simulation reverted" }],
    ["broadcast, no receipt", { kind: "unknown", txHash: TX, reason: "timeout" }],
    ["send threw", { kind: "unknown", reason: "transport error" }],
    ["mined, success", { kind: "mined", txHash: TX, status: "success", blockHash: BLOCK }],
    ["mined, reverted", { kind: "mined", txHash: TX, status: "reverted", blockHash: BLOCK }],
  ];
  const expected: Record<string, Record<FundedStateKind, string>> = {
    "never broadcast": { funded_ours: "committed", unfunded: "unchanged", other: "indeterminate", unreadable: "indeterminate" },
    "broadcast, no receipt": { funded_ours: "committed", unfunded: "indeterminate", other: "indeterminate", unreadable: "indeterminate" },
    "send threw": { funded_ours: "committed", unfunded: "indeterminate", other: "indeterminate", unreadable: "indeterminate" },
    "mined, success": { funded_ours: "committed", unfunded: "indeterminate", other: "indeterminate", unreadable: "indeterminate" },
    "mined, reverted": { funded_ours: "committed", unfunded: "unchanged", other: "indeterminate", unreadable: "indeterminate" },
  };
  for (const [name, send] of sends) {
    for (const read of ["funded_ours", "unfunded", "other", "unreadable"] as const) {
      it(`${name} + read ${read} -> ${expected[name]![read]}`, () => {
        expect(classifyFunding(send, read)).toBe(expected[name]![read]);
      });
    }
  }
});

describe("readFundedState: read from the contract, never from a receipt or a balance", () => {
  it("unfunded: no accepted policy, and no escrow funded for the job", async () => {
    const { chain, prepared } = await setup();
    const s = await readFundedState({ publicClient: chain.publicClient, prepared });
    expect(s.kind).toBe("unfunded");
    expect(s.blockHash).toBe(chain.state.block.hash);
  });
  it("funded_ours: policy().jobPolicyHash_ is this policy's, with the unit states", async () => {
    const { fx, chain, prepared, fundedAs } = await setup();
    fundedAs(fx.jobPolicyHash);
    const s = await readFundedState({ publicClient: chain.publicClient, prepared, blockHash: chain.state.block.hash });
    expect(s.kind).toBe("funded_ours");
    expect(s.unitStates).toEqual([1, 1]);
  });
  it("other: funded under another acceptance", async () => {
    const { chain, prepared, fundedAs } = await setup();
    fundedAs(keccak256(stringToHex("another acceptance")));
    expect((await readFundedState({ publicClient: chain.publicClient, prepared })).kind).toBe("other");
  });
  it("other: the job is funded by another escrow, so this one never can be", async () => {
    const { fx, chain, prepared } = await setup();
    chain.on(fx.factory, FACTORY_ABI, "fundedEscrowOf", () => OTHER);
    expect((await readFundedState({ publicClient: chain.publicClient, prepared })).kind).toBe("other");
  });
  it("unreadable: a read fails, or no block can be pinned", async () => {
    const { chain, prepared } = await setup();
    chain.state.failCalls = true;
    expect((await readFundedState({ publicClient: chain.publicClient, prepared })).kind).toBe("unreadable");
    chain.state.failBlocks = true;
    const s = await readFundedState({ publicClient: chain.publicClient, prepared });
    expect(s.kind).toBe("unreadable");
    expect(s.blockHash).toBeNull();
  });
  it("NOT_PREPARED for a copy", async () => {
    const { chain, prepared } = await setup();
    expect(await refusal(readFundedState({ publicClient: chain.publicClient, prepared: { ...prepared } }))).toBe("NOT_PREPARED");
  });
});

describe("approveAndFund: refusals before anything is sent", () => {
  it("NOT_PREPARED", async () => {
    const { chain, prepared, fund } = await setup();
    expect(await refusal(fund(chain.wallet(), structuredClone(prepared)))).toBe("NOT_PREPARED");
    expect(chain.sends()).toEqual([]);
  });
  it("PAYER_NOT_SIGNER: another wallet would send", async () => {
    const { chain, fund } = await setup();
    expect(await refusal(fund(chain.wallet(newAccount())))).toBe("PAYER_NOT_SIGNER");
    expect(chain.sends()).toEqual([]);
  });
  it("CHAIN_MISMATCH: the wallet moved to another chain", async () => {
    const { chain, fund } = await setup();
    chain.state.walletChainId = 1;
    expect(await refusal(fund())).toBe("CHAIN_MISMATCH");
  });
  it("ESCROW_NOT_CREATED: the clone does not exist yet", async () => {
    const { chain, fund, simulated } = await setup({}, { escrowCode: false });
    expect(await refusal(fund())).toBe("ESCROW_NOT_CREATED");
    expect(simulated()).toEqual([]);
    expect(chain.sends()).toEqual([]);
  });
  it("already funded under this policy: committed, and nothing is simulated or sent", async () => {
    const { fx, chain, fund, fundedAs, simulated } = await setup();
    fundedAs(fx.jobPolicyHash);
    const result = await fund();
    expect(result.outcome).toBe("committed");
    expect(result.alreadyFunded).toBe(true);
    expect(result.stage).toBe("precheck");
    expect(simulated()).toEqual([]);
    expect(chain.sends()).toEqual([]);
  });
  it("ALREADY_FUNDED: funded under another acceptance", async () => {
    const { chain, fund, fundedAs } = await setup();
    fundedAs(keccak256(stringToHex("another acceptance")));
    expect(await refusal(fund())).toBe("ALREADY_FUNDED");
    expect(chain.sends()).toEqual([]);
  });
  it("ALREADY_FUNDED: the job is funded by another escrow", async () => {
    const { fx, chain, fund } = await setup();
    chain.on(fx.factory, FACTORY_ABI, "fundedEscrowOf", () => OTHER);
    expect(await refusal(fund())).toBe("ALREADY_FUNDED");
  });
  it("LIVE_CHECK_FAILED: the funding state cannot be read, or no block can be pinned", async () => {
    const { chain, fund } = await setup();
    chain.state.failCalls = true;
    expect(await refusal(fund())).toBe("LIVE_CHECK_FAILED");
    chain.state.failCalls = false;
    chain.state.failBlocks = true;
    expect(await refusal(fund())).toBe("LIVE_CHECK_FAILED");
    expect(chain.sends()).toEqual([]);
  });
  it("EXPIRY_TOO_SOON: time passed since prepare", async () => {
    const { fx, chain, fund } = await setup();
    chain.state.block.timestamp = fx.expiry - MARGIN + 1n;
    expect(await refusal(fund())).toBe("EXPIRY_TOO_SOON");
    expect(chain.sends()).toEqual([]);
  });
  it("RECLAIM_WINDOW: time passed since prepare, and a reclaim window no longer holds", async () => {
    const { chain, fund } = await setup({ expiry: NOW + 40n * DAY, reclaimAt: [NOW + 30n * DAY] });
    chain.state.block.timestamp = NOW + 20n * DAY + 1n;
    expect(await refusal(fund())).toBe("RECLAIM_WINDOW");
    expect(chain.sends()).toEqual([]);
  });
  it("SIMULATION_REVERTED: the approve would revert", async () => {
    const { fx, chain, fund } = await setup();
    chain.on(fx.usdc, ERC20_ABI, "approve", () => revertWith(encodeErrorResult({ abi: ESCROW_ABI, errorName: "NotActive" })));
    expect(await refusal(fund())).toBe("SIMULATION_REVERTED");
    expect(chain.sends()).toEqual([]);
  });
  it("a wallet that cannot send: the approve's outcome is unknown, fund() is never sent, funding is unchanged", async () => {
    const { chain, fund, simulated } = await setup();
    const result = await fund();
    expect(result.stage).toBe("approve");
    expect(result.outcome).toBe("unchanged");
    expect(result.fundTx).toBeUndefined();
    expect(result.readBack.kind).toBe("unfunded");
    expect(simulated()).toHaveLength(1); // the approve only
    expect(chain.sends()).toEqual([]);
  });
});
