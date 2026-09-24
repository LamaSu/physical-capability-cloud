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
 *
 * Access (N4b-gw item 4): default-deny, per kernel. Every route is listed in
 * RELAY_ROUTE_ACCESS below and a preHandler enforces it; a route missing from
 * the table is refused. The caller is the authenticated principal (req.userId,
 * set by apiGate for an API key or a SIWE session); with none the answer is
 * 401, never an "anonymous" pass.
 *   - kernel_operator: the device side (claim pending calls, report results,
 *     push camera frames, read and answer chat) and minting scopes. Only the
 *     principal recorded as the kernel's operatorAddress.
 *   - operator_or_grant: the operator, or a principal holding an active,
 *     unexpired execution scope on this kernel.
 *   - object_owner: routes addressing one scope or one call. The handler
 *     allows the kernel operator or the scope's creator, and the object must
 *     belong to the :kernelId in the path.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getStore, getRepos } from "../db.js";
import { schema, eq, and, sql } from "@pcc/store";
import { isToolSafe, getManifest, warmManifestCache } from "../services/tool-manifest-service.js";
import { getSafetyGateway, initSafetyGateway } from "@pcc/kernel";

const {
  toolCallRelay,
  executionScopes,
  ot2CameraFrames,
  ot2ChatMessages,
  shopKernels,
  negotiationSessions,
} = schema;

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

// ── Access control (N4b-gw item 4) ──────────────────────────────────────────

export type RelayAccess = "kernel_operator" | "operator_or_grant" | "object_owner";

/**
 * The complete access table for this plugin, keyed "METHOD /route/pattern".
 * The preHandler refuses any route of this plugin that is not listed here, so
 * a new relay route stays closed until someone decides who may call it.
 */
export const RELAY_ROUTE_ACCESS: Readonly<Record<string, RelayAccess>> = {
  "GET /api/relay/:kernelId/manifest": "operator_or_grant",
  "POST /api/relay/:kernelId/tool-call": "operator_or_grant",
  "GET /api/relay/:kernelId/tool-call/pending": "kernel_operator",
  "POST /api/relay/:kernelId/tool-result": "kernel_operator",
  "GET /api/relay/:kernelId/tool-result/:id": "object_owner",
  "POST /api/relay/:kernelId/scope": "kernel_operator",
  "GET /api/relay/:kernelId/scope/:scopeId": "object_owner",
  "POST /api/relay/:kernelId/scope/:scopeId/revoke": "object_owner",
  "GET /api/relay/:kernelId/scope/:scopeId/audit": "object_owner",
  "POST /api/relay/:kernelId/camera/frame": "kernel_operator",
  "GET /api/relay/:kernelId/camera/latest": "operator_or_grant",
  "GET /api/relay/:kernelId/camera/snapshot": "operator_or_grant",
  "GET /api/relay/:kernelId/camera/stream": "operator_or_grant",
  "POST /api/relay/:kernelId/chat": "operator_or_grant",
  "GET /api/relay/:kernelId/chat/messages": "operator_or_grant",
  "GET /api/relay/:kernelId/chat/pending": "kernel_operator",
  "POST /api/relay/:kernelId/chat/respond": "kernel_operator",
};

/** operatorAddress values that record no owner (same set as kernel.facade.ts). */
const UNOWNED_OPERATOR_ADDRESSES = new Set([
  "",
  "0x0000000000000000000000000000000000000000",
]);

