import type { StoreDB } from "../connection.js";
import { KernelRepository } from "./kernels.js";
import { CapabilityRepository } from "./capabilities.js";
import { JobRepository } from "./jobs.js";
import { EvidenceBundleRepository } from "./evidence.js";
import { EscrowRepository } from "./settlement.js";
import { ProtocolTemplateRepository, ProtocolRunRepository, AutomationStatusRepository } from "./protocols.js";
import { OrchestratorRepository } from "./orchestrator.js";
import { LogisticsRepository } from "./logistics.js";
import { SessionRepository } from "./sessions.js";
import { EncryptionRepository } from "./encryption.js";
import { SensorRepository } from "./sensors.js";
import { BatchRepository } from "./batches.js";
import { StoryRepository } from "./story.js";
import { SWFRepository } from "./swf.js";
import { ApiKeyRepository } from "./api-keys.js";
import { AuditLogRepository } from "./audit-log.js";
import { RegistrationRepository } from "./registrations.js";
import { A2AMessageRepository } from "./a2a-messages.js";
import { GovernanceRepository } from "./governance.js";
import { TemplateStoreRepository } from "./template-store.js";
import { AnalyticsRepository } from "./analytics.js";
import { RatingRepository } from "./ratings.js";
import { OrchestratorSessionRepository } from "./orchestrator-sessions.js";
import { ContributorRepository } from "./contributor.js";

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
  SessionRepository,
  EncryptionRepository,
  SensorRepository,
  BatchRepository,
  StoryRepository,
  SWFRepository,
  ApiKeyRepository,
  AuditLogRepository,
  RegistrationRepository,
  A2AMessageRepository,
  GovernanceRepository,
  TemplateStoreRepository,
  AnalyticsRepository,
  RatingRepository,
  OrchestratorSessionRepository,
  ContributorRepository,
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
    sessions: new SessionRepository(db),
    encryption: new EncryptionRepository(db),
    sensors: new SensorRepository(db),
    batches: new BatchRepository(db),
    story: new StoryRepository(db),
    swf: new SWFRepository(db),
    apiKeys: new ApiKeyRepository(db),
    auditLog: new AuditLogRepository(db),
    registrations: new RegistrationRepository(db),
    a2aMessages: new A2AMessageRepository(db),
    governance: new GovernanceRepository(db),
    templateStore: new TemplateStoreRepository(db),
    analytics: new AnalyticsRepository(db),
    ratings: new RatingRepository(db),
    orchestratorSessions: new OrchestratorSessionRepository(db),
    contributors: new ContributorRepository(db),
  };
}

export type Repositories = ReturnType<typeof buildRepositories>;
