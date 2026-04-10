/**
 * Facade layer — the standardized interface between transport (routes/MCP) and business logic.
 *
 * Architecture:
 *   Routes/MCP → Facades → Populators → Repositories
 *
 * Each facade:
 * - Returns Result<T> (never throws)
 * - Uses populators for model→DTO transformation
 * - Accesses data through repositories only (never raw DB)
 * - Enforces RBAC via allowedRoles
 * - Emits telemetry for observability
 */

import { CapabilityFacade } from "./capability.facade.js";
import { JobFacade } from "./job.facade.js";
import { KernelFacade } from "./kernel.facade.js";
import { SettlementFacade } from "./settlement.facade.js";
import { ComplianceFacade } from "./compliance.facade.js";
import { AgentFacade } from "./agent.facade.js";

export { BaseFacade } from "./base.facade.js";
export { CapabilityFacade } from "./capability.facade.js";
export type { CreateCapabilityInput } from "./capability.facade.js";
export { JobFacade } from "./job.facade.js";
export type { JobFilters, SubmitJobInput, JobSubmitResult, JobStatusResult, RegisterDeviceInput } from "./job.facade.js";
export { KernelFacade } from "./kernel.facade.js";
export type { KernelFilters, CreateKernelInput, HeartbeatInput, HeartbeatResult, CapabilityAnnouncementInput, AnnouncementResult } from "./kernel.facade.js";
export { SettlementFacade } from "./settlement.facade.js";
export type { EscrowFilters, DisputeInput, BatchIntentInput } from "./settlement.facade.js";
export { ComplianceFacade } from "./compliance.facade.js";
export { AgentFacade } from "./agent.facade.js";
export type { AgentSession, AgentSessionSummary, RegisterAgentInput } from "./agent.facade.js";
export { ROLE_PERMISSIONS as AGENT_ROLE_PERMISSIONS } from "./agent.facade.js";

// Re-export types for convenience
export type {
  PopulationContext,
  PaginationParams,
  PaginatedResult,
  CapabilityDTO,
  CapabilitySearchCriteria,
  JobDTO,
  JobDetailDTO,
  JobTimelineEvent,
  KernelDTO,
  KernelHealthSnapshot,
  DeviceStatusDTO,
  EvidenceSummaryDTO,
  ComplianceReportDTO,
  DriftAlertDTO,
  ALCOAStatus,
  TierComplianceResult,
  AggregatedAttestationDTO,
  EscrowSummaryDTO,
  SettlementResultDTO,
  AgentRole,
  AgentPermissions,
  AgentContext,
  AgentSession as AgentSessionType,
} from "./types.js";
export { SOD_CONFLICTS } from "./types.js";

// ── Singleton Facade Instances ─────────────────────────────────────────────

let _capabilityFacade: CapabilityFacade | null = null;
let _jobFacade: JobFacade | null = null;
let _kernelFacade: KernelFacade | null = null;
let _settlementFacade: SettlementFacade | null = null;
let _complianceFacade: ComplianceFacade | null = null;

export function getCapabilityFacade(): CapabilityFacade {
  if (!_capabilityFacade) {
    _capabilityFacade = new CapabilityFacade();
  }
  return _capabilityFacade;
}

export function getJobFacade(): JobFacade {
  if (!_jobFacade) {
    _jobFacade = new JobFacade();
  }
  return _jobFacade;
}

export function getKernelFacade(): KernelFacade {
  if (!_kernelFacade) {
    _kernelFacade = new KernelFacade();
  }
  return _kernelFacade;
}

export function getSettlementFacade(): SettlementFacade {
  if (!_settlementFacade) {
    _settlementFacade = new SettlementFacade();
  }
  return _settlementFacade;
}

export function getComplianceFacade(): ComplianceFacade {
  if (!_complianceFacade) {
    _complianceFacade = new ComplianceFacade();
  }
  return _complianceFacade;
}

let _agentFacade: AgentFacade | null = null;

export function getAgentFacade(): AgentFacade {
  if (!_agentFacade) {
    _agentFacade = new AgentFacade();
  }
  return _agentFacade;
}
