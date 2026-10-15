import { encodeFunctionData, getAddress, isAddress, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { types as utilTypes } from "node:util";
import {
  computeAcceptedPolicyDigest, computeBindingsRoot, computeSubjectBlockHash,
  formatOperatorPrincipalId, principalTupleWord,
  type SubjectBinding, type SubjectBlockFields,
} from "@pcc/spec";
import {
  VNEXT, buildUnitConfig, computeFee, jobPolicyTypedData, policySalt, predictEscrow, prePolicyRoot, settlementUnitId, unitsRoot,
  type JobPolicyFields, type UnitConfig,
} from "@pcc/contracts/vnext";
import { computeTermsHash } from "./terms-hash.js";

export type OperatorChainId = 84532 | 31337;
export type OperatorSigningErrorCode = "bad_input" | "bad_escrow" | "bad_bytes32" |
  "bad_integer" | "zero_package_digest" | "signing_failed" | "bad_terms" |
  "operator_mismatch" | "chain_mismatch" | "deployment_mismatch" | "escrow_mismatch" |
  "units_root_mismatch" | "pre_policy_root_mismatch" |
  "units_count" | "gross_below_min" | "tier_not_allowed" | "reclaim_too_soon" |
  "reclaim_too_late" | "fee_too_high" | "fee_recipient_not_allowed" |
  "payout_recipient_not_allowed" | "pass_through_too_high" | "fee_split_mismatch" | "payout_sum_mismatch" |
  "acceptance_expired" | "acceptance_too_long" | "terms_hash_mismatch" | "assurance_tier_mismatch" |
  "subject_pin_mismatch" | "settlement_address_mismatch" | "bindings_root_mismatch" |
  "operator_principal_mismatch" | "payer_principal_mismatch" |
  "accepted_policy_mismatch" | "composition_not_supported";

/** Signing errors retain only a closed code, never inputs or library exceptions. */
export class OperatorSigningError extends Error {
  readonly code: OperatorSigningErrorCode;
  constructor(code: OperatorSigningErrorCode) {
    super(code);
    this.name = "OperatorSigningError";
    this.code = code;
  }
}

export interface D1Input {
  escrow: Address;
  settlementUnitId: Hex;
  jobIdHash: Hex;
  milestoneIndex: number | bigint;
  stepId: Hex;
  compositionRoot: Hex;
  acceptedEnvelopeHash: Hex;
  packageBodyHash: Hex;
}

export interface SubmitEvidenceTxInput {
  escrow: Address;
  unitId: Hex;
  packageDigest: Hex;
  nonce: number | bigint;
  gas: number | bigint;
  maxFeePerGas: number | bigint;
  maxPriorityFeePerGas: number | bigint;
}

/** Local operator limits, snapshotted at key load; never supplied by the signing caller. */
export interface HostTerms {
  readonly chainId: OperatorChainId;
  readonly factory: Address;
  readonly implementation: Address;
  readonly operatorPayoutRecipient: Address;
  readonly settlementToken: Address;
  readonly subjectPins: Readonly<Partial<SubjectBlockFields> & Pick<SubjectBlockFields, "committedProgramHash">>;
  readonly bindingsRoot?: Hex;
  readonly maxPassThrough: bigint;
  readonly minG: bigint;
  readonly allowedRequiredTiers: readonly number[];
  readonly reclaimMinSeconds: number;
  readonly reclaimMaxSeconds: number;
  readonly maxFeeBps: number;
  readonly allowedFeeRecipients: readonly Address[];
  readonly allowedPayoutRecipients: readonly Address[];
  readonly maxUnits: number;
  readonly maxAcceptanceSeconds: number;
}

export interface JobPolicyAcceptanceInput {
  policy: JobPolicyFields;
  units: UnitConfig[];
  subjectBlock: SubjectBlockFields;
  bindings: SubjectBinding[];
}

// Admission keys only; the field types and digest encoding belong to @pcc/spec.
const subjectKeys = ["payer", "operatorPrincipal", "operatorSettlementAddress", "authorizedTuplesRoot",
  "expertSetRoot", "executorSetRoot", "expectedRecipient", "targetSystemIdentity", "committedProgramHash",
  "recipeRef", "sampleManifestRef", "childrenRoot", "operatingEnvelopeHash", "expectedRouteArea",
  "expectedLocationHash", "captureNonceAnchor", "challengeAnchor", "integrityGrade"] as const satisfies readonly (keyof SubjectBlockFields)[];
type AssertSubjectKeys<T extends never> = T;
type SubjectKeysComplete = AssertSubjectKeys<Exclude<keyof SubjectBlockFields, typeof subjectKeys[number]>>;

// Frozen recursively: an importer cannot change what the signing closure encodes.
export const submitEvidenceAbiItem = Object.freeze({
  type: "function",
  name: "submitEvidence",
  stateMutability: "nonpayable",
  inputs: Object.freeze([
    Object.freeze({ name: "unitId", type: "bytes32" }),
    Object.freeze({ name: "packageDigest", type: "bytes32" }),
  ]),
  outputs: Object.freeze([]),
} as const);

// Exact field order/types from gateway/settlement/operator-signature-verifier.ts.
const d1Types = Object.freeze({
  FinalMilestonePackageV2: Object.freeze([
    Object.freeze({ name: "chainId", type: "uint256" }),
    Object.freeze({ name: "escrow", type: "address" }),
    Object.freeze({ name: "settlementUnitId", type: "bytes32" }),
    Object.freeze({ name: "jobIdHash", type: "bytes32" }),
    Object.freeze({ name: "milestoneIndex", type: "uint256" }),
    Object.freeze({ name: "stepId", type: "bytes32" }),
    Object.freeze({ name: "compositionRoot", type: "bytes32" }),
    Object.freeze({ name: "acceptedEnvelopeHash", type: "bytes32" }),
    Object.freeze({ name: "packageBodyHash", type: "bytes32" }),
  ]),
} as const);

const uint256Max = (1n << 256n) - 1n;
const isProxy = utilTypes.isProxy;
// Circle USDC from packages/contracts/ts/chain-config.ts (Base Sepolia).
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Snapshot data properties once. Reject extras, inherited fields and accessors. */
function inputRecord(input: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  try {
    if (input === null || typeof input !== "object") throw new OperatorSigningError("bad_input");
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) throw new OperatorSigningError("bad_input");
    const names = Reflect.ownKeys(input);
    if (names.some((name) => typeof name !== "string" || (!fields.includes(name) && !optional.includes(name)))) {
      throw new OperatorSigningError("bad_input");
    }
    const record: Record<string, unknown> = Object.create(null);
    for (const field of [...fields, ...optional.filter((field) => Object.hasOwn(input, field))]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new OperatorSigningError("bad_input");
      }
      record[field] = descriptor.value;
    }
    return record;
  } catch {
    throw new OperatorSigningError("bad_input");
  }
}

