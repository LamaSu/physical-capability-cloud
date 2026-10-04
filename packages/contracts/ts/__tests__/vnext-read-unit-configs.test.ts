/**
 * `readUnitConfigs` (../vnext/read.ts) against a SCRIPTED stub client, exactly like `vnext-preflight.test.ts`:
 * the chain is a stub that decodes each raw `eth_call` by selector and answers from a `UnitConfig[]` fixture
 * built with the REAL compiler (`buildUnitConfig` / `compileVNextPolicy`), never from hand-rolled hashes. The
 * stub implements ONLY `getChainId`, `getBlock` and `request` (raw JSON-RPC) — no `readContract` / `getCode` /
 * `simulateContract` — so any read that bypassed the pinned raw-call path would throw "not a function"
 * immediately rather than silently answering unpinned.
 *
 * The round-trip test asserts the EXACT set of check names, in order: dropping any one of them from the
 * implementation (a mutation) shrinks that array and fails the test, independent of whether the check is also
 * redundant with another on some OTHER input (several are: `prePolicyRoot` alone catches a tampered
 * `compositionRoot`, since neither `payoutConfigHash` nor the unit-id derivation depends on that field).
 *
 * `vnext-read-unit-configs.anvil.test.ts` runs this same function against the real contracts.
 */
import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
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
  buildUnitConfig,
  compileVNextPolicy,
  jobIdHashOf,
  payoutConfigHash,
  readUnitConfigs,
  VNextSettlementEscrowABI,
  type PayoutEntry,
  type UnitConfig,
} from "../vnext/index.js";

const k = (s: string): Hex => keccak256(stringToHex(s));
/**
 * A distinct, correctly-sized (20-byte) address per hex digit — no hand-counted hex strings. Checksummed
 * (EIP-55) at construction: viem's ABI decoder always returns addresses checksummed, regardless of the
 * case the caller supplied on encode, so a fixture address containing a letter (a-f) must already be in
 * its checksummed form or a correct round-trip would spuriously fail `toEqual` on case alone.
 */
const A = (digit: string): Address => getAddress(`0x${digit.repeat(40)}`);

const CHAIN_ID = 8453n;
const CHAIN_ID_NUM = Number(CHAIN_ID);
const FACTORY = A("a");
const IMPLEMENTATION = A("b");
const TOKEN = A("c");
const PAYER = A("d");
const OPERATOR = A("e");
const FEE_RECIPIENT = A("f");
const RECIP1 = A("1");
const RECIP2 = A("2");
const RECIP3 = A("3");

const FUNDING_TIME = 1_900_000_000n;

/** The fixture: 2 units, unit 0 with 2 payout legs and a nonzero compositionRoot, built with the REAL compiler. */
const compiled = compileVNextPolicy({
  chainId: CHAIN_ID,
  factory: FACTORY,
  implementation: IMPLEMENTATION,
  token: TOKEN,
  payer: PAYER,
  operator: OPERATOR,
  jobIdHash: jobIdHashOf("vnext:read-unit-configs:unit-test-job"),
  termsHash: k("terms"),
  policyNonce: 1n,
  acceptedPolicyDigest: zeroHash,
  expiry: 2_000_000_000n,
  fundingTime: FUNDING_TIME,
  units: [
    buildUnitConfig({
      milestoneIndex: 0n,
      stepId: k("step-0"),
      requiredTier: 1,
      g: 1_000_000_000n,
      feeBps: 250,
      feeRecipient: FEE_RECIPIENT,
      reclaimAt: FUNDING_TIME + 2_000_000n,
      compositionSchemaVersion: 1,
      compositionRoot: k("composition-root-0"),
      payouts: [
        { recipient: RECIP1, amount: 600_000_000n },
        { recipient: RECIP2, amount: 375_000_000n },
      ],
    }),
    buildUnitConfig({
      milestoneIndex: 1n,
      stepId: k("step-1"),
      requiredTier: 0,
      g: 5_000_000n,
      feeBps: 0,
      feeRecipient: zeroAddress,
      reclaimAt: FUNDING_TIME + 3_000_000n,
      compositionSchemaVersion: 0,
      compositionRoot: zeroHash,
      payouts: [{ recipient: RECIP3, amount: 5_000_000n }],
    }),
  ],
});

