export type { IJobRepository, JobRow, JobInsert } from "./IJobRepository.js";
export type { IKernelRepository, KernelRow, KernelInsert, DeviceRow, DeviceInsert } from "./IKernelRepository.js";
export type { ICapabilityRepository, CapabilityRow, CapabilityInsert } from "./ICapabilityRepository.js";
export type {
  IEvidenceBundleRepository,
  EvidenceRow,
  EvidenceInsert,
  EvidenceEventRow,
  EvidenceEventInsert,
  CaptureVerdictRow,
} from "./IEvidenceBundleRepository.js";
export type {
  IEscrowRepository,
  EscrowRow,
  EscrowInsert,
  MilestoneRow,
  MilestoneInsert,
  DisputeRow,
  DisputeInsert,
} from "./IEscrowRepository.js";
export type {
  IProtocolTemplateRepository,
  TemplateRow,
  TemplateInsert,
  StepRow,
  StepInsert,
  TransferRow,
  TransferInsert,
  ForkRow,
  ForkInsert,
} from "./IProtocolTemplateRepository.js";
export type {
  IProtocolRunRepository,
  ProtocolRunRow,
  ProtocolRunInsert,
  ProtocolRunStepRow,
  ProtocolRunStepInsert,
  ProtocolRunTransferRow,
  ProtocolRunTransferInsert,
  ProtocolEventRow,
  ProtocolEventInsert,
} from "./IProtocolRunRepository.js";
export type {
  IAutomationStatusRepository,
  AutomationStatusRow,
  AutomationStatusInsert,
  TransferAgentRow,
  TransferAgentInsert,
} from "./IAutomationStatusRepository.js";
export type {
  IOrchestratorRepository,
  GraphRow,
  GraphInsert,
  NodeRow,
  NodeInsert,
  EdgeRow,
  EdgeInsert,
  SampleRow,
  SampleInsert,
  SampleMovementRow,
  SampleMovementInsert,
  InstrumentWorkflowRow,
  InstrumentWorkflowInsert,
  InstrumentStepRow,
  InstrumentStepInsert,
  ResourceClaimRow,
  ResourceClaimInsert,
} from "./IOrchestratorRepository.js";
export type {
  ILogisticsRepository,
  ProviderRow,
  ProviderInsert,
  ShipmentRow,
  ShipmentInsert,
  TrackingEventRow,
  TrackingEventInsert,
  ConditionReadingRow,
  ConditionReadingInsert,
  BookingRow,
  BookingInsert,
  InstallationRow,
  InstallationInsert,
  InstallationStepRow,
  InstallationStepInsert,
  InstallationNoteRow,
  InstallationNoteInsert,
  TimelineEventRow,
  TimelineEventInsert,
} from "./ILogisticsRepository.js";
export type { ISessionRepository, SessionRow, SessionInsert } from "./ISessionRepository.js";
export type {
  IEncryptionRepository,
  EncryptedBundleRow,
  EncryptedBundleInsert,
  KeyCapsuleRow,
  KeyCapsuleInsert,
  AccessGrantRow,
  AccessGrantInsert,
  EvidenceCommitmentRow,
  EvidenceCommitmentInsert,
  ZkProofRow,
  ZkProofInsert,
  CommitmentTreeRow,
  CommitmentTreeInsert,
} from "./IEncryptionRepository.js";
export type {
  ISensorRepository,
  ChannelRow,
  ChannelInsert,
  AggregateRow,
  AggregateInsert,
  AnomalyRow,
  AnomalyInsert,
} from "./ISensorRepository.js";
export type {
  IBatchRepository,
  BatchManifestRow,
  BatchManifestInsert,
  SampleSlotRow,
  SampleSlotInsert,
  BatchEventRow,
  BatchEventInsert,
} from "./IBatchRepository.js";
export type {
  IStoryRepository,
  IpRegistrationRow,
  IpRegistrationInsert,
  DerivativeLinkRow,
  DerivativeLinkInsert,
  RoyaltySplitRow,
  RoyaltySplitInsert,
  RevenueClaimRow,
  RevenueClaimInsert,
} from "./IStoryRepository.js";
export type {
  ISWFRepository,
  SWFParticipantRow,
  SWFParticipantInsert,
  SWFEpochRow,
  SWFEpochInsert,
  SWFAccrualRow,
  SWFAccrualInsert,
  SWFContributionScoreRow,
  SWFContributionScoreInsert,
  SWFDividendClaimRow,
  SWFDividendClaimInsert,
  SWFProposalRow,
  SWFProposalInsert,
  SWFVoteRow,
  SWFVoteInsert,
} from "./ISWFRepository.js";
export type { IApiKeyRepository, ApiKeyRow, ApiKeyInsert } from "./IApiKeyRepository.js";
export type { IAuditLogRepository, AuditLogRow, AuditLogInsert } from "./IAuditLogRepository.js";
export type { IRegistrationRepository, RegistrationRow, RegistrationInsert } from "./IRegistrationRepository.js";
export type {
  IA2AMessageRepository,
  A2AMessageRow,
  A2AMessageInsert,
  A2AConversationRow,
  A2AConversationInsert,
} from "./IA2AMessageRepository.js";
export type {
  IGovernanceRepository,
  RateLimitPolicyRow,
  RateLimitPolicyInsert,
  DlpRuleRow,
  DlpRuleInsert,
  EndpointScopeRow,
  EndpointScopeInsert,
} from "./IGovernanceRepository.js";
export type {
  ITemplateStoreRepository,
  CapabilityTemplateStoreRow,
  CapabilityTemplateStoreInsert,
  MachineProfileStoreRow,
  MachineProfileStoreInsert,
  VerificationTemplateRow,
  VerificationTemplateInsert,
  QueryTemplateRow,
  QueryTemplateInsert,
  TemplateRatingRow,
  TemplateRatingInsert,
} from "./ITemplateStoreRepository.js";
export type {
  IAnalyticsRepository,
  AnalyticsEventRow,
  AnalyticsEventInsert,
  MaterializedViewRow,
  MaterializedViewInsert,
  ComplianceTemplateRow,
  ComplianceTemplateInsert,
  ComplianceProfileRow,
  ComplianceProfileInsert,
} from "./IAnalyticsRepository.js";
export type {
  IContributorRepository,
  ContributorProfileRecord,
  ContributorProfileRow,
  ContributorProfileInsert,
  RateScheduleRecord,
  RateScheduleRow,
  RateScheduleInsert,
  TrainingManifestRecord,
  TrainingManifestRow,
  TrainingManifestInsert,
  CompositionManifestRecord,
  CompositionManifestRow,
  CompositionManifestInsert,
} from "./IContributorRepository.js";