/** Dense, ordinary arrays only; snapshot element descriptors without invoking user code. */
function inputArray(input: unknown): unknown[] {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      throw new OperatorSigningError("bad_input");
    }
    const length = Object.getOwnPropertyDescriptor(input, "length")?.value as number;
    if (Reflect.ownKeys(input).length !== length + 1) throw new OperatorSigningError("bad_input");
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new OperatorSigningError("bad_input");
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch { throw new OperatorSigningError("bad_input"); }
}

/** Copy data once without selecting fields: the producer admits the complete shape. */
function snapshotProducerRecord(input: unknown): Record<string, unknown> {
  try {
    if (input === null || typeof input !== "object" || isProxy(input)) {
      throw new OperatorSigningError("bad_input");
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) throw new OperatorSigningError("bad_input");
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new OperatorSigningError("bad_input");
      Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true });
    }
    return snapshot;
  } catch { throw new OperatorSigningError("bad_input"); }
}

function snapshotProducerBindings(input: unknown): SubjectBinding[] {
  if (isProxy(input)) throw new OperatorSigningError("bad_input");
  return inputArray(input).map((binding) => snapshotProducerRecord(binding) as unknown as SubjectBinding);
}

function policyCommitments(input: JobPolicyAcceptanceInput) {
  try {
    const subjectBlockHash = computeSubjectBlockHash(input.subjectBlock);
    const bindingsRoot = computeBindingsRoot(input.bindings);
    const acceptedPolicyDigest = computeAcceptedPolicyDigest({
      termsHash: input.policy.termsHash.toLowerCase() as Hex, subjectBlockHash, bindingsRoot,
    });
    return { subjectBlockHash, bindingsRoot, acceptedPolicyDigest };
  } catch { throw new OperatorSigningError("bad_input"); }
}

