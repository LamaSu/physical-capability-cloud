import { describe, expect, it } from "vitest";
import { getContractAddress, keccak256, stringToHex, zeroHash, type Address, type Hex } from "viem";
import { CIRCLE_USDC, reclaimWindowFor } from "@pcc/spec/funding";
import { buildUnitConfig, compileVNextPolicy, VNEXT_GOLDEN as G, type VNextCompileInput } from "../vnext/index.js";

const k = (s: string): Hex => keccak256(stringToHex(s));
const T = G.inputs.fundingTime;
function goldenInput(chainId: bigint, delay: bigint, token: Address = "0x5555555555555555555555555555555555555555"): VNextCompileInput {
  const factory = getContractAddress({ from: G.inputs.factoryDeployer, nonce: 0n });
  const u = G.inputs.units[0];
  return {
    chainId, factory, implementation: getContractAddress({ from: factory, nonce: 1n }), token,
    payer: G.inputs.payer, operator: G.inputs.operator, jobIdHash: k(G.inputs.jobId),
    termsHash: k(G.inputs.terms), policyNonce: G.inputs.policyNonce, acceptedPolicyDigest: k(G.inputs.acceptedPolicy),
    expiry: G.inputs.expiry, fundingTime: T,
    units: [buildUnitConfig({ milestoneIndex: u.milestoneIndex, stepId: k(u.step), requiredTier: u.requiredTier,
      g: u.g, feeBps: u.feeBps, feeRecipient: u.feeRecipient, reclaimAt: T + delay,
      compositionSchemaVersion: u.compositionSchemaVersion,
      compositionRoot: u.compositionRoot === null ? zeroHash : k(u.compositionRoot), payouts: u.payouts })],
  };
}
const badReclaim = (input: VNextCompileInput) => expect(() => compileVNextPolicy(input))
  .toThrow(expect.objectContaining({ code: "BAD_RECLAIM" }));

describe("compiler reclaim windows from the SDK table", () => {
  it.each([4_500n, 31_536_000n, 7_200n])("84532 compiles delay %s", (delay) => {
    expect(compileVNextPolicy(goldenInput(84532n, delay)).configs).toHaveLength(1);
  });
  it.each([4_499n, 31_536_001n])("84532 refuses delay %s", (delay) => {
    expect(() => compileVNextPolicy(goldenInput(84532n, delay))).toThrow(expect.objectContaining({
      code: "BAD_RECLAIM", message: expect.stringContaining("fundingTime + [4500, 31536000] seconds"),
    }));
  });
  it.each([8453n, 31337n, 1n])("chain %s keeps the 10-day floor", (id) => {
    badReclaim(goldenInput(id, 7_200n));
    expect(compileVNextPolicy(goldenInput(id, 864_000n)).configs).toHaveLength(1);
  });
  it("8453 cannot select the testnet window by naming its USDC", () => {
    badReclaim(goldenInput(8453n, 7_200n, CIRCLE_USDC["84532"]!));
  });
  it.each([84532n, 8453n, 31337n])("compiler and SDK agree on chain %s", (id) => {
    const { min } = reclaimWindowFor(id);
    expect(compileVNextPolicy(goldenInput(id, min)).configs).toHaveLength(1);
    badReclaim(goldenInput(id, min - 1n));
  });
});
