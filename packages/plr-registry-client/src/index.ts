/**
 * @pcc/plr-registry-client — TypeScript client for the on-chain
 * PLRBackendRegistry, plus EIP-712 signing/verification for off-chain
 * BackendManifest documents.
 *
 * Public API:
 *   - signBackendManifest(manifest, signer, domain) → SignedBackendManifest
 *   - verifyBackendManifest(signed, domain) → { valid, recovered }
 *   - manifestCid(payload) → bytes32 (re-exported from @pcc/spec for
 *     convenience)
 *   - PLRRegistryClient — high-level RPC reader/writer over viem
 */

export {
  signBackendManifest,
  verifyBackendManifest,
  prepareEip712Payload,
  type SignerLike,
  type RegistryEip712Domain,
} from "./manifest.js";

export { PLR_BACKEND_REGISTRY_ABI } from "./abi.js";

export {
  PLRRegistryClient,
  type PLRRegistryClientConfig,
} from "./client.js";

// Re-export pure spec helpers for one-stop import.
export {
  canonicalizeBackendManifest,
  deriveBackendIpId,
  manifestCid,
  sumAuthorBps,
  validateAuthorGroupBps,
  isStructurallyValidBackendManifest,
  addressToDelegatedAgentBytes32,
  delegatedAgentBytes32ToAddress,
  BackendDisabledError,
  PLR_DEFAULT_RATE_BPS,
  PLR_BACKEND_IP_ID_PREFIX,
  type BackendRecord,
  type BackendManifest,
  type BackendManifestAuthor,
  type SignedBackendManifest,
} from "@pcc/spec";
