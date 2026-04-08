/**
 * Frontend DTO type definitions for PCC gateway facade responses.
 *
 * These are copied (not imported) from packages/gateway/src/facades/types.ts
 * to avoid a cross-package build dependency in the dashboard.
 * When the backend DTOs change, update this file to match.
 *
 * Contract: these types reflect exactly what the HTTP routes return after
 * sendResult() unwraps the Result<T> envelope. Route-level envelope wrappers
 * (e.g. { kernels: KernelDTO[] }) are NOT reflected here — those are handled
 * in the API client (gateway.ts).
 */

// ── Primitive aliases (mirrors @pcc/spec) ────────────────────────────────────

export type Id = string;
export type Timestamp = string; // ISO-8601
export type Amount = string;    // stringified number (USDC units)
export type Currency = string;  // e.g. "USDC"

export type AssuranceTier = 0 | 1 | 2 | 3;

export type CapabilityType = string; // e.g. "3d-printing", "cnc"

export type StepStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "disputed";

export type EscrowStatus =
  | "pending"
  | "funded"
  | "active"
  | "released"
  | "disputed"
  | "refunded"
  | "expired";

export interface GeoLocation {
  lat: number;
  lng: number;
  label?: string;
}

// ── Pagination ────────────────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ── Capability DTOs ───────────────────────────────────────────────────────────

export interface CapabilityDTO {
  id: Id;
  kernelId: Id;
  type: CapabilityType;
  name: string;
  description?: string;
  materials: string[];
  tolerances?: Record<string, unknown>;
  envelope?: Record<string, unknown>;
  assuranceTiers: AssuranceTier[];
  pricing: Record<string, unknown>;
  location: GeoLocation;
  tags?: string[];
  // ── Enrichment (not in raw model) ──
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

// ── Job DTOs ──────────────────────────────────────────────────────────────────

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
  kernelName?: string;
  capabilityType?: CapabilityType;
  evidenceCount?: number;
  escrowStatus?: EscrowStatus;
  estimatedCompletion?: Timestamp;
}

export interface JobTimelineEvent {
  type:
    | "queued"
    | "started"
    | "progress"
    | "evidence_received"
    | "verification_started"
    | "verified"
    | "settled"
    | "failed"
    | "disputed";
  timestamp: Timestamp;
  details?: Record<string, unknown>;
}

export interface JobDetailDTO extends JobDTO {
  timeline: JobTimelineEvent[];
  evidenceBundles: EvidenceSummaryDTO[];
  escrow?: EscrowSummaryDTO;
}

// ── Kernel DTOs ───────────────────────────────────────────────────────────────

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
  capabilityCount: number;
  capabilityTypes: CapabilityType[];
  reputation?: number;
  totalJobsCompleted: number;
  isStale: boolean;
  activeJobCount?: number;
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

export interface KernelHealthSnapshot extends KernelDTO {
  devices: DeviceStatusDTO[];
  recentJobs: JobDTO[];
  uptimePercent?: number;
}

// ── Evidence & Compliance DTOs ────────────────────────────────────────────────

export interface EvidenceSummaryDTO {
  id: Id;
  jobId: Id;
  stepId: Id;
  assuranceTier: AssuranceTier;
  eventCount: number;
  bundleHash: string;
  createdAt: Timestamp;
  verified: boolean;
  storageCid?: string;
}

export interface ALCOAStatus {
  attributable: boolean;
  legible: boolean;
  contemporaneous: boolean;
  original: boolean;
  accurate: boolean;
  consistent: boolean;
  complete: boolean;
  credible: boolean;
  enduring: boolean;
  available: boolean;
}

export interface DriftAlertDTO {
  type: "power_anomaly" | "temperature_excursion" | "duration_mismatch" | "sensor_gap";
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  expectedValue?: string;
  actualValue?: string;
  timestamp: Timestamp;
}

export interface ComplianceReportDTO {
  capabilityId: Id;
  kernelId: Id;
  satisfiedStandards: string[];
  alcoaStatus: ALCOAStatus;
  tierCompliance: Record<AssuranceTier, boolean>;
  recentEvidence: EvidenceSummaryDTO[];
  driftAlerts: DriftAlertDTO[];
}

// ── Settlement DTOs ───────────────────────────────────────────────────────────

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
