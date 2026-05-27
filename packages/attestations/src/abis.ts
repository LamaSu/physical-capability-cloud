/**
 * EAS contract ABIs — minimal subset needed for read + schema register.
 * Full ABIs at:
 * https://github.com/ethereum-attestation-service/eas-contracts/tree/master/deployments
 */

export const easAbi = [
  {
    inputs: [{ internalType: "bytes32", name: "uid", type: "bytes32" }],
    name: "getAttestation",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "uid", type: "bytes32" },
          { internalType: "bytes32", name: "schema", type: "bytes32" },
          { internalType: "uint64", name: "time", type: "uint64" },
          { internalType: "uint64", name: "expirationTime", type: "uint64" },
          { internalType: "uint64", name: "revocationTime", type: "uint64" },
          { internalType: "bytes32", name: "refUID", type: "bytes32" },
          { internalType: "address", name: "recipient", type: "address" },
          { internalType: "address", name: "attester", type: "address" },
          { internalType: "bool", name: "revocable", type: "bool" },
          { internalType: "bytes", name: "data", type: "bytes" },
        ],
        internalType: "struct Attestation",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "uid", type: "bytes32" }],
    name: "isAttestationValid",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "version",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getDomainSeparator",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "recipient", type: "address" },
      { indexed: true, internalType: "address", name: "attester", type: "address" },
      { indexed: false, internalType: "bytes32", name: "uid", type: "bytes32" },
      { indexed: true, internalType: "bytes32", name: "schemaUID", type: "bytes32" },
    ],
    name: "Attested",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "recipient", type: "address" },
      { indexed: true, internalType: "address", name: "attester", type: "address" },
      { indexed: false, internalType: "bytes32", name: "uid", type: "bytes32" },
      { indexed: true, internalType: "bytes32", name: "schemaUID", type: "bytes32" },
    ],
    name: "Revoked",
    type: "event",
  },
] as const;

export const schemaRegistryAbi = [
  {
    inputs: [{ internalType: "bytes32", name: "uid", type: "bytes32" }],
    name: "getSchema",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "uid", type: "bytes32" },
          { internalType: "address", name: "resolver", type: "address" },
          { internalType: "bool", name: "revocable", type: "bool" },
          { internalType: "string", name: "schema", type: "string" },
        ],
        internalType: "struct SchemaRecord",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "string", name: "schema", type: "string" },
      { internalType: "address", name: "resolver", type: "address" },
      { internalType: "bool", name: "revocable", type: "bool" },
    ],
    name: "register",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "uid", type: "bytes32" },
      { indexed: true, internalType: "address", name: "registerer", type: "address" },
      {
        components: [
          { internalType: "bytes32", name: "uid", type: "bytes32" },
          { internalType: "address", name: "resolver", type: "address" },
          { internalType: "bool", name: "revocable", type: "bool" },
          { internalType: "string", name: "schema", type: "string" },
        ],
        indexed: false,
        internalType: "struct SchemaRecord",
        name: "schema",
        type: "tuple",
      },
    ],
    name: "Registered",
    type: "event",
  },
] as const;
