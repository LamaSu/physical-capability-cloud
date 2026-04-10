import type { FastifyInstance } from "fastify";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
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
  // Per-IP rate limiter for feedback (max 10 per hour)
  const feedbackRateMap = new Map<string, { count: number; windowStart: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of feedbackRateMap) if (now - e.windowStart > 3600_000) feedbackRateMap.delete(ip);
  }, 600_000);

  // Submit feedback (public — no auth required, but rate limited + file size capped)
  app.post("/api/feedback", async (request, reply) => {
    // Rate limit: 10 feedback per IP per hour
    const now = Date.now();
    const ipEntry = feedbackRateMap.get(request.ip);
    if (ipEntry && now - ipEntry.windowStart < 3600_000 && ipEntry.count >= 10) {
      return reply.status(429).send({ error: "Too many feedback submissions" });
    }
    if (!ipEntry || now - ipEntry.windowStart > 3600_000) {
      feedbackRateMap.set(request.ip, { count: 1, windowStart: now });
    } else {
      ipEntry.count++;
    }

    // Cap feedback file size at 5MB to prevent disk exhaustion
    try {
      if (existsSync(FEEDBACK_FILE) && statSync(FEEDBACK_FILE).size > 5 * 1024 * 1024) {
        return reply.status(507).send({ error: "Feedback storage full" });
      }
    } catch { /* ignore */ }
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

  // Read feedback — requires auth. Previously unauthenticated (red team: all
  // submitted bug reports were world-readable, including wallet addresses).
  app.get("/api/feedback", async (request, reply) => {
    const operatorId = (request as any).operatorId ?? (request as any).userId;
    if (!operatorId) {
      return reply.status(401).send({ error: "authentication_required" });
    }
    const entries = loadFeedback();
    return reply.send({
      count: entries.length,
      entries: entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    });
  });
}
