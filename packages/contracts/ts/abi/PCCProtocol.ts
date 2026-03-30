/**
 * PCCProtocol ABI — root protocol contract for Physical Capability Cloud.
 *
 * Collects 1.5% from ALL PCC escrow settlements. Fee recipient is immutable.
 * Factory deploys MilestoneEscrow instances that are registered as protocol escrows.
 */
export const PCCProtocolABI = [
  // Constructor
  {
    type: "constructor",
    inputs: [
      { name: "_feeRecipient", type: "address" },
      { name: "_initialFeeBps", type: "uint256" },
      { name: "_governor", type: "address" },
    ],
    stateMutability: "nonpayable",
  },

  // ── Constants ──────────────────────────────────────────────────────

  {
    name: "FEE_BPS_MIN",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "FEE_BPS_MAX",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },

  // ── Immutable State ────────────────────────────────────────────────

  {
    name: "feeRecipient",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },

  // ── Governance State ───────────────────────────────────────────────

  {
    name: "protocolFeeBps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "governor",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },

  // ── Registry Addresses ────────────────────────────────────────────

  {
    name: "identityRegistry",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "reputationRegistry",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "validationRegistry",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "verifierRegistry",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },

  // ── Escrow Factory State ──────────────────────────────────────────

  {
    name: "isProtocolEscrow",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allEscrows",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },

  // ── Fee Accounting ────────────────────────────────────────────────

  {
    name: "totalFeesCollectedByToken",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "feesFromEscrow",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "escrow", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },

  // ── Views ──────────────────────────────────────────────────────────

  {
    name: "getEscrowCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "calculateFee",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "fee", type: "uint256" }],
  },
  {
    name: "getTotalFeesForToken",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },

  // ── State-changing ────────────────────────────────────────────────

  {
    name: "createEscrow",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "payer", type: "address" },
      { name: "arbiter", type: "address" },
      { name: "token", type: "address" },
      { name: "cwmId", type: "bytes32" },
    ],
    outputs: [{ name: "escrow", type: "address" }],
  },
  {
    name: "collectFee",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "fee", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "setProtocolFeeBps",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newFeeBps", type: "uint256" }],
    outputs: [],
  },
  {
    name: "setRegistries",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_identityRegistry", type: "address" },
      { name: "_reputationRegistry", type: "address" },
      { name: "_validationRegistry", type: "address" },
      { name: "_verifierRegistry", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "transferGovernor",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newGovernor", type: "address" }],
    outputs: [],
  },

  // ── Events ────────────────────────────────────────────────────────

  {
    name: "EscrowCreated",
    type: "event",
    inputs: [
      { name: "escrow", type: "address", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "arbiter", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "cwmId", type: "bytes32", indexed: false },
    ],
  },
  {
    name: "FeeCollected",
    type: "event",
    inputs: [
      { name: "escrow", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  {
    name: "ProtocolFeeBpsUpdated",
    type: "event",
    inputs: [
      { name: "oldBps", type: "uint256", indexed: false },
      { name: "newBps", type: "uint256", indexed: false },
    ],
  },
  {
    name: "GovernorTransferred",
    type: "event",
    inputs: [
      { name: "oldGovernor", type: "address", indexed: true },
      { name: "newGovernor", type: "address", indexed: true },
    ],
  },
  {
    name: "RegistriesUpdated",
    type: "event",
    inputs: [
      { name: "identityRegistry", type: "address", indexed: false },
      { name: "reputationRegistry", type: "address", indexed: false },
      { name: "validationRegistry", type: "address", indexed: false },
      { name: "verifierRegistry", type: "address", indexed: false },
    ],
  },
] as const;

/** Hardcoded fee recipient — the immutable value set in PCCProtocol constructor */
export const PCC_FEE_RECIPIENT = "0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B" as const;

/** Default protocol fee in basis points (1.5%) */
export const PCC_DEFAULT_FEE_BPS = 150n;

/** Minimum protocol fee in basis points (0.1%) */
export const PCC_FEE_BPS_MIN = 10n;

/** Maximum protocol fee in basis points (5%) */
export const PCC_FEE_BPS_MAX = 500n;
