/**
 * prepareFunding: one test per refusal, against a consistent payload built per run (implementer-bravo, pcc-adk).
 * Each case changes ONE thing in the wire payload, the pins or the fake chain, and expects ONE refusal code. A
 * refusal must sign and send nothing.
 */
import { describe, expect, it } from "vitest";
import { getAddress, hashTypedData, maxUint256, zeroHash, type Hex, type LocalAccount } from "viem";
import { FundingRefusal, prepareFunding, type FundingRefusalCode, type PrepareFundingArgs } from "../../funding/index.js";
import { CIRCLE_USDC } from "../../funding/pins.js";
import { ESCROW_ABI, FACTORY_ABI } from "../../funding/vnext.js";
import { DAY, IMPLEMENTATION, NOW, OTHER, buildFixture, highS, makeChain, newAccount, parityV, testPins, type FixtureOptions } from "./fixture.js";

const MARGIN = 300n;

async function refusal(p: Promise<unknown>): Promise<FundingRefusalCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FundingRefusal) return e.code;
    throw e;
  }
  throw new Error("expected a FundingRefusal, but the call succeeded");
}

async function setup(o: FixtureOptions = {}) {
  const fx = await buildFixture(o);
  const chain = makeChain(fx);
  const prepare = (payload: unknown = fx.wire(), extra: Partial<PrepareFundingArgs> = {}) =>
    prepareFunding({
      payload,
      wallet: chain.wallet(),
      publicClient: chain.publicClient,
      quote: { maxTotalGross: fx.totalGross },
      pins: testPins(fx),
      ...extra,
    });
  /** Expect `code` for the payload `mutate` makes, and that nothing was sent. */
  const expectRefusal = async (code: FundingRefusalCode, mutate: (w: any) => void, extra: Partial<PrepareFundingArgs> = {}) => {
    const w = fx.wire();
    mutate(w);
    expect(await refusal(prepare(w, extra))).toBe(code);
    expect(chain.sends()).toEqual([]);
  };
  return { fx, chain, prepare, expectRefusal };
}

/** The checksummed address with one letter's case flipped: a bad EIP-55 checksum. */
function badChecksum(address: string): string {
  const a = getAddress(address);
  const i = [...a].findIndex((ch, k) => k > 1 && /[a-fA-F]/.test(ch));
  return a.slice(0, i) + (a[i] === a[i]!.toUpperCase() ? a[i]!.toLowerCase() : a[i]!.toUpperCase()) + a.slice(i + 1);
}

describe("prepareFunding: a consistent payload", () => {
  it("verifies it and returns every recomputed value, deep-frozen", async () => {
    const { fx, chain, prepare } = await setup();
    const prepared = await prepare();
    expect(prepared.escrow).toBe(fx.escrow);
    expect(prepared.totalGross).toBe(fx.totalGross);
    expect(prepared.jobPolicyHash).toBe(fx.jobPolicyHash);
    expect(prepared.digest).toBe(fx.digest);
    expect(hashTypedData(prepared.typedData)).toBe(fx.digest);
    expect(prepared.unitIds).toEqual(fx.unitIds);
    expect(prepared.policyKey).toBe(fx.policyKey);
    expect(prepared.payer).toBe(fx.payer.address);
    expect(prepared.operatorSignature).toBe(fx.operatorSignature);
    expect(prepared.reclaimAt).toEqual({ earliest: NOW + 30n * DAY, latest: NOW + 60n * DAY });
    expect(prepared.verifiedAt.blockTimestamp).toBe(NOW);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.configs[0]!.payouts[0])).toBe(true);
    expect(Object.isFrozen(prepared.typedData.message)).toBe(true);
    expect(() => {
      (prepared as { totalGross: bigint }).totalGross = 1n;
    }).toThrow();
    expect(chain.sends()).toEqual([]);
  });

  it("judges the payload as it was at the call, not as the caller later changes it", async () => {
    const { fx, prepare } = await setup();
    const w = fx.wire();
    const pending = prepare(w);
    w.totalGross = "1";
    w.fund.configs[0].g = "1";
    w.approve.spender = OTHER;
    const prepared = await pending;
    expect(prepared.totalGross).toBe(fx.totalGross);
    expect(prepared.configs[0]!.g).toBe(fx.configs[0]!.g);
  });

  it("accepts checksummed and lowercase addresses alike", async () => {
    const { fx, prepare } = await setup();
    const w = fx.wire();
    w.escrow = w.escrow.toLowerCase();
    w.typedData.message.payer = getAddress(w.typedData.message.payer);
    expect((await prepare(w)).escrow).toBe(fx.escrow);
  });
});

