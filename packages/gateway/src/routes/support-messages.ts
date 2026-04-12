/**
 * Operator support messaging — in-gateway communication channel.
 *
 * Operators send messages (with optional diagnostic retrieval codes)
 * directly from pcc-node. Admin sees all threads and can reply.
 * Operators poll for replies.
 *
 *   POST /api/operator/support              — send a support message
 *   GET  /api/operator/support              — list all threads (admin)
 *   GET  /api/operator/support/mine         — operator checks their thread
 *   GET  /api/operator/support/:threadId    — get a specific thread
 *   POST /api/operator/support/:threadId/reply — reply to a thread
 *   PATCH /api/operator/support/:threadId   — update thread status (admin)
 */

import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";

// Discord webhook for #bug-reports notifications
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";

async function notifyDiscord(thread: SupportThread, msg: Message): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return;

  const priorityEmoji: Record<string, string> = {
    urgent: "🔴",
    high: "🟠",
    normal: "🟡",
    low: "⚪",
  };

  const emoji = priorityEmoji[thread.priority] ?? "⚪";
  const logsNote = msg.retrievalCode
    ? `\n📎 Logs attached: \`${msg.retrievalCode}\``
    : "";

  const content = [
    `${emoji} **New support message** from \`${thread.kernelName || thread.kernelId}\``,
    `> ${msg.text.slice(0, 300)}${msg.text.length > 300 ? "..." : ""}`,
    logsNote,
    `Thread: \`${thread.id}\` | Priority: **${thread.priority}** | Platform: ${thread.systemInfo?.platform ?? "unknown"}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, username: "PCC Support" }),
    });
    if (!res.ok) {
      console.error(`Discord webhook failed: ${res.status}`);
    }
  } catch (err) {
    // Non-fatal — don't break support flow if Discord is down
    console.error(`Discord webhook error: ${err}`);
  }
}

interface Message {
  id: string;
  from: "operator" | "admin";
  text: string;
  timestamp: string;
  retrievalCode?: string; // attached diagnostic retrieval code
}

interface SupportThread {
  id: string;
  kernelId: string;
  kernelName: string;
  operatorIp: string;
  subject: string;
  status: "open" | "in-progress" | "resolved" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  systemInfo?: {
    platform?: string;
    nodeVersion?: string;
    daemonRunning?: boolean;
    gatewayReachable?: boolean;
  };
}

// In-memory store — same pattern as diagnostic-logs
const MAX_THREADS = 200;
const threads: SupportThread[] = [];

function findThread(threadId: string): SupportThread | undefined {
  return threads.find((t) => t.id === threadId);
}

function findThreadByKernel(kernelId: string): SupportThread | undefined {
  // Find most recent open thread for this kernel
  return [...threads]
    .reverse()
    .find((t) => t.kernelId === kernelId && t.status !== "closed");
}

function inferPriority(text: string): SupportThread["priority"] {
  const lower = text.toLowerCase();
  if (
    lower.includes("crash") ||
    lower.includes("data loss") ||
    lower.includes("urgent") ||
    lower.includes("production down")
  ) {
    return "urgent";
  }
  if (
    lower.includes("error") ||
    lower.includes("fail") ||
    lower.includes("broken") ||
    lower.includes("not working")
  ) {
    return "high";
  }
  if (lower.includes("slow") || lower.includes("warning") || lower.includes("help")) {
    return "normal";
  }
  return "low";
}

export async function supportMessageRoutes(app: FastifyInstance) {
  /**
   * POST /api/operator/support
   *
   * Operator sends a support message. Creates a new thread or appends
   * to an existing open thread for this kernel.
   *
   * Body: {
   *   kernelId: string,
   *   kernelName?: string,
   *   message: string,
   *   subject?: string,
   *   retrievalCode?: string,   // from `pcc-node logs`
   *   systemInfo?: { platform, nodeVersion, daemonRunning, gatewayReachable }
   * }
   */
  app.post<{
    Body: {
      kernelId?: string;
      kernelName?: string;
      message?: string;
      subject?: string;
      retrievalCode?: string;
      systemInfo?: Record<string, unknown>;
    };
  }>("/api/operator/support", async (req, reply) => {
    // Rate limit: 5 support messages per operator per 10 minutes (Discord webhook flood prevention, R5 NEW-04)
    const callerId = (req as any).operatorId ?? (req as any).userId ?? req.ip;
    const { checkCallerRate } = await import("../middleware/security-hardening.js");
    if (!checkCallerRate(callerId, "support_create", 5, 600_000)) {
      return reply.code(429).send({
        error: "rate_limited",
        message: "Too many support messages. Try again in 10 minutes.",
      });
    }

    const { kernelId, kernelName, message, subject, retrievalCode, systemInfo } =
      req.body ?? {};

    if (!kernelId) {
      return reply.code(400).send({ error: "kernelId required" });
    }
    if (!message) {
      return reply.code(400).send({ error: "message required" });
    }

    const now = new Date().toISOString();
    const msg: Message = {
      id: `msg-${uuidv4().slice(0, 8)}`,
      from: "operator",
      text: message,
      timestamp: now,
      ...(retrievalCode ? { retrievalCode } : {}),
    };

    // Try to append to existing open thread
    let thread = findThreadByKernel(kernelId);

    if (thread) {
      thread.messages.push(msg);
      thread.updatedAt = now;
      if (retrievalCode) {
        // Bump priority if they're attaching logs — they put in effort
        if (thread.priority === "low") thread.priority = "normal";
      }
      // Fire-and-forget Discord notification
      notifyDiscord(thread, msg).catch(() => {});
      return {
        threadId: thread.id,
        messageId: msg.id,
        isNewThread: false,
        timestamp: now,
      };
    }

    // Create new thread
    if (threads.length >= MAX_THREADS) {
      // Evict oldest closed thread, or oldest thread
      const closedIdx = threads.findIndex((t) => t.status === "closed");
      if (closedIdx >= 0) {
        threads.splice(closedIdx, 1);
      } else {
        threads.shift();
      }
    }

    thread = {
      id: `thread-${uuidv4().slice(0, 8)}`,
      kernelId,
      kernelName: kernelName ?? kernelId,
      operatorIp: req.ip,
      subject: subject ?? message.slice(0, 80),
      status: "open",
      priority: inferPriority(message),
      createdAt: now,
      updatedAt: now,
      messages: [msg],
      ...(systemInfo ? { systemInfo: systemInfo as SupportThread["systemInfo"] } : {}),
    };

    threads.push(thread);

    // Fire-and-forget Discord notification
    notifyDiscord(thread, msg).catch(() => {});

    return {
      threadId: thread.id,
      messageId: msg.id,
      isNewThread: true,
      timestamp: now,
    };
  });

  /**
   * GET /api/operator/support
   *
   * List all support threads (admin view). Sorted newest first.
   * Query: ?status=open&limit=50
   */
  app.get<{
    Querystring: { status?: string; limit?: string };
  }>("/api/operator/support", async (req) => {
    const { status, limit: limitStr } = req.query;
    const limit = Math.min(parseInt(limitStr ?? "50", 10) || 50, 200);

    let filtered = [...threads].reverse();
    if (status) {
      filtered = filtered.filter((t) => t.status === status);
    }

    return {
      threads: filtered.slice(0, limit).map((t) => ({
        id: t.id,
        kernelId: t.kernelId,
        kernelName: t.kernelName,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        messageCount: t.messages.length,
        lastMessage: t.messages[t.messages.length - 1]?.timestamp,
        hasRetrievalCode: t.messages.some((m) => m.retrievalCode),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      total: filtered.length,
    };
  });

  /**
   * GET /api/operator/support/mine
   *
   * Operator checks their thread(s) for replies.
   * Query: ?kernelId=xxx
   */
  app.get<{
    Querystring: { kernelId?: string };
  }>("/api/operator/support/mine", async (req, reply) => {
    const { kernelId } = req.query;

    if (!kernelId) {
      return reply.code(400).send({ error: "kernelId query param required" });
    }

    const myThreads = threads
      .filter((t) => t.kernelId === kernelId)
      .reverse();

    return {
      threads: myThreads.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        messages: t.messages,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      total: myThreads.length,
      hasUnreadReplies: myThreads.some((t) => {
        const msgs = t.messages;
        return msgs.length > 0 && msgs[msgs.length - 1].from === "admin";
      }),
    };
  });

  /**
   * GET /api/operator/support/:threadId
   *
   * Get a specific thread with all messages.
   */
  app.get<{
    Params: { threadId: string };
  }>("/api/operator/support/:threadId", async (req, reply) => {
    const thread = findThread(req.params.threadId);
    if (!thread) {
      return reply.code(404).send({ error: "thread not found" });
    }
    return { thread };
  });

  /**
   * POST /api/operator/support/:threadId/reply
   *
   * Reply to a thread. Can be used by admin or operator.
   *
   * Body: { message: string, from?: "admin" | "operator", retrievalCode?: string }
   */
  app.post<{
    Params: { threadId: string };
    Body: {
      message?: string;
      from?: "admin" | "operator";
      retrievalCode?: string;
    };
  }>("/api/operator/support/:threadId/reply", async (req, reply) => {
    const { message, retrievalCode } = req.body ?? {};

    if (!message) {
      return reply.code(400).send({ error: "message required" });
    }

    // Derive `from` from caller identity — never trust body.from (admin impersonation fix, R5 NEW-03)
    const callerId = (req as any).operatorId ?? (req as any).userId;
    const { isBrokerOperator } = await import("../middleware/security-hardening.js");
    const isAdmin = callerId ? isBrokerOperator(callerId) : false;
    const from: "admin" | "operator" = isAdmin ? "admin" : "operator";

    const thread = findThread(req.params.threadId);
    if (!thread) {
      return reply.code(404).send({ error: "thread not found" });
    }

    // Ownership check: operators can only reply to their own threads
    if (!isAdmin && callerId && thread.operatorId && thread.operatorId !== callerId) {
      return reply.code(403).send({ error: "forbidden", message: "You can only reply to your own threads" });
    }

    const now = new Date().toISOString();
    const msg: Message = {
      id: `msg-${uuidv4().slice(0, 8)}`,
      from,
      text: message,
      timestamp: now,
      ...(retrievalCode ? { retrievalCode } : {}),
    };

    thread.messages.push(msg);
    thread.updatedAt = now;

    // Auto-update status based on who replied
    if (from === "admin" && thread.status === "open") {
      thread.status = "in-progress";
    }

    return {
      threadId: thread.id,
      messageId: msg.id,
      timestamp: now,
    };
  });

  /**
   * PATCH /api/operator/support/:threadId
   *
   * Update thread status (admin). Body: { status: "resolved" | "closed" | ... }
   */
  app.patch<{
    Params: { threadId: string };
    Body: { status?: string; priority?: string };
  }>("/api/operator/support/:threadId", async (req, reply) => {
    const { status, priority } = req.body ?? {};
    const thread = findThread(req.params.threadId);
    if (!thread) {
      return reply.code(404).send({ error: "thread not found" });
    }

    if (status) {
      const valid = ["open", "in-progress", "resolved", "closed"];
      if (!valid.includes(status)) {
        return reply.code(400).send({ error: "invalid status", valid });
      }
      thread.status = status as SupportThread["status"];
    }
    if (priority) {
      const valid = ["low", "normal", "high", "urgent"];
      if (!valid.includes(priority)) {
        return reply.code(400).send({ error: "invalid priority", valid });
      }
      thread.priority = priority as SupportThread["priority"];
    }

    thread.updatedAt = new Date().toISOString();

    return {
      threadId: thread.id,
      status: thread.status,
      priority: thread.priority,
      updatedAt: thread.updatedAt,
    };
  });
}
