/**
 * Kernel Populator — transforms raw ShopKernel DB rows into KernelDTOs and KernelHealthSnapshots.
 *
 * Handles enrichment: capabilityCount, capabilityTypes, isStale, activeJobCount, devices.
 * Encapsulates the 5-minute staleness detection logic so it never leaks into routes.
 * Applies reputation decay (exponential half-life) and cold-start tier gating at read time.
 */

import type {
  KernelDTO,
  KernelHealthSnapshot,
  DeviceStatusDTO,
  JobDTO,
  PopulationContext,
} from "../types.js";
import { getReputationService } from "../../services/reputation-service.js";
import { isKernelStale } from "./staleness.js";
import { normalizeAssuranceTier } from "./job.populator.js";

/**
 * Raw kernel DB row — matches what KernelRepository.findById/findAll returns.
 * The spec's ShopKernel type has `capabilities: Capability[]` as a required field
 * that is only populated in-memory (never from the DB). We use this local type
 * to avoid casting issues throughout the populator layer.
 */
export interface RawKernel {
  id: string;
  name: string;
  operatorAddress: string;
  location: { lat: number; lng: number };
  physicalAddress: string;
  maxAssuranceTier: number;
  publicKey: string;
  /** Proven secp256k1 signing address (checksummed 0x…); null when unproven. */
  signingAddress?: string | null;
  reputation: number;
  totalJobsCompleted: number;
  /** ISO timestamp of last reputation write; used for decay computation. Null for legacy rows. */
  reputationUpdatedAt?: string | null;
  status: string;
  registeredAt: string;
  lastHeartbeat: string;
  version: string;
  did?: string;
  [key: string]: unknown;
}

/** Raw capability row (subset we care about for populating kernels) */
interface RawCapability {
  id: string;
  type: string;
  kernelId: string;
  [key: string]: unknown;
}

/** Raw device row returned by KernelRepository.findDevicesByKernel */
interface RawDevice {
  id: string;
  type: string;
  model?: string | null;
  status?: string | null;
  healthStatus?: string | null;
  adapterType?: string | null;
  adapterConfig?: string | null;
  capabilities?: string[] | null;
  contributesToCapabilities?: string[] | null;
  lastHealthCheck?: number | null;
  [key: string]: unknown;
}

/** Raw job row (minimal subset for recent-jobs list) */
interface RawJob {
  id: string;
  capabilityId: string;
  kernelId: string;
  status: string;
  progress: number;
  startedAt: string | null;
  completedAt: string | null;
  /** Real assurance tier from the jobs row; null/undefined = legacy row (tier 0). */
  assuranceTier?: number | null;
}

/**
 * Populate a single ShopKernel into a KernelDTO.
 * Capability types and staleness are computed from pre-loaded data.
 */
export function populateKernelDTO(
  model: RawKernel,
  capabilities: RawCapability[],
  ctx: PopulationContext,
  activeJobCount?: number,
): KernelDTO {
  const capabilityTypes = capabilities.map((c) => c.type);
  const capabilityCount = capabilities.length;

  // A kernel with an active listing (≥1 capability) is open for business and
  // gets a keepalive grace, so low-traffic operators stay available without
  // periodic heartbeats. Kernels with no listing keep the bare 5-min threshold.
  const isStale = isKernelStale(model.status, model.lastHeartbeat, capabilityCount > 0);

  const reputationService = getReputationService();
  const totalJobsCompleted = model.totalJobsCompleted ?? 0;

  // Reputation: use pre-loaded cache (already decay-adjusted) when available,
  // otherwise compute decay on the fly from the raw model fields.
  const reputation = ctx.includeReputation
    ? (ctx.reputationCache?.get(model.id) ??
        reputationService.computeEffectiveReputation(
          model.reputation,
          model.reputationUpdatedAt ?? null,
          totalJobsCompleted,
        ))
    : model.reputation;

  // Cold-start tier gate: cap maxAssuranceTier to what the operator has earned.
  // Only applies when ctx.applyColdStartGate is true (opt-in per call site).
  const effectiveReputation = ctx.applyColdStartGate
    ? reputationService.computeEffectiveReputation(
        model.reputation,
        model.reputationUpdatedAt ?? null,
        totalJobsCompleted,
      )
    : reputation;

  const maxAssuranceTier: KernelDTO["maxAssuranceTier"] = ctx.applyColdStartGate
    ? (Math.min(
        model.maxAssuranceTier ?? 2,
        reputationService.getMaxAllowedTier(effectiveReputation, totalJobsCompleted),
      ) as KernelDTO["maxAssuranceTier"])
    : ((model.maxAssuranceTier ?? 2) as KernelDTO["maxAssuranceTier"]);

  return {
    id: model.id,
    name: model.name,
    operatorAddress: model.operatorAddress,
    location: model.location,
    physicalAddress: model.physicalAddress ?? "",
    maxAssuranceTier,
    status: model.status as KernelDTO["status"],
    lastHeartbeat: model.lastHeartbeat ?? new Date().toISOString(),
    version: model.version ?? "0.1.0",
    // Proven signing identity (null when the kernel registered without a valid
    // proof-of-possession). Flows to GET /api/kernels/:id and GET /api/kernels.
    signingAddress: (model.signingAddress as string | null | undefined) ?? null,
    // Enrichment
    capabilityCount,
    capabilityTypes,
    /** Backward-compat alias for capabilityTypes (dashboard + tests use kernel.capabilities) */
    reputation,
    totalJobsCompleted,
    isStale,
    activeJobCount: activeJobCount ?? 0,
  };
}

