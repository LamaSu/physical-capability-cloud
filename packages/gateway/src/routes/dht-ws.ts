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
import { canOpenSSE, trackSSEOpen, trackSSEClose, checkCallerRate } from "../middleware/security-hardening.js";
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
const MAX_MATERIALS = 20;
const CAPABILITY_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MATERIAL_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const CURRENCY_RE = /^[A-Z0-9]{2,10}$/;
const ENDPOINT_URL_RE = /^(?:https|wss):\/\/[^\s]{1,2000}$/;
const TRANSPORTS = new Set(["websocket-direct", "websocket-relay", "webrtc", "http-poll"]);
type CapabilitySummary = import("@pcc/spec").CapabilityAnnouncement["capabilities"][number];
type PeerEndpoint = import("@pcc/spec").CapabilityAnnouncement["endpoints"][number];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * One capability, validated and REBUILT from known fields (WP-A round 7, admingates
 * AG-18). The shape check used to count the array's elements only, so null, strings
 * and arbitrary objects were stored and broadcast as sent. Unknown keys are dropped.
 */
function parseCapability(c: unknown): CapabilitySummary | string {
  if (!isPlainObject(c)) return "every capability must be an object";
  if (typeof c.type !== "string" || !CAPABILITY_TYPE_RE.test(c.type)) {
    return "capability.type must be 1-128 characters: letters, digits and . _ : / -";
  }
  const out: CapabilitySummary = { type: c.type };
  if (c.materials !== undefined) {
    if (!Array.isArray(c.materials) || c.materials.length > MAX_MATERIALS || !c.materials.every((m) => typeof m === "string" && MATERIAL_RE.test(m))) {
      return `capability.materials must be at most ${MAX_MATERIALS} strings of 1-64 printable characters`;
    }
    out.materials = [...(c.materials as string[])];
  }
  if (c.priceRange !== undefined) {
    const r = c.priceRange;
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e12;
    if (!isPlainObject(r) || !num(r.min) || !num(r.max) || (r.min as number) > (r.max as number) || typeof r.currency !== "string" || !CURRENCY_RE.test(r.currency)) {
      return "capability.priceRange must be {min <= max, both 0..1e12, currency: 2-10 upper-case letters or digits}";
    }
    out.priceRange = { min: r.min as number, max: r.max as number, currency: r.currency };
  }
  if (c.queueDepth !== undefined) {
    if (!Number.isInteger(c.queueDepth) || (c.queueDepth as number) < 0 || (c.queueDepth as number) > 1_000_000) {
      return "capability.queueDepth must be an integer 0..1000000";
    }
    out.queueDepth = c.queueDepth as number;
  }
  return out;
}

/** One endpoint, validated and REBUILT: {transport, url, priority} only (AG-18). */
function parseEndpoint(e: unknown): PeerEndpoint | string {
  if (!isPlainObject(e) || typeof e.url !== "string" || !ENDPOINT_URL_RE.test(e.url)) {
    return "every endpoint needs an https:// or wss:// url";
  }
  const transport = e.transport === undefined ? "websocket-relay" : e.transport;
  if (typeof transport !== "string" || !TRANSPORTS.has(transport)) {
    return "endpoint.transport must be websocket-direct, websocket-relay, webrtc or http-poll";
  }
  const priority = e.priority === undefined ? 1 : e.priority;
  if (!Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 100) {
    return "endpoint.priority must be an integer 0..100";
  }
  return { transport: transport as PeerEndpoint["transport"], url: e.url, priority: priority as number };
}
/** Per-principal announce quota (#2883): at most this many announcements per window. */
export const ANNOUNCE_QUOTA = { limit: 30, windowMs: 10 * 60_000 };

/** The announcement's fields, validated and rebuilt, or the first reason it is refused. */
function parseAnnouncement(a: unknown):
  | { ok: true; kernelId: string; capabilities: CapabilitySummary[]; endpoints: PeerEndpoint[]; ttlSeconds: number }
  | { ok: false; error: string } {
  if (!isPlainObject(a)) return { ok: false, error: "a JSON object is required" };
  if (typeof a.kernelId !== "string" || a.kernelId.length === 0 || a.kernelId.length > 128) {
    return { ok: false, error: "kernelId must be a string of 1-128 characters" };
  }
  if (!Array.isArray(a.capabilities) || a.capabilities.length === 0 || a.capabilities.length > MAX_ANNOUNCE_CAPABILITIES) {
    return { ok: false, error: `capabilities must be an array of 1-${MAX_ANNOUNCE_CAPABILITIES}` };
  }
  const capabilities: CapabilitySummary[] = [];
  for (const c of a.capabilities) {
    const parsed = parseCapability(c);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    capabilities.push(parsed);
  }
  const endpoints: PeerEndpoint[] = [];
  if (a.endpoints !== undefined) {
    if (!Array.isArray(a.endpoints) || a.endpoints.length > MAX_ANNOUNCE_ENDPOINTS) {
      return { ok: false, error: `endpoints must be an array of at most ${MAX_ANNOUNCE_ENDPOINTS}` };
    }
    for (const e of a.endpoints) {
      const parsed = parseEndpoint(e);
      if (typeof parsed === "string") return { ok: false, error: parsed };
      endpoints.push(parsed);
    }
  }
  if (a.ttlSeconds !== undefined && !(Number.isInteger(a.ttlSeconds) && (a.ttlSeconds as number) >= 1 && (a.ttlSeconds as number) <= MAX_ANNOUNCE_TTL_SECONDS)) {
    return { ok: false, error: `ttlSeconds must be an integer from 1 to ${MAX_ANNOUNCE_TTL_SECONDS}` };
  }
  return { ok: true, kernelId: a.kernelId, capabilities, endpoints, ttlSeconds: (a.ttlSeconds as number | undefined) ?? 300 };
}

