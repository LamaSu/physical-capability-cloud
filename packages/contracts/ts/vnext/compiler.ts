/**
 * The V-next exact settlement compiler: the ONE public, canonical off-chain implementation of the
 * bytes the V-next settlement contracts commit to (reconciliation ledger row R14).
 *
 * Composition (the accepted-plan compiler) and economics (the payout compiler) call this module.
 * They never encode a V-next value themselves: two encoders drift, and a drifted encoder is a job
 * that funds at the wrong address, or never funds at all.
 *
 * Byte contract: `docs/VNEXT_SETTLEMENT_ABI.md`, frozen at master `ac86a404`. Every value this
 * module produces is pinned by `./golden.ts`:
 *   - `test/VNextAbiFreeze.t.sol` pins the same literals against the REAL contracts, end to end
 *     (predict, create, then fund with signatures over the independently computed digest);
 *   - `ts/__tests__/vnext-compiler.test.ts` pins them against this module.
 * The literals were computed by a third implementation that read only the doc.
 *
 * Pure: no I/O, no clock, no randomness. Integers are `bigint`, except the uint8/uint16 fields,
 * which are range-checked `number`s. Fails closed on every STATIC funding rule (doc §5.1): an input
 * that `fund()` or `initialize()` would reject for its content alone throws {@link VNextCompileError}
 * before any hash is returned.
 *
 * Compiling is NOT proof of fundability. Whether a job funds also depends on live chain state that
 * a pure function cannot see (doc §5.2): cohorts enabled, the policy nonce not revoked or superseded,
 * the job not already funded, the clone created and unsealed, the signatures valid for their signers,
 * and the token pull exact. `preflightVNextFunding` (./preflight.ts) checks those against a live
 * client and simulates the exact signed `fund()` call from the actual sender.
 */
