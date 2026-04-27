/**
 * MilestoneEscrow ABI — generated from MilestoneEscrow.sol
 *
 * Escrow contract for PCC workflows. Holds funds per milestone,
 * releases after evidence + attestation + challenge window.
 */
export const MilestoneEscrowABI = [
  // Constructor
  {
    type: "constructor",
    inputs: [
      { name: "_payer", type: "address" },
      { name: "_arbiter", type: "address" },
      { name: "_token", type: "address" },
      { name: "_cwmId", type: "bytes32" },
      { name: "_protocolRoot", type: "address" },
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
    name: "submitAttestation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneIndex", type: "uint256" },
      { name: "_attestationHash", type: "bytes32" },
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
    name: "AttestationSubmitted",
    type: "event",
    inputs: [
      { name: "milestoneIndex", type: "uint256", indexed: true },
      { name: "attestationHash", type: "bytes32", indexed: false },
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
] as const;

/** Milestone status enum matching Solidity */
export const MilestoneStatus = {
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

export type MilestoneStatusName = keyof typeof MilestoneStatus;

export function milestoneStatusName(status: number): MilestoneStatusName {
  const names = Object.entries(MilestoneStatus);
  const match = names.find(([, v]) => v === status);
  return match ? (match[0] as MilestoneStatusName) : "Unfunded";
}
