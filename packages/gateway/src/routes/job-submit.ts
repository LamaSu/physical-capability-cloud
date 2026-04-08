/**
 * Job submission routes — refactored to use JobFacade.
 *
 * POST /api/jobs/submit          — submit a new job (fire-and-forget async execution)
 * GET  /api/jobs/:jobId/status   — poll job status (DB + in-memory tracker)
 * POST /api/devices/register     — register a new device with adapter config
 * GET  /api/devices/:kernelId    — list devices for a kernel
 * POST /api/devices/:deviceId/health — trigger health check on a device
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import { getJobFacade } from "../facades/index.js";
import type { SubmitJobInput, RegisterDeviceInput } from "../facades/index.js";

// ── Result→HTTP helper ─────────────────────────────────────────────────────

function sendResult<T>(reply: FastifyReply, result: Result<T>): unknown {
  if (result.success) return result.data;
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}

// ── Route plugin ──────────────────────────────────────────────────────────

export async function jobSubmitRoutes(app: FastifyInstance) {
  const facade = getJobFacade();

  // ── POST /api/jobs/submit ──────────────────────────────────────────────────

  /**
   * Submit a new job — capability fuzzy matching, DB persistence,
   * external kernel routing, and local KernelService fire-and-forget.
   */
  app.post<{ Body: SubmitJobInput }>("/api/jobs/submit", async (req, reply) => {
    const actorId = (req as any).operatorId ?? (req as any).apiKeyId;
    const result = await facade.submit(
      req.body,
      actorId,
      req.ip,
      req.headers["user-agent"],
    );
    return sendResult(reply, result);
  });

  // ── GET /api/jobs/:jobId/status ────────────────────────────────────────────

  /**
   * Poll job status — hybrid KernelService in-memory + DB fallback.
   */
  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId/status", async (req, reply) => {
    const result = await facade.getStatus(req.params.jobId);
    return sendResult(reply, result);
  });

  // ── POST /api/devices/register ─────────────────────────────────────────────

  /**
   * Register a device for a kernel. Returns 409 on duplicate, 400 on missing fields.
   */
  app.post<{ Body: RegisterDeviceInput }>("/api/devices/register", async (req, reply) => {
    const result = await facade.registerDevice(req.body);
    if (!result.success) {
      // Map duplicate error to 409
      if (result.error.message?.includes("UNIQUE") || result.error.message?.includes("unique")) {
        return reply.code(409).send({ error: "device_already_exists" });
      }
      return sendResult(reply, result);
    }
    return result.data;
  });

  // ── GET /api/devices/:kernelId ─────────────────────────────────────────────

  /**
   * List devices for a kernel.
   */
  app.get<{ Params: { kernelId: string } }>("/api/devices/:kernelId", async (req, reply) => {
    const result = await facade.getDevicesForKernel(req.params.kernelId);
    if (result.success) return { devices: result.data };
    return sendResult(reply, result);
  });

  // ── POST /api/devices/:deviceId/health ────────────────────────────────────

  /**
   * Trigger a health check on a device.
   */
  app.post<{ Params: { deviceId: string } }>("/api/devices/:deviceId/health", async (req, reply) => {
    const result = await facade.checkDeviceHealth(req.params.deviceId);
    return sendResult(reply, result);
  });
}
