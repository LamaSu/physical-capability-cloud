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
  PCCProtocolABI,
  PCC_FEE_RECIPIENT,
  PCC_DEFAULT_FEE_BPS,
  PCC_FEE_BPS_MIN,
  PCC_FEE_BPS_MAX,
  RateScheduleRegistryABI,
  ContributorNFTABI,
  ATTESTATION_SCHEMA_VERSION,
  ATTESTATION_V1_EMPTY_EXTRA_DATA,
} from "./abi/index.js";
export type { MilestoneStatusName, EntityTypeName, EntityStatusName } from "./abi/index.js";

// Chain config
export {
  deployments,
  getDeployment,
  getContractAddress,
} from "./chain-config.js";
export type { ChainDeployment } from "./chain-config.js";

// Oracle attestation (IPCCOracle.Attestation mirror)
export {
  buildOracleAttestation,
  attestationToTuple,
  isSupportedAttestationVersion,
} from "./oracle-attestation.js";
export type { OracleAttestation } from "./oracle-attestation.js";

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

// Story Protocol — default revenue split profiles
export {
  SPLIT_PROFILES,
  buildSplitsForJob,
  calculateDistribution,
  validateSplitTotal,
} from "./story-defaults.js";
export type {
  RevenueSplitProfile,
  SplitEntry,
  SplitRole,
  SplitProfileName,
  ResolvedSplit,
  DistributionEntry,
} from "./story-defaults.js";

// Licensing Engine — automatic IP licensing logic
export {
  LicensingEngine,
  getLicensingEngine,
  resetLicensingEngine,
  captureClassFromEvidence,
} from "./licensing-engine.js";
export type {
  LicenseEvaluation,
  EffectiveRevShareChain,
  RoyaltyDistribution,
} from "./licensing-engine.js";

// IP Enforcement Bridge — similarity → licensing → Story Protocol
export { IPEnforcementBridge } from "./ip-enforcement.js";
export type {
  EnforcementResult,
  RoyaltySettlement,
} from "./ip-enforcement.js";

// splitPayout helpers (ADR-11) — Payout struct + ROLE_TAGS + buildPayoutMap stub
export { ROLE_TAGS, buildPayoutMap } from "./payouts.js";
export type {
  Payout,
  RoleTagKey,
  BuildPayoutMapInput,
  BuildPayoutMapResult,
} from "./payouts.js";
