/**
 * @pcc/identity
 *
 * W3C DID resolvers (did:pkh, did:web, did:ens) + Verifiable Credentials helpers.
 *
 * Specs implemented:
 *   - DID Core 1.0:        https://www.w3.org/TR/did-core/
 *   - did:pkh method:      https://w3c-ccg.github.io/did-method-pkh/
 *   - did:web method:      https://w3c-ccg.github.io/did-method-web/
 *   - VC Data Model 1.1:   https://www.w3.org/TR/vc-data-model/
 */

export { DIDResolver } from "./resolver.js";
export { VCVerifier, verifiableCredentialSchema } from "./vc.js";
export type { JWSVerifier, VCVerifierOptions } from "./vc.js";
export { parseDID, isDID } from "./did.js";
export { resolvePKH, parsePKHIdentifier } from "./methods/pkh.js";
export { resolveWeb, didWebToUrl } from "./methods/web.js";
export { resolveENS } from "./methods/ens.js";
export {
  DIDResolutionError,
  type DIDDocument,
  type VerificationMethod,
  type ServiceEndpoint,
  type ResolverOptions,
  type ParsedDID,
  type VerifiableCredential,
  type VCProof,
  type VCVerificationResult,
} from "./types.js";