import {
  concat,
  encodeAbiParameters,
  getContractAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

const k = (preimage: string): Hex => keccak256(stringToHex(preimage));

const JOB_POLICY_TYPE =
  "JobPolicy(uint256 chainId,address factory,address implementation,address escrow,uint256 policyVersion,address payer,address operator,bytes32 jobIdHash,bytes32 termsHash,uint256 policyNonce,bytes32 prePolicyRoot,bytes32 unitsRoot,uint256 expiry,bytes32 acceptedPolicyDigest)";

const UINT256_MAX = (1n << 256n) - 1n;

/** Doc §1. Hashes are derived from their preimages here and pinned as literals by the golden tests. */
export const VNEXT = {
  SETTLEMENT_UNIT_DOMAIN: k("PCC:vnext:settlement-unit:v1"),
  POLICY_SALT_DOMAIN: k("PCC:vnext:policy-salt:v2"),
  POLICY_NONCE_DOMAIN: k("PCC:vnext:policy-nonce:v1"),
  EVIDENCE_COMMITMENT_DOMAIN: k("PCC:vnext:evidence-commitment:v1"),
  EIP712_DOMAIN_TYPEHASH: k("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  EIP712_NAME: "VNextSettlementEscrow",
  EIP712_VERSION: "1",
  EIP712_NAME_HASH: k("VNextSettlementEscrow"),
  EIP712_VERSION_HASH: k("1"),
  JOB_POLICY_TYPE,
  JOB_POLICY_TYPEHASH: k(JOB_POLICY_TYPE),
  POLICY_VERSION: 2n,
  DOMAIN_VERSION_V1: 1,
  FEE_BASIS_GROSS: 0,
  ROUNDING_FLOOR: 0,
  FEE_DENOMINATOR: 10_000n,
  MAX_FEE_BPS: 1000,
  MIN_BONDABLE_GROSS: 5n,
  /** `g` is narrowed to uint128 at funding (`toUint128`, reverts `ValueOverflow`). */
  MAX_GROSS: (1n << 128n) - 1n,
  /** `reclaimAt` is narrowed to uint64 at funding (`toUint64`, reverts `ValueOverflow`). The ABI field stays uint256. */
  MAX_RECLAIM_AT: (1n << 64n) - 1n,
  MAX_TIER: 3,
  MAX_SETTLEMENT_UNITS: 16,
  MAX_PAYOUT_LEGS_PER_UNIT: 16,
  MAX_TOTAL_LEGS_PER_JOB: 256,
  /** 10 days = challenge 2 d + appeal 5 d + backup 2 d + 1 d. */
  MIN_RECLAIM_DELAY: 864_000n,
  /** 365 days. */
  MAX_RECLAIM_DELAY: 31_536_000n,
  MAX_SIGNATURE_BYTES: 1024,
  /** The complete `fund()` calldata, selector included. */
  MAX_CONFIG_BYTES: 26_372,
  /**
   * The escrow's FIXED evidence-commitment layout label (`submitEvidence` hardcodes it). It is NOT
   * the evidence package's own format: a FinalMilestonePackageV2 (body `packageFormat: "2"`) is
   * committed with label 1, and its own format is already inside `packageDigest`'s preimage.
   */
  EVIDENCE_PACKAGE_FORMAT_V1: 1,
  FEE_LEG_INDEX: UINT256_MAX,
  REFUND_LEG_INDEX: UINT256_MAX - 1n,
  BOND_LEG_INDEX: UINT256_MAX - 2n,
  DELAY_COMP_LEG_INDEX: UINT256_MAX - 3n,
  BURN_LEG_INDEX: UINT256_MAX - 4n,
  /** EIP-1167 minimal-proxy creation code = PREFIX ‖ implementation (20 bytes) ‖ SUFFIX (55 bytes total). */
  EIP1167_PREFIX: "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" as Hex,
  EIP1167_SUFFIX: "0x5af43d82803e903d91602b57fd5bf3" as Hex,
} as const;

/** `ClaimClass` (VNextSettlementLib), as its uint8 ABI values. */
export const ClaimClass = { PRINCIPAL: 0, FEE: 1, REFUND: 2, BOND: 3, DELAY_COMP: 4, BURN: 5 } as const;
export type ClaimClassValue = (typeof ClaimClass)[keyof typeof ClaimClass];

/**
 * `UnitState` (VNextSettlementLib), as the uint8 that `unitState(unitId)` returns. These are ABI
 * values only. Render them through the canonical money-status map in `@pcc/spec`, never a local one.
 * `unitState()` never returns AWAITING_FUNDING: it reverts `UnitNotFound()` for an unfunded id, so
 * an observed 0 is a read error.
 */
export const VNextUnitState = {
  AWAITING_FUNDING: 0,
  FUNDED_ACTIVE: 1,
  PRIMARY_ASSERTED: 2,
  CHALLENGED: 3,
  BACKUP_PENDING: 4,
  BACKUP_ASSERTED: 5,
  RELEASE_ALLOCATED: 6,
  REFUND_ALLOCATED: 7,
  SETTLED_RELEASED: 8,
  SETTLED_REFUNDED: 9,
} as const;
export type VNextUnitStateValue = (typeof VNextUnitState)[keyof typeof VNextUnitState];

// ── Types (doc §2) ─────────────────────────────────────────────────────────────────────────────

export interface PayoutEntry {
  recipient: Address;
  amount: bigint;
}

/** The funding input for one settlement unit: `VNextSettlementEscrow.UnitConfig`, field for field. */
export interface UnitConfig {
  milestoneIndex: bigint;
  stepId: Hex;
  requiredTier: number;
  requestedTier: number;
  g: bigint;
  f: bigint;
  n: bigint;
  feeBps: number;
  feeRecipient: Address;
  reclaimAt: bigint;
  compositionSchemaVersion: number;
  compositionRoot: Hex;
  payouts: readonly PayoutEntry[];
}

/** What a unit's author supplies. `f` and `n` are derived; `requestedTier` equals `requiredTier`. */
export interface UnitSpec {
  milestoneIndex: bigint;
  stepId: Hex;
  requiredTier: number;
  g: bigint;
  feeBps: number;
  /** `0x0` iff `feeBps == 0`. */
  feeRecipient: Address;
  reclaimAt: bigint;
  compositionSchemaVersion: number;
  compositionRoot: Hex;
  payouts: readonly PayoutEntry[];
}

export interface PolicyIdentity {
  payer: Address;
  operator: Address;
  jobIdHash: Hex;
  termsHash: Hex;
  policyNonce: bigint;
  prePolicyRoot: Hex;
  acceptedPolicyDigest: Hex;
}

export interface PolicyAcceptance {
  expiry: bigint;
  payerSignature: Hex;
  operatorSignature: Hex;
}

export interface VNextCompileInput {
  chainId: bigint;
  factory: Address;
  /** `factory.implementation()`. */
  implementation: Address;
  /** The implementation's settlement token (`USDC()`), which may not be a recipient. */
  token: Address;
  payer: Address;
  operator: Address;
  jobIdHash: Hex;
  termsHash: Hex;
  policyNonce: bigint;
  acceptedPolicyDigest: Hex;
  /** Acceptance expiry (unix seconds). `fund()` reverts `PolicyExpired` after it. */
  expiry: bigint;
  /**
   * The unix time the job is expected to be funded. `fund()` checks every `reclaimAt` against
   * `block.timestamp`, so compile with the time you expect to fund at and keep margin from both
   * edges of the reclaim window.
   */
  fundingTime: bigint;
  /** ORDERED: the array order is the funding order, which is hashed into two roots. */
  units: readonly UnitConfig[];
}

export interface CompiledUnit {
  config: UnitConfig;
  unitId: Hex;
  feeScheduleHash: Hex;
  payoutConfigHash: Hex;
}

export interface JobPolicyTypedData {
  domain: { name: string; version: string; chainId: bigint; verifyingContract: Address };
  types: { JobPolicy: readonly { name: string; type: string }[] };
  primaryType: "JobPolicy";
  message: {
    chainId: bigint;
    factory: Address;
    implementation: Address;
    escrow: Address;
    policyVersion: bigint;
    payer: Address;
    operator: Address;
    jobIdHash: Hex;
    termsHash: Hex;
    policyNonce: bigint;
    prePolicyRoot: Hex;
    unitsRoot: Hex;
    expiry: bigint;
    acceptedPolicyDigest: Hex;
  };
}

export interface CompiledVNextPolicy {
  chainId: bigint;
  factory: Address;
  implementation: Address;
  /** The settlement token the compile assumed (recipient exclusion). The preflight checks it is `USDC()`. */
  token: Address;
  /** The funding time the compile assumed. The preflight re-checks the windows at the live block time. */
  fundingTime: bigint;
  configs: readonly UnitConfig[];
  prePolicyRoot: Hex;
  identity: PolicyIdentity;
  salt: Hex;
  escrow: Address;
  unitIds: readonly Hex[];
  unitsRoot: Hex;
  expiry: bigint;
  /** The EIP-712 struct hash both parties sign over (doc §3 step 6). */
  jobPolicyHash: Hex;
  domainSeparator: Hex;
  /** The EIP-712 digest the payer and the operator sign (doc §3 step 8). */
  digest: Hex;
  /** The same digest as EIP-712 typed data, for wallets (`signTypedData`). */
  typedData: JobPolicyTypedData;
  policyKey: Hex;
  perUnit: readonly CompiledUnit[];
  /** Σ g: the exact amount `fund()` pulls from the payer. */
  totalGross: bigint;
}

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────

/** Each code names the `fund()` / `initialize()` / factory revert it pre-empts. */
export type VNextCompileErrorCode =
  | "BAD_INPUT" // malformed address / bytes32 / integer (no contract analogue: rejected before encoding)
  | "BAD_UNIT_COUNT" // BadUnitCount
  | "BAD_LEG_COUNT" // BadLegCount
  | "TOO_MANY_LEGS" // TooManyLegs
  | "TIER_REQUEST_MISMATCH" // TierRequestMismatch
  | "TIER_OUT_OF_RANGE" // TierOutOfRange
  | "VALUE_OVERFLOW" // ValueOverflow: g > 2^128-1 (toUint128) or reclaimAt > 2^64-1 (toUint64)
  | "FEE_BPS_TOO_HIGH" // "V1: feeBps>MAX"
  | "GROSS_BELOW_MIN" // "V1: G<minBondable"
  | "NET_ZERO" // "V1: N==0"
  | "FEE_NOT_BELOW_GROSS" // "V1: F>=G"
  | "NET_PLUS_FEE_MISMATCH" // "V1: N+F!=G"
  | "FEE_MISMATCH" // "V1: F!=mulDiv"
  | "FEE_RECIPIENT_MISSING" // "V1: fee>0 recipient==0"
  | "FEE_ZERO_REPRESENTATION" // "V1: fee==0 rep"
  | "ZERO_PAYOUT" // ZeroPayout
  | "FORBIDDEN_RECIPIENT" // ForbiddenRecipient
  | "PAYOUT_SUM_MISMATCH" // PayoutSumMismatch
  | "BAD_RECLAIM" // BadReclaim
  | "DUPLICATE_UNIT" // DuplicateUnit
  | "PARTY_COLLISION" // PartyCollision
  | "ONLY_PAYER" // OnlyPayer: a sender other than the payer must carry the payer's signature
  | "POLICY_EXPIRED" // PolicyExpired
  | "SIGNATURE_TOO_LARGE" // SignatureTooLarge
  | "CONFIG_TOO_LARGE"; // ConfigTooLarge

export class VNextCompileError extends Error {
  readonly code: VNextCompileErrorCode;
  constructor(code: VNextCompileErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "VNextCompileError";
    this.code = code;
  }
}

function fail(code: VNextCompileErrorCode, message: string): never {
  throw new VNextCompileError(code, message);
}

// ── Input checks ───────────────────────────────────────────────────────────────────────────────

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function address(value: unknown, what: string): Address {
  if (typeof value !== "string" || !isAddress(value)) fail("BAD_INPUT", `${what} is not an address: ${String(value)}`);
  return value as Address;
}

function bytes32(value: unknown, what: string): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) fail("BAD_INPUT", `${what} is not a bytes32: ${String(value)}`);
  return value as Hex;
}