/** Every function the stub can answer, for decoding raw eth_call data by selector. */
const UNIT_READ_ABI = parseAbi([
  "function requiredTierOf(bytes32 unitId) view returns (uint8)",
  "function feeBpsOf(bytes32 unitId) view returns (uint16)",
  "function feeRecipientOf(bytes32 unitId) view returns (address)",
  "function feeAmountsOf(bytes32 unitId) view returns (uint256 g_, uint256 f_, uint256 n_)",
  "function compositionRootOf(bytes32 unitId) view returns (bytes32)",
  "function unitCounters(bytes32 unitId) view returns (uint256 liability_, uint256 payoutCount_, uint256 remainingClaimCount_)",
]);
const STUB_ABI = [...VNextSettlementEscrowABI, ...UNIT_READ_ABI] as Abi;

const HEAD = 12_345n;
const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const HEAD_HASH = hashOf(HEAD);

interface StubOpts {
  configs: readonly UnitConfig[];
  unitIds: readonly Hex[];
  jobIdHash: Hex;
  prePolicyRoot: Hex;
  /** Per-unit-index overrides for what `payoutAt`/`unitCounters` actually serve (default: `configs[i].payouts`). */
  servedPayouts?: Record<number, readonly PayoutEntry[]>;
  /** Per-unit-index override for `unitTerms().payoutConfigHash_` (default: the TRUE hash of the served payouts). */
  servedPayoutConfigHash?: Record<number, Hex>;
  /** Per-unit-index override for `compositionRootOf` (default: `configs[i].compositionRoot`). */
  servedCompositionRoot?: Record<number, Hex>;
  /** Sequence `getChainId()` returns, call by call; the last entry repeats once exhausted. Default: always CHAIN_ID_NUM. */
  chainIds?: number[];
  /** Make every raw `request` call throw, simulating a node that cannot serve EIP-1898 pinned calls at all. */
  pinUnsupported?: boolean;
  getBlockFails?: boolean;
}

type Call = { method: string; blockHash?: Hex; requireCanonical?: boolean };
type Stub = PublicClient & { calls: Call[] };

function serve(functionName: string, callArgs: readonly unknown[], o: StubOpts): unknown {
  const idxOf = (unitId: Hex) => o.unitIds.findIndex((id) => id.toLowerCase() === (unitId as string).toLowerCase());
  switch (functionName) {
    case "unitCount":
      return BigInt(o.configs.length);
    case "unitIdAt":
      return o.unitIds[Number(callArgs[0] as bigint)];
    case "jobIdHash":
      return o.jobIdHash;
    case "policy":
      return [zeroAddress, 0n, o.prePolicyRoot, zeroHash, zeroHash];
    case "unitTerms": {
      const unitId = callArgs[0] as Hex;
      const i = idxOf(unitId);
      const c = o.configs[i]!;
      // The FROZEN commitment: computed from the TRUE fixture payouts by default, never from `servedPayouts`
      // (which simulates what payoutAt/unitCounters report NOW, possibly a tampered disagreement with this
      // frozen value — that disagreement is exactly what check (1) must catch). Only `servedPayoutConfigHash`
      // itself overrides it, for a test that wants to corrupt the commitment directly.
      const hash = o.servedPayoutConfigHash?.[i] ?? payoutConfigHash(unitId, c.payouts);
      return [c.milestoneIndex, c.stepId, c.requestedTier, c.reclaimAt, hash, c.compositionSchemaVersion, false];
    }
    case "requiredTierOf":
      return o.configs[idxOf(callArgs[0] as Hex)]!.requiredTier;
    case "feeAmountsOf": {
      const c = o.configs[idxOf(callArgs[0] as Hex)]!;
      return [c.g, c.f, c.n];
    }
    case "feeBpsOf":
      return o.configs[idxOf(callArgs[0] as Hex)]!.feeBps;
    case "feeRecipientOf":
      return o.configs[idxOf(callArgs[0] as Hex)]!.feeRecipient;
    case "compositionRootOf": {
      const i = idxOf(callArgs[0] as Hex);
      return o.servedCompositionRoot?.[i] ?? o.configs[i]!.compositionRoot;
    }
    case "unitCounters": {
      const i = idxOf(callArgs[0] as Hex);
      const payouts = o.servedPayouts?.[i] ?? o.configs[i]!.payouts;
      return [0n, BigInt(payouts.length), 0n];
    }
    case "payoutAt": {
      const i = idxOf(callArgs[0] as Hex);
      const index = Number(callArgs[1] as bigint);
      const payouts = o.servedPayouts?.[i] ?? o.configs[i]!.payouts;
      const p = payouts[index]!;
      return [p.recipient, p.amount];
    }
    default:
      throw new Error(`stub: unscripted read ${functionName}`);
  }
}