import type { IJobRepository } from "./IJobRepository.js";
import type { IKernelRepository } from "./IKernelRepository.js";
import type { ICapabilityRepository } from "./ICapabilityRepository.js";
import type { IEvidenceBundleRepository } from "./IEvidenceBundleRepository.js";
import type { IEscrowRepository } from "./IEscrowRepository.js";
import type { IProtocolTemplateRepository } from "./IProtocolTemplateRepository.js";
import type { IProtocolRunRepository } from "./IProtocolRunRepository.js";
import type { IAutomationStatusRepository } from "./IAutomationStatusRepository.js";
import type { IOrchestratorRepository } from "./IOrchestratorRepository.js";
import type { ILogisticsRepository } from "./ILogisticsRepository.js";
import type { ISessionRepository } from "./ISessionRepository.js";
import type { IEncryptionRepository } from "./IEncryptionRepository.js";
import type { ISensorRepository } from "./ISensorRepository.js";
import type { IBatchRepository } from "./IBatchRepository.js";
import type { IStoryRepository } from "./IStoryRepository.js";
import type { ISWFRepository } from "./ISWFRepository.js";
import type { IApiKeyRepository } from "./IApiKeyRepository.js";
import type { IAuditLogRepository } from "./IAuditLogRepository.js";
import type { IRegistrationRepository } from "./IRegistrationRepository.js";
import type { IA2AMessageRepository } from "./IA2AMessageRepository.js";
import type { IGovernanceRepository } from "./IGovernanceRepository.js";
import type { ITemplateStoreRepository } from "./ITemplateStoreRepository.js";
import type { IAnalyticsRepository } from "./IAnalyticsRepository.js";
import type { IOrchestratorSessionRepository } from "./IOrchestratorSessionRepository.js";
import type { IRatingRepository } from "./IRatingRepository.js";
import type { IContributorRepository } from "./IContributorRepository.js";
import type { IRequestRepository } from "./IRequestRepository.js";
import type { IInvocationReceiptRepository } from "./IInvocationReceiptRepository.js";
import type { IGatewayReceiptRepository } from "./IGatewayReceiptRepository.js";
import type { ICsdUsageRepository } from "./ICsdUsageRepository.js";

