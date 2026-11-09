import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { CIRCLE_USDC, FundingRefusal, VNEXT_FACTORY, prepareFunding } from "../../funding/index.js";
import { resolvePins } from "../../funding/pins.js";
import { OTHER, buildFixture, makeChain, testExpect } from "./fixture.js";

const record = JSON.parse(readFileSync(new URL(
  "../../../../contracts/deployments/vnext/base-sepolia/CANONICAL.json", import.meta.url), "utf8"));

describe("built-in V-next factory", () => {
  it("T1 the table is the committed canonical record's", () => {
    expect(Object.isFrozen(VNEXT_FACTORY)).toBe(true);
    expect(Object.keys(VNEXT_FACTORY)).toEqual(["84532"]);
    expect(VNEXT_FACTORY["84532"]).toBe(record.factory);
    expect(record).toMatchObject({ mode: "CANONICAL", canonical: true, doNotPin: false, label: "",
      broadcast: true, chainId: 84532, scheduleTestnetOnly: true });
    expect(record.usdc.toLowerCase()).toBe(CIRCLE_USDC["84532"]!.toLowerCase());
  });

  it("T2 resolvePins fills gaps and refuses a contradicting factory", () => {
    const builtin = { usdc: CIRCLE_USDC["84532"], factory: record.factory };
    expect(resolvePins(84532n, undefined)).toEqual(builtin);
    expect(resolvePins(84532n, { "84532": { factory: record.factory.toLowerCase() } })).toEqual(builtin);
    try {
      resolvePins(84532n, { "84532": { factory: OTHER } });
      expect.fail("expected PIN_INVALID");
    } catch (e) {
      expect(e).toBeInstanceOf(FundingRefusal);
      expect(e).toMatchObject({ code: "PIN_INVALID" });
      expect((e as Error).message).toContain(OTHER);
      expect((e as Error).message).toContain(record.factory);
    }
    expect(resolvePins(31337n, { "31337": { usdc: OTHER, factory: OTHER } })).toEqual({ usdc: OTHER, factory: OTHER });
    expect(resolvePins(8453n, undefined)).toEqual({ usdc: CIRCLE_USDC["8453"], factory: undefined });
  });

  it("T3 only own properties supply built-in factory pins", () => {
    Object.prototype["1"] = OTHER;
    try {
      expect(resolvePins(1n, undefined).factory).toBeUndefined();
    } finally {
      delete Object.prototype["1"];
    }
  });

  it("T4 Base Sepolia prepares without caller pins", async () => {
    const fx = await buildFixture({ chainId: 84532, usdc: CIRCLE_USDC["84532"] });
    const chain = makeChain(fx);
    const prepared = await prepareFunding({ payload: fx.wire(), wallet: chain.wallet(), publicClient: chain.publicClient,
      expect: testExpect(fx), quote: { maxTotalGross: fx.totalGross } });
    expect(prepared.factory).toBe(getAddress(record.factory));
    expect(chain.sends()).toEqual([]);
  });

  it("T5 another factory on Base Sepolia refuses before any RPC", async () => {
    const fx = await buildFixture({ chainId: 84532, usdc: CIRCLE_USDC["84532"], factory: OTHER });
    const chain = makeChain(fx);
    const args = { payload: fx.wire(), wallet: chain.wallet(), publicClient: chain.publicClient,
      expect: testExpect(fx), quote: { maxTotalGross: fx.totalGross } };
    await expect(prepareFunding(args)).rejects.toMatchObject({ code: "FACTORY_NOT_PINNED" });
    await expect(prepareFunding({ ...args, pins: { "84532": { factory: OTHER } } })).rejects.toMatchObject({ code: "PIN_INVALID" });
    expect(chain.state.log).toEqual([]);
    expect(chain.sends()).toEqual([]);
  });
});
