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
import type { OperatorPolicy, Result } from "@pcc/spec";
import { getJobFacade } from "../facades/index.js";
import type { SubmitJobInput, RegisterDeviceInput } from "../facades/index.js";
import { getStore } from "../db.js";
import { schema, eq } from "@pcc/store";

const { operatorPolicies, captureVerdicts, captureAnchors } = schema;

const CAPTURE_CLASS_ORDER = ["CC0", "CC1", "CC2", "CC3", "CC4", "CC5"] as const;
type CaptureClassName = typeof CAPTURE_CLASS_ORDER[number];

/**
 * Evaluate a submitted capture verdict against a kernel's operator policy.
 * Returns `{allowed: false, reason}` when the policy rejects the job on
 * CVP grounds (minCaptureClass unmet, requireAnchor not satisfied, or
 * verdict missing entirely when the policy demands one).
 */
function checkCapturePolicy(
  policy: OperatorPolicy,
  captureVerdictId: string | undefined,
): { allowed: true } | { allowed: false; reason: string; code: string } {
  const minClass = policy.minCaptureClass;
  const requireAnchor = policy.requireAnchor === true;

  // No CVP constraints — allow.
  if (!minClass && !requireAnchor) {
    return { allowed: true };
  }

  // Policy requires a verdict but none was supplied.
  if (!captureVerdictId) {
    return {
      allowed: false,
      code: "capture_verdict_required",
      reason:
        "Operator policy requires a captureVerdictId on this kernel (minCaptureClass or requireAnchor is set).",
    };
  }

  const { db } = getStore();
  const verdict = db
    .select()
    .from(captureVerdicts)
    .where(eq(captureVerdicts.id, captureVerdictId))
    .get();

  if (!verdict) {
    return {
      allowed: false,
      code: "capture_verdict_not_found",
      reason: `captureVerdictId=${captureVerdictId} not found`,
    };
  }

  if (verdict.verdict !== "PASS") {
    return {
      allowed: false,
      code: "capture_verdict_not_pass",
      reason: `capture verdict is ${verdict.verdict} (expected PASS)`,
    };
  }

  if (minClass) {
    const verifiedIdx = CAPTURE_CLASS_ORDER.indexOf(
      verdict.verifiedClassStr as CaptureClassName,
    );
    const minIdx = CAPTURE_CLASS_ORDER.indexOf(minClass);
    if (verifiedIdx < minIdx) {
      return {
        allowed: false,
        code: "capture_class_below_minimum",
        reason: `verified class ${verdict.verifiedClassStr} < required ${minClass}`,
      };
    }
  }

  if (requireAnchor) {
    if (!verdict.anchorCandidate) {
      return {
        allowed: false,
        code: "capture_not_anchor_candidate",
        reason: "operator policy requireAnchor=true but verdict.anchorCandidate=false",
      };
    }
    const anchor = db
      .select()
      .from(captureAnchors)
      .where(eq(captureAnchors.verdictId, captureVerdictId))
      .get();
    if (!anchor) {
      return {
        allowed: false,
        code: "capture_not_anchored",
        reason:
          "operator policy requireAnchor=true but verdict has no on-chain anchor row",
      };
    }
  }

  return { allowed: true };
}

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
  app.post<{ Body: SubmitJobInput & { captureVerdictId?: string } }>(
    "/api/jobs/submit",
    async (req, reply) => {
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId;

      // ── Capture Verification Protocol gate (Wave 4) ──
      // Before dispatching to the facade, consult the target kernel's
      // operator policy for minCaptureClass / requireAnchor.
      const kernelId = (req.body as { kernelId?: string } | undefined)?.kernelId;
      if (kernelId) {
        try {
          const { db } = getStore();
          const policyRow = db
            .select()
            .from(operatorPolicies)
            .where(eq(operatorPolicies.kernelId, kernelId))
            .get();
          if (policyRow?.policy) {
            const policy = policyRow.policy as unknown as OperatorPolicy;
            const gate = checkCapturePolicy(
              policy,
              (req.body as { captureVerdictId?: string }).captureVerdictId,
            );
            if (!gate.allowed) {
              return reply.status(403).send({
                error: gate.code,
                message: gate.reason,
                kernelId,
              });
            }
          }
        } catch (err) {
          // Fail-open — a policy read failure should not block jobs that
          // don't actually require CVP. The facade and subsequent gates
          // will still run. Log for observability.
          req.log.warn(
            { err, kernelId },
            "capture policy gate read failed; proceeding without CVP check",
          );
        }
      }

      const result = await facade.submit(
        req.body,
        actorId,
        req.ip,
        req.headers["user-agent"],
      );
      return sendResult(reply, result);
    },
  );

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