function makeStub(o: StubOpts): Stub {
  const calls: Call[] = [];
  let chainCallIndex = 0;
  const client = {
    calls,
    getChainId: async () => {
      const seq = o.chainIds ?? [CHAIN_ID_NUM];
      const v = seq[Math.min(chainCallIndex, seq.length - 1)]!;
      chainCallIndex++;
      return v;
    },
    getBlock: async (params: Record<string, unknown> = {}) => {
      if (o.getBlockFails) throw new Error("block unavailable");
      const n = (params.blockNumber as bigint | undefined) ?? HEAD;
      return { number: n, hash: hashOf(n), timestamp: 0n };
    },
    // Raw JSON-RPC ONLY: an EIP-1898 (block-hash-pinned) caller's exclusive path. No readContract/getCode/
    // simulateContract is implemented on this stub at all, so a read that bypassed this path would throw.
    request: async (args: { method: string; params: unknown[] }) => {
      const block = args.params[args.params.length - 1] as { blockHash?: Hex; requireCanonical?: boolean };
      calls.push({ method: args.method, blockHash: block?.blockHash, requireCanonical: block?.requireCanonical });
      if (o.pinUnsupported) throw new Error("invalid argument 1: hex string without 0x prefix (EIP-1898 unsupported)");
      if (!block?.blockHash) throw new Error(`stub: ${args.method} called without a pinned block hash`);
      if (args.method === "eth_getCode") return "0x1234" as Hex;
      if (args.method !== "eth_call") throw new Error(`stub: unsupported method ${args.method}`);
      const tx = args.params[0] as { to: Address; data: Hex };
      const { functionName, args: callArgs } = decodeFunctionData({ abi: STUB_ABI, data: tx.data });
      const result = serve(functionName, (callArgs ?? []) as readonly unknown[], o);
      return encodeFunctionResult({ abi: STUB_ABI, functionName, result: result as never });
    },
  };
  return client as unknown as Stub;
}

