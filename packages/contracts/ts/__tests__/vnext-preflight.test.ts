/**
 * The funding preflight (doc §5.2): each LIVE prerequisite a pure compile cannot see must fail the
 * preflight BY NAME, and a reverting simulation must fail it even when every named check passes.
 * The chain is a scripted stub that RECORDS every request and serves state PER BLOCK, so these tests also
 * pin what the preflight asks for: one block for everything, and exactly the signed fund() from the sender
 * (astra review of #367). The real `fund()` behaviour behind each prerequisite is pinned by the forge
 * suites, and `vnext-preflight.anvil.test.ts` runs this preflight against the real contracts.
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

/** The latest block the stub serves when no block is named. */
const HEAD = 5_000n;
const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

type Call = { kind: "getBlock" | "readContract" | "getCode" | "simulateContract"; params: Record<string, unknown> };
type Stub = PublicClient & { calls: Call[] };

/**
 * `over` applies at every block; `atBlock[n]` overrides it at block n only. Every request is recorded, and every
 * block-scoped request is answered from the state AT the block it names (the head when it names none).
 */
function chain(over: Partial<Chain> = {}, atBlock: Record<string, Partial<Chain>> = {}, blockReadFails = false): Stub {
  const base: Chain = {
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
  const at = (n: unknown): Chain => ({ ...base, ...(atBlock[String((n as bigint | undefined) ?? HEAD)] ?? {}) });
  const id = compiled.identity;
  const reads: Record<string, (st: Chain, address: Address) => unknown> = {
    implementation: (st) => st.implementation,
    predictEscrow: (st) => st.predicted,
    initialized: (st) => st.initialized,
    configurationSealed: (st) => st.sealed,
    policy: (st) => [id.operator, st.policyNonce, id.prePolicyRoot, st.jobPolicyHash, id.acceptedPolicyDigest],
    payer: () => id.payer,
    jobIdHash: () => id.jobIdHash,
    termsHash: () => id.termsHash,
    USDC: (st) => st.usdc,
    authorizedOracle: () => PRIMARY,
    escalationAttester: () => ESCALATION,
    enabled: (st, a) => (a === PRIMARY ? st.primaryEnabled : st.escalationEnabled),
    policyNonceFloor: (st) => st.floor,
    fundedEscrowOf: (st) => st.funded,
    balanceOf: (st) => st.balance,
    allowance: (st) => st.allowance,
  };
  const calls: Call[] = [];
  return {
    calls,
    getChainId: async () => base.chainId,
    getBlock: async (params: Record<string, unknown> = {}) => {
      calls.push({ kind: "getBlock", params });
      if (blockReadFails) throw new Error("block unavailable");
      const n = (params.blockNumber as bigint | undefined) ?? HEAD;
      return { number: n, hash: hashOf(n), timestamp: at(n).timestamp };
    },
    getCode: async (params: Record<string, unknown>) => {
      calls.push({ kind: "getCode", params });
      return at(params.blockNumber).code;
    },
    readContract: async (params: Record<string, unknown>) => {
      calls.push({ kind: "readContract", params });
      const st = at(params.blockNumber);
      const functionName = params.functionName as string;
      if (st.throwOn === functionName) throw new Error(`execution reverted: ${functionName}`);
      const fn = reads[functionName];
      if (!fn) throw new Error(`unscripted read: ${functionName}`);
      return fn(st, params.address as Address);
    },
    simulateContract: async (params: Record<string, unknown>) => {
      calls.push({ kind: "simulateContract", params });
      const st = at(params.blockNumber);
      if (st.simulateError) throw st.simulateError;
      return { result: undefined };
    },
  } as unknown as Stub;
}

const failed = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

/** Every custom error the escrow, the factory's acceptPolicy and SafeERC20 declare on the `fund()` path (enumerated from
 *  the Solidity by hand). A token's own revert data is outside this list and can still surface undecoded. */
const FUND_PATH_ERRORS = [
  "NotInitialized", "AlreadySealed", "Reentrancy", "ConfigTooLarge", "SignatureTooLarge", "BadUnitCount", "OnlyPayer",
  "InvalidOrDisabledCohort", "TierRequestMismatch", "TierOutOfRange", "ValueOverflow", "DuplicateUnit", "BadLegCount",
  "ZeroPayout", "ForbiddenRecipient", "PayoutSumMismatch", "BadReclaim", "TooManyLegs", "PolicyRootMismatch",
  "NotThePolicyEscrow", "PolicyExpired", "PolicyNoLongerValid", "JobAlreadyFunded", "BadSignature",
  "BadOperatorSignature", "BalanceReadFailed", "FundingDeltaMismatch", "SafeERC20FailedOperation",
];

describe("the escrow ABI subset declares every escrow, factory and SafeERC20 error on the fund() path", () => {
  it("declares each one", () => {
    const declared = new Set(VNextSettlementEscrowABI.filter((x) => x.type === "error").map((x) => (x as { name: string }).name));
    expect(FUND_PATH_ERRORS.filter((e) => !declared.has(e))).toEqual([]);
  });
});

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

describe("preflightVNextFunding: one block, this policy, this exact call (astra review of #367)", () => {
  it("pins ONE block: reads it once, and every read, the code lookup and the simulation carry it", async () => {
    const c = chain();
    const r = await preflightVNextFunding(c, { compiled, acceptance: signed, sender: RELAYER });
    expect(r.ok).toBe(true);
    expect(r.blockNumber).toBe(HEAD);
    expect(r.blockHash).toBe(hashOf(HEAD));
    expect(c.calls.filter((x) => x.kind === "getBlock")).toHaveLength(1);
    const scoped = c.calls.filter((x) => x.kind !== "getBlock");
    expect(scoped.length).toBeGreaterThan(15);
    expect(scoped.filter((x) => x.params.blockNumber !== HEAD).map((x) => `${x.kind}:${String(x.params.functionName)}`)).toEqual([]);
    expect(scoped.map((x) => x.kind)).toContain("getCode");
    expect(scoped.map((x) => x.kind)).toContain("simulateContract");
  });

  it("reports the state AT the pinned block, not at the head", async () => {
    const c = () => chain({}, { [String(HEAD)]: { primaryEnabled: false, simulateError: new Error("InvalidOrDisabledCohort") } });
    const atHead = await preflightVNextFunding(c(), { compiled, acceptance: signed, sender: RELAYER });
    expect(failed(atHead)).toEqual(["primary cohort enabled"]);
    expect(atHead.simulation.ok).toBe(false);
    const earlier = await preflightVNextFunding(c(), { compiled, acceptance: signed, sender: RELAYER, blockNumber: HEAD - 1n });
    expect(earlier.blockNumber).toBe(HEAD - 1n);
    expect(failed(earlier)).toEqual([]);
    expect(earlier.simulation).toEqual({ ok: true });
    expect(earlier.ok).toBe(true);
  });

  it("checks the expiry and every reclaim window against the PINNED block's timestamp", async () => {
    const c = () => chain({}, { [String(HEAD - 1n)]: { timestamp: compiled.expiry }, [String(HEAD)]: { timestamp: compiled.expiry + 1n } });
    const atExpiry = await preflightVNextFunding(c(), { compiled, acceptance: signed, sender: RELAYER, blockNumber: HEAD - 1n });
    expect(atExpiry.blockTimestamp).toBe(compiled.expiry);
    expect(failed(atExpiry)).not.toContain("acceptance not expired"); // inclusive, as the factory's `block.timestamp > expiry`
    const after = await preflightVNextFunding(c(), { compiled, acceptance: signed, sender: RELAYER });
    expect(after.blockTimestamp).toBe(compiled.expiry + 1n);
    expect(failed(after)).toContain("acceptance not expired");
  });

  it("simulates EXACTLY the signed fund(): the compiled escrow and configs, this acceptance, from this sender, at the pinned block", async () => {
    const c = chain();
    await preflightVNextFunding(c, { compiled, acceptance: signed, sender: RELAYER, blockNumber: HEAD - 7n });
    const sims = c.calls.filter((x) => x.kind === "simulateContract");
    expect(sims).toHaveLength(1);
    const s = sims[0]!.params;
    expect(s.address).toBe(compiled.escrow);
    expect(s.functionName).toBe("fund");
    expect(s.account).toBe(RELAYER);
    expect(s.blockNumber).toBe(HEAD - 7n);
    const [configs, acceptance] = s.args as [unknown, unknown];
    expect(configs).toEqual(compiled.configs);
    expect(acceptance).toBe(signed); // the caller's own object, not a rebuilt one
  });

  it("fails an acceptance whose expiry is not the compiled expiry, even when the chain would accept it", async () => {
    // astra's case: an acceptance freshly signed for a LATER expiry funds a differently dated policy. The simulation
    // (stubbed here to pass, as the real one would for a validly signed later expiry) must not carry the result.
    const later = { ...signed, expiry: compiled.expiry + 99n };
    const r = await preflightVNextFunding(chain(), { compiled, acceptance: later, sender: RELAYER });
    expect(r.simulation).toEqual({ ok: true });
    expect(failed(r)).toEqual(["acceptance expiry matches the compiled policy"]);
    expect(r.ok).toBe(false);
  });

  it("a block it cannot read fails by name, and nothing else runs", async () => {
    const c = chain({}, {}, true);
    const r = await preflightVNextFunding(c, { compiled, acceptance: signed, sender: RELAYER });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["pinned block"]);
    expect(r.blockNumber).toBeNull();
    expect(c.calls.map((x) => x.kind)).toEqual(["getBlock"]);
  });
});
