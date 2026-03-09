// ABI exports
export {
  MilestoneEscrowABI,
  MilestoneStatus,
  milestoneStatusName,
  MockUSDCABI,
  IdentityRegistryABI,
  EntityType,
  EntityStatus,
  entityTypeName,
  entityStatusName,
  ReputationRegistryABI,
  ValidationRegistryABI,
} from "./abi/index.js";
export type { MilestoneStatusName, EntityTypeName, EntityStatusName } from "./abi/index.js";

// Chain config
export {
  deployments,
  getDeployment,
  getContractAddress,
} from "./chain-config.js";
export type { ChainDeployment } from "./chain-config.js";