/** Hash the same strict snapshots the signer uses, for the CLI's public hand-off. */
export function computeJobPolicyCommitments(input: JobPolicyAcceptanceInput) {
  return policyCommitments(snapshotJobPolicyAcceptanceInput(input));
}

function escrowAddress(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || value === zeroAddress) {
    throw new OperatorSigningError("bad_escrow");
  }
  try {
    if (getAddress(value) === value) return value as Address;
  } catch { /* Collapse address-library exceptions to the closed code. */ }
  throw new OperatorSigningError("bad_escrow");
}

function bytes32(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) throw new OperatorSigningError("bad_bytes32");
  return value as Hex;
}

function policyAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new OperatorSigningError("bad_escrow");
  return value as Address;
}

function policyBytes32(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new OperatorSigningError("bad_bytes32");
  return value as Hex;
}

function unsignedInteger(value: unknown, max = uint256Max): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new OperatorSigningError("bad_integer");
    value = BigInt(value);
  }
  if (typeof value !== "bigint" || value < 0n || value > max) throw new OperatorSigningError("bad_integer");
  return value;
}

function bigintField(value: unknown): bigint {
  if (typeof value !== "bigint") throw new OperatorSigningError("bad_integer");
  return unsignedInteger(value);
}

function numberField(value: unknown, max: number): number {
  if (typeof value !== "number") throw new OperatorSigningError("bad_integer");
  return Number(unsignedInteger(value, BigInt(max)));
}

function pinGrade(value: unknown): SubjectBlockFields["integrityGrade"] {
  if (typeof value === "string") {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(value) || BigInt(value) > 255n) throw new OperatorSigningError("bad_terms");
    return value;
  }
  if (typeof value === "number" && Object.is(value, -0)) throw new OperatorSigningError("bad_terms");
  unsignedInteger(value, 255n);
  return value as number | bigint;
}