/** The authenticated principal apiGate resolved (API key or SIWE), or null. */
function relayPrincipal(req: FastifyRequest): string | null {
  const id = req.userId ?? req.operatorId ?? null;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** True only when `principal` is the recorded operator of `kernelId`. */
function isKernelOperator(kernelId: string, principal: string): boolean {
  const { db } = getStore();
  const kernel = db.select().from(shopKernels).where(eq(shopKernels.id, kernelId)).get();
  if (!kernel || UNOWNED_OPERATOR_ADDRESSES.has(kernel.operatorAddress)) return false;
  return kernel.operatorAddress === principal;
}

/** True when `principal` created an active, unexpired scope on `kernelId`. */
function holdsActiveScope(kernelId: string, principal: string): boolean {
  const { db } = getStore();
  const now = new Date();
  return db
    .select()
    .from(executionScopes)
    .where(
      and(
        eq(executionScopes.kernelId, kernelId),
        eq(executionScopes.createdBy, principal),
        eq(executionScopes.status, "active"),
      ),
    )
    .all()
    .some((scope) => new Date(scope.expiresAt) > now);
}

/** Operator of the kernel, or the creator of this scope. */
function ownsScope(
  scope: typeof executionScopes.$inferSelect,
  kernelId: string,
  principal: string,
): boolean {
  return scope.createdBy === principal || isKernelOperator(kernelId, principal);
}

/**
 * Load the scope a scope/:scopeId route addresses. Replies 404 unless the
 * scope is on :kernelId, and 403 unless the caller is the kernel operator or
 * the scope's creator.
 */
function ownedScopeOrReply(
  req: FastifyRequest<{ Params: { kernelId: string; scopeId: string } }>,
  reply: FastifyReply,
): typeof executionScopes.$inferSelect | null {
  const { kernelId, scopeId } = req.params;
  const { db } = getStore();
  const scope = db.select().from(executionScopes).where(eq(executionScopes.id, scopeId)).get();
  if (!scope || scope.kernelId !== kernelId) {
    reply.status(404).send({ error: "Scope not found", id: scopeId });
    return null;
  }
  if (!ownsScope(scope, kernelId, relayPrincipal(req)!)) {
    reply.status(403).send({
      error: "scope_not_yours",
      message: "Only the kernel operator or the scope's creator may use this scope.",
    });
    return null;
  }
  return scope;
}

/** preHandler for every relay route: default-deny, per kernel. */
async function relayAccessGuard(req: FastifyRequest, reply: FastifyReply) {
  const principal = relayPrincipal(req);
  if (!principal) {
    return reply.status(401).send({
      error: "authentication_required",
      message: "The device relay requires the kernel operator's key or an execution scope holder's key.",
    });
  }

  const routeKey = `${req.method} ${req.routeOptions.url}`;
  const access = RELAY_ROUTE_ACCESS[routeKey];
  if (!access) {
    return reply.status(403).send({ error: "relay_route_not_allowed", route: routeKey });
  }
  if (access === "object_owner") return; // the handler checks the addressed object

  const { kernelId } = req.params as { kernelId: string };
  if (isKernelOperator(kernelId, principal)) return;
  if (access === "operator_or_grant" && holdsActiveScope(kernelId, principal)) return;

  return reply.status(403).send({
    error: "relay_access_denied",
    required: access === "kernel_operator" ? "kernel_operator" : "kernel_operator_or_active_scope",
    message:
      access === "kernel_operator"
        ? "Only this kernel's operator may use this relay route."
        : "Requires this kernel's operator or an active execution scope on this kernel.",
  });
}

/**
 * Parity with the retired /api/ot2/tool-call: a scoped write under a scope
 * bound to a job is refused while that job's escrow exists and is not funded.
 * Unlike the legacy route, a lookup error refuses the call instead of
 * letting it through. N4b-gw item 5 (gateway, R30) replaces this with the
 * accepted, funded job and committed-protocol check.
 */
function escrowRefusal(scope: typeof executionScopes.$inferSelect): string | null {
  if (!scope.jobId) return null;
  const repos = getRepos();
  const job = repos.jobs.findById(scope.jobId);
  if (!job) return null;
  const { db } = getStore();
  const session = db
    .select()
    .from(negotiationSessions)
    .where(eq(negotiationSessions.jobId, scope.jobId))
    .get();
  if (!session?.cwmId) return null;
  const escrow = repos.escrows.findByCwm(session.cwmId);
  if (escrow && escrow.status !== "funded" && escrow.status !== "active" && escrow.status !== "completed") {
    return escrow.status;
  }
  return null;
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

  // Default-deny, per kernel, for every route below (see RELAY_ROUTE_ACCESS).
  app.addHook("preHandler", relayAccessGuard);

  // Ensure tables exist (idempotent; packages/db/src/migrate.ts creates them too)
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
    // The guard admitted this caller as the operator or an active scope holder.
    const callerId = relayPrincipal(req)!;
    const isOperator = isKernelOperator(kernelId, callerId);
    const deviceType = resolveDeviceType(kernelId);

    // Non-safe tools require a scope, and anyone but the operator must name
    // their own scope for every call.
    if (!scopeId && (!isOperator || !isToolSafe(deviceType, toolName))) {
      return reply.status(403).send({
        error: "scope_required",
        message: isOperator
          ? `Write operations require an execution scope. Create one via POST /api/relay/${kernelId}/scope`
          : "Name the execution scope you were granted on this kernel (scopeId).",
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
      if (scope.createdBy !== callerId && !isOperator) {
        return reply.status(403).send({
          error: "scope_not_yours",
          message: "This scope belongs to a different agent.",
        });
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

      if (!isToolSafe(deviceType, toolName)) {
        // Escrow gate carried over from the retired /api/ot2/tool-call.
        let unfundedStatus: string | null;
        try {
          unfundedStatus = escrowRefusal(scope);
        } catch (err) {
          return reply.status(503).send({
            error: "escrow_check_unavailable",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        if (unfundedStatus) {
          const id = generateId("tc");
          db.insert(toolCallRelay).values({
            id,
            scopeId,
            kernelId,
            toolName,
            toolArgs: args ?? {},
            status: "rejected",
            error: "escrow_not_funded",
            createdAt: new Date().toISOString(),
          }).run();
          return reply.status(402).send({
            error: "Escrow not funded",
            reason: "escrow_not_funded",
            escrowStatus: unfundedStatus,
            callId: id,
            toolName,
            scopeId,
          });
        }

        // Increment command count for non-safe tools
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

      // Admission check only (no execution). The actual work happens on-device:
      // the executor polls tool_call_relay and later reports the outcome to
      // POST /tool-result, which records the real success/failure to the breaker.
      // (Passing a no-op execute to validateAndRelay here recorded a phantom
      // success on every relayed call and kept the breaker permanently closed.)
      const safetyVerdict = await gateway.validateOnly({
        commandId: generateId("cmd"),
        deviceId: kernelId,
        class: scopeId ? "scoped" : "safe",
        type: toolName,
        params: (args ?? {}) as Record<string, unknown>,
        agentDid,
        scopeId: scopeId ?? undefined,
      });

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

    // ── Caller-ownership check (safety review S3 F2; N4b-gw) ────────────────
    // Reporting a result mutates the safety circuit breaker for call.kernelId
    // (recordDeviceFailure/Success below) and is the device's own outcome.
    // The guard admitted only the operator of :kernelId (the on-device
    // executor runs under the operator). The call must also belong to that
    // kernel, so an operator cannot report, trip or reset another kernel's
    // calls by naming their callId. A scope holder commands; it never reports.
    if (call.kernelId !== req.params.kernelId) {
      return reply.status(403).send({
        error: "tool_result_not_yours",
        message: "This tool call belongs to a different kernel.",
      });
    }

    // ── Idempotency / breaker-integrity guard (finding F2) ───────────────────
    // Only the FIRST terminal transition of a call records its outcome. A call
    // that is already completed/failed/rejected is treated as an idempotent
    // no-op ack: a poll-based executor retrying its POST after a dropped 200 —
    // or a replayed callId — must neither double-count a breaker trip nor
    // spuriously reset a tripped breaker.
    if (
      call.status === "completed" ||
      call.status === "failed" ||
      call.status === "rejected"
    ) {
      return reply.status(200).send({
        callId,
        status: call.status,
        completedAt: call.completedAt ?? null,
        idempotent: true,
      });
    }

    const now = new Date().toISOString();
    const newStatus = error ? "failed" : "completed";

    // Feed the executor's REAL outcome back into the safety circuit breaker.
    // The tool-call admission (validateOnly) keyed the breaker by kernelId, so
    // the outcome MUST be recorded under the same key — this is what lets a
    // device that keeps failing on the executor actually trip the breaker and
    // block subsequent relayed commands. (A relayed tool call is kernel-scoped;
    // the relay row carries no finer deviceId.) Non-fatal if gateway is absent.
    //
    // Guarded on 'claimed': only a call that was admitted AND picked up by an
    // executor carries a real device outcome. The terminal-state guard above
    // already excluded replays, so this is the single first-transition record.
    if (call.status === "claimed") {
      try {
        const gateway = getSafetyGateway();
        if (error) {
          gateway.recordDeviceFailure(call.kernelId);
        } else {
          gateway.recordDeviceSuccess(call.kernelId);
        }
      } catch {
        // Gateway not initialised — result recording proceeds without the breaker.
      }
    }

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
    const { kernelId, id } = req.params;

    const { db } = getStore();
    const call = db
      .select()
      .from(toolCallRelay)
      .where(eq(toolCallRelay.id, id))
      .get();

    if (!call || call.kernelId !== kernelId) {
      return reply.status(404).send({ error: "Tool call not found", id });
    }

    // Object owner: the kernel operator, or the creator of the call's scope.
    const principal = relayPrincipal(req)!;
    const scope = call.scopeId
      ? db.select().from(executionScopes).where(eq(executionScopes.id, call.scopeId)).get()
      : undefined;
    const allowed = scope
      ? ownsScope(scope, kernelId, principal)
      : isKernelOperator(kernelId, principal);
    if (!allowed) {
      return reply.status(403).send({
        error: "tool_result_not_yours",
        message: "Only the kernel operator or the owning execution scope may read this result.",
      });
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

    if (!allowedTools) {
      return reply.status(400).send({
        error: "allowedTools is required",
      });
    }

    if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
      return reply.status(400).send({
        error: "allowedTools must be a non-empty array of tool names",
      });
    }

    // Only the kernel operator reaches this handler (guard). The scope is the
    // operator's own unless the operator names the principal it delegates to.
    const holder = createdBy ?? relayPrincipal(req)!;

    // A scope may only be bound to a job on this kernel: its tool calls are
    // counted into that job's completion record.
    if (jobId) {
      const job = getRepos().jobs.findById(jobId);
      if (!job || job.kernelId !== kernelId) {
        return reply.status(400).send({
          error: "job_not_on_kernel",
          message: "jobId must name a job on this kernel.",
        });
      }
    }

    const id = generateId("scope");
    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + (expiresInMinutes ?? 30) * 60_000).toISOString();

    const { db } = getStore();
    db.insert(executionScopes).values({
      id,
      kernelId,
      jobId: jobId ?? null,
      createdBy: holder,
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
      createdBy: holder,
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
    const scope = ownedScopeOrReply(req, reply);
    if (!scope) return reply;

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
    const scope = ownedScopeOrReply(req, reply);
    if (!scope) return reply;

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

    const scope = ownedScopeOrReply(req, reply);
    if (!scope) return reply;

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
    // Camera auth (operator or active scope holder) is the relay guard's.
    const { kernelId } = req.params;

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
    // Camera auth (operator or active scope holder) is the relay guard's.
    const { kernelId } = req.params;

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

    // Mark original message as completed if provided (only this kernel's)
    if (messageId) {
      db.update(ot2ChatMessages)
        .set({ status: "completed" })
        .where(and(eq(ot2ChatMessages.id, messageId), eq(ot2ChatMessages.kernelId, kernelId)))
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