describe("BAD_PAYLOAD: anything off the v1 schema, never repaired", () => {
  const cases: Array<[string, (w: any) => void]> = [
    ["an extra top-level key", (w) => (w.note = "hi")],
    ["a missing key", (w) => delete w.approve],
    ["a uint256 as a JS number", (w) => (w.totalGross = Number(w.totalGross))],
    ["a non-canonical decimal (leading zero)", (w) => (w.expiry = `0${w.expiry}`)],
    ["a negative decimal", (w) => (w.fund.configs[0].g = "-1")],
    ["another schema tag", (w) => (w.schema = "pcc.vnext.buyer-funding.prepare.v2")],
    ["17 units", (w) => (w.fund.configs = Array.from({ length: 17 }, () => w.fund.configs[0]))],
    ["no units", (w) => (w.fund.configs = [])],
    ["17 payout legs", (w) => (w.fund.configs[0].payouts = Array.from({ length: 17 }, () => w.fund.configs[0].payouts[0]))],
    ["a bad EIP-55 checksum", (w) => (w.escrow = badChecksum(w.escrow))],
    ["a 1025-byte signature", (w) => (w.fund.acceptance.operatorSignature = `0x${"ab".repeat(1025)}`)],
    ["a tier above uint8", (w) => (w.fund.configs[0].requiredTier = 256)],
    ["an EIP712Domain entry in types", (w) => (w.typedData.types.EIP712Domain = [{ name: "name", type: "string" }])],
    ["a salt in the domain", (w) => (w.typedData.domain.salt = zeroHash)],
    ["a bytes32 of the wrong length", (w) => (w.typedData.message.jobIdHash = "0x1234")],
  ];
  for (const [name, mutate] of cases) {
    it(name, async () => {
      const { expectRefusal } = await setup();
      await expectRefusal("BAD_PAYLOAD", mutate);
    });
  }
  it("a payload that is not a plain object", async () => {
    const { prepare } = await setup();
    for (const payload of [null, "payload", [], 7]) expect(await refusal(prepare(payload))).toBe("BAD_PAYLOAD");
  });
});

describe("X402_REFUSED: x402 never funds an escrow (plan G10)", () => {
  const cases: Array<[string, (w: any) => void]> = [
    ["an x402 payment-required body", (w) => (w.x402Version = 1)],
    ["x402 payment requirements", (w) => (w.accepts = [{ scheme: "exact", payTo: w.escrow }])],
    ["a payTo naming the escrow", (w) => (w.payTo = w.escrow)],
    ["an EIP-3009 TransferWithAuthorization", (w) => (w.typedData.primaryType = "TransferWithAuthorization")],
    ["an EIP-2612 Permit", (w) => (w.typedData.primaryType = "Permit")],
  ];
  for (const [name, mutate] of cases) {
    it(name, async () => {
      const { expectRefusal } = await setup();
      await expectRefusal("X402_REFUSED", mutate);
    });
  }
});

describe("CHAIN_MISMATCH", () => {
  it("the wallet is on another chain", async () => {
    const { chain, expectRefusal } = await setup();
    chain.state.walletChainId = 1;
    await expectRefusal("CHAIN_MISMATCH", () => {});
  });
  it("the read client is on another chain", async () => {
    const { chain, expectRefusal } = await setup();
    chain.state.chainId = 1;
    await expectRefusal("CHAIN_MISMATCH", () => {});
  });
});