const base = (): StubOpts => ({
  configs: compiled.configs,
  unitIds: compiled.unitIds,
  jobIdHash: compiled.identity.jobIdHash,
  prePolicyRoot: compiled.prePolicyRoot,
});
const failed = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe("readUnitConfigs", () => {
  it("round-trips: the reconstruction deep-equals the fixture, ok:true, with every proof check present and passing", async () => {
    const stub = makeStub(base());
    const r = await readUnitConfigs({ client: stub, escrow: compiled.escrow });

    expect(r.ok).toBe(true);
    expect(r.chainId).toBe(CHAIN_ID_NUM);
    expect(r.escrow).toBe(compiled.escrow);
    expect(r.blockNumber).toBe(HEAD);
    expect(r.blockHash).toBe(HEAD_HASH);
    expect(r.prePolicyRoot).toBe(compiled.prePolicyRoot);
    expect(r.units).toEqual(compiled.unitIds.map((unitId, i) => ({ unitId, config: compiled.configs[i] })));
    // The exact check vocabulary, in order: removing any one entry (a "drop check" mutation) fails this.
    expect(r.checks.map((c) => c.name)).toEqual([
      "pinned block",
      "escrow funded (unitCount > 0)",
      "units[0] payoutConfigHash",
      "units[0] unitId derivation",
      "units[1] payoutConfigHash",
      "units[1] unitId derivation",
      "prePolicyRoot",
      "chain id unchanged",
    ]);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("pins ONE block by HASH: getBlock() runs once, and every subsequent call addresses that hash (EIP-1898)", async () => {
    const stub = makeStub(base());
    const r = await readUnitConfigs({ client: stub, escrow: compiled.escrow });
    expect(r.ok).toBe(true);
    expect(stub.calls.length).toBeGreaterThan(10);
    expect(stub.calls.every((c) => c.blockHash === HEAD_HASH && c.requireCanonical === true)).toBe(true);
    const methods = new Set(stub.calls.map((c) => c.method));
    expect(methods.has("eth_getCode")).toBe(true);
    expect(methods.has("eth_call")).toBe(true);
    expect(methods.size).toBe(2);
  });

  it("honours an explicit blockNumber instead of the latest block", async () => {
    const stub = makeStub(base());
    const r = await readUnitConfigs({ client: stub, escrow: compiled.escrow, blockNumber: HEAD - 7n });
    expect(r.ok).toBe(true);
    expect(r.blockNumber).toBe(HEAD - 7n);
    expect(r.blockHash).toBe(hashOf(HEAD - 7n));
  });

  it("a tampered payout amount fails units[0] payoutConfigHash and, with it, the whole-escrow prePolicyRoot", async () => {
    const original = compiled.configs[0]!.payouts;
    const tampered: PayoutEntry[] = [{ recipient: original[0]!.recipient, amount: original[0]!.amount + 1n }, original[1]!];
    const stub = makeStub({ ...base(), servedPayouts: { 0: tampered } });
    const r = await readUnitConfigs({ client: stub, escrow: compiled.escrow });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["units[0] payoutConfigHash", "prePolicyRoot"]);
  });

  it("a swapped payout order fails units[0] payoutConfigHash and the whole-escrow prePolicyRoot", async () => {
    const original = compiled.configs[0]!.payouts;
    const swapped: PayoutEntry[] = [original[1]!, original[0]!];
    const stub = makeStub({ ...base(), servedPayouts: { 0: swapped } });
    const r = await readUnitConfigs({ client: stub, escrow: compiled.escrow });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["units[0] payoutConfigHash", "prePolicyRoot"]);
  });

  it("a wrong compositionRoot fails ONLY the whole-escrow prePolicyRoot: neither payoutConfigHash nor the unit-id derivation covers it", async () => {
    const wrongRoot = k("a-different-composition-root-entirely");
    const stub = makeStub({ ...base(), servedCompositionRoot: { 0: wrongRoot } });
    const r = await readUnitConfigs({ client: stub, escrow: compiled.escrow });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["prePolicyRoot"]);
    expect(r.units[0]!.config.compositionRoot).toBe(wrongRoot); // reported honestly, just flagged as unproven
  });

  it("fails closed when the node cannot serve calls pinned by block hash (EIP-1898), and does not throw", async () => {
    const stub = makeStub({ ...base(), pinUnsupported: true });
    const r = await readUnitConfigs({ client: stub, escrow: compiled.escrow });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["pinned block"]);
    expect(r.units).toEqual([]);
  });

  it("fails when the chain id changes during the read", async () => {
    const stub = makeStub({ ...base(), chainIds: [CHAIN_ID_NUM, CHAIN_ID_NUM + 1] });
    const r = await readUnitConfigs({ client: stub, escrow: compiled.escrow });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["chain id unchanged"]);
  });

  it("an unfunded clone returns ok:false with a clear check, and does not throw", async () => {
    const stub = makeStub({ configs: [], unitIds: [], jobIdHash: compiled.identity.jobIdHash, prePolicyRoot: zeroHash });
    const r = await readUnitConfigs({ client: stub, escrow: compiled.escrow });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(expect.arrayContaining(["escrow funded (unitCount > 0)", "prePolicyRoot"]));
    expect(r.units).toEqual([]);
  });
});