/** uint256 as a bigint. A JS `number` is refused on purpose: it silently corrupts values above 2^53. */
function uint(value: unknown, what: string, max: bigint = UINT256_MAX): bigint {
  if (typeof value !== "bigint") fail("BAD_INPUT", `${what} must be a bigint, got ${typeof value}`);
  const v = value as bigint;
  if (v < 0n || v > max) fail("BAD_INPUT", `${what} is out of range: ${v}`);
  return v;
}

/** uint8 / uint16 as a safe-integer `number`. */
function small(value: unknown, what: string, bits: 8 | 16): number {
  const max = bits === 8 ? 0xff : 0xffff;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    fail("BAD_INPUT", `${what} must be an integer in [0, ${max}], got ${String(value)}`);
  }
  return value as number;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `Array.isArray` without its narrowing, which would widen a `readonly T[]` to `any[]`. */
const isArray = (value: unknown): boolean => Array.isArray(value);

// ── Fee math (doc §2 / §5) ─────────────────────────────────────────────────────────────────────

/** The escrow's ONLY fee rule: `f = floor(g * feeBps / 10000)`, `n = g - f`. */
export function computeFee(g: bigint, feeBps: number): { f: bigint; n: bigint } {
  const gross = uint(g, "g");
  const bps = small(feeBps, "feeBps", 16);
  const f = (gross * BigInt(bps)) / VNEXT.FEE_DENOMINATOR; // bigint division truncates = floor for g >= 0
  return { f, n: gross - f };
}

