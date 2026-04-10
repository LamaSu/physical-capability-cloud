/**
 * Generic Device Relay Routes
 *
 * Device-agnostic relay that replaces the OT-2-specific routes.
 * All routes are namespaced by :kernelId so any device type works.
 *
 * Tool calls:
 *   POST /api/relay/:kernelId/tool-call          -- Brain posts a tool call
 *   GET  /api/relay/:kernelId/tool-call/pending   -- Executor polls for pending calls
 *   POST /api/relay/:kernelId/tool-result         -- Executor posts result
 *   GET  /api/relay/:kernelId/tool-result/:id     -- Brain polls for a specific result
 *
 * Execution scopes:
 *   POST /api/relay/:kernelId/scope               -- Create an execution scope
 *   GET  /api/relay/:kernelId/scope/:scopeId      -- Get scope details
 *   POST /api/relay/:kernelId/scope/:scopeId/revoke -- Revoke a scope
 *   GET  /api/relay/:kernelId/scope/:scopeId/audit  -- Audit trail for a scope
 *
 * Camera:
 *   POST /api/relay/:kernelId/camera/frame        -- Agent pushes a frame
 *   GET  /api/relay/:kernelId/camera/latest        -- Get latest frame as JPEG
 *   GET  /api/relay/:kernelId/camera/snapshot      -- Get latest frame as JSON
 *   GET  /api/relay/:kernelId/camera/stream        -- SSE frame notifications
 *
 * Chat:
 *   POST /api/relay/:kernelId/chat                 -- User sends a message
 *   GET  /api/relay/:kernelId/chat/messages         -- Conversation history
 *   GET  /api/relay/:kernelId/chat/pending          -- Agent polls for user messages
 *   POST /api/relay/:kernelId/chat/respond          -- Agent posts response
 *
 * Manifest:
 *   GET  /api/relay/:kernelId/manifest              -- Get tool manifest for this kernel
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { getStore } from "../db.js";
import { schema, eq, and, sql } from "@pcc/store";
import { isToolSafe, getManifest, warmManifestCache } from "../services/tool-manifest-service.js";
import { getSafetyGateway, initSafetyGateway } from "@pcc/kernel";

const { toolCallRelay, executionScopes, ot2CameraFrames, ot2ChatMessages, shopKernels } = schema;

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Resolve the device type for a kernel. Falls back to "generic". */
function resolveDeviceType(kernelId: string): string {
  const { db } = getStore();
  const kernel = db.select().from(shopKernels).where(eq(shopKernels.id, kernelId)).get();
  if (!kernel) return "generic";

  // Check if any device on this kernel has an adapterType that maps to a known device type
  const devices = db.select().from(schema.kernelDevices)
    .where(eq(schema.kernelDevices.kernelId, kernelId))
    .all();

  // Map adapter types to device types
  for (const device of devices) {
    if (device.adapterType === "opentrons") return "opentrons";
    if (device.adapterType === "octoprint") return "octoprint";
    if (device.adapterType === "ipp") return "ipp";
  }

  return "generic";
}

interface ScopeValidation {
  allowed: boolean;
  reason: string;
}

function validateToolCall(
  scope: typeof executionScopes.$inferSelect,
  toolName: string,
  deviceType: string,
): ScopeValidation {
  // Safe tools always pass
  if (isToolSafe(deviceType, toolName)) {
    return { allowed: true, reason: "safe_tool" };
  }

  // Check scope is active and not expired
  if (scope.status !== "active") {
    return { allowed: false, reason: "scope_not_active" };
  }
  if (new Date(scope.expiresAt) < new Date()) {
    return { allowed: false, reason: "scope_expired" };
  }

  // Check tool is in allowed list
  const allowedTools = scope.allowedTools as string[];
  if (!allowedTools.includes(toolName)) {
    return { allowed: false, reason: "tool_not_allowed" };
  }

  // Check command count
  if (scope.commandCount >= scope.maxCommands) {
    return { allowed: false, reason: "max_commands_reached" };
  }

  return { allowed: true, reason: "scope_approved" };
}

