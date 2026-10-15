/**
 * `prepareFunding`: verify a gateway's prepare payload before the buyer signs or sends anything. Author:
 * implementer-bravo (pcc-adk).
 *
 * It recomputes everything it can and refuses on any difference. It never repairs a payload (buyer-funding plan
 * S3.1; the check list and the source of each check are in the design note and on each refusal below). On
 * success it returns a deep-frozen `PreparedFunding`, registered in a module-private set. `signJobPolicy` and
 * `approveAndFund` accept nothing else, so neither can be handed unverified terms.
 * Every pin, especially the factory, must come from the caller's own trusted configuration,
 * never from the gateway payload or any gateway response.
 *
 * ESC = packages/contracts/src/VNextSettlementEscrow.sol, FAC = .../VNextSettlementEscrowFactory.sol.
 */
import {
  getAddress,
  hexToBigInt,
  hexToNumber,
  isAddress,
  recoverAddress,
  size,
  slice,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { AcceptedPolicyDigestInputError, computeAcceptedPolicyDigest } from "../evidence/accepted-policy.js";
import { computeTermsHashV21, TermsHashV21Error } from "./terms-hash-v21.js";
import { assertChain, describeRevert, pinBlock, pinnedReader } from "./chain.js";
import { refuse } from "./errors.js";
import { parsePreparePayload, type PreparePayload } from "./payload.js";
import { resolvePins, type FundingPins } from "./pins.js";
import {
  ECDSA_S_MAX,
  ESCROW_ABI,
  FACTORY_ABI,
  JOB_POLICY_FIELDS,
  MAX_RECLAIM_DELAY,
  MAX_PAYOUT_LEGS,
  MAX_UNITS,
  MIN_RECLAIM_DELAY,
  POLICY_VERSION,
  acceptanceDigest,
  domainSeparator,
  jobPolicyHash,
  jobIdHashOf,
  jobPolicyTypedData,
  policyKey,
  policySalt,
  prePolicyRoot,
  predictEscrow,
  settlementUnitId,
  unitsRoot,
  type JobPolicyMessage,
  type JobPolicyTypedData,
  type PayoutEntry,
  type UnitConfig,
} from "./vnext.js";

/** Seconds the acceptance must outlive the latest block, and the slack kept above the 10-day reclaim floor. */
export const DEFAULT_MARGIN_SECONDS = 300n;

/**
 * Buyer intent fixed in the caller's own records before requesting the prepare payload; never copy it from that
 * payload. PCC MVP units bind all three commitments exactly (termsHash, acceptedPolicyDigest and compositionRoots);
 * bind jobPolicyHash as well when you hold it. An MVP integration never passes allowUnchecked.
 * Values come from the caller's own pins;
 * Thursday PRINT buyers use printUnitThursdayExpectation and economics' PRINT_UNIT_THURSDAY_V1 pins.
 * A PRINT buyer's termsHash is the v2.1 hash of the configs it funds (#8165), carried privately until evidence's
 * public producer is available (#8168). The oracle's Thursday-shape vector test exists in
 * `print-unit-golden-v2.test.ts`: `reproduces v2.1 milestonesRoot and DERIVED termsHash from the example terms`.
 * Never copy values from a payload or gateway response. Outside the MVP, exact-literal "unchecked" waivers require
 * allowUnchecked: true and leave the terms, evidence policy or composition to the payload's author;
 * prepared.unchecked lists them.
 * Optional expectations bind chainId, unit count, each unit's gross, ordered payouts, composition schema and
 * reclaim floor exactly when supplied. Without jobPolicyHash, unbound values remain the payload author's choices,
 * including milestoneIndex, stepId, expiry, policyNonce, each tier within the allowed set, reclaimAt within
 * the permitted window, each unit's feeBps up to maxFeeBps (which fixes f and n), its fee recipient within
 * feeRecipients, and its compositionRoot within compositionRoots. Deriving termsHash binds it to these configs;
 * it does not independently constrain these choices. A mixed tier set hands the choice of release authority to the
 * payload's author, unit by unit: a tier-0 unit releases only on the buyer's approval; a tier-1+ unit releases on
 * the cohort's assertion once its challenge window closes. The buyer can contest it only by posting a bond within
 * that window, which opens an appeal. The unit still releases unless the appeal rules for the buyer, and appeal
 * silence releases. Show prepared.configs to the buyer, or bind jobPolicyHash.
 */
export interface FundingExpectations {
  jobId: string;
  operator: Address;
  payees: readonly Address[];
  maxFeeBps: number;
  feeRecipients: readonly Address[];
  /** Accepted ESC assurance tiers, integers 0..3. Both requiredTier and requestedTier must belong. */
  tiers: readonly number[];
  /** Latest permitted reclaim time, in chain seconds. */
  latestReclaimAt: bigint;
  /** Pin a hash, derive v2.1 from the funded configs, or explicitly waive outside the MVP. */
  termsHash: Hex | "unchecked" | { derive: "v2.1"; token: Address; assuranceTier: number };
  /** Roots bind the public digest producer to the termsHash the buyer checked; unchecked terms are refused. */
  acceptedPolicyDigest: Hex | "unchecked" | { subjectBlockHash: Hex; bindingsRoot: Hex };
  compositionRoots: readonly Hex[] | "unchecked";
  /** Exact UnitConfig composition schema version, uint16; never waivable. */
  compositionSchemaVersion?: number;
  /** Exact chain id; never waivable. */
  chainId?: bigint;
  /** Exact number of settlement units. */
  unitCount?: number;
  /** Exact gross USDC base units for every settlement unit. */
  unitGross?: bigint;
  /** Exact ordered recipient/amount payout legs for every settlement unit. */
  unitPayouts?: readonly PayoutEntry[];
  /** Earliest permitted reclaim time, in chain seconds. */
  earliestReclaimAt?: bigint;
  jobPolicyHash?: Hex;
}

export type UncheckedFundingField = "termsHash" | "acceptedPolicyDigest" | "compositionRoots";

export interface PrepareFundingArgs {
  /** The gateway's prepare response, JSON-decoded (`pcc.vnext.buyer-funding.prepare.v1`). */
  payload: unknown;
  /** The buyer's viem wallet: an EOA account that signs and sends. */
  wallet: WalletClient;
  /** Reads the chain the payload names. */
  publicClient: PublicClient;
  /** The buyer-approved quote: ΣG above it is refused. */
  quote: { maxTotalGross: bigint };
  /** Required independent buyer intent; explicit "unchecked" waivers are recorded in PreparedFunding.unchecked. */
  expect: FundingExpectations;
  /**
   * Explicit opt-in to exact-literal commitment waivers outside the MVP: omit it or pass a boolean.
   * Only an own property is used; an own getter is read once.
   */
  allowUnchecked?: boolean;
  /**
   * Extra pins by chain id; required for the factory until a V-next deployment is pinned in this module.
   * Every pin, especially the factory, must come from the caller's own trusted configuration,
   * never from the gateway payload or any gateway response.
   */
  pins?: FundingPins;
  marginSeconds?: bigint;
}

/**
 * A payload that passed every check, with every value the SDK recomputed. Deep-frozen.
 * Optional expectations bind chainId, unit count, each unit's gross, ordered payouts, composition schema and
 * reclaim floor exactly when supplied. Without jobPolicyHash, unbound values remain the payload author's choices,
 * including milestoneIndex, stepId, expiry, policyNonce, each tier within the allowed set, reclaimAt within
 * the permitted window, each unit's feeBps up to maxFeeBps (which fixes f and n), its fee recipient within
 * feeRecipients, and its compositionRoot within compositionRoots. Deriving termsHash binds it to these configs;
 * it does not independently constrain these choices. A mixed tier set hands the choice of release authority to the
 * payload's author, unit by unit: a tier-0 unit releases only on the buyer's approval; a tier-1+ unit releases on
 * the cohort's assertion once its challenge window closes. The buyer can contest it only by posting a bond within
 * that window, which opens an appeal. The unit still releases unless the appeal rules for the buyer, and appeal
 * silence releases. Show prepared.configs to the buyer, or bind jobPolicyHash.
 * These choices are not waivers and do not appear in unchecked.
 */
export interface PreparedFunding {
  /** A frozen copy of the caller's independent intent, captured before any RPC call. */
  readonly expect: Readonly<FundingExpectations>;
  /** Explicitly waived commitments, for a buyer UI or agent to display. */
  readonly unchecked: readonly UncheckedFundingField[];
  readonly chainId: bigint;
  readonly factory: Address;
  readonly implementation: Address;
  readonly escrow: Address;
  readonly usdc: Address;
  readonly payer: Address;
  readonly operator: Address;
  /** ΣG: exactly what `fund()` pulls from the payer, and exactly what the approve allows. */
  readonly totalGross: bigint;
  readonly expiry: bigint;
  readonly configs: readonly UnitConfig[];
  readonly unitIds: readonly Hex[];
  readonly prePolicyRoot: Hex;
  /** The EIP-712 struct hash: `policy().jobPolicyHash_` reads back exactly this once funded. */
  readonly jobPolicyHash: Hex;
  readonly digest: Hex;
  readonly policyKey: Hex;
  /** The SDK's own typed data: the only thing `signJobPolicy` signs. */
  readonly typedData: JobPolicyTypedData;
  readonly operatorSignature: Hex;
  /** When the money is locked until: a unit refunds at its reclaimAt unless it is released first (plan G14). */
  readonly reclaimAt: { readonly earliest: bigint; readonly latest: bigint };
  /** The block the live checks ran at. */
  readonly verifiedAt: { readonly blockNumber: bigint; readonly blockHash: Hex; readonly blockTimestamp: bigint };
}

const PREPARED = new WeakSet<object>();

/** Only an object `prepareFunding` returned passes; a structurally identical copy does not. */
export function assertPrepared(x: unknown): PreparedFunding {
  if (typeof x !== "object" || x === null || !PREPARED.has(x)) {
    refuse("NOT_PREPARED", "pass the object prepareFunding returned; nothing else is signed or sent");
  }
  return x as PreparedFunding;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Validate and copy caller intent synchronously; no RPC or signature request precedes this. */
function copyExpectations(raw: unknown): FundingExpectations {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) {
    refuse("BAD_EXPECTATION", "expect must be a plain object");
  }
  const e = raw as Record<string, unknown>;
  const required = ["jobId", "operator", "payees", "maxFeeBps", "feeRecipients", "tiers", "latestReclaimAt", "termsHash", "acceptedPolicyDigest", "compositionRoots"];
  const optional = ["jobPolicyHash", "compositionSchemaVersion", "chainId", "unitCount", "unitGross", "unitPayouts", "earliestReclaimAt"];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(e, key)) ||
      Object.keys(e).some((key) => !required.includes(key) && !optional.includes(key))) {
    refuse("BAD_EXPECTATION", `expect must contain ${required.join(", ")}, with only ${optional.join(", ")} optional`);
  }
  const address = (v: unknown, field: string): Address => {
    if (typeof v !== "string" || !isAddress(v)) refuse("BAD_EXPECTATION", `expect.${field} is not an address`);
    return v;
  };
  const addresses = (v: unknown, field: string, nonempty: boolean): Address[] => {
    if (!Array.isArray(v) || (nonempty && v.length === 0)) refuse("BAD_EXPECTATION", `expect.${field} must be ${nonempty ? "a non-empty" : "an"} address array`);
    // Array.from also validates sparse entries rather than silently skipping them.
    return Array.from(v, (entry, i) => address(entry, `${field}[${i}]`));
  };
  const hash = (v: unknown, field: string): Hex => {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) refuse("BAD_EXPECTATION", `expect.${field} is not a bytes32`);
    return v as Hex;
  };
  const uint256 = (v: unknown, field: string): bigint => {
    if (typeof v !== "bigint" || v < 0n || v >= 1n << 256n) {
      refuse("BAD_EXPECTATION", `expect.${field} must be a non-negative uint256 bigint`);
    }
    return v;
  };
  if (typeof e.jobId !== "string") refuse("BAD_EXPECTATION", "expect.jobId must be a string");
  const operator = address(e.operator, "operator");
  const payees = addresses(e.payees, "payees", true);
  if (typeof e.maxFeeBps !== "number" || !Number.isInteger(e.maxFeeBps) || e.maxFeeBps < 0 || e.maxFeeBps > 10_000) {
    refuse("BAD_EXPECTATION", "expect.maxFeeBps must be an integer in [0, 10000]");
  }
  const feeRecipients = addresses(e.feeRecipients, "feeRecipients", e.maxFeeBps !== 0);
  if (!Array.isArray(e.tiers) || e.tiers.length === 0) refuse("BAD_EXPECTATION", "expect.tiers must be a non-empty array");
  const tiers = Array.from(e.tiers, (tier) => {
    if (typeof tier !== "number" || !Number.isInteger(tier) || tier < 0 || tier > 3) refuse("BAD_EXPECTATION", "expect.tiers entries must be integers in [0, 3]");
    return tier;
  });
  if (typeof e.latestReclaimAt !== "bigint" || e.latestReclaimAt < 0n || e.latestReclaimAt >= 1n << 256n) {
    refuse("BAD_EXPECTATION", "expect.latestReclaimAt must be a non-negative uint256 bigint in chain seconds");
  }
  const fields = (v: object, keys: readonly string[], field: string): Record<string, unknown> => {
    if (Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v)) ||
        keys.some((key) => !Object.prototype.hasOwnProperty.call(v, key)) ||
        Object.keys(v).some((key) => !keys.includes(key))) {
      refuse("BAD_EXPECTATION", `expect.${field} must contain only ${keys.join(", ")}`);
    }
    return v as Record<string, unknown>;
  };
  let termsHash: FundingExpectations["termsHash"];
  if (typeof e.termsHash === "object" && e.termsHash !== null) {
    const t = fields(e.termsHash, ["derive", "token", "assuranceTier"], "termsHash");
    if (t.derive !== "v2.1") refuse("BAD_EXPECTATION", "expect.termsHash.derive must be v2.1");
    if (typeof t.assuranceTier !== "number" || !Number.isInteger(t.assuranceTier) || t.assuranceTier < 0 || t.assuranceTier > 3) {
      refuse("BAD_EXPECTATION", "expect.termsHash.assuranceTier must be an integer in [0, 3]");
    }
    termsHash = { derive: "v2.1", token: address(t.token, "termsHash.token"), assuranceTier: t.assuranceTier };
  } else termsHash = e.termsHash === "unchecked" ? e.termsHash : hash(e.termsHash, "termsHash");
  let acceptedPolicyDigest: FundingExpectations["acceptedPolicyDigest"];
  if (typeof e.acceptedPolicyDigest === "object" && e.acceptedPolicyDigest !== null) {
    const a = fields(e.acceptedPolicyDigest, ["subjectBlockHash", "bindingsRoot"], "acceptedPolicyDigest");
    if (termsHash === "unchecked") refuse("BAD_EXPECTATION", "expect.acceptedPolicyDigest roots require a checked termsHash");
    acceptedPolicyDigest = { subjectBlockHash: hash(a.subjectBlockHash, "acceptedPolicyDigest.subjectBlockHash"),
      bindingsRoot: hash(a.bindingsRoot, "acceptedPolicyDigest.bindingsRoot") };
  } else acceptedPolicyDigest = e.acceptedPolicyDigest === "unchecked" ? e.acceptedPolicyDigest : hash(e.acceptedPolicyDigest, "acceptedPolicyDigest");
  let compositionRoots: readonly Hex[] | "unchecked";
  if (e.compositionRoots === "unchecked") compositionRoots = e.compositionRoots;
  else {
    if (!Array.isArray(e.compositionRoots) || e.compositionRoots.length === 0) refuse("BAD_EXPECTATION", "expect.compositionRoots must be a non-empty bytes32 array or the literal unchecked");
    compositionRoots = Array.from(e.compositionRoots, (root, i) => hash(root, `compositionRoots[${i}]`));
  }
  const compositionSchemaVersion = e.compositionSchemaVersion;
  if (compositionSchemaVersion !== undefined &&
      (typeof compositionSchemaVersion !== "number" || !Number.isInteger(compositionSchemaVersion) ||
       compositionSchemaVersion < 0 || compositionSchemaVersion > 65_535)) {
    refuse("BAD_EXPECTATION", "expect.compositionSchemaVersion must be an integer in [0, 65535]");
  }
  const chainId = e.chainId === undefined ? undefined : uint256(e.chainId, "chainId");
  if (chainId === 0n) refuse("BAD_EXPECTATION", "expect.chainId must be a positive uint256 bigint");
  const unitCount = e.unitCount;
  if (unitCount !== undefined && (typeof unitCount !== "number" || !Number.isInteger(unitCount) || unitCount < 1 || unitCount > MAX_UNITS)) {
    refuse("BAD_EXPECTATION", `expect.unitCount must be an integer in [1, ${MAX_UNITS}]`);
  }
  const unitGross = e.unitGross === undefined ? undefined : uint256(e.unitGross, "unitGross");
  const earliestReclaimAt = e.earliestReclaimAt === undefined ? undefined : uint256(e.earliestReclaimAt, "earliestReclaimAt");
  if (earliestReclaimAt !== undefined && earliestReclaimAt > e.latestReclaimAt) {
    refuse("BAD_EXPECTATION", "expect.earliestReclaimAt must not exceed expect.latestReclaimAt");
  }
  let unitPayouts: PayoutEntry[] | undefined;
  if (e.unitPayouts !== undefined) {
    if (!Array.isArray(e.unitPayouts) || e.unitPayouts.length < 1 || e.unitPayouts.length > MAX_PAYOUT_LEGS) {
      refuse("BAD_EXPECTATION", `expect.unitPayouts must contain 1..${MAX_PAYOUT_LEGS} payout entries`);
    }
    unitPayouts = Array.from(e.unitPayouts, (entry: unknown, i) => {
      const field = `unitPayouts[${i}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) {
        refuse("BAD_EXPECTATION", `expect.${field} must be a plain recipient/amount object`);
      }
      const leg = entry as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(leg, "recipient") || !Object.prototype.hasOwnProperty.call(leg, "amount") ||
          Object.keys(leg).some((key) => key !== "recipient" && key !== "amount")) {
        refuse("BAD_EXPECTATION", `expect.${field} must contain only recipient and amount`);
      }
      return { recipient: address(leg.recipient, `${field}.recipient`), amount: uint256(leg.amount, `${field}.amount`) };
    });
  }
  return { jobId: e.jobId, operator, payees, maxFeeBps: e.maxFeeBps, feeRecipients, tiers,
    latestReclaimAt: e.latestReclaimAt, termsHash, acceptedPolicyDigest, compositionRoots,
    ...(compositionSchemaVersion === undefined ? {} : { compositionSchemaVersion }),
    ...(chainId === undefined ? {} : { chainId }),
    ...(unitCount === undefined ? {} : { unitCount }),
    ...(unitGross === undefined ? {} : { unitGross }),
    ...(unitPayouts === undefined ? {} : { unitPayouts }),
    ...(earliestReclaimAt === undefined ? {} : { earliestReclaimAt }),
    ...(e.jobPolicyHash === undefined ? {} : { jobPolicyHash: hash(e.jobPolicyHash, "jobPolicyHash") }) };
}

function checkIntent(p: PreparePayload, e: FundingExpectations, structHash: Hex): void {
  const m = p.typedData.message;
  const display = (v: unknown): string => Array.isArray(v) ? `[${v.join(", ")}]` : String(v);
  const mismatch = (field: string, got: unknown, want: unknown): never =>
    refuse("INTENT_MISMATCH", `${field} is ${display(got)}; the buyer expects ${display(want)}`);
  const expectedJob = jobIdHashOf(e.jobId);
  if (e.chainId !== undefined && p.chainId !== e.chainId) mismatch("chainId", p.chainId, e.chainId);
  if (!same(m.jobIdHash, expectedJob)) mismatch("jobId (message.jobIdHash)", m.jobIdHash, expectedJob);
  if (!same(m.operator, e.operator)) mismatch("operator", m.operator, e.operator);
  let checkedTermsHash: Hex | undefined;
  if (typeof e.termsHash === "object") {
    const { token, assuranceTier } = e.termsHash;
    p.fund.configs.forEach((c, i) => {
      for (const field of ["requiredTier", "requestedTier"] as const) {
        if (c[field] !== assuranceTier) mismatch(`assuranceTier (fund.configs[${i}].${field})`, c[field], assuranceTier);
      }
    });
    try {
      checkedTermsHash = computeTermsHashV21({ token, assuranceTier,
        milestones: p.fund.configs.map((c) => ({ milestoneIndex: c.milestoneIndex, stepId: c.stepId, amount: c.g, deadline: c.reclaimAt })) });
    } catch (error) {
      if (error instanceof TermsHashV21Error) refuse("INTENT_MISMATCH", `termsHash: ${error.message}`);
      throw error;
    }
  } else if (e.termsHash !== "unchecked") checkedTermsHash = e.termsHash;
  if (checkedTermsHash !== undefined && !same(m.termsHash, checkedTermsHash)) mismatch("termsHash", m.termsHash, checkedTermsHash);
  let checkedDigest: Hex | undefined;
  if (typeof e.acceptedPolicyDigest === "object") {
    try {
      checkedDigest = computeAcceptedPolicyDigest({ termsHash: checkedTermsHash!.toLowerCase() as Hex,
        subjectBlockHash: e.acceptedPolicyDigest.subjectBlockHash.toLowerCase() as Hex,
        bindingsRoot: e.acceptedPolicyDigest.bindingsRoot.toLowerCase() as Hex });
    } catch (error) {
      if (error instanceof AcceptedPolicyDigestInputError) refuse("INTENT_MISMATCH", `acceptedPolicyDigest: ${error.message}`);
      throw error;
    }
  } else if (e.acceptedPolicyDigest !== "unchecked") checkedDigest = e.acceptedPolicyDigest;
  if (checkedDigest !== undefined && !same(m.acceptedPolicyDigest, checkedDigest)) mismatch("acceptedPolicyDigest", m.acceptedPolicyDigest, checkedDigest);
  if (e.unitCount !== undefined && p.fund.configs.length !== e.unitCount) mismatch("unitCount (fund.configs.length)", p.fund.configs.length, e.unitCount);
  p.fund.configs.forEach((c, i) => {
    if (e.unitGross !== undefined && c.g !== e.unitGross) mismatch(`unitGross (fund.configs[${i}].g)`, c.g, e.unitGross);
    if (e.unitPayouts !== undefined) {
      if (c.payouts.length !== e.unitPayouts.length) mismatch(`unitPayouts (fund.configs[${i}].payouts.length)`, c.payouts.length, e.unitPayouts.length);
      c.payouts.forEach((leg, j) => {
        const expected = e.unitPayouts![j]!;
        if (!same(leg.recipient, expected.recipient)) mismatch(`unitPayouts (fund.configs[${i}].payouts[${j}].recipient)`, leg.recipient, expected.recipient);
        if (leg.amount !== expected.amount) mismatch(`unitPayouts (fund.configs[${i}].payouts[${j}].amount)`, leg.amount, expected.amount);
      });
    }
    c.payouts.forEach((leg, j) => {
      if (!e.payees.some((payee) => same(leg.recipient, payee))) mismatch(`payees (fund.configs[${i}].payouts[${j}].recipient)`, leg.recipient, e.payees);
    });
    if (c.feeBps > e.maxFeeBps) mismatch(`maxFeeBps (fund.configs[${i}].feeBps)`, c.feeBps, e.maxFeeBps);
    // ESC:787-788 / E3 binds the recipient whenever feeBps > 0, even if F rounds to zero.
    if (c.feeBps > 0 && !e.feeRecipients.some((recipient) => same(c.feeRecipient, recipient))) mismatch(`feeRecipients (fund.configs[${i}].feeRecipient)`, c.feeRecipient, e.feeRecipients);
    for (const field of ["requiredTier", "requestedTier"] as const) {
      if (!e.tiers.includes(c[field])) mismatch(`tiers (fund.configs[${i}].${field})`, c[field], e.tiers);
    }
    if (c.reclaimAt > e.latestReclaimAt) mismatch(`latestReclaimAt (fund.configs[${i}].reclaimAt)`, c.reclaimAt, e.latestReclaimAt);
    if (e.earliestReclaimAt !== undefined && c.reclaimAt < e.earliestReclaimAt) mismatch(`earliestReclaimAt (fund.configs[${i}].reclaimAt)`, c.reclaimAt, e.earliestReclaimAt);
    if (e.compositionRoots !== "unchecked" && !e.compositionRoots.some((root) => same(c.compositionRoot, root))) mismatch(`compositionRoots (fund.configs[${i}].compositionRoot)`, c.compositionRoot, e.compositionRoots);
    if (e.compositionSchemaVersion !== undefined && c.compositionSchemaVersion !== e.compositionSchemaVersion) mismatch(`compositionSchemaVersion (fund.configs[${i}].compositionSchemaVersion)`, c.compositionSchemaVersion, e.compositionSchemaVersion);
  });
  if (e.jobPolicyHash !== undefined && !same(structHash, e.jobPolicyHash)) mismatch("jobPolicyHash", structHash, e.jobPolicyHash);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** What the factory's ECDSA leg accepts (FAC:375-387): 65 bytes, v in {27, 28}, s <= secp256k1n / 2. */
export function eoaSignatureProblem(signature: Hex): string | undefined {
  if (size(signature) !== 65) return `the signature is ${size(signature)} bytes; an EOA signature is 65`;
  const v = hexToNumber(slice(signature, 64, 65));
  if (v !== 27 && v !== 28) return `v is ${v}; the factory accepts only 27 or 28`;
  if (hexToBigInt(slice(signature, 32, 64)) > ECDSA_S_MAX) return "s is above secp256k1n / 2; the factory rejects it";
  return undefined;
}

/** The address an EOA signature over `digest` recovers to, or undefined if it does not recover. */
export async function recoverSigner(digest: Hex, signature: Hex): Promise<Address | undefined> {
  try {
    return await recoverAddress({ hash: digest, signature });
  } catch {
    return undefined;
  }
}

/**
 * The time rules at a block. The factory refuses `block.timestamp > expiry` (FAC:237) and `fund()` refuses a
 * reclaimAt outside [10 d, 365 d] after its own block (ESC:796-801). The transactions land after `timestamp`,
 * so both keep `margin` seconds of slack on the side that time erodes.
 */
export function checkTiming(p: { expiry: bigint; configs: readonly UnitConfig[] }, timestamp: bigint, margin: bigint): void {
  if (p.expiry < timestamp + margin) {
    refuse("EXPIRY_TOO_SOON", `the acceptance expires at ${p.expiry}; the latest block is at ${timestamp}, and the margin is ${margin}s`);
  }
  p.configs.forEach((c, i) => {
    const delay = c.reclaimAt - timestamp;
    if (delay < MIN_RECLAIM_DELAY + margin || delay > MAX_RECLAIM_DELAY) {
      refuse(
        "RECLAIM_WINDOW",
        `fund.configs[${i}].reclaimAt is ${delay}s after the latest block; fund() needs [${MIN_RECLAIM_DELAY}, ${MAX_RECLAIM_DELAY}]s after its own block (margin ${margin}s)`,
      );
    }
  });
}

function domainProblem(got: PreparePayload["typedData"]["domain"], want: JobPolicyTypedData["domain"]): string | undefined {
  if (got.name !== want.name) return `name is "${got.name}"; the escrow's is "${want.name}"`;
  if (got.version !== want.version) return `version is "${got.version}"; the escrow's is "${want.version}"`;
  if (got.chainId !== want.chainId) return `chainId is ${got.chainId}; the policy's is ${want.chainId}`;
  if (!same(got.verifyingContract, want.verifyingContract)) {
    return `verifyingContract is ${got.verifyingContract}; the predicted escrow is ${want.verifyingContract}`;
  }
  return undefined;
}

function typedDataProblem(got: PreparePayload["typedData"], want: JobPolicyTypedData): string | undefined {
  if (got.primaryType !== want.primaryType) return `primaryType is "${got.primaryType}"; expected "${want.primaryType}"`;
  const g = got.types.JobPolicy;
  const w = want.types.JobPolicy;
  if (g.length !== w.length || g.some((f, i) => f.name !== w[i]!.name || f.type !== w[i]!.type)) {
    return "types.JobPolicy is not the contract's JobPolicy struct";
  }
  for (const { name } of JOB_POLICY_FIELDS) {
    const a = got.message[name];
    const b = want.message[name];
    const equal = typeof b === "bigint" ? a === b : same(String(a), b);
    if (!equal) return `message.${name} is ${String(a)}; the recomputed value is ${String(b)}`;
  }
  return undefined;
}

export async function prepareFunding(args: PrepareFundingArgs): Promise<PreparedFunding> {
  const allowUnchecked = Object.prototype.hasOwnProperty.call(args, "allowUnchecked") ? args.allowUnchecked : false;
  if (typeof allowUnchecked !== "boolean") {
    refuse("BAD_EXPECTATION", "allowUnchecked must be true or false");
  }
  const expect = copyExpectations(args.expect);
  const waived = (["termsHash", "acceptedPolicyDigest", "compositionRoots"] as const).filter((field) => expect[field] === "unchecked");
  if (waived.length !== 0 && allowUnchecked !== true) {
    refuse("BAD_EXPECTATION", `${waived.join(", ")} waived without allowUnchecked: true; the PCC MVP binds its commitments exactly and must not waive them`);
  }
  // Everything judged below comes from this parse, taken before the first await.
  const p = parsePreparePayload(args.payload);
  if (expect.chainId !== undefined && p.chainId !== expect.chainId) {
    refuse("INTENT_MISMATCH", `chainId is ${p.chainId}; the buyer expects ${expect.chainId}`);
  }
  const maxTotalGross = args.quote?.maxTotalGross;
  if (typeof maxTotalGross !== "bigint" || maxTotalGross < 0n) throw new TypeError("quote.maxTotalGross must be a non-negative bigint");
  const margin = args.marginSeconds ?? DEFAULT_MARGIN_SECONDS;
  if (typeof margin !== "bigint" || margin < 0n) throw new TypeError("marginSeconds must be a non-negative bigint");
  const pins = resolvePins(p.chainId, args.pins);
  const account = args.wallet.account;
  if (!account) refuse("PAYER_NOT_SIGNER", "the wallet has no account to sign or send with");
  const m = p.typedData.message;

  // 2. The deployment. The token is the pinned Circle USDC (plan S3 negative; DEP-01), and the factory is the pinned
  //    one (plan §3 step 6, S1 negative 5). Without a factory pin, every check below could be met by a look-alike
  //    deployment whose fund() pays someone else.
  if (pins.usdc === undefined) refuse("TOKEN_NOT_PINNED", `chain ${p.chainId} has no USDC pin`);
  if (typeof expect.termsHash === "object" && !same(expect.termsHash.token, pins.usdc)) {
    refuse("BAD_EXPECTATION", `expect.termsHash.token must equal pinned USDC ${pins.usdc}`);
  }
  if (!same(p.usdc, pins.usdc)) refuse("TOKEN_NOT_PINNED", `usdc ${p.usdc} is not the pinned USDC ${pins.usdc}`);
  if (pins.factory === undefined) refuse("FACTORY_NOT_PINNED", `chain ${p.chainId} has no factory pin: pass pins["${p.chainId}"].factory`);
  if (!same(p.factory, pins.factory)) refuse("FACTORY_NOT_PINNED", `factory ${p.factory} is not the pinned factory ${pins.factory}`);

  // 3. The payer is this wallet (plan S3 negative: "the payer is not its own address").
  if (!same(m.payer, account.address)) refuse("PAYER_NOT_SIGNER", `the policy's payer is ${m.payer}; the wallet is ${account.address}`);

  // 4. ΣG, recomputed from the configs (fund() pulls exactly that: ESC:830, 843), against the payload and the quote.
  const totalGross = p.fund.configs.reduce((sum, c) => sum + c.g, 0n);
  if (totalGross !== p.totalGross) refuse("TOTAL_GROSS_MISMATCH", `the configs' gross amounts sum to ${totalGross}; the payload says ${p.totalGross}`);
  if (totalGross > maxTotalGross) refuse("AMOUNT_EXCEEDS_QUOTE", `ΣG is ${totalGross}; the quote allows at most ${maxTotalGross}`);

  // 5. The terms: the configs' hash (ESC:873), then the address that hash commits to through the salt (FAC:390-398).
  const root = prePolicyRoot(p.fund.configs);
  if (!same(root, m.prePolicyRoot)) refuse("POLICY_ROOT_MISMATCH", `keccak256(abi.encode(configs)) is ${root}; the policy says ${m.prePolicyRoot}`);
  // The factory's PolicyIdentity, in its field order (VNextSettlementLib PolicyIdentity), with the recomputed root.
  const identity = {
    payer: m.payer,
    operator: m.operator,
    jobIdHash: m.jobIdHash,
    termsHash: m.termsHash,
    policyNonce: m.policyNonce,
    prePolicyRoot: root,
    acceptedPolicyDigest: m.acceptedPolicyDigest,
  };
  const salt = policySalt(identity);
  const escrow = predictEscrow(p.factory, m.implementation, salt);
  if (!same(escrow, p.escrow)) refuse("ESCROW_NOT_PREDICTED", `escrow ${p.escrow} is not CREATE2(factory, salt, clone(implementation)) = ${escrow}`);

  // 6. The typed data: exactly the JobPolicy the factory hashes (FAC:299-329), in the clone's domain (FAC:333-343).
  const unitIds = p.fund.configs.map((c) =>
    settlementUnitId({ chainId: p.chainId, escrow, jobIdHash: m.jobIdHash, milestoneIndex: c.milestoneIndex, stepId: c.stepId }),
  );
  const message: JobPolicyMessage = {
    chainId: p.chainId,
    factory: getAddress(p.factory),
    implementation: getAddress(m.implementation),
    escrow,
    policyVersion: POLICY_VERSION,
    payer: getAddress(m.payer),
    operator: getAddress(m.operator),
    jobIdHash: m.jobIdHash,
    termsHash: m.termsHash,
    policyNonce: m.policyNonce,
    prePolicyRoot: root,
    unitsRoot: unitsRoot(unitIds),
    expiry: p.expiry,
    acceptedPolicyDigest: m.acceptedPolicyDigest,
  };
  const typedData = jobPolicyTypedData(message);
  const badDomain = domainProblem(p.typedData.domain, typedData.domain);
  if (badDomain) refuse("DOMAIN_MISMATCH", badDomain);
  const badTypedData = typedDataProblem(p.typedData, typedData);
  if (badTypedData) refuse("TYPED_DATA_MISMATCH", badTypedData);

  // 7. The approve the gateway expects: exactly ΣG of the pinned USDC, to the escrow (plan §3 step 5).
  if (!same(p.approve.token, pins.usdc)) refuse("TOKEN_NOT_PINNED", `approve.token ${p.approve.token} is not the pinned USDC ${pins.usdc}`);
  if (!same(p.approve.spender, escrow)) refuse("APPROVE_SPENDER_NOT_ESCROW", `approve.spender ${p.approve.spender} is not the escrow ${escrow}`);
  if (p.approve.amount !== totalGross) refuse("APPROVE_AMOUNT_NOT_TOTAL", `approve.amount ${p.approve.amount} is not ΣG ${totalGross}`);

  // 8. The exact fund() args: this policy's expiry, and the payer-sent shape. The payer leg is implicit only when
  //    the payer sends (ESC:718; FAC:253), so its signature bytes are empty and are never checked.
  if (p.fund.acceptance.expiry !== p.expiry) refuse("FUND_ARGS_MISMATCH", `fund.acceptance.expiry ${p.fund.acceptance.expiry} is not the policy's ${p.expiry}`);
  if (p.fund.acceptance.payerSignature !== "0x") refuse("FUND_ARGS_MISMATCH", "fund.acceptance.payerSignature must be empty: the payer sends fund() itself");
  // E3: VNextSettlementLib.sol:583-589 requires N+F=G, F=0 and the zero fee recipient when feeBps is zero.
  // Refuse the reverting fund() args locally, before the buyer can broadcast an approval.
  p.fund.configs.forEach((c, i) => {
    if (c.feeBps !== 0) return;
    if (c.f !== 0n) refuse("FUND_ARGS_MISMATCH", `fund.configs[${i}].f must be 0 when feeBps is 0`);
    if (c.n !== c.g) refuse("FUND_ARGS_MISMATCH", `fund.configs[${i}].n must equal g when feeBps is 0`);
    if (!same(c.feeRecipient, "0x0000000000000000000000000000000000000000")) {
      refuse("FUND_ARGS_MISMATCH", `fund.configs[${i}].feeRecipient must be the zero address when feeBps is 0`);
    }
  });

  // 9. The operator's acceptance: an EOA signature over the RECOMPUTED digest (FAC:256, 375-387).
  const structHash = jobPolicyHash(message);
  const digest = acceptanceDigest(domainSeparator(p.chainId, escrow), structHash);
  const operatorSignature = p.fund.acceptance.operatorSignature;
  const badShape = eoaSignatureProblem(operatorSignature);
  if (badShape) refuse("OPERATOR_SIGNATURE_INVALID", badShape);
  const operatorSigner = await recoverSigner(digest, operatorSignature);
  if (operatorSigner === undefined || !same(operatorSigner, m.operator)) {
    refuse("OPERATOR_SIGNATURE_INVALID", `the operator signature recovers to ${operatorSigner ?? "nothing"} over these terms, not the operator ${m.operator}`);
  }

  // Internal coherence and the operator's signature do not establish the buyer's authorization.
  checkIntent(p, expect, structHash);

  // The first RPC follows all local checks, including the caller's independent intent.
  // Both clients must be on the policy's chain (plan S3 negative: "the chainId differs").
  await assertChain(args.wallet, args.publicClient, p.chainId);

  // 10. Live, at one pinned block: the pinned factory's implementation (an immutable, FAC:34), the factory's own
  //     prediction of the escrow address (ABI doc §5.2), that implementation's token (an immutable, ESC:75), and the
  //     time rules.
  const live = async <T>(what: string, read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (e) {
      refuse("LIVE_CHECK_FAILED", `${what}: ${describeRevert(e)}`);
    }
  };
  const block = await live("pin the latest block", () => pinBlock(args.publicClient));
  const reader = pinnedReader(args.publicClient, block.hash);
  const factoryCode = await live("read the factory's code", () => reader.code(p.factory));
  if (factoryCode === "0x") refuse("DEPLOYMENT_MISMATCH", `no code at the pinned factory ${p.factory} on chain ${p.chainId}`);
  const liveImplementation = await live("factory.implementation()", () => reader.read<Address>(p.factory, FACTORY_ABI, "implementation"));
  if (!same(liveImplementation, m.implementation)) {
    refuse("DEPLOYMENT_MISMATCH", `the pinned factory's implementation is ${liveImplementation}; the policy names ${m.implementation}`);
  }
  // reviewer-charlie L5: the escrow the approve names must also be the pinned factory's own answer for this identity
  // (FAC:146, 390-392), so it never rests on this module's salt and CREATE2 derivation alone.
  const predicted = await live("factory.predictEscrow(identity)", () => reader.read<Address>(p.factory, FACTORY_ABI, "predictEscrow", [identity]));
  if (!same(predicted, escrow)) {
    refuse("ESCROW_NOT_PREDICTED", `the pinned factory's predictEscrow(identity) is ${predicted}; this module derived ${escrow}`);
  }
  const liveToken = await live("implementation.USDC()", () => reader.read<Address>(m.implementation, ESCROW_ABI, "USDC"));
  if (!same(liveToken, pins.usdc)) refuse("TOKEN_NOT_PINNED", `the implementation settles in ${liveToken}, not the pinned USDC ${pins.usdc}`);
  checkTiming({ expiry: p.expiry, configs: p.fund.configs }, block.timestamp, margin);

  const reclaims = p.fund.configs.map((c) => c.reclaimAt);
  const prepared: PreparedFunding = deepFreeze({
    expect,
    unchecked: (["termsHash", "acceptedPolicyDigest", "compositionRoots"] as const).filter((field) => expect[field] === "unchecked"),
    chainId: p.chainId,
    factory: message.factory,
    implementation: message.implementation,
    escrow,
    usdc: getAddress(pins.usdc),
    payer: message.payer,
    operator: message.operator,
    totalGross,
    expiry: p.expiry,
    configs: p.fund.configs,
    unitIds,
    prePolicyRoot: root,
    jobPolicyHash: structHash,
    digest,
    policyKey: policyKey(message.payer, message.operator, m.jobIdHash),
    typedData,
    operatorSignature,
    reclaimAt: {
      earliest: reclaims.reduce((a, b) => (b < a ? b : a)),
      latest: reclaims.reduce((a, b) => (b > a ? b : a)),
    },
    verifiedAt: { blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp },
  });
  PREPARED.add(prepared);
  return prepared;
}
