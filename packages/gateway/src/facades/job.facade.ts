/**
 * Job Facade — job lifecycle management, submission, and status tracking.
 *
 * Maps to L1.4 (Job Execution) in the standards taxonomy.
 * Replaces inline DB access in routes/jobs.ts and routes/job-submit.ts
 * with standardized populator-based DTOs.
 */

import { v4 as uuidv4 } from "uuid";
import { type Result, ok, err, Errors } from "@pcc/spec";
import { BaseFacade } from "./base.facade.js";
import type {
  JobDTO,
  JobDetailDTO,
  PopulationContext,
  AgentRole,
  PaginationParams,
  PaginatedResult,
} from "./types.js";
import {
  populateJobDTO,
  populateJobDetailDTO,
  populateJobList,
} from "./populators/job.populator.js";
import { getKernelService } from "../services/kernel-service.js";
import { auditService } from "../services/audit-service.js";
import { pipelineTelemetry } from "../telemetry.js";
import { trackServerEvent } from "../services/posthog-service.js";
import { recordOperatorStage } from "../services/funnel-tracker.js";

/**
 * Adapters that never count toward the operator-onboarding funnel's
 * adapter_ready stage: "mock" is the test/simulator adapter and
 * "generic-http" is the catch-all placeholder adapter — neither proves a
 * real machine is reachable. Mirrors the unmerged onboarding-readiness.ts's
 * NON_EXECUTING_ADAPTERS set (see item4-stage-inventory.md). Exported so it
 * can be unit-tested independent of KernelService/adapter wiring.
 */
export function isRealAdapterHealthy(
  healthy: boolean,
  adapterType: string | null | undefined,
): boolean {
  return healthy === true && isExecutingAdapter(adapterType);
}

/** A real adapter: not the "mock" simulator and not the "generic-http" placeholder. */
export function isExecutingAdapter(adapterType: string | null | undefined): boolean {
  return !!adapterType && adapterType !== "mock" && adapterType !== "generic-http";
}

/** A device-row snapshot shape sufficient to detect a revision change. */
export interface DeviceRevisionSnapshot {
  kernelId?: string | null;
  adapterType?: string | null;
  adapterConfig?: string | null;
  lastUpdated?: string | null;
}

/**
 * Whether two device-row snapshots are the exact same revision: both rows
 * must exist, and kernelId, adapterType, adapterConfig and lastUpdated must
 * all be strictly equal. `lastUpdated` is bumped on every register/
 * re-register (routes/setup.ts), so this catches a device moved to another
 * kernel, re-adapted, or simply re-registered with byte-identical fields
 * between a "before" snapshot and an "after" read — none of those describe
 * one continuous, uninterrupted registration (#469 round 2 R1/R3). A
 * health-status-only write (repos.kernels.updateHealth) does NOT touch
 * lastUpdated, so it never trips this check on its own.
 */
export function sameDeviceRevision(
  before: DeviceRevisionSnapshot | undefined,
  after: DeviceRevisionSnapshot | undefined,
): boolean {
  if (!before || !after) return false;
  return (
    before.kernelId === after.kernelId &&
    before.adapterType === after.adapterType &&
    before.adapterConfig === after.adapterConfig &&
    before.lastUpdated === after.lastUpdated
  );
}

// ── Input interfaces ────────────────────────────────────────────────────────

export interface JobFilters {
  kernelId?: string;
  status?: string;
  /** Wave 4.1.x — when set (typically by tenantOpts(req) at the route layer
   *  under TENANT_ENFORCE), filters rows to this tenant. Omitted = today's
   *  cross-tenant default. */
  tenantId?: string;
}

export interface SubmitJobInput {
  jobId?: string;
  stepId: string;
  kernelId: string;
  capabilityId?: string;
  deviceId?: string;
  gcodeHash?: string;
  assuranceTier?: number;
  capabilityType?: string;
  description?: string;
  title?: string;
  parameters?: Record<string, unknown>;
}

export interface JobSubmitResult {
  jobId: string;
  deviceId: string | null;
  status: "queued" | "accepted";
}

export interface JobStatusResult {
  jobId: string;
  status: string;
  progress?: number;
  deviceId: string | null;
  evidenceBundleId: string | null;
}

export interface RegisterDeviceInput {
  kernelId: string;
  id: string;
  type: string;
  model: string;
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
  capabilities?: string[];
}

