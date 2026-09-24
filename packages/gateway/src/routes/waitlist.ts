import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { SUMMIT_HTML } from "./summit-page.js";
import { adminTokenMatches } from "../auth/admin-key.js";

// Durable storage on the mounted volume (same dir as the gateway DB / WORKFLOW_DB).
// One JSONL line per submission — churn-proof: optional fields ride in `details`,
// so the form can add/remove fields with no migration. Migrate to a table later if needed.
const DATA_DIR = dirname(process.env.PCC_DB_PATH ?? "/app/data/pcc.sqlite");
const WAITLIST_FILE = `${DATA_DIR}/waitlist.jsonl`;
const BETA_FILE = `${DATA_DIR}/beta-applications.jsonl`;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Per-IP sliding-window limit. Generous: the summit signup is progressive (one POST
// per step) and a packed room shares NAT'd IPs.
//
// WP-A round 5 (coord-watch #2883): a known leadId used to BYPASS this limit
// entirely, and anyone who knew a lead's id could rewrite its merged record. Now:
//   - a lead's record is keyed by leadId PLUS a server-issued leadToken
//     (leadKey = leadId~sha256(token)[:16]), so another caller's leadId without its
//     token lands in a record of its own. This is stateless: it survives restarts.
//   - updates carrying a token this process issued draw on a per-lead budget
//     (LEAD_UPDATE_MAX per window). Every other request counts against the per-IP
//     window, including invented tokens and the first save.
//   - both maps are bounded.
const MAX_TRACKED = 50_000;
const hits = new Map<string, number[]>();
function rateLimited(ip: string, max = 80, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.delete(ip); // re-insert: Map order is insertion order, oldest first
  hits.set(ip, arr);
  if (hits.size > MAX_TRACKED) hits.delete(hits.keys().next().value as string);
  return arr.length > max;
}

const LEAD_UPDATE_MAX = 20;
const LEAD_WINDOW_MS = 10 * 60_000;
/** leadKey -> update timestamps, only for leads THIS process issued a token to. */
const issuedLeads = new Map<string, number[]>();

function leadKeyOf(leadId: string, token: string): string {
  return `${leadId}~${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

/** True when this update must be refused: over its lead's budget, or (unknown lead) over the IP window. */
function leadRateLimited(ip: string, leadKey: string | null): boolean {
  const known = leadKey !== null ? issuedLeads.get(leadKey) : undefined;
  if (known === undefined) return rateLimited(ip);
  const now = Date.now();
  const arr = known.filter((t) => now - t < LEAD_WINDOW_MS);
  arr.push(now);
  issuedLeads.set(leadKey as string, arr);
  return arr.length > LEAD_UPDATE_MAX;
}

function trackIssuedLead(leadKey: string): void {
  if (!issuedLeads.has(leadKey)) issuedLeads.set(leadKey, [Date.now()]);
  if (issuedLeads.size > MAX_TRACKED) issuedLeads.delete(issuedLeads.keys().next().value as string);
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
    // leadKey binds a lead to its token (WP-A round 5); rows written before it keep leadId.
    const key = String(row.leadKey ?? row.leadId ?? row.id ?? row.email ?? `anon-${anon++}`);
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

const COUNT_CACHE_MS = 30_000;
let countCache: { at: number; count: number; beta: number } | null = null;

/** Test-only: forget limiter state and the count cache. */
export function _resetWaitlistStateForTests(): void {
  hits.clear();
  issuedLeads.clear();
  countCache = null;
}

function rid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Admin review is gated by a shared token (X-Admin-Token === WAITLIST_ADMIN_TOKEN),
// independent of the API-key scope system so it works even mounted before apiGate.
// Compared in CONSTANT TIME (auth/admin-key.ts adminTokenMatches, WP-A fold F7);
// fails closed when the env var is unset or blank.
function adminOk(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!adminTokenMatches(req)) {
    reply.code(403).send({ error: "forbidden", message: "Admin token required (X-Admin-Token)." });
    return false;
  }
  return true;
}

export async function waitlistRoutes(app: FastifyInstance): Promise<void> {
  // Mobile-first summit signup page (self-contained; public — mounted before apiGate).
  app.get("/summit", async (_req, reply) => {
    return reply.header("content-type", "text/html; charset=utf-8").send(SUMMIT_HTML);
  });

  // Low-friction, progressive waitlist signup (PUBLIC). Only requirement: a valid email.
  // Send a stable `leadId` with every step and each call upserts one record (coalesced
  // on read), so partial signups (email only, email+name, ...) are still captured.
  app.post("/api/waitlist", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.website || b.hp) return { status: "ok" }; // honeypot — accept silently, drop
    const leadId = b.leadId ? String(b.leadId).trim().slice(0, 64) : null;
    // A lead continues only with ITS token; without one it starts a record of its own.
    const presented = typeof b.leadToken === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(b.leadToken) ? b.leadToken : null;
    const leadToken = leadId ? (presented ?? randomBytes(18).toString("base64url")) : null;
    const leadKey = leadId && leadToken ? leadKeyOf(leadId, leadToken) : null;
    if (leadRateLimited(req.ip, presented ? leadKey : null)) {
      return reply.code(429).send({ error: "rate_limited", message: "Too many submissions — try again shortly." });
    }
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: "bad_request", message: "A valid email is required." });
    }
    const rec = {
      id: rid("wl"),
      leadId,
      leadKey,
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
    countCache = null;
    if (leadKey && !presented) trackIssuedLead(leadKey);
    return { status: "ok", id: rec.id, leadId, leadToken, message: "You're on the waitlist — we'll be in touch." };
  });

  // Full beta-tester application (PUBLIC). Required: email, name, company.
  // Everything else is optional/skippable and stored in `details`.
  app.post("/api/beta-apply", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.website || b.hp) return { status: "ok" }; // honeypot
    if (rateLimited(req.ip)) {
      return reply.code(429).send({ error: "rate_limited", message: "Too many submissions — try again shortly." });
    }
    const email = String(b.email ?? "").trim().toLowerCase();
    const name = String(b.name ?? "").trim();
    const company = String(b.company ?? "").trim();
    // Only email is hard-required — Step 2 (name/company/role/pitch) is fully
    // skippable per the summit spec; it is pure upside.
    if (!EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: "bad_request", message: "A valid email is required." });
    }

    // Optional invite code → fast-track if it validates against PCC's existing invite system.
    const inviteCode = b.inviteCode ? String(b.inviteCode).trim() : null;
    let status = "new";
    if (inviteCode) {
      try {
        const port = process.env.PORT ?? "3200";
        const r = await fetch(`http://127.0.0.1:${port}/api/onboard/check/${encodeURIComponent(inviteCode)}`);
        if (r.ok) {
          const j = (await r.json().catch(() => ({}))) as { valid?: boolean };
          if (j?.valid === true) status = "fast-track";
        }
      } catch {
        // best-effort; leave status=new for manual admin review
      }
    }

    // Everything beyond the known top-levels lands in `details` (no migration on field changes).
    const { email: _e, name: _n, company: _c, inviteCode: _i, role: _r, source: _s, ref: _rf, website: _w, hp: _h, ...details } = b;
    const rec = {
      id: rid("beta"),
      kind: "beta-application",
      email,
      name: name || null,
      company: company || null,
      role: b.role ?? null,
      inviteCode,
      source: b.source ?? b.ref ? String(b.source ?? b.ref).trim() : null,
      status,
      details,
      createdAt: new Date().toISOString(),
      ip: req.ip,
    };
    append(BETA_FILE, rec);
    countCache = null;
    return {
      status: "ok",
      id: rec.id,
      fastTracked: status === "fast-track",
      message:
        status === "fast-track"
          ? "Valid invite — you're fast-tracked. Check your email for next steps."
          : "Application received — we read every one and will be in touch.",
    };
  });

  // Public live counter for the signup page (#N social proof + open-mic read-out). No auth.
  // Cached (#2883): it used to re-read and coalesce both files on every request.
  app.get("/api/waitlist/count", async () => {
    const now = Date.now();
    if (countCache === null || now - countCache.at > COUNT_CACHE_MS) {
      countCache = {
        at: now,
        count: readCoalesced(WAITLIST_FILE).length, // distinct leads, not raw rows
        beta: readAll(BETA_FILE).length,
      };
    }
    return { count: countCache.count, beta: countCache.beta };
  });

  // Admin review / export (gated by X-Admin-Token).
  app.get("/api/admin/waitlist", async (req, reply) => {
    if (!adminOk(req, reply)) return;
    const items = readCoalesced(WAITLIST_FILE); // one merged record per lead
    return { total: items.length, items };
  });
  app.get("/api/admin/beta-apply", async (req, reply) => {
    if (!adminOk(req, reply)) return;
    const items = readAll(BETA_FILE);
    return { total: items.length, items };
  });
}