/** Strict validation also copies and freezes the lists, closing mutation after key load. */
export function validateHostTerms(input: HostTerms): HostTerms {
  try {
    const r = inputRecord(input, ["chainId", "factory", "implementation", "operatorPayoutRecipient", "settlementToken", "subjectPins", "maxPassThrough",
      "minG", "allowedRequiredTiers", "reclaimMinSeconds", "reclaimMaxSeconds",
      "maxFeeBps", "allowedFeeRecipients", "allowedPayoutRecipients", "maxUnits", "maxAcceptanceSeconds"], ["bindingsRoot"]);
    const chainId = r.chainId;
    if (chainId !== 84532 && chainId !== 31337) throw new OperatorSigningError("bad_terms");
    const factory = policyAddress(r.factory);
    const implementation = policyAddress(r.implementation);
    const operatorPayoutRecipient = policyAddress(r.operatorPayoutRecipient);
    const settlementToken = policyAddress(r.settlementToken);
    if (settlementToken === zeroAddress) throw new OperatorSigningError("bad_terms");
    if (chainId === 84532 && settlementToken.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()) {
      throw new OperatorSigningError("bad_terms");
    }
    const pins = snapshotProducerRecord(r.subjectPins);
    const pinRecord = inputRecord(pins, ["committedProgramHash"], subjectKeys.filter((key) => key !== "committedProgramHash"));
    const subjectPins: Record<string, unknown> = Object.create(null);
    for (const [field, value] of Object.entries(pinRecord)) {
      subjectPins[field] = field === "integrityGrade" ? pinGrade(value)
        : field === "operatorSettlementAddress" ? policyAddress(value) : policyBytes32(value).toLowerCase();
    }
    if (subjectPins.operatorSettlementAddress !== undefined
      && (subjectPins.operatorSettlementAddress as Address).toLowerCase() !== operatorPayoutRecipient.toLowerCase()) {
      throw new OperatorSigningError("bad_terms");
    }
    const bindingsRoot = Object.hasOwn(r, "bindingsRoot") ? policyBytes32(r.bindingsRoot).toLowerCase() as Hex : undefined;
    const maxPassThrough = bigintField(r.maxPassThrough);
    const minG = bigintField(r.minG);
    const allowedRequiredTiers = inputArray(r.allowedRequiredTiers).map((value) => numberField(value, VNEXT.MAX_TIER));
    const allowedFeeRecipients = inputArray(r.allowedFeeRecipients).map(policyAddress);
    const allowedPayoutRecipients = inputArray(r.allowedPayoutRecipients).map(policyAddress);
    const reclaimMinSeconds = numberField(r.reclaimMinSeconds, Number.MAX_SAFE_INTEGER);
    const reclaimMaxSeconds = numberField(r.reclaimMaxSeconds, Number.MAX_SAFE_INTEGER);
    const maxFeeBps = numberField(r.maxFeeBps, VNEXT.MAX_FEE_BPS);
    const maxUnits = numberField(r.maxUnits, VNEXT.MAX_SETTLEMENT_UNITS);
    const maxAcceptanceSeconds = numberField(r.maxAcceptanceSeconds, Number.MAX_SAFE_INTEGER);
    if (factory === zeroAddress || implementation === zeroAddress
      || !allowedPayoutRecipients.some((address) => address.toLowerCase() === operatorPayoutRecipient.toLowerCase())
      || allowedRequiredTiers.length === 0 || new Set(allowedRequiredTiers).size !== allowedRequiredTiers.length
      || new Set(allowedFeeRecipients.map((address) => address.toLowerCase())).size !== allowedFeeRecipients.length
      || allowedPayoutRecipients.length === 0
      || new Set(allowedPayoutRecipients.map((address) => address.toLowerCase())).size !== allowedPayoutRecipients.length
      || BigInt(reclaimMinSeconds) < VNEXT.MIN_RECLAIM_DELAY || BigInt(reclaimMaxSeconds) > VNEXT.MAX_RECLAIM_DELAY
      || reclaimMinSeconds > reclaimMaxSeconds || maxUnits === 0 || maxAcceptanceSeconds === 0) {
      throw new OperatorSigningError("bad_terms");
    }
    return Object.freeze({ chainId, factory, implementation, operatorPayoutRecipient, settlementToken,
      subjectPins: Object.freeze(subjectPins) as HostTerms["subjectPins"],
      ...(bindingsRoot === undefined ? {} : { bindingsRoot }), maxPassThrough,
      minG, allowedRequiredTiers: Object.freeze(allowedRequiredTiers), reclaimMinSeconds,
      reclaimMaxSeconds, maxFeeBps, allowedFeeRecipients: Object.freeze(allowedFeeRecipients),
      allowedPayoutRecipients: Object.freeze(allowedPayoutRecipients), maxUnits, maxAcceptanceSeconds });
  } catch { throw new OperatorSigningError("bad_terms"); }
}

