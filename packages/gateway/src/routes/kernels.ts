import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import { getKernelFacade } from "../facades/index.js";
import type { CreateKernelInput, HeartbeatInput, CapabilityAnnouncementInput } from "../facades/index.js";

// ── Result→HTTP helper ────────────────────────────────────────────────────────

function sendResult<T>(reply: FastifyReply, result: Result<T>): unknown {
  if (result.success) return result.data;
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}

export async function kernelRoutes(app: FastifyInstance) {
  const facade = getKernelFacade();

  /**
   * List all kernels with staleness detection and capability type enrichment.
   * Supports optional ?status= filter.
   * Returns { kernels: KernelDTO[] } for backward compatibility.
   */
  app.get<{ Querystring: { status?: string } }>(
    "/api/kernels",
    async (req, reply) => {
      const result = await facade.list({ status: req.query.status });
      if (result.success) return { kernels: result.data };
      return sendResult(reply, result);
    },
  );

  /**
   * Get a single kernel by ID with full health snapshot (capabilities + devices).
   * Returns { kernel: KernelHealthSnapshot } for backward compat.
   * Returns 404 when not found (previously returned 200 with { error: "not_found" }).
   */
  app.get<{ Params: { kernelId: string } }>("/api/kernels/:kernelId", async (req, reply) => {
    const result = await facade.getById(req.params.kernelId);
    if (result.success) return { kernel: result.data };
    return sendResult(reply, result);
  });

  /**
   * Get devices for a kernel.
   * Returns { devices: DeviceStatusDTO[] }.
   */
  app.get<{ Params: { kernelId: string } }>(
    "/api/kernels/:kernelId/devices",
    async (req, reply) => {
      const result = await facade.getDevices(req.params.kernelId);
      if (result.success) return { devices: result.data };
      return sendResult(reply, result);
    },
  );

  /**
   * Get jobs for a kernel.
   * Returns { jobs: JobDTO[] }.
   */
  app.get<{ Params: { kernelId: string } }>(
    "/api/kernels/:kernelId/jobs",
    async (req, reply) => {
      const result = await facade.getJobs(req.params.kernelId);
      if (result.success) return { jobs: result.data };
      return sendResult(reply, result);
    },
  );

  /**
   * Register (upsert) a kernel.
   * Returns 201 + { kernel, created: true } on creation.
   * Returns 200 + { kernel, created: false } when already exists (heartbeat update).
   */
  app.post<{ Body: CreateKernelInput }>("/api/kernels", async (req, reply) => {
    const actorId = (req as any).operatorId ?? (req as any).apiKeyId;
    const result = await facade.register(
      req.body,
      actorId,
      req.ip,
      req.headers["user-agent"],
    );
    if (!result.success) return sendResult(reply, result);
    const { kernel, created } = result.data;
    if (created) {
      return reply.code(201).send({ kernel, created: true });
    }
    return { kernel, created: false };
  });

  /**
   * Per-kernel heartbeat — pcc-node daemons call this path.
   * Updates status + upserts any announced capabilities.
   * Returns { acknowledged, kernelId, status, capabilitiesReceived, timestamp }.
   */
  app.post<{
    Params: { kernelId: string };
    Body: HeartbeatInput;
  }>("/api/kernels/:kernelId/heartbeat", async (req, reply) => {
    const result = await facade.heartbeat(req.params.kernelId, req.body ?? {});
    return sendResult(reply, result);
  });

  /**
   * Capability announcement from pcc-node daemons.
   * Acknowledges receipt; signature verification is a TODO.
   * Returns { acknowledged, kernelId, capabilitiesReceived, devicesReceived, timestamp }.
   */
  app.post<{
    Params: { kernelId: string };
    Body: CapabilityAnnouncementInput;
  }>("/api/kernels/:kernelId/capabilities", async (req, reply) => {
    const result = await facade.announceCapabilities(req.params.kernelId, req.body ?? {});
    return sendResult(reply, result);
  });
}
