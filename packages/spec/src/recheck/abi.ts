/** Standalone human-readable subset; no contracts dependency or viem runtime. */
export const KIT_ABI = Object.freeze({
  escrow: Object.freeze([
    "function settlement(bytes32 unitId) view returns (uint8 state_, uint64 assertedAt_, bytes32 acceptedAssertionId_, bool backupLane_, address challenger_, uint64 challengedAt_, uint256 bond_)",
    "function unitCounters(bytes32 unitId) view returns (uint256 liability_, uint256 payoutCount_, uint256 remainingClaimCount_)",
    "function unitTerms(bytes32 unitId) view returns (uint256 milestoneIndex_, bytes32 stepId_, uint8 requestedTier_, uint256 reclaimAt_, bytes32 payoutConfigHash_, uint16 compositionSchemaVersion_, bool evidenceCommitted_)",
    "function feeAmountsOf(bytes32 unitId) view returns (uint256 g_, uint256 f_, uint256 n_)",
    "function payoutAt(bytes32 unitId, uint256 index) view returns (address recipient, uint256 amount)",
    "function requiredTierOf(bytes32 unitId) view returns (uint8)",
    "function compositionRootOf(bytes32 unitId) view returns (bytes32)",
    "function unitExists(bytes32 unitId) view returns (bool)",
    "function emergencyAnchorOf(bytes32 unitId) view returns (uint256)",
    "function initialized() view returns (bool)",
    "function factory() view returns (address)",
    "function USDC() view returns (address)",
    "event Finalized(bytes32 indexed unitId, bool released, uint8 reason)",
    "event EscalationResolved(bytes32 indexed unitId, bytes32 indexed adjudicationId, uint8 role, bool upheld)",
    "event ReleaseAllocated(bytes32 indexed unitId, uint256 claimCount)",
    "event RefundAllocated(bytes32 indexed unitId, uint256 claimCount)",
    "event ClaimCreated(bytes32 indexed claimId, bytes32 indexed unitId, uint256 legIndex, uint8 class, address recipient, uint256 amount)",
    "event ClaimDischarged(bytes32 indexed claimId, bytes32 indexed unitId, address destination, uint256 amount)",
  ] as const),
  factory: Object.freeze([
    "function implementation() view returns (address)",
  ] as const),
});
