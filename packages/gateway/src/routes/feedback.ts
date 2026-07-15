/**
 * Agent + human feedback sink.
 *
 * POST /api/feedback        (PUBLIC) — cold, unauthenticated agents (and the
 *                            dashboard bug-report form / install.html) post here.
 * GET  /api/admin/feedback  (X-Admin-Token gated) — review / export all reports.
 *
 * Storage mirrors routes/waitlist.ts EXACTLY: one JSONL line per submission on
 * the mounted volume (DATA_DIR = dirname(PCC_DB_PATH)). Churn-proof — unknown
 * fields ride along in the record, so the form/tool can add or remove fields
 * with no migration. Light per-IP rate limit + honeypot guard the public surface.
 *
 * Onboarding agents that hit a bug, friction, or dead-end call the `pcc_report`
 * tool (wired to this route in agent-package.json) so the team learns about
 * agent friction without the agent needing a key or a human relay.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Durable storage on the mounted volume (same dir as the gateway DB / WORKFLOW_DB).
// Migrate to a table later if volume warrants it.
const DATA_DIR = dirname(process.env.PCC_DB_PATH ?? "/app/data/pcc.sqlite");
const FEEDBACK_FILE = `${DATA_DIR}/feedback.jsonl`;

// Per-IP sliding-window limit (mirrors waitlist.ts). Generous default for a packed
// onboarding session behind NAT, but a stuck agent retry-looping can't flood the
// volume. Tunable via env for ops + tests.
const RATE_MAX = Number.parseInt(process.env.PCC_FEEDBACK_RATE_MAX ?? "60", 10);
const RATE_WINDOW_MS = Number.parseInt(process.env.PCC_FEEDBACK_RATE_WINDOW_MS ?? "60000", 10);
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_MAX;
}

/** Reset the in-memory rate-limit counter. Test-only export. */
export function __resetFeedbackRateLimit(): void {
  hits.clear();
}

