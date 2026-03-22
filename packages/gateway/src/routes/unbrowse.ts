/**
 * Unbrowse Proxy Routes — Gateway proxy to Unbrowse server.
 *
 * Exposes Unbrowse's API through the PCC gateway so that any agent
 * on the network can use Unbrowse without running a local instance.
 *
 * Architecture:
 *   Remote Agent → PCC Gateway /api/unbrowse/* → Unbrowse server (localhost:6969 or UNBROWSE_URL)
 *
 * The gateway acts as a single shared Unbrowse access point. Skills discovered
 * through this proxy are still published to the global marketplace (beta-api.unbrowse.ai)
 * so all agents benefit.
 *
 * Routes:
 *   GET  /api/unbrowse/health     — Check if Unbrowse is reachable
 *   POST /api/unbrowse/search     — Search marketplace for skills
 *   POST /api/unbrowse/resolve    — Resolve intent (search → capture → execute)
 *   POST /api/unbrowse/execute/:skillId — Execute a specific skill
 *   POST /api/unbrowse/feedback   — Submit skill feedback
 *   GET  /api/unbrowse/skills     — List shared skills from local registry
 */

import type { FastifyInstance } from "fastify";

const UNBROWSE_URL = (process.env.UNBROWSE_URL ?? "http://localhost:6969").replace(/\/$/, "");

/** Shared skill registry — skills agents have shared via the gateway */
const sharedSkillRegistry: Map<string, {
  skillId: string;
  domain: string;
  intent: string;
  discoveredBy: string;
  discoveredAt: string;
  usageCount: number;
}> = new Map();

async function proxyToUnbrowse(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`${UNBROWSE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({ error: "Non-JSON response" }));
    return { status: res.status, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
      return {
        status: 503,
        body: {
          error: "Unbrowse server not reachable",
          unbrowseUrl: UNBROWSE_URL,
          hint: "Start Unbrowse: npx unbrowse setup (or set UNBROWSE_URL)",
        },
      };
    }
    return { status: 502, body: { error: message } };
  }
}

export async function unbrowseRoutes(app: FastifyInstance) {
  // ── Health ──────────────────────────────────────────────────────

  app.get("/api/unbrowse/health", async (_req, reply) => {
    const result = await proxyToUnbrowse("/health", { method: "GET" });
    return reply.status(result.status).send({
      unbrowse: result.status === 200 ? "connected" : "unreachable",
      unbrowseUrl: UNBROWSE_URL,
      sharedSkills: sharedSkillRegistry.size,
      ...(typeof result.body === "object" ? result.body : {}),
    });
  });

  // ── Search ─────────────────────────────────────────────────────

  app.post<{
    Body: { intent: string; k?: number; domain?: string };
  }>("/api/unbrowse/search", async (req, reply) => {
    const { intent, k, domain } = req.body;
    if (!intent) return reply.status(400).send({ error: "intent is required" });

    const result = await proxyToUnbrowse("/v1/search", {
      method: "POST",
      body: JSON.stringify({ intent, k: k ?? 10, ...(domain ? { domain } : {}) }),
    });

    return reply.status(result.status).send(result.body);
  });

  // ── Resolve ────────────────────────────────────────────────────

  app.post<{
    Body: {
      intent: string;
      url: string;
      params?: Record<string, unknown>;
      dry_run?: boolean;
    };
  }>("/api/unbrowse/resolve", async (req, reply) => {
    const { intent, url, params, dry_run } = req.body;
    if (!intent) return reply.status(400).send({ error: "intent is required" });
    if (!url) return reply.status(400).send({ error: "url is required" });

    const result = await proxyToUnbrowse("/v1/intent/resolve", {
      method: "POST",
      body: JSON.stringify({
        intent,
        params: { url, ...params },
        context: { url },
        dry_run: dry_run ?? true,
      }),
    });

    return reply.status(result.status).send(result.body);
  });

  // ── Execute Skill ──────────────────────────────────────────────

  app.post<{
    Params: { skillId: string };
    Body: { params?: Record<string, unknown> };
  }>("/api/unbrowse/execute/:skillId", async (req, reply) => {
    const { skillId } = req.params;
    const { params } = req.body ?? {};

    // Track usage
    const skill = sharedSkillRegistry.get(skillId);
    if (skill) skill.usageCount++;

    const result = await proxyToUnbrowse(`/v1/skills/${skillId}/execute`, {
      method: "POST",
      body: JSON.stringify({ params: params ?? {} }),
    });

    return reply.status(result.status).send(result.body);
  });

  // ── Feedback ───────────────────────────────────────────────────

  app.post<{
    Body: { skill_id: string; rating: number; comment?: string };
  }>("/api/unbrowse/feedback", async (req, reply) => {
    const { skill_id, rating, comment } = req.body;
    if (!skill_id) return reply.status(400).send({ error: "skill_id is required" });
    if (!rating || rating < 1 || rating > 5) return reply.status(400).send({ error: "rating must be 1-5" });

    const result = await proxyToUnbrowse("/v1/feedback", {
      method: "POST",
      body: JSON.stringify({ skill_id, rating, comment }),
    });

    return reply.status(result.status).send(result.body);
  });

  // ── Shared Skill Registry ─────────────────────────────────────

  /** List all skills shared through this gateway */
  app.get("/api/unbrowse/skills", async (_req, reply) => {
    return reply.send({
      skills: [...sharedSkillRegistry.values()],
      total: sharedSkillRegistry.size,
    });
  });

  /** Share a skill — agents call this to publish a discovered skill to the gateway registry */
  app.post<{
    Body: {
      skillId: string;
      domain: string;
      intent: string;
      discoveredBy: string;
    };
  }>("/api/unbrowse/skills/share", async (req, reply) => {
    const { skillId, domain, intent, discoveredBy } = req.body;
    if (!skillId || !domain || !intent) {
      return reply.status(400).send({ error: "skillId, domain, and intent are required" });
    }

    sharedSkillRegistry.set(skillId, {
      skillId,
      domain,
      intent,
      discoveredBy: discoveredBy ?? "anonymous",
      discoveredAt: new Date().toISOString(),
      usageCount: 0,
    });

    return reply.status(201).send({
      shared: true,
      skillId,
      totalShared: sharedSkillRegistry.size,
    });
  });
}
