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
 *
 * `kind: "attempt"` (ADK track item 3, contract attempt.v1) reports one phase of
 * an onboarding or operating attempt, success or failure, plus a session roll-up.
 * It shares the guards above; see the "Attempt reports" section at the end.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { redactSecrets } from "../redaction.js";
import { trackServerEvent } from "../services/posthog-service.js";
import { auditService } from "../services/audit-service.js";

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

// Drop terminal control chars (C0 except TAB/LF, DEL, C1) from agent text so it
// can't do escape-sequence injection in any consumer (daily report, logs, a TUI).
function stripControl(s: string): string {
  let out = "";
  for (let k = 0; k < s.length; k++) {
    const cc = s.charCodeAt(k);
    if (cc === 9 || cc === 10 || (cc >= 32 && cc !== 127 && !(cc >= 128 && cc <= 159))) out += s[k];
  }
  return out;
}

function clampStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // Bound the raw input BEFORE scanning (r-p3-r2 #4) so stripControl/trim never walk an
  // unbounded value on this public route. 64k is far above any field cap (detail=20k).
  const bounded = v.length > 64_000 ? v.slice(0, 64_000) : v;
  // Strip C0/C1 control chars incl. ESC (0x1B) so agent-supplied text can't do
  // terminal-escape injection in any consumer — the daily report, logs, a TUI (r-p3 #2).
  // Keep \t and \n (harmless + useful in multi-line detail).
  const t = stripControl(bounded).trim();
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

// Hard cap on the input handed to redaction — well above any legitimate field
// (detail is 20000), so nothing real is lost, but it bounds the regex work on this
// PUBLIC route so a pathologically huge body can't burn CPU/memory (review #4).
const PRE_REDACT_MAX = 64_000;

