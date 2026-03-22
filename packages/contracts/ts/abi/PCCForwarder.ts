/**
 * PCCForwarder ABI -- Payment-Gated Transaction Relay (ERC-8194) forwarder.
 *
 * Enables keyless agent authentication by bundling EIP-3009 USDC payment
 * authorizations with target contract calls.
 */
export const PCCForwarderABI = [
  // Constructor
  {
    type: "constructor",
    inputs: [
      { name: "_usdc", type: "address" },
      { name: "_owner", type: "address" },
    ],
    stateMutability: "nonpayable",
  },

  // ── Views ──────────────────────────────────────────────────────────

  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "usdc",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "isPGTRForwarder",
    type: "function",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "pgtrSender",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "isTrustedForwarder",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "authorizedRelayers",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "trustedTargets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "usedNonces",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },

  // ── Admin ──────────────────────────────────────────────────────────

  {
    name: "transferOwnership",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
  },
  {
    name: "addRelayer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "relayer", type: "address" }],
    outputs: [],
  },
  {
    name: "removeRelayer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "relayer", type: "address" }],
    outputs: [],
  },
  {
    name: "addTarget",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "target", type: "address" }],
    outputs: [],
  },
  {
    name: "removeTarget",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "target", type: "address" }],
    outputs: [],
  },

  // ── Relay ──────────────────────────────────────────────────────────

  {
    name: "relay",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "payer", type: "address" },
      { name: "target", type: "address" },
      { name: "callData", type: "bytes" },
      { name: "paymentAmount", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "expiry", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [{ name: "result", type: "bytes" }],
  },

  // ── Events ─────────────────────────────────────────────────────────

  {
    name: "PaymentGatedCall",
    type: "event",
    inputs: [
      { name: "payer", type: "address", indexed: true },
      { name: "target", type: "address", indexed: true },
      { name: "selector", type: "bytes4", indexed: true },
      { name: "paymentAmount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "RelayerAdded",
    type: "event",
    inputs: [
      { name: "relayer", type: "address", indexed: true },
    ],
  },
  {
    name: "RelayerRemoved",
    type: "event",
    inputs: [
      { name: "relayer", type: "address", indexed: true },
    ],
  },
  {
    name: "TargetAdded",
    type: "event",
    inputs: [
      { name: "target", type: "address", indexed: true },
    ],
  },
  {
    name: "TargetRemoved",
    type: "event",
    inputs: [
      { name: "target", type: "address", indexed: true },
    ],
  },
  {
    name: "OwnershipTransferred",
    type: "event",
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
] as const;
