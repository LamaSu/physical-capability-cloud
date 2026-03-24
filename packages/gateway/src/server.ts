import { initSentry, Sentry } from "./sentry.js";
// Must be called before any other imports so Sentry patches HTTP/fetch/Fastify
initSentry();

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { initStore, closeStore } from "./db.js";
import { capabilityRoutes } from "./routes/capabilities.js";
import { buildRoutes } from "./routes/build.js";
import { jobRoutes } from "./routes/jobs.js";
import { kernelRoutes } from "./routes/kernels.js";
import { escrowRoutes } from "./routes/escrow.js";
import { agentRoutes } from "./routes/agents.js";
import { onboardRoutes } from "./routes/onboard.js";
import { marketplaceRoutes } from "./routes/marketplace.js";
import { spaceRoutes } from "./routes/spaces.js";
import { operatorRoutes } from "./routes/operator.js";
import { sensorRoutes } from "./routes/sensors.js";
import { batchRoutes } from "./routes/batches.js";
import { evidenceEncryptedRoutes } from "./routes/evidence-encrypted.js";
import { zkProofRoutes } from "./routes/zk-proofs.js";
import { logisticsRoutes } from "./routes/logistics.js";
import { orchestratorRoutes } from "./routes/orchestrator.js";
import { protocolRoutes } from "./routes/protocols.js";
import { rewardRoutes } from "./routes/rewards.js";
import { authRoutes } from "./routes/auth.js";
import { registryRoutes } from "./routes/registry.js";
import { agentChatRoutes } from "./routes/agent-chat.js";
import { settlementRoutes } from "./routes/settlement.js";
import { bountyRoutes } from "./routes/bounty.js";
import { poolRoutes } from "./routes/pool.js";
import { wellKnownRoutes } from "./routes/well-known.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { traceRoutes } from "./routes/traces.js";
import { jobSubmitRoutes } from "./routes/job-submit.js";
import { pgtrRelayRoutes } from "./routes/pgtr-relay.js";
import { tmpTaskRoutes } from "./routes/tmp-tasks.js";
import { setupRoutes } from "./routes/setup.js";
import { unbrowseRoutes } from "./routes/unbrowse.js";
import { csdRoutes } from "./routes/csd.js";
import { discoverRoutes } from "./routes/discover.js";
import { ipRoutes } from "./routes/ip.js";
import { swfRoutes } from "./routes/swf.js";
import { docRoutes } from "./routes/docs.js";
import { statusRoutes } from "./routes/status.js";
import { subnetRoutes } from "./routes/subnet.js";
import { photoVerificationRoutes } from "./routes/photo-verification.js";
import { humanVerificationRoutes } from "./routes/human-verification.js";
import { fiatRampRoutes } from "./routes/fiat-ramp.js";
import { siweAuthPlugin } from "./auth/siwe-auth.js";
import { x402Gate } from "./middleware/x402-gate.js";
import { aegisGate } from "./middleware/aegis-gate.js";
import { provisionRoutes } from "./routes/provision.js";
import { apiGate } from "./middleware/api-gate.js";
import { initAgentBridge, getAgentStatus, getConversations, getRecentMessages, getAgentCards, isAgentBridgeReady } from "./agent-bridge.js";
import { a2aRelayRoutes } from "@pcc/a2a";
import { notificationSSE } from "./sse/notifications.js";
import { topicSSE } from "./sse/topic-sse.js";
import { ProducerManager } from "./sse/producers.js";
import { getOrCreateSession } from "./session.js";

