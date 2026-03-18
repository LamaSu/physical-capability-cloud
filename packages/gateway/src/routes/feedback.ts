import type { FastifyInstance } from "fastify";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const FEEDBACK_FILE = process.env.PCC_FEEDBACK_PATH ?? "./data/feedback.json";

interface FeedbackEntry {
  id: string;
  type: "bug" | "comment" | "difficulty" | "suggestion";
  message: string;
  page?: string;
  userAgent?: string;
  timestamp: string;
  walletAddress?: string;
}

function loadFeedback(): FeedbackEntry[] {
  try {
    if (existsSync(FEEDBACK_FILE)) {
      return JSON.parse(readFileSync(FEEDBACK_FILE, "utf-8"));
    }
  } catch { /* ignore parse errors */ }
  return [];
}

function saveFeedback(entries: FeedbackEntry[]): void {
  const dir = dirname(FEEDBACK_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FEEDBACK_FILE, JSON.stringify(entries, null, 2));
}

export async function feedbackRoutes(app: FastifyInstance) {
  // Submit feedback (public — no auth required)
  app.post("/api/feedback", async (request, reply) => {
    const body = request.body as {
      type?: string;
      message?: string;
      page?: string;
      walletAddress?: string;
    };

    if (!body.message || body.message.trim().length === 0) {
      return reply.status(400).send({ error: "Message is required" });
    }

    if (body.message.length > 5000) {
      return reply.status(400).send({ error: "Message too long (max 5000 chars)" });
    }

    const entry: FeedbackEntry = {
      id: `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type: (["bug", "comment", "difficulty", "suggestion"].includes(body.type ?? "")
        ? body.type
        : "comment") as FeedbackEntry["type"],
      message: body.message.trim(),
      page: body.page,
      userAgent: request.headers["user-agent"],
      timestamp: new Date().toISOString(),
      walletAddress: body.walletAddress,
    };

    const entries = loadFeedback();
    entries.push(entry);
    saveFeedback(entries);

    return reply.status(201).send({ id: entry.id, submitted: true });
  });

  // Read feedback (for the operator — no auth for now, add later)
  app.get("/api/feedback", async (_request, reply) => {
    const entries = loadFeedback();
    return reply.send({
      count: entries.length,
      entries: entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    });
  });
}