/**
 * Build one `UnitConfig` from its author's spec: derives `f`/`n` with {@link computeFee}, sets
 * `requestedTier = requiredTier`, and refuses every context-free per-unit rule of doc §5, including
 * exact conservation (`Σ payouts == n`). Context rules (recipient ≠ escrow/token/factory, the
 * reclaim window, duplicates) are checked by {@link compileVNextPolicy}.
 */
export function buildUnitConfig(spec: UnitSpec): UnitConfig {
  const { f, n } = computeFee(spec.g, spec.feeBps);
  const config: UnitConfig = {
    milestoneIndex: spec.milestoneIndex,
    stepId: spec.stepId,
    requiredTier: spec.requiredTier,
    requestedTier: spec.requiredTier,
    g: spec.g,
    f,
    n,
    feeBps: spec.feeBps,
    feeRecipient: spec.feeRecipient,
    reclaimAt: spec.reclaimAt,
    compositionSchemaVersion: spec.compositionSchemaVersion,
    compositionRoot: spec.compositionRoot,
    payouts: spec.payouts.map((p) => ({ recipient: p.recipient, amount: p.amount })),
  };
  checkUnitConfig(config, 0);
  return config;
}

/**
 * The context-free `fund()` checks for one unit, in the contract's order: tiers, the uint128 bound,
 * `checkV1Invariants`, the leg count, each leg, conservation, then the fee recipient.
 */
function checkUnitConfig(c: UnitConfig, i: number): void {
  const at = `units[${i}]`;
  uint(c.milestoneIndex, `${at}.milestoneIndex`);
  bytes32(c.stepId, `${at}.stepId`);
  const requiredTier = small(c.requiredTier, `${at}.requiredTier`, 8);
  const requestedTier = small(c.requestedTier, `${at}.requestedTier`, 8);
  const g = uint(c.g, `${at}.g`);
  const f = uint(c.f, `${at}.f`);
  const n = uint(c.n, `${at}.n`);
  const feeBps = small(c.feeBps, `${at}.feeBps`, 16);
  const feeRecipient = address(c.feeRecipient, `${at}.feeRecipient`);
  uint(c.reclaimAt, `${at}.reclaimAt`);
  small(c.compositionSchemaVersion, `${at}.compositionSchemaVersion`, 16);
  bytes32(c.compositionRoot, `${at}.compositionRoot`);
  if (!isArray(c.payouts)) fail("BAD_INPUT", `${at}.payouts is not an array`);

  if (requiredTier !== requestedTier) fail("TIER_REQUEST_MISMATCH", `${at}: requiredTier != requestedTier`);
  if (requiredTier > VNEXT.MAX_TIER) fail("TIER_OUT_OF_RANGE", `${at}: tier ${requiredTier} > ${VNEXT.MAX_TIER}`);
  if (g > VNEXT.MAX_GROSS) fail("VALUE_OVERFLOW", `${at}: g does not fit uint128`);

  // checkV1Invariants, in its order (the fixed fields it also checks are set by the escrow itself).
  if (feeBps > VNEXT.MAX_FEE_BPS) fail("FEE_BPS_TOO_HIGH", `${at}: feeBps ${feeBps} > ${VNEXT.MAX_FEE_BPS}`);
  if (g < VNEXT.MIN_BONDABLE_GROSS) fail("GROSS_BELOW_MIN", `${at}: g ${g} < ${VNEXT.MIN_BONDABLE_GROSS}`);
  if (n === 0n) fail("NET_ZERO", `${at}: n == 0`);
  if (f >= g) fail("FEE_NOT_BELOW_GROSS", `${at}: f >= g`);
  if (n + f !== g) fail("NET_PLUS_FEE_MISMATCH", `${at}: n + f != g`);
  if (f !== (g * BigInt(feeBps)) / VNEXT.FEE_DENOMINATOR) fail("FEE_MISMATCH", `${at}: f != floor(g*feeBps/10000)`);
  if (feeBps > 0) {
    if (same(feeRecipient, zeroAddress)) fail("FEE_RECIPIENT_MISSING", `${at}: feeBps > 0 with no fee recipient`);
  } else if (f !== 0n || !same(feeRecipient, zeroAddress)) {
    fail("FEE_ZERO_REPRESENTATION", `${at}: feeBps == 0 needs f == 0 and feeRecipient == 0x0`);
  }

  const legs = c.payouts.length;
  if (legs === 0 || legs > VNEXT.MAX_PAYOUT_LEGS_PER_UNIT) fail("BAD_LEG_COUNT", `${at}: ${legs} payout legs`);
  let sum = 0n;
  c.payouts.forEach((p, j) => {
    const amount = uint(p.amount, `${at}.payouts[${j}].amount`);
    const recipient = address(p.recipient, `${at}.payouts[${j}].recipient`);
    if (amount === 0n) fail("ZERO_PAYOUT", `${at}.payouts[${j}]: zero amount`);
    if (same(recipient, zeroAddress)) fail("FORBIDDEN_RECIPIENT", `${at}.payouts[${j}]: zero recipient`);
    sum += amount;
  });
  // Exact conservation (R34): over- AND under-allocation are both refused, including by 1 base unit.
  if (sum !== n) fail("PAYOUT_SUM_MISMATCH", `${at}: payouts sum to ${sum}, n is ${n}`);
}