/** Runtime schema uses the compiler's types; no local JobPolicy or UnitConfig type is maintained. */
export function snapshotJobPolicyAcceptanceInput(input: JobPolicyAcceptanceInput): JobPolicyAcceptanceInput {
  const r = inputRecord(input, ["policy", "units", "subjectBlock", "bindings"]);
  const p = inputRecord(r.policy, ["chainId", "factory", "implementation", "escrow", "payer", "operator",
    "jobIdHash", "termsHash", "policyNonce", "prePolicyRoot", "unitsRoot", "expiry", "acceptedPolicyDigest"]);
  const policy: JobPolicyFields = {
    chainId: bigintField(p.chainId), factory: policyAddress(p.factory), implementation: policyAddress(p.implementation),
    escrow: policyAddress(p.escrow), payer: policyAddress(p.payer), operator: policyAddress(p.operator),
    jobIdHash: policyBytes32(p.jobIdHash), termsHash: policyBytes32(p.termsHash), policyNonce: bigintField(p.policyNonce),
    prePolicyRoot: policyBytes32(p.prePolicyRoot), unitsRoot: policyBytes32(p.unitsRoot), expiry: bigintField(p.expiry),
    acceptedPolicyDigest: policyBytes32(p.acceptedPolicyDigest),
  };
  const units: UnitConfig[] = inputArray(r.units).map((value) => {
    const u = inputRecord(value, ["milestoneIndex", "stepId", "requiredTier", "requestedTier", "g", "f", "n",
      "feeBps", "feeRecipient", "reclaimAt", "compositionSchemaVersion", "compositionRoot", "payouts"]);
    return {
      milestoneIndex: bigintField(u.milestoneIndex), stepId: policyBytes32(u.stepId),
      requiredTier: numberField(u.requiredTier, 255), requestedTier: numberField(u.requestedTier, 255),
      g: bigintField(u.g), f: bigintField(u.f), n: bigintField(u.n), feeBps: numberField(u.feeBps, 65535),
      feeRecipient: policyAddress(u.feeRecipient), reclaimAt: bigintField(u.reclaimAt),
      compositionSchemaVersion: numberField(u.compositionSchemaVersion, 65535), compositionRoot: policyBytes32(u.compositionRoot),
      payouts: inputArray(u.payouts).map((value) => {
        const payout = inputRecord(value, ["recipient", "amount"]);
        return { recipient: policyAddress(payout.recipient), amount: bigintField(payout.amount) };
      }),
    };
  });
  const subjectBlock = snapshotProducerRecord(r.subjectBlock) as unknown as SubjectBlockFields;
  const bindings = snapshotProducerBindings(r.bindings);
  return { policy, units, subjectBlock, bindings };
}

