/**
 * IdentityRegistry ABI — generated from IdentityRegistry.sol
 */
export const IdentityRegistryABI = [
  { type: "constructor", inputs: [], stateMutability: "nonpayable" },

  // Views
  { name: "admin", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "nextId", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    name: "getEntity",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "id", type: "uint256" },
        { name: "entityType", type: "uint8" },
        { name: "owner", type: "address" },
        { name: "metadataHash", type: "bytes32" },
        { name: "status", type: "uint8" },
        { name: "registeredAt", type: "uint256" },
        { name: "updatedAt", type: "uint256" },
      ],
    }],
  },
  {
    name: "getEntityCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getOwnerEntityCount",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getOwnerEntityIds",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },

  // State-changing
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_entityType", type: "uint8" },
      { name: "_metadataHash", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "updateMetadata",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "_newMetadataHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "setStatus",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "_status", type: "uint8" },
    ],
    outputs: [],
  },
  {
    name: "transferAdmin",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_newAdmin", type: "address" }],
    outputs: [],
  },

  // Events
  {
    name: "EntityRegistered",
    type: "event",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "entityType", type: "uint8", indexed: false },
      { name: "owner", type: "address", indexed: true },
      { name: "metadataHash", type: "bytes32", indexed: false },
    ],
  },
  {
    name: "EntityUpdated",
    type: "event",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "newMetadataHash", type: "bytes32", indexed: false },
    ],
  },
  {
    name: "EntityStatusChanged",
    type: "event",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "newStatus", type: "uint8", indexed: false },
    ],
  },
  {
    name: "AdminTransferred",
    type: "event",
    inputs: [
      { name: "oldAdmin", type: "address", indexed: true },
      { name: "newAdmin", type: "address", indexed: true },
    ],
  },
] as const;

export const EntityType = {
  Agent: 0,
  Machine: 1,
  Operator: 2,
  Verifier: 3,
} as const;

export const EntityStatus = {
  Active: 0,
  Suspended: 1,
  Deregistered: 2,
} as const;

export type EntityTypeName = keyof typeof EntityType;
export type EntityStatusName = keyof typeof EntityStatus;

export function entityTypeName(type: number): EntityTypeName {
  const match = Object.entries(EntityType).find(([, v]) => v === type);
  return match ? (match[0] as EntityTypeName) : "Agent";
}

export function entityStatusName(status: number): EntityStatusName {
  const match = Object.entries(EntityStatus).find(([, v]) => v === status);
  return match ? (match[0] as EntityStatusName) : "Active";
}
