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
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  getContractAddress,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  VNEXT_GOLDEN,
  VNextSettlementEscrowABI,
  VNextSettlementEscrowFactoryABI,
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
  /** The fund() simulation reverts with this escrow error (served to both the viem and the raw eth_call paths). */
  simulateRevert?: string;
  throwOn?: string;
};

/** Every function the stub can answer, for decoding raw eth_call data by selector. */
const STUB_ABI = [
  ...VNextSettlementEscrowFactoryABI,
  ...VNextSettlementEscrowABI,
  ...parseAbi([
    "function enabled() view returns (bool)",
    "function balanceOf(address account) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
  ]),
] as Abi;

/** The latest block the stub serves when no block is named. */
const HEAD = 5_000n;
const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

type Call = {
  kind: "getBlock" | "readContract" | "getCode" | "simulateContract" | "request";
  params: Record<string, unknown>;
};
type Stub = PublicClient & { calls: Call[] };

/** Knobs for the adversarial cases: what the head block reads as, per-HASH state, and a hook run on each read. */
type Adversary = {
  /** What getBlock() returns for the head: a block number and the hash the node reported at that moment. */
  head?: { number: bigint; hash: Hex };
  /** State served to calls pinned by block HASH (EIP-1898), overriding the by-number state for that hash. */
  byHash?: Record<string, Partial<Chain>>;
  /** Run before answering each contract read (to mutate caller-owned inputs mid-flight). */
  onRead?: (functionName: string) => void;
};

/**
 * `over` applies at every block; `atBlock[n]` overrides it at block n only. Every request is recorded, and every
 * block-scoped request is answered from the state AT the block it names (the head when it names none).
 */
function chain(
  over: Partial<Chain> = {},
  atBlock: Record<string, Partial<Chain>> = {},
  blockReadFails = false,
  adv: Adversary = {},
): Stub {
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
  /** State for a call pinned by hash: the per-hash override if any, else the block the hash names in this stub. */
  const atHash = (h: string): Chain => ({ ...at(BigInt(h)), ...(adv.byHash?.[h.toLowerCase()] ?? {}) });
  const revertOf = (st: Chain): unknown =>
    st.simulateRevert
      ? new ContractFunctionExecutionError(
          new ContractFunctionRevertedError({
            abi: VNextSettlementEscrowABI,
            data: encodeErrorResult({ abi: VNextSettlementEscrowABI, errorName: st.simulateRevert as never }),
            functionName: "fund",
          }),
          { abi: VNextSettlementEscrowABI, functionName: "fund", args: [] },
        )
      : st.simulateError;
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
    enabled: (st, a) => (a.toLowerCase() === PRIMARY.toLowerCase() ? st.primaryEnabled : st.escalationEnabled),
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
      if (adv.head && params.blockNumber === undefined) {
        return { number: adv.head.number, hash: adv.head.hash, timestamp: atHash(adv.head.hash).timestamp };
      }
      const n = (params.blockNumber as bigint | undefined) ?? HEAD;
      return { number: n, hash: hashOf(n), timestamp: at(n).timestamp };
    },
    // Raw JSON-RPC, as an EIP-1898 (block-hash-pinned) caller uses it: eth_call and eth_getCode only.
    request: async (args: { method: string; params: unknown[] }) => {
      calls.push({ kind: "request", params: args as unknown as Record<string, unknown> });
      const block = args.params[args.params.length - 1] as { blockHash?: Hex; requireCanonical?: boolean };
      if (!block?.blockHash) throw new Error(`stub: ${args.method} without a block hash`);
      const st = atHash(block.blockHash);
      if (args.method === "eth_getCode") return st.code;
      if (args.method !== "eth_call") throw new Error(`stub: unsupported ${args.method}`);
      const tx = args.params[0] as { to: Address; data: Hex; from?: Address };
      const { functionName } = decodeFunctionData({ abi: STUB_ABI, data: tx.data });
      if (functionName === "fund") {
        const err = revertOf(st);
        if (err instanceof ContractFunctionExecutionError) {
          const data = (err.cause as ContractFunctionRevertedError).raw;
          throw Object.assign(new Error("execution reverted"), { code: 3, data });
        }
        if (err) throw err;
        return "0x";
      }
      adv.onRead?.(functionName);
      if (st.throwOn === functionName) throw new Error(`execution reverted: ${functionName}`);
      const fn = reads[functionName];
      if (!fn) throw new Error(`unscripted read: ${functionName}`);
      return encodeFunctionResult({ abi: STUB_ABI, functionName, result: fn(st, tx.to) as never });
    },
    getCode: async (params: Record<string, unknown>) => {
      calls.push({ kind: "getCode", params });
      return at(params.blockNumber).code;
    },
    readContract: async (params: Record<string, unknown>) => {
      calls.push({ kind: "readContract", params });
      const st = at(params.blockNumber);
      const functionName = params.functionName as string;
      adv.onRead?.(functionName);
      if (st.throwOn === functionName) throw new Error(`execution reverted: ${functionName}`);
      const fn = reads[functionName];
      if (!fn) throw new Error(`unscripted read: ${functionName}`);
      return fn(st, params.address as Address);
    },
    simulateContract: async (params: Record<string, unknown>) => {
      calls.push({ kind: "simulateContract", params });
      const st = at(params.blockNumber);
      const err = revertOf(st);
      if (err) throw err;
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
    ["a read that reverts", { throwOn: "fundedEscrowOf" }, "job not already funded"],
  ];
  for (const [what, over, check] of cases) {
    it(`fails on ${what}, naming "${check}"`, async () => {
      const r = await preflightVNextFunding(chain(over), { compiled, acceptance: signed, sender: RELAYER });
      expect(r.ok).toBe(false);
      expect(failed(r)).toContain(check);
    });
  }

  it("reports a short balance or allowance as a DIAGNOSTIC; the simulation of the pull decides", async () => {
    const short = { balance: compiled.totalGross - 1n, allowance: compiled.totalGross - 1n };
    const r = await preflightVNextFunding(chain({ ...short, simulateRevert: "FundingDeltaMismatch" }), {
      compiled,
      acceptance: signed,
      sender: RELAYER,
    });
    expect(failed(r)).toEqual([]);
    expect(r.diagnostics.filter((d) => !d.ok).map((d) => d.name)).toEqual(["payer balance", "payer allowance to the escrow"]);
    expect(r.simulation).toEqual({ ok: false, error: "FundingDeltaMismatch" });
    expect(r.ok).toBe(false);
  });

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
    const r = await preflightVNextFunding(chain({ simulateRevert: "BadSignature" }), { compiled, acceptance: signed, sender: RELAYER });
    expect(failed(r)).toEqual([]);
    expect(r.simulation).toEqual({ ok: false, error: "BadSignature" });
    expect(r.ok).toBe(false);
  });
});

