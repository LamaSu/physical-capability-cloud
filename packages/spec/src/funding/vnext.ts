/**
 * The V-next encodings the buyer-funding SDK RECOMPUTES to check a gateway's prepare payload. Author:
 * implementer-bravo (pcc-adk).
 *
 * Byte contract: docs/VNEXT_SETTLEMENT_ABI.md §1-§3 (frozen at master ac86a404). The canonical encoder is
 * `@pcc/contracts/vnext`, but that package is private and this module must stay viem-only so it can move into
 * `@pcc/adk` unchanged. So this is a second implementation, used ONLY to verify (recompute, compare, refuse on
 * any difference), never to decide bytes the gateway did not also produce. Drift is caught by:
 *   - `__tests__/vnext-golden.test.ts`: every function here reproduces the committed clean-room golden vectors
 *     (packages/contracts/test/fixtures/vnext-golden/vnext-golden-vectors.json), which `VNextAbiFreeze.t.sol`
 *     and `vnext-compiler.test.ts` pin against the real contracts and the canonical compiler;
 *   - the anvil e2e (packages/contracts/ts/__tests__/buyer-funding.anvil.test.ts), where the canonical compiler
 *     builds the payload, this module verifies it, and the real contracts fund it.
 * Pure: no I/O, no clock.
 */
