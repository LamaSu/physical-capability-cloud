/**
 * Facade DTO types and shared interfaces.
 *
 * These types define the contract between Facades and the transport layer
 * (routes, MCP tools, A2A handlers). DTOs are distinct from internal models
 * (in @pcc/spec) — they include enrichment fields like availability scores,
 * reputation rankings, compliance status, and estimated delivery.
 */

import type {
  Id,
  Amount,
  Currency,
  Timestamp,
  GeoLocation,
  AssuranceTier,
  CapabilityType,
  PricingModel,
  ToleranceSpec,
  WorkEnvelope,
  StepStatus,
  EscrowStatus,
} from "@pcc/spec";

// ── Population Context ─────────────────────────────────────────────────────

/**
 * Context passed to populators to control enrichment behavior.
 * Prevents N+1 queries by pre-loading shared data.
 */
export interface PopulationContext {
  /** DID of the viewer (for personalized pricing, trust gates) */
  viewerDid?: string;
  /** Preferred currency for price conversion */
  currency?: Currency;
  /** Include reputation scores (requires ERC-8004 lookup) */
  includeReputation?: boolean;
  /** Include compliance/audit status */
  includeCompliance?: boolean;
  /** Include real-time device health */
  includeHealth?: boolean;
  /** Pre-loaded reputation map (kernelId → score) to avoid N+1 */
  reputationCache?: Map<string, number>;
  /** Pre-loaded queue depths (capabilityId → depth) */
  queueDepthCache?: Map<string, number>;
  /**
   * When true, the populator will cap maxAssuranceTier using the cold-start gate
   * (job count + effective reputation thresholds). Defaults to false to preserve
   * existing behavior for internal/admin reads.
   */
  applyColdStartGate?: boolean;
}

// ── Pagination ─────────────────────────────────────────────────────────────

