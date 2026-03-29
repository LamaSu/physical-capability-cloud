/**
 * OT-2 Execution Scope Routes
 *
 * Execution scopes define what a brain agent is allowed to do on a specific
 * OT-2 for a specific job. They enforce tool allowlists, command budgets,
 * and time limits.
 *
 * POST /api/ot2/scope              — Create an execution scope
 * GET  /api/ot2/scope/:id          — Get scope details
 * POST /api/ot2/scope/:id/revoke   — Revoke a scope (emergency stop)
 * GET  /api/ot2/scope/:id/audit    — Get all tool calls made under this scope
 */

import type { FastifyInstance } from "fastify";
import { getStore } from "../db.js";
import { schema, eq, sql } from "@pcc/store";

const { executionScopes, toolCallRelay } = schema;

function generateId(): string {
  return `scope_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function ot2ScopeRoutes(app: FastifyInstance) {
  // Ensure tables exist (idempotent — same DDL as relay routes, CREATE IF NOT EXISTS is safe)
  const { db } = getStore();
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

  // ── POST /api/ot2/scope — Create an execution scope ───────────────
  app.post<{
    Body: {
      kernelId?: string;
      jobId?: string;
      createdBy?: string;
      allowedTools?: string[];
      allowedPipettes?: string[];
      allowedSlots?: number[];
      maxCommands?: number;
      maxRetries?: number;
      expiresInMinutes?: number;
    };
  }>("/api/ot2/scope", async (req, reply) => {
    const {
      kernelId,
      jobId,
      createdBy,
      allowedTools,
      allowedPipettes,
      allowedSlots,
      maxCommands,
      maxRetries,
      expiresInMinutes,
    } = req.body ?? {};

    if (!kernelId || !createdBy || !allowedTools) {
      return reply.status(400).send({
        error: "kernelId, createdBy, and allowedTools are required",
      });
    }

    if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
      return reply.status(400).send({
        error: "allowedTools must be a non-empty array of tool names",
      });
    }

    const id = generateId();
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

  // ── GET /api/ot2/scope/:id — Get scope details ────────────────────
  app.get<{
    Params: {
      id: string;
    };
  }>("/api/ot2/scope/:id", async (req, reply) => {
    const { id } = req.params;

    const { db } = getStore();
    const scope = db
      .select()
      .from(executionScopes)
      .where(eq(executionScopes.id, id))
      .get();

    if (!scope) {
      return reply.status(404).send({ error: "Scope not found", id });
    }

    // Check if expired and auto-update status
    if (scope.status === "active" && new Date(scope.expiresAt) < new Date()) {
      db.update(executionScopes)
        .set({ status: "expired" })
        .where(eq(executionScopes.id, id))
        .run();
      scope.status = "expired";
    }

    return {
      ...scope,
      remainingCommands: scope.maxCommands - scope.commandCount,
      remainingRetries: scope.maxRetries - scope.retryCount,
    };
  });

  // ── POST /api/ot2/scope/:id/revoke — Revoke a scope (emergency stop)
  app.post<{
    Params: {
      id: string;
    };
  }>("/api/ot2/scope/:id/revoke", async (req, reply) => {
    const { id } = req.params;

    const { db } = getStore();
    const scope = db
      .select()
      .from(executionScopes)
      .where(eq(executionScopes.id, id))
      .get();

    if (!scope) {
      return reply.status(404).send({ error: "Scope not found", id });
    }

    if (scope.status === "revoked") {
      return reply.status(409).send({ error: "Scope already revoked", id });
    }

    db.update(executionScopes)
      .set({ status: "revoked" })
      .where(eq(executionScopes.id, id))
      .run();

    // Also reject any pending tool calls under this scope
    const pendingCalls = db
      .select()
      .from(toolCallRelay)
      .where(
        eq(toolCallRelay.scopeId, id),
      )
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
      id,
      status: "revoked",
      rejectedPendingCalls: rejectedCount,
    };
  });

  // ── GET /api/ot2/scope/:id/audit — Get all tool calls under this scope
  app.get<{
    Params: {
      id: string;
    };
    Querystring: {
      limit?: string;
    };
  }>("/api/ot2/scope/:id/audit", async (req, reply) => {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit ?? "100", 10), 500);

    const { db } = getStore();

    // Verify scope exists
    const scope = db
      .select()
      .from(executionScopes)
      .where(eq(executionScopes.id, id))
      .get();

    if (!scope) {
      return reply.status(404).send({ error: "Scope not found", id });
    }

    const calls = db
      .select()
      .from(toolCallRelay)
      .where(eq(toolCallRelay.scopeId, id))
      .orderBy(toolCallRelay.createdAt)
      .limit(limit)
      .all();

    // Parse results back from JSON strings
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

    // Summary counts
    const statusCounts: Record<string, number> = {};
    for (const c of calls) {
      statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
    }

    return {
      scopeId: id,
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
}
