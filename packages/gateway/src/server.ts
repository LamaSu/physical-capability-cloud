import Fastify from "fastify";
import cors from "@fastify/cors";
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
import { authRoutes } from "./routes/auth.js";
import { registryRoutes } from "./routes/registry.js";
import { x402Gate } from "./middleware/x402-gate.js";
import { initAgentBridge, getAgentStatus, getConversations, getRecentMessages, getAgentCards, isAgentBridgeReady } from "./agent-bridge.js";
import { notificationSSE } from "./sse/notifications.js";
import { topicSSE } from "./sse/topic-sse.js";
import { getOrCreateSession } from "./session.js";

export async function createGateway(port = 3200) {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });

  // Session middleware
  app.decorateRequest("pccSession", null);
  app.addHook("onRequest", async (req) => {
    const sessionId = req.headers["x-pcc-session"] as string | undefined;
    (req as unknown as { pccSession: unknown }).pccSession = getOrCreateSession(sessionId);
  });

  // Health check
  app.get("/api/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  }));

  // Auth routes (before other routes so session is available)
  await app.register(authRoutes);

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
  await app.register(registryRoutes);

  // SSE endpoints
  await app.register(notificationSSE);
  await app.register(topicSSE);

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

  return {
    app,
    start: async () => {
      // Initialize agent bridge in background (non-blocking)
      initAgentBridge().catch((err) =>
        console.warn("[gateway] Agent bridge init failed:", err),
      );

      const address = await app.listen({ port, host: "0.0.0.0" });
      console.log(`PCC Gateway listening on ${address}`);
      return address;
    },
  };
}

// Auto-start when run directly
const isMain = import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`;
if (isMain) {
  createGateway().then(({ start }) => start());
}
