/**
 * The V-next compiler against the frozen golden vectors (docs/VNEXT_SETTLEMENT_ABI.md §8).
 *
 * `VNEXT_GOLDEN` was computed by an independent clean-room implementation that read only the doc.
 * `test/VNextAbiFreeze.t.sol` asserts the same literals against the real contracts, so a pass here
 * and a pass there mean the compiler and the contracts agree byte for byte.
 */
import { describe, expect, it } from "vitest";
import {
  getContractAddress,
  hashTypedData,
  keccak256,
  stringToHex,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import {
  ClaimClass,
  VNEXT,
  VNEXT_GOLDEN,
  VNextCompileError,
  VNextSettlementEscrowABI,
  VNextSettlementEscrowFactoryABI,
  buildUnitConfig,
  claimId,
  cloneInitCodeHash,
  compileVNextPolicy,
  computeFee,
  encodeFundCalldata,
  encodeUnitConfigs,
  evidenceCommitment,
  jobIdHashOf,
  prePolicyRoot,
  settlementUnitId,
  type UnitConfig,
  type VNextCompileErrorCode,
  type VNextCompileInput,
} from "../vnext/index.js";

const G = VNEXT_GOLDEN;
const k = (s: string): Hex => keccak256(stringToHex(s));
const lc = (s: string) => s.toLowerCase();
/** The settlement token only matters for the recipient-exclusion rule; it enters no hash. */
const TOKEN: Address = "0x5555555555555555555555555555555555555555";

const FACTORY = getContractAddress({ from: G.inputs.factoryDeployer, nonce: 0n });
const IMPLEMENTATION = getContractAddress({ from: FACTORY, nonce: 1n });

function goldenUnits(): UnitConfig[] {
  return G.inputs.units.map((u) =>
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
  );
}

function goldenInput(units: UnitConfig[] = goldenUnits()): VNextCompileInput {
  return {
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
    units,
  };
}

function expectCode(fn: () => unknown, code: VNextCompileErrorCode) {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected ${code}, nothing was thrown`).toBeInstanceOf(VNextCompileError);
  expect((caught as VNextCompileError).code).toBe(code);
}

/** A copy of unit `i` with `edit` applied; every other unit is untouched. */
function withUnit(i: number, edit: (u: UnitConfig) => UnitConfig): UnitConfig[] {
  return goldenUnits().map((u, j) => (j === i ? edit({ ...u, payouts: u.payouts.map((p) => ({ ...p })) }) : u));
}

describe("V-next golden vectors: self-check anchors", () => {
  it("reproduces the repo's CREATE anchor and the cast-computed evidence-commitment golden", () => {
    expect(lc(getContractAddress({ from: "0x00000000000000000000000000000000000000D0", nonce: 0n }))).toBe(
      "0xe61244bb1242d392fb53df4979a62e955a9bc70d",
    );
    const esc: Address = "0x00000000000000000000000000000000000e5c0f"; // address(0xE5C0F), lowercase: viem enforces EIP-55 on mixed case
    const unit = settlementUnitId({
      chainId: 8453n,
      escrow: esc,
      jobIdHash: k("golden-job"),
      milestoneIndex: 3n,
      stepId: k("golden-step"),
    });
    expect(
      evidenceCommitment({
        chainId: 8453n,
        escrow: esc,
        settlementUnitId: unit,
        compositionSchemaVersion: 1,
        packageDigest: k("golden-evidence-package"),
      }),
    ).toBe("0xba4753b572b0d79518e05c88932d213125d0634a2c2fbbd7e74d7d52578eb7aa");
  });

  it("derives the pinned constants from their preimages", () => {
    for (const [name, value] of Object.entries(G.constants)) {
      expect(VNEXT[name as keyof typeof VNEXT], name).toBe(value);
    }
  });

  it("derives the pinned golden inputs", () => {
    expect(jobIdHashOf(G.inputs.jobId)).toBe(G.derivedInputs.jobIdHash);
    expect(k(G.inputs.terms)).toBe(G.derivedInputs.termsHash);
    expect(k(G.inputs.acceptedPolicy)).toBe(G.derivedInputs.acceptedPolicyDigest);
    expect(k(G.inputs.units[0].step)).toBe(G.derivedInputs.stepIdA);
    expect(k(G.inputs.units[1].step)).toBe(G.derivedInputs.stepIdB);
    expect(k(G.inputs.units[0].compositionRoot as string)).toBe(G.derivedInputs.compositionRoot);
    expect(k(G.inputs.evidence.package)).toBe(G.derivedInputs.packageDigest);
  });
});

describe("V-next compiler: the golden job, byte for byte", () => {
  const compiled = compileVNextPolicy(goldenInput());
  const out = G.outputs;

  it("places the factory and the implementation where the forge test deploys them", () => {
    expect(FACTORY).toBe(out.factory);
    expect(IMPLEMENTATION).toBe(out.implementation);
    expect(cloneInitCodeHash(IMPLEMENTATION)).toBe(out.initCodeHash);
  });

  it("derives f and n with the escrow's floor rule", () => {
    compiled.configs.forEach((c, i) => {
      expect(c.f).toBe(out.fees[i].f);
      expect(c.n).toBe(out.fees[i].n);
      expect(computeFee(c.g, c.feeBps)).toEqual(out.fees[i]);
    });
  });

  it("matches every address-independent and address-dependent value", () => {
    expect((encodeUnitConfigs(compiled.configs).length - 2) / 2).toBe(out.encodedConfigsLength);
    expect(compiled.prePolicyRoot).toBe(out.prePolicyRoot);
    expect(compiled.salt).toBe(out.salt);
    expect(compiled.escrow).toBe(out.escrow);
    expect(compiled.unitIds).toEqual(out.unitIds);
    expect(compiled.unitsRoot).toBe(out.unitsRoot);
    expect(compiled.jobPolicyHash).toBe(out.jobPolicyHash);
    expect(compiled.domainSeparator).toBe(out.domainSeparator);
    expect(compiled.digest).toBe(out.digest);
    expect(compiled.policyKey).toBe(out.policyKey);
    expect(compiled.perUnit.map((u) => u.feeScheduleHash)).toEqual(out.feeScheduleHashes);
    expect(compiled.perUnit.map((u) => u.payoutConfigHash)).toEqual(out.payoutConfigHashes);
    expect(compiled.totalGross).toBe(1_000_000_010n);
  });

  it("gives wallets typed data that hashes to the same digest (viem's own EIP-712)", () => {
    expect(hashTypedData(compiled.typedData)).toBe(out.digest);
  });

  it("matches the claim ids and the evidence commitment", () => {
    const [u0, u1] = compiled.unitIds;
    const base = { chainId: G.inputs.chainId, escrow: compiled.escrow };
    const principal = (unit: Hex, j: bigint) =>
      claimId({ ...base, settlementUnitId: unit, legIndex: j, claimClass: ClaimClass.PRINCIPAL });
    expect(principal(u0, 0n)).toBe(out.claimIds.u0_principal0);
    expect(principal(u0, 1n)).toBe(out.claimIds.u0_principal1);
    expect(principal(u0, 2n)).toBe(out.claimIds.u0_principal2);
    expect(claimId({ ...base, settlementUnitId: u0, legIndex: VNEXT.FEE_LEG_INDEX, claimClass: ClaimClass.FEE })).toBe(
      out.claimIds.u0_fee,
    );
    expect(
      claimId({ ...base, settlementUnitId: u0, legIndex: VNEXT.REFUND_LEG_INDEX, claimClass: ClaimClass.REFUND }),
    ).toBe(out.claimIds.u0_refund);
    expect(principal(u1, 0n)).toBe(out.claimIds.u1_principal0);
    expect(
      claimId({ ...base, settlementUnitId: u1, legIndex: VNEXT.REFUND_LEG_INDEX, claimClass: ClaimClass.REFUND }),
    ).toBe(out.claimIds.u1_refund);
    expect(
      evidenceCommitment({
        ...base,
        settlementUnitId: u0,
        compositionSchemaVersion: 3,
        packageDigest: k(G.inputs.evidence.package),
      }),
    ).toBe(out.evidenceCommitmentU0);
  });

  it("freezes the input types: every ABI selector equals the pinned literal", () => {
    const items = [...VNextSettlementEscrowABI, ...VNextSettlementEscrowFactoryABI].filter(
      (x) => x.type === "function",
    ) as unknown as AbiFunction[];
    const bySelector = new Map(items.map((f) => [toFunctionSelector(f), f.name]));
    for (const [signature, selector] of Object.entries(G.selectors)) {
      expect(toFunctionSelector(signature), signature).toBe(selector);
      expect(bySelector.has(selector), `ABI has no function with the selector of ${signature}`).toBe(true);
    }
  });

  it("encodes the complete fund() calldata under the escrow's size bound", () => {
    const sig = `0x${"11".repeat(65)}` as Hex;
    const data = encodeFundCalldata(compiled.configs, { expiry: G.inputs.expiry, payerSignature: sig, operatorSignature: sig });
    expect(data.slice(0, 10)).toBe(G.selectors[Object.keys(G.selectors).find((s) => s.startsWith("fund("))!]);
    expect((data.length - 2) / 2).toBe(1668);
    const tooBig = `0x${"11".repeat(VNEXT.MAX_SIGNATURE_BYTES + 1)}` as Hex;
    expectCode(
      () => encodeFundCalldata(compiled.configs, { expiry: 1n, payerSignature: tooBig, operatorSignature: sig }),
      "SIGNATURE_TOO_LARGE",
    );
  });
});

describe("V-next compiler: one changed byte is a different policy", () => {
  const golden = compileVNextPolicy(goldenInput());
  const mutations: [string, UnitConfig[]][] = [
    ["reclaimAt + 1", withUnit(0, (u) => ({ ...u, reclaimAt: u.reclaimAt + 1n }))],
    ["compositionRoot, last byte", withUnit(0, (u) => ({ ...u, compositionRoot: `${u.compositionRoot.slice(0, 64)}dc` as Hex }))],
    [
      "payout recipient, last byte",
      withUnit(0, (u) => ({
        ...u,
        payouts: u.payouts.map((p, j) => (j === 2 ? { ...p, recipient: "0x3333333333333333333333333333333333333332" as Address } : p)),
      })),
    ],
    [
      "two payout amounts traded (same sum)",
      withUnit(0, (u) => ({
        ...u,
        payouts: u.payouts.map((p, j) => (j === 0 ? { ...p, amount: p.amount - 1n } : j === 1 ? { ...p, amount: p.amount + 1n } : p)),
      })),
    ],
    ["milestoneIndex + 1", withUnit(1, (u) => ({ ...u, milestoneIndex: u.milestoneIndex + 1n }))],
    ["compositionSchemaVersion + 1", withUnit(0, (u) => ({ ...u, compositionSchemaVersion: 4 }))],
    ["unit order swapped", [...goldenUnits()].reverse()],
  ];
  for (const [what, units] of mutations) {
    it(`${what}: new prePolicyRoot, new escrow, new digest`, () => {
      const c = compileVNextPolicy(goldenInput(units));
      expect(c.prePolicyRoot).not.toBe(golden.prePolicyRoot);
      expect(c.escrow).not.toBe(golden.escrow);
      expect(c.digest).not.toBe(golden.digest);
    });
  }

  it("a different acceptedPolicyDigest is a different escrow address (salt), not just a different signature", () => {
    const c = compileVNextPolicy({ ...goldenInput(), acceptedPolicyDigest: zeroHash });
    expect(c.prePolicyRoot).toBe(golden.prePolicyRoot);
    expect(c.escrow).not.toBe(golden.escrow);
  });

  it("prePolicyRoot is the root of exactly the encoded configs", () => {
    expect(prePolicyRoot(golden.configs)).toBe(G.outputs.prePolicyRoot);
  });
});

describe("V-next compiler fails closed on every funding rule (doc §5)", () => {
  it("exact conservation (R34): over- and under-allocation by one base unit are both refused", () => {
    const over = withUnit(0, (u) => ({ ...u, payouts: u.payouts.map((p, j) => (j === 1 ? { ...p, amount: p.amount + 1n } : p)) }));
    const under = withUnit(0, (u) => ({ ...u, payouts: u.payouts.map((p, j) => (j === 1 ? { ...p, amount: p.amount - 1n } : p)) }));
    expectCode(() => compileVNextPolicy(goldenInput(over)), "PAYOUT_SUM_MISMATCH");
    expectCode(() => compileVNextPolicy(goldenInput(under)), "PAYOUT_SUM_MISMATCH");
    const spec = G.inputs.units[0];
    const common = {
      milestoneIndex: 0n,
      stepId: k(spec.step),
      requiredTier: 2,
      g: spec.g,
      feeBps: spec.feeBps,
      feeRecipient: spec.feeRecipient,
      reclaimAt: spec.reclaimAt,
      compositionSchemaVersion: 0,
      compositionRoot: zeroHash,
    };
    const payee = spec.payouts[0].recipient;
    expect(buildUnitConfig({ ...common, payouts: [{ recipient: payee, amount: 976_500_003n }] }).n).toBe(976_500_003n);
    expectCode(() => buildUnitConfig({ ...common, payouts: [{ recipient: payee, amount: 976_500_004n }] }), "PAYOUT_SUM_MISMATCH");
    expectCode(() => buildUnitConfig({ ...common, payouts: [{ recipient: payee, amount: 976_500_002n }] }), "PAYOUT_SUM_MISMATCH");
  });

  it("refuses a fee that is not the escrow's floor rule, and an inconsistent n", () => {
    expectCode(() => compileVNextPolicy(goldenInput(withUnit(0, (u) => ({ ...u, f: u.f + 1n, n: u.n - 1n })))), "FEE_MISMATCH");
    expectCode(() => compileVNextPolicy(goldenInput(withUnit(0, (u) => ({ ...u, n: u.n + 1n })))), "NET_PLUS_FEE_MISMATCH");
  });

  it("refuses out-of-range fees, grosses and tiers", () => {
    expectCode(() => compileVNextPolicy(goldenInput(withUnit(0, (u) => ({ ...u, feeBps: 1001 })))), "FEE_BPS_TOO_HIGH");
    expectCode(
      () => compileVNextPolicy(goldenInput(withUnit(1, (u) => ({ ...u, g: 4n, n: 4n, payouts: [{ ...u.payouts[0], amount: 4n }] })))),
      "GROSS_BELOW_MIN",
    );
    expectCode(() => compileVNextPolicy(goldenInput(withUnit(1, (u) => ({ ...u, g: 1n << 128n })))), "VALUE_OVERFLOW");
    expectCode(() => compileVNextPolicy(goldenInput(withUnit(0, (u) => ({ ...u, requestedTier: 1 })))), "TIER_REQUEST_MISMATCH");
    expectCode(() => compileVNextPolicy(goldenInput(withUnit(0, (u) => ({ ...u, requiredTier: 4, requestedTier: 4 })))), "TIER_OUT_OF_RANGE");
  });

  it("refuses a fee recipient that contradicts feeBps", () => {
    expectCode(() => compileVNextPolicy(goldenInput(withUnit(0, (u) => ({ ...u, feeRecipient: zeroAddress })))), "FEE_RECIPIENT_MISSING");
    expectCode(() => compileVNextPolicy(goldenInput(withUnit(1, (u) => ({ ...u, feeRecipient: TOKEN })))), "FEE_ZERO_REPRESENTATION");
  });

  it("refuses bad legs: zero amounts, zero recipients, and leg counts outside 1..16", () => {
    expectCode(
      () => compileVNextPolicy(goldenInput(withUnit(0, (u) => ({ ...u, payouts: [...u.payouts, { recipient: TOKEN, amount: 0n }] })))),
      "ZERO_PAYOUT",
    );
    expectCode(
      () => compileVNextPolicy(goldenInput(withUnit(1, (u) => ({ ...u, payouts: [{ recipient: zeroAddress, amount: 7n }] })))),
      "FORBIDDEN_RECIPIENT",
    );
    expectCode(() => compileVNextPolicy(goldenInput(withUnit(1, (u) => ({ ...u, payouts: [] })))), "BAD_LEG_COUNT");
    const seventeen = Array.from({ length: 17 }, (_, j) => ({
      recipient: `0x${(j + 1).toString(16).padStart(40, "0")}` as Address,
      amount: 1n,
    }));
    expectCode(
      () =>
        compileVNextPolicy(
          goldenInput(withUnit(1, (u) => ({ ...u, g: 17n, n: 17n, payouts: seventeen }))),
        ),
      "BAD_LEG_COUNT",
    );
  });

  it("refuses recipients the escrow excludes: the token and the factory", () => {
    const to = (r: Address) => withUnit(1, (u) => ({ ...u, payouts: [{ recipient: r, amount: 7n }] }));
    expectCode(() => compileVNextPolicy(goldenInput(to(TOKEN))), "FORBIDDEN_RECIPIENT");
    expectCode(() => compileVNextPolicy(goldenInput(to(FACTORY))), "FORBIDDEN_RECIPIENT");
    expectCode(() => compileVNextPolicy(goldenInput(withUnit(0, (u) => ({ ...u, feeRecipient: FACTORY })))), "FORBIDDEN_RECIPIENT");
  });

  it("refuses unit counts outside 1..16 and duplicate units", () => {
    expectCode(() => compileVNextPolicy(goldenInput([])), "BAD_UNIT_COUNT");
    const u = goldenUnits()[1];
    const seventeen = Array.from({ length: 17 }, (_, i) => ({ ...u, milestoneIndex: BigInt(i) }));
    expectCode(() => compileVNextPolicy(goldenInput(seventeen)), "BAD_UNIT_COUNT");
    expectCode(() => compileVNextPolicy(goldenInput([u, { ...u }])), "DUPLICATE_UNIT");
  });

  it("refuses a reclaim deadline outside [fundingTime + 10 days, fundingTime + 365 days], edges included", () => {
    const at = (t: bigint) => withUnit(0, (u) => ({ ...u, reclaimAt: t }));
    const T = G.inputs.fundingTime;
    expect(() => compileVNextPolicy(goldenInput(at(T + VNEXT.MIN_RECLAIM_DELAY)))).not.toThrow();
    expect(() => compileVNextPolicy(goldenInput(at(T + VNEXT.MAX_RECLAIM_DELAY)))).not.toThrow();
    expectCode(() => compileVNextPolicy(goldenInput(at(T + VNEXT.MIN_RECLAIM_DELAY - 1n))), "BAD_RECLAIM");
    expectCode(() => compileVNextPolicy(goldenInput(at(T + VNEXT.MAX_RECLAIM_DELAY + 1n))), "BAD_RECLAIM");
    expectCode(() => compileVNextPolicy(goldenInput(at(T))), "BAD_RECLAIM");
  });

  it("refuses bad parties and an expired acceptance", () => {
    expectCode(() => compileVNextPolicy({ ...goldenInput(), payer: zeroAddress }), "FORBIDDEN_RECIPIENT");
    expectCode(() => compileVNextPolicy({ ...goldenInput(), operator: G.inputs.payer }), "PARTY_COLLISION");
    expectCode(() => compileVNextPolicy({ ...goldenInput(), operator: TOKEN }), "FORBIDDEN_RECIPIENT");
    expectCode(() => compileVNextPolicy({ ...goldenInput(), expiry: G.inputs.fundingTime - 1n }), "POLICY_EXPIRED");
  });

  it("refuses JS numbers where the ABI has uint256 (the 2^53 trap) and malformed hex", () => {
    const asNumber = withUnit(1, (u) => ({ ...u, milestoneIndex: Number(u.milestoneIndex) as unknown as bigint }));
    expectCode(() => compileVNextPolicy(goldenInput(asNumber)), "BAD_INPUT");
    expectCode(() => compileVNextPolicy({ ...goldenInput(), jobIdHash: "0x1234" as Hex }), "BAD_INPUT");
    expectCode(
      () => compileVNextPolicy({ ...goldenInput(), payer: "0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266x" as Address }),
      "BAD_INPUT",
    );
  });
});
