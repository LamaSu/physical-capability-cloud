/**
 * Hand-curated ABI for PLRBackendRegistry — covers the read + write
 * methods + events the off-chain client needs. Full ABI lives in the
 * forge `out/` artifact after `forge build`; this trimmed surface keeps
 * the client bundle small.
 */

export const PLR_BACKEND_REGISTRY_ABI = [
  // ── Constructor (informational only — used by deploy script) ──────────
  {
    type: "constructor",
    inputs: [
      { name: "_contributorNFT", type: "address" },
      { name: "_scheduleRegistry", type: "address" },
      { name: "_governanceMultisig", type: "address" },
    ],
    stateMutability: "nonpayable",
  },

  // ── Writes ────────────────────────────────────────────────────────────
  {
    type: "function",
    name: "register",
    inputs: [
      { name: "modulePath", type: "string" },
      { name: "contributorTokenId", type: "uint256" },
      { name: "scheduleHash", type: "bytes32" },
      { name: "delegatedAgentId", type: "bytes32" },
      { name: "manifestCid", type: "bytes32" },
    ],
    outputs: [{ name: "modulePathKey", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setEnabled",
    inputs: [
      { name: "modulePathKey", type: "bytes32" },
      { name: "enabled", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setManifestCid",
    inputs: [
      { name: "modulePathKey", type: "bytes32" },
      { name: "newCid", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setScheduleHash",
    inputs: [
      { name: "modulePathKey", type: "bytes32" },
      { name: "newScheduleHash", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setDelegatedAgent",
    inputs: [
      { name: "modulePathKey", type: "bytes32" },
      { name: "newAgentId", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "proposeAuthorshipTransfer",
    inputs: [
      { name: "modulePathKey", type: "bytes32" },
      { name: "newTokenId", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executeAuthorshipTransfer",
    inputs: [{ name: "modulePathKey", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "recoverAuthorship",
    inputs: [
      { name: "modulePathKey", type: "bytes32" },
      { name: "newTokenId", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimRecovery",
    inputs: [{ name: "modulePathKey", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },

  // ── Views ─────────────────────────────────────────────────────────────
  {
    type: "function",
    name: "assertEnabled",
    inputs: [{ name: "modulePath", type: "string" }],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isEnabled",
    inputs: [{ name: "modulePath", type: "string" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRecord",
    inputs: [{ name: "modulePath", type: "string" }],
    outputs: [
      {
        components: [
          { name: "scheduleHash", type: "bytes32" },
          { name: "delegatedAgentId", type: "bytes32" },
          { name: "manifestCid", type: "bytes32" },
          { name: "contributorTokenId", type: "uint256" },
          { name: "registeredAt", type: "uint64" },
          { name: "lastEnabledChange", type: "uint64" },
          { name: "enabled", type: "bool" },
        ],
        type: "tuple",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "authorOf",
    inputs: [{ name: "modulePath", type: "string" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalBackends",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "deriveIpId",
    inputs: [
      { name: "modulePath", type: "string" },
      { name: "majorVersion", type: "uint8" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "pure",
  },

  // ── Events ────────────────────────────────────────────────────────────
  {
    type: "event",
    name: "BackendRegistered",
    inputs: [
      { name: "modulePathKey", type: "bytes32", indexed: true },
      { name: "modulePath", type: "string", indexed: false },
      { name: "author", type: "address", indexed: true },
      { name: "contributorTokenId", type: "uint256", indexed: false },
      { name: "scheduleHash", type: "bytes32", indexed: false },
      { name: "delegatedAgentId", type: "bytes32", indexed: false },
      { name: "manifestCid", type: "bytes32", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BackendEnabledChanged",
    inputs: [
      { name: "modulePathKey", type: "bytes32", indexed: true },
      { name: "actor", type: "address", indexed: true },
      { name: "enabled", type: "bool", indexed: false },
      { name: "changedAt", type: "uint64", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "AuthorshipTransferred",
    inputs: [
      { name: "modulePathKey", type: "bytes32", indexed: true },
      { name: "oldAuthor", type: "address", indexed: true },
      { name: "newAuthor", type: "address", indexed: true },
      { name: "oldTokenId", type: "uint256", indexed: false },
      { name: "newTokenId", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
] as const;