// Redact secrets from a free-text field, THEN clamp — redact BEFORE truncation so a
// secret that would straddle the size limit is still fully matched (review #6). The
// input is first bounded to PRE_REDACT_MAX so redaction never scans an unbounded value.
function redactClamp(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const bounded = v.length > PRE_REDACT_MAX ? v.slice(0, PRE_REDACT_MAX) : v;
  return clampStr(redactSecrets(bounded), max);
}
// Path-like fields (endpoint / logs[].path / page): drop any query string first —
// that's where a `?api_key=…` would hide — then redact + clamp (review #1). The input
// is bounded to PRE_REDACT_MAX BEFORE scanning for the separator so a huge value isn't
// fully scanned/split on this public route (review r3 #3).
function pathClamp(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const bounded = v.length > PRE_REDACT_MAX ? v.slice(0, PRE_REDACT_MAX) : v;
  const q = bounded.indexOf("?");
  return redactClamp(q >= 0 ? bounded.slice(0, q) : bounded, max);
}
// The HTTP methods PCC uses. `method` is the verb the agent hit — always one of these;
// anything else (incl. a pure-alpha secret like "PASSWORD") is dropped, not persisted.
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"]);
function clampMethod(v: unknown): string | null {
  const m = clampStr(v, 16);
  const upper = m ? m.toUpperCase() : null;
  return upper && HTTP_METHODS.has(upper) ? upper : null;
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
    const method = clampMethod(e.method); // validated HTTP verb, or dropped
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

    // ADK attempt reports have their own contract (section at the end of this file).
    if (b.kind === "attempt") return handleAttemptReport(req, reply, b);

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

    // Normalize (trim) FIRST, then cap the normalized address at 256 and validate it
    // (review r6): harmless surrounding whitespace shouldn't reject a valid email, and
    // an invalid over-long string is rejected, not truncated into a different valid-
    // looking one (r4 #3). The Fastify body-size limit bounds the raw payload.
    const emailRaw = (typeof b.email === "string" ? b.email.trim() : "") || null;
    if (emailRaw && emailRaw.length > 256) {
      return reply.code(400).send({ error: "bad_request", message: "Email too long." });
    }
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      return reply.code(400).send({ error: "bad_request", message: "Invalid email format." });
    }
    // Validate the ORIGINAL address, then drop it if redaction would alter it: a
    // secret-shaped local part must not be stored as a mangled "[redacted-hex]@x.com"
    // that still passes the validator (r3 #4).
    const email = emailRaw && redactSecrets(emailRaw) === emailRaw ? emailRaw : null;

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
      traceId: redactClamp(b.traceId ?? b.trace_id ?? (req as unknown as { traceId?: string }).traceId, FIELD_MAX),
      severity,
      agentId: redactClamp(b.agentId ?? b.agent_kind, FIELD_MAX),
      errorCode: redactClamp(b.errorCode ?? b.last_error_code, FIELD_MAX),
      // Auto-feedback: the HTTP method + status the agent hit (from a report_hint
      // send{} block). Lets the team see "500 on POST /api/build/contract" directly.
      method: clampMethod(b.method), // validated verb, never a stashed secret
      httpStatus: clampHttpStatus(b.status ?? b.httpStatus),
      // Legacy dashboard fields ride along (no migration).
      page: pathClamp(b.page, FIELD_MAX),
      email,
      // A public 0x+40hex address survives; a 0x+64hex private key is redacted.
      walletAddress: redactClamp(b.walletAddress, 128),
      status: "new",
      createdAt: new Date().toISOString(),
      ip: req.ip,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
    };

    // Dedup: collapse a retry-looping agent's repeated reports of the SAME failure
    // within the window. Accepted (200, not an error, so the agent doesn't retry) but
    // not persisted or re-notified. Key = SHA-256 over a serialized tuple with a
    // trusted principal + the FULL endpoint, errorCode, and summary; JSON.stringify
    // avoids `|`-delimiter collisions (review #4). Prefer an authenticated principal
    // (apiKeyId/userId) so users behind one NAT/proxy IP don't cross-suppress each
    // other; fall back to IP for cold, unauthenticated agents (review #2).
    const apiKeyId = (req as unknown as { apiKeyId?: string }).apiKeyId;
    const userId = (req as unknown as { userId?: string }).userId;
    // Tag the principal by namespace so an apiKeyId and a userId with the same string
    // value (or an empty/initialized id) can't collapse into one dedup identity (r3 #5).
    const principal: [string, string] = apiKeyId
      ? ["apiKey", apiKeyId]
      : userId
        ? ["user", userId]
        : ["ip", req.ip];
    const dedupKey = createHash("sha256")
      .update(JSON.stringify([principal, rec.endpoint ?? "", rec.errorCode ?? "", rec.summary]))
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
    // Observability (folds in the value of the deprecated /api/feedback/agent-report
    // route). Best-effort — never let it break the response.
    //  1) The `agent.report` audit event the admin-observability views read, so the
    //     feedback-stream + error-histogram + per-agent journey light up with the new
    //     reports (metadata shape mirrors what admin-observability.ts expects).
    try {
      auditService.log({
        eventType: "agent.report",
        actor:
          (req as unknown as { operatorId?: string }).operatorId ??
          (req as unknown as { apiKeyId?: string }).apiKeyId ??
          `anonymous:${req.ip}`,
        resourceType: "agent_report",
        resourceId: rec.id,
        action: "create",
        metadata: {
          trace_id: rec.traceId,
          summary: rec.summary,
          agent_kind: rec.agentId,
          last_endpoint: rec.endpoint,
          last_error_code: rec.errorCode,
          confused_about: rec.type,
          http_status: rec.httpStatus,
          severity: rec.severity,
          log_count: rec.logs?.length ?? 0,
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"] as string | undefined,
      });
    } catch {
      /* best-effort observability */
    }
    //  2) A PostHog event for aggregate dashboards.
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
  // Optional filters: ?kind=feedback|attempt and ?sessionId=<uuid>. Without them
  // the response is exactly as before.
  app.get("/api/admin/feedback", async (req, reply) => {
    if (!adminOk(req, reply)) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    let items = readAll(FEEDBACK_FILE) as Array<Record<string, unknown>>;
    if (typeof q.kind === "string" && q.kind !== "") {
      items = items.filter((r) => (r.kind ?? "feedback") === q.kind);
    }
    if (typeof q.sessionId === "string" && q.sessionId !== "") {
      const sid = q.sessionId.toLowerCase();
      items = items.filter((r) => r.sessionId === sid);
    }
    return { total: items.length, items };
  });
}

// ── Attempt reports (ADK track item 3; contract attempt.v1) ─────────────────
//
// Operator R7: an "attempt" is the whole experience of onboarding and operating a
// device, success or failure. Each report is one runbook phase, or the `session`
// roll-up. Contract: returns/pcc-painpoints-work/item3-attempt-reporting-contract-v1.md
// in the reconciliation workspace. Same public route, honeypot, per-IP rate limit
// and secret redaction as a classic report; the classic path above is unchanged.
// Deliberate differences:
//   - a client sessionId (UUID v4) and seq are required, and dedup keys on them,
//     so a retried report collapses but distinct phase reports never do;
//   - emails inside free text are redacted as well as secrets;
//   - no raw IP is stored; an authenticated principal is stored only as a hash;
//   - a transcript is never read or stored (operator item 99 decides consent);
//   - Discord hears only failed / blocked / budget_stop outcomes.