// ── The public read boundary (WP-A round 7, admingates AG-13) ─────────────────
// /api/dht/peers, /api/dht/metrics and the event stream return an EXPLICIT set of
// fields. Telemetry events carry more than that: query_started carries the
// caller's search filter, which is demand data and private. Peer ids and gossip
// message ids are dropped too.
const PUBLIC_METRIC_KEYS = [
  "peersConnected", "peersTotal", "queriesTotal", "queriesSucceeded", "queriesFailed",
  "announcementsTotal", "announcementsActive", "gossipForwarded", "gossipDropped",
] as const;
const PUBLIC_EVENT_FIELDS = ["kernelDid", "capabilityTypes", "resultCount", "durationMs", "count", "ttl"] as const;

export function publicDhtMetrics(m: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of PUBLIC_METRIC_KEYS) {
    const v = m[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function publicDhtEvent(e: { type: string; timestamp: string; data?: Record<string, unknown> }): Record<string, unknown> {
  const out: Record<string, unknown> = { type: e.type, timestamp: e.timestamp };
  for (const k of PUBLIC_EVENT_FIELDS) {
    const v = e.data?.[k];
    if (typeof v === "number" || typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = [...v];
  }
  return out;
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
      // Only the owner-checked REST announce below may put a record in the gateway's
      // registry. A /ws/dht peer's announcement has no verified signature and no
      // owner check, so the node drops it and ignores peers' query answers
      // (WP-A round 6, wpa-326-admingates-astra "bind announcements to an
      // authorized kernel"). Without this, any key holder could connect and inject
      // kernel records that the public /api/dht/query then served.
      trustPeerRecords: false,
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
    if (!checkCallerRate(String(actor), "dht_announce", ANNOUNCE_QUOTA.limit, ANNOUNCE_QUOTA.windowMs)) {
      return reply.status(429).send({ error: "too_many_announcements", message: "Announcement quota reached; try again later." });
    }
    const parsed = parseAnnouncement(req.body);
    if (!parsed.ok) return reply.status(400).send({ error: "invalid_announcement", message: parsed.error });

    const kernel = getRepos().kernels.findById(parsed.kernelId);
    if (!kernel) return reply.status(404).send({ error: "kernel_not_found" });
    if (!sameIdentity(kernel.operatorAddress, actor)) {
      return reply.status(403).send({ error: "not_kernel_owner", message: "Only the kernel's operator may announce it." });
    }

    // Built only from validated, rebuilt fields: nothing the caller sent is stored as is.
    const record = {
      kernelDid: `did:pcc:${parsed.kernelId}`,
      kernelId: parsed.kernelId,
      capabilities: parsed.capabilities,
      endpoints: parsed.endpoints,
      ttlSeconds: parsed.ttlSeconds,
      // Server-stamped: a record's freshness is its TTL from now, never a caller's clock.
      timestamp: new Date().toISOString(),
      // The gateway does not verify a caller-supplied signature, so it never passes
      // one on as if it did. The record's authority is the owner check above.
      signature: "",
    };
    dhtNode.getRegistry().store(record);
    dhtNode.announce(record);
    return { announced: true, kernelId: parsed.kernelId };
  });

  // ── REST: peer info + stats ────────────────────────────────────────
  app.get("/api/dht/peers", async () => {
    return {
      peers: dhtNode.getPeers().map((p) => ({ did: p.did })),
      stats: dhtNode.getRegistry().stats(), // counts per capability type: public
      totalAnnouncements: dhtNode.getRegistry().size,
    };
  });

  // ── REST: telemetry metrics snapshot ──────────────────────────────
  app.get("/api/dht/metrics", async () => {
    return {
      metrics: publicDhtMetrics(dhtTelemetry.getMetrics() as unknown as Record<string, unknown>),
      recentEvents: dhtTelemetry.getRecentEvents().slice(-50).map(publicDhtEvent),
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
      metrics: publicDhtMetrics(dhtTelemetry.getMetrics() as unknown as Record<string, unknown>),
    });
    reply.raw.write(`event: snapshot\ndata: ${snapshot}\n\n`);

    // Forward live metric events to this SSE client
    const onMetric = (event: import("@pcc/dht").DHTMetricEvent) => {
      try {
        reply.raw.write(`event: metric\ndata: ${JSON.stringify(publicDhtEvent(event))}\n\n`);
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
