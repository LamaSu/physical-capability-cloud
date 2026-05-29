/**
 * PCCProtocol ABI — root protocol contract for Physical Capability Cloud.
 *
 * Collects 2.35% from ALL PCC escrow settlements. Fee recipient is immutable.
 * Every settlement must pass through the PCC Verification Oracle.
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
      { name: "_oracleVerifier", type: "address" },
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
  {
    name: "SUPPORTED_ATTESTATION_VERSION",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },

  // ── Immutable State ────────────────────────────────────────────────

  {
    name: "feeRecipient",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "oracleVerifier",
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

  // ── Oracle-Gated Settlement ────────────────────────────────────────

  {
    name: "verifyOracleAttestation",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "attestation",
        type: "tuple",
        components: [
          { name: "version", type: "uint8" },
          { name: "escrowAddress", type: "address" },
          { name: "jobId", type: "string" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "tier", type: "uint8" },
          { name: "verified", type: "bool" },
          { name: "timestamp", type: "uint256" },
          { name: "nonce", type: "bytes32" },
          { name: "extraData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "valid", type: "bool" }],
  },
  {
    name: "collectFeeWithAttestation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "fee", type: "uint256" },
      {
        name: "attestation",
        type: "tuple",
        components: [
          { name: "version", type: "uint8" },
          { name: "escrowAddress", type: "address" },
          { name: "jobId", type: "string" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "tier", type: "uint8" },
          { name: "verified", type: "bool" },
          { name: "timestamp", type: "uint256" },
          { name: "nonce", type: "bytes32" },
          { name: "extraData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
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

/** Default protocol fee in basis points (2.35%) */
export const PCC_DEFAULT_FEE_BPS = 235n;

/** Minimum protocol fee in basis points (0.1%) */
export const PCC_FEE_BPS_MIN = 10n;

/** Maximum protocol fee in basis points (5%) */
export const PCC_FEE_BPS_MAX = 500n;

/**
 * Current IPCCOracle.Attestation schema version.
 *
 * Every Attestation produced by the TypeScript side MUST carry
 * `version: ATTESTATION_SCHEMA_VERSION`. The protocol's
 * `requiresOracle` modifier rejects anything else (defense-in-depth),
 * and the oracle's `verifyAttestation` also rejects unsupported
 * versions. Bumping this is a deliberate, coordinated migration:
 * deploy a new PCCVerificationOracle, wire a new PCCProtocol to it,
 * and update this constant. Old in-flight attestations signed against
 * the old schema will no longer verify.
 */
export const ATTESTATION_SCHEMA_VERSION = 1 as const;

/** Empty extraData payload for v1 attestations (no extension fields defined). */
export const ATTESTATION_V1_EMPTY_EXTRA_DATA = "0x" as const;
