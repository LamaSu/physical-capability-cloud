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
import { createHash } from "node:crypto";
import { redactSecrets } from "../redaction.js";
import { trackServerEvent } from "../services/posthog-service.js";

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

// Dedup: a retry-looping agent files the "same" failure many times. Collapse reports
// with an identical (principal, endpoint, errorCode, summary-prefix) within a window,
// so the volume + Discord aren't flooded and the team sees one report per real issue.
// Finer-grained than the rate limit (which is a blunt per-IP cap).
// Guard a bad env override: a NaN/negative window would make the expiry check
// always-false, so keys would never expire and reports would dedup forever (review #5).
const DEDUP_WINDOW_MS = (() => {
  const n = Number.parseInt(process.env.PCC_FEEDBACK_DEDUP_WINDOW_MS ?? "300000", 10);
  return Number.isFinite(n) && n > 0 ? n : 300000; // 5 min default
})();
const recentReports = new Map<string, number>();
// PEEK — prune expired keys and report whether this one is present, WITHOUT recording
// it. The key is marked only after a successful append (markSeen), so a failed write
// can't permanently dedup a report that never persisted (review #3).
function seenRecently(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of recentReports) if (now - t > DEDUP_WINDOW_MS) recentReports.delete(k);
  return recentReports.has(key);
}
function markSeen(key: string): void {
  recentReports.set(key, Date.now());
}
/** Reset the in-memory dedup window. Test-only export. */
export function __resetFeedbackDedup(): void {
  recentReports.clear();
}

// Bounds for the optional `logs` array (recent step SUMMARIES, not bodies).
const MAX_LOG_ENTRIES = 20;
const LOG_NOTE_MAX = 500;

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
  // Must be a whole HTTP status (100..599). Reject fractional values rather than
  // silently truncating (503.9 -> null, not 503) — the field is documented integer.
  return Number.isInteger(n) && n >= 100 && n < 600 ? n : null;
}

// Redact secrets from a free-text field, THEN clamp — redact BEFORE truncation so a
// secret that would straddle the size limit is still fully matched (review #6).
function redactClamp(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  return clampStr(redactSecrets(v), max);
}
// Path-like fields (endpoint / logs[].path / page): drop any query string first —
// that's where a `?api_key=…` would hide — then redact + clamp (review #1).
function pathClamp(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  return redactClamp(v.split("?")[0], max);
}

interface LogEntry {
  step?: number;
  method?: string;
  path?: string;
  status?: number;
  note?: string;
}

// Bound + sanitize the optional `logs` array: the agent's last few steps as SUMMARIES
// (method/path/status + a short note), never full bodies. Caps entry count + field
// sizes, coerces status, drops junk, and REDACTS secret-shaped strings from each note.
// Returns null when there is nothing usable, so the field simply doesn't persist.
function clampLogs(v: unknown): LogEntry[] | null {
  if (!Array.isArray(v)) return null;
  const out: LogEntry[] = [];
  for (const raw of v.slice(0, MAX_LOG_ENTRIES)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const entry: LogEntry = {};
    if (Number.isInteger(Number(e.step))) entry.step = Number(e.step);
    const method = clampStr(e.method, 16); // HTTP method — no secrets
    if (method) entry.method = method;
    const path = pathClamp(e.path ?? e.endpoint, FIELD_MAX); // strip query + redact
    if (path) entry.path = path;
    const status = clampHttpStatus(e.status);
    if (status !== null) entry.status = status;
    const note = redactClamp(e.note, LOG_NOTE_MAX); // redact before clamp
    if (note) entry.note = note;
    if (Object.keys(entry).length > 0) out.push(entry);
  }
  return out.length > 0 ? out : null;
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
    // Scrub secret-shaped strings from all agent-supplied free text before it is
    // persisted to the public sink (Phase 2 defense-in-depth; redact BEFORE clamp).
    const summary = redactClamp(b.summary ?? b.message, SUMMARY_MAX);
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
      detail: redactClamp(b.detail, DETAIL_MAX),
      // Phase 2: the agent's last few steps (method/path/status + a redacted note),
      // bounded + summarized — the "logs" half of "feedback and logs".
      logs: clampLogs(b.logs),
      // Path-like: strip any query string (where a ?api_key=… hides) + redact (#1).
      endpoint: pathClamp(b.endpoint ?? b.last_endpoint ?? b.page, FIELD_MAX),
      traceId: clampStr(b.traceId ?? b.trace_id ?? (req as unknown as { traceId?: string }).traceId, FIELD_MAX),
      severity,
      agentId: redactClamp(b.agentId ?? b.agent_kind, FIELD_MAX),
      errorCode: redactClamp(b.errorCode ?? b.last_error_code, FIELD_MAX),
      // Auto-feedback: the HTTP method + status the agent hit (from a report_hint
      // send{} block). Lets the team see "500 on POST /api/build/contract" directly.
      method: clampStr(b.method, 16),
      httpStatus: clampHttpStatus(b.status ?? b.httpStatus),
      // Legacy dashboard fields ride along (no migration).
      page: pathClamp(b.page, FIELD_MAX),
      email,
      walletAddress: clampStr(b.walletAddress, 128),
      status: "new",
      createdAt: new Date().toISOString(),
      ip: req.ip,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
    };

    // Dedup: collapse a retry-looping agent's repeated reports of the SAME failure
    // within the window. Accepted (200, not an error, so the agent doesn't retry) but
    // not persisted or re-notified. Key = SHA-256 over a serialized tuple with a
    // TRUSTED principal (req.ip, not the spoofable agent traceId) + the FULL endpoint,
    // errorCode, and summary; JSON.stringify avoids `|`-delimiter collisions (#4).
    const dedupKey = createHash("sha256")
      .update(JSON.stringify([req.ip, rec.endpoint ?? "", rec.errorCode ?? "", rec.summary]))
      .digest("hex");
    if (seenRecently(dedupKey)) {
      return reply.code(200).send({
        status: "ok",
        submitted: false,
        deduped: true,
        message: "Thanks — a matching report was already recorded moments ago.",
      });
    }

    append(FEEDBACK_FILE, rec);
    // Mark the key only AFTER a successful append — a failed write must not
    // permanently dedup a report that never persisted (#3).
    markSeen(dedupKey);
    // Live-notify the team via Discord webhook (best-effort, non-blocking).
    notifyDiscord(rec).catch(() => {});
    // Observability event (folds in the value of the orphaned /api/feedback/agent-report
    // route). Best-effort — never let telemetry break the response.
    try {
      trackServerEvent("feedback_filed", {
        feedback_id: rec.id,
        type: rec.type,
        endpoint: rec.endpoint,
        http_status: rec.httpStatus,
        error_code: rec.errorCode,
        trace_id: rec.traceId,
        agent_kind: rec.agentId,
        severity: rec.severity,
        log_count: rec.logs?.length ?? 0,
      });
    } catch {
      /* best-effort telemetry */
    }

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