// ── Type-alias map for capability fuzzy matching ───────────────────────────

const TYPE_ALIASES: Record<string, string[]> = {
  "document-printing": ["print", "printer", "document", "paper", "copy", "scan", "laser", "inkjet", "color", "page", "doc"],
  "2d-print": ["print", "printer", "document", "paper", "poster", "wide-format", "inkjet", "page", "2d"],
  "liquid-handler": ["pipette", "liquid", "lab", "assay", "hplc", "ot-2", "opentrons", "plate", "well", "dilution"],
  "fdm": ["3d-print", "fdm", "filament", "pla", "abs", "petg", "extrusion", "3d", "print"],
  "cnc-3axis": ["cnc", "mill", "machining", "metal", "aluminum", "milling"],
  "laser-cut": ["laser", "cut", "engrave", "acrylic", "wood", "engraving"],
  "sla": ["resin", "sla", "dlp", "stereolithography"],
  "pcr": ["pcr", "qpcr", "genomics", "dna", "amplification"],
  "sequencing": ["sequencing", "nanopore", "genome", "dna", "rna"],
  "hplc": ["hplc", "chromatography", "analysis", "separation"],
  "mass-spec": ["mass-spec", "massspec", "spectrometry", "peptide", "metabolomics"],
  "electrophysiology": ["patch-clamp", "ephys", "electrophysiology", "neural", "neuron"],
  "microscopy": ["microscopy", "microscope", "imaging", "fluorescence", "confocal"],
  "centrifuge": ["centrifuge", "spin", "separation", "sample-prep"],
  "cell-culture": ["cell-culture", "incubation", "mammalian", "cell-line"],
  "sample-prep": ["sample-prep", "preparation", "liquid-handling", "automation"],
  "assay": ["assay", "plate-reader", "absorbance", "fluorescence", "screening"],
};

// ── Facade ─────────────────────────────────────────────────────────────────

export class JobFacade extends BaseFacade {
  protected readonly allowedRoles: readonly AgentRole[] = [
    "discovery",
    "negotiation",
    "execution",
    "operator",
    "admin",
  ];

  constructor() {
    super("job");
  }

  /**
   * List jobs with optional kernel/status filtering and enrichment.
   * Replaces: GET /api/jobs
   */
  async list(
    filters?: JobFilters,
    ctx?: Partial<PopulationContext>,
    pagination?: PaginationParams,
  ): Promise<Result<PaginatedResult<JobDTO>>> {
    return this.execute("list", async () => {
      const context = this.defaultContext(ctx);
      const offset = pagination?.offset ?? 0;
      const limit = pagination?.limit ?? 50;

      const opts = filters?.tenantId ? { tenantId: filters.tenantId } : undefined;
      let jobs;
      if (filters?.kernelId && filters?.status) {
        jobs = this.repos.jobs.findByKernelAndStatus(filters.kernelId, filters.status, opts);
      } else if (filters?.kernelId) {
        jobs = this.repos.jobs.findByKernel(filters.kernelId, opts);
      } else if (filters?.status) {
        jobs = this.repos.jobs.findByStatus(filters.status, opts);
      } else {
        jobs = this.repos.jobs.findAll(opts);
      }

      const total = jobs.length;
      const page = jobs.slice(offset, offset + limit);

      // Batch-load kernels and capabilities to avoid N+1
      const kernelIds = [...new Set(page.map((j) => j.kernelId))];
      const kernelMap = this.loadKernelMap(kernelIds);
      const capabilityIds = [...new Set(page.map((j) => j.capabilityId))];
      const capabilityMap = this.loadCapabilityMap(capabilityIds);

      const items = populateJobList(page, kernelMap, capabilityMap, context);

      return { items, total, offset, limit, hasMore: offset + limit < total };
    });
  }

  /**
   * Get a single job by ID with evidence bundles.
   * Replaces: GET /api/jobs/:jobId
   */
  async getById(
    jobId: string,
    ctx?: Partial<PopulationContext>,
  ): Promise<Result<JobDetailDTO>> {
    return this.execute("getById", async () => {
      const context = this.defaultContext(ctx);

      const job = this.repos.jobs.findById(jobId);
      if (!job) {
        throw new NotFoundError("job", jobId);
      }

      const kernelMap = this.loadKernelMap([job.kernelId]);
      const capabilityMap = this.loadCapabilityMap([job.capabilityId]);
      const evidenceBundles = this.repos.evidence.findByJob(jobId);

      return populateJobDetailDTO(job, kernelMap, capabilityMap, evidenceBundles, context);
    });
  }

