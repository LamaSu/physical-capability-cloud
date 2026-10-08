/**
 * approveAndFund's pre-send refusals, the funding read-back, and the three-outcome rule (implementer-bravo, pcc-adk).
 * The sends, receipts and read-backs against real contracts are in packages/contracts/ts/__tests__/
 * buyer-funding.anvil.test.ts.
 */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeErrorResult, getAbiItem, keccak256, stringToHex, toFunctionSelector, type Hex } from "viem";
import {
  FundingRefusal,
  approveAndFund,
  classifyFunding,
  prepareFunding,
  readFundedState,
  type ApproveAndFundArgs,
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
  const fund = (wallet = chain.wallet(), p = prepared, extra: Partial<ApproveAndFundArgs> = {}) =>
    approveAndFund({ prepared: p, wallet, publicClient: chain.publicClient, ...extra });
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
  it("PAYER_NOT_SIGNER: a wallet with no account", async () => {
    const { chain, prepared } = await setup();
    expect(await refusal(approveAndFund({ prepared, wallet: chain.accountless(), publicClient: chain.publicClient }))).toBe("PAYER_NOT_SIGNER");
  });
  it("LIVE_CHECK_FAILED: the escrow's code cannot be read", async () => {
    const { chain, fund } = await setup();
    chain.state.failCode = true;
    expect(await refusal(fund())).toBe("LIVE_CHECK_FAILED");
    expect(chain.sends()).toEqual([]);
  });
  it("a negative margin is a caller error", async () => {
    const { chain, prepared } = await setup();
    await expect(approveAndFund({ prepared, wallet: chain.wallet(), publicClient: chain.publicClient, marginSeconds: -1n })).rejects.toThrow(TypeError);
  });
});

