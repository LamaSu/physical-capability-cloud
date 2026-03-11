import type { StoreDB } from "../connection.js";
import { KernelRepository } from "./kernels.js";
import { CapabilityRepository } from "./capabilities.js";
import { JobRepository } from "./jobs.js";
import { EvidenceBundleRepository } from "./evidence.js";
import { EscrowRepository } from "./settlement.js";
import { ProtocolTemplateRepository, ProtocolRunRepository, AutomationStatusRepository } from "./protocols.js";
import { OrchestratorRepository } from "./orchestrator.js";
import { LogisticsRepository } from "./logistics.js";

export {
  KernelRepository,
  CapabilityRepository,
  JobRepository,
  EvidenceBundleRepository,
  EscrowRepository,
  ProtocolTemplateRepository,
  ProtocolRunRepository,
  AutomationStatusRepository,
  OrchestratorRepository,
  LogisticsRepository,
};

export function buildRepositories(db: StoreDB) {
  return {
    kernels: new KernelRepository(db),
    capabilities: new CapabilityRepository(db),
    jobs: new JobRepository(db),
    evidence: new EvidenceBundleRepository(db),
    escrows: new EscrowRepository(db),
    protocols: new ProtocolTemplateRepository(db),
    protocolRuns: new ProtocolRunRepository(db),
    automationStatuses: new AutomationStatusRepository(db),
    orchestrator: new OrchestratorRepository(db),
    logistics: new LogisticsRepository(db),
  };
}

export type Repositories = ReturnType<typeof buildRepositories>;