import {
  concat,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

const k = (preimage: string): Hex => keccak256(stringToHex(preimage));

/** The compiler's `jobIdHash` convention: keccak256 of the canonical job id's UTF-8 bytes. */
export function jobIdHashOf(jobId: string): Hex {
  return keccak256(stringToHex(jobId));
}

/** ABI doc §1. */
export const SETTLEMENT_UNIT_DOMAIN = k("PCC:vnext:settlement-unit:v1");
export const POLICY_SALT_DOMAIN = k("PCC:vnext:policy-salt:v2");
export const POLICY_NONCE_DOMAIN = k("PCC:vnext:policy-nonce:v1");
export const EIP712_DOMAIN_TYPEHASH = k("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
export const EIP712_NAME = "VNextSettlementEscrow";
export const EIP712_VERSION = "1";
export const JOB_POLICY_TYPEHASH = k(
  "JobPolicy(uint256 chainId,address factory,address implementation,address escrow,uint256 policyVersion,address payer,address operator,bytes32 jobIdHash,bytes32 termsHash,uint256 policyNonce,bytes32 prePolicyRoot,bytes32 unitsRoot,uint256 expiry,bytes32 acceptedPolicyDigest)",
);
/** `VNextSettlementLib.POLICY_VERSION_V2`. */
export const POLICY_VERSION = 2n;
/** 10 days: `VNextSettlementLib.MIN_RECLAIM_DELAY` (challenge 2 d + appeal 5 d + backup 2 d + 1 d). */
export const MIN_RECLAIM_DELAY = 864_000n;
/** 365 days: `VNextSettlementLib.MAX_RECLAIM_DELAY`. */
export const MAX_RECLAIM_DELAY = 31_536_000n;
/** `VNextSettlementLib.MAX_SETTLEMENT_UNITS` / `MAX_PAYOUT_LEGS_PER_UNIT`, used here as input bounds. */
export const MAX_UNITS = 16;
export const MAX_PAYOUT_LEGS = 16;
/** `VNextSettlementLib.ECDSA_S_MAX` (secp256k1n / 2): the factory rejects a higher `s`. */
export const ECDSA_S_MAX = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
/** `UnitState.FUNDED_ACTIVE`. */
export const UNIT_FUNDED_ACTIVE = 1;

/**
 * EIP-1167 as the factory's Clones.sol builds it (its line 23). The 10-byte creation code copies the 45 bytes after
 * it (0x2d bytes from offset 0x0a) and returns them as the clone's runtime, which delegates every call to `impl`:
 *   363d3d373d3d3d363d73 ‖ impl ‖ 5af43d82803e903d91602b57fd5bf3
 */
const EIP1167_CREATION: Hex = "0x3d602d80600a3d3981f3";
const EIP1167_RUNTIME_PREFIX: Hex = "0x363d3d373d3d3d363d73";
const EIP1167_SUFFIX: Hex = "0x5af43d82803e903d91602b57fd5bf3";

/** The JobPolicy struct's fields, in order (ABI doc §1 `JOB_POLICY_TYPEHASH`). */
export const JOB_POLICY_FIELDS = [
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
] as const;

export interface PayoutEntry {
  recipient: Address;
  amount: bigint;
}

/** `VNextSettlementEscrow.UnitConfig`, field for field (ABI doc §2). */
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

/**
 * The JobPolicy message: what both parties sign (ABI doc §3 step 6). A type alias, not an interface, so it is
 * assignable to viem's `Record<string, unknown>` typed-data message.
 */
export type JobPolicyMessage = {
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

/** The policy as EIP-712 typed data, in viem's form (no `EIP712Domain` entry: it is derived from `domain`). */
export interface JobPolicyTypedData {
  domain: { name: string; version: string; chainId: bigint; verifyingContract: Address };
  types: { JobPolicy: ReadonlyArray<{ name: string; type: string }> };
  primaryType: "JobPolicy";
  message: JobPolicyMessage;
}

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
    {
      name: "payouts",
      type: "tuple[]",
      components: [
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
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

/** ABI doc §3 step 1: keccak256(abi.encode(UnitConfig[])), with the leading 0x20 offset word. Order-sensitive. */
export function prePolicyRoot(configs: readonly UnitConfig[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [UNIT_CONFIGS_PARAM],
      [configs.map((c) => ({ ...c, payouts: c.payouts.map((p) => ({ recipient: p.recipient, amount: p.amount })) }))],
    ),
  );
}

/** ABI doc §3 step 2: the CREATE2 salt over the whole policy identity. */
export function policySalt(id: {
  payer: Address;
  operator: Address;
  jobIdHash: Hex;
  termsHash: Hex;
  policyNonce: bigint;
  prePolicyRoot: Hex;
  acceptedPolicyDigest: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(SALT_PARAMS, [
      POLICY_SALT_DOMAIN,
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

/** The runtime code at an EIP-1167 clone of `implementation` (45 bytes); pinned to the golden init code by the golden test. */
export function cloneRuntimeCode(implementation: Address): Hex {
  return concat([EIP1167_RUNTIME_PREFIX, implementation, EIP1167_SUFFIX]);
}

/** keccak256 of the EIP-1167 creation code for a clone of `implementation` (ABI doc §3 step 3). */
export function cloneInitCodeHash(implementation: Address): Hex {
  return keccak256(concat([EIP1167_CREATION, cloneRuntimeCode(implementation)]));
}

/** ABI doc §3 step 3: the address `factory.predictEscrow(identity)` returns (FAC:390-392). */
export function predictEscrow(factory: Address, implementation: Address, salt: Hex): Address {
  return getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecodeHash: cloneInitCodeHash(implementation) });
}

/** ABI doc §3 step 4. */
export function settlementUnitId(p: { chainId: bigint; escrow: Address; jobIdHash: Hex; milestoneIndex: bigint; stepId: Hex }): Hex {
  return keccak256(
    encodeAbiParameters(UNIT_ID_PARAMS, [SETTLEMENT_UNIT_DOMAIN, p.chainId, p.escrow, p.jobIdHash, p.milestoneIndex, p.stepId]),
  );
}

/** ABI doc §3 step 5: r = 0; r = keccak256(abi.encode(r, id)) for each unit id, in funding order. */
export function unitsRoot(unitIds: readonly Hex[]): Hex {
  let r: Hex = zeroHash;
  for (const id of unitIds) r = keccak256(encodeAbiParameters(PAIR_PARAMS, [r, id]));
  return r;
}

/** ABI doc §3 step 6: the EIP-712 struct hash of JobPolicy (FAC:299-329). */
export function jobPolicyHash(m: JobPolicyMessage): Hex {
  return keccak256(
    encodeAbiParameters(JOB_POLICY_PARAMS, [
      JOB_POLICY_TYPEHASH,
      m.chainId,
      m.factory,
      m.implementation,
      m.escrow,
      m.policyVersion,
      m.payer,
      m.operator,
      m.jobIdHash,
      m.termsHash,
      m.policyNonce,
      m.prePolicyRoot,
      m.unitsRoot,
      m.expiry,
      m.acceptedPolicyDigest,
    ]),
  );
}

/** ABI doc §3 step 7: the CLONE's domain; `verifyingContract` is the escrow, not the factory (FAC:333-343). */
export function domainSeparator(chainId: bigint, escrow: Address): Hex {
  return keccak256(
    encodeAbiParameters(DOMAIN_PARAMS, [
      EIP712_DOMAIN_TYPEHASH,
      k(EIP712_NAME),
      k(EIP712_VERSION),
      chainId,
      escrow,
    ]),
  );
}

/** ABI doc §3 step 8: keccak256(0x1901 ‖ domainSeparator ‖ jobPolicyHash) (FAC:250). */
export function acceptanceDigest(domainSep: Hex, structHash: Hex): Hex {
  return keccak256(concat(["0x1901", domainSep, structHash]));
}

/** The policy as typed data; viem's `hashTypedData` of it equals {@link acceptanceDigest} (pinned by the golden test). */
export function jobPolicyTypedData(m: JobPolicyMessage): JobPolicyTypedData {
  return {
    domain: { name: EIP712_NAME, version: EIP712_VERSION, chainId: m.chainId, verifyingContract: m.escrow },
    types: { JobPolicy: JOB_POLICY_FIELDS.map((f) => ({ name: f.name, type: f.type })) },
    primaryType: "JobPolicy",
    message: { ...m },
  };
}

/** ABI doc §3: the (payer, operator, job) scope of `policyNonceFloor` and `fundedEscrowOf`. */
export function policyKey(payer: Address, operator: Address, jobIdHash: Hex): Hex {
  return keccak256(encodeAbiParameters(POLICY_KEY_PARAMS, [POLICY_NONCE_DOMAIN, payer, operator, jobIdHash]));
}

/** The only token calls the SDK makes: `approve` (send), `allowance` (read-back). */
export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/** Factory reads (FAC:34, 54, 146). `predictEscrow`'s selector is pinned to the golden vector (0xa5b0de55). */
export const FACTORY_ABI = parseAbi([
  "struct PolicyIdentity { address payer; address operator; bytes32 jobIdHash; bytes32 termsHash; uint256 policyNonce; bytes32 prePolicyRoot; bytes32 acceptedPolicyDigest; }",
  "function implementation() view returns (address)",
  "function predictEscrow(PolicyIdentity p) view returns (address)",
  "function fundedEscrowOf(bytes32 policyKey) view returns (address)",
]);

/**
 * The escrow calls the SDK makes, plus every custom error the `fund()` path can raise (copied from
 * `@pcc/contracts/vnext`'s abi.ts), so a simulation names its revert. `fund`'s selector is pinned to the golden
 * vector (0x7976bcc7) by the golden test.
 */
export const ESCROW_ABI = parseAbi([
  "struct PayoutEntry { address recipient; uint256 amount; }",
  "struct UnitConfig { uint256 milestoneIndex; bytes32 stepId; uint8 requiredTier; uint8 requestedTier; uint256 g; uint256 f; uint256 n; uint16 feeBps; address feeRecipient; uint256 reclaimAt; uint16 compositionSchemaVersion; bytes32 compositionRoot; PayoutEntry[] payouts; }",
  "struct PolicyAcceptance { uint256 expiry; bytes payerSignature; bytes operatorSignature; }",
  "function fund(UnitConfig[] configs, PolicyAcceptance acceptance)",
  "function policy() view returns (address operator_, uint256 policyNonce_, bytes32 prePolicyRoot_, bytes32 jobPolicyHash_, bytes32 acceptedPolicyDigest_)",
  "function unitCount() view returns (uint256)",
  "function unitIdAt(uint256 index) view returns (bytes32)",
  "function unitState(bytes32 unitId) view returns (uint8)",
  "function USDC() view returns (address)",
  "error NotInitialized()",
  "error AlreadySealed()",
  "error Reentrancy()",
  "error InvalidOrDisabledCohort()",
  "error BalanceReadFailed()",
  "error FundingDeltaMismatch()",
  "error PolicyNoLongerValid()",
  "error JobAlreadyFunded()",
  "error NotThePolicyEscrow()",
  "error SafeERC20FailedOperation(address token)",
  "error BadUnitCount()",
  "error BadLegCount()",
  "error TooManyLegs()",
  "error DuplicateUnit()",
  "error ZeroPayout()",
  "error PayoutSumMismatch()",
  "error ForbiddenRecipient()",
  "error BadReclaim()",
  "error PartyCollision()",
  "error PolicyRootMismatch()",
  "error PolicyExpired()",
  "error SignatureTooLarge()",
  "error ConfigTooLarge()",
  "error TierRequestMismatch()",
  "error TierOutOfRange()",
  "error ValueOverflow()",
  "error OnlyPayer()",
  "error BadSignature()",
  "error BadOperatorSignature()",
  "error NotActive()",
  "error UnitNotFound()",
]);
