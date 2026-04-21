/**
 * @pcc/alerts — Fastify server binding all primitives together.
 *
 * Exposed routes:
 *   GET  /health                       (open; used by Upptime)
 *   POST /heartbeat/:worker            (optionally auth-gated by heartbeatToken)
 *   GET  /alerts/recent?limit=N        (open; ring buffer of recent alerts)
 *
 * The server is also callable as a library — `buildServer(cfg)` returns the
 * Fastify instance without listen(), useful for tests.
 *
 * Author: implementer-alpha
 */

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { createPublicClient, http } from "viem";
import { loadAlertsConfig, type AlertsConfig } from "./config.js";
import type { Alert } from "./types.js";
import { AlertRingBuffer } from "./ring-buffer.js";
import { NotifierRegistry } from "./notifiers/index.js";
import { createDiscordNotifier } from "./notifiers/discord.js";
import {
  startChainWatcher,
  type ChainClientFactory,
  type ChainWatcherHandle,
} from "./chain-watcher.js";
import {
  startRpcHealth,
  type BlockNumberProviderFactory,
  type RpcHealthHandle,
} from "./rpc-health.js";
import { startHeartbeat, type HeartbeatHandle } from "./heartbeat.js";

const VERSION = "0.1.0";

export interface BuildServerOptions {
  config: AlertsConfig;
  /** Override viem client creation (tests). */
  chainClientFactory?: ChainClientFactory;
  /** Override block-number provider creation (tests). */
  blockNumberProviderFactory?: BlockNumberProviderFactory;
  /** Override fetch used by Discord notifier (tests). */
  fetchImpl?: typeof fetch;
}

export interface BuiltServer {
  app: FastifyInstance;
  buffer: AlertRingBuffer;
  registry: NotifierRegistry;
  chainHandles: ChainWatcherHandle[];
  rpcHandles: RpcHealthHandle[];
  heartbeat: HeartbeatHandle | null;
  shutdown: () => Promise<void>;
}

const defaultChainClientFactory: ChainClientFactory = (cfg) => {
  const client = createPublicClient({
    transport: http(cfg.rpcUrl),
  });
  return {
    watchContractEvent: (args) =>
      client.watchContractEvent({
        address: args.address,
        // Cast: viem expects a typed ABI but we accept generic arrays from JSON config.
        abi: args.abi as never,
        eventName: args.eventName,
        onLogs: (logs) => args.onLogs(logs),
        onError: args.onError,
      }),
  };
};

const defaultBlockNumberProviderFactory: BlockNumberProviderFactory = (cfg) => {
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  return {
    getBlockNumber: () => client.getBlockNumber(),
  };
};

export function buildServer(opts: BuildServerOptions): BuiltServer {
  const { config } = opts;
  const buffer = new AlertRingBuffer(config.ringBufferSize);
  const registry = new NotifierRegistry();

  if (config.notifiers.discord) {
    registry.register(
      createDiscordNotifier({
        webhookUrl: config.notifiers.discord.webhookUrl,
        fetchImpl: opts.fetchImpl,
      }),
    );
  }

  const app = Fastify({ logger: { level: "info" } });

  // ---------------------------------------------------------------------
  // Central alert dispatch: append to ring buffer + broadcast to notifiers.
  // ---------------------------------------------------------------------
  const dispatch = async (alert: Alert): Promise<void> => {
    buffer.push(alert);
    await registry.broadcast(alert, (name, err) => {
      app.log.error(
        { notifier: name, err: err instanceof Error ? err.message : String(err) },
        "notifier failed",
      );
    });
  };

  // ---------------------------------------------------------------------
  // Start sources.
  // ---------------------------------------------------------------------
  const chainClientFactory = opts.chainClientFactory ?? defaultChainClientFactory;
  const chainHandles: ChainWatcherHandle[] = [];
  for (const w of config.chainWatchers) {
    const handle = startChainWatcher({
      config: w,
      clientFactory: chainClientFactory,
      onAlert: dispatch,
      onError: (err) => app.log.error({ err }, "chain watcher error"),
    });
    chainHandles.push(handle);
  }

  const rpcProviderFactory =
    opts.blockNumberProviderFactory ?? defaultBlockNumberProviderFactory;
  const rpcHandles: RpcHealthHandle[] = [];
  for (const p of config.rpcProbes) {
    const handle = startRpcHealth({
      config: p,
      providerFactory: rpcProviderFactory,
      onAlert: dispatch,
    });
    rpcHandles.push(handle);
  }

  const heartbeat =
    config.heartbeats.length > 0
      ? startHeartbeat({ configs: config.heartbeats, onAlert: dispatch })
      : null;

  // ---------------------------------------------------------------------
  // Routes.
  // ---------------------------------------------------------------------

  app.get("/health", async () => ({
    ok: true,
    version: VERSION,
    chainWatchers: config.chainWatchers.length,
    rpcProbes: config.rpcProbes.length,
    heartbeats: config.heartbeats.length,
    workers: heartbeat?.snapshot() ?? [],
    bufferedAlerts: buffer.size(),
    bufferCapacity: buffer.capacity,
  }));

  app.post(
    "/heartbeat/:worker",
    async (req: FastifyRequest<{ Params: { worker: string } }>, reply: FastifyReply) => {
      if (config.heartbeatToken) {
        const auth = req.headers["authorization"];
        const expected = `Bearer ${config.heartbeatToken}`;
        if (auth !== expected) {
          return reply.code(401).send({ error: "unauthorized" });
        }
      }
      const { worker } = req.params;
      if (!worker) {
        return reply.code(400).send({ error: "missing worker path param" });
      }
      if (!heartbeat) {
        // No heartbeats configured; still accept the post so ops scripts don't
        // crash, but flag it so operators notice.
        return reply.code(202).send({ ok: true, note: "no heartbeats configured" });
      }
      heartbeat.record(worker);
      return reply.send({ ok: true, worker });
    },
  );

  app.get(
    "/alerts/recent",
    async (
      req: FastifyRequest<{ Querystring: { limit?: string } }>,
      reply: FastifyReply,
    ) => {
      const raw = req.query.limit;
      const parsed = raw ? Number.parseInt(raw, 10) : 50;
      if (!Number.isFinite(parsed) || parsed < 1) {
        return reply.code(400).send({ error: "limit must be a positive integer" });
      }
      const limit = Math.min(parsed, buffer.capacity);
      return { alerts: buffer.recent(limit) };
    },
  );

  const shutdown = async (): Promise<void> => {
    for (const h of chainHandles) h.stop();
    for (const h of rpcHandles) h.stop();
    heartbeat?.stop();
    await app.close();
  };

  return { app, buffer, registry, chainHandles, rpcHandles, heartbeat, shutdown };
}

/**
 * Entrypoint for `node dist/server.js`. Reads ALERTS_CONFIG(_FILE) from env,
 * builds the server, and listens.
 */
export async function main(): Promise<void> {
  const config = loadAlertsConfig();
  const { app, shutdown } = buildServer({ config });
  const stop = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutdown signal received");
    await shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      chainWatchers: config.chainWatchers.length,
      rpcProbes: config.rpcProbes.length,
      heartbeats: config.heartbeats.length,
      hasDiscord: Boolean(config.notifiers.discord),
    },
    "@pcc/alerts listening",
  );
}

// Only auto-run when executed directly, not when imported.
// Using process.argv[1] check keeps this fragile-free under tsx/node.
const isDirect =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("server.js") || process.argv[1].endsWith("server.ts"));
if (isDirect) {
  main().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}
