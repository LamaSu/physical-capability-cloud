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
import { NotFoundError, BadRequestError, ConflictError } from "./facade-errors.js";
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
import {
  populateDeviceRegistrationDTO,
  type DeviceRegistrationDTO,
} from "./populators/device.populator.js";
import { getKernelService } from "../services/kernel-service.js";
import { localJobDispatchDecision } from "../services/local-job-dispatch.js";
import { auditService } from "../services/audit-service.js";
import { pipelineTelemetry } from "../telemetry.js";
import { trackServerEvent } from "../services/posthog-service.js";
import { safeServerEventProperties, safeServerEventDistinctId } from "../services/posthog-policy.js";
import { logSafeId } from "../redaction.js";
import { writeJobStatusGuarded, SETTLEMENT_OWNED_MESSAGE } from "../services/settlement-owned-status.js";
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

// ── Input interfaces ────────────────────────────────────────────────────────

export interface JobFilters {
  kernelId?: string;
  status?: string;
  /** Wave 4.1.x — when set (typically by tenantOpts(req) at the route layer
   *  under TENANT_ENFORCE), filters rows to this tenant. Omitted = today's
   *  cross-tenant default. */
  tenantId?: string;
  /** Only these jobs: the ids the caller may read (jobReadScopeOf). Applied before the
   *  page is cut, so `total` and `hasMore` count only readable jobs. */
  jobIds?: ReadonlySet<string>;
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
  /** A strict true can only remove local dispatch. */
  queueOnly?: unknown;
}