export function prepareJobPolicyAcceptance(input: JobPolicyAcceptanceInput, chainId: OperatorChainId,
  operator: Address, terms: HostTerms | undefined, clock: () => Date) {
  const snapshot = snapshotJobPolicyAcceptanceInput(input);
  const { policy, units, subjectBlock } = snapshot;
  const commitments = policyCommitments(snapshot);
  let nowMs: bigint;
  try {
    const time = Date.prototype.getTime.call(clock());
    if (!Number.isFinite(time)) throw new OperatorSigningError("bad_input");
    nowMs = BigInt(time);
  } catch { throw new OperatorSigningError("bad_input"); }
  if (policy.escrow === zeroAddress) throw new OperatorSigningError("bad_escrow");
  if (policy.factory === zeroAddress || policy.implementation === zeroAddress) {
    throw new OperatorSigningError("deployment_mismatch");
  }
  if (terms === undefined) throw new OperatorSigningError("bad_terms");
  if (policy.operator.toLowerCase() !== operator.toLowerCase()) throw new OperatorSigningError("operator_mismatch");
  if (policy.chainId !== BigInt(chainId)) throw new OperatorSigningError("chain_mismatch");
  if (policy.factory.toLowerCase() !== terms.factory.toLowerCase()
    || policy.implementation.toLowerCase() !== terms.implementation.toLowerCase()) {
    throw new OperatorSigningError("deployment_mismatch");
  }
  let operatorPrincipal: Hex;
  let payerPrincipal: Hex;
  try {
    operatorPrincipal = principalTupleWord("operator", formatOperatorPrincipalId(terms.chainId, operator));
    payerPrincipal = principalTupleWord("operator", formatOperatorPrincipalId(terms.chainId, policy.payer));
  } catch { throw new OperatorSigningError("bad_input"); }
  if (subjectBlock.operatorPrincipal.toLowerCase() !== operatorPrincipal.toLowerCase()) {
    throw new OperatorSigningError("operator_principal_mismatch");
  }
  if (subjectBlock.payer.toLowerCase() !== payerPrincipal.toLowerCase()) {
    throw new OperatorSigningError("payer_principal_mismatch");
  }
  for (const field of Object.keys(terms.subjectPins) as (keyof SubjectBlockFields)[]) {
    const pin = terms.subjectPins[field];
    const value = subjectBlock[field];
    const matches = field === "integrityGrade" ? BigInt(value) === BigInt(pin!)
      : (value as string).toLowerCase() === (pin as string).toLowerCase();
    if (!matches) throw new OperatorSigningError("subject_pin_mismatch");
  }
  if (subjectBlock.operatorSettlementAddress.toLowerCase() !== terms.operatorPayoutRecipient.toLowerCase()) {
    throw new OperatorSigningError("settlement_address_mismatch");
  }
  if (terms.bindingsRoot !== undefined && commitments.bindingsRoot !== terms.bindingsRoot.toLowerCase()) {
    throw new OperatorSigningError("bindings_root_mismatch");
  }
  if (units.length < 1 || units.length > terms.maxUnits) throw new OperatorSigningError("units_count");
  let passThrough = 0n;
  for (const unit of units) {
    if (unit.compositionSchemaVersion !== 0 || unit.compositionRoot.toLowerCase() !== zeroHash) {
      throw new OperatorSigningError("composition_not_supported");
    }
    if (unit.g < terms.minG) throw new OperatorSigningError("gross_below_min");
    if (!terms.allowedRequiredTiers.includes(unit.requiredTier)) throw new OperatorSigningError("tier_not_allowed");
    if (unit.reclaimAt < policy.expiry + BigInt(terms.reclaimMinSeconds)) throw new OperatorSigningError("reclaim_too_soon");
    if (unit.reclaimAt * 1000n > nowMs + BigInt(terms.reclaimMaxSeconds) * 1000n) throw new OperatorSigningError("reclaim_too_late");
    if (unit.feeBps > terms.maxFeeBps) throw new OperatorSigningError("fee_too_high");
    if (unit.feeRecipient === zeroAddress ? unit.feeBps !== 0
      : !terms.allowedFeeRecipients.some((address) => address.toLowerCase() === unit.feeRecipient.toLowerCase())) {
      throw new OperatorSigningError("fee_recipient_not_allowed");
    }
    if (unit.payouts.some((payout) => !terms.allowedPayoutRecipients.some((address) =>
      address.toLowerCase() === payout.recipient.toLowerCase()))) {
      throw new OperatorSigningError("payout_recipient_not_allowed");
    }
    const { f, n } = computeFee(unit.g, unit.feeBps);
    if (unit.f !== f || unit.n !== n) throw new OperatorSigningError("fee_split_mismatch");
    if (unit.payouts.length === 0 || unit.payouts.some((payout) => payout.amount <= 0n)
      || unit.payouts.reduce((sum, payout) => sum + payout.amount, 0n) !== unit.n) {
      throw new OperatorSigningError("payout_sum_mismatch");
    }
    const own = unit.payouts.reduce((sum, payout) =>
      payout.recipient.toLowerCase() === terms.operatorPayoutRecipient.toLowerCase() ? sum + payout.amount : sum, 0n);
    passThrough += unit.n - own;
    try {
      // The exported builder enforces the compiler's context-free per-unit rules.
      // It derives requestedTier, so also check the caller's supplied tier against that result.
      const validated = buildUnitConfig(unit);
      if (unit.requestedTier !== validated.requestedTier) throw new OperatorSigningError("bad_input");
    } catch { throw new OperatorSigningError("bad_input"); }
  }
  // Job-level assurance must agree across the same ordered snapshot used below.
  // The per-unit requestedTier equality is already enforced by buildUnitConfig above.
  const assuranceTier = units[0]!.requiredTier;
  if (units.some((unit) => unit.requiredTier !== assuranceTier)) {
    throw new OperatorSigningError("assurance_tier_mismatch");
  }
  let termsHash: Hex;
  try {
    termsHash = computeTermsHash({ token: terms.settlementToken, assuranceTier,
      milestones: units.map((unit) => ({ milestoneIndex: unit.milestoneIndex, stepId: unit.stepId,
        amount: unit.g, deadline: unit.reclaimAt })) });
  } catch { throw new OperatorSigningError("bad_input"); }
  if (policy.termsHash.toLowerCase() !== termsHash.toLowerCase()) throw new OperatorSigningError("terms_hash_mismatch");
  if (commitments.acceptedPolicyDigest !== policy.acceptedPolicyDigest.toLowerCase()) {
    throw new OperatorSigningError("accepted_policy_mismatch");
  }
  if (passThrough > terms.maxPassThrough) throw new OperatorSigningError("pass_through_too_high");
  if (policy.expiry * 1000n <= nowMs) throw new OperatorSigningError("acceptance_expired");
  if (policy.expiry * 1000n > nowMs + BigInt(terms.maxAcceptanceSeconds) * 1000n) throw new OperatorSigningError("acceptance_too_long");
  try {
    const root = unitsRoot(units.map((unit) => settlementUnitId({ chainId: policy.chainId, escrow: policy.escrow,
      jobIdHash: policy.jobIdHash, milestoneIndex: unit.milestoneIndex, stepId: unit.stepId })));
    if (policy.unitsRoot.toLowerCase() !== root) throw new OperatorSigningError("units_root_mismatch");
    // unitsRoot only binds identities. The pre-policy commitment binds the checked economic configs.
    if (policy.prePolicyRoot.toLowerCase() !== prePolicyRoot(units)) throw new OperatorSigningError("pre_policy_root_mismatch");
    if (policy.escrow.toLowerCase() !== predictEscrow({ factory: policy.factory,
      implementation: policy.implementation, salt: policySalt(policy) }).toLowerCase()) {
      throw new OperatorSigningError("escrow_mismatch");
    }
    return jobPolicyTypedData(policy);
  } catch (error) {
    if (error instanceof OperatorSigningError) throw error;
    throw new OperatorSigningError("bad_input");
  }
}