export async function createGateway(port = 3200) {
  // Initialize SQLite store — only seed demo data in dev (not production)
  const shouldSeed = process.env.PCC_SEED_DATA === "true" || process.env.NODE_ENV !== "production";
  initStore({ seed: shouldSeed });

  // Initialize KernelService (mock mode by default)
  const { initKernelService } = await import("./services/kernel-service.js");
  initKernelService();

  const app = Fastify({ logger: true });

  // Sentry error handler — captures Fastify errors and attaches request context
  // Must be registered before other error handlers
  try {
    Sentry.setupFastifyErrorHandler(app);
  } catch {
    // Sentry not initialised (no DSN) — safe to ignore
  }

  // Close the DB, IPFS node, and batch settlement when the server shuts down
  app.addHook("onClose", async () => {
    closeStore();
    const { stopEvidenceStorage } = await import("./services.js");
    await stopEvidenceStorage();
    const { stopBatchSettlement } = await import("./contracts/batch-settlement.js");
    stopBatchSettlement();
    // Flush any remaining Sentry events before the process exits
    try {
      await Sentry.close(2000);
    } catch {
      // Non-fatal
    }
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(websocket);

  // Decorate request with userId (set by requireAuth / optionalAuth hooks)
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);

  // SIWE auth routes (nonce, verify, me, logout, sessions)
  await app.register(siweAuthPlugin);

  // Session middleware
  app.decorateRequest("pccSession", null);
  app.addHook("onRequest", async (req) => {
    const sessionId = req.headers["x-pcc-session"] as string | undefined;
    (req as unknown as { pccSession: unknown }).pccSession = getOrCreateSession(sessionId);
  });

  // ERC-8004 domain verification (public, before auth)
  await app.register(wellKnownRoutes);
  // Bug reports / feedback (public, before auth)
  await app.register(feedbackRoutes);

  // Health check
  app.get("/api/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  }));

  // Service status (public — shows which services are mock vs real)
  await app.register(statusRoutes);

  // Auth routes (before other routes so session is available)
  await app.register(authRoutes);

  // API key provisioning routes (under /api/auth/ — must be before apiGate)
  await app.register(provisionRoutes);

  // AEGIS content scanning gate (before payment + REST routes — scans request bodies)
  const aegisEnabled = process.env.PCC_AEGIS_ENABLED !== "false";
  if (aegisEnabled) {
    await app.register(aegisGate);
  }

  // API key gate — requires API key or session on all /api/* routes
  await app.register(apiGate);

  // x402 payment gate (before REST routes — gates protected endpoints)
  await app.register(x402Gate);

  // REST routes
  await app.register(capabilityRoutes);
  await app.register(buildRoutes);
  await app.register(jobRoutes);
  await app.register(kernelRoutes);
  await app.register(escrowRoutes);
  await app.register(agentRoutes);
  await app.register(onboardRoutes);
  await app.register(marketplaceRoutes);
  await app.register(spaceRoutes);
  await app.register(operatorRoutes);

  await app.register(sensorRoutes);
  await app.register(batchRoutes);
  await app.register(evidenceEncryptedRoutes);
  await app.register(zkProofRoutes);
  await app.register(logisticsRoutes);
  await app.register(orchestratorRoutes);
  await app.register(protocolRoutes);
  await app.register(rewardRoutes);
  await app.register(registryRoutes);
  await app.register(agentChatRoutes);
  await app.register(settlementRoutes);
  await app.register(fiatRampRoutes);
  await app.register(bountyRoutes);
  await app.register(poolRoutes);
  await app.register(telemetryRoutes);
  await app.register(traceRoutes);
  await app.register(jobSubmitRoutes);
  await app.register(pgtrRelayRoutes);
  await app.register(tmpTaskRoutes);
  await app.register(setupRoutes);
  await app.register(unbrowseRoutes);
  await app.register(csdRoutes);
  await app.register(discoverRoutes);
  await app.register(ipRoutes);
  await app.register(docRoutes);
  await app.register(photoVerificationRoutes);
  await app.register(humanVerificationRoutes);
  await app.register(swfRoutes);
  await app.register(subnetRoutes);

  // A2A relay — WebSocket + REST relay for networked agent-to-agent messaging
  await app.register(a2aRelayRoutes);

  // SSE endpoints
  await app.register(notificationSSE);
  await app.register(topicSSE);

  // Mock SSE producers (enabled by default; set ENABLE_MOCK_STREAMING=false to disable)
  const enableMockStreaming = process.env.ENABLE_MOCK_STREAMING !== "false";
  let producerManager: ProducerManager | null = null;
  if (enableMockStreaming) {
    producerManager = new ProducerManager();
  }

  // Producer status endpoint
  app.get("/api/producers/status", async () => ({
    enabled: enableMockStreaming,
    producers: producerManager?.getStatus() ?? [],
  }));

  // Agent bridge status endpoint
  app.get("/api/agents/status", async () => getAgentStatus());
  app.get("/api/agents/cards", async () => ({ cards: getAgentCards() }));
  app.get("/api/agents/live/conversations", async () => ({
    conversations: getConversations(),
    source: isAgentBridgeReady() ? "live" : "mock",
  }));
  app.get("/api/agents/live/messages", async (req) => {
    const limit = parseInt((req.query as Record<string, string>).limit ?? "50", 10);
    return {
      messages: getRecentMessages(limit),
      source: isAgentBridgeReady() ? "live" : "mock",
    };
  });

  // Clean up producers on shutdown
  app.addHook("onClose", async () => {
    producerManager?.stopAll();
  });

  // Serve dashboard static files in production
  if (process.env.SERVE_DASHBOARD === "true") {
    const { resolve } = await import("node:path");
    const dashboardPath = resolve(process.env.DASHBOARD_PATH ?? "./apps/dashboard/dist");

    await app.register(fastifyStatic, {
      root: dashboardPath,
      prefix: "/",
      decorateReply: false,
      wildcard: true,
    });

    // SPA fallback — serve index.html for all non-API/SSE routes
    // Only if the requested path isn't a real file in dist/
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const indexHtml = readFileSync(join(dashboardPath, "index.html"), "utf-8");

    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/sse/")) {
        return reply.status(404).send({ error: "not_found" });
      }
      // Check if a real static file exists (strip query string)
      const cleanPath = req.url.split("?")[0];
      const filePath = join(dashboardPath, cleanPath);
      if (existsSync(filePath) && !filePath.endsWith("/")) {
        return reply.sendFile(cleanPath);
      }
      // Check for index.html in subdirectories (e.g. /docs/ → /docs/index.html)
      const indexPath = join(dashboardPath, cleanPath, "index.html");
      if (existsSync(indexPath)) {
        return reply.type("text/html").send(readFileSync(indexPath, "utf-8"));
      }
      return reply.type("text/html").send(indexHtml);
    });

    console.log(`[gateway] Serving dashboard from ${dashboardPath}`);
  }

  return {
    app,
    start: async () => {
      // Initialize agent bridge in background (non-blocking)
      initAgentBridge().catch((err) =>
        console.warn("[gateway] Agent bridge init failed:", err),
      );

      // Initialize ERC-4337 batch settlement in background (non-blocking)
      import("./contracts/batch-settlement.js")
        .then(({ initBatchSettlement }) => initBatchSettlement())
        .catch((err) =>
          console.warn("[gateway] Batch settlement init failed:", err),
        );

      // Start mock streaming producers
      producerManager?.startAll();

      const address = await app.listen({ port, host: "0.0.0.0" });
      console.log(`PCC Gateway listening on ${address}`);
      return address;
    },
  };
}

// Auto-start when run directly
import { fileURLToPath } from "node:url";
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = parseInt(process.env.PORT ?? "3200", 10);
  console.log(`[gateway] Starting PCC Gateway on port ${port} (pid=${process.pid})...`);
  createGateway(port)
    .then(({ start }) => start())
    .catch((err) => {
      console.error("[gateway] FATAL: Failed to start gateway:", err);
      process.exit(1);
    });
}

// Catch unhandled rejections and uncaught exceptions so the process
// never exits silently. Railway needs log output to diagnose failures.
process.on("unhandledRejection", (reason) => {
  console.error("[gateway] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[gateway] Uncaught exception:", err);
  process.exit(1);
});
