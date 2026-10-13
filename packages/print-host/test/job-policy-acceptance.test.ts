import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  acceptanceDigest,
  buildUnitConfig,
  checkAcceptance,
  computeFee,
  domainSeparator,
  jobPolicyHash,
  jobPolicyTypedData,
  prePolicyRoot,
  settlementUnitId,
  unitsRoot,
  VNEXT,
  type JobPolicyFields,
  type UnitConfig,
} from "@pcc/contracts/vnext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAddress,
  hashTypedData,
  recoverAddress,
  verifyTypedData,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  loadOperatorKey,
  OperatorSigningError,
  type HostTerms,
  type OperatorKey,
} from "../src/keys.js";
import { validateHostTerms } from "../src/operator-signing.js";

const failure = vi.hoisted(() => ({ enabled: false }));
vi.mock("viem/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/accounts")>();
  return { ...actual, privateKeyToAccount: (...args: Parameters<typeof actual.privateKeyToAccount>) => {
    const account = actual.privateKeyToAccount(...args);
    return { ...account, async signTypedData(input: Parameters<typeof account.signTypedData>[0]) {
      if (failure.enabled) throw new Error(args[0], { cause: { secret: args[0] } });
      return account.signTypedData(input);
    } };
  } };
});

const now = new Date("2026-10-10T12:00:00.000Z");
const nowSeconds = BigInt(now.getTime() / 1000);
const factory = getAddress(`0x${"ab".repeat(20)}`);
const implementation = getAddress(`0x${"cd".repeat(20)}`);
const escrow = getAddress(`0x${"ef".repeat(20)}`);
const payer = getAddress(`0x${"12".repeat(20)}`);
const feeRecipient = getAddress(`0x${"34".repeat(20)}`);
const otherRecipient = getAddress(`0x${"56".repeat(20)}`);
const payoutRecipient = getAddress(`0x${"ab78".repeat(10)}`);
let directory: string;
let path: string;
let secret: Hex;
let key: OperatorKey;

function terms() {
  return {
    minG: 1_000n,
    allowedRequiredTiers: [1, 2],
    reclaimMinSeconds: 864_000,
    reclaimMaxSeconds: 1_728_000,
    maxFeeBps: 100,
    allowedFeeRecipients: [feeRecipient],
    allowedPayoutRecipients: [payoutRecipient],
    maxUnits: 2,
    maxAcceptanceSeconds: 600,
  } satisfies HostTerms;
}
function word(label: string): Hex {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}
function unit(overrides: Partial<UnitConfig> = {}, index = 0): UnitConfig {
  const gross = overrides.g ?? 10_000n;
  const bps = overrides.feeBps ?? 50;
  const { n } = computeFee(gross, bps);
  return {
    ...buildUnitConfig({
      milestoneIndex: BigInt(index), stepId: word(`step-${index}`), requiredTier: 1,
      g: gross, feeBps: bps, feeRecipient: bps === 0 ? zeroAddress : feeRecipient,
      reclaimAt: nowSeconds + 1_000_000n, compositionSchemaVersion: 1,
      compositionRoot: word(`composition-${index}`),
      payouts: [{ recipient: payoutRecipient, amount: n }],
    }),
    ...overrides,
  };
}
function input(configs: UnitConfig[] = [unit()], overrides: Partial<JobPolicyFields> = {}) {
  const policy: JobPolicyFields = {
    chainId: 84532n, factory, implementation, escrow, payer, operator: key.address,
    jobIdHash: word("job"), termsHash: word("terms"), policyNonce: 1n,
    prePolicyRoot: prePolicyRoot(configs), unitsRoot: word("temporary-root"),
    expiry: nowSeconds + 300n, acceptedPolicyDigest: word("accepted-policy"),
    ...overrides,
  };
  policy.unitsRoot = unitsRoot(configs.map((config) => settlementUnitId({
    chainId: policy.chainId, escrow: policy.escrow, jobIdHash: policy.jobIdHash,
    milestoneIndex: config.milestoneIndex, stepId: config.stepId,
  })));
  return { policy, units: configs, now };
}
function noLeak(value: unknown): void {
  const renderings = [String(value), `${value}`, JSON.stringify(value) ?? "",
    inspect(value, { depth: 5, showHidden: true }),
    inspect(value, { customInspect: false, showHidden: true, depth: 5 })];
  const hex = secret.slice(2);
  for (let index = 0; index <= hex.length - 12; index++) {
    expect(renderings.some((rendered) => rendered.includes(hex.slice(index, index + 12))),
      "a private key fragment is reachable in a rendering").toBe(false);
  }
}
async function refusal(operation: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try { await operation(); } catch (error) { caught = error; }
  expect(caught instanceof OperatorSigningError, "the signer must return its closed refusal class").toBe(true);
  const error = caught as OperatorSigningError;
  expect(error.code).toBe(code);
  expect(error.message).toBe(code);
  expect(Object.hasOwn(error, "cause")).toBe(false);
  expect(Object.keys(error).every((field) => ["name", "code"].includes(field))).toBe(true);
  noLeak(error);
}
async function accepts(candidate: ReturnType<typeof input>, bound = key): Promise<void> {
  const signature = await bound.signJobPolicyAcceptance(candidate);
  expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  expect(await verifyTypedData({ ...jobPolicyTypedData(candidate.policy), address: bound.address, signature }))
    .toBe(true);
}