  /**
   * Update job status (and optional progress).
   * Replaces: PATCH /api/jobs/:jobId/status
   */
  async updateStatus(
    jobId: string,
    status: string,
    progress?: number,
  ): Promise<Result<JobDTO>> {
    return this.execute("updateStatus", async () => {
      const updated = this.repos.jobs.updateStatus(jobId, status, progress);
      if (!updated) {
        throw new NotFoundError("job", jobId);
      }

      const kernelMap = this.loadKernelMap([updated.kernelId]);
      const capabilityMap = this.loadCapabilityMap([updated.capabilityId]);

      return populateJobDTO(updated, kernelMap, capabilityMap, this.defaultContext());
    });
  }

  /**
   * Submit a new job — fire-and-forget async execution pattern.
   * Handles capability fuzzy matching, DB persistence, external kernel routing,
   * and local KernelService dispatch.
   * Replaces: POST /api/jobs/submit
   */
  async submit(
    body: SubmitJobInput,
    actorId?: string,
    ip?: string,
    userAgent?: string,
  ): Promise<Result<JobSubmitResult>> {
    return this.execute("submit", async () => {
      const { stepId, kernelId, deviceId, gcodeHash, assuranceTier, parameters } = body;

      if (!stepId) {
        return this.badRequest("missing_step_id", "stepId is required");
      }
      if (!kernelId) {
        return this.badRequest("missing_kernel_id", "kernelId is required");
      }

      const jobId = body.jobId ?? `job-${uuidv4()}`;

      // Resolve capability ID (fuzzy match if not provided)
      let resolvedCapabilityId = body.capabilityId;
      if (!resolvedCapabilityId) {
        const caps = this.repos.capabilities.findByKernel(kernelId);
        if (caps.length === 0) {
          return this.badRequest("no_capability_found_for_kernel", "No capabilities found for this kernel");
        }
        const resolved = this.resolveCapabilityId(caps, body);
        if (!resolved) {
          return this.badRequest("no_capability_found_for_kernel", "Could not resolve capability for this job");
        }
        resolvedCapabilityId = resolved;
      }

      // Insert job to DB (status = queued)
      this.repos.jobs.insert({
        id: jobId,
        stepId,
        cwmId: `cwm-${uuidv4()}`,
        capabilityId: resolvedCapabilityId,
        kernelId,
        status: "queued",
        assignedDevices: deviceId ? [deviceId] : [],
        startedAt: new Date().toISOString(),
        progress: 0,
        parameters: parameters ?? null,
        // F8 — persist the tier the job was submitted at (default 0 =
        // self-attested) so JobDTOs report the real value, not a hardcoded 0.
        assuranceTier: typeof assuranceTier === "number" ? assuranceTier : 0,
      });

      // Determine if this is an external kernel (daemon will pick up the job)
      let svc;
      try {
        svc = getKernelService();
      } catch {
        // KernelService not initialized — treat as external kernel path
        pipelineTelemetry.emit(jobId, "job_submit", "completed", {
          metadata: { kernelId, stepId, external: true },
        });
        return { jobId, deviceId: null, status: "queued" as const };
      }

      const localKernelId = (svc as any).config?.kernelId;
      const isExternalKernel = localKernelId && kernelId !== localKernelId;

      if (isExternalKernel) {
        pipelineTelemetry.emit(jobId, "job_submit", "completed", {
          metadata: { kernelId, stepId, external: true },
        });
        trackServerEvent("job_submitted", { kernelId, capabilityType: body.capabilityId, external: true }, actorId);
        auditService.log({
          eventType: "job.submitted",
          actor: actorId,
          resourceType: "job",
          resourceId: jobId,
          action: "create",
          metadata: { kernelId, stepId, external: true, assuranceTier },
          ip,
          userAgent,
        });
        return { jobId, deviceId: null, status: "queued" as const };
      }

      // Local kernel: fire-and-forget via KernelService
      try {
        const result = await svc.submitJob({ jobId, stepId, deviceId, gcodeHash, assuranceTier });
        pipelineTelemetry.emit(result.jobId, "job_submit", "completed", {
          metadata: { kernelId, stepId, deviceId: result.deviceId },
        });
        trackServerEvent("job_submitted", { kernelId, capabilityType: body.capabilityId }, actorId);
        auditService.log({
          eventType: "job.submitted",
          actor: actorId,
          resourceType: "job",
          resourceId: result.jobId,
          action: "create",
          metadata: { kernelId, stepId, deviceId: result.deviceId, assuranceTier },
          ip,
          userAgent,
        });
        return { jobId: result.jobId, deviceId: result.deviceId ?? null, status: result.status as "queued" | "accepted" };
      } catch (error) {
        // Roll back DB record
        try {
          this.repos.jobs.updateStatus(jobId, "failed");
        } catch {
          // best-effort rollback
        }
        throw error;
      }
    });
  }