describe("pins: the token and the factory", () => {
  it("TOKEN_NOT_PINNED: no USDC pin for the chain", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("TOKEN_NOT_PINNED", () => {}, { pins: {} });
  });
  it("TOKEN_NOT_PINNED: the payload's token is not the pin", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("TOKEN_NOT_PINNED", (w) => (w.usdc = OTHER));
  });
  it("TOKEN_NOT_PINNED: the approve's token is not the pin", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("TOKEN_NOT_PINNED", (w) => (w.approve.token = OTHER));
  });
  it("TOKEN_NOT_PINNED: the implementation settles in another token (live)", async () => {
    const { chain, expectRefusal } = await setup();
    chain.on(IMPLEMENTATION, ESCROW_ABI, "USDC", () => OTHER);
    await expectRefusal("TOKEN_NOT_PINNED", () => {});
  });
  it("TOKEN_NOT_PINNED: MockUSDC on Base Sepolia, against the built-in Circle pin", async () => {
    const { fx, expectRefusal } = await setup({ chainId: 84532 });
    await expectRefusal("TOKEN_NOT_PINNED", () => {}, { pins: { "84532": { factory: fx.factory } } });
  });
  it("Base Sepolia with Circle USDC passes on the built-in pin alone", async () => {
    const circle = CIRCLE_USDC["84532"]!;
    const { fx, prepare } = await setup({ chainId: 84532, usdc: circle });
    const prepared = await prepare(fx.wire(), { pins: { "84532": { factory: fx.factory } } });
    expect(prepared.usdc).toBe(circle);
  });
  it("PIN_INVALID: a caller pin may not override the built-in one", async () => {
    const { fx, expectRefusal } = await setup({ chainId: 84532 });
    await expectRefusal("PIN_INVALID", () => {}, { pins: { "84532": { usdc: fx.usdc, factory: fx.factory } } });
  });
  it("PIN_INVALID: a malformed caller pin", async () => {
    const { fx, expectRefusal } = await setup();
    await expectRefusal("PIN_INVALID", () => {}, { pins: { "31337": { usdc: fx.usdc, factory: "0x1234" as never } } });
  });
  it("FACTORY_NOT_PINNED: no factory pin for the chain", async () => {
    const { fx, expectRefusal } = await setup();
    await expectRefusal("FACTORY_NOT_PINNED", () => {}, { pins: { "31337": { usdc: fx.usdc } } });
  });
  it("FACTORY_NOT_PINNED: the payload's factory is not the pin", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("FACTORY_NOT_PINNED", (w) => (w.factory = OTHER));
  });
});

describe("the pinned deployment, read live at one block", () => {
  it("DEPLOYMENT_MISMATCH: no code at the pinned factory", async () => {
    const { fx, chain, expectRefusal } = await setup();
    chain.state.code.delete(fx.factory.toLowerCase());
    await expectRefusal("DEPLOYMENT_MISMATCH", () => {});
  });
  it("DEPLOYMENT_MISMATCH: the factory's implementation is not the policy's", async () => {
    const { fx, chain, expectRefusal } = await setup();
    chain.on(fx.factory, FACTORY_ABI, "implementation", () => OTHER);
    await expectRefusal("DEPLOYMENT_MISMATCH", () => {});
  });
  it("LIVE_CHECK_FAILED: the node cannot serve the hash-pinned calls", async () => {
    const { chain, expectRefusal } = await setup();
    chain.state.failCalls = true;
    await expectRefusal("LIVE_CHECK_FAILED", () => {});
  });
  it("LIVE_CHECK_FAILED: no block to pin", async () => {
    const { chain, expectRefusal } = await setup();
    chain.state.failBlocks = true;
    await expectRefusal("LIVE_CHECK_FAILED", () => {});
  });
});

describe("the payer and the money", () => {
  it("PAYER_NOT_SIGNER: the policy's payer is not this wallet", async () => {
    const { chain, expectRefusal } = await setup();
    await expectRefusal("PAYER_NOT_SIGNER", () => {}, { wallet: chain.wallet(newAccount() as LocalAccount) });
  });
  it("TOTAL_GROSS_MISMATCH: the payload's ΣG is not the configs' sum", async () => {
    const { fx, expectRefusal } = await setup();
    await expectRefusal("TOTAL_GROSS_MISMATCH", (w) => (w.totalGross = (fx.totalGross + 1n).toString()));
  });
  it("AMOUNT_EXCEEDS_QUOTE: ΣG above the buyer's quote; exactly the quote passes", async () => {
    const { fx, prepare, expectRefusal } = await setup();
    await expectRefusal("AMOUNT_EXCEEDS_QUOTE", () => {}, { quote: { maxTotalGross: fx.totalGross - 1n } });
    expect((await prepare(fx.wire(), { quote: { maxTotalGross: fx.totalGross } })).totalGross).toBe(fx.totalGross);
  });
});