/** Recipient exclusion set (`_requireAllowedRecipient`): not 0x0, the escrow, the token or the factory. */
function requireAllowedRecipient(r: Address, ctx: { escrow: Address; token: Address; factory: Address }, what: string) {
  if (same(r, zeroAddress) || same(r, ctx.escrow) || same(r, ctx.token) || same(r, ctx.factory)) {
    fail("FORBIDDEN_RECIPIENT", `${what} (${r}) is 0x0, the escrow, the token or the factory`);
  }
}

// ── ABI parameter shapes ───────────────────────────────────────────────────────────────────────

const PAYOUT_COMPONENTS = [
  { name: "recipient", type: "address" },
  { name: "amount", type: "uint256" },
] as const;

const PAYOUTS_PARAM = { type: "tuple[]", components: PAYOUT_COMPONENTS } as const;

/** `UnitConfig[]`: `(uint256,bytes32,uint8,uint8,uint256,uint256,uint256,uint16,address,uint256,uint16,bytes32,(address,uint256)[])[]`. */
const UNIT_CONFIGS_PARAM = {
  type: "tuple[]",
  components: [
    { name: "milestoneIndex", type: "uint256" },
    { name: "stepId", type: "bytes32" },
    { name: "requiredTier", type: "uint8" },
    { name: "requestedTier", type: "uint8" },
    { name: "g", type: "uint256" },
    { name: "f", type: "uint256" },
    { name: "n", type: "uint256" },
    { name: "feeBps", type: "uint16" },
    { name: "feeRecipient", type: "address" },
    { name: "reclaimAt", type: "uint256" },
    { name: "compositionSchemaVersion", type: "uint16" },
    { name: "compositionRoot", type: "bytes32" },
    { name: "payouts", type: "tuple[]", components: PAYOUT_COMPONENTS },
  ],
} as const;

const SALT_PARAMS = parseAbiParameters("bytes32, address, address, bytes32, bytes32, uint256, bytes32, bytes32");
const UNIT_ID_PARAMS = parseAbiParameters("bytes32, uint256, address, bytes32, uint256, bytes32");
const PAIR_PARAMS = parseAbiParameters("bytes32, bytes32");
const JOB_POLICY_PARAMS = parseAbiParameters(
  "bytes32, uint256, address, address, address, uint256, address, address, bytes32, bytes32, uint256, bytes32, bytes32, uint256, bytes32",
);
const DOMAIN_PARAMS = parseAbiParameters("bytes32, bytes32, bytes32, uint256, address");
const POLICY_KEY_PARAMS = parseAbiParameters("bytes32, address, address, bytes32");
const FEE_SCHEDULE_PARAMS = parseAbiParameters(
  "uint8, uint256, address, bytes32, uint8, uint256, uint256, uint256, uint16, uint256, uint8, address, bytes32",
);
const CLAIM_ID_PARAMS = parseAbiParameters("uint256, address, bytes32, uint256, uint8");
const EVIDENCE_PARAMS = parseAbiParameters("bytes32, uint256, address, bytes32, uint16, uint8, bytes32");

const plainPayouts = (payouts: readonly PayoutEntry[]) =>
  payouts.map((p) => ({ recipient: p.recipient, amount: p.amount }));

// ── Hashes (doc §3, §4) ────────────────────────────────────────────────────────────────────────

/** `abi.encode(UnitConfig[])`: the preimage of {@link prePolicyRoot}, with its leading 0x20 word. */
export function encodeUnitConfigs(configs: readonly UnitConfig[]): Hex {
  return encodeAbiParameters(
    [UNIT_CONFIGS_PARAM],
    [configs.map((c) => ({ ...c, payouts: plainPayouts(c.payouts) }))],
  );
}

/** Doc §3 step 1: `keccak256(abi.encode(UnitConfig[]))`. Order-sensitive. */
export function prePolicyRoot(configs: readonly UnitConfig[]): Hex {
  return keccak256(encodeUnitConfigs(configs));
}

/** Doc §3 step 2: the CREATE2 salt over the complete policy identity. */
export function policySalt(id: PolicyIdentity): Hex {
  return keccak256(
    encodeAbiParameters(SALT_PARAMS, [
      VNEXT.POLICY_SALT_DOMAIN,
      id.payer,
      id.operator,
      id.jobIdHash,
      id.termsHash,
      id.policyNonce,
      id.prePolicyRoot,
      id.acceptedPolicyDigest,
    ]),
  );
}

/** keccak256 of the EIP-1167 creation code for a clone of `implementation`. */
export function cloneInitCodeHash(implementation: Address): Hex {
  return keccak256(concat([VNEXT.EIP1167_PREFIX, implementation, VNEXT.EIP1167_SUFFIX]));
}

