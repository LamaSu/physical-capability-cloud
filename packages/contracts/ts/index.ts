// ABI exports
export {
  MilestoneEscrowABI,
  MilestoneStatus,
  milestoneStatusName,
  MockUSDCABI,
} from "./abi/index.js";
export type { MilestoneStatusName } from "./abi/index.js";

// Chain config
export {
  deployments,
  getDeployment,
  getContractAddress,
} from "./chain-config.js";
export type { ChainDeployment } from "./chain-config.js";