export const ATTEMPT_CONTRACT = "attempt.v1";
export const ATTEMPT_PHASES = [
  "prerequisites",
  "identify",
  "intake",
  "research",
  "build",
  "register",
  "verify",
  "operate",
  "publish",
  "session",
] as const;
export const ATTEMPT_OUTCOMES = [
  "ok",
  "failed",
  "blocked",
  "skipped",
  "budget_stop",
  "abandoned",
  "in_progress",
] as const;
export const HARNESS_NAMES = ["claude-code", "codex", "pcc-hosted", "other"] as const;
export const DEVICE_CLASSES = ["lab_instrument", "robot", "printer", "process_agent", "other"] as const;
export const PROPOSAL_TARGETS = ["runbook", "agent-package", "docs", "code", "process", "other"] as const;
export const TOKEN_SOURCES = ["self_reported", "harness", "metered", "unknown"] as const;

const ALERT_OUTCOMES = new Set(["failed", "blocked", "budget_stop"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTEMPT_ID = /^[A-Za-z0-9:._/-]{1,200}$/;
const PACK_DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_SEQ = 10_000;
const MAX_DURATION_MS = 86_400_000;
const MAX_TOKENS = 1_000_000_000;
const MAX_ROLLUP_PHASES = 16;

// Emails inside attempt free text. The start-of-run lookbehind and bounded
// quantifiers keep matching linear on this public route.
const EMAIL_IN_TEXT = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;
function redactEmails(s: string): string {
  return s.replace(EMAIL_IN_TEXT, "[redacted-email]");
}

/** Attempt free text: bound, redact secrets and emails, then clamp (redact before clamp). */
function attemptText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const bounded = v.length > PRE_REDACT_MAX ? v.slice(0, PRE_REDACT_MAX) : v;
  return clampStr(redactEmails(redactSecrets(bounded)), max);
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function enumValue<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  if (typeof v !== "string") return null;
  const n = v.trim().toLowerCase();
  return (allowed as readonly string[]).includes(n) ? (n as T) : null;
}

function boundedInt(v: unknown, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/** `budget-stop` and `Budget_Stop` both mean budget_stop; anything unlisted is "unknown". */
function attemptOutcome(v: unknown): string {
  const n = typeof v === "string" ? v.trim().toLowerCase().replace(/-/g, "_") : "";
  return (ATTEMPT_OUTCOMES as readonly string[]).includes(n) ? n : "unknown";
}

/** An id is kept only if it is id-shaped and nothing in it looks like a secret. */
function attemptId(v: unknown): string | null {
  if (typeof v !== "string" || !ATTEMPT_ID.test(v)) return null;
  return redactSecrets(v) === v ? v : null;
}

/** Redact emails in log notes before clampLogs redacts secrets and clamps them. */
function preRedactLogNotes(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v.slice(0, MAX_LOG_ENTRIES).map((raw) => {
    const e = asObject(raw);
    if (e === null || typeof e.note !== "string") return raw;
    const bounded = e.note.length > PRE_REDACT_MAX ? e.note.slice(0, PRE_REDACT_MAX) : e.note;
    return { ...e, note: redactEmails(bounded) };
  });
}

/** The session roll-up: real phases only, at most MAX_ROLLUP_PHASES entries. */
function attemptRollup(v: unknown): Array<{ phase: string; outcome: string; durationMs: number | null }> | null {
  if (!Array.isArray(v)) return null;
  const out: Array<{ phase: string; outcome: string; durationMs: number | null }> = [];
  for (const raw of v.slice(0, MAX_ROLLUP_PHASES)) {
    const e = asObject(raw);
    const phase = e === null ? null : enumValue(e.phase, ATTEMPT_PHASES);
    if (e === null || phase === null || phase === "session") continue;
    out.push({ phase, outcome: attemptOutcome(e.outcome), durationMs: boundedInt(e.durationMs, MAX_DURATION_MS) });
  }
  return out.length > 0 ? out : null;
}

function attemptIds(v: unknown): Record<string, string> | null {
  const o = asObject(v);
  if (o === null) return null;
  const out: Record<string, string> = {};
  for (const k of ["kernelId", "capabilityId", "kitId", "jobId"]) {
    const id = attemptId(o[k]);
    if (id !== null) out[k] = id;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function attemptDevice(v: unknown): Record<string, string | null> | null {
  const o = asObject(v);
  if (o === null) return null;
  const out = {
    make: attemptText(o.make, 128),
    model: attemptText(o.model, 128),
    class: o.class === undefined || o.class === null ? null : (enumValue(o.class, DEVICE_CLASSES) ?? "other"),
  };
  return out.make || out.model || out.class ? out : null;
}

function attemptHarness(v: unknown): Record<string, string | null> | null {
  const o = asObject(v);
  if (o === null) return null;
  const name = o.name === undefined || o.name === null ? null : (enumValue(o.name, HARNESS_NAMES) ?? "other");
  const out: Record<string, string | null> = {
    name,
    version: attemptText(o.version, 128),
    model: attemptText(o.model, 128),
  };
  if (name === "other" && typeof o.name === "string") out.label = attemptText(o.name, 64);
  return out.name || out.version || out.model ? out : null;
}

// A 64-hex value is exactly what redaction treats as a private key, so a pack
// digest is stored only as its first 16 hex digits: enough to tell pack builds
// apart, never a whole 256-bit value.
function attemptPack(v: unknown): { version: string | null; digestPrefix: string | null } | null {
  const o = asObject(v);
  if (o === null) return null;
  const version = attemptText(o.version, 64);
  const d = typeof o.digest === "string" ? o.digest.trim().toLowerCase() : "";
  const digestPrefix = PACK_DIGEST.test(d) ? d.slice(0, "sha256:".length + 16) : null;
  return version || digestPrefix ? { version, digestPrefix } : null;
}

function attemptEnv(v: unknown): Record<string, string | null> | null {
  const o = asObject(v);
  if (o === null) return null;
  const out = { os: attemptText(o.os, 64), python: attemptText(o.python, 64), pccNode: attemptText(o.pccNode, 64) };
  return out.os || out.python || out.pccNode ? out : null;
}

/** Tokens are never guessed: counts are stored as sent (bounded) with their source label. */
function attemptTokens(v: unknown): { in: number | null; out: number | null; source: string } | null {
  const o = asObject(v);
  if (o === null) return null;
  return {
    in: boundedInt(o.in, MAX_TOKENS),
    out: boundedInt(o.out, MAX_TOKENS),
    source: enumValue(o.source, TOKEN_SOURCES) ?? "unknown",
  };
}

function attemptProposal(v: unknown): { target: string; path: string | null; text: string } | null {
  const o = asObject(v);
  if (o === null) return null;
  const text = attemptText(o.text, SUMMARY_MAX);
  if (text === null) return null;
  const path = pathClamp(o.path, FIELD_MAX);
  return { target: enumValue(o.target, PROPOSAL_TARGETS) ?? "other", path: path === null ? null : redactEmails(path), text };
}

export type AttemptParse =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; field: string; message: string };

/** Validate and normalise an attempt report body. Pure; exported for tests. */
export function parseAttemptReport(b: Record<string, unknown>): AttemptParse {
  const sid = typeof b.sessionId === "string" ? b.sessionId.trim() : "";
  if (!UUID_V4.test(sid)) {
    return { ok: false, field: "sessionId", message: "sessionId must be a client-generated UUID v4." };
  }
  const seq = boundedInt(b.seq, MAX_SEQ);
  if (seq === null) return { ok: false, field: "seq", message: `seq must be an integer from 0 to ${MAX_SEQ}.` };
  if (typeof b.phase !== "string" || b.phase.trim() === "") {
    return { ok: false, field: "phase", message: "phase is required." };
  }
  if (typeof b.outcome !== "string" || b.outcome.trim() === "") {
    return { ok: false, field: "outcome", message: "outcome is required." };
  }
  const phase = enumValue(b.phase, ATTEMPT_PHASES) ?? "other";
  const outcome = attemptOutcome(b.outcome);
  const fields: Record<string, unknown> = {
    contract: ATTEMPT_CONTRACT,
    sessionId: sid.toLowerCase(),
    seq,
    phase,
    ...(phase === "other" ? { phaseLabel: attemptText(b.phase, 64) } : {}),
    outcome,
    ...(outcome === "unknown" ? { outcomeLabel: attemptText(b.outcome, 64) } : {}),
    durationMs: boundedInt(b.durationMs, MAX_DURATION_MS),
    summary: attemptText(b.summary, SUMMARY_MAX) ?? `${phase}: ${outcome}`,
    detail: attemptText(b.detail, DETAIL_MAX),
    logs: clampLogs(preRedactLogNotes(b.logs)),
    ...(phase === "session" ? { phases: attemptRollup(b.phases) } : {}),
    ids: attemptIds(b.ids),
    device: attemptDevice(b.device),
    harness: attemptHarness(b.harness),
    pack: attemptPack(b.pack),
    env: attemptEnv(b.env),
    tokens: attemptTokens(b.tokens),
    proposal: attemptProposal(b.proposal),
    traceId: attemptText(b.traceId, FIELD_MAX),
    consent: { transcript: asObject(b.consent)?.transcript === true },
    // Presence only: the transcript itself is never read (operator item 99).
    ...("transcript" in b ? { transcriptDropped: true } : {}),
  };
  return { ok: true, fields };
}

async function handleAttemptReport(req: FastifyRequest, reply: FastifyReply, b: Record<string, unknown>) {
  const parsed = parseAttemptReport(b);
  if (!parsed.ok) {
    return reply.code(400).send({ error: "bad_request", field: parsed.field, message: parsed.message });
  }
  const f = parsed.fields;
  const apiKeyId = (req as unknown as { apiKeyId?: string }).apiKeyId;
  const userId = (req as unknown as { userId?: string }).userId;
  const principal: [string, string] = apiKeyId ? ["apiKey", apiKeyId] : userId ? ["user", userId] : ["ip", req.ip];
  const rec: Record<string, unknown> = {
    id: rid("at"),
    kind: "attempt",
    ...f,
    traceId: f.traceId ?? attemptText((req as unknown as { traceId?: string }).traceId, FIELD_MAX),
    principal: principal[0] === "ip" ? "anonymous" : principal[0],
    ...(principal[0] === "ip"
      ? {}
      : { principalHash: createHash("sha256").update(JSON.stringify(principal)).digest("hex") }),
    status: "new",
    createdAt: new Date().toISOString(),
    userAgent: clampStr(req.headers["user-agent"], 200),
  };

  const dedupKey = createHash("sha256")
    .update(JSON.stringify(["attempt", principal, f.sessionId, f.seq]))
    .digest("hex");
  if (seenRecently(dedupKey)) {
    return reply.code(200).send({
      status: "ok",
      submitted: false,
      deduped: true,
      sessionId: f.sessionId,
      message: "Thanks — this attempt report (same sessionId and seq) was already recorded.",
    });
  }

  append(FEEDBACK_FILE, rec);
  markSeen(dedupKey);
  if (ALERT_OUTCOMES.has(String(f.outcome))) {
    const harness = f.harness as { name?: string | null } | null;
    notifyDiscord({
      id: rec.id,
      type: `attempt ${String(f.phase)}/${String(f.outcome)}`,
      summary: rec.summary,
      detail: rec.detail,
      traceId: rec.traceId,
      agentId: harness?.name ?? null,
      createdAt: rec.createdAt,
      userAgent: rec.userAgent,
    }).catch(() => {});
  }
  try {
    auditService.log({
      eventType: "agent.attempt",
      actor: (req as unknown as { operatorId?: string }).operatorId ?? apiKeyId ?? "anonymous",
      resourceType: "agent_attempt",
      resourceId: String(rec.id),
      action: "create",
      metadata: {
        session_id: f.sessionId,
        seq: f.seq,
        phase: f.phase,
        outcome: f.outcome,
        duration_ms: f.durationMs,
        harness: (f.harness as { name?: string | null } | null)?.name ?? null,
        device_class: (f.device as { class?: string | null } | null)?.class ?? null,
        has_proposal: f.proposal !== null,
        transcript_dropped: f.transcriptDropped === true,
      },
      userAgent: req.headers["user-agent"] as string | undefined,
    });
  } catch {
    /* best-effort observability */
  }
  try {
    trackServerEvent("attempt_reported", {
      attempt_id: rec.id,
      session_id: f.sessionId,
      phase: f.phase,
      outcome: f.outcome,
      duration_ms: f.durationMs,
      harness: (f.harness as { name?: string | null } | null)?.name ?? null,
      device_class: (f.device as { class?: string | null } | null)?.class ?? null,
      tokens_source: (f.tokens as { source?: string } | null)?.source ?? null,
      has_proposal: f.proposal !== null,
    });
  } catch {
    /* best-effort telemetry */
  }

  return reply.code(201).send({
    status: "ok",
    id: rec.id,
    sessionId: f.sessionId,
    submitted: true,
    message: "Thanks — attempt report recorded.",
  });
}
