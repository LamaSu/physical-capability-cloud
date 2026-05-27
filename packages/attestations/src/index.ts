/**
 * @pcc/attestations — Ethereum Attestation Service (EAS) wrapper for PCC.
 *
 * EAS is the generic on-chain attestation primitive:
 *  - Schemas registered once, used by anyone
 *  - On-chain (gas-paid) AND off-chain (signed JSON, free) attestations
 *  - Indexed by The Graph, Tenderly, and others
 *  - Supports revocation
 *
 * PCC's tier system becomes one consumer of EAS attestations — composable
 * with audits, vendor vouches, and any future attestation-backed signal.
 *
 * @see https://attest.org
 * @see https://github.com/ethereum-attestation-service/eas-contracts
 */

// Core types
export type {
  AttestationSchema,
  Attestation,
  OffChainAttestation,
  VerificationResult,
  EASDeployment,
} from "./types.js";

// Constants
export {
  EAS_DEPLOYMENTS,
  getEASDeployment,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  EAS_DOMAIN_NAME,
  OFFCHAIN_ATTESTATION_VERSION,
  DEFAULT_EAS_CONTRACT_VERSION,
} from "./constants.js";

// ABIs (for downstream consumers building their own clients)
export { easAbi, schemaRegistryAbi } from "./abis.js";

// Read-only EAS client
export { EASClient, type EASClientOptions } from "./eas-client.js";

// Schema Registry client + helpers
export {
  SchemaRegistryClient,
  type SchemaRegistryClientOptions,
  computeSchemaUID,
  parseSchemaString,
  encodeSchemaData,
  decodeSchemaData,
  type SchemaField,
} from "./schema-registry.js";

// Off-chain attestation sign / verify
export {
  OffChainSigner,
  OffChainVerifier,
  computeOffChainUID,
  generateSalt,
  OFFCHAIN_ATTESTATION_TYPES,
  type OffChainSignerOptions,
  type AttestParams,
} from "./off-chain.js";

// PCC schemas
export {
  PCC_BRIDGE_TIER_SCHEMA,
  PCC_BRIDGE_TIER_SCHEMA_UID,
  toPCCBridgeTierFields,
  type PCCBridgeTierData,
} from "./schemas/pcc-tier-bridge.js";
export {
  PCC_AUDIT_SCHEMA,
  PCC_AUDIT_SCHEMA_UID,
  toPCCAuditFields,
  type PCCAuditData,
} from "./schemas/pcc-audit.js";
export {
  PCC_VENDOR_VOUCH_SCHEMA,
  PCC_VENDOR_VOUCH_SCHEMA_UID,
  toPCCVendorVouchFields,
  type PCCVendorVouchData,
} from "./schemas/pcc-vendor-vouch.js";
