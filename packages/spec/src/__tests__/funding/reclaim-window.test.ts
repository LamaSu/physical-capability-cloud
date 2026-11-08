import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";
import { computeAcceptedPolicyDigest, computeBindingsRoot, computeSubjectBlockHash } from "../../evidence/accepted-policy.js";
import { approveAndFund } from "../../funding/fund.js";
import { prepareFunding } from "../../funding/prepare.js";
import { CIRCLE_USDC } from "../../funding/pins.js";
import { MAX_RECLAIM_DELAY, MIN_RECLAIM_DELAY, ESCROW_ABI } from "../../funding/vnext.js";
import { computeTermsHashV21 } from "../../funding/terms-hash-v21.js";
import { NOW, buildFixture, makeChain, newAccount, testExpect, testPins } from "./fixture.js";

const windows = () => import("../../funding/pins.js");
const record = () => JSON.parse(readFileSync(new URL(
  "../../../../contracts/deployments/vnext/base-sepolia/CANONICAL.json", import.meta.url), "utf8"));

async function fixture(chainId = 84532, delay = 7_200n) {
  const parties = { payer: newAccount(), operator: newAccount() };
  const fx = await buildFixture({ chainId, usdc: CIRCLE_USDC[String(chainId)], expiry: NOW + 1_200n,
    reclaimAt: [NOW + delay], configure: (cs) => Object.assign(cs[0]!, {
      g: 1_000_000n, f: 0n, n: 1_000_000n, feeBps: 0, feeRecipient: zeroAddress,
      requiredTier: 1, requestedTier: 1, payouts: [{ recipient: parties.operator.address, amount: 1_000_000n }],
    }),
  }, parties);
  const chain = makeChain(fx, { escrowCode: true });
  const own = { ...testExpect(fx), maxFeeBps: 0, feeRecipients: [zeroAddress], tiers: [1] };
  const prepare = (marginSeconds?: bigint) => prepareFunding({ payload: fx.wire(), wallet: chain.wallet(),
    publicClient: chain.publicClient, quote: { maxTotalGross: fx.totalGross }, expect: own,
    pins: testPins(fx), marginSeconds });
  return { fx, chain, prepare };
}

