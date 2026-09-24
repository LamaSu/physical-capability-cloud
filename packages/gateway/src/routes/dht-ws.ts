/**
 * DHT WebSocket Routes — makes the gateway a DHT bootstrap node.
 *
 * - GET /ws/dht                — WebSocket endpoint for DHT peer connections
 * - GET /api/dht/query         — REST fallback for querying capabilities
 * - GET /api/dht/peers         — List connected DHT peers + registry stats
 * - GET /api/dht/metrics       — Snapshot of DHT telemetry counters + recent events
 * - GET /api/dht/events/stream — SSE stream of live DHT metric events
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { DHTNode, dhtTelemetry } from "@pcc/dht";
import { pipelineTelemetry } from "../telemetry.js";
import { canOpenSSE, trackSSEOpen, trackSSEClose } from "../middleware/security-hardening.js";
import { resolveApiKeyFromToken } from "../auth/api-key-auth.js";
import { resolveSession } from "../auth/siwe-auth.js";
import { sameIdentity } from "../auth/reserved-identities.js";
import { getRepos } from "../db.js";

/**
 * The principal of a DHT peer connection, or null (WP-A round 5, #2883). /ws/dht
 * is outside /api, so apiGate never sees it: this is its only authentication. It
 * used to accept any string starting "pcc_". Now the key must RESOLVE to an
 * active key record, or the request must carry a valid SIWE session.
 */
export function dhtPeerPrincipal(req: FastifyRequest): string | null {
  const authHeader = req.headers.authorization;
  const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const queryKey = (req.query as { apiKey?: unknown } | undefined)?.apiKey;
  const token = bearer ?? (typeof queryKey === "string" ? queryKey : undefined);
  if (token?.startsWith("pcc_")) {
    const key = resolveApiKeyFromToken(token);
    if (key) return key.operatorId;
  }
  const session = resolveSession(req);
  return session ? session.address : null;
}

/** Bounds on a DHT announcement (#2883): ids, sizes, lifetimes and endpoint schemes. */
const MAX_ANNOUNCE_CAPABILITIES = 50;
const MAX_ANNOUNCE_ENDPOINTS = 10;
const MAX_ANNOUNCE_TTL_SECONDS = 3600;

function announceShapeError(a: any): string | null {
  if (!a || typeof a !== "object") return "a JSON object is required";
  if (typeof a.kernelId !== "string" || a.kernelId.length === 0 || a.kernelId.length > 128) return "kernelId must be a string of 1-128 characters";
  if (!Array.isArray(a.capabilities) || a.capabilities.length === 0 || a.capabilities.length > MAX_ANNOUNCE_CAPABILITIES) {
    return `capabilities must be an array of 1-${MAX_ANNOUNCE_CAPABILITIES}`;
  }
  if (a.endpoints !== undefined) {
    if (!Array.isArray(a.endpoints) || a.endpoints.length > MAX_ANNOUNCE_ENDPOINTS) return `endpoints must be an array of at most ${MAX_ANNOUNCE_ENDPOINTS}`;
    for (const e of a.endpoints) {
      if (!e || typeof e !== "object" || typeof e.url !== "string" || !/^(?:https|wss):\/\/[^\s]{1,2000}$/.test(e.url)) {
        return "every endpoint needs an https:// or wss:// url";
      }
    }
  }
  if (a.ttlSeconds !== undefined && !(Number.isInteger(a.ttlSeconds) && a.ttlSeconds >= 1 && a.ttlSeconds <= MAX_ANNOUNCE_TTL_SECONDS)) {
    return `ttlSeconds must be an integer from 1 to ${MAX_ANNOUNCE_TTL_SECONDS}`;
  }
  return null;
}

let gatewayDHTNode: DHTNode | null = null;

/** Get or create the gateway's DHT node (singleton) */
function getGatewayDHTNode(): DHTNode {
  if (!gatewayDHTNode) {
    gatewayDHTNode = new DHTNode({
      identity: {
        did: "did:pcc:gateway",
        publicKey: "",
        endpoints: [
          {
            transport: "websocket-relay",
            url: "wss://capability.network/ws/dht",
            priority: 1,
          },
        ],
      },
      bootstrapNodes: [], // Gateway IS the bootstrap; don't self-connect
      port: 0, // Don't listen on a separate port; use Fastify's WS
      defaultTTL: 5,
      queryTimeoutMs: 5000,
    });
  }
  return gatewayDHTNode;
}