  /**
   * Get job execution status — hybrid: KernelService in-memory + DB fallback.
   * Replaces: GET /api/jobs/:jobId/status
   */
  async getStatus(jobId: string): Promise<Result<JobStatusResult>> {
    return this.execute("getStatus", async () => {
      let svc;
      try {
        svc = getKernelService();
      } catch {
        // KernelService not initialized — fall back to DB only
        const job = this.repos.jobs.findById(jobId);
        if (!job) throw new NotFoundError("job", jobId, "not_found");
        return {
          jobId,
          status: job.status,
          progress: job.progress,
          deviceId: job.assignedDevices[0] ?? null,
          evidenceBundleId: job.evidenceBundleId ?? null,
        };
      }

      const result = await svc.getJobStatus(jobId);
      if (result.status === "unknown") {
        // DB fallback
        const job = this.repos.jobs.findById(jobId);
        if (!job) throw new NotFoundError("job", jobId, "not_found");
        return {
          jobId,
          status: job.status,
          progress: job.progress,
          deviceId: job.assignedDevices[0] ?? null,
          evidenceBundleId: job.evidenceBundleId ?? null,
        };
      }

      return {
        jobId,
        status: result.status,
        progress: result.progress,
        deviceId: result.deviceId ?? null,
        evidenceBundleId: result.evidenceBundleId ?? null,
      };
    });
  }

  /**
   * Register a device for a kernel.
   * Replaces: POST /api/devices/register
   */
  async registerDevice(
    body: RegisterDeviceInput,
  ): Promise<Result<{ device: unknown }>> {
    return this.execute("registerDevice", async () => {
      const { kernelId, id, type, model, adapterType, adapterConfig, capabilities } = body;

      if (!kernelId || !id || !type || !model || !adapterType) {
        return this.badRequest("missing_required_fields", "kernelId, id, type, model, adapterType are all required");
      }

      const kernel = this.repos.kernels.findById(kernelId);
      if (!kernel) {
        return this.badRequest("kernel_not_found", `Kernel '${kernelId}' not found`);
      }

      const device = this.repos.kernels.insertDevice({
        id,
        kernelId,
        type,
        model,
        firmware: "unknown",
        status: "idle",
        contributesToCapabilities: capabilities ?? [],
        lastUpdated: new Date().toISOString(),
        adapterType,
        adapterConfig: adapterConfig ? JSON.stringify(adapterConfig) : undefined,
        capabilities: capabilities ?? [],
        healthStatus: "healthy",
      });

      return { device };
    });
  }

  /**
   * Get devices for a kernel.
   * Replaces: GET /api/devices/:kernelId
   */
  async getDevicesForKernel(kernelId: string): Promise<Result<unknown[]>> {
    return this.execute("getDevicesForKernel", async () => {
      return this.repos.kernels.findDevicesByKernel(kernelId);
    });
  }