/** Check if a caller has camera access for a kernel */
function hasCameraAccess(
  callerId: string,
  kernelId: string,
): boolean {
  if (!callerId || callerId === "anonymous") return false;

  const { db } = getStore();

  // Check if caller is the kernel operator
  const kernel = db.select().from(shopKernels).where(eq(shopKernels.id, kernelId)).get();
  if (kernel && kernel.operatorAddress === callerId) return true;

  // Check if caller has an active scope for this kernel
  const scope = db
    .select()
    .from(executionScopes)
    .where(
      and(
        eq(executionScopes.kernelId, kernelId),
        eq(executionScopes.createdBy, callerId),
        eq(executionScopes.status, "active"),
      ),
    )
    .limit(1)
    .get();

  return !!scope;
}

// ── Active SSE clients for camera streams (per kernel) ──────────────────────
const cameraStreamClients = new Map<string, Set<FastifyReply>>();

function getStreamClients(kernelId: string): Set<FastifyReply> {
  if (!cameraStreamClients.has(kernelId)) {
    cameraStreamClients.set(kernelId, new Set());
  }
  return cameraStreamClients.get(kernelId)!;
}

// ── Route Registration ──────────────────────────────────────────────────────

export async function deviceRelayRoutes(app: FastifyInstance) {
  // Ensure the safety gateway singleton is initialized. In production this is
  // a no-op (KernelService constructor calls initSafetyGateway first). In
  // test environments where KernelService is not running, this creates a
  // default gateway instance so relay validation can proceed.
  initSafetyGateway();

  // Pre-warm manifest cache so sync lookups work
  await warmManifestCache();

  // Ensure tables exist (idempotent — same DDL as OT-2 routes)
  const { db } = getStore();

  db.run(sql`CREATE TABLE IF NOT EXISTS tool_call_relay (
    id TEXT PRIMARY KEY,
    scope_id TEXT,
    kernel_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_args TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS execution_scopes (
    id TEXT PRIMARY KEY,
    kernel_id TEXT NOT NULL,
    job_id TEXT,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    allowed_tools TEXT NOT NULL,
    allowed_pipettes TEXT,
    allowed_slots TEXT,
    max_commands INTEGER NOT NULL DEFAULT 100,
    command_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS ot2_camera_frames (
    id TEXT PRIMARY KEY,
    kernel_id TEXT NOT NULL,
    frame_data TEXT NOT NULL,
    captured_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS ot2_chat_messages (
    id TEXT PRIMARY KEY,
    kernel_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`);

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL MANIFEST
  // ═══════════════════════════════════════════════════════════════════════════

  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/manifest", async (req) => {
    const { kernelId } = req.params;
    const deviceType = resolveDeviceType(kernelId);
    const manifest = await getManifest(deviceType);
    return {
      kernelId,
      deviceType,
      manifest,
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL CALL RELAY
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/relay/:kernelId/tool-call
  app.post<{
    Params: { kernelId: string };
    Body: {
      scopeId?: string;
      toolName?: string;
      args?: Record<string, unknown>;
    };
  }>("/api/relay/:kernelId/tool-call", async (req, reply) => {
    const { kernelId } = req.params;
    const { scopeId, toolName, args } = req.body ?? {};

    if (!toolName) {
      return reply.status(400).send({ error: "toolName is required" });
    }

    const { db } = getStore();
    const callerId = (req as any).operatorId ?? "anonymous";
    const deviceType = resolveDeviceType(kernelId);

    // Non-safe tools require a scope
    if (!isToolSafe(deviceType, toolName) && !scopeId) {
      return reply.status(403).send({
        error: "scope_required",
        message: `Write operations require an execution scope. Create one via POST /api/relay/${kernelId}/scope`,
      });
    }

    // Validate scope if provided
    if (scopeId) {
      const scope = db
        .select()
        .from(executionScopes)
        .where(eq(executionScopes.id, scopeId))
        .get();

      if (!scope) {
        return reply.status(404).send({ error: "Scope not found", scopeId });
      }

      // Verify scope belongs to this kernel
      if (scope.kernelId !== kernelId) {
        return reply.status(403).send({
          error: "scope_kernel_mismatch",
          message: "This scope belongs to a different kernel.",
        });
      }

      // Verify caller owns this scope (or is the kernel operator)
      if (scope.createdBy !== callerId && callerId !== "anonymous") {
        const kernel = db.select().from(shopKernels).where(eq(shopKernels.id, kernelId)).get();
        const isOperator = kernel && kernel.operatorAddress === callerId;
        if (!isOperator) {
          return reply.status(403).send({
            error: "scope_not_yours",
            message: "This scope belongs to a different agent.",
          });
        }
      }

      const validation = validateToolCall(scope, toolName, deviceType);
      if (!validation.allowed) {
        const id = generateId("tc");
        const now = new Date().toISOString();

        db.insert(toolCallRelay).values({
          id,
          scopeId,
          kernelId,
          toolName,
          toolArgs: args ?? {},
          status: "rejected",
          error: validation.reason,
          createdAt: now,
        }).run();

        return reply.status(403).send({
          error: "Tool call rejected by execution scope",
          reason: validation.reason,
          callId: id,
          toolName,
          scopeId,
        });
      }

      // Increment command count for non-safe tools
      if (!isToolSafe(deviceType, toolName)) {
        db.update(executionScopes)
          .set({ commandCount: scope.commandCount + 1 })
          .where(eq(executionScopes.id, scopeId))
          .run();
      }
    }

    // ── Safety gateway check ─────────────────────────────────────────────────
    // Scope validation above handles *authorization* (which tools are allowed).
    // The safety governor handles *physical safety* (envelope, rate, e-stop, class).
    // Both must pass in order: scope first, then governor.
    try {
      const gateway = getSafetyGateway();
      const agentDid =
        (req as any).operatorId ??
        (req.headers["x-agent-did"] as string | undefined) ??
        callerId;

      const safetyVerdict = await gateway.validateAndRelay(
        {
          commandId: generateId("cmd"),
          deviceId: kernelId,
          class: scopeId ? "scoped" : "safe",
          type: toolName,
          params: (args ?? {}) as Record<string, unknown>,
          agentDid,
          scopeId: scopeId ?? undefined,
        },
        // No-op execute — for relay calls the actual execution happens on-device
        // (executor polls tool_call_relay). The gateway only needs to validate;
        // the DB insert is the relay mechanism, not a direct hardware call.
        async () => undefined,
      );

      if (!safetyVerdict.allowed) {
        return reply.status(403).send({
          error: "Tool call denied by safety governor",
          reason: safetyVerdict.verdict?.reason ?? safetyVerdict.reason ?? "governor_denied",
          checks: safetyVerdict.verdict?.checks ?? [],
          toolName,
          kernelId,
          scopeId: scopeId ?? null,
        });
      }
    } catch (err) {
      // getSafetyGateway() throws if not initialized — treat as a safety failure
      return reply.status(503).send({
        error: "Safety gateway not available",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    const id = generateId("tc");
    const now = new Date().toISOString();

    db.insert(toolCallRelay).values({
      id,
      scopeId: scopeId ?? null,
      kernelId,
      toolName,
      toolArgs: args ?? {},
      status: "pending",
      createdAt: now,
    }).run();

    return reply.status(201).send({
      id,
      kernelId,
      scopeId: scopeId ?? null,
      toolName,
      status: "pending",
      createdAt: now,
    });
  });

  // GET /api/relay/:kernelId/tool-call/pending
  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/tool-call/pending", async (req) => {
    const { kernelId } = req.params;

    const { db } = getStore();

    // Reclaim stale claimed calls (claimed >120s ago without completion).
    // This prevents calls from being stuck forever if the executor crashes.
    const CLAIM_TIMEOUT_MS = 120_000;
    const staleThreshold = new Date(Date.now() - CLAIM_TIMEOUT_MS).toISOString();
    const staleClaimed = db
      .select()
      .from(toolCallRelay)
      .where(
        and(
          eq(toolCallRelay.kernelId, kernelId),
          eq(toolCallRelay.status, "claimed"),
        ),
      )
      .all()
      .filter((c) => c.claimedAt && c.claimedAt < staleThreshold);

    for (const stale of staleClaimed) {
      db.update(toolCallRelay)
        .set({ status: "pending", claimedAt: null })
        .where(eq(toolCallRelay.id, stale.id))
        .run();
    }

    const pending = db
      .select()
      .from(toolCallRelay)
      .where(
        and(
          eq(toolCallRelay.kernelId, kernelId),
          eq(toolCallRelay.status, "pending"),
        ),
      )
      .orderBy(toolCallRelay.createdAt)
      .limit(5)
      .all();

    // Mark them as claimed
    const now = new Date().toISOString();
    for (const call of pending) {
      db.update(toolCallRelay)
        .set({ status: "claimed", claimedAt: now })
        .where(eq(toolCallRelay.id, call.id))
        .run();
    }

    return {
      calls: pending.map((c) => ({
        id: c.id,
        scopeId: c.scopeId,
        kernelId: c.kernelId,
        toolName: c.toolName,
        args: c.toolArgs,
        createdAt: c.createdAt,
      })),
      count: pending.length,
    };
  });

  // POST /api/relay/:kernelId/tool-result
  app.post<{
    Params: { kernelId: string };
    Body: {
      callId?: string;
      result?: unknown;
      error?: string;
    };
  }>("/api/relay/:kernelId/tool-result", async (req, reply) => {
    const { callId, result, error } = req.body ?? {};

    if (!callId) {
      return reply.status(400).send({ error: "callId is required" });
    }

    const { db } = getStore();

    const call = db
      .select()
      .from(toolCallRelay)
      .where(eq(toolCallRelay.id, callId))
      .get();

    if (!call) {
      return reply.status(404).send({ error: "Tool call not found", callId });
    }

    const now = new Date().toISOString();
    const newStatus = error ? "failed" : "completed";

    // If failed and scope has retries left, update retry count
    if (error && call.scopeId) {
      const scope = db
        .select()
        .from(executionScopes)
        .where(eq(executionScopes.id, call.scopeId))
        .get();

      if (scope && scope.retryCount < scope.maxRetries) {
        db.update(executionScopes)
          .set({ retryCount: scope.retryCount + 1 })
          .where(eq(executionScopes.id, call.scopeId))
          .run();
      }
    }

    db.update(toolCallRelay)
      .set({
        status: newStatus,
        result: result != null ? JSON.stringify(result) : null,
        error: error ?? null,
        completedAt: now,
      })
      .where(eq(toolCallRelay.id, callId))
      .run();

    return reply.status(200).send({
      callId,
      status: newStatus,
      completedAt: now,
    });
  });

  // GET /api/relay/:kernelId/tool-result/:id
  app.get<{
    Params: { kernelId: string; id: string };
  }>("/api/relay/:kernelId/tool-result/:id", async (req, reply) => {
    const { id } = req.params;

    const { db } = getStore();
    const call = db
      .select()
      .from(toolCallRelay)
      .where(eq(toolCallRelay.id, id))
      .get();

    if (!call) {
      return reply.status(404).send({ error: "Tool call not found", id });
    }

    let parsedResult = null;
    if (call.result) {
      try {
        parsedResult = JSON.parse(call.result);
      } catch {
        parsedResult = call.result;
      }
    }

    return {
      id: call.id,
      scopeId: call.scopeId,
      kernelId: call.kernelId,
      toolName: call.toolName,
      args: call.toolArgs,
      status: call.status,
      result: parsedResult,
      error: call.error,
      createdAt: call.createdAt,
      claimedAt: call.claimedAt,
      completedAt: call.completedAt,
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EXECUTION SCOPES
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/relay/:kernelId/scope
  app.post<{
    Params: { kernelId: string };
    Body: {
      jobId?: string;
      createdBy?: string;
      allowedTools?: string[];
      allowedPipettes?: string[];
      allowedSlots?: number[];
      maxCommands?: number;
      maxRetries?: number;
      expiresInMinutes?: number;
    };
  }>("/api/relay/:kernelId/scope", async (req, reply) => {
    const { kernelId } = req.params;
    const {
      jobId,
      createdBy,
      allowedTools,
      allowedPipettes,
      allowedSlots,
      maxCommands,
      maxRetries,
      expiresInMinutes,
    } = req.body ?? {};

    if (!createdBy || !allowedTools) {
      return reply.status(400).send({
        error: "createdBy and allowedTools are required",
      });
    }

    if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
      return reply.status(400).send({
        error: "allowedTools must be a non-empty array of tool names",
      });
    }

    const id = generateId("scope");
    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + (expiresInMinutes ?? 30) * 60_000).toISOString();

    const { db } = getStore();
    db.insert(executionScopes).values({
      id,
      kernelId,
      jobId: jobId ?? null,
      createdBy,
      status: "active",
      allowedTools,
      allowedPipettes: allowedPipettes ?? null,
      allowedSlots: allowedSlots ?? null,
      maxCommands: maxCommands ?? 100,
      commandCount: 0,
      maxRetries: maxRetries ?? 3,
      retryCount: 0,
      createdAt: now,
      expiresAt: expiry,
    }).run();

    return reply.status(201).send({
      id,
      kernelId,
      jobId: jobId ?? null,
      createdBy,
      status: "active",
      allowedTools,
      allowedPipettes: allowedPipettes ?? null,
      allowedSlots: allowedSlots ?? null,
      maxCommands: maxCommands ?? 100,
      commandCount: 0,
      maxRetries: maxRetries ?? 3,
      retryCount: 0,
      createdAt: now,
      expiresAt: expiry,
    });
  });

  // GET /api/relay/:kernelId/scope/:scopeId
  app.get<{
    Params: { kernelId: string; scopeId: string };
  }>("/api/relay/:kernelId/scope/:scopeId", async (req, reply) => {
    const { scopeId } = req.params;

    const { db } = getStore();
    const scope = db
      .select()
      .from(executionScopes)
      .where(eq(executionScopes.id, scopeId))
      .get();

    if (!scope) {
      return reply.status(404).send({ error: "Scope not found", id: scopeId });
    }

    // Check if expired and auto-update status
    if (scope.status === "active" && new Date(scope.expiresAt) < new Date()) {
      db.update(executionScopes)
        .set({ status: "expired" })
        .where(eq(executionScopes.id, scopeId))
        .run();
      scope.status = "expired";
    }

    return {
      ...scope,
      remainingCommands: scope.maxCommands - scope.commandCount,
      remainingRetries: scope.maxRetries - scope.retryCount,
    };
  });

  // POST /api/relay/:kernelId/scope/:scopeId/revoke
  app.post<{
    Params: { kernelId: string; scopeId: string };
  }>("/api/relay/:kernelId/scope/:scopeId/revoke", async (req, reply) => {
    const { scopeId } = req.params;

    const { db } = getStore();
    const scope = db
      .select()
      .from(executionScopes)
      .where(eq(executionScopes.id, scopeId))
      .get();

    if (!scope) {
      return reply.status(404).send({ error: "Scope not found", id: scopeId });
    }

    if (scope.status === "revoked") {
      return reply.status(409).send({ error: "Scope already revoked", id: scopeId });
    }

    db.update(executionScopes)
      .set({ status: "revoked" })
      .where(eq(executionScopes.id, scopeId))
      .run();

    // Reject any pending tool calls under this scope
    const pendingCalls = db
      .select()
      .from(toolCallRelay)
      .where(eq(toolCallRelay.scopeId, scopeId))
      .all();

    const now = new Date().toISOString();
    let rejectedCount = 0;
    for (const call of pendingCalls) {
      if (call.status === "pending" || call.status === "claimed") {
        db.update(toolCallRelay)
          .set({
            status: "rejected",
            error: "scope_revoked",
            completedAt: now,
          })
          .where(eq(toolCallRelay.id, call.id))
          .run();
        rejectedCount++;
      }
    }

    return {
      id: scopeId,
      status: "revoked",
      rejectedPendingCalls: rejectedCount,
    };
  });

  // GET /api/relay/:kernelId/scope/:scopeId/audit
  app.get<{
    Params: { kernelId: string; scopeId: string };
    Querystring: { limit?: string };
  }>("/api/relay/:kernelId/scope/:scopeId/audit", async (req, reply) => {
    const { scopeId } = req.params;
    const limit = Math.min(parseInt(req.query.limit ?? "100", 10), 500);

    const { db } = getStore();

    const scope = db
      .select()
      .from(executionScopes)
      .where(eq(executionScopes.id, scopeId))
      .get();

    if (!scope) {
      return reply.status(404).send({ error: "Scope not found", id: scopeId });
    }

    const calls = db
      .select()
      .from(toolCallRelay)
      .where(eq(toolCallRelay.scopeId, scopeId))
      .orderBy(toolCallRelay.createdAt)
      .limit(limit)
      .all();

    const parsed = calls.map((c) => {
      let parsedResult = null;
      if (c.result) {
        try {
          parsedResult = JSON.parse(c.result);
        } catch {
          parsedResult = c.result;
        }
      }
      return {
        id: c.id,
        toolName: c.toolName,
        args: c.toolArgs,
        status: c.status,
        result: parsedResult,
        error: c.error,
        createdAt: c.createdAt,
        claimedAt: c.claimedAt,
        completedAt: c.completedAt,
      };
    });

    const statusCounts: Record<string, number> = {};
    for (const c of calls) {
      statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
    }

    return {
      scopeId,
      scopeStatus: scope.status,
      commandCount: scope.commandCount,
      maxCommands: scope.maxCommands,
      retryCount: scope.retryCount,
      maxRetries: scope.maxRetries,
      calls: parsed,
      totalCalls: calls.length,
      statusCounts,
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMERA RELAY
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/relay/:kernelId/camera/frame
  app.post<{
    Params: { kernelId: string };
    Body: {
      frame?: string;
      capturedAt?: string;
    };
  }>("/api/relay/:kernelId/camera/frame", async (req, reply) => {
    const { kernelId } = req.params;
    const { frame, capturedAt } = req.body ?? {};

    if (!frame) {
      return reply.status(400).send({ error: "frame (base64 JPEG) is required" });
    }

    // Max ~5MB JPEG
    if (frame.length > 5 * 1024 * 1024 * 1.37) {
      return reply.status(400).send({ error: "Frame too large (max ~5MB JPEG)" });
    }

    const id = generateId("frame");
    const now = capturedAt ?? new Date().toISOString();

    const { db } = getStore();

    db.insert(ot2CameraFrames).values({
      id,
      kernelId,
      frameData: frame,
      capturedAt: now,
    }).run();

    // Keep only latest 5 frames per kernel
    const allFrames = db
      .select({ id: ot2CameraFrames.id })
      .from(ot2CameraFrames)
      .where(eq(ot2CameraFrames.kernelId, kernelId))
      .orderBy(sql`${ot2CameraFrames.capturedAt} DESC`)
      .all();

    if (allFrames.length > 5) {
      const toDelete = allFrames.slice(5);
      for (const old of toDelete) {
        db.delete(ot2CameraFrames).where(eq(ot2CameraFrames.id, old.id)).run();
      }
    }

    // Notify SSE clients for this kernel
    const clients = getStreamClients(kernelId);
    const ssePayload = `event: frame\ndata: ${JSON.stringify({ id, kernelId, capturedAt: now })}\n\n`;
    for (const client of clients) {
      try {
        client.raw.write(ssePayload);
      } catch {
        clients.delete(client);
      }
    }

    return reply.status(201).send({
      id,
      kernelId,
      capturedAt: now,
      framesKept: Math.min(allFrames.length, 5),
    });
  });

  // GET /api/relay/:kernelId/camera/latest
  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/camera/latest", async (req, reply) => {
    const { kernelId } = req.params;
    const callerId = (req as any).operatorId ?? "anonymous";

    // Camera auth: only operator or active scope holder
    if (!hasCameraAccess(callerId, kernelId)) {
      return reply.status(403).send({
        error: "camera_access_denied",
        message: "Camera access requires operator privileges or an active execution scope.",
      });
    }

    const { db } = getStore();
    const latest = db
      .select()
      .from(ot2CameraFrames)
      .where(eq(ot2CameraFrames.kernelId, kernelId))
      .orderBy(sql`${ot2CameraFrames.capturedAt} DESC`)
      .limit(1)
      .get();

    if (!latest) {
      return reply.status(404).send({ error: "No frames available" });
    }

    const buffer = Buffer.from(latest.frameData, "base64");
    return reply
      .header("Content-Type", "image/jpeg")
      .header("X-Frame-Id", latest.id)
      .header("X-Captured-At", latest.capturedAt)
      .send(buffer);
  });

  // GET /api/relay/:kernelId/camera/snapshot
  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/camera/snapshot", async (req, reply) => {
    const { kernelId } = req.params;
    const callerId = (req as any).operatorId ?? "anonymous";

    // Camera auth: only operator or active scope holder
    if (!hasCameraAccess(callerId, kernelId)) {
      return reply.status(403).send({
        error: "camera_access_denied",
        message: "Camera access requires operator privileges or an active execution scope.",
      });
    }

    const { db } = getStore();
    const latest = db
      .select()
      .from(ot2CameraFrames)
      .where(eq(ot2CameraFrames.kernelId, kernelId))
      .orderBy(sql`${ot2CameraFrames.capturedAt} DESC`)
      .limit(1)
      .get();

    if (!latest) {
      return reply.status(404).send({ error: "No frames available" });
    }

    return {
      id: latest.id,
      kernelId: latest.kernelId,
      frame: latest.frameData,
      capturedAt: latest.capturedAt,
    };
  });

  // GET /api/relay/:kernelId/camera/stream
  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/camera/stream", async (req, reply) => {
    const { kernelId } = req.params;

    // Strict origin check — prevent subdomain spoofing (red team #47)
    const SSE_ALLOWED = new Set([
      "https://capability.network",
      "http://localhost:5173",
      "http://localhost:3200",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:3200",
    ]);
    const origin = req.headers.origin as string | undefined;
    const allowOrigin = origin && SSE_ALLOWED.has(origin) ? origin : "https://capability.network";

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate, private",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Credentials": "true",
    });

    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ type: "connected", kernelId })}\n\n`);

    const clients = getStreamClients(kernelId);
    clients.add(reply);

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
        clients.delete(reply);
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(reply);
    });

    await new Promise<void>(() => {});
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAT RELAY
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/relay/:kernelId/chat
  app.post<{
    Params: { kernelId: string };
    Body: {
      message?: string;
    };
  }>("/api/relay/:kernelId/chat", async (req, reply) => {
    const { kernelId } = req.params;
    const { message } = req.body ?? {};

    if (!message) {
      return reply.status(400).send({ error: "message is required" });
    }

    if (message.length > 10_000) {
      return reply.status(400).send({ error: "Message too long (max 10000 chars)" });
    }

    const id = generateId("msg");
    const now = new Date().toISOString();

    const { db } = getStore();
    db.insert(ot2ChatMessages).values({
      id,
      kernelId,
      role: "user",
      content: message,
      status: "pending",
      createdAt: now,
    }).run();

    return reply.status(201).send({
      id,
      kernelId,
      role: "user",
      content: message,
      status: "pending",
      createdAt: now,
    });
  });

  // GET /api/relay/:kernelId/chat/messages
  app.get<{
    Params: { kernelId: string };
    Querystring: { limit?: string };
  }>("/api/relay/:kernelId/chat/messages", async (req) => {
    const { kernelId } = req.params;
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10), 200);

    const { db } = getStore();
    const messages = db
      .select()
      .from(ot2ChatMessages)
      .where(eq(ot2ChatMessages.kernelId, kernelId))
      .orderBy(ot2ChatMessages.createdAt)
      .limit(limit)
      .all();

    return { messages, count: messages.length };
  });

  // GET /api/relay/:kernelId/chat/pending
  app.get<{
    Params: { kernelId: string };
  }>("/api/relay/:kernelId/chat/pending", async (req) => {
    const { kernelId } = req.params;

    const { db } = getStore();
    const pending = db
      .select()
      .from(ot2ChatMessages)
      .where(
        and(
          eq(ot2ChatMessages.kernelId, kernelId),
          eq(ot2ChatMessages.role, "user"),
          eq(ot2ChatMessages.status, "pending"),
        ),
      )
      .orderBy(ot2ChatMessages.createdAt)
      .all();

    for (const msg of pending) {
      db.update(ot2ChatMessages)
        .set({ status: "processing" })
        .where(eq(ot2ChatMessages.id, msg.id))
        .run();
    }

    return { messages: pending, count: pending.length };
  });

  // POST /api/relay/:kernelId/chat/respond
  app.post<{
    Params: { kernelId: string };
    Body: {
      messageId?: string;
      response?: string;
      toolCalls?: unknown[];
    };
  }>("/api/relay/:kernelId/chat/respond", async (req, reply) => {
    const { kernelId } = req.params;
    const { messageId, response, toolCalls } = req.body ?? {};

    if (!response) {
      return reply.status(400).send({ error: "response is required" });
    }

    const { db } = getStore();

    // Mark original message as completed if provided
    if (messageId) {
      db.update(ot2ChatMessages)
        .set({ status: "completed" })
        .where(eq(ot2ChatMessages.id, messageId))
        .run();
    }

    const id = generateId("msg");
    const now = new Date().toISOString();

    db.insert(ot2ChatMessages).values({
      id,
      kernelId,
      role: "assistant",
      content: response,
      toolCalls: toolCalls ?? null,
      status: "completed",
      createdAt: now,
    }).run();

    return reply.status(201).send({
      id,
      kernelId,
      role: "assistant",
      content: response,
      toolCalls: toolCalls ?? null,
      status: "completed",
      createdAt: now,
    });
  });
}