describe("approveAndFund: after the first broadcast, the outcome rests on the escrow's own state", () => {
  /** Calldata of the eth_call simulations, in order (reads are pinned by block hash; simulations run at "latest"). */
  const simulatedData = (chain: Awaited<ReturnType<typeof setup>>["chain"]) =>
    chain.state.log
      .filter((x) => x.method === "eth_call" && (x.params as unknown[])[1] === "latest")
      .map((x) => (x.params as [{ data: Hex }])[0].data);

  it("committed: approve(escrow, ΣG) then a payer-sent fund(), simulated and sent byte for byte, funded per policy()", async () => {
    const { fx, chain, prepared, fund, fundedAs } = await setup();
    chain.state.afterSend = (i) => {
      if (i === 1) fundedAs(fx.jobPolicyHash);
    };
    const result = await fund();
    expect(result.outcome).toBe("committed");
    expect(result.stage).toBe("fund");
    expect(result.alreadyFunded).toBe(false);
    expect(result.readBack.kind).toBe("funded_ours");
    expect(result.readBack.blockHash).toBe(chain.state.block.hash);
    const [approveSent, fundSent] = chain.state.sent;
    expect(result.approveTx).toBe(approveSent!.hash);
    expect(result.fundTx).toBe(fundSent!.hash);
    expect(approveSent!.to.toLowerCase()).toBe(fx.usdc.toLowerCase());
    expect(decodeFunctionData({ abi: ERC20_ABI, data: approveSent!.data }).args).toEqual([fx.escrow, fx.totalGross]);
    expect(fundSent!.to.toLowerCase()).toBe(fx.escrow.toLowerCase());
    const [configs, acceptance] = decodeFunctionData({ abi: ESCROW_ABI, data: fundSent!.data }).args as unknown as [unknown, { expiry: bigint; payerSignature: Hex; operatorSignature: Hex }];
    expect(configs).toEqual(prepared.configs);
    expect(acceptance).toEqual({ expiry: fx.expiry, payerSignature: "0x", operatorSignature: fx.operatorSignature });
    expect(simulatedData(chain)).toEqual([approveSent!.data, fundSent!.data]);
  });

  it("a wallet configured with a data suffix still sends exactly the simulated bytes", async () => {
    const { fx, chain, fund, fundedAs } = await setup();
    chain.state.afterSend = (i) => {
      if (i === 1) fundedAs(fx.jobPolicyHash);
    };
    const result = await fund(chain.wallet(fx.payer, { dataSuffix: "0xdeadbeef" }));
    expect(result.outcome).toBe("committed");
    expect(chain.state.sent.map((t) => t.data)).toEqual(simulatedData(chain));
    expect(chain.state.sent.some((t) => t.data.endsWith("deadbeef"))).toBe(false);
  });

  it("the approve's send throws: its outcome is unknown, fund() is never sent, funding is unchanged", async () => {
    const { chain, fund } = await setup();
    chain.state.failSend = true;
    const result = await fund();
    expect(result.stage).toBe("approve");
    expect(result.outcome).toBe("unchanged");
    expect(result.approveTx).toBeUndefined();
    expect(result.fundTx).toBeUndefined();
    expect(result.detail).toContain("unknown");
    expect(simulatedData(chain)).toHaveLength(1);
  });

  it("the approve never mines: fund() is never sent, funding is unchanged", async () => {
    const { chain, fund } = await setup();
    chain.state.receipts = ["none"];
    const result = await fund(undefined, undefined, { receiptTimeoutMs: 200 });
    expect(result.stage).toBe("approve");
    expect(result.outcome).toBe("unchanged");
    expect(result.approveTx).toBe(chain.state.sent[0]!.hash);
    expect(result.detail).toContain("unknown");
    expect(chain.state.sent).toHaveLength(1);
  });

  it("the approve mines but reverts: fund() is never simulated or sent", async () => {
    const { chain, fund } = await setup();
    chain.state.receipts = ["reverted"];
    const result = await fund();
    expect(result.stage).toBe("approve");
    expect(result.outcome).toBe("unchanged");
    expect(result.detail).toContain("reverted");
    expect(simulatedData(chain)).toHaveLength(1);
    expect(chain.state.sent).toHaveLength(1);
  });

  it("the allowance does not read back as ΣG at the approve's block: fund() is never sent", async () => {
    const { fx, chain, fund } = await setup();
    chain.on(fx.usdc, ERC20_ABI, "allowance", () => fx.totalGross - 1n);
    const result = await fund();
    expect(result.stage).toBe("approve");
    expect(result.outcome).toBe("unchanged");
    expect(result.detail).toContain("allowance");
    expect(chain.state.sent).toHaveLength(1);
  });

  it("unchanged: the fund() simulation reverts, so it is never sent", async () => {
    const { fx, chain, fund } = await setup();
    chain.on(fx.escrow, ESCROW_ABI, "fund", () => revertWith(encodeErrorResult({ abi: ESCROW_ABI, errorName: "InvalidOrDisabledCohort" })));
    const result = await fund();
    expect(result.stage).toBe("fund");
    expect(result.outcome).toBe("unchanged");
    expect(result.fundTx).toBeUndefined();
    expect(result.detail).toContain("InvalidOrDisabledCohort");
    expect(chain.state.sent).toHaveLength(1);
  });

  it("unchanged: fund() mines but reverts, and the escrow reads unfunded at that block", async () => {
    const { chain, fund } = await setup();
    chain.state.receipts = ["success", "reverted"];
    const result = await fund();
    expect(result.outcome).toBe("unchanged");
    expect(result.fundTx).toBe(chain.state.sent[1]!.hash);
    expect(result.readBack.kind).toBe("unfunded");
  });

  it("indeterminate: fund() mines successfully but the escrow still reads unfunded (a stale read)", async () => {
    const { chain, fund } = await setup();
    const result = await fund();
    expect(result.outcome).toBe("indeterminate");
    expect(result.readBack.kind).toBe("unfunded");
  });

  it("indeterminate: fund() never mines before the receipt wait ends", async () => {
    const { chain, fund } = await setup();
    chain.state.receipts = ["success", "none"];
    const result = await fund(undefined, undefined, { receiptTimeoutMs: 200 });
    expect(result.outcome).toBe("indeterminate");
    expect(result.fundTx).toBe(chain.state.sent[1]!.hash);
    expect(result.detail).toContain("no receipt");
  });

  it("indeterminate: fund() mines successfully but the escrow cannot be read back", async () => {
    const { chain, fund } = await setup();
    chain.state.afterSend = (i) => {
      if (i === 1) chain.state.failCalls = true;
    };
    const result = await fund();
    expect(result.outcome).toBe("indeterminate");
    expect(result.readBack.kind).toBe("unreadable");
  });

  it("every read is pinned to one block by its hash (EIP-1898); only the two simulations run at latest", async () => {
    const { fx, chain, fund, fundedAs } = await setup();
    chain.state.afterSend = (i) => {
      if (i === 1) fundedAs(fx.jobPolicyHash);
    };
    chain.state.log.length = 0;
    expect((await fund()).outcome).toBe("committed");
    const reads = chain.state.log.filter((x) => x.method === "eth_getCode" || x.method === "eth_call");
    const atLatest = reads.filter((x) => (x.params as unknown[])[1] === "latest");
    expect(atLatest.map((x) => ((x.params as [{ data: Hex }])[0].data as string).slice(0, 10))).toEqual(simulatedData(chain).map((d) => d.slice(0, 10)));
    expect(atLatest).toHaveLength(2);
    const pinned = reads.filter((x) => (x.params as unknown[])[1] !== "latest");
    expect(pinned.length).toBeGreaterThan(4);
    for (const x of pinned) {
      expect((x.params as unknown[])[1]).toEqual({ blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), requireCanonical: true });
    }
  });

  it("the allowance is read at the approve's own block, not at the block the pre-checks ran at", async () => {
    const { fx, chain, fund, fundedAs } = await setup();
    const precheckBlock = chain.state.block.hash;
    // The chain moves on between the pre-checks and the approve, so the approve lands in a later block.
    chain.on(fx.usdc, ERC20_ABI, "approve", () => {
      chain.advanceBlock();
      return true;
    });
    chain.state.afterSend = (i) => {
      if (i === 1) fundedAs(fx.jobPolicyHash);
    };
    chain.state.log.length = 0;
    expect((await fund()).outcome).toBe("committed");
    const approveBlock = chain.state.sent[0]!.block.hash;
    expect(approveBlock).not.toBe(precheckBlock);
    const allowanceSelector = toFunctionSelector(getAbiItem({ abi: ERC20_ABI, name: "allowance" }));
    const allowanceRead = chain.state.log.find(
      (x) => x.method === "eth_call" && (x.params as [{ data: Hex }])[0].data.startsWith(allowanceSelector),
    );
    expect((allowanceRead!.params as unknown[])[1]).toEqual({ blockHash: approveBlock, requireCanonical: true });
  });

  it("the read-back is at the fund() receipt's block, even when the chain has moved on", async () => {
    const { fx, chain, fund, fundedAs } = await setup();
    chain.state.afterSend = (i) => {
      if (i === 1) {
        fundedAs(fx.jobPolicyHash);
        chain.advanceBlock();
      }
    };
    const result = await fund();
    expect(result.outcome).toBe("committed");
    expect(result.readBack.blockHash).toBe(chain.state.sent[1]!.block.hash);
    expect(result.readBack.blockHash).not.toBe(chain.state.block.hash);
  });

  it("indeterminate: the fund() send throws after the approve (it may have been broadcast)", async () => {
    const { chain, fund } = await setup();
    chain.state.afterSend = (i) => {
      if (i === 0) chain.state.failSend = true;
    };
    const result = await fund();
    expect(result.stage).toBe("fund");
    expect(result.outcome).toBe("indeterminate");
    expect(result.fundTx).toBeUndefined();
    expect(result.readBack.kind).toBe("unfunded");
  });

  it("committed even when the fund() receipt is lost, once the escrow reads funded under this policy", async () => {
    const { fx, chain, fund, fundedAs } = await setup();
    chain.state.receipts = ["success", "none"];
    chain.state.afterSend = (i) => {
      if (i === 1) fundedAs(fx.jobPolicyHash);
    };
    const result = await fund(undefined, undefined, { receiptTimeoutMs: 200 });
    expect(result.outcome).toBe("committed");
    expect(result.readBack.kind).toBe("funded_ours");
  });
});

