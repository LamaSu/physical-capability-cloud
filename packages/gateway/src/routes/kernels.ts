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

/**
 * Build a "next step" hint pointing operators at POST /api/capabilities.
 *
 * Discovery context: POST /api/kernels creates a kernel row but does NOT make
 * the operator discoverable. The catalog (GET /api/capabilities) filters on
 * capabilities, not kernels — a kernel with zero capabilities is correctly
 * invisible to user-agents browsing for skills. This hint tells the operator
 * that an additional POST is required.
 *
 * See docs/DEPLOY.md (Runtime Env Semantics) and
 * pcc-operator-onboarding-and-categories.md (Part A item 14).
 *
 * agent: implementer-victor (cherry-picked via implementer-whiskey integration)
 */
function buildCapabilityRegistrationHint(kernelId: string) {
  return {
    action: "POST /api/capabilities",
    explanation:
      `Your kernel is registered but is not yet discoverable. ` +
      `PCC catalog discovery filters on capabilities, not kernels. ` +
      `POST at least one capability tied to this kernel via ` +
      `{ kernelId: "${kernelId}", type: "<category.action>", name: "<human-name>", ... } ` +
      `to appear in GET /api/capabilities and become discoverable to user-agents.`,
    documentationUrl: "/docs/onboarding/capability-registration",
    exampleCurl:
      `curl -X POST <gateway>/api/capabilities ` +
      `-H 'Authorization: Bearer <key>' ` +
      `-H 'Content-Type: application/json' ` +
      `-d '{"kernelId":"${kernelId}","type":"pizza.order","name":"..."}'`,
  };
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
   * Returns { kernel: KernelHealthSnapshot } with extra discoveryStatus +
   * nextStep hint when the kernel has zero capabilities (purely additive —
   * existing clients that only consume kernel.id keep working).
   * Returns 404 when not found.
   */
  app.get<{ Params: { kernelId: string } }>("/api/kernels/:kernelId", async (req, reply) => {
    const result = await facade.getById(req.params.kernelId);
    if (!result.success) return sendResult(reply, result);
    const snapshot = result.data;
    const capabilityCount = snapshot.capabilityCount ?? 0;
    const discoveryStatus =
      capabilityCount >= 1 ? "discoverable" : "kernel-registered-not-discoverable";
    // Backward-compat alias: tests + dashboard read `kernel.capabilities`
    // (a string[] of types). The KernelHealthSnapshot stores them as
    // `capabilityTypes`; expose both shapes for callers that haven't
    // migrated yet. Purely additive — KernelHealthSnapshot fields are
    // preserved.
    const responseKernel: Record<string, unknown> = {
      ...snapshot,
      capabilities: snapshot.capabilityTypes ?? [],
      discoveryStatus,
    };
    if (discoveryStatus === "kernel-registered-not-discoverable") {
      responseKernel.nextStep = buildCapabilityRegistrationHint(snapshot.id);
    }
    return { kernel: responseKernel };
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
   * Returns 201 + { kernel, created: true, discoveryStatus, nextStep } on creation
   * (freshly registered kernels have zero capabilities → not yet discoverable;
   * the nextStep hint tells the operator to POST /api/capabilities — Victor's
   * onboarding-clarity fix, integrated via implementer-whiskey).
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
      return reply.code(201).send({
        kernel,
        created: true,
        capabilities: [],
        discoveryStatus: "kernel-registered-not-discoverable",
        nextStep: buildCapabilityRegistrationHint(kernel.id),
      });
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

  /**
   * Per-capability heartbeat (feat/ed25519-keys-and-kernel-ttl).
   *
   * Single-row heartbeat for clients that already announced their kernel
   * but want to refresh ONE capability's TTL without re-sending the
   * whole catalog. Authentication follows the same Bearer-token model as
   * other write routes — the gateway middleware gate ensures the caller
   * has a valid API key before the handler runs.
   *
   * Returns 200 with { acknowledged, capabilityId, kernelId, validUntil,
   *   timestamp, resurrected }, or 404 if the capability id is unknown.
   */
  app.post<{
    Params: { capId: string };
    Body: { signature?: string };
  }>("/api/capabilities/:capId/heartbeat", async (req, reply) => {
    const { getRepos } = await import("../db.js");
    const { computeValidUntilIso, emitKernelLifecycleEvent } = await import(
      "../facades/kernel.facade.js"
    );
    const repos = getRepos();
    const cap = (repos.capabilities as any).findById(req.params.capId);
    if (!cap) {
      return reply.status(404).send({ error: "capability_not_found" });
    }
    const nowDate = new Date();
    const nowIso = nowDate.toISOString();
    const validUntil = computeValidUntilIso(nowDate);

    // Detect resurrection at the capability level.
    const priorValidUntil = cap.validUntil ?? cap.valid_until;
    let resurrected = false;
    if (priorValidUntil) {
      const parsed = Date.parse(priorValidUntil);
      if (Number.isFinite(parsed) && parsed < nowDate.getTime()) {
        resurrected = true;
      }
    }

    try {
      (repos.capabilities as any).update(req.params.capId, {
        lastHeartbeatAt: nowIso,
        validUntil,
      });
    } catch {
      return reply.status(500).send({ error: "update_failed" });
    }
    try {
      emitKernelLifecycleEvent({
        event: "kernel.heartbeat.received",
        kernelId: cap.kernelId,
        capabilityId: cap.id,
      });
    } catch {
      // telemetry shouldn't block the response
    }

    return reply.status(200).send({
      acknowledged: true,
      capabilityId: cap.id,
      kernelId: cap.kernelId,
      validUntil,
      resurrected,
      timestamp: nowIso,
    });
  });
}
