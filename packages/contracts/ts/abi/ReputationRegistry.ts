/**
 * ReputationRegistry ABI — generated from ReputationRegistry.sol
 */
export const ReputationRegistryABI = [
  {
    type: "constructor",
    inputs: [{ name: "_identityRegistry", type: "address" }],
    stateMutability: "nonpayable",
  },

  // Views
  { name: "admin", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    name: "identityRegistry",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "authorizedAttesters",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getReputation",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "entityId", type: "uint256" }],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "entityId", type: "uint256" },
        { name: "score", type: "uint256" },
        { name: "totalJobs", type: "uint256" },
        { name: "successfulJobs", type: "uint256" },
        { name: "disputesWon", type: "uint256" },
        { name: "disputesLost", type: "uint256" },
        { name: "lastUpdated", type: "uint256" },
      ],
    }],
  },
  {
    name: "getScore",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "entityId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },

  // State-changing
  {
    name: "authorizeAttester",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_attester", type: "address" }],
    outputs: [],
  },
  {
    name: "revokeAttester",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_attester", type: "address" }],
    outputs: [],
  },
  {
    name: "recordJobCompletion",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "entityId", type: "uint256" },
      { name: "bonus", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "recordDisputeOutcome",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "entityId", type: "uint256" },
      { name: "won", type: "bool" },
    ],
    outputs: [],
  },
  {
    name: "recordSlash",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "entityId", type: "uint256" },
      { name: "penalty", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "setReputation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "entityId", type: "uint256" },
      { name: "score", type: "uint256" },
    ],
    outputs: [],
  },

  // Events
  {
    name: "ReputationUpdated",
    type: "event",
    inputs: [
      { name: "entityId", type: "uint256", indexed: true },
      { name: "oldScore", type: "uint256", indexed: false },
      { name: "newScore", type: "uint256", indexed: false },
      { name: "reason", type: "string", indexed: false },
    ],
  },
  {
    name: "AttesterAuthorized",
    type: "event",
    inputs: [{ name: "attester", type: "address", indexed: true }],
  },
  {
    name: "AttesterRevoked",
    type: "event",
    inputs: [{ name: "attester", type: "address", indexed: true }],
  },
] as const;