/** Doc §3 step 3: the clone address `factory.predictEscrow(identity)` returns. */
export function predictEscrow(p: { factory: Address; implementation: Address; salt: Hex }): Address {
  return getContractAddress({
    opcode: "CREATE2",
    from: p.factory,
    salt: p.salt,
    bytecodeHash: cloneInitCodeHash(p.implementation),
  });
}

/** Doc §3 step 4. */
export function settlementUnitId(p: {
  chainId: bigint;
  escrow: Address;
  jobIdHash: Hex;
  milestoneIndex: bigint;
  stepId: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(UNIT_ID_PARAMS, [
      VNEXT.SETTLEMENT_UNIT_DOMAIN,
      p.chainId,
      p.escrow,
      p.jobIdHash,
      p.milestoneIndex,
      p.stepId,
    ]),
  );
}

/** Doc §3 step 5: `r = 0; r = keccak256(abi.encode(r, id))` for each unit id, in funding order. */
export function unitsRoot(unitIds: readonly Hex[]): Hex {
  let r: Hex = zeroHash;
  for (const id of unitIds) r = keccak256(encodeAbiParameters(PAIR_PARAMS, [r, id]));
  return r;
}

export interface JobPolicyFields {
  chainId: bigint;
  factory: Address;
  implementation: Address;
  escrow: Address;
  payer: Address;
  operator: Address;
  jobIdHash: Hex;
  termsHash: Hex;
  policyNonce: bigint;
  prePolicyRoot: Hex;
  unitsRoot: Hex;
  expiry: bigint;
  acceptedPolicyDigest: Hex;
}

/** Doc §3 step 6: the EIP-712 struct hash of `JobPolicy` (15 static words). */
export function jobPolicyHash(p: JobPolicyFields): Hex {
  return keccak256(
    encodeAbiParameters(
      JOB_POLICY_PARAMS,
      [
        VNEXT.JOB_POLICY_TYPEHASH,
        p.chainId,
        p.factory,
        p.implementation,
        p.escrow,
        VNEXT.POLICY_VERSION,
        p.payer,
        p.operator,
        p.jobIdHash,
        p.termsHash,
        p.policyNonce,
        p.prePolicyRoot,
        p.unitsRoot,
        p.expiry,
        p.acceptedPolicyDigest,
      ],
    ),
  );
}

/** Doc §3 step 7: the CLONE's EIP-712 domain (`verifyingContract` is the escrow, not the factory). */
export function domainSeparator(chainId: bigint, escrow: Address): Hex {
  return keccak256(
    encodeAbiParameters(DOMAIN_PARAMS, [
      VNEXT.EIP712_DOMAIN_TYPEHASH,
      VNEXT.EIP712_NAME_HASH,
      VNEXT.EIP712_VERSION_HASH,
      chainId,
      escrow,
    ]),
  );
}

/** Doc §3 step 8: `keccak256(0x1901 ‖ domainSeparator ‖ jobPolicyHash)`. */
export function acceptanceDigest(domainSep: Hex, policyHash: Hex): Hex {
  return keccak256(concat(["0x1901", domainSep, policyHash]));
}

/** The acceptance as EIP-712 typed data; `hashTypedData` of it equals {@link acceptanceDigest}. */
export function jobPolicyTypedData(p: JobPolicyFields): JobPolicyTypedData {
  return {
    domain: {
      name: VNEXT.EIP712_NAME,
      version: VNEXT.EIP712_VERSION,
      chainId: p.chainId,
      verifyingContract: p.escrow,
    },
    types: {
      JobPolicy: [
        { name: "chainId", type: "uint256" },
        { name: "factory", type: "address" },
        { name: "implementation", type: "address" },
        { name: "escrow", type: "address" },
        { name: "policyVersion", type: "uint256" },
        { name: "payer", type: "address" },
        { name: "operator", type: "address" },
        { name: "jobIdHash", type: "bytes32" },
        { name: "termsHash", type: "bytes32" },
        { name: "policyNonce", type: "uint256" },
        { name: "prePolicyRoot", type: "bytes32" },
        { name: "unitsRoot", type: "bytes32" },
        { name: "expiry", type: "uint256" },
        { name: "acceptedPolicyDigest", type: "bytes32" },
      ],
    },
    primaryType: "JobPolicy",
    message: {
      chainId: p.chainId,
      factory: p.factory,
      implementation: p.implementation,
      escrow: p.escrow,
      policyVersion: VNEXT.POLICY_VERSION,
      payer: p.payer,
      operator: p.operator,
      jobIdHash: p.jobIdHash,
      termsHash: p.termsHash,
      policyNonce: p.policyNonce,
      prePolicyRoot: p.prePolicyRoot,
      unitsRoot: p.unitsRoot,
      expiry: p.expiry,
      acceptedPolicyDigest: p.acceptedPolicyDigest,
    },
  };
}

/** Doc §3: the (payer, operator, job) scope of `policyNonceFloor` and `fundedEscrowOf`. */
export function policyKey(payer: Address, operator: Address, jobIdHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(POLICY_KEY_PARAMS, [
      VNEXT.POLICY_NONCE_DOMAIN,
      payer,
      operator,
      jobIdHash,
    ]),
  );
}

