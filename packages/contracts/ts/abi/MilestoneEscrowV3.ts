/**
 * MilestoneEscrowV3 ABI — hand-authored from MilestoneEscrowV3.sol
 *
 * V3 of the PCC milestone escrow. A duplicate of MilestoneEscrowV2 with three
 * behavioral changes (see MilestoneEscrowV3.sol header for the full rationale):
 *
 *   (1) FEE-FROM-ATTESTATION. `submitAttestation` decodes `feeBps` (uint16) and
 *       `feeRecipient` (address) from the `pcc.evidence.v2` EAS payload (the V1
 *       7-field tuple plus those two trailing fields), stores them on the
 *       milestone, and `release()` uses them instead of root.protocolFeeBps.
 *       A hard cap `MAX_FEE_BPS() == 1000` (10%) is enforced at submission.
 *
 *   (2) MODE-A PAYER-APPROVAL RELEASE. New `approveAndRelease(uint256)` callable
 *       ONLY by the payer (buyer). User-verifiable evidence path: no oracle
 *       attestation, no challenge window, no fee. Emits `PayerApprovedRelease`.
 *
 *   (3) ADDITIVE — the oracle-attested path (Mode B: submitAttestation →
 *       challenge window → release) and disputes (Mode C) are inherited from V2.
 *
 * Differences from MilestoneEscrowV2ABI (relevant to gateway/escrow-client wiring):
 *   - clone/initialize pattern: constructor is (address _eas, bytes32 _schemaUid,
 *     address _oracle); per-escrow config moves to initialize(payer, arbiter,
 *     token, cwmId, protocolRoot).
 *   - getMilestone() tuple gains 2 fields: attestedFeeBps (uint16),
 *     attestedFeeRecipient (address).
 *   - AttestationSubmitted event gains attestedFeeBps (uint16) + attestedFeeRecipient
 *     (address) — every fee parameter is replayable from logs alone.
 *   - NEW function approveAndRelease(uint256) + NEW event PayerApprovedRelease.
 *   - NEW getter MAX_FEE_BPS() -> uint16.
 *   - schema-UID getter is named PCC_EVIDENCE_V2_SCHEMA_UID() (V2 gates on
 *     pcc.evidence.v1 via PCC_EVIDENCE_SCHEMA_UID(); V3 gates on pcc.evidence.v2).
 *
 * DRAFT status (mirrors the .sol): NOT DEPLOYED. No V3 factory/address ships
 * yet; this ABI is published so the gateway can encode V3 calldata (Mode A
 * payer-approval, Mode B attestation/release) against the real interface instead
 * of a hand-rolled stub. Everything is additive — V1/V2 ABIs are untouched.
 */