describe("the terms", () => {
  it("POLICY_ROOT_MISMATCH: a tampered config", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("POLICY_ROOT_MISMATCH", (w) => (w.fund.configs[0].reclaimAt = (BigInt(w.fund.configs[0].reclaimAt) + 1n).toString()));
  });
  it("POLICY_ROOT_MISMATCH: the same units in another order (order is money-significant)", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("POLICY_ROOT_MISMATCH", (w) => w.fund.configs.reverse());
  });
  it("ESCROW_NOT_PREDICTED: an escrow the factory and salt do not derive", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("ESCROW_NOT_PREDICTED", (w) => (w.escrow = OTHER));
  });
  it("ESCROW_NOT_PREDICTED: the policy names another implementation", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("ESCROW_NOT_PREDICTED", (w) => (w.typedData.message.implementation = OTHER));
  });
  const domainCases: Array<[string, (w: any) => void]> = [
    ["verifyingContract is the factory, not the predicted escrow", (w) => (w.typedData.domain.verifyingContract = w.factory)],
    ["another name", (w) => (w.typedData.domain.name = "VNextSettlementEscrowV2")],
    ["another version", (w) => (w.typedData.domain.version = "2")],
    ["another chain id", (w) => (w.typedData.domain.chainId = "1")],
  ];
  for (const [name, mutate] of domainCases) {
    it(`DOMAIN_MISMATCH: ${name}`, async () => {
      const { expectRefusal } = await setup();
      await expectRefusal("DOMAIN_MISMATCH", mutate);
    });
  }
  const typedCases: Array<[string, (w: any) => void]> = [
    ["message.escrow", (w) => (w.typedData.message.escrow = OTHER)],
    ["message.unitsRoot", (w) => (w.typedData.message.unitsRoot = zeroHash)],
    ["message.policyVersion", (w) => (w.typedData.message.policyVersion = "1")],
    ["message.expiry differs from the payload's expiry", (w) => (w.typedData.message.expiry = (BigInt(w.expiry) + 1n).toString())],
    ["message.chainId", (w) => (w.typedData.message.chainId = "1")],
    ["message.factory", (w) => (w.typedData.message.factory = OTHER)],
    ["the struct's fields in another order", (w) => w.typedData.types.JobPolicy.reverse()],
    ["a field of another type", (w) => (w.typedData.types.JobPolicy[0].type = "uint64")],
    ["another primary type", (w) => (w.typedData.primaryType = "JobPolicyV2")],
  ];
  for (const [name, mutate] of typedCases) {
    it(`TYPED_DATA_MISMATCH: ${name}`, async () => {
      const { expectRefusal } = await setup();
      await expectRefusal("TYPED_DATA_MISMATCH", mutate);
    });
  }
});

describe("the approve and the fund() args", () => {
  it("APPROVE_SPENDER_NOT_ESCROW", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("APPROVE_SPENDER_NOT_ESCROW", (w) => (w.approve.spender = w.factory));
  });
  it("APPROVE_AMOUNT_NOT_TOTAL: unlimited", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("APPROVE_AMOUNT_NOT_TOTAL", (w) => (w.approve.amount = maxUint256.toString()));
  });
  it("APPROVE_AMOUNT_NOT_TOTAL: one base unit over, and one under", async () => {
    const { fx, expectRefusal } = await setup();
    await expectRefusal("APPROVE_AMOUNT_NOT_TOTAL", (w) => (w.approve.amount = (fx.totalGross + 1n).toString()));
    await expectRefusal("APPROVE_AMOUNT_NOT_TOTAL", (w) => (w.approve.amount = (fx.totalGross - 1n).toString()));
  });
  it("FUND_ARGS_MISMATCH: the acceptance's expiry is not the policy's", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("FUND_ARGS_MISMATCH", (w) => (w.fund.acceptance.expiry = (BigInt(w.expiry) + 1n).toString()));
  });
  it("FUND_ARGS_MISMATCH: a payer signature in a payer-sent fund()", async () => {
    const { fx, expectRefusal } = await setup();
    const sig = await fx.payer.sign({ hash: fx.digest });
    await expectRefusal("FUND_ARGS_MISMATCH", (w) => (w.fund.acceptance.payerSignature = sig));
  });
});

