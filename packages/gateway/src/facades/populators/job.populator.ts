/**
 * Job Populator — transforms raw Job DB rows into JobDTOs and JobDetailDTOs.
 *
 * Handles enrichment: kernelName, capabilityType, evidenceCount, escrowStatus.
 * Accepts PopulationContext to batch-load shared data and avoid N+1.
 */

import type {
  JobDTO,
  JobDetailDTO,
  JobTimelineEvent,
  EvidenceSummaryDTO,
  EscrowSummaryDTO,
  PopulationContext,
} from "../types.js";

/** Raw job row returned by JobRepository (drizzle infer type) */
export interface RawJob {
  id: string;
  stepId: string;
  cwmId: string;
  capabilityId: string;
  kernelId: string;
  status: string;
  assignedDevices: string[];
  startedAt: string | null;
  completedAt: string | null;
  progress: number;
  evidenceBundleId: string | null;
  parameters: Record<string, unknown> | null;
  /** Real assurance tier from the jobs row. Null/undefined = legacy row
   *  (pre-column) — treated as tier 0 (self-attested). */
  assuranceTier?: number | null;
}

/**
 * Normalize a raw tier value to the AssuranceTier union (0|1|2|3).
 * Null/undefined (legacy rows) and non-finite values collapse to tier 0 —
 * the weakest claim — so the DTO never over-reports an SLA grade.
 */
export function normalizeAssuranceTier(raw: number | null | undefined): JobDTO["assuranceTier"] {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.min(3, Math.max(0, Math.trunc(raw))) as JobDTO["assuranceTier"];
}

/** Raw capability row for type lookup */
interface RawCapability {
  id: string;
  type: string;
  name: string;
  [key: string]: unknown;
}

/** Raw evidence bundle row */
interface RawEvidenceBundle {
  id: string;
  jobId: string;
  stepId: string;
  kernelId?: string;
  assuranceTier?: number;
  bundleHash?: string;
  createdAt?: string;
  verified?: boolean;
  storageCid?: string;
  events?: unknown[];
  [key: string]: unknown;
}

/**
 * Populate a single raw Job row into a JobDTO.
 * Requires pre-loaded kernel map and capability map to avoid N+1.
 */
export function populateJobDTO(
  model: RawJob,
  kernelMap: Map<string, any>,
  capabilityMap: Map<string, RawCapability>,
  ctx: PopulationContext,
  evidenceCount?: number,
  escrowStatus?: string,
): JobDTO {
  const kernel = kernelMap.get(model.kernelId);
  const capability = capabilityMap.get(model.capabilityId);

  return {
    id: model.id,
    capabilityId: model.capabilityId,
    kernelId: model.kernelId,
    status: model.status as JobDTO["status"],
    progress: model.progress ?? undefined,
    assuranceTier: normalizeAssuranceTier(model.assuranceTier),
    createdAt: model.startedAt ?? new Date().toISOString(),
    updatedAt: model.completedAt ?? undefined,
    // Enrichment
    kernelName: kernel?.name,
    capabilityType: capability?.type as JobDTO["capabilityType"],
    evidenceCount: evidenceCount ?? 0,
    escrowStatus: escrowStatus as JobDTO["escrowStatus"],
    estimatedCompletion: undefined,
  };
}

/**
 * Populate a raw Job row into a full JobDetailDTO with timeline and evidence.
 */
export function populateJobDetailDTO(
  model: RawJob,
  kernelMap: Map<string, any>,
  capabilityMap: Map<string, RawCapability>,
  evidenceBundles: RawEvidenceBundle[],
  ctx: PopulationContext,
  escrow?: EscrowSummaryDTO,
): JobDetailDTO {
  const base = populateJobDTO(
    model,
    kernelMap,
    capabilityMap,
    ctx,
    evidenceBundles.length,
    escrow?.status,
  );

  const evidenceSummaries: EvidenceSummaryDTO[] = evidenceBundles.map((b) => ({
    id: b.id,
    jobId: b.jobId,
    stepId: b.stepId,
    assuranceTier: (b.assuranceTier ?? 0) as EvidenceSummaryDTO["assuranceTier"],
    eventCount: Array.isArray(b.events) ? b.events.length : 0,
    bundleHash: b.bundleHash ?? "",
    createdAt: b.createdAt ?? new Date().toISOString(),
    verified: b.verified ?? false,
    storageCid: b.storageCid ?? undefined,
  }));

  const timeline = buildTimeline(model, evidenceBundles);

  return {
    ...base,
    timeline,
    evidenceBundles: evidenceSummaries,
    escrow,
  };
}

/**
 * Batch-populate jobs from pre-loaded maps.
 * Call this when listing jobs to prevent N+1.
 */
export function populateJobList(
  models: RawJob[],
  kernelMap: Map<string, any>,
  capabilityMap: Map<string, RawCapability>,
  ctx: PopulationContext,
  evidenceCountMap?: Map<string, number>,
  escrowStatusMap?: Map<string, string>,
): JobDTO[] {
  return models.map((model) =>
    populateJobDTO(
      model,
      kernelMap,
      capabilityMap,
      ctx,
      evidenceCountMap?.get(model.id),
      escrowStatusMap?.get(model.id),
    ),
  );
}

// ── Private helpers ────────────────────────────────────────────────────────

function buildTimeline(model: RawJob, evidenceBundles: RawEvidenceBundle[]): JobTimelineEvent[] {
  const events: JobTimelineEvent[] = [];
  const createdAt = model.startedAt ?? new Date().toISOString();

  events.push({ type: "queued", timestamp: createdAt });

  if (model.status !== "queued" && model.status !== "failed") {
    events.push({ type: "started", timestamp: createdAt });
  }

  for (const bundle of evidenceBundles) {
    events.push({
      type: "evidence_received",
      timestamp: bundle.createdAt ?? createdAt,
      details: { bundleId: bundle.id, bundleHash: bundle.bundleHash },
    });
    if (bundle.verified) {
      events.push({
        type: "verified",
        timestamp: bundle.createdAt ?? createdAt,
        details: { bundleId: bundle.id },
      });
    }
  }

  if (model.progress > 0) {
    events.push({
      type: "progress",
      timestamp: model.completedAt ?? createdAt,
      details: { progress: model.progress },
    });
  }

  if (model.status === "settled" || model.status === "completed") {
    events.push({ type: "settled", timestamp: model.completedAt ?? createdAt });
  } else if (model.status === "failed") {
    events.push({ type: "failed", timestamp: model.completedAt ?? createdAt });
  } else if (model.status === "disputed") {
    events.push({ type: "disputed", timestamp: model.completedAt ?? createdAt });
  }

  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return events;
}