// reviewer-charlie L1 (implementer-delta): both stop paths (the approve stops the run; the fund() simulation reverts)
// send nothing more, but "nothing more was sent" does not mean "unchanged". Someone holding the buyer's JobPolicy
// signature can fund the escrow from the buyer's allowance at any time, and a read can fail. So each stop path is
// classified by the escrow's read-back, like every other path (verify-writes-three-outcomes).
describe("approveAndFund: a run that stops before fund() is sent is classified by the read-back, never assumed unchanged", () => {
  it("the approve stops the run, but the escrow reads funded under this policy: committed", async () => {
    const { fx, chain, fund, fundedAs } = await setup();
    chain.state.afterSend = (i) => {
      if (i === 0) {
        // In the approve's own block, a relayed fund() carrying the buyer's signature spent the allowance.
        chain.on(fx.usdc, ERC20_ABI, "allowance", () => 0n);
        fundedAs(fx.jobPolicyHash);
      }
    };
    const result = await fund();
    expect(result.stage).toBe("approve");
    expect(result.detail).toContain("allowance");
    expect(result.readBack.kind).toBe("funded_ours");
    expect(result.outcome).toBe("committed");
    expect(result.fundTx).toBeUndefined();
    expect(chain.state.sent).toHaveLength(1);
  });

  it("the approve stops the run (mined, reverted), and the escrow cannot be read back: indeterminate, never unchanged", async () => {
    const { chain, fund } = await setup();
    chain.state.receipts = ["reverted"];
    chain.state.afterSend = (i) => {
      if (i === 0) chain.state.failCalls = true;
    };
    const result = await fund();
    expect(result.stage).toBe("approve");
    expect(result.detail).toContain("reverted");
    expect(result.readBack.kind).toBe("unreadable");
    expect(result.outcome).toBe("indeterminate");
    expect(chain.state.sent).toHaveLength(1);
  });

  it("the fund() simulation reverts because the escrow was funded under this policy in the meantime: committed", async () => {
    const { fx, chain, fund, fundedAs } = await setup();
    chain.state.afterSend = (i) => {
      if (i === 0) {
        // Between the approve and the fund(), a relayer holding the buyer's signature funded the escrow: it is sealed.
        fundedAs(fx.jobPolicyHash);
        chain.on(fx.escrow, ESCROW_ABI, "fund", () => revertWith(encodeErrorResult({ abi: ESCROW_ABI, errorName: "AlreadySealed" })));
      }
    };
    const result = await fund();
    expect(result.stage).toBe("fund");
    expect(result.detail).toContain("AlreadySealed");
    expect(result.readBack.kind).toBe("funded_ours");
    expect(result.outcome).toBe("committed");
    expect(result.fundTx).toBeUndefined();
    expect(chain.state.sent).toHaveLength(1);
  });

  it("the fund() simulation reverts, and the escrow cannot be read back: indeterminate, never unchanged", async () => {
    const { fx, chain, fund } = await setup();
    chain.on(fx.escrow, ESCROW_ABI, "fund", () => {
      chain.state.failCalls = true; // the node stops answering calls right after the simulation
      return revertWith(encodeErrorResult({ abi: ESCROW_ABI, errorName: "InvalidOrDisabledCohort" }));
    });
    const result = await fund();
    expect(result.stage).toBe("fund");
    expect(result.detail).toContain("InvalidOrDisabledCohort");
    expect(result.readBack.kind).toBe("unreadable");
    expect(result.outcome).toBe("indeterminate");
    expect(result.fundTx).toBeUndefined();
    expect(chain.state.sent).toHaveLength(1);
  });
});
