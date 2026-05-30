/**
 * MilestoneEscrowV2 ABI — hand-authored from MilestoneEscrowV2.sol
 *
 * Authored by implementer-alpha — EAS attestation-bridge migration (deliverable 4).
 *
 * V2 of the PCC milestone escrow. Identical to MilestoneEscrow except the
 * release-gating attestation step reads a REAL on-chain EAS attestation by UID
 * and validates its provenance + payload (see MilestoneEscrowV2.sol §submitAttestation).
 *
 * Differences from MilestoneEscrowABI (relevant to gateway/escrow-client wiring):
 *   - constructor takes 3 extra args: _eas (address), _schemaUid (bytes32), _oracle (address)
 *   - getMilestone() tuple gains 3 fields: requiredTier (uint8), jobIdHash (bytes32),
 *     verifierAttestationUid (bytes32)
 *   - NEW getters: eas() -> address, authorizedOracle() -> address,
 *     PCC_EVIDENCE_SCHEMA_UID() -> bytes32
 *   - addMilestone / addMilestoneWithToken gain (_requiredTier uint8, _jobId string)
 *   - submitAttestation(uint256 milestoneIndex, bytes32 easUid) — same wire signature as V1
 *     (uint256,bytes32) but the bytes32 is now the EAS UID, not a free-form hash
 *   - AttestationSubmitted event's 2nd arg is named `attestationUid` (was `attestationHash`)
 */
export const MilestoneEscrowV2ABI = [
  // Constructor
  {
    type: "constructor",
    inputs: [
      { name: "_payer", type: "address" },
      { name: "_arbiter", type: "address" },
      { name: "_token", type: "address" },
      { name: "_cwmId", type: "bytes32" },
      { name: "_protocolRoot", type: "address" },
      { name: "_eas", type: "address" },
      { name: "_schemaUid", type: "bytes32" },
      { name: "_oracle", type: "address" },
    ],
    stateMutability: "nonpayable",
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

  // ── EAS wiring getters (NEW in V2) ─────────────────────────────────

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
    name: "PCC_EVIDENCE_SCHEMA_UID",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
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
    // V2: the bytes32 arg is the EAS attestation UID (validated on-chain against EAS).
    // Wire signature is unchanged from V1 — submitAttestation(uint256,bytes32).
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
    name: "release",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "milestoneIndex", type: "uint256" }],
    outputs: [],
  },

  // ── Verifier management (retained for ABI/back-compat) ─────────────

  {
    name: "authorizedVerifiers",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "addVerifier",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "verifier", type: "address" }],
    outputs: [],
  },
  {
    name: "removeVerifier",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "verifier", type: "address" }],
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

  // ── Events ─────────────────────────────────────────────────────────

  // ── PGTR Forwarder events ─────────────────────────────────────────

  {
    name: "ForwarderAdded",
    type: "event",
    inputs: [
      { name: "forwarder", type: "address", indexed: true },
    ],
  },
  {
    name: "ForwarderRemoved",
    type: "event",
    inputs: [
      { name: "forwarder", type: "address", indexed: true },
    ],
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
    // V2: 2nd arg carries the EAS attestation UID (was the raw attestation hash in V1).
    name: "AttestationSubmitted",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "attestationUid", type: "bytes32", indexed: false },
      { name: "challengeWindowEnd", type: "uint256", indexed: false },
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
    inputs: [
      { name: "token", type: "address", indexed: true },
    ],
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

/** Milestone status enum matching Solidity (identical to V1). */
export const MilestoneStatusV2 = {
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

export type MilestoneStatusV2Name = keyof typeof MilestoneStatusV2;

export function milestoneStatusV2Name(status: number): MilestoneStatusV2Name {
  const names = Object.entries(MilestoneStatusV2);
  const match = names.find(([, v]) => v === status);
  return match ? (match[0] as MilestoneStatusV2Name) : "Unfunded";
}
