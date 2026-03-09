/**
 * ValidationRegistry ABI — generated from ValidationRegistry.sol
 */
export const ValidationRegistryABI = [
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
    name: "authorizedValidators",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getAttestation",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "attestationId", type: "uint256" }],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "id", type: "uint256" },
        { name: "subjectId", type: "uint256" },
        { name: "validator", type: "address" },
        { name: "claimHash", type: "bytes32" },
        { name: "claimType", type: "string" },
        { name: "issuedAt", type: "uint256" },
        { name: "expiresAt", type: "uint256" },
        { name: "revoked", type: "bool" },
      ],
    }],
  },
  {
    name: "getEntityAttestationIds",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "entityId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "getValidatorAttestationIds",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "validator", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "hasValidAttestation",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "entityId", type: "uint256" },
      { name: "claimType", type: "string" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getAttestationCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },

  // State-changing
  {
    name: "authorizeValidator",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_validator", type: "address" }],
    outputs: [],
  },
  {
    name: "revokeValidator",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_validator", type: "address" }],
    outputs: [],
  },
  {
    name: "attest",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_subjectId", type: "uint256" },
      { name: "_claimHash", type: "bytes32" },
      { name: "_claimType", type: "string" },
      { name: "_durationSeconds", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "revokeAttestation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "attestationId", type: "uint256" }],
    outputs: [],
  },

  // Events
  {
    name: "AttestationCreated",
    type: "event",
    inputs: [
      { name: "attestationId", type: "uint256", indexed: true },
      { name: "subjectId", type: "uint256", indexed: true },
      { name: "validator", type: "address", indexed: true },
      { name: "claimType", type: "string", indexed: false },
      { name: "claimHash", type: "bytes32", indexed: false },
    ],
  },
  {
    name: "AttestationRevoked",
    type: "event",
    inputs: [
      { name: "attestationId", type: "uint256", indexed: true },
      { name: "revokedBy", type: "address", indexed: true },
    ],
  },
  {
    name: "ValidatorAuthorized",
    type: "event",
    inputs: [{ name: "validator", type: "address", indexed: true }],
  },
  {
    name: "ValidatorRevoked",
    type: "event",
    inputs: [{ name: "validator", type: "address", indexed: true }],
  },
] as const;
