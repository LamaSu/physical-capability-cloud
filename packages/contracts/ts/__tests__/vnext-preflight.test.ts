/**
 * The funding preflight (doc §5.2): each LIVE prerequisite a pure compile cannot see must fail the
 * preflight BY NAME, and a reverting simulation must fail it even when every named check passes.
 * The chain is a scripted stub. The real `fund()` behaviour behind each prerequisite is pinned by the
 * forge suites.
 */
import { describe, expect, it } from "vitest";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  getContractAddress,
  keccak256,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  VNEXT_GOLDEN,
  VNextSettlementEscrowABI,
  buildUnitConfig,
  compileVNextPolicy,
  jobIdHashOf,
  preflightVNextFunding,
  type PolicyAcceptance,
} from "../vnext/index.js";

const G = VNEXT_GOLDEN;
const k = (s: string): Hex => keccak256(stringToHex(s));
const TOKEN: Address = "0x5555555555555555555555555555555555555555";
const PRIMARY: Address = "0x00000000000000000000000000000000000000a1";
const ESCALATION: Address = "0x00000000000000000000000000000000000000a2";
const RELAYER: Address = "0x000000000000000000000000000000000000bEEF";
const FACTORY = getContractAddress({ from: G.inputs.factoryDeployer, nonce: 0n });
const IMPLEMENTATION = getContractAddress({ from: FACTORY, nonce: 1n });

const compiled = compileVNextPolicy({
  chainId: G.inputs.chainId,
  factory: FACTORY,
  implementation: IMPLEMENTATION,
  token: TOKEN,
  payer: G.inputs.payer,
  operator: G.inputs.operator,
  jobIdHash: jobIdHashOf(G.inputs.jobId),
  termsHash: k(G.inputs.terms),
  policyNonce: G.inputs.policyNonce,
  acceptedPolicyDigest: k(G.inputs.acceptedPolicy),
  expiry: G.inputs.expiry,
  fundingTime: G.inputs.fundingTime,
  units: G.inputs.units.map((u) =>
    buildUnitConfig({
      milestoneIndex: u.milestoneIndex,
      stepId: k(u.step),
      requiredTier: u.requiredTier,
      g: u.g,
      feeBps: u.feeBps,
      feeRecipient: u.feeRecipient,
      reclaimAt: u.reclaimAt,
      compositionSchemaVersion: u.compositionSchemaVersion,
      compositionRoot: u.compositionRoot === null ? zeroHash : k(u.compositionRoot),
      payouts: u.payouts,
    }),
  ),
});

const sig = `0x${"11".repeat(65)}` as Hex;
const signed: PolicyAcceptance = { expiry: G.inputs.expiry, payerSignature: sig, operatorSignature: sig };

type Chain = {
  chainId: number;
  implementation: Address;
  predicted: Address;
  code: Hex;
  initialized: boolean;
  sealed: boolean;
  policyNonce: bigint;
  jobPolicyHash: Hex;
  usdc: Address;
  primaryEnabled: boolean;
  escalationEnabled: boolean;
  floor: bigint;
  funded: Address;
  timestamp: bigint;
  balance: bigint;
  allowance: bigint;
  simulateError?: unknown;
  throwOn?: string;
};

function chain(over: Partial<Chain> = {}): PublicClient {
  const st: Chain = {
    chainId: Number(G.inputs.chainId),
    implementation: IMPLEMENTATION,
    predicted: compiled.escrow,
    code: "0x363d3d373d3d3d363d73",
    initialized: true,
    sealed: false,
    policyNonce: compiled.identity.policyNonce,
    jobPolicyHash: zeroHash,
    usdc: TOKEN,
    primaryEnabled: true,
    escalationEnabled: true,
    floor: compiled.identity.policyNonce,
    funded: zeroAddress,
    timestamp: G.inputs.fundingTime,
    balance: compiled.totalGross,
    allowance: compiled.totalGross,
    ...over,
  };
  const id = compiled.identity;
  const reads: Record<string, (address: Address) => unknown> = {
    implementation: () => st.implementation,
    predictEscrow: () => st.predicted,
    initialized: () => st.initialized,
    configurationSealed: () => st.sealed,
    policy: () => [id.operator, st.policyNonce, id.prePolicyRoot, st.jobPolicyHash, id.acceptedPolicyDigest],
    payer: () => id.payer,
    jobIdHash: () => id.jobIdHash,
    termsHash: () => id.termsHash,
    USDC: () => st.usdc,
    authorizedOracle: () => PRIMARY,
    escalationAttester: () => ESCALATION,
    enabled: (a) => (a === PRIMARY ? st.primaryEnabled : st.escalationEnabled),
    policyNonceFloor: () => st.floor,
    fundedEscrowOf: () => st.funded,
    balanceOf: () => st.balance,
    allowance: () => st.allowance,
  };
  return {
    getChainId: async () => st.chainId,
    getBlock: async () => ({ timestamp: st.timestamp }),
    getCode: async () => st.code,
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (st.throwOn === functionName) throw new Error(`execution reverted: ${functionName}`);
      const fn = reads[functionName];
      if (!fn) throw new Error(`unscripted read: ${functionName}`);
      return fn(address);
    },
    simulateContract: async () => {
      if (st.simulateError) throw st.simulateError;
      return { result: undefined };
    },
  } as unknown as PublicClient;
}

