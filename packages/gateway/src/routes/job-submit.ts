/**
 * Job submission routes.
 *
 * POST /api/jobs/submit          — submit a new job (fire-and-forget async execution)
 * GET  /api/jobs/:jobId/status   — poll job status (DB + in-memory tracker)
 * POST /api/devices/register     — register a new device with adapter config
 * GET  /api/devices/:kernelId    — list devices for a kernel
 * POST /api/devices/:deviceId/health — trigger health check on a device
 */

import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { getRepos } from "../db.js";
import { getKernelService } from "../services/kernel-service.js";
import { auditService } from "../services/audit-service.js";
import { pipelineTelemetry } from "../telemetry.js";
import { trackServerEvent } from "../services/posthog-service.js";

// ---------------------------------------------------------------------------
// Body / Params interfaces
// ---------------------------------------------------------------------------

interface SubmitJobBody {
  jobId?: string;
  stepId: string;
  kernelId: string;
  capabilityId?: string;
  deviceId?: string;
  gcodeHash?: string;
  assuranceTier?: number;
}

interface JobStatusParams {
  jobId: string;
}

interface RegisterDeviceBody {
  kernelId: string;
  id: string;
  type: string;
  model: string;
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
  capabilities?: string[];
}

interface KernelDevicesParams {
  kernelId: string;
}

interface DeviceHealthParams {
  deviceId: string;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function jobSubmitRoutes(app: FastifyInstance) {
  // ── POST /api/jobs/submit ──────────────────────────────────────────────────

  app.post<{ Body: SubmitJobBody }>("/api/jobs/submit", async (req, reply) => {
    const { stepId, kernelId, capabilityId, deviceId, gcodeHash, assuranceTier } = req.body;

    if (!stepId) {
      return reply.code(400).send({ error: "missing_step_id" });
    }
    if (!kernelId) {
      return reply.code(400).send({ error: "missing_kernel_id" });
    }

    const jobId = req.body.jobId ?? `job-${uuidv4()}`;

    // Persist the job record before firing off execution
    try {
      const repos = getRepos();

      // Resolve capability id — use provided or fall back to the first capability
      // registered for this kernel.
      let resolvedCapabilityId = capabilityId;
      if (!resolvedCapabilityId) {
        const caps = repos.capabilities.findByKernel(kernelId);
        resolvedCapabilityId = caps[0]?.id;
      }
      if (!resolvedCapabilityId) {
        return reply.code(400).send({ error: "no_capability_found_for_kernel" });
      }

      repos.jobs.insert({
        id: jobId,
        stepId,
        cwmId: `cwm-${uuidv4()}`,
        capabilityId: resolvedCapabilityId,
        kernelId,
        status: "queued",
        assignedDevices: deviceId ? [deviceId] : [],
        startedAt: new Date().toISOString(),
        progress: 0,
      });
    } catch (err) {
      return reply.code(500).send({
        error: "db_insert_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }

    // Delegate to KernelService (fire-and-forget)
    try {
      const svc = getKernelService();
      const result = await svc.submitJob({
        jobId,
        stepId,
        deviceId,
        gcodeHash,
        assuranceTier,
      });
      pipelineTelemetry.emit(result.jobId, "job_submit", "completed", { metadata: { kernelId, stepId, deviceId: result.deviceId } });
      trackServerEvent("job_submitted", { kernelId, capabilityType: capabilityId }, (req as any).operatorId);
      auditService.log({
        eventType: "job.submitted",
        actor: (req as any).operatorId ?? (req as any).apiKeyId,
        resourceType: "job",
        resourceId: result.jobId,
        action: "create",
        metadata: { kernelId, stepId, deviceId: result.deviceId, assuranceTier },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return { jobId: result.jobId, deviceId: result.deviceId, status: result.status };
    } catch (err) {
      // Roll back DB record on failure to start
      try {
        const repos = getRepos();
        repos.jobs.updateStatus(jobId, "failed");
      } catch {
        // best-effort
      }
      return reply.code(500).send({
        error: "submission_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // ── GET /api/jobs/:jobId/status ────────────────────────────────────────────

  app.get<{ Params: JobStatusParams }>("/api/jobs/:jobId/status", async (req, reply) => {
    const { jobId } = req.params;

    try {
      const svc = getKernelService();
      const result = await svc.getJobStatus(jobId);
      if (result.status === "unknown") {
        // Also check DB directly — job may exist but not tracked in-memory
        const repos = getRepos();
        const job = repos.jobs.findById(jobId);
        if (!job) {
          return reply.code(404).send({ error: "not_found" });
        }
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
    } catch (err) {
      return reply.code(500).send({
        error: "status_check_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // ── POST /api/devices/register ─────────────────────────────────────────────

  app.post<{ Body: RegisterDeviceBody }>("/api/devices/register", async (req, reply) => {
    const { kernelId, id, type, model, adapterType, adapterConfig, capabilities } = req.body;

    if (!kernelId || !id || !type || !model || !adapterType) {
      return reply.code(400).send({ error: "missing_required_fields" });
    }

    try {
      const repos = getRepos();

      // Verify the kernel exists
      const kernel = repos.kernels.findById(kernelId);
      if (!kernel) {
        return reply.code(400).send({ error: "kernel_not_found" });
      }

      const device = repos.kernels.insertDevice({
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
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      // Handle UNIQUE constraint violation
      if (message.includes("UNIQUE") || message.includes("unique")) {
        return reply.code(409).send({ error: "device_already_exists" });
      }
      return reply.code(500).send({ error: "insert_failed", message });
    }
  });

  // ── GET /api/devices/:kernelId ─────────────────────────────────────────────

  app.get<{ Params: KernelDevicesParams }>("/api/devices/:kernelId", async (req, reply) => {
    const { kernelId } = req.params;

    try {
      const repos = getRepos();
      const devices = repos.kernels.findDevicesByKernel(kernelId);
      return { devices };
    } catch (err) {
      return reply.code(500).send({
        error: "query_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // ── POST /api/devices/:deviceId/health ────────────────────────────────────

  app.post<{ Params: DeviceHealthParams }>("/api/devices/:deviceId/health", async (req, reply) => {
    const { deviceId } = req.params;

    try {
      const svc = getKernelService();
      const result = await svc.checkDeviceHealth(deviceId);

      // Update DB health record
      try {
        const repos = getRepos();
        repos.kernels.updateHealth(
          deviceId,
          result.healthy ? "healthy" : "offline",
          Math.floor(Date.now() / 1000),
        );
      } catch {
        // DB update is best-effort
      }

      return { healthy: result.healthy, details: result.details ?? null };
    } catch (err) {
      return reply.code(500).send({
        error: "health_check_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });
}