describe("chain-selected reclaim windows", () => {
  it("prepares and sends the 84532 dry-run unit at NOW + 60", async () => {
    const { dryRunUnitTestnetExpectation, dryRunUnitPrincipalWord, DRY_RUN_UNIT_TESTNET_V1: p } =
      await import("../../funding/dry-run-unit.js");
    const { fx: initial } = await fixture();
    const subject = { ...p.zeroSubjectFields, committedProgramHash: p.committedProgramHash,
      payer: dryRunUnitPrincipalWord(initial.payer.address), operatorPrincipal: dryRunUnitPrincipalWord(initial.operator.address),
      operatorSettlementAddress: initial.operator.address.toLowerCase() as Address,
      authorizedTuplesRoot: p.compositionRoot, integrityGrade: 0 };
    const termsHash = computeTermsHashV21({ token: initial.usdc, assuranceTier: 1,
      milestones: initial.configs.map((c) => ({ milestoneIndex: c.milestoneIndex, stepId: c.stepId, amount: c.g, deadline: c.reclaimAt })) });
    const fx = await buildFixture({ chainId: 84532, usdc: initial.usdc, expiry: NOW + 1_200n,
      reclaimAt: [NOW + 7_200n], configure: (cs) => Object.assign(cs[0]!, initial.configs[0]), termsHash,
      acceptedPolicyDigest: computeAcceptedPolicyDigest({ termsHash, subjectBlockHash: computeSubjectBlockHash(subject),
        bindingsRoot: computeBindingsRoot([]) }),
    }, { payer: initial.payer, operator: initial.operator });
    const chain = makeChain(fx, { escrowCode: true });
    chain.state.block.timestamp = NOW + 60n;
    const own = dryRunUnitTestnetExpectation({ jobId: fx.jobId, operator: fx.operator.address,
      fundingWallet: fx.payer.address, subject, bindings: [], latestBlockTimestamp: NOW });
    const prepared = await prepareFunding({ payload: fx.wire(), wallet: chain.wallet(), publicClient: chain.publicClient,
      quote: { maxTotalGross: 1_000_000n }, expect: own, pins: { "84532": { factory: fx.factory } } });
    expect(prepared.reclaimAt).toEqual({ earliest: NOW + 7_200n, latest: NOW + 7_200n });
    chain.state.afterSend = (i) => {
      if (i === 1) {
        chain.on(fx.escrow, ESCROW_ABI, "policy", () => [fx.operator.address, 1n, fx.message.prePolicyRoot,
          fx.jobPolicyHash, fx.message.acceptedPolicyDigest]);
        chain.state.fundedEscrow = fx.escrow;
      }
    };
    const result = await approveAndFund({ prepared, wallet: chain.wallet(), publicClient: chain.publicClient });
    expect(result.outcome).toBe("committed");
    expect(chain.sends()).toHaveLength(2);
  });

  // Independent of the new builder, so the first run reaches the old timing refusal.
  it("accepts the 84532 dry-run delay through checkTiming", async () => {
    const { chain, prepare } = await fixture();
    chain.state.block.timestamp = NOW + 60n;
    expect((await prepare()).reclaimAt).toEqual({ earliest: NOW + 7_200n, latest: NOW + 7_200n });
  });
  it.each([8453, 31337, 1])("keeps the 10-day preparation floor on chain %s", async (id) => {
    const { prepare } = await fixture(id);
    await expect(prepare()).rejects.toMatchObject({ code: "RECLAIM_WINDOW" });
  });
  it("rechecks the validated 31337 chain before sending", async () => {
    const { fx, chain, prepare } = await fixture(31337);
    // It is valid at preparation, then too close at the funding block.
    chain.state.block.timestamp = NOW - 864_000n;
    const prepared = await prepare();
    expect(prepared.chainId).toBe(31337n);
    chain.state.block.timestamp = NOW + 60n;
    await expect(approveAndFund({ prepared, wallet: chain.wallet(), publicClient: chain.publicClient }))
      .rejects.toMatchObject({ code: "RECLAIM_WINDOW" });
    expect(chain.sends()).toEqual([]);
    expect(fx.configs[0]!.reclaimAt).toBe(NOW + 7_200n);
  });
  it.each(["walletChainId", "chainId"] as const)("refuses a mismatched %s before timing or signing", async (field) => {
    const { fx, chain, prepare } = await fixture();
    const sign = vi.spyOn(fx.payer, "sign");
    const signTx = vi.spyOn(fx.payer, "signTransaction");
    const signTyped = vi.spyOn(fx.payer, "signTypedData");
    chain.state[field] = 8453;
    await expect(prepare()).rejects.toMatchObject({ code: "CHAIN_MISMATCH" });
    expect(chain.state.log.length).toBeGreaterThan(0);
    expect(chain.state.log.every((entry) => entry.method === "eth_chainId")).toBe(true);
    expect(sign).not.toHaveBeenCalled();
    expect(signTx).not.toHaveBeenCalled();
    expect(signTyped).not.toHaveBeenCalled();
    expect(chain.sends()).toEqual([]);
  });
  it.each([
    [4_800n, undefined, true], [4_799n, undefined, false],
    [31_536_000n, undefined, true], [31_536_001n, undefined, false], [4_500n, 0n, true],
  ] as const)("84532 delay %s, margin %s, accepted %s", async (delay, margin, accepted) => {
    const { prepare } = await fixture(84532, delay);
    if (accepted) expect((await prepare(margin)).reclaimAt.earliest).toBe(NOW + delay);
    else await expect(prepare(margin)).rejects.toMatchObject({ code: "RECLAIM_WINDOW",
      message: expect.stringContaining("[4500, 31536000]") });
  });
  it("freezes the only built-in window and defaults all other chains", async () => {
    const { RECLAIM_WINDOWS, reclaimWindowFor } = await windows();
    expect(Object.keys(RECLAIM_WINDOWS)).toEqual(["84532"]);
    expect(Object.isFrozen(RECLAIM_WINDOWS)).toBe(true);
    expect(Object.isFrozen(RECLAIM_WINDOWS["84532"])).toBe(true);
    expect(RECLAIM_WINDOWS["84532"]).toEqual({ scheduleId: "vnext-testnet-short-v1", testnetOnly: true,
      minReclaimDelay: 4_500n, maxReclaimDelay: 31_536_000n });
    for (const id of [8453n, 31337n, 1n]) {
      expect(reclaimWindowFor(id)).toEqual({ min: MIN_RECLAIM_DELAY, max: MAX_RECLAIM_DELAY });
      expect(Object.isFrozen(reclaimWindowFor(id))).toBe(true);
    }
    expect(reclaimWindowFor(84532n)).toEqual({ min: 4_500n, max: 31_536_000n });
    expect(Object.isFrozen(reclaimWindowFor(84532n))).toBe(true);
  });
  it("pins the window to the committed canonical deployment record", async () => {
    const r = record();
    const { RECLAIM_WINDOWS } = await windows();
    expect(r.chainId).toBe(84532);
    expect(r.usdc.toLowerCase()).toBe(CIRCLE_USDC["84532"]!.toLowerCase());
    expect({ scheduleId: r.scheduleId, testnetOnly: r.scheduleTestnetOnly,
      minReclaimDelay: BigInt(r.minReclaimDelaySec), maxReclaimDelay: BigInt(r.maxReclaimDelaySec) })
      .toEqual(RECLAIM_WINDOWS["84532"]);
    expect(r).toMatchObject({ mode: "CANONICAL", canonical: true, doNotPin: false });
  });
});