export const MilestoneEscrowV3ABI = [
  // Constructor (implementation only — clones use initialize)
  {
    type: "constructor",
    inputs: [
      { name: "_eas", type: "address" },
      { name: "_schemaUid", type: "bytes32" },
      { name: "_oracle", type: "address" },
    ],
    stateMutability: "nonpayable",
  },

  // ── Initializer (clones only) ──────────────────────────────────────

  {
    name: "initialize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_payer", type: "address" },
      { name: "_arbiter", type: "address" },
      { name: "_token", type: "address" },
      { name: "_cwmId", type: "bytes32" },
      { name: "_protocolRoot", type: "address" },
    ],
    outputs: [],
  },

  // ── Views ──────────────────────────────────────────────────────────

  {
    name: "payer",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "arbiter",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "token",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "cwmId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "protocolRoot",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "funded",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "totalAmount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },

  // ── EAS wiring getters (immutables) ────────────────────────────────

  {
    name: "eas",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "authorizedOracle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    // V3 gates on the pcc.evidence.v2 schema (V2 used PCC_EVIDENCE_SCHEMA_UID for v1).
    name: "PCC_EVIDENCE_V2_SCHEMA_UID",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    // SECURITY (review C1): true once an EAS UID has released a milestone in this escrow.
    name: "attestationUsed",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "easUid", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "MAX_ASSURANCE_TIER",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    // V3: hard upper bound on the attested protocol fee (1000 = 10%).
    name: "MAX_FEE_BPS",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },

  {
    name: "getMilestoneCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getMilestone",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "idx", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "stepId", type: "bytes32" },
          { name: "operator", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "operatorBond", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "evidenceBundleHash", type: "bytes32" },
          { name: "verifierAttestationHash", type: "bytes32" },
          { name: "challengeWindowEnd", type: "uint256" },
          { name: "challengeWindowSeconds", type: "uint256" },
          // ── V2 additions ──
          { name: "requiredTier", type: "uint8" },
          { name: "jobIdHash", type: "bytes32" },
          { name: "verifierAttestationUid", type: "bytes32" },
          // ── V3 additions (fee-from-attestation) ──
          { name: "attestedFeeBps", type: "uint16" },
          { name: "attestedFeeRecipient", type: "address" },
        ],
      },
    ],
  },
  {
    name: "getDispute",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "idx", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "challenger", type: "address" },
          { name: "challengerBond", type: "uint256" },
          { name: "challengerEvidenceHash", type: "bytes32" },
          { name: "reason", type: "string" },
          { name: "resolved", type: "bool" },
          { name: "challengerWon", type: "bool" },
        ],
      },
    ],
  },

  // ── Multi-stablecoin views ───────────────────────────────────────

  {
    name: "isStablecoinAllowed",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getReserveTokens",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "tokenForMilestone",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "milestoneIndex", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },

  // ── PGTR Forwarder views ─────────────────────────────────────────

  {
    name: "trustedForwarders",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },

  // ── PGTR Forwarder management ───────────────────────────────────

  {
    name: "addForwarder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "forwarder", type: "address" }],
    outputs: [],
  },
  {
    name: "removeForwarder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "forwarder", type: "address" }],
    outputs: [],
  },

  // ── Multi-stablecoin management ──────────────────────────────────

  {
    name: "allowStablecoin",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_token", type: "address" },
      { name: "_attestor", type: "address" },
      { name: "_reportUri", type: "string" },
      { name: "_maxDeviationBps", type: "uint16" },
    ],
    outputs: [],
  },
  {
    name: "revokeStablecoin",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_token", type: "address" }],
    outputs: [],
  },

  // ── State-changing ─────────────────────────────────────────────────

  {
    name: "addMilestone",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_stepId", type: "bytes32" },
      { name: "_operator", type: "address" },
      { name: "_amount", type: "uint256" },
      { name: "_operatorBond", type: "uint256" },
      { name: "_challengeWindowSeconds", type: "uint256" },
      { name: "_requiredTier", type: "uint8" },
      { name: "_jobId", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "addMilestoneWithToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_stepId", type: "bytes32" },
      { name: "_operator", type: "address" },
      { name: "_amount", type: "uint256" },
      { name: "_operatorBond", type: "uint256" },
      { name: "_challengeWindowSeconds", type: "uint256" },
      { name: "_requiredTier", type: "uint8" },
      { name: "_jobId", type: "string" },
      { name: "_token", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "fund",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "depositBond",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "milestoneIndex", type: "uint256" }],
    outputs: [],
  },
  {
    name: "submitEvidence",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneIndex", type: "uint256" },
      { name: "_evidenceBundleHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    // Mode B (oracle-attested): the bytes32 is the pcc.evidence.v2 EAS UID. The
    // contract decodes (string,bytes32,bytes32,string,uint8,bool,bytes32,uint16,address)
    // from the attestation data and stores the trailing feeBps/feeRecipient.
    name: "submitAttestation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneIndex", type: "uint256" },
      { name: "easUid", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    // Mode B release — fee math reads the attested feeBps/feeRecipient (not root state).
    name: "release",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "milestoneIndex", type: "uint256" }],
    outputs: [],
  },
  {
    // Mode A (NEW in V3): payer signs off without oracle attestation. No fee,
    // no challenge window. Callable ONLY by the payer (PGTR-forwarder-aware).
    name: "approveAndRelease",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "milestoneIndex", type: "uint256" }],
    outputs: [],
  },

  // ── splitPayout views (ADR-11) ───────────────────────────────────

  {
    name: "MAX_PAYOUTS",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "MAX_SINGLE_BPS",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "payoutMapSet",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getPayoutMap",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "milestoneIndex", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "recipient", type: "address" },
          { name: "bps", type: "uint256" },
          { name: "roleTag", type: "bytes32" },
          { name: "ipId", type: "bytes32" },
        ],
      },
    ],
  },

  // ── splitPayout state-changing (ADR-11) ──────────────────────────

  {
    name: "setPayoutMap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneIndex", type: "uint256" },
      {
        name: "payouts",
        type: "tuple[]",
        components: [
          { name: "recipient", type: "address" },
          { name: "bps", type: "uint256" },
          { name: "roleTag", type: "bytes32" },
          { name: "ipId", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: "fileDispute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneIndex", type: "uint256" },
      { name: "_challengerBond", type: "uint256" },
      { name: "_challengerEvidenceHash", type: "bytes32" },
      { name: "_reason", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "resolveDispute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneIndex", type: "uint256" },
      { name: "_challengerWon", type: "bool" },
    ],
    outputs: [],
  },

  // ── Errors ─────────────────────────────────────────────────────────

  {
    type: "error",
    name: "AlreadyInitialized",
    inputs: [],
  },

  // ── Events ─────────────────────────────────────────────────────────

  // ── PGTR Forwarder events ─────────────────────────────────────────

  {
    name: "ForwarderAdded",
    type: "event",
    inputs: [{ name: "forwarder", type: "address", indexed: true }],
  },
  {
    name: "ForwarderRemoved",
    type: "event",
    inputs: [{ name: "forwarder", type: "address", indexed: true }],
  },

  // ── Original events ─────────────────────────────────────────────

  {
    name: "EscrowFunded",
    type: "event",
    inputs: [
      { name: "cwmId", type: "bytes32", indexed: true },
      { name: "totalAmount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "MilestoneLocked",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "stepId", type: "bytes32", indexed: false },
    ],
  },
  {
    name: "EvidenceSubmitted",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "evidenceBundleHash", type: "bytes32", indexed: false },
    ],
  },
  {
    // V3: carries the attested fee parameters so auditors can replay the fee
    // math from logs alone (attestedFeeBps + attestedFeeRecipient are new).
    name: "AttestationSubmitted",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "attestationUid", type: "bytes32", indexed: false },
      { name: "challengeWindowEnd", type: "uint256", indexed: false },
      { name: "attestedFeeBps", type: "uint16", indexed: false },
      { name: "attestedFeeRecipient", type: "address", indexed: false },
    ],
  },
  {
    name: "MilestoneReleased",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "operator", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    // Mode A (NEW in V3): distinct from MilestoneReleased so off-chain tooling
    // can separate user-attested from oracle-attested settlements. No fee taken.
    name: "PayerApprovedRelease",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "approvedBy", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "DisputeFiled",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "challenger", type: "address", indexed: false },
      { name: "bond", type: "uint256", indexed: false },
    ],
  },
  {
    name: "DisputeResolved",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "challengerWon", type: "bool", indexed: false },
    ],
  },
  {
    name: "MilestoneRefunded",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "BondSlashed",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "slashedParty", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },

  // ── splitPayout events (ADR-11) ──────────────────────────────────

  {
    name: "PayoutMapSet",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "payoutCount", type: "uint256", indexed: false },
      { name: "totalBps", type: "uint256", indexed: false },
    ],
  },
  {
    name: "SplitPayoutExecuted",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "roleTag", type: "bytes32", indexed: true },
      { name: "ipId", type: "bytes32", indexed: false },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },

  // ── Multi-stablecoin events ──────────────────────────────────────

  {
    name: "StablecoinAllowed",
    type: "event",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "attestor", type: "address", indexed: true },
      { name: "reportUri", type: "string", indexed: false },
      { name: "maxDeviationBps", type: "uint16", indexed: false },
    ],
  },
  {
    name: "StablecoinRevoked",
    type: "event",
    inputs: [{ name: "token", type: "address", indexed: true }],
  },
  {
    name: "MilestoneAdded",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "stepId", type: "bytes32", indexed: false },
      { name: "operator", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "operatorBond", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Milestone status enum matching Solidity (identical to V1/V2). */
export const MilestoneStatusV3 = {
  Unfunded: 0,
  Funded: 1,
  Locked: 2,
  Evidenced: 3,
  Attested: 4,
  Released: 5,
  Disputed: 6,
  Refunded: 7,
  Slashed: 8,
} as const;

export type MilestoneStatusV3Name = keyof typeof MilestoneStatusV3;

export function milestoneStatusV3Name(status: number): MilestoneStatusV3Name {
  const names = Object.entries(MilestoneStatusV3);
  const match = names.find(([, v]) => v === status);
  return match ? (match[0] as MilestoneStatusV3Name) : "Unfunded";
}

/**
 * Hard upper bound on the attested protocol fee enforced by
 * MilestoneEscrowV3.submitAttestation (`require(attestedFeeBps <= MAX_FEE_BPS)`).
 * 1000 bps = 10%. The gateway mirrors this off-chain so it never mints a
 * pcc.evidence.v2 attestation the contract would reject. Single source of truth
 * shared by the contract (constant) and the gateway (oracle-client guard).
 */
export const MAX_FEE_BPS_V3 = 1000 as const;

/**
 * The canonical `pcc.evidence.v2` EAS schema string MilestoneEscrowV3 gates on.
 *
 * Field order is LOAD-BEARING — it must match the contract's
 *   abi.decode(a.data, (string, bytes32, bytes32, string, uint8, bool, bytes32, uint16, address))
 * in MilestoneEscrowV3.submitAttestation. It is V1's 7-field schema plus the two
 * trailing fee fields (feeBps, feeRecipient). The gateway's oracle-client mirrors
 * this exact string; a parity test asserts the two never drift.
 */
export const PCC_EVIDENCE_SCHEMA_V2 =
  "string jobId, bytes32 kernelId, bytes32 evidenceBundleHash, string ipfsCid, uint8 assuranceTier, bool oracleVerified, bytes32 stepId, uint16 feeBps, address feeRecipient" as const;
