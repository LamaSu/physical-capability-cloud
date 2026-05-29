/**
 * @pcc/bridge-directory — directory of vendor bridges that integrate
 * with the Physical Capability Cloud.
 *
 * Phase 1: JSON document at https://capability.network/bridges.json.
 * Phase 2: on-chain BridgeDirectory.sol on Base.
 *
 * Consumers should always use `getBridgeDirectory()` and treat the
 * source-mode parameter as an implementation detail.
 */

export type {
  BridgeDirectory,
  BridgeDirectoryVersion,
  BridgeEntry,
  BridgeStatus,
  BridgeTrustTier,
  BridgeSLA,
  RegistryMap,
  SourceMode,
  GetDirectoryOptions,
} from "./types.js";

export {
  STATUS_TO_UINT,
  UINT_TO_STATUS,
  DEFAULT_JSON_URL,
  DEFAULT_CHAIN_ID,
} from "./types.js";

export {
  BridgeDirectorySchema,
  BridgeEntrySchema,
  BridgeStatusSchema,
  BridgeSLASchema,
  BridgeDirectoryVersionSchema,
  parseRegistries,
} from "./schema.js";

export {
  fetchJsonDirectory,
  parseDirectoryJson,
} from "./json-source.js";

export {
  fetchOnchainDirectory,
  OnchainNotImplementedError,
} from "./onchain-source.js";

export { fetchAutoDirectory } from "./auto-source.js";

export {
  getBridgeDirectory,
  lookupBridge,
  filterByStatus,
  filterByCapabilityType,
} from "./resolver.js";
