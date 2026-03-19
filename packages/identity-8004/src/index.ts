/**
 * @pcc/identity-8004 — ERC-8004 Trustless Agents integration for PCC.
 *
 * Provides:
 * - IdentityRegistryClient: register PCC kernels as on-chain agents (ERC-721)
 * - ReputationRegistryClient: submit/query feedback scores
 * - ValidationRegistryClient: request/respond to agent validation
 * - generateRegistrationFile: auto-generate Agent Registration File from kernel config
 * - Contract ABIs and deployed addresses
 */

export { IdentityRegistryClient, type IdentityRegistryConfig } from "./identity-registry.js";
export { ReputationRegistryClient, type ReputationRegistryConfig } from "./reputation-registry.js";
export { ValidationRegistryClient, type ValidationRegistryConfig } from "./validation-registry.js";
export {
  generateRegistrationFile,
  generateDomainVerification,
  type KernelRegistrationInput,
} from "./registration-file.js";
export { identityRegistryAbi, reputationRegistryAbi, validationRegistryAbi } from "./abis.js";
export { REGISTRY_ADDRESSES, getRegistryAddresses, type RegistryAddresses } from "./constants.js";
export {
  CrossChainRegistrationManager,
  SUPPORTED_CHAINS,
  type ChainRegistration,
  type CrossChainRegistrationPlan,
} from "./cross-chain.js";
