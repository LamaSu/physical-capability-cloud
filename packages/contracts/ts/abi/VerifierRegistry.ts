/**
 * VerifierRegistry ABI — generated from VerifierRegistry.sol
 *
 * Stake-based registry for human verifiers in the PCC network.
 * Verifiers stake tokens to register, can be slashed or rewarded.
 */
export const VerifierRegistryABI = [
  // Constructor
  {
    type: "constructor",
    inputs: [{ name: "_stakeToken", type: "address" }],
    stateMutability: "nonpayable",
  },

  // ── Errors ──────────────────────────────────────────────────────────────

  {
    type: "error",
    name: "InsufficientStake",
    inputs: [
      { name: "provided", type: "uint256" },
      { name: "required", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "AlreadyRegistered",
    inputs: [{ name: "verifier", type: "address" }],
  },
  {
    type: "error",
    name: "NotRegistered",
    inputs: [{ name: "verifier", type: "address" }],
  },
  {
    type: "error",
    name: "NotActive",
    inputs: [{ name: "verifier", type: "address" }],
  },
  {
    type: "error",
    name: "UnstakeNotRequested",
    inputs: [{ name: "verifier", type: "address" }],
  },
  {
    type: "error",
    name: "CooldownNotElapsed",
    inputs: [{ name: "remaining", type: "uint256" }],
  },
  {
    type: "error",
    name: "Unauthorized",
    inputs: [{ name: "caller", type: "address" }],
  },
  {
    type: "error",
    name: "SlashExceedsStake",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "stake", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "RewardTransferFailed",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidReputation",
    inputs: [{ name: "value", type: "uint256" }],
  },

  // ── Events ──────────────────────────────────────────────────────────────

  {
    type: "event",
    name: "VerifierRegistered",
    inputs: [
      { name: "verifier", type: "address", indexed: true },
      { name: "stake", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VerifierUnstakeRequested",
    inputs: [{ name: "verifier", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "VerifierWithdrawn",
    inputs: [
      { name: "verifier", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VerifierSlashed",
    inputs: [
      { name: "verifier", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "reason", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VerifierRewarded",
    inputs: [
      { name: "verifier", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ReputationUpdated",
    inputs: [
      { name: "verifier", type: "address", indexed: true },
      { name: "newReputation", type: "uint256", indexed: false },
    ],
  },

  // ── Views ────────────────────────────────────────────────────────────────

  {
    name: "stakeToken",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "MIN_STAKE",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "COOLDOWN_PERIOD",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "arbiter",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "rewardSource",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "verifiers",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "addr", type: "address" },
      { name: "stake", type: "uint256" },
      { name: "reputation", type: "uint256" },
      { name: "registeredAt", type: "uint256" },
      { name: "unstakeRequestedAt", type: "uint256" },
      { name: "active", type: "bool" },
    ],
  },
  {
    name: "verifierList",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getActiveVerifiers",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "getVerifierCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "isActive",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "verifier", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },

  // ── Write Functions ──────────────────────────────────────────────────────

  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "stakeAmount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "requestUnstake",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "slash",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "verifier", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "reason", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "reward",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "verifier", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "updateReputation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "verifier", type: "address" },
      { name: "newReputation", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "setArbiter",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newArbiter", type: "address" }],
    outputs: [],
  },
  {
    name: "setRewardSource",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newRewardSource", type: "address" }],
    outputs: [],
  },
] as const;