export interface JobSubmitResult {
  jobId: string;
  deviceId: string | null;
  status: "queued" | "accepted";
  reason?: Extract<ReturnType<typeof localJobDispatchDecision>, { ok: false }>["reason"];
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

// ── Pagination coercion ─────────────────────────────────────────────────────

/**
 * Coerce an offset/limit value to a safe non-negative integer (N111).
 *
 * `list()` is called from several places (routes/jobs.ts, routes/setup.ts,
 * routes/status.ts, routes/operator-relay.ts) and not all of them validate
 * their input the way routes/jobs.ts's querystring schema now does — so this
 * is the last line of defense. Anything that isn't a finite, non-negative
 * integer (a string, a float, NaN, a negative number) falls back to
 * `fallback` instead of being used in `offset + limit` arithmetic, which is
 * exactly how N111 happened: string concatenation standing in for addition.
 */
function toSafeOffsetOrLimit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}

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
      // N111 — defensive coercion: the route's querystring schema already
      // guarantees real numbers, but this facade is called from other
      // places too (setup.ts, status.ts, operator-relay.ts), so don't trust
      // the caller. toSafeOffsetOrLimit() forces integer-only arithmetic
      // regardless of what's passed (string, float, NaN, negative, etc.).
      const offset = toSafeOffsetOrLimit(pagination?.offset, 0);
      const limit = toSafeOffsetOrLimit(pagination?.limit, 50);

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
      if (filters?.jobIds) {
        const readable = filters.jobIds;
        jobs = jobs.filter((job) => readable.has(job.id));
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
      // N85(a): a generic writer may not finish, fail, cancel or re-open a paid job.
      const outcome = writeJobStatusGuarded(jobId, status, progress);
      if (outcome.kind === "not_found") {
        throw new NotFoundError("job", jobId);
      }
      if (outcome.kind === "refused") {
        throw new ConflictError(SETTLEMENT_OWNED_MESSAGE, "settlement_owned_status");
      }
      const updated = outcome.job;

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

      // Only an explicitly matched, enabled, unstopped local kernel may run.
      let svc;
      try {
        svc = getKernelService();
      } catch {
        // KernelService not initialized — treat as external kernel path
      }

      const queued = (reason: Extract<ReturnType<typeof localJobDispatchDecision>, { ok: false }>["reason"]) => {
        // The shared dispatch decision supplies a closed reason; caller-supplied
        // ids still pass through N71's formatters at the telemetry boundary.
        pipelineTelemetry.emit(logSafeId(jobId), "job_submit", "completed", {
          metadata: { kernelId: logSafeId(kernelId), stepId: logSafeId(stepId), external: true, reason: logSafeId(reason) },
        });
        trackServerEvent("job_submitted", safeServerEventProperties({ kernelId, capabilityType: body.capabilityId, external: true, reason }), safeServerEventDistinctId(actorId));
        auditService.log({
          eventType: "job.submitted",
          actor: actorId,
          resourceType: "job",
          resourceId: jobId,
          action: "create",
          metadata: { kernelId, stepId, external: true, assuranceTier, reason },
          ip,
          userAgent,
        });
        return { jobId, deviceId: null, status: "queued" as const, reason };
      };

      const decision = localJobDispatchDecision(svc?.kernelId, kernelId, svc?.hasExplicitConfig ?? false, body.queueOnly);
      if (!decision.ok) return queued(decision.reason);

      // Local kernel: fire-and-forget via KernelService
      try {
        const result = await svc!.submitJob({ jobId, kernelId, stepId, deviceId, gcodeHash, assuranceTier });
        // The stop or operator switch may have changed during safety preflight.
        if (result.status === "queued") return queued(result.reason);
        // result.deviceId may be auto-selected or caller-supplied; format it too.
        pipelineTelemetry.emit(logSafeId(result.jobId), "job_submit", "completed", {
          metadata: { kernelId: logSafeId(kernelId), stepId: logSafeId(stepId), deviceId: logSafeId(result.deviceId) },
        });
        trackServerEvent("job_submitted", safeServerEventProperties({ kernelId, capabilityType: body.capabilityId }), safeServerEventDistinctId(actorId));
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
   * Register a device for a kernel. The response is the explicit registration view
   * (populateDeviceRegistrationDTO), never the stored row.
   * Replaces: POST /api/devices/register
   */
  async registerDevice(
    body: RegisterDeviceInput,
  ): Promise<Result<{ device: DeviceRegistrationDTO | undefined }>> {
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

      // An explicit view, not the row (N71): the row holds adapterConfig, and with a
      // rest-spread every column added later would be public.
      return { device: populateDeviceRegistrationDTO(device) };
    });
  }

  /**
   * The public view of a device row (N71, operator item 86). It is the same view
   * GET /api/kernels/:kernelId/devices returns (kernel.facade.ts getDevices). A
   * row's adapterConfig is the device's connection config (hosts, tokens, API
   * keys): no response carries it, and dispatch reads it from the row. This
   * endpoint used to return the raw rows to any key, for any kernel. (What a
   * caller sends in is its own: POST /api/setup/generate-config hands it back.)
   */
  private publicDevice(d: any) {
    return {
      id: d.id,
      type: d.type,
      model: d.model,
      status: d.status ?? "offline",
      healthStatus: d.healthStatus ?? "unknown",
      adapterType: d.adapterType ?? undefined,
      capabilities: d.capabilities ?? d.contributesToCapabilities ?? [],
    };
  }

  /**
   * Get devices for a kernel (the public view; see publicDevice).
   * Replaces: GET /api/devices/:kernelId
   */
  async getDevicesForKernel(kernelId: string): Promise<Result<unknown[]>> {
    return this.execute("getDevicesForKernel", async () => {
      return this.repos.kernels.findDevicesByKernel(kernelId).map((d: any) => this.publicDevice(d));
    });
  }

  /**
   * The fixed set of `details` values KernelService.checkDeviceHealth can legitimately
   * return: an adapter's own status, "device_not_found", or the "adapter_error" fallback
   * for a thrown exception (kernel-service.ts). Anything else — an object, an array, a
   * number, or a string outside this set — is not a shape checkDeviceHealth promises,
   * so it is dropped rather than trusted (N71 round 3, astra pack 83b: "the service
   * contract specifies strings", but a mocked/future caller could return anything).
   */
  private static readonly SAFE_HEALTH_DETAILS = new Set([
    "idle", "busy", "maintenance", "error", "offline", "device_not_found", "adapter_error",
  ]);

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
      let before: { kernelId?: string | null; adapterType?: string | null } | undefined;
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
      // unchanged across the check: a device moved to another kernel (or given
      // another adapter) mid-check is not attributed to either (#469 round 1).
      try {
        const after = this.repos.kernels.findDeviceById(deviceId);
        if (
          opts.operatorId &&
          before?.kernelId &&
          after?.kernelId === before.kernelId &&
          after?.adapterType === before.adapterType &&
          isRealAdapterHealthy(result.healthy, before.adapterType)
        ) {
          recordOperatorStage(before.kernelId, "adapter_ready", { deviceId, operatorId: opts.operatorId });
        }
      } catch {
        /* funnel tracking must never break a health-check response */
      }

      // Allow-listed here as well as fixed-coded in the service: this is what leaves
      // the API (N71 round 3, astra pack 83b) — a free-form string from a dependency
      // (e.g. "password=...") is never safe to show regardless of any scrub (N71
      // round 5, astra pack 83d: the service-side scrubber this comment used to name
      // was deleted outright — kernel-service.ts's checkDeviceHealth never logs the
      // message at all any more, scrubbed or not).
      const details =
        typeof result.details === "string" && JobFacade.SAFE_HEALTH_DETAILS.has(result.details)
          ? result.details
          : null;
      return { healthy: result.healthy, details };
    });
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /** Return a bad-request result (shorthand used inside execute()) */
  private badRequest<T>(code: string, message: string): T {
    throw new BadRequestError(message, code);
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
// merge-up (master): the local ConflictError/NotFoundError duplicates master
// defined here are dropped — NotFoundError is already imported from
// facade-errors.ts above (a local redeclaration would be a duplicate
// identifier), and ConflictError now also comes from facade-errors.ts (its
// class there gained the optional `code` param master's duplicate existed to
// provide). Using the SHARED classes, not file-local duplicates, is required
// for base.facade.ts's `error instanceof ConflictError` / `instanceof
// NotFoundError` checks to recognize errors thrown here — a local duplicate
// class has a different identity and would silently fall through to the
// generic 500 branch instead of the intended 409/404.