  /**
   * Trigger a health check on a device.
   * Replaces: POST /api/devices/:deviceId/health
   */
  async checkDeviceHealth(
    deviceId: string,
    opts: { operatorId?: string | null } = {},
  ): Promise<Result<{ healthy: boolean; details: unknown }>> {
    return this.execute("checkDeviceHealth", async () => {
      const svc = getKernelService();
      // Snapshot the device row BEFORE the check, so the funnel attributes the
      // result to the device that was actually checked (#469 round 1).
      let before: DeviceRevisionSnapshot | undefined;
      try {
        before = this.repos.kernels.findDeviceById(deviceId);
      } catch {
        before = undefined;
      }
      const result = await svc.checkDeviceHealth(deviceId);

      // Update DB health record (best-effort)
      try {
        this.repos.kernels.updateHealth(
          deviceId,
          result.healthy ? "healthy" : "offline",
          Math.floor(Date.now() / 1000),
        );
      } catch {
        // non-fatal
      }

      // Operator-onboarding funnel (ADK track item 4): adapter_ready. Only a
      // REAL adapter (not mock/generic-http) that is actually healthy
      // counts. kernelId + adapterType are resolved from the device's own
      // DB row (the health-check route only has deviceId) — if the row
      // can't be found, there's nothing to attribute the stage to, so we
      // don't record. Telemetry must never break a health-check response.
      // Recorded only for an authenticated caller, and only if the device row is
      // the SAME REVISION across the check (kernelId, adapterType, adapterConfig
      // and lastUpdated all unchanged): a device moved to another kernel, given
      // another adapter, or simply re-registered mid-check — even with
      // byte-identical config, since lastUpdated still bumps — is not
      // attributed to either (#469 round 1 + round 2 R3).
      try {
        const after = this.repos.kernels.findDeviceById(deviceId);
        if (
          opts.operatorId &&
          before?.kernelId &&
          sameDeviceRevision(before, after) &&
          isRealAdapterHealthy(result.healthy, before.adapterType)
        ) {
          recordOperatorStage(before.kernelId, "adapter_ready", { deviceId, operatorId: opts.operatorId });
        }
      } catch {
        /* funnel tracking must never break a health-check response */
      }

      return { healthy: result.healthy, details: result.details ?? null };
    });
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /** Return a bad-request result (shorthand used inside execute()) */
  private badRequest<T>(code: string, message: string): T {
    throw Object.assign(new Error(message), { name: "BadRequestError", code });
  }

  private loadKernelMap(kernelIds: string[]): Map<string, any> {
    const map = new Map<string, any>();
    try {
      // Single IN-list query (chunked inside the repo) — true N+1 prevention.
      for (const kernel of this.repos.kernels.findByIds([...new Set(kernelIds)])) {
        map.set(kernel.id, kernel);
      }
    } catch {
      // Non-fatal
    }
    return map;
  }

  private loadCapabilityMap(capabilityIds: string[]): Map<string, any> {
    const map = new Map<string, any>();
    try {
      // Single IN-list query (chunked inside the repo) — true N+1 prevention.
      for (const cap of this.repos.capabilities.findByIds([...new Set(capabilityIds)])) {
        map.set(cap.id, cap);
      }
    } catch {
      // Non-fatal
    }
    return map;
  }

  /**
   * Fuzzy-match a capability from the kernel's available capabilities.
   * Returns the best-matching capability ID, or the first one as fallback.
   */
  private resolveCapabilityId(caps: any[], body: SubmitJobInput): string | null {
    if (caps.length === 0) return null;

    const searchTerms = [
      body.stepId,
      body.capabilityType,
      body.description,
      body.title,
    ].filter(Boolean).join(" ").toLowerCase();

    const scored = caps.map((cap) => {
      const capText = [
        cap.type,
        cap.name,
        cap.description,
        ...(cap.materials || []),
        ...(cap.tags || []),
      ].join(" ").toLowerCase();

      let score = 0;

      // Exact type match wins
      if (body.capabilityType && cap.type === body.capabilityType) score += 100;

      // Keyword overlap
      const keywords = searchTerms.split(/\s+/);
      for (const kw of keywords) {
        if (kw.length < 3) continue;
        if (capText.includes(kw)) score += 10;
      }

      // Type alias matching
      const aliases = TYPE_ALIASES[cap.type];
      if (aliases) {
        for (const alias of aliases) {
          if (searchTerms.includes(alias)) score += 20;
        }
      }

      return { cap, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].score > 0 ? scored[0].cap.id : caps[0].id;
  }
}

/** Internal error for flow control — caught by BaseFacade.execute() */
class NotFoundError extends Error {
  readonly code?: string;
  constructor(entity: string, id: string, code?: string) {
    super(`${entity} '${id}' not found`);
    this.name = "NotFoundError";
    if (code) this.code = code;
  }
}