/**
 * Populate a ShopKernel into a full KernelHealthSnapshot with devices and recent jobs.
 */
export function populateKernelHealthSnapshot(
  model: RawKernel,
  capabilities: RawCapability[],
  rawDevices: RawDevice[],
  recentJobs: RawJob[],
  ctx: PopulationContext,
  activeJobCount?: number,
): KernelHealthSnapshot {
  const base = populateKernelDTO(model, capabilities, ctx, activeJobCount);
  const devices = rawDevices.map(populateDeviceStatusDTO);
  const jobDTOs = recentJobs.map((job) => populateJobDTO(job, model));

  return {
    ...base,
    devices,
    recentJobs: jobDTOs,
    uptimePercent: computeUptimePercent(model),
  };
}

/**
 * Batch-populate a list of kernels from pre-loaded capability map.
 * Prevents N+1: capability map is (kernelId → RawCapability[]).
 */
export function populateKernelList(
  models: RawKernel[],
  capabilityMap: Map<string, RawCapability[]>,
  ctx: PopulationContext,
  activeJobCountMap?: Map<string, number>,
): KernelDTO[] {
  return models.map((model) =>
    populateKernelDTO(
      model,
      capabilityMap.get(model.id) ?? [],
      ctx,
      activeJobCountMap?.get(model.id),
    ),
  );
}

// ── Private helpers ────────────────────────────────────────────────────────

function populateDeviceStatusDTO(raw: RawDevice): DeviceStatusDTO {
  return {
    id: raw.id,
    type: raw.type,
    model: raw.model ?? undefined,
    status: ((raw.status ?? "offline") as DeviceStatusDTO["status"]),
    healthStatus: ((raw.healthStatus ?? "unknown") as DeviceStatusDTO["healthStatus"]),
    adapterType: raw.adapterType ?? undefined,
    capabilities: (raw.capabilities ?? raw.contributesToCapabilities ?? []) as string[],
  };
}

function populateJobDTO(job: RawJob, kernel: RawKernel): JobDTO {
  return {
    id: job.id,
    capabilityId: job.capabilityId,
    kernelId: kernel.id,
    status: job.status as JobDTO["status"],
    progress: job.progress ?? undefined,
    assuranceTier: normalizeAssuranceTier(job.assuranceTier),
    createdAt: job.startedAt ?? new Date().toISOString(),
    updatedAt: job.completedAt ?? undefined,
    kernelName: kernel.name,
    capabilityType: undefined,
    evidenceCount: 0,
    escrowStatus: undefined,
    estimatedCompletion: undefined,
  };
}

function computeUptimePercent(kernel: RawKernel): number | undefined {
  if (kernel.status === "online") return 100;
  if (kernel.status === "offline") return 0;
  if (kernel.status === "maintenance") return 50;
  return undefined;
}