beforeEach(async () => {
  failure.enabled = false;
  directory = await mkdtemp(join(tmpdir(), "ph-policy-"));
  await chmod(directory, 0o700);
  secret = generatePrivateKey();
  path = join(directory, "operator.json");
  await writeFile(path, JSON.stringify({
    kind: "pcc-printhost.operator-key", version: 1, algorithm: "secp256k1", purpose: "runtime test",
    createdAt: now.toISOString(), address: privateKeyToAccount(secret).address, privateKey: secret,
  }), { mode: 0o600 });
  key = await loadOperatorKey(path, 84532, { now, terms: terms() });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe("JobPolicy acceptance uses the canonical compiler bytes", () => {
  for (const chainId of [84532, 31337] as const) {
    it(`recovers over the compiler acceptanceDigest with policy.escrow as the domain on chain ${chainId}`, async () => {
      const bound = await loadOperatorKey(path, chainId, { now, terms: terms() });
      const candidate = input([unit()], { chainId: BigInt(chainId) });
      const signature = await bound.signJobPolicyAcceptance(candidate);
      const digest = acceptanceDigest(domainSeparator(candidate.policy.chainId, candidate.policy.escrow),
        jobPolicyHash(candidate.policy));
      expect(hashTypedData(jobPolicyTypedData(candidate.policy))).toBe(digest);
      expect(await recoverAddress({ hash: digest, signature })).toBe(bound.address);
      expect(await verifyTypedData({ ...jobPolicyTypedData(candidate.policy), address: bound.address, signature }))
        .toBe(true);
      // The compiler's acceptance helper checks shape; viem above verifies the signature itself.
      expect(() => checkAcceptance({ expiry: candidate.policy.expiry,
        payerSignature: "0x", operatorSignature: signature }, { sender: payer, payer })).not.toThrow();
      const otherDomainDigest = acceptanceDigest(domainSeparator(candidate.policy.chainId, candidate.policy.factory),
        jobPolicyHash(candidate.policy));
      expect(await recoverAddress({ hash: otherDomainDigest, signature })).not.toBe(bound.address);
    });
  }
  it("compares operator addresses without making letter case part of their identity", async () => {
    await accepts(input([unit()], { operator: key.address.toLowerCase() as Address }));
  });
  it("refuses an operator different from the loaded EOA", async () => {
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { operator: payer })), "operator_mismatch");
  });
  it("refuses a policy chain different from the bound chain", async () => {
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { chainId: 31337n })), "chain_mismatch");
  });
  it("recomputes unitsRoot and refuses a different commitment", async () => {
    const candidate = input();
    candidate.policy.unitsRoot = word("wrong-units-root");
    await refusal(() => key.signJobPolicyAcceptance(candidate), "units_root_mismatch");
  });
  it("recomputes prePolicyRoot and refuses economic changes under an old commitment", async () => {
    const candidate = input();
    candidate.policy.prePolicyRoot = word("wrong-pre-policy-root");
    await refusal(() => key.signJobPolicyAcceptance(candidate), "pre_policy_root_mismatch");
  });
  it("does not allow a caller-supplied domain or verifyingContract", async () => {
    for (const extra of [{ verifyingContract: factory }, { escrow: factory },
      { domain: { verifyingContract: factory } }, { types: {} }, { primaryType: "Other" }]) {
      await refusal(() => key.signJobPolicyAcceptance({ ...input(), ...extra } as never), "bad_input");
    }
  });
});