export interface PaginationParams {
  offset?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ── Capability DTOs ────────────────────────────────────────────────────────

export interface CapabilityDTO {
  id: Id;
  kernelId: Id;
  type: CapabilityType;
  name: string;
  description?: string;
  materials: string[];
  tolerances?: ToleranceSpec;
  envelope?: WorkEnvelope;
  assuranceTiers: AssuranceTier[];
  pricing: PricingModel;
  location: GeoLocation;
  tags?: string[];
  // ── Enrichment fields (not in raw model) ──
  /** Operator reputation score (0-1000) from ERC-8004 */
  reputation?: number;
  /** Current queue depth (jobs waiting) */
  queueDepth: number;
  /** Is this capability currently available? */
  available: boolean;
  /** Estimated wait time in minutes */
  estimatedWaitMinutes?: number;
  /** Kernel name for display */
  kernelName?: string;
  /** Kernel online status */
  kernelStatus?: "online" | "offline" | "maintenance" | "stale";
}

export interface CapabilitySearchCriteria {
  type?: CapabilityType;
  materials?: string[];
  maxPrice?: Amount;
  minReputation?: number;
  location?: GeoLocation;
  radiusKm?: number;
  assuranceTier?: AssuranceTier;
  query?: string;
}

// ── Job DTOs ───────────────────────────────────────────────────────────────

export interface JobDTO {
  id: Id;
  capabilityId: Id;
  kernelId: Id;
  status: StepStatus;
  progress?: number;
  assuranceTier: AssuranceTier;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  // ── Enrichment ──
  /** Kernel name */
  kernelName?: string;
  /** Capability type */
  capabilityType?: CapabilityType;
  /** Evidence bundle count */
  evidenceCount?: number;
  /** Escrow status */
  escrowStatus?: EscrowStatus;
  /** Estimated completion */
  estimatedCompletion?: Timestamp;
}

export interface JobTimelineEvent {
  type: "queued" | "started" | "progress" | "evidence_received" | "verification_started" | "verified" | "settled" | "failed" | "disputed";
  timestamp: Timestamp;
  details?: Record<string, unknown>;
}

export interface JobDetailDTO extends JobDTO {
  timeline: JobTimelineEvent[];
  evidenceBundles: EvidenceSummaryDTO[];
  escrow?: EscrowSummaryDTO;
}

// ── Kernel DTOs ────────────────────────────────────────────────────────────

export interface KernelDTO {
  id: Id;
  name: string;
  operatorAddress: string;
  location: GeoLocation;
  physicalAddress: string;
  maxAssuranceTier: AssuranceTier;
  status: "online" | "offline" | "maintenance" | "suspended";
  lastHeartbeat: Timestamp;
  version: string;
  // ── Enrichment ──
  /** Number of capabilities this kernel offers */
  capabilityCount: number;
  /** Capability types offered */
  capabilityTypes: CapabilityType[];
  /** Reputation score */
  reputation?: number;
  /** Total completed jobs */
  totalJobsCompleted: number;
  /** Is the kernel stale? (heartbeat >5min old while status=online) */
  isStale: boolean;
  /** Active job count */
  activeJobCount?: number;
}

export interface KernelHealthSnapshot extends KernelDTO {
  devices: DeviceStatusDTO[];
  recentJobs: JobDTO[];
  uptimePercent?: number;
}

export interface DeviceStatusDTO {
  id: Id;
  type: string;
  model?: string;
  status: "idle" | "busy" | "error" | "offline" | "maintenance";
  healthStatus: "healthy" | "degraded" | "offline" | "unknown";
  adapterType?: string;
  capabilities: Id[];
}

// ── Evidence & Compliance DTOs ─────────────────────────────────────────────

export interface EvidenceSummaryDTO {
  id: Id;
  jobId: Id;
  stepId: Id;
  assuranceTier: AssuranceTier;
  eventCount: number;
  bundleHash: string;
  createdAt: Timestamp;
  /** Whether this bundle has been verified */
  verified: boolean;
  /** CID if stored on IPFS */
  storageCid?: string;
}

/** ALCOA+ compliance status — each principle maps to a boolean check */
export interface ALCOAStatus {
  /** Who recorded the data — source.deviceId + source.kernelId must be present */
  attributable: boolean;
  /** Data is readable and hash-verifiable */
  legible: boolean;
  /** Timestamps fall within the execution window */
  contemporaneous: boolean;
  /** Bundle came directly from the kernel (signature present, not test-signed) */
  original: boolean;
  /** Tier requirements satisfied, event hashes verified */
  accurate: boolean;
  /** No high/critical duration_mismatch drift alerts */
  consistent: boolean;
  /** All required tier event types present — no sensor_gap alerts */
  complete: boolean;
  /** Verifier confidence ≥ 90 (or true when no attestations available) */
  credible: boolean;
  /** Evidence stored on IPFS / Storacha — durable reference */
  enduring: boolean;
  /** Bundle accessible via gateway and storage CID */
  available: boolean;
}

export interface ComplianceReportDTO {
  capabilityId: Id;
  kernelId: Id;
  /** ISO standards this evidence chain satisfies */
  satisfiedStandards: string[];
  /** ALCOA+ compliance checks */
  alcoaStatus: ALCOAStatus;
  /** Tier compliance */
  tierCompliance: Record<AssuranceTier, boolean>;
  /** Recent evidence bundles */
  recentEvidence: EvidenceSummaryDTO[];
  /** Drift detection results (telemetry vs CWM expected) */
  driftAlerts: DriftAlertDTO[];
}

/** Result of checking a bundle against tier requirements */
export interface TierComplianceResult {
  tier: AssuranceTier;
  compliant: boolean;
  missingEventTypes: string[];
  presentEventTypes: string[];
  totalEvents: number;
  minimumRequired: number;
}

/** Aggregated result from multiple verifier attestations */
export interface AggregatedAttestationDTO {
  jobId: string;
  attestations: Array<{
    verifierId: string;
    result: "valid" | "invalid" | "inconclusive";
    confidence: number;
    timestamp: string;
  }>;
  consensus: "valid" | "invalid" | "inconclusive" | "no_quorum";
  quorumRequired: number;
  quorumAchieved: number;
  aggregatedConfidence: number;
}

export interface DriftAlertDTO {
  type: "power_anomaly" | "temperature_excursion" | "duration_mismatch" | "sensor_gap";
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  expectedValue?: string;
  actualValue?: string;
  timestamp: Timestamp;
}

// ── Settlement DTOs ────────────────────────────────────────────────────────

export interface EscrowSummaryDTO {
  id: Id;
  jobId: Id;
  status: EscrowStatus;
  totalAmount: Amount;
  currency: Currency;
  milestoneCount: number;
  releasedCount: number;
  disputedCount: number;
  challengeWindowEnd?: Timestamp;
}

export interface SettlementResultDTO {
  jobId: Id;
  escrowId: Id;
  status: "settled" | "disputed" | "refunded";
  releasedAmount: Amount;
  protocolFee: Amount;
  txHash?: string;
  chain: string;
}

// ── Agent / RBAC DTOs ──────────────────────────────────────────────────────

/** Agent roles for RBAC enforcement */
export type AgentRole =
  | "discovery"
  | "negotiation"
  | "escrow"
  | "execution"
  | "verification"
  | "settlement"
  | "operator"
  | "admin";

/** Per-role facade access matrix */
export interface AgentPermissions {
  role: AgentRole;
  allowedFacades: string[];
  allowedActions: string[];
  forbiddenActions: string[];
}

/** SoD constraint: these role pairs cannot be the same DID on the same job */
export const SOD_CONFLICTS: ReadonlyArray<[AgentRole, AgentRole]> = [
  ["execution", "verification"],
  ["escrow", "verification"],
  ["execution", "settlement"],
] as const;

/** Agent session context passed through the facade layer */
export interface AgentContext {
  did: string;
  role: AgentRole;
  sessionId: string;
  permissions: AgentPermissions;
  /** The job ID this agent is operating on (for SoD checks) */
  jobId?: Id;
}

/**
 * Full agent session record (in-memory, per gateway lifecycle).
 * Supersedes AgentContext — the session is the source of truth.
 *
 * ASI03 (OWASP Identity and Privilege Abuse): Sessions have a hard TTL enforced
 * via `expiresAt`. Sessions older than this are rejected by getAgentContext() and
 * must be re-issued via registerAgent() or createSession().
 */
export interface AgentSession {
  sessionId: string;
  agentId: string;
  did: string;
  role: AgentRole;
  permissions: AgentPermissions;
  /** Job ID this session is bound to (optional — for SoD tracking) */
  jobId?: Id;
  /** Unix ms timestamp of session creation */
  createdAt: number;
  /** Unix ms timestamp of last activity */
  lastActivity: number;
  /**
   * Unix ms timestamp when this session expires (ASI03 TTL enforcement).
   *
   * Default: 1 hour from creation (SESSION_TTL_MS).
   * Role-specific TTLs may be shorter (see ROLE_TTL_MS in agent.facade.ts).
   * Sessions past this timestamp are rejected with SESSION_EXPIRED (401).
   * Use refreshSession() to extend TTL before expiry.
   */
  expiresAt: number;
  /** false after revokeSession / revokeAllForDid */
  active: boolean;
}