export async function dhtWebSocketRoutes(app: FastifyInstance) {
  const dhtNode = getGatewayDHTNode();

  // Start the node (pruning timer, etc.)
  await dhtNode.start();

  // ── WebSocket endpoint (auth required to prevent unauthorized DHT peers) ──
  app.get("/ws/dht", { websocket: true }, (socket: any, req: FastifyRequest) => {
    // A key that RESOLVES, or a valid SIWE session; a "pcc_" prefix alone is not a credential.
    if (!dhtPeerPrincipal(req)) {
      socket.close(4001, "Authentication required for DHT peer connections");
      return;
    }

    dhtNode.handleConnection(socket);
  });

  // ── REST: query capabilities ───────────────────────────────────────
  app.get("/api/dht/query", async (req) => {
    const q = req.query as Record<string, string>;
    const filter = {
      type: q.type,
      materials: q.materials ? q.materials.split(",") : undefined,
      maxPrice: q.maxPrice ? parseFloat(q.maxPrice) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
    };

    const results = await dhtNode.query(filter);
    pipelineTelemetry.emit("pipeline-" + Date.now(), "dht_query", "completed", { metadata: { type: filter.type, resultCount: results.length } });
    return { results, count: results.length };
  });

  // ── REST: announce capabilities ─────────────────────────────────────
  // Authenticated by apiGate (it is no longer on the public list, #2883) and bound
  // to the kernel's recorded owner: a caller announces only kernels it operates,
  // under a DID derived from the id, within bounded sizes and lifetimes.
  app.post("/api/dht/announce", async (req, reply) => {
    const actor = (req as any).operatorId ?? (req as any).userId;
    if (!actor) {
      return reply.status(401).send({ error: "Authentication required for DHT announcements" });
    }
    const announcement = req.body as any;
    const shapeError = announceShapeError(announcement);
    if (shapeError) return reply.status(400).send({ error: "invalid_announcement", message: shapeError });

    const kernel = getRepos().kernels.findById(announcement.kernelId);
    if (!kernel) return reply.status(404).send({ error: "kernel_not_found" });
    if (!sameIdentity(kernel.operatorAddress, actor)) {
      return reply.status(403).send({ error: "not_kernel_owner", message: "Only the kernel's operator may announce it." });
    }

    const record = {
      kernelDid: `did:pcc:${announcement.kernelId}`,
      kernelId: announcement.kernelId,
      capabilities: announcement.capabilities,
      endpoints: announcement.endpoints ?? [],
      ttlSeconds: announcement.ttlSeconds ?? 300,
      timestamp: new Date().toISOString(),
      signature: typeof announcement.signature === "string" ? announcement.signature : "",
    };
    dhtNode.getRegistry().store(record);
    dhtNode.announce(record);
    return { announced: true, kernelId: announcement.kernelId };
  });

  // ── REST: peer info + stats ────────────────────────────────────────
  app.get("/api/dht/peers", async () => {
    return {
      peers: dhtNode.getPeers(),
      stats: dhtNode.getRegistry().stats(),
      totalAnnouncements: dhtNode.getRegistry().size,
    };
  });

  // ── REST: telemetry metrics snapshot ──────────────────────────────
  app.get("/api/dht/metrics", async () => {
    return {
      metrics: dhtTelemetry.getMetrics(),
      recentEvents: dhtTelemetry.getRecentEvents().slice(-50),
    };
  });

  // ── SSE: live DHT event stream (auth + connection limit) ────────────
  app.get("/api/dht/events/stream", async (req, reply: FastifyReply) => {
    // Require auth (this endpoint was missed in SEC-17/SEC-18)
    const apiKeyId = (req as any).apiKeyId;
    const userId = (req as any).userId;
    if (!apiKeyId && !userId) {
      return reply.status(401).send({ error: "Authentication required for DHT event stream" });
    }

    // SSE connection limit
    if (!canOpenSSE(req.ip)) {
      return reply.status(429).send({ error: "too_many_connections" });
    }
    trackSSEOpen(req.ip);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send the current metrics snapshot on connect
    const snapshot = JSON.stringify({
      type: "snapshot",
      metrics: dhtTelemetry.getMetrics(),
    });
    reply.raw.write(`event: snapshot\ndata: ${snapshot}\n\n`);

    // Forward live metric events to this SSE client
    const onMetric = (event: import("@pcc/dht").DHTMetricEvent) => {
      try {
        reply.raw.write(`event: metric\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client disconnected; cleanup handled by req.raw.on("close")
      }
    };
    dhtTelemetry.on("metric", onMetric as (...args: unknown[]) => void);

    // Heartbeat to keep the connection alive through proxies
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      dhtTelemetry.removeListener("metric", onMetric as (...args: unknown[]) => void);
      trackSSEClose(req.ip);
    });

    // Keep the Fastify handler alive until the client disconnects
    await new Promise<void>(() => {});
  });

  // Clean up on shutdown
  app.addHook("onClose", async () => {
    await dhtNode.stop();
    gatewayDHTNode = null;
  });
}
