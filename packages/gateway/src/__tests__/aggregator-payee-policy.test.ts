/**
 * WP-A round 8 (astra failclosed r2 FC-10: prove the gateway recipient policy covers
 * every consumer). The aggregator's own x402 gate took PCC_AGGREGATOR_TREASURY with a
 * SHAPE check only, so a placeholder payee (the zero/sentinel range, a repeated-digit
 * address, a public-key test account) was advertised in every priceTag. It now uses
 * the same configuredAddress policy as the main payment gate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getAddress } from "viem";
import { getX402GateConfig, _resetAggregatorRegistryForTests } from "../routes/aggregator/index.js";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["PCC_X402_ENABLED", "PCC_AGGREGATOR_TREASURY"]) saved[k] = process.env[k];
  process.env.PCC_X402_ENABLED = "true";
  _resetAggregatorRegistryForTests();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetAggregatorRegistryForTests();
});

describe("the aggregator's x402 payee follows the gateway recipient policy", () => {
  it.each<[string, string]>([
    ["the 0x…0001 sentinel", "0x0000000000000000000000000000000000000001"],
    ["a repeated-digit address", "0x1111111111111111111111111111111111111111"],
    ["the checksummed form of a repeated-letter address", getAddress("0x" + "b".repeat(40))],
    ["Hardhat account #0 (public private key)", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
    ["a mixed-case address with a broken checksum", "0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
  ])("[neg] %s is never the payee: the gate stays unconfigured", (_name, payee) => {
    process.env.PCC_AGGREGATOR_TREASURY = payee;
    expect(getX402GateConfig()).toBeUndefined();
  });

  it("control: a real, checksummed payee configures the gate", () => {
    const payee = getAddress("0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432");
    process.env.PCC_AGGREGATOR_TREASURY = payee;
    expect(getX402GateConfig()?.payTo).toBe(payee);
  });
});
