/**
 * OT-2 Chat Relay Routes
 *
 * Real-time chat with a remote OT-2 agent through PCC.
 * The OT-2 is on a private network — it can reach capability.network
 * but nobody can reach it directly. This relay bridges that gap.
 *
 * POST /api/ot2/chat           — User sends a message
 * GET  /api/ot2/chat/messages  — Get conversation history
 * GET  /api/ot2/chat/pending   — Agent polls for new user messages
 * POST /api/ot2/chat/respond   — Agent posts its response
 */

import type { FastifyInstance } from "fastify";
import { getStore } from "../db.js";
import { schema, eq, and, sql } from "@pcc/store";

const { ot2ChatMessages } = schema;

function generateId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function ot2ChatRoutes(app: FastifyInstance) {
  // Ensure the table exists (idempotent — handles fresh deploys without migrations)
  const { db } = getStore();
  db.run(sql`CREATE TABLE IF NOT EXISTS ot2_chat_messages (
    id TEXT PRIMARY KEY,
    kernel_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`);

  // ── POST /api/ot2/chat — User sends a message ────────────────────
  app.post<{
    Body: {
      kernelId?: string;
      message?: string;
    };
  }>("/api/ot2/chat", async (req, reply) => {
    const { kernelId, message } = req.body ?? {};

    if (!kernelId || !message) {
      return reply.status(400).send({ error: "kernelId and message are required" });
    }

    if (message.length > 10_000) {
      return reply.status(400).send({ error: "Message too long (max 10000 chars)" });
    }

    const id = generateId();
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

  // ── GET /api/ot2/chat/messages — Conversation history ─────────────
  app.get<{
    Querystring: {
      kernelId?: string;
      limit?: string;
    };
  }>("/api/ot2/chat/messages", async (req, reply) => {
    const kernelId = req.query.kernelId ?? "kernel-nanoclaw";
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

  // ── GET /api/ot2/chat/pending — Agent polls for new user messages ─
  app.get<{
    Querystring: {
      kernelId?: string;
    };
  }>("/api/ot2/chat/pending", async (req) => {
    const kernelId = req.query.kernelId ?? "kernel-nanoclaw";

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

    // Mark them as processing so they aren't double-fetched
    for (const msg of pending) {
      db.update(ot2ChatMessages)
        .set({ status: "processing" })
        .where(eq(ot2ChatMessages.id, msg.id))
        .run();
    }

    return { messages: pending, count: pending.length };
  });

  // ── POST /api/ot2/chat/respond — Agent posts its response ────────
  app.post<{
    Body: {
      messageId?: string;
      response?: string;
      toolCalls?: unknown[];
      kernelId?: string;
    };
  }>("/api/ot2/chat/respond", async (req, reply) => {
    const { messageId, response, toolCalls, kernelId } = req.body ?? {};

    if (!response) {
      return reply.status(400).send({ error: "response is required" });
    }

    const resolvedKernelId = kernelId ?? "kernel-nanoclaw";
    const { db } = getStore();

    // If messageId is provided, mark the original message as completed
    if (messageId) {
      db.update(ot2ChatMessages)
        .set({ status: "completed" })
        .where(eq(ot2ChatMessages.id, messageId))
        .run();
    }

    // Insert the assistant response
    const id = generateId();
    const now = new Date().toISOString();

    db.insert(ot2ChatMessages).values({
      id,
      kernelId: resolvedKernelId,
      role: "assistant",
      content: response,
      toolCalls: toolCalls ?? null,
      status: "completed",
      createdAt: now,
    }).run();

    return reply.status(201).send({
      id,
      kernelId: resolvedKernelId,
      role: "assistant",
      content: response,
      toolCalls: toolCalls ?? null,
      status: "completed",
      createdAt: now,
    });
  });
}