describe("HostTerms enforce each acceptance boundary", () => {
  it("accepts one and maxUnits units, refuses zero and maxUnits plus one", async () => {
    await accepts(input([unit()]));
    await accepts(input([unit({}, 0), unit({}, 1)]));
    await refusal(() => key.signJobPolicyAcceptance(input([])), "units_count");
    await refusal(() => key.signJobPolicyAcceptance(input([unit({}, 0), unit({}, 1), unit({}, 2)])), "units_count");
  });
  it("accepts gross equal to minG and refuses gross one below minG", async () => {
    await accepts(input([unit({ g: terms().minG })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ g: terms().minG - 1n })])), "gross_below_min");
  });
  it("accepts each allowed requiredTier and refuses neighboring excluded tiers", async () => {
    for (const requiredTier of terms().allowedRequiredTiers) {
      await accepts(input([unit({ requiredTier, requestedTier: requiredTier })]));
    }
    for (const requiredTier of [0, 3]) {
      await refusal(() => key.signJobPolicyAcceptance(input([unit({ requiredTier, requestedTier: requiredTier })])),
        "tier_not_allowed");
    }
  });
  it("accepts reclaimAt at the lower bound and refuses one second before it", async () => {
    const bound = nowSeconds + BigInt(terms().reclaimMinSeconds);
    await accepts(input([unit({ reclaimAt: bound })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ reclaimAt: bound - 1n })])), "reclaim_too_soon");
  });
  it("accepts reclaimAt at the upper bound and refuses one second after it", async () => {
    const bound = nowSeconds + BigInt(terms().reclaimMaxSeconds);
    await accepts(input([unit({ reclaimAt: bound })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ reclaimAt: bound + 1n })])), "reclaim_too_late");
  });
  it("accepts feeBps equal to maxFeeBps and refuses one basis point above it", async () => {
    await accepts(input([unit({ feeBps: terms().maxFeeBps })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ feeBps: terms().maxFeeBps + 1 })])), "fee_too_high");
  });
  it("accepts an allowed fee recipient and refuses a different fee recipient", async () => {
    await accepts(input([unit({ feeRecipient })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ feeRecipient: otherRecipient })])),
      "fee_recipient_not_allowed");
  });
  it("accepts the zero address only for a zero fee and refuses it for a positive fee", async () => {
    await accepts(input([unit({ feeBps: 0, feeRecipient: zeroAddress })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ feeBps: 1, feeRecipient: zeroAddress })])),
      "fee_recipient_not_allowed");
  });
  it("refuses the zero address with a positive fee even if terms explicitly list it", async () => {
    const bound = await loadOperatorKey(path, 84532, { now, terms: { ...terms(), allowedFeeRecipients: [zeroAddress] } });
    await accepts(input([unit({ feeBps: 0, feeRecipient: zeroAddress })]), bound);
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({ feeBps: 1, feeRecipient: zeroAddress })])),
      "fee_recipient_not_allowed");
  });
  it("accepts payout recipients that differ from the allowed address only in letter case", async () => {
    const lowercase = payoutRecipient.toLowerCase() as Address;
    expect(lowercase).not.toBe(payoutRecipient);
    await accepts(input([unit({ payouts: [{ recipient: lowercase, amount: unit().n }] })]));
  });
  it("accepts an allowed payout recipient and refuses a recipient outside the operator's list", async () => {
    await accepts(input());
    await refusal(() => key.signJobPolicyAcceptance(input([unit({
      payouts: [{ recipient: otherRecipient, amount: unit().n }],
    })])), "payout_recipient_not_allowed");
  });
  it("checks every payout recipient within a unit", async () => {
    const split = [{ recipient: payoutRecipient, amount: 1n },
      { recipient: otherRecipient, amount: unit().n - 1n }];
    const bound = await loadOperatorKey(path, 84532, { now,
      terms: { ...terms(), allowedPayoutRecipients: [payoutRecipient, otherRecipient] } });
    await accepts(input([unit({ payouts: split })]), bound);
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ payouts: split })])),
      "payout_recipient_not_allowed");
  });
  it("checks payout recipients in every unit", async () => {
    await accepts(input([unit({}, 0), unit({}, 1)]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({}, 0), unit({
      payouts: [{ recipient: otherRecipient, amount: unit().n }],
    }, 1)])), "payout_recipient_not_allowed");
  });
  for (const offset of [-1n, 1n]) {
    it(`accepts the compiler fee and refuses f off by ${offset} base unit`, async () => {
      await accepts(input());
      await refusal(() => key.signJobPolicyAcceptance(input([unit({ f: unit().f + offset })])),
        "fee_split_mismatch");
    });
    it(`accepts the compiler net and refuses n off by ${offset} base unit`, async () => {
      await accepts(input());
      const n = unit().n + offset;
      await refusal(() => key.signJobPolicyAcceptance(input([unit({ n,
        payouts: [{ recipient: payoutRecipient, amount: n }],
      })])), "fee_split_mismatch");
    });
    it(`accepts exact payout conservation and refuses a payout sum off by ${offset} base unit`, async () => {
      await accepts(input());
      await refusal(() => key.signJobPolicyAcceptance(input([unit({
        payouts: [{ recipient: payoutRecipient, amount: unit().n + offset }],
      })])), "payout_sum_mismatch");
    });
  }
  it("uses the compiler's floored fee for gross not divisible by the fee denominator", async () => {
    const candidate = unit({ g: 10_001n });
    expect(candidate.f).toBe(50n);
    expect(candidate.n).toBe(9_951n);
    await accepts(input([candidate]));
    await refusal(() => key.signJobPolicyAcceptance(input([{ ...candidate, f: 51n, n: 9_950n,
      payouts: [{ recipient: payoutRecipient, amount: 9_950n }],
    }])), "fee_split_mismatch");
  });
  it("checks the fee split in every unit", async () => {
    await accepts(input([unit({}, 0), unit({}, 1)]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({}, 0), unit({ f: unit().f + 1n }, 1)])),
      "fee_split_mismatch");
  });
  it("accepts one positive payout and refuses an empty payouts list", async () => {
    await accepts(input());
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ payouts: [] })])), "payout_sum_mismatch");
  });
  it("accepts every positive payout and refuses zero even when the sum equals n", async () => {
    const n = unit().n;
    await accepts(input([unit({ payouts: [{ recipient: payoutRecipient, amount: 1n },
      { recipient: payoutRecipient, amount: n - 1n }] })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({
      payouts: [{ recipient: payoutRecipient, amount: 0n }, { recipient: payoutRecipient, amount: n }],
    })])), "payout_sum_mismatch");
  });
  it("checks payout conservation in every unit", async () => {
    await accepts(input([unit({}, 0), unit({}, 1)]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({}, 0), unit({
      payouts: [{ recipient: payoutRecipient, amount: unit().n - 1n }],
    }, 1)])), "payout_sum_mismatch");
  });
  it("checks every unit rather than only the first", async () => {
    await refusal(() => key.signJobPolicyAcceptance(input([unit({}, 0), unit({ g: terms().minG - 1n }, 1)])),
      "gross_below_min");
  });
  it("accepts expiry one second after now and refuses expiry at now or in the past", async () => {
    await accepts(input([unit()], { expiry: nowSeconds + 1n }));
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { expiry: nowSeconds })), "acceptance_expired");
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { expiry: nowSeconds - 1n })), "acceptance_expired");
  });
  it("accepts expiry at maxAcceptanceSeconds and refuses one second beyond it", async () => {
    const bound = nowSeconds + BigInt(terms().maxAcceptanceSeconds);
    await accepts(input([unit()], { expiry: bound }));
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { expiry: bound + 1n })), "acceptance_too_long");
  });
  it("uses the exact fractional clock for expiry and the acceptance upper bound", async () => {
    const fractionalNow = new Date(now.getTime() + 500);
    await accepts({ ...input([unit()], { expiry: nowSeconds + 1n }), now: fractionalNow });
    await refusal(() => key.signJobPolicyAcceptance({ ...input([unit()], { expiry: nowSeconds }), now: fractionalNow }),
      "acceptance_expired");
    await accepts({ ...input([unit()], { expiry: nowSeconds + BigInt(terms().maxAcceptanceSeconds) }), now: fractionalNow });
    await refusal(() => key.signJobPolicyAcceptance({
      ...input([unit()], { expiry: nowSeconds + BigInt(terms().maxAcceptanceSeconds) + 1n }), now: fractionalNow,
    }), "acceptance_too_long");
  });
  it("uses the exact fractional clock for the reclaim lower bound", async () => {
    const fractionalNow = new Date(now.getTime() + 500);
    const lower = nowSeconds + BigInt(terms().reclaimMinSeconds);
    await refusal(() => key.signJobPolicyAcceptance({ ...input([unit({ reclaimAt: lower })]), now: fractionalNow }),
      "reclaim_too_soon");
    await accepts({ ...input([unit({ reclaimAt: lower + 1n })]), now: fractionalNow });
  });
  it("requires loaded terms before producing an acceptance", async () => {
    const unbounded = await loadOperatorKey(path, 84532, { now });
    await refusal(() => unbounded.signJobPolicyAcceptance(input()), "bad_terms");
  });
  it("snapshots HostTerms so callers cannot weaken them after loading", async () => {
    const supplied = terms();
    const bound = await loadOperatorKey(path, 84532, { now, terms: supplied });
    supplied.minG = 0n;
    supplied.allowedRequiredTiers.push(3);
    supplied.allowedFeeRecipients.push(otherRecipient);
    supplied.allowedPayoutRecipients.push(otherRecipient);
    supplied.reclaimMaxSeconds *= 2;
    supplied.maxAcceptanceSeconds *= 2;
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({ g: terms().minG - 1n })])), "gross_below_min");
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({ requiredTier: 3, requestedTier: 3 })])), "tier_not_allowed");
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({ feeRecipient: otherRecipient })])),
      "fee_recipient_not_allowed");
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({
      payouts: [{ recipient: otherRecipient, amount: unit().n }],
    })])), "payout_recipient_not_allowed");
  });
});