describe("preflightVNextFunding: one block, this policy, this exact call (astra review of #367)", () => {
  it("pins ONE block by HASH: reads it once, and every read, the code lookup and the simulation address it (EIP-1898)", async () => {
    const c = chain();
    const r = await preflightVNextFunding(c, { compiled, acceptance: signed, sender: RELAYER });
    expect(r.ok).toBe(true);
    expect(r.blockNumber).toBe(HEAD);
    expect(r.blockHash).toBe(hashOf(HEAD));
    expect(c.calls.filter((x) => x.kind === "getBlock")).toHaveLength(1);
    const scoped = c.calls.filter((x) => x.kind !== "getBlock");
    expect(scoped.length).toBeGreaterThan(15);
    expect(scoped.every((x) => x.kind === "request")).toBe(true);
    const pins = scoped.map((x) => {
      const params = (x.params as unknown as { params: unknown[] }).params;
      return params[params.length - 1];
    });
    expect(pins.every((b) => JSON.stringify(b) === JSON.stringify({ blockHash: hashOf(HEAD), requireCanonical: true }))).toBe(true);
    const methods = scoped.map((x) => (x.params as unknown as { method: string }).method);
    expect(methods).toContain("eth_getCode");
    expect(methods).toContain("eth_call");
  });

  it("fails closed when the node cannot serve calls pinned by block hash", async () => {
    const c = chain();
    (c as unknown as { request: unknown }).request = async () => {
      throw new Error("invalid argument 1: hex string without 0x prefix (EIP-1898 unsupported)");
    };
    const r = await preflightVNextFunding(c, { compiled, acceptance: signed, sender: RELAYER });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["pinned block"]);
    expect(r.simulation.ok).toBe(false);
  });

  it("fails when the chain id changes during the preflight", async () => {
    const c = chain();
    let n = 0;
    (c as unknown as { getChainId: () => Promise<number> }).getChainId = async () => (n++ === 0 ? Number(G.inputs.chainId) : 1);
    const r = await preflightVNextFunding(c, { compiled, acceptance: signed, sender: RELAYER });
    expect(failed(r)).toEqual(["chain id unchanged"]);
    expect(r.ok).toBe(false);
  });

  it("reports the state AT the pinned block, not at the head", async () => {
    const c = () => chain({}, { [String(HEAD)]: { primaryEnabled: false, simulateRevert: "InvalidOrDisabledCohort" } });
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
    const r = await preflightVNextFunding(c, { compiled, acceptance: signed, sender: RELAYER, blockNumber: HEAD - 7n });
    const sims = c.calls.filter((x) => {
      const req = x.params as unknown as { method?: string; params?: unknown[] };
      return x.kind === "request" && req.method === "eth_call" && (req.params?.[0] as { from?: string })?.from !== undefined;
    });
    expect(sims).toHaveLength(1);
    const req = sims[0]!.params as unknown as { params: [{ from: Address; to: Address; data: Hex }, { blockHash: Hex }] };
    expect(req.params[0].to).toBe(compiled.escrow);
    expect(req.params[0].from).toBe(RELAYER);
    expect(req.params[1].blockHash).toBe(hashOf(HEAD - 7n));
    const { functionName, args } = decodeFunctionData({ abi: VNextSettlementEscrowABI, data: req.params[0].data });
    expect(functionName).toBe("fund");
    const [configs, acceptance] = args as unknown as [unknown, PolicyAcceptance];
    expect(configs).toEqual(compiled.configs);
    expect(acceptance).toEqual(signed);
    // ...and the result hands back exactly what it judged, as a copy (not the caller's own object).
    expect(r.fundArgs[1]).toEqual(signed);
    expect(r.fundArgs[1]).not.toBe(signed);
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

describe("preflightVNextFunding: one block IDENTITY, one frozen input (astra round 2 on #367, pack 26b)", () => {
  it("F1: a reorganized block cannot pass for the one it read: every call is pinned to the block HASH", async () => {
    // getBlock() reports block N as H1, where the primary cohort is DISABLED and fund() reverts. Block N is then
    // reorganized: calls pinned only by NUMBER now reach a replacement block where everything passes.
    const H1 = hashOf(HEAD);
    const c = chain(
      {},
      {},
      false,
      { head: { number: HEAD, hash: H1 }, byHash: { [H1]: { primaryEnabled: false, simulateRevert: "InvalidOrDisabledCohort" } } },
    );
    const r = await preflightVNextFunding(c, { compiled, acceptance: signed, sender: RELAYER });
    expect(r.blockHash).toBe(H1);
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("primary cohort enabled");
    expect(r.simulation).toEqual({ ok: false, error: "InvalidOrDisabledCohort" });
  });

  it("F2: inputs are frozen at the call: a caller that swaps the acceptance mid-flight changes nothing that is judged", async () => {
    const acceptance: PolicyAcceptance = { ...signed };
    const laterSig = `0x${"22".repeat(65)}` as Hex;
    const c = chain({}, {}, false, {
      onRead: (fn) => {
        if (fn === "balanceOf") {
          acceptance.expiry = compiled.expiry + 99n;
          acceptance.payerSignature = laterSig;
          acceptance.operatorSignature = laterSig;
        }
      },
    });
    const r = await preflightVNextFunding(c, { compiled, acceptance, sender: RELAYER });
    const sims = c.calls.filter((x) => x.kind === "simulateContract" || (x.kind === "request" && JSON.stringify(x.params).includes('"eth_call"')));
    const fundCall = sims.find((x) => x.kind === "simulateContract") ?? sims[sims.length - 1];
    const simulated = JSON.stringify(fundCall?.params, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(simulated).not.toContain(laterSig.slice(2));
    expect(r.ok).toBe(true);
    expect(r.checks.find((x) => x.name === "acceptance expiry matches the compiled policy")?.ok).toBe(true);
  });

  it("F3: balance and allowance are DIAGNOSTICS: a short reported balance never vetoes a fund() that simulates", async () => {
    const r = await preflightVNextFunding(chain({ balance: 0n, allowance: 0n }), { compiled, acceptance: signed, sender: RELAYER });
    expect(r.simulation).toEqual({ ok: true });
    expect(r.ok).toBe(true);
  });
});