/** Doc §4: the 13-field fee schedule the escrow freezes per unit (`feeScheduleHashOf`). */
export function feeScheduleHash(p: {
  chainId: bigint;
  escrow: Address;
  settlementUnitId: Hex;
  g: bigint;
  f: bigint;
  n: bigint;
  feeBps: number;
  feeRecipient: Address;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      FEE_SCHEDULE_PARAMS,
      [
        VNEXT.DOMAIN_VERSION_V1,
        p.chainId,
        p.escrow,
        p.settlementUnitId,
        VNEXT.FEE_BASIS_GROSS,
        p.g,
        p.f,
        p.n,
        p.feeBps,
        VNEXT.FEE_DENOMINATOR,
        VNEXT.ROUNDING_FLOOR,
        p.feeRecipient,
        zeroHash,
      ],
    ),
  );
}

/** Doc §4: `keccak256(abi.encode(bytes32 settlementUnitId, (address,uint256)[] payouts))`. */
export function payoutConfigHash(settlementUnitIdValue: Hex, payouts: readonly PayoutEntry[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, PAYOUTS_PARAM],
      [settlementUnitIdValue, plainPayouts(payouts)],
    ),
  );
}

/** Doc §4. `legIndex`: the payout index for PRINCIPAL, else `VNEXT.*_LEG_INDEX`. */
export function claimId(p: {
  chainId: bigint;
  escrow: Address;
  settlementUnitId: Hex;
  legIndex: bigint;
  claimClass: ClaimClassValue;
}): Hex {
  return keccak256(
    encodeAbiParameters(CLAIM_ID_PARAMS, [
      p.chainId,
      p.escrow,
      p.settlementUnitId,
      p.legIndex,
      p.claimClass,
    ]),
  );
}

/**
 * Doc §4: the commitment `submitEvidence` stores. The layout label is always
 * `VNEXT.EVIDENCE_PACKAGE_FORMAT_V1` (1); there is deliberately no parameter for it.
 */
export function evidenceCommitment(p: {
  chainId: bigint;
  escrow: Address;
  settlementUnitId: Hex;
  compositionSchemaVersion: number;
  packageDigest: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(EVIDENCE_PARAMS, [
      VNEXT.EVIDENCE_COMMITMENT_DOMAIN,
      p.chainId,
      p.escrow,
      p.settlementUnitId,
      p.compositionSchemaVersion,
      VNEXT.EVIDENCE_PACKAGE_FORMAT_V1,
      p.packageDigest,
    ]),
  );
}

/** The escrow's `jobIdHash` convention: keccak256 of the job id's UTF-8 bytes (pass the canonical id). */
export function jobIdHashOf(jobId: string): Hex {
  return keccak256(stringToHex(jobId));
}

// ── The compiler ───────────────────────────────────────────────────────────────────────────────

/**
 * Compile a V-next job end to end (doc §3), refusing every STATIC rule of doc §5.1 first.
 * A successful compile is not proof of fundability: run `preflightVNextFunding` for doc §5.2.
 *
 * Returns everything both parties need to sign and everything the funder needs to submit:
 * the escrow address, the unit ids, the digest (and the same digest as typed data), and the
 * per-unit hashes the escrow will freeze, so a reader can verify the funded escrow against it.
 */
