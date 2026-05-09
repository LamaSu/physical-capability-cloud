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
  email?: string;
}

// Discord webhook for live feedback notifications. Reuses the same env var
// /api/operator/support uses so all feedback shows up in one channel.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";

async function notifyDiscord(entry: FeedbackEntry): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const fields: { name: string; value: string; inline?: boolean }[] = [
      { name: "Type", value: entry.type, inline: true },
      { name: "Page", value: entry.page ?? "—", inline: true },
    ];
    if (entry.email) fields.push({ name: "Email", value: entry.email, inline: true });
    if (entry.walletAddress) fields.push({ name: "Wallet", value: entry.walletAddress, inline: true });
    fields.push({ name: "Message", value: entry.message.slice(0, 1024) });
    fields.push({ name: "ID", value: entry.id, inline: true });

    const payload = {
      username: "PCC Feedback",
      embeds: [{
        title: `New ${entry.type}`,
        color: 0x2563eb,
        fields,
        footer: { text: (entry.userAgent ?? "").slice(0, 200) },
        timestamp: entry.timestamp,
      }],
    };
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error(`Discord webhook failed: ${res.status}`);
  } catch (err) {
    console.error(`Discord webhook error: ${err}`);
  }
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
      email?: string;
    };

    if (!body.message || body.message.trim().length === 0) {
      return reply.status(400).send({ error: "Message is required" });
    }

    if (body.message.length > 5000) {
      return reply.status(400).send({ error: "Message too long (max 5000 chars)" });
    }

    let email: string | undefined;
    if (body.email && body.email.trim().length > 0) {
      const trimmed = body.email.trim();
      if (trimmed.length > 256) {
        return reply.status(400).send({ error: "Email too long" });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return reply.status(400).send({ error: "Invalid email format" });
      }
      email = trimmed;
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
      email,
    };

    const entries = loadFeedback();
    entries.push(entry);
    saveFeedback(entries);

    // Live-notify the team via Discord webhook (best-effort, non-blocking)
    notifyDiscord(entry).catch(() => {});

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
