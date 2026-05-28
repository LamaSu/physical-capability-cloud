/**
 * @pcc/a2a-signing — A2A v1.0 Signed Agent Cards.
 *
 * Public surface:
 *   - signAgentCard(card, {privateKey, kid, jwksUrl}) → SignedAgentCard
 *   - verifyAgentCard(signedCard, {jwksUrl | jwks | key}) → VerifyResult
 *   - loadSigningKey() → LoadedSigningKey | null  (from env)
 *   - generateJWKS(publicKey, kid) → JWKS document
 *
 * See README.md for env vars, key generation, and rotation strategy.
 */

export {
  signAgentCard,
  type AgentCard,
  type SignedAgentCard,
  type AgentCardSignature,
  type SignCardOptions,
} from "./sign-card.js";

export { verifyAgentCard, type VerifyResult, type VerifyOptions } from "./verify-card.js";

export {
  loadSigningKey,
  generateJWKS,
  DEFAULT_KID,
  DEFAULT_ALG,
  type LoadedSigningKey,
} from "./key-management.js";
