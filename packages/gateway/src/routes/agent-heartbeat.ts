/**
 * Agent Heartbeat Routes
 *
 * POST /api/agents/heartbeat — record a liveness ping from an agent
 * GET  /api/agents/health    — get current health status of all monitored agents
 */

import type { FastifyInstance } from "fastify";
import { getHeartbeatMonitor } from "../agent-bridge.js";

export async function agentHeartbeatRoutes(app: FastifyInstance) {
  // ── POST /api/agents/heartbeat ─────────────────────────────────────────────
  // Agents call this endpoint to prove they are alive.
  // Body: { agentId: string }
  app.post<{
    Body: { agentId?: string };
  }>("/api/agents/heartbeat", async (req, reply) => {
    const { agentId } = req.body ?? {};

    if (!agentId || typeof agentId !== "string") {
      return reply.status(400).send({ error: "agentId is required" });
    }

    const monitor = getHeartbeatMonitor();
    if (!monitor) {
      // Agent bridge not yet initialized — accept silently so callers don't error
      return { ok: true, agentId, note: "monitor_not_ready" };
    }

    const accepted = monitor.recordHeartbeat(agentId);

    if (!accepted) {
      // Either unknown agent or suspended agent
      const status = monitor.getStatus().find((r) => r.agentId === agentId);
      if (!status) {
        return reply.status(404).send({ error: "agent_not_registered", agentId });
      }
      if (status.status === "suspended") {
        return reply.status(403).send({
          error: "agent_suspended",
          agentId,
          message: "Agent is suspended due to rogue designation. Operator re-activation required.",
        });
      }
    }

    return {
      ok: true,
      agentId,
      timestamp: new Date().toISOString(),
    };
  });

  // ── GET /api/agents/health ─────────────────────────────────────────────────
  // Returns current liveness status of all monitored agents.
  app.get("/api/agents/health", async () => {
    const monitor = getHeartbeatMonitor();
    if (!monitor) {
      return { agents: [], source: "monitor_not_initialized" };
    }

    const records = monitor.getStatus();
    return {
      agents: records,
      counts: {
        total: records.length,
        healthy: records.filter((r) => r.status === "healthy").length,
        suspicious: records.filter((r) => r.status === "suspicious").length,
        rogue: records.filter((r) => r.status === "rogue").length,
        suspended: records.filter((r) => r.status === "suspended").length,
      },
      timestamp: new Date().toISOString(),
    };
  });
}
