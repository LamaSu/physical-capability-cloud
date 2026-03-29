/**
 * OT-2 Tool-Call Relay Routes
 *
 * The brain (on DGX Spark) posts tool calls here.
 * The executor (on OT-2) polls for pending calls and posts results back.
 * PCC is the relay in the middle.
 *
 * POST /api/ot2/tool-call          — Brain posts a tool call
 * GET  /api/ot2/tool-call/pending  — Executor polls for pending calls
 * POST /api/ot2/tool-result        — Executor posts result
 * GET  /api/ot2/tool-result/:id    — Brain polls for a specific result
 */

import type { FastifyInstance } from "fastify";
import { getStore } from "../db.js";
import { schema, eq, and, sql } from "@pcc/store";

const { toolCallRelay, executionScopes } = schema;

/** Tools that are always allowed regardless of scope */
const SAFE_TOOLS = [
  "ot2_health",
  "ot2_pipettes",
  "ot2_modules",
  "ot2_deck_calibration",
  "ot2_pipette_offset",
  "ot2_tip_length",
  "ot2_lights",
  "ot2_home",
  "ot2_identify",
];

function generateId(): string {
  return `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

interface ScopeValidation {
  allowed: boolean;
  reason: string;
}

function validateToolCall(
  scope: typeof executionScopes.$inferSelect,
  toolName: string,
): ScopeValidation {
  // Safe tools always pass
  if (SAFE_TOOLS.includes(toolName)) {
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

  // Passed all checks
  return { allowed: true, reason: "scope_approved" };
}

export async function ot2RelayRoutes(app: FastifyInstance) {
  // Ensure tables exist (idempotent)
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

  // ── POST /api/ot2/tool-call — Brain posts a tool call ─────────────
  app.post<{
    Body: {
      kernelId?: string;
      scopeId?: string;
      toolName?: string;
      args?: Record<string, unknown>;
    };
  }>("/api/ot2/tool-call", async (req, reply) => {
    const { kernelId, scopeId, toolName, args } = req.body ?? {};

    if (!kernelId || !toolName) {
      return reply.status(400).send({ error: "kernelId and toolName are required" });
    }

    const { db } = getStore();
    const callerId = (req as any).operatorId ?? "anonymous";

    // Non-safe tools require a scope (no free writes)
    if (!SAFE_TOOLS.includes(toolName) && !scopeId) {
      return reply.status(403).send({
        error: "scope_required",
        message: "Write operations require an execution scope. Create one via POST /api/ot2/scope",
      });
    }

    // If a scopeId is provided, validate the tool call against the scope
    if (scopeId) {
      const scope = db
        .select()
        .from(executionScopes)
        .where(eq(executionScopes.id, scopeId))
        .get();

      if (!scope) {
        return reply.status(404).send({ error: "Scope not found", scopeId });
      }

      // Verify caller owns this scope (or is the kernel operator)
      if (scope.createdBy !== callerId && callerId !== "anonymous") {
        // Check if caller is the kernel operator (they can use any scope on their kernel)
        const kernel = db.select().from(schema.shopKernels).where(eq(schema.shopKernels.id, kernelId)).get();
        const isOperator = kernel && (kernel as any).operatorAddress === callerId;
        if (!isOperator) {
          return reply.status(403).send({
            error: "scope_not_yours",
            message: "This scope belongs to a different agent. You can only use scopes you created.",
          });
        }
      }

      const validation = validateToolCall(scope, toolName);
      if (!validation.allowed) {
        // Insert the call as rejected for audit trail
        const id = generateId();
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
      if (!SAFE_TOOLS.includes(toolName)) {
        db.update(executionScopes)
          .set({ commandCount: scope.commandCount + 1 })
          .where(eq(executionScopes.id, scopeId))
          .run();
      }
    }

    const id = generateId();
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

  // ── GET /api/ot2/tool-call/pending — Executor polls for pending calls
  app.get<{
    Querystring: {
      kernelId?: string;
    };
  }>("/api/ot2/tool-call/pending", async (req) => {
    const kernelId = req.query.kernelId ?? "kernel-nanoclaw";

    const { db } = getStore();
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

    // Mark them as claimed so they aren't double-fetched
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

  // ── POST /api/ot2/tool-result — Executor posts result ─────────────
  app.post<{
    Body: {
      callId?: string;
      result?: unknown;
      error?: string;
    };
  }>("/api/ot2/tool-result", async (req, reply) => {
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

    // If failed and scope has retries left, check retry budget
    if (error && call.scopeId) {
      const scope = db
        .select()
        .from(executionScopes)
        .where(eq(executionScopes.id, call.scopeId))
        .get();

      if (scope && scope.retryCount < scope.maxRetries) {
        // Increment retry count on the scope
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

  // ── GET /api/ot2/tool-result/:id — Brain polls for a specific result
  app.get<{
    Params: {
      id: string;
    };
  }>("/api/ot2/tool-result/:id", async (req, reply) => {
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

    // Parse result back from JSON string if present
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
}