export type {
  IRatingRepository,
  RatingRow,
  RatingInsert,
  RatingAggregate,
} from "./IRatingRepository.js";

export type {
  ICsdUsageRepository,
  CsdUsage,
  CsdUsageRow,
  CsdUsageInsert,
} from "./ICsdUsageRepository.js";

export type {
  IRequestRepository,
  RequestRow,
  RequestInsert,
  RequestsFilter,
} from "./IRequestRepository.js";

export type {
  IInvocationReceiptRepository,
  InvocationReceiptRow,
  InvocationReceiptInsert,
  InvocationReceiptFilter,
} from "./IInvocationReceiptRepository.js";

export type {
  IGatewayReceiptRepository,
  GatewayReceiptRow,
  GatewayReceiptInsert,
  GatewayReceiptSessionSnapshot,
} from "./IGatewayReceiptRepository.js";

/**
 * Aggregate interface for the full repository collection.
 * Facades and gateway code depend on this interface, not on the concrete
 * Drizzle/SQLite implementation. This is the key abstraction seam that
 * allows swapping SQLite for Postgres (Phase 2/3) without touching callers.
 */
export interface IRepositories {
  kernels: IKernelRepository;
  capabilities: ICapabilityRepository;
  jobs: IJobRepository;
  evidence: IEvidenceBundleRepository;
  escrows: IEscrowRepository;
  protocols: IProtocolTemplateRepository;
  protocolRuns: IProtocolRunRepository;
  automationStatuses: IAutomationStatusRepository;
  orchestrator: IOrchestratorRepository;
  logistics: ILogisticsRepository;
  sessions: ISessionRepository;
  encryption: IEncryptionRepository;
  sensors: ISensorRepository;
  batches: IBatchRepository;
  story: IStoryRepository;
  swf: ISWFRepository;
  apiKeys: IApiKeyRepository;
  auditLog: IAuditLogRepository;
  registrations: IRegistrationRepository;
  a2aMessages: IA2AMessageRepository;
  governance: IGovernanceRepository;
  templateStore: ITemplateStoreRepository;
  analytics: IAnalyticsRepository;
  // Wave 4.3 — orchestrator-sdk session store. The gateway wires
  // OrchestratorSessionStore (in services/) onto this and calls
  // setSessionStore() to swap the SDK's in-memory Map.
  orchestratorSessions: IOrchestratorSessionRepository;
  // T2.7 — buyer-side operator ratings; aggregate + recent for the public
  // /api/operators/:id/ratings surface plus the auth-gated /rate POST.
  ratings: IRatingRepository;
  contributors: IContributorRepository;
  // Wave 5 — demand-intent capture; replaces the in-memory requestsStore in
  // packages/gateway/src/routes/requests.ts. compositionSignature indexed for
  // fast aggregation by the @pcc/demand-intel sketches.
  requests: IRequestRepository;
  // Universal Aggregator (Phase 1) — per-invocation provenance receipts for
  // indexed-tool calls proxied through /api/aggregator/invoke.
  invocationReceipts: IInvocationReceiptRepository;
  // v3 evidence-signing (§8.5 step 5) — per-checkpoint transactional gateway
  // receipts (§8.3: receipt ⟺ committed acceptance). Additive; not wired into
  // the live settlement path until step 6.
  gatewayReceipts: IGatewayReceiptRepository;
  // PR #118 follow-on — persistent CSD usage attribution (replaces in-memory
  // Map on CsdRegistry). Opt-in via PCC_CSD_PERSIST=true in gateway boot.
  csdUsage: ICsdUsageRepository;
  // Option B Phase A -- durable WebAuthn challenge cache.
  passkeySessions: {
    insert(row: {
      sessionId: string;
      challenge: string;
      rpId: string;
      expectedOrigin: string;
      operatorId?: string;
      createdAt: number;
      expiresAt: number;
    }): unknown;
    findById(sessionId: string): {
      sessionId: string;
      challenge: string;
      rpId: string;
      expectedOrigin: string;
      operatorId: string | null;
      createdAt: number;
      expiresAt: number;
    } | undefined;
    delete(sessionId: string): unknown;
    sweepExpired(now: number): unknown;
  };
}