const failed = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe("preflightVNextFunding", () => {
  it("passes when every live prerequisite holds and the signed fund() simulates", async () => {
    const r = await preflightVNextFunding(chain(), { compiled, acceptance: signed, sender: RELAYER });
    expect(failed(r)).toEqual([]);
    expect(r.simulation).toEqual({ ok: true });
    expect(r.ok).toBe(true);
  });

  const cases: [string, Partial<Chain>, string][] = [
    ["a disabled primary cohort", { primaryEnabled: false }, "primary cohort enabled"],
    ["a disabled escalation cohort", { escalationEnabled: false }, "escalation cohort enabled"],
    ["a revoked or superseded nonce", { floor: compiled.identity.policyNonce + 1n }, "policy nonce not revoked or superseded"],
    ["a job funded by another escrow", { funded: RELAYER }, "job not already funded"],
    ["a sealed clone", { sealed: true }, "escrow initialized, not sealed"],
    ["an uninitialized clone", { initialized: false }, "escrow initialized, not sealed"],
    ["an already-funded clone", { jobPolicyHash: `0x${"ab".repeat(32)}` as Hex }, "escrow identity"],
    ["another implementation", { implementation: RELAYER }, "implementation"],
    ["another chain", { chainId: 1 }, "chain id"],
    ["another settlement token", { usdc: RELAYER }, "settlement token"],
    ["an expired acceptance", { timestamp: G.inputs.expiry + 1n }, "acceptance not expired"],
    ["a short allowance", { allowance: compiled.totalGross - 1n }, "payer allowance to the escrow"],
    ["a short balance", { balance: compiled.totalGross - 1n }, "payer balance"],
    ["a read that reverts", { throwOn: "fundedEscrowOf" }, "job not already funded"],
  ];
  for (const [what, over, check] of cases) {
    it(`fails on ${what}, naming "${check}"`, async () => {
      const r = await preflightVNextFunding(chain(over), { compiled, acceptance: signed, sender: RELAYER });
      expect(r.ok).toBe(false);
      expect(failed(r)).toContain(check);
    });
  }

  it("fails a relayer that carries no payer signature (OnlyPayer); the payer itself may send without one", async () => {
    const unsignedByPayer = { ...signed, payerSignature: "0x" as Hex };
    const byRelayer = await preflightVNextFunding(chain(), { compiled, acceptance: unsignedByPayer, sender: RELAYER });
    expect(failed(byRelayer)).toContain("acceptance shape");
    const byPayer = await preflightVNextFunding(chain(), { compiled, acceptance: unsignedByPayer, sender: G.inputs.payer });
    expect(failed(byPayer)).toEqual([]);
  });

  it("does not simulate against an escrow that does not exist yet", async () => {
    const r = await preflightVNextFunding(chain({ code: "0x" }), { compiled, acceptance: signed, sender: RELAYER });
    expect(failed(r)).toContain("escrow created");
    expect(r.simulation.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("fails on a reverting simulation even when every named check passes, and names the contract error", async () => {
    const reverted = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({
        abi: VNextSettlementEscrowABI,
        data: encodeErrorResult({ abi: VNextSettlementEscrowABI, errorName: "BadSignature" }),
        functionName: "fund",
      }),
      { abi: VNextSettlementEscrowABI, functionName: "fund", args: [] },
    );
    const r = await preflightVNextFunding(chain({ simulateError: reverted }), { compiled, acceptance: signed, sender: RELAYER });
    expect(failed(r)).toEqual([]);
    expect(r.simulation).toEqual({ ok: false, error: "BadSignature" });
    expect(r.ok).toBe(false);
  });
});