function append(file: string, rec: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
}
function readAll(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function rid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Admin review is gated by a shared token (X-Admin-Token === WAITLIST_ADMIN_TOKEN),
// independent of the API-key scope system. Mirrors routes/waitlist.ts adminOk so
// the two admin surfaces share one operator token. Fails closed when the env var
// is unset.
function adminOk(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = process.env.WAITLIST_ADMIN_TOKEN;
  const provided = (req.headers["x-admin-token"] as string | undefined) ?? "";
  if (!token || provided !== token) {
    reply.code(403).send({ error: "forbidden", message: "Admin token required (X-Admin-Token)." });
    return false;
  }
  return true;
}

// Canonical agent categories + the legacy dashboard categories. Unknown values
// fall back to "bug" rather than 400 — a stuck agent's report should never be
// rejected on a taxonomy quibble.
const FEEDBACK_TYPES = new Set(["bug", "friction", "idea", "comment", "difficulty", "suggestion"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

const SUMMARY_MAX = 5000; // keeps the prior /api/feedback message ceiling
const DETAIL_MAX = 20000;
const FIELD_MAX = 2000;

function clampStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

// Coerce an HTTP status (number or numeric string, e.g. from a report_hint send{}
// block) to a valid 100..599 int, else null. Named httpStatus so it never collides
// with the record's own workflow `status` field.
function clampHttpStatus(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 100 && n < 600 ? Math.trunc(n) : null;
}

// Discord webhook for live feedback notifications — preserved from the prior
// /api/feedback so the team keeps getting alerts (the dashboard modal +
// install.html both rely on it). Best-effort; no-op if the env var is unset.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";
async function notifyDiscord(rec: Record<string, unknown>): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const fields: { name: string; value: string; inline?: boolean }[] = [
      { name: "Type", value: String(rec.type ?? "—"), inline: true },
    ];
    if (rec.severity) fields.push({ name: "Severity", value: String(rec.severity), inline: true });
    if (rec.endpoint) fields.push({ name: "Endpoint", value: String(rec.endpoint), inline: true });
    if (rec.traceId) fields.push({ name: "Trace", value: String(rec.traceId), inline: true });
    if (rec.agentId) fields.push({ name: "Agent", value: String(rec.agentId), inline: true });
    if (rec.email) fields.push({ name: "Email", value: String(rec.email), inline: true });
    if (rec.walletAddress) fields.push({ name: "Wallet", value: String(rec.walletAddress), inline: true });
    fields.push({ name: "Summary", value: String(rec.summary ?? "").slice(0, 1024) });
    if (rec.detail) fields.push({ name: "Detail", value: String(rec.detail).slice(0, 1024) });
    fields.push({ name: "ID", value: String(rec.id), inline: true });

    const payload = {
      username: "PCC Feedback",
      embeds: [
        {
          title: `New ${rec.type}`,
          color: 0x2563eb,
          fields,
          footer: { text: String(rec.userAgent ?? "").slice(0, 200) },
          timestamp: rec.createdAt,
        },
      ],
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

export async function feedbackRoutes(app: FastifyInstance) {
  // Submit feedback (PUBLIC — agents are unauthenticated/cold). Mirrors
  // routes/waitlist.ts: honeypot, per-IP rate limit, JSONL append on DATA_DIR,
  // optional fields tolerated with no migration.
  app.post("/api/feedback", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.website || b.hp) return { status: "ok" }; // honeypot — accept silently, drop

    if (rateLimited(req.ip)) {
      return reply
        .code(429)
        .send({ error: "rate_limited", message: "Too many submissions — try again shortly." });
    }

    // Accept the canonical agent shape AND tolerate the legacy dashboard shape
    // and the /api/feedback/agent-report aliases — no migration, fields ride along:
    //   agent:        { type, summary, detail, endpoint, traceId, severity, agentId }
    //   dashboard:    { type, message, page, walletAddress, email }
    //   agent-report: { trace_id, last_endpoint, last_error_code, agent_kind }
    const summary = clampStr(b.summary ?? b.message, SUMMARY_MAX);
    if (!summary) {
      return reply
        .code(400)
        .send({ error: "bad_request", message: "`summary` (or `message`) is required." });
    }

    const typeRaw = String(b.type ?? "").trim().toLowerCase();
    const type = FEEDBACK_TYPES.has(typeRaw) ? typeRaw : "bug";
    const severityRaw = String(b.severity ?? "").trim().toLowerCase();
    const severity = SEVERITIES.has(severityRaw) ? severityRaw : null;

    const email = clampStr(b.email, 256);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: "bad_request", message: "Invalid email format." });
    }

    const rec = {
      id: rid("fb"),
      kind: "feedback",
      type,
      summary,
      detail: clampStr(b.detail, DETAIL_MAX),
      endpoint: clampStr(b.endpoint ?? b.last_endpoint ?? b.page, FIELD_MAX),
      traceId: clampStr(b.traceId ?? b.trace_id ?? (req as unknown as { traceId?: string }).traceId, FIELD_MAX),
      severity,
      agentId: clampStr(b.agentId ?? b.agent_kind, FIELD_MAX),
      errorCode: clampStr(b.errorCode ?? b.last_error_code, FIELD_MAX),
      // Auto-feedback: the HTTP method + status the agent hit (from a report_hint
      // send{} block). Lets the team see "500 on POST /api/build/contract" directly.
      method: clampStr(b.method, 16),
      httpStatus: clampHttpStatus(b.status ?? b.httpStatus),
      // Legacy dashboard fields ride along (no migration).
      page: clampStr(b.page, FIELD_MAX),
      email,
      walletAddress: clampStr(b.walletAddress, 128),
      status: "new",
      createdAt: new Date().toISOString(),
      ip: req.ip,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
    };

    append(FEEDBACK_FILE, rec);
    // Live-notify the team via Discord webhook (best-effort, non-blocking).
    notifyDiscord(rec).catch(() => {});

    return reply.code(201).send({
      status: "ok",
      id: rec.id,
      submitted: true,
      message: "Thanks — your feedback was recorded. We read every report.",
    });
  });

  // Admin review / export (gated by X-Admin-Token === WAITLIST_ADMIN_TOKEN).
  app.get("/api/admin/feedback", async (req, reply) => {
    if (!adminOk(req, reply)) return;
    const items = readAll(FEEDBACK_FILE);
    return { total: items.length, items };
  });
}
