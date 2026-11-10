import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appendFileSync, readFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SUMMIT_HTML } from "./summit-page.js";

// Durable storage on the mounted volume (same dir as the gateway DB / WORKFLOW_DB).
// One JSONL line per submission — churn-proof: optional fields ride in `details`,
// so the form can add/remove fields with no migration. Migrate to a table later if needed.
const DATA_DIR = dirname(process.env.PCC_DB_PATH ?? "/app/data/pcc.sqlite");
const WAITLIST_FILE = `${DATA_DIR}/waitlist.jsonl`;
const BETA_FILE = `${DATA_DIR}/beta-applications.jsonl`;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const BETA_WRITE = { bodyLimit: 4096, logLevel: "silent", config: { auditOmitsClient: true } } as const;
const BETA_ROLES = new Set(["buyer", "operator", "builder"]);
const BETA_FORBIDDEN = new Set([...'<>()[],;:"', String.fromCharCode(92)]);
const BETA_KEYS = ["id", "kind", "email", "name", "role", "status", "createdAt"];
const betaHits = new Map<string, number[]>();
let betaWindowStart = 0;
let betaWindowCount = 0;

function hasControlChar(text: string): boolean {
  return [...text].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 32 || (c >= 0x7f && c <= 0x9f) || c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
  });
}

function betaSignup(body: unknown): { email: string; name: string; role: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { email, name, role } = body as Record<string, unknown>;
  if (typeof email !== "string" || typeof name !== "string" || typeof role !== "string") return null;
  const e = email.trim().toLowerCase();
  const n = name.trim();
  if (e.length > 254 || !EMAIL_RE.test(e) || [...e].some((c) => BETA_FORBIDDEN.has(c)) || hasControlChar(e)) return null;
  if (n.length < 1 || n.length > 100 || hasControlChar(n) || !BETA_ROLES.has(role)) return null;
  return { email: e, name: n, role };
}

function betaRateLimited(ip: string): boolean {
  const now = Date.now();
  if (now - betaWindowStart >= 60_000) {
    betaWindowStart = now;
    betaWindowCount = 0;
  }
  if (betaHits.size > 10_000) betaHits.clear();
  const recent = (betaHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 10 || betaWindowCount >= 30) return true;
  betaHits.set(ip, [...recent, now]);
  betaWindowCount++;
  return false;
}

function readBetaByEmail(): Record<string, unknown>[] {
  const byEmail = new Map<string, Record<string, unknown>>();
  for (const row of readAll(BETA_FILE) as Record<string, unknown>[]) {
    if (typeof row.email !== "string") continue;
    const merged = byEmail.get(row.email) ?? {};
    for (const key of BETA_KEYS) if (row[key] !== null && row[key] !== undefined && row[key] !== "") merged[key] = row[key];
    byEmail.set(row.email, merged);
  }
  return [...byEmail.values()];
}

export function __resetBetaSignupLimits(): void {
  betaHits.clear();
  betaWindowStart = betaWindowCount = 0;
}

// Per-IP sliding-window limit. Generous: the summit signup is progressive (one POST
// per step) and a packed room shares NAT'd IPs. Updates to a lead we've already
// accepted are exempt — only NEW leads count toward the window.
const hits = new Map<string, number[]>();
const seenLeads = new Map<string, number>();
function rateLimited(ip: string, leadId: string | null = null, max = 80, windowMs = 60_000): boolean {
  if (leadId && seenLeads.has(leadId)) return false; // progressive update — always allow
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
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

// Progressive capture appends one row per step. Coalesce by leadId (fallback id/email)
// so each lead is ONE record with the fullest data entered. Last non-empty value wins.
// Old rows (no leadId) keep their own id key, so they stay distinct — no data loss.
function readCoalesced(file: string): Record<string, any>[] {
  const byKey = new Map<string, Record<string, any>>();
  const order: string[] = [];
  let anon = 0;
  for (const raw of readAll(file)) {
    const row = raw as Record<string, any>;
    const key = String(row.leadId ?? row.id ?? row.email ?? `anon-${anon++}`);
    if (!byKey.has(key)) {
      byKey.set(key, {});
      order.push(key);
    }
    const merged = byKey.get(key)!;
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (v !== null && v !== undefined && v !== "") merged[k] = v;
    }
  }
  return order.map((k) => byKey.get(k)!);
}

