/**
 * The compiler-facing subset of the V-next settlement ABI: the functions a compiler, funder,
 * executor or reader calls on the path compile -> create -> fund -> read state -> settle.
 *
 * Hand-authored in viem's human-readable form. It is FROZEN by selector: every function selector
 * below is pinned to the same literal by `ts/__tests__/vnext-compiler.test.ts` (this ABI) and by
 * `test/VNextAbiFreeze.t.sol` (the real contracts), so a drifted signature fails CI on at least
 * one side. See `docs/VNEXT_SETTLEMENT_ABI.md` §7.
 */
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { VNEXT, VNextCompileError, checkAcceptance, type PolicyAcceptance, type UnitConfig } from "./compiler.js";

export const VNextSettlementEscrowFactoryABI = parseAbi([
  "struct PolicyIdentity { address payer; address operator; bytes32 jobIdHash; bytes32 termsHash; uint256 policyNonce; bytes32 prePolicyRoot; bytes32 acceptedPolicyDigest; }",
  "function createEscrow(PolicyIdentity p) returns (address escrow)",
  "function predictEscrow(PolicyIdentity p) view returns (address)",
  "function saltOf(PolicyIdentity p) pure returns (bytes32)",
  "function policyKey(address payer, address operator, bytes32 jobIdHash) pure returns (bytes32)",
  "function revokePolicy(address payer, address operator, bytes32 jobIdHash, uint256 uptoNonce)",
  "function implementation() view returns (address)",
  "function policyNonceFloor(bytes32 policyKey) view returns (uint256)",
  "function fundedEscrowOf(bytes32 policyKey) view returns (address)",
  "event EscrowCreated(address indexed escrow, address indexed payer, address indexed operator, bytes32 jobIdHash, uint256 policyNonce, bytes32 salt)",
]);

export const VNextSettlementEscrowABI = parseAbi([
  "struct PayoutEntry { address recipient; uint256 amount; }",
  "struct UnitConfig { uint256 milestoneIndex; bytes32 stepId; uint8 requiredTier; uint8 requestedTier; uint256 g; uint256 f; uint256 n; uint16 feeBps; address feeRecipient; uint256 reclaimAt; uint16 compositionSchemaVersion; bytes32 compositionRoot; PayoutEntry[] payouts; }",
  "struct PolicyAcceptance { uint256 expiry; bytes payerSignature; bytes operatorSignature; }",
  "function fund(UnitConfig[] configs, PolicyAcceptance acceptance)",
  "function policy() view returns (address operator_, uint256 policyNonce_, bytes32 prePolicyRoot_, bytes32 jobPolicyHash_, bytes32 acceptedPolicyDigest_)",
  "function unitState(bytes32 unitId) view returns (uint8)",
  "function unitCount() view returns (uint256)",
  "function unitIdAt(uint256 index) view returns (bytes32)",
  "function unitTerms(bytes32 unitId) view returns (uint256 milestoneIndex_, bytes32 stepId_, uint8 requestedTier_, uint256 reclaimAt_, bytes32 payoutConfigHash_, uint16 compositionSchemaVersion_, bool evidenceCommitted_)",
  "function feeScheduleHashOf(bytes32 unitId) view returns (bytes32)",
  "function payoutAt(bytes32 unitId, uint256 index) view returns (address recipient, uint256 amount)",
  "function submitEvidence(bytes32 unitId, bytes32 packageDigest)",
  "function finalize(bytes32 unitId)",
  "function reclaimAfterDeadline(bytes32 unitId)",
  "function dischargeClaim(bytes32 claimId)",
  "function payer() view returns (address)",
  "function operator() view returns (address)",
  "function jobIdHash() view returns (bytes32)",
  "function termsHash() view returns (bytes32)",
  "function factory() view returns (address)",
  "function initialized() view returns (bool)",
  "function configurationSealed() view returns (bool)",
  "function USDC() view returns (address)",
  "function authorizedOracle() view returns (address)",
  "function escalationAttester() view returns (address)",
  "event PolicyAccepted(bytes32 indexed jobPolicyHash, address indexed payer, address indexed operator, uint256 policyNonce, bytes32 unitsRoot)",
  "event UnitFunded(bytes32 indexed unitId, uint256 g, uint256 f, uint256 n)",
  "event Funded(uint256 unitCount, uint256 totalGross, uint256 totalPayoutLegs)",
  "event ReleaseAllocated(bytes32 indexed unitId, uint256 claimCount)",
  "event RefundAllocated(bytes32 indexed unitId, uint256 claimCount)",
  "event Finalized(bytes32 indexed unitId, bool released, uint8 reason)",
  "event BuyerApproved(bytes32 indexed unitId, uint256 approvalNonce)",
  "event EscalationResolved(bytes32 indexed unitId, bytes32 indexed adjudicationId, uint8 role, bool upheld)",
  "event ClaimDischarged(bytes32 indexed claimId, bytes32 indexed unitId, address destination, uint256 amount)",
  // EVERY revert reachable from fund(), including the factory's acceptPolicy, so a preflight simulation can
  // name any failure instead of printing a raw selector. The static ones are the reverts a compile pre-empts
  // (VNextCompileErrorCode names each); the live ones are what preflightVNextFunding surfaces. The V1 fee-schedule
  // invariants revert with Error(string) reasons ("V1: ..."), which decode without a declaration.
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
]);

/**
 * `Finalized(unitId, released, reason)` reason codes. Together with `EscalationResolved` (role 1 =
 * appeal, 2 = emergency; `upheld` = release) and `BuyerApproved` (release), they are the complete
 * set of outcome causes. See `docs/VNEXT_SETTLEMENT_ABI.md` §6.
 */
export const VNextFinalizedReason = {
  UNCONTESTED_RELEASE: 0,
  APPEAL_SILENCE_RELEASE: 1,
  BACKUP_NO_RELEASE: 2,
  EMERGENCY_SILENCE_REFUND: 3,
  DEADLINE_RECLAIM: 4,
} as const;

/** `EscalationResolved.role` values (O5Types.sol). */
export const VNextEscalationRole = { APPEAL: 1, EMERGENCY: 2 } as const;

/**
 * The complete `fund()` calldata, refused if the escrow would refuse it on size
 * (`SignatureTooLarge`, `ConfigTooLarge`). Compile the configs with `compileVNextPolicy` first.
 */
export function encodeFundCalldata(configs: readonly UnitConfig[], acceptance: PolicyAcceptance): Hex {
  checkAcceptance(acceptance);
  const data = encodeFunctionData({
    abi: VNextSettlementEscrowABI,
    functionName: "fund",
    args: [
      configs.map((c) => ({ ...c, payouts: c.payouts.map((p) => ({ recipient: p.recipient, amount: p.amount })) })),
      acceptance,
    ],
  });
  if ((data.length - 2) / 2 > VNEXT.MAX_CONFIG_BYTES) {
    throw new VNextCompileError("CONFIG_TOO_LARGE", `fund() calldata exceeds ${VNEXT.MAX_CONFIG_BYTES} bytes`);
  }
  return data;
}