describe("HostTerms loading refuses malformed authorizations", () => {
  const malformed: Array<[string, Record<string, unknown>]> = [
    ["negative minG", { minG: -1n }], ["number minG", { minG: 1_000 }],
    ["empty tier list", { allowedRequiredTiers: [] }], ["tier above three", { allowedRequiredTiers: [4] }],
    ["negative tier", { allowedRequiredTiers: [-1] }], ["fractional tier", { allowedRequiredTiers: [1.5] }],
    ["repeated tier", { allowedRequiredTiers: [1, 1] }],
    ["negative reclaim minimum", { reclaimMinSeconds: -1 }],
    ["fractional reclaim minimum", { reclaimMinSeconds: 1.5 }],
    ["inverted reclaim window", { reclaimMaxSeconds: 864_000 - 1 }],
    ["unsafe reclaim maximum", { reclaimMaxSeconds: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative fee maximum", { maxFeeBps: -1 }], ["fractional fee maximum", { maxFeeBps: 1.5 }],
    ["fee maximum above contract maximum", { maxFeeBps: 1_001 }],
    ["invalid fee recipient", { allowedFeeRecipients: ["invalid"] }],
    ["undefined payout recipient list", { allowedPayoutRecipients: undefined }],
    ["empty payout recipient list", { allowedPayoutRecipients: [] }],
    ["non-array payout recipient list", { allowedPayoutRecipients: payoutRecipient }],
    ["invalid payout recipient", { allowedPayoutRecipients: ["invalid"] }],
    ["repeated payout recipient", { allowedPayoutRecipients: [payoutRecipient, payoutRecipient] }],
    ["repeated payout recipient in different letter case", {
      allowedPayoutRecipients: [payoutRecipient, payoutRecipient.toLowerCase()],
    }],
    ["zero maxUnits", { maxUnits: 0 }], ["too many maxUnits", { maxUnits: 17 }],
    ["fractional maxUnits", { maxUnits: 1.5 }],
    ["zero acceptance maximum", { maxAcceptanceSeconds: 0 }],
    ["negative acceptance maximum", { maxAcceptanceSeconds: -1 }],
    ["unsafe acceptance maximum", { maxAcceptanceSeconds: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  for (const [label, change] of malformed) {
    it(`refuses ${label} at load with bad_terms`, async () => {
      await refusal(() => loadOperatorKey(path, 84532, { now, terms: { ...terms(), ...change } as never }), "bad_terms");
    });
  }
  it("requires the payout recipient authorization field at load", async () => {
    const supplied: Partial<ReturnType<typeof terms>> = terms();
    delete supplied.allowedPayoutRecipients;
    await refusal(() => loadOperatorKey(path, 84532, { now, terms: supplied as HostTerms }), "bad_terms");
  });
  for (const variant of ["extra", "accessor", "inherited"] as const) {
    it(`refuses ${variant} HostTerms fields without inspecting their values`, async () => {
      const getter = vi.fn(() => { throw new Error(secret); });
      const supplied = variant === "inherited" ? Object.assign(Object.create({ secret }), terms()) : terms();
      if (variant === "extra") Object.defineProperty(supplied, "unapproved", { enumerable: true, value: secret });
      if (variant === "accessor") Object.defineProperty(supplied, "minG", { enumerable: true, get: getter });
      await refusal(() => loadOperatorKey(path, 84532, { now, terms: supplied }), "bad_terms");
      expect(getter).not.toHaveBeenCalled();
    });
  }
  for (const variant of ["extra", "accessor", "inherited", "sparse"] as const) {
    it(`refuses ${variant} payout recipient list fields without executing a getter`, async () => {
      const supplied = terms();
      const getter = vi.fn(() => { throw new Error(secret); });
      if (variant === "extra") Object.defineProperty(supplied.allowedPayoutRecipients, "unapproved", {
        value: secret, enumerable: true,
      });
      if (variant === "accessor") Object.defineProperty(supplied.allowedPayoutRecipients, "0", {
        get: getter, enumerable: true,
      });
      if (variant === "inherited") {
        Object.setPrototypeOf(supplied.allowedPayoutRecipients, Object.create(Array.prototype));
      }
      if (variant === "sparse") supplied.allowedPayoutRecipients.length = 2;
      await refusal(() => loadOperatorKey(path, 84532, { now, terms: supplied }), "bad_terms");
      expect(getter).not.toHaveBeenCalled();
    });
  }
  it("copies and freezes the payout recipient authorization list", () => {
    const supplied = terms();
    const validated = validateHostTerms(supplied);
    expect(validated.allowedPayoutRecipients).not.toBe(supplied.allowedPayoutRecipients);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.allowedPayoutRecipients)).toBe(true);
    supplied.allowedPayoutRecipients.splice(0, 1, otherRecipient);
    expect(validated.allowedPayoutRecipients).toEqual([payoutRecipient]);
    expect(() => (validated.allowedPayoutRecipients as Address[]).push(otherRecipient)).toThrow(TypeError);
  });
});

describe("JobPolicy acceptance also enforces buildUnitConfig's context-free rules", () => {
  it("accepts equal requestedTier and requiredTier and refuses a mismatched request", async () => {
    await accepts(input([unit({ requiredTier: 1, requestedTier: 1 })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ requiredTier: 1, requestedTier: 2 })])),
      "bad_input");
  });
  it("accepts the uint128 gross maximum and refuses one base unit above it", async () => {
    const maximum = unit({ g: VNEXT.MAX_GROSS });
    await accepts(input([maximum]));
    const g = VNEXT.MAX_GROSS + 1n;
    const { f, n } = computeFee(g, maximum.feeBps);
    await refusal(() => key.signJobPolicyAcceptance(input([{ ...maximum, g, f, n,
      payouts: [{ recipient: payoutRecipient, amount: n }],
    }])), "bad_input");
  });
  it("accepts the compiler minimum gross and refuses one below despite permissive HostTerms", async () => {
    const bound = await loadOperatorKey(path, 84532, { now, terms: { ...terms(), minG: 0n } });
    const minimum = unit({ g: VNEXT.MIN_BONDABLE_GROSS });
    await accepts(input([minimum]), bound);
    const g = VNEXT.MIN_BONDABLE_GROSS - 1n;
    const { f, n } = computeFee(g, minimum.feeBps);
    await refusal(() => bound.signJobPolicyAcceptance(input([{ ...minimum, g, f, n,
      payouts: [{ recipient: payoutRecipient, amount: n }],
    }])), "bad_input");
  });
  it("accepts the compiler payout leg limit and refuses one extra leg", async () => {
    const payouts = (count: number) => Array.from({ length: count }, (_, index) => ({
      recipient: payoutRecipient, amount: index === count - 1 ? unit().n - BigInt(count - 1) : 1n,
    }));
    await accepts(input([unit({ payouts: payouts(VNEXT.MAX_PAYOUT_LEGS_PER_UNIT) })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({
      payouts: payouts(VNEXT.MAX_PAYOUT_LEGS_PER_UNIT + 1),
    })])), "bad_input");
  });
  it("refuses the zero payout recipient even when HostTerms explicitly authorize it", async () => {
    const bound = await loadOperatorKey(path, 84532, { now,
      terms: { ...terms(), allowedPayoutRecipients: [payoutRecipient, zeroAddress] } });
    await accepts(input(), bound);
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({
      payouts: [{ recipient: zeroAddress, amount: unit().n }],
    })])), "bad_input");
  });
  it("accepts a zero fee with a zero recipient and refuses a nonzero recipient for that fee", async () => {
    await accepts(input([unit({ feeBps: 0, feeRecipient: zeroAddress })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ feeBps: 0, feeRecipient })])), "bad_input");
  });
});