function rid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Admin review is gated by a shared token (X-Admin-Token === WAITLIST_ADMIN_TOKEN),
// independent of the API-key scope system so it works even mounted before apiGate.
function adminOk(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = process.env.WAITLIST_ADMIN_TOKEN;
  const provided = (req.headers["x-admin-token"] as string | undefined) ?? "";
  if (!token || provided !== token) {
    reply.code(403).send({ error: "forbidden", message: "Admin token required (X-Admin-Token)." });
    return false;
  }
  return true;
}

export async function waitlistRoutes(app: FastifyInstance): Promise<void> {
  // Mobile-first summit signup page (self-contained; public — mounted before apiGate).
  app.get("/summit", { config: { cspInlineScripts: true } }, async (_req, reply) => {
    return reply.header("content-type", "text/html; charset=utf-8").send(SUMMIT_HTML);
  });

  // Low-friction, progressive waitlist signup (PUBLIC). Only requirement: a valid email.
  // Send a stable `leadId` with every step and each call upserts one record (coalesced
  // on read), so partial signups (email only, email+name, ...) are still captured.
  app.post("/api/waitlist", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.website || b.hp) return { status: "ok" }; // honeypot — accept silently, drop
    const leadId = b.leadId ? String(b.leadId).trim().slice(0, 64) : null;
    if (rateLimited(req.ip, leadId)) {
      return reply.code(429).send({ error: "rate_limited", message: "Too many submissions — try again shortly." });
    }
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: "bad_request", message: "A valid email is required." });
    }
    const rec = {
      id: rid("wl"),
      leadId,
      kind: "waitlist",
      email,
      name: b.name ?? null,
      company: b.company ?? null,
      country: b.country ?? null,
      role: b.role ?? null,
      useCase: b.useCase ?? null,
      inviteCode: b.inviteCode ? String(b.inviteCode).trim() : null,
      referral: b.referral ?? null,
      source: (b.source ?? b.ref) ? String(b.source ?? b.ref).trim() : null,
      completed: b.completed === true ? true : null,
      status: "new",
      createdAt: new Date().toISOString(),
      ip: req.ip,
    };
    append(WAITLIST_FILE, rec);
    if (leadId) seenLeads.set(leadId, Date.now());
    return { status: "ok", id: rec.id, leadId, message: "You're on the waitlist — we'll be in touch." };
  });

  // Beta signup (PUBLIC): name, email and role, all required; nothing else is kept.
  app.post("/api/beta-apply", BETA_WRITE, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.website || b.hp) return { status: "ok" }; // honeypot
    if (betaRateLimited(req.ip)) {
      return reply.code(429).send({ error: "rate_limited" });
    }
    const signup = betaSignup(req.body);
    if (!signup) return reply.code(400).send({ error: "bad_request" });
    try {
      if (existsSync(BETA_FILE) && statSync(BETA_FILE).size >= 10 * 1024 * 1024) return reply.code(503).send({ error: "unavailable" });
      append(BETA_FILE, { id: rid("beta"), kind: "beta-application", ...signup, status: "new", createdAt: new Date().toISOString() });
    } catch {
      return reply.code(503).send({ error: "unavailable" });
    }
    return { status: "ok" };
  });

  // Public live counter for the signup page (#N social proof + open-mic read-out). No auth.
  app.get("/api/waitlist/count", async () => {
    const count = readCoalesced(WAITLIST_FILE).length; // distinct leads, not raw rows
    const beta = readAll(BETA_FILE).length;
    return { count, beta };
  });

  // Admin review / export (gated by X-Admin-Token).
  app.get("/api/admin/waitlist", async (req, reply) => {
    if (!adminOk(req, reply)) return reply;
    const items = readCoalesced(WAITLIST_FILE); // one merged record per lead
    return { total: items.length, items };
  });
  app.get("/api/admin/beta-apply", { logLevel: "silent" }, async (req, reply) => {
    if (!adminOk(req, reply)) return reply;
    const items = readBetaByEmail();
    return { total: items.length, items };
  });

  app.post("/api/admin/beta-apply/remove", BETA_WRITE, async (req, reply) => {
    if (!adminOk(req, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, any>;
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    if (!email) return reply.code(400).send({ error: "bad_request" });
    const rows = readAll(BETA_FILE) as Record<string, unknown>[];
    const kept = rows.filter((row) => row.email !== email);
    if (kept.length === rows.length) return { status: "ok" };
    try {
      writeFileSync(`${BETA_FILE}.tmp`, "");
      for (const row of kept) append(`${BETA_FILE}.tmp`, row);
      renameSync(`${BETA_FILE}.tmp`, BETA_FILE);
    } catch {
      return reply.code(503).send({ error: "unavailable" });
    }
    return { status: "ok" };
  });
}
