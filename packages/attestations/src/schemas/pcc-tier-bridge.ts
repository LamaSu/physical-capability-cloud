/**
 * PCC Tier Bridge schema — a bridge maintainer attests a tier level
 * (0..3, matching PCC assurance tiers) for an evidence CID.
 *
 * Use cases:
 *  - Tier promotion: bridge maintainer signs "this evidence supports Tier 2"
 *  - Tier audit: third party signs an independent tier assessment
 *
 * Schema fields:
 *   - bridgeMaintainer: address that operates the bridge being signaled
 *   - tier: uint8 0..3 (PCC assurance tier)
 *   - evidenceCID: bytes32 (IPFS CID hash or evidence-bundle reference)
 */

import { computeSchemaUID } from "../schema-registry.js";
import { ZERO_ADDRESS } from "../constants.js";

/** Schema definition string — register once on EAS Schema Registry per chain. */
export const PCC_BRIDGE_TIER_SCHEMA =
  "address bridgeMaintainer,uint8 tier,bytes32 evidenceCID";

/** Computed schema UID assuming default resolver (zero) and revocable=true. */
export const PCC_BRIDGE_TIER_SCHEMA_UID = computeSchemaUID(
  PCC_BRIDGE_TIER_SCHEMA,
  ZERO_ADDRESS,
  true,
);

/** Strongly-typed payload for tier-bridge attestations. */
export interface PCCBridgeTierData {
  bridgeMaintainer: `0x${string}`;
  /** 0 = self-attested, 1 = verified, 2 = certified, 3 = sovereign */
  tier: 0 | 1 | 2 | 3;
  /** 32-byte CID hash referencing the supporting evidence bundle */
  evidenceCID: `0x${string}`;
}

/** Convert a typed payload to the field-name map required by encodeSchemaData. */
export function toPCCBridgeTierFields(
  data: PCCBridgeTierData,
): Record<string, unknown> {
  if (data.tier < 0 || data.tier > 3) {
    throw new Error(`PCC tier must be 0..3, got ${data.tier}`);
  }
  return {
    bridgeMaintainer: data.bridgeMaintainer,
    tier: data.tier,
    evidenceCID: data.evidenceCID,
  };
}