describe("JobPolicy acceptance snapshots only strict data fields", () => {
  for (const level of ["input", "policy", "unit", "payout", "units array", "payouts array"] as const) {
    for (const variant of ["extra", "accessor", "inherited"] as const) {
      it(`refuses ${variant} fields on the ${level} without executing a getter`, async () => {
        const candidate = input();
        let target: object;
        if (level === "input") target = candidate;
        else if (level === "policy") target = candidate.policy;
        else if (level === "unit") target = candidate.units[0];
        else if (level === "payout") target = candidate.units[0].payouts[0];
        else if (level === "units array") target = candidate.units;
        else target = candidate.units[0].payouts;
        const getter = vi.fn(() => { throw new Error(secret); });
        const fields = { input: "policy", policy: "operator", unit: "g", payout: "amount", "units array": "0", "payouts array": "0" };
        if (variant === "extra") Object.defineProperty(target, "unapproved", { value: secret, enumerable: true });
        if (variant === "accessor") Object.defineProperty(target, fields[level], { enumerable: true, get: getter });
        if (variant === "inherited") {
          const prototype = Object.create(Object.getPrototypeOf(target));
          Object.defineProperty(prototype, "unapproved", { value: secret, enumerable: true });
          Object.setPrototypeOf(target, prototype);
        }
        await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
        expect(getter).not.toHaveBeenCalled();
      });
    }
  }
  it("refuses a getter on now before using the clock", async () => {
    const candidate = input();
    const getter = vi.fn(() => { throw new Error(secret); });
    Object.defineProperty(candidate, "now", { enumerable: true, get: getter });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
    expect(getter).not.toHaveBeenCalled();
  });
  it("refuses missing policy fields", async () => {
    const candidate = input();
    delete (candidate.policy as Partial<JobPolicyFields>).escrow;
    await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
  });
  it("refuses sparse arrays", async () => {
    const candidate = input();
    candidate.units.length = 2;
    await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
  });
  it("refuses symbol and non-enumerable fields", async () => {
    const candidate = input();
    Object.defineProperty(candidate.policy, Symbol("unapproved"), { value: secret });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
    const nonEnumerable = input();
    Object.defineProperty(nonEnumerable.policy, "operator", { value: key.address, enumerable: false });
    await refusal(() => key.signJobPolicyAcceptance(nonEnumerable), "bad_input");
  });
  it("refuses non-object input and invalid now values", async () => {
    for (const value of [null, undefined, [], secret, 1, true]) {
      await refusal(() => key.signJobPolicyAcceptance(value as never), "bad_input");
    }
    for (const value of ["2026-10-10", 0, new Date(Number.NaN)]) {
      await refusal(() => key.signJobPolicyAcceptance({ ...input(), now: value } as never), "bad_input");
    }
  });
  it("refuses decimal strings and unsafe integer policy fields at the signing API", async () => {
    for (const value of ["84532", 84532, -1n, (1n << 256n)]) {
      await refusal(() => key.signJobPolicyAcceptance({ ...input(), policy: { ...input().policy, chainId: value } } as never),
        "bad_integer");
    }
  });
  it("does not expose keys or input values through library signing failures or logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    failure.enabled = true;
    await refusal(() => key.signJobPolicyAcceptance(input()), "signing_failed");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    noLeak(key);
  });
});