export function prepareD1(input: D1Input, chainId: OperatorChainId) {
  const record = inputRecord(input, ["escrow", "settlementUnitId", "jobIdHash", "milestoneIndex",
    "stepId", "compositionRoot", "acceptedEnvelopeHash", "packageBodyHash"]);
  const escrow = escrowAddress(record.escrow);
  return {
    domain: { name: "PCC FinalMilestonePackage", version: "2", chainId, verifyingContract: escrow },
    types: d1Types,
    primaryType: "FinalMilestonePackageV2" as const,
    message: {
      chainId: BigInt(chainId), escrow,
      settlementUnitId: bytes32(record.settlementUnitId),
      jobIdHash: bytes32(record.jobIdHash),
      milestoneIndex: unsignedInteger(record.milestoneIndex),
      stepId: bytes32(record.stepId),
      compositionRoot: bytes32(record.compositionRoot),
      acceptedEnvelopeHash: bytes32(record.acceptedEnvelopeHash),
      packageBodyHash: bytes32(record.packageBodyHash),
    },
  };
}

export function prepareSubmitEvidenceTx(input: SubmitEvidenceTxInput, chainId: OperatorChainId) {
  const record = inputRecord(input, ["escrow", "unitId", "packageDigest", "nonce", "gas",
    "maxFeePerGas", "maxPriorityFeePerGas"]);
  const escrow = escrowAddress(record.escrow);
  const unitId = bytes32(record.unitId);
  const packageDigest = bytes32(record.packageDigest);
  if (packageDigest === zeroHash) throw new OperatorSigningError("zero_package_digest");
  return {
    type: "eip1559" as const,
    chainId,
    to: escrow,
    value: 0n,
    data: encodeFunctionData({ abi: [submitEvidenceAbiItem], functionName: "submitEvidence", args: [unitId, packageDigest] }),
    nonce: Number(unsignedInteger(record.nonce, BigInt(Number.MAX_SAFE_INTEGER))),
    gas: unsignedInteger(record.gas),
    maxFeePerGas: unsignedInteger(record.maxFeePerGas),
    maxPriorityFeePerGas: unsignedInteger(record.maxPriorityFeePerGas),
  };
}