describe("OPERATOR_SIGNATURE_INVALID: missing, or not the operator's over these exact terms", () => {
  it("missing", async () => {
    const { expectRefusal } = await setup();
    await expectRefusal("OPERATOR_SIGNATURE_INVALID", (w) => (w.fund.acceptance.operatorSignature = "0x"));
  });
  it("signed by the payer, not the operator", async () => {
    const { fx, expectRefusal } = await setup();
    const sig = await fx.payer.sign({ hash: fx.digest });
    await expectRefusal("OPERATOR_SIGNATURE_INVALID", (w) => (w.fund.acceptance.operatorSignature = sig));
  });
  it("the operator's signature over other terms (another expiry)", async () => {
    const { fx, expectRefusal } = await setup();
    const other = await buildFixture({ expiry: fx.expiry + 1n }, { payer: fx.payer, operator: fx.operator });
    expect(other.escrow).toBe(fx.escrow); // the expiry is not in the salt: same escrow, different digest
    await expectRefusal("OPERATOR_SIGNATURE_INVALID", (w) => (w.fund.acceptance.operatorSignature = other.operatorSignature));
  });
  it("the high-s twin (recovers to the operator, but the factory rejects it)", async () => {
    const { fx, expectRefusal } = await setup();
    await expectRefusal("OPERATOR_SIGNATURE_INVALID", (w) => (w.fund.acceptance.operatorSignature = highS(fx.operatorSignature)));
  });
  it("v written as 0/1 (recovers to the operator, but the factory wants 27/28)", async () => {
    const { fx, expectRefusal } = await setup();
    await expectRefusal("OPERATOR_SIGNATURE_INVALID", (w) => (w.fund.acceptance.operatorSignature = parityV(fx.operatorSignature)));
  });
  it("64 bytes", async () => {
    const { fx, expectRefusal } = await setup();
    await expectRefusal("OPERATOR_SIGNATURE_INVALID", (w) => (w.fund.acceptance.operatorSignature = fx.operatorSignature.slice(0, 130) as Hex));
  });
});

describe("time, at the pinned block (the fake chain's block time is NOW)", () => {
  it("EXPIRY_TOO_SOON: already expired", async () => {
    const { expectRefusal } = await setup({ expiry: NOW - 1n });
    await expectRefusal("EXPIRY_TOO_SOON", () => {});
  });
  it("EXPIRY_TOO_SOON: inside the margin; exactly the margin passes", async () => {
    const tight = await setup({ expiry: NOW + MARGIN - 1n });
    await tight.expectRefusal("EXPIRY_TOO_SOON", () => {});
    const edge = await setup({ expiry: NOW + MARGIN });
    expect((await edge.prepare()).expiry).toBe(NOW + MARGIN);
  });
  it("RECLAIM_WINDOW: 10 days with no margin left; 10 days plus the margin passes", async () => {
    const tight = await setup({ reclaimAt: [NOW + 10n * DAY + MARGIN - 1n] });
    await tight.expectRefusal("RECLAIM_WINDOW", () => {});
    const edge = await setup({ reclaimAt: [NOW + 10n * DAY + MARGIN] });
    expect((await edge.prepare()).reclaimAt.earliest).toBe(NOW + 10n * DAY + MARGIN);
  });
  it("RECLAIM_WINDOW: beyond 365 days; exactly 365 days passes", async () => {
    const far = await setup({ reclaimAt: [NOW + 365n * DAY + 1n] });
    await far.expectRefusal("RECLAIM_WINDOW", () => {});
    const edge = await setup({ reclaimAt: [NOW + 365n * DAY] });
    expect((await edge.prepare()).reclaimAt.latest).toBe(NOW + 365n * DAY);
  });
});