export function compileVNextPolicy(input: VNextCompileInput): CompiledVNextPolicy {
  const chainId = uint(input.chainId, "chainId");
  const factory = address(input.factory, "factory");
  const implementation = address(input.implementation, "implementation");
  const token = address(input.token, "token");
  const payer = address(input.payer, "payer");
  const operator = address(input.operator, "operator");
  const jobIdHash = bytes32(input.jobIdHash, "jobIdHash");
  const termsHash = bytes32(input.termsHash, "termsHash");
  const policyNonce = uint(input.policyNonce, "policyNonce");
  const acceptedPolicyDigest = bytes32(input.acceptedPolicyDigest, "acceptedPolicyDigest");
  const expiry = uint(input.expiry, "expiry");
  const fundingTime = uint(input.fundingTime, "fundingTime");
  const configs: readonly UnitConfig[] = input.units;
  if (!isArray(configs)) fail("BAD_INPUT", "units is not an array");

  if (configs.length === 0 || configs.length > VNEXT.MAX_SETTLEMENT_UNITS) {
    fail("BAD_UNIT_COUNT", `${configs.length} units (1..${VNEXT.MAX_SETTLEMENT_UNITS})`);
  }
  let totalLegs = 0;
  let totalGross = 0n;
  const seen = new Set<string>();
  configs.forEach((c, i) => {
    checkUnitConfig(c, i);
    totalLegs += c.payouts.length;
    totalGross += c.g;
    // Duplicate (milestoneIndex, stepId) means a duplicate unit id at any escrow address.
    const key = `${c.milestoneIndex}:${c.stepId.toLowerCase()}`;
    if (seen.has(key)) fail("DUPLICATE_UNIT", `units[${i}] repeats (milestoneIndex, stepId)`);
    seen.add(key);
    const delay = c.reclaimAt - fundingTime;
    if (c.reclaimAt <= fundingTime || delay < VNEXT.MIN_RECLAIM_DELAY || delay > VNEXT.MAX_RECLAIM_DELAY) {
      fail("BAD_RECLAIM", `units[${i}]: reclaimAt must be fundingTime + [10 days, 365 days]`);
    }
    // fund() then narrows it: `u.reclaimAt = toUint64(c.reclaimAt)` (VNextSettlementEscrow.sol:825).
    if (c.reclaimAt > VNEXT.MAX_RECLAIM_AT) fail("VALUE_OVERFLOW", `units[${i}]: reclaimAt does not fit uint64`);
  });
  if (totalLegs > VNEXT.MAX_TOTAL_LEGS_PER_JOB) fail("TOO_MANY_LEGS", `${totalLegs} payout legs in the job`);
  if (fundingTime > expiry) fail("POLICY_EXPIRED", "the acceptance expires before the funding time");

  // initialize(): the payer is nonzero; the operator is an allowed recipient and not the payer.
  if (same(payer, zeroAddress)) fail("FORBIDDEN_RECIPIENT", "payer is 0x0");
  if (same(operator, payer)) fail("PARTY_COLLISION", "operator == payer");

  const root = prePolicyRoot(configs);
  const identity: PolicyIdentity = {
    payer,
    operator,
    jobIdHash,
    termsHash,
    policyNonce,
    prePolicyRoot: root,
    acceptedPolicyDigest,
  };
  const salt = policySalt(identity);
  const escrow = predictEscrow({ factory, implementation, salt });

  const ctx = { escrow, token, factory };
  requireAllowedRecipient(operator, ctx, "operator");
  configs.forEach((c, i) => {
    c.payouts.forEach((p, j) => requireAllowedRecipient(p.recipient, ctx, `units[${i}].payouts[${j}].recipient`));
    if (c.feeBps > 0) requireAllowedRecipient(c.feeRecipient, ctx, `units[${i}].feeRecipient`);
  });

  const unitIds = configs.map((c) =>
    settlementUnitId({ chainId, escrow, jobIdHash, milestoneIndex: c.milestoneIndex, stepId: c.stepId }),
  );
  const uRoot = unitsRoot(unitIds);
  const fields: JobPolicyFields = {
    chainId,
    factory,
    implementation,
    escrow,
    payer,
    operator,
    jobIdHash,
    termsHash,
    policyNonce,
    prePolicyRoot: root,
    unitsRoot: uRoot,
    expiry,
    acceptedPolicyDigest,
  };
  const policyHash = jobPolicyHash(fields);
  const domainSep = domainSeparator(chainId, escrow);

  return {
    chainId,
    factory,
    implementation,
    token,
    fundingTime,
    configs,
    prePolicyRoot: root,
    identity,
    salt,
    escrow,
    unitIds,
    unitsRoot: uRoot,
    expiry,
    jobPolicyHash: policyHash,
    domainSeparator: domainSep,
    digest: acceptanceDigest(domainSep, policyHash),
    typedData: jobPolicyTypedData(fields),
    policyKey: policyKey(payer, operator, jobIdHash),
    perUnit: configs.map((c, i) => ({
      config: c,
      unitId: unitIds[i],
      feeScheduleHash: feeScheduleHash({
        chainId,
        escrow,
        settlementUnitId: unitIds[i],
        g: c.g,
        f: c.f,
        n: c.n,
        feeBps: c.feeBps,
        feeRecipient: c.feeRecipient,
      }),
      payoutConfigHash: payoutConfigHash(unitIds[i], c.payouts),
    })),
    totalGross,
  };
}

/**
 * Refuse an acceptance the escrow would refuse on its SHAPE: an oversized signature (`SignatureTooLarge`),
 * or, when `ctx` names the sender, a missing payer signature from anyone other than the payer
 * (`OnlyPayer`). Whether a signature is VALID for its signer is a live question (EOA vs ERC-1271, with
 * the clone as the caller); `preflightVNextFunding` answers it by simulating `fund()`.
 */
export function checkAcceptance(
  acceptance: PolicyAcceptance,
  ctx?: { sender: Address; payer: Address },
): PolicyAcceptance {
  uint(acceptance.expiry, "acceptance.expiry");
  for (const [what, sig] of [
    ["payerSignature", acceptance.payerSignature],
    ["operatorSignature", acceptance.operatorSignature],
  ] as const) {
    if (typeof sig !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(sig)) fail("BAD_INPUT", `${what} is not hex bytes`);
    if ((sig.length - 2) / 2 > VNEXT.MAX_SIGNATURE_BYTES) {
      fail("SIGNATURE_TOO_LARGE", `${what} exceeds ${VNEXT.MAX_SIGNATURE_BYTES} bytes`);
    }
  }
  if (ctx) {
    const sender = address(ctx.sender, "sender");
    const payer = address(ctx.payer, "payer");
    if (!same(sender, payer) && acceptance.payerSignature.length <= 2) {
      fail("ONLY_PAYER", "a sender other than the payer must carry the payer's signature");
    }
  }
  return acceptance;
}
