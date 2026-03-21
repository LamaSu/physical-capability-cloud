// ABI exports
export {
  MilestoneEscrowABI,
  MilestoneStatus,
  milestoneStatusName,
  MockUSDCABI,
  PCCForwarderABI,
  IdentityRegistryABI,
  EntityType,
  EntityStatus,
  entityTypeName,
  entityStatusName,
  ReputationRegistryABI,
  ValidationRegistryABI,
  VerifierRegistryABI,
} from "./abi/index.js";
export type { MilestoneStatusName, EntityTypeName, EntityStatusName } from "./abi/index.js";

// Chain config
export {
  deployments,
  getDeployment,
  getContractAddress,
} from "./chain-config.js";
export type { ChainDeployment } from "./chain-config.js";

// Capability Certificates (Bubblegum cNFT mock)
export { CapabilityCertificateService } from "./capability-certificates.js";
export type { MintCertificateParams } from "./capability-certificates.js";

// DePIN Reward Engine
export { RewardEngine, SCORE_WEIGHTS } from "./reward-engine.js";
export type { KernelEpochInput } from "./reward-engine.js";

// Revenue Incentive Network
export { IncentiveNetwork } from "./incentive-network.js";
export type { IncentiveConfig, FundingSource, IncentivePoolState } from "./incentive-network.js";

// PCC Native NFT (zero-fee soulbound certificates)
export { PCCNFTClient } from "./pcc-nft/index.js";
export type {
  PCCAsset,
  PCCCollection,
  MintParams,
  UpdateParams,
  BurnParams,
  CreateCollectionParams,
  PCCNFTClientConfig,
} from "./pcc-nft/index.js";

// Story Protocol IP Service
export {
  StoryIPService,
  getStoryIPService,
  resetStoryIPService,
} from "./story-ip-service.js";
export type {
  RegisterCapabilityOptions,
  RegisterJobEvidenceParams,
} from "./story-ip-service.js";
