import { initSentry, Sentry } from "./sentry.js";
// Must be called before any other imports so Sentry patches HTTP/fetch/Fastify
initSentry();

import { initPostHog, shutdownPostHog } from "./services/posthog-service.js";
initPostHog();

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import { initStore, closeStore, getRepos } from "./db.js";
import { capabilityRoutes } from "./routes/capabilities.js";
import { buildRoutes } from "./routes/build.js";
import { jobRoutes } from "./routes/jobs.js";
import { kernelRoutes } from "./routes/kernels.js";
import { escrowRoutes } from "./routes/escrow.js";
import { pccProtocolRoutes } from "./routes/pcc-protocol.js";
import { agentRoutes } from "./routes/agents.js";
import { onboardRoutes } from "./routes/onboard.js";
import { marketplaceRoutes } from "./routes/marketplace.js";
import { spaceRoutes } from "./routes/spaces.js";
import { operatorRoutes } from "./routes/operator.js";
import { operatorsPublicRoutes } from "./routes/operators-public.js";
import { captureRoutes } from "./routes/capture.js";
import { negotiationRoutes } from "./routes/negotiation.js";
import { a2aTasksRoutes } from "./routes/a2a-tasks.js";
import { kernelAgentPackageRoutes } from "./routes/kernel-agent-package.js";
import { sdkRoutes } from "./routes/sdk.js";
import { sensorRoutes } from "./routes/sensors.js";
import { batchRoutes } from "./routes/batches.js";
import { evidenceEncryptedRoutes } from "./routes/evidence-encrypted.js";
// import { evidenceSearchRoutes } from "./routes/evidence-search.js"; // TODO: Agent B — file not created yet
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
import { jwksRoutes } from "./routes/jwks.js";
import { initSigningKey } from "./signing-key.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { identifyDeviceRoutes } from "./routes/identify-device.js";
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
import { contributorRoutes } from "./routes/contributors.js";
import { swfRoutes } from "./routes/swf.js";
import { docRoutes } from "./routes/docs.js";
import { statusRoutes } from "./routes/status.js";
import { subnetRoutes } from "./routes/subnet.js";
import { photoVerificationRoutes } from "./routes/photo-verification.js";
import { humanVerificationRoutes } from "./routes/human-verification.js";
import { fiatRampRoutes } from "./routes/fiat-ramp.js";
import { anomalyRoutes } from "./routes/anomaly.js";
import { requestRoutes } from "./routes/requests.js";
import { adminDemandRoutes, startDemandSnapshotCron } from "./routes/admin-demand.js";
import { toolSearchRoutes, prewarmToolIndex } from "./routes/tool-search.js";
import { intentIngestRoutes } from "./routes/intent-ingest.js";
import { dhtWebSocketRoutes } from "./routes/dht-ws.js";
import { siweAuthPlugin } from "./auth/siwe-auth.js";
import { x402Gate } from "./middleware/x402-gate.js";
import { aegisGate } from "./middleware/aegis-gate.js";
import { provisionRoutes } from "./routes/provision.js";
import { auditRoutes } from "./routes/audit.js";
import { gaslessRoutes } from "./routes/gasless.js";
import { contextPackRoutes } from "./routes/context-pack.js";
import { nearRoutes } from "./routes/near.js";
import { litProvisionRoutes } from "./routes/lit-provision.js";
import { ot2ChatRoutes } from "./routes/ot2-chat.js";
import { ot2CameraRoutes } from "./routes/ot2-camera.js";
import { ot2RelayRoutes } from "./routes/ot2-relay.js";
import { ot2ScopeRoutes } from "./routes/ot2-scope.js";
import { deviceRelayRoutes } from "./routes/device-relay.js";
import { paidJobFlowRoutes } from "./routes/paid-job-flow.js";
import { operatorRelayRoutes } from "./routes/operator-relay.js";
import { diagnosticLogRoutes } from "./routes/diagnostic-logs.js";
import { supportMessageRoutes } from "./routes/support-messages.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { securityMonitorPlugin } from "./middleware/security-monitor.js";
import { corsOriginValidator, securityHeaders } from "./middleware/security-hardening.js";
import { rateLimiter } from "./middleware/rate-limiter.js";
import { dlpRedactor } from "./middleware/dlp-redactor.js";
import { scopeChecker } from "./middleware/scope-checker.js";
import { templateRoutes } from "./routes/templates.js";
import { nlQueryRoutes } from "./routes/nl-query.js";
import { complianceTemplateRoutes } from "./routes/compliance-templates.js";
import { getAnalyticsService } from "./services/analytics-service.js";
import { wizardRoutes } from "./routes/wizard.js";
import { complianceRoutes } from "./routes/compliance.js";
import { touchstoneRoutes } from "./routes/touchstone.js";
import { aggregatorRoutes } from "./routes/aggregator/index.js";
import { identitySessionRoutes } from "./routes/identity-session.js";
import { kernelMarketplaceRoutes } from "./routes/kernel-marketplace.js";
import { templateSessionRoutes } from "./routes/template-session.js";
import { orchestratorTemplatesRoutes } from "./routes/orchestrator-templates.js";
import { physicalOperatorAgent, dataProductStubAgent } from "./routes/template-agents.js";
import { apiGate } from "./middleware/api-gate.js";
import { tenantContext } from "./middleware/tenant-context.js";
import { setSessionStore } from "@pcc/orchestrator-sdk";
import { OrchestratorSessionStore } from "./services/orchestrator-session-store.js";
import { startEventBusOtelBridge } from "./services/event-bus-otel-bridge.js";
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

  const app = Fastify({
    logger: true,
    bodyLimit: 1_048_576, // 1 MB body limit (prevents oversized payload attacks)
    trustProxy: true, // Trust Railway/Cloudflare proxy headers for real client IP
  });

  // Sentry error handler — captures Fastify errors and attaches request context
  // Must be registered before other error handlers
  try {
    Sentry.setupFastifyErrorHandler(app);
  } catch {
    // Sentry not initialised (no DSN) — safe to ignore
  }

  // Global error handler — intercepts known client errors (malformed bodies, etc.)
  // and returns a clean 400 instead of letting them bubble as 500s to Sentry.
  // Registered after Sentry so Sentry's onError hook still fires for 500s.
  app.setErrorHandler((error, request, reply) => {
    // FST_ERR_CTP_BODY_TOO_LARGE or body size mismatch
    if (
      error.code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
      error.code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH" ||
      error.code === "FST_ERR_CTP_BODY_SIZE_MISMATCH" ||
      (error.message && (error.message.includes("Content-Length") || error.message.includes("body size")))
    ) {
      return reply.status(400).send({
        error: "invalid_request",
        message: "Request body size did not match Content-Length header",
      });
    }
    // FST_ERR_CTP_INVALID_MEDIA_TYPE
    if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.status(415).send({
        error: "unsupported_media_type",
        message: error.message,
      });
    }
    // For 5xx errors, report to Sentry before responding
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      Sentry.captureException(error, { extra: { url: request.url, method: request.method } });
    }
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? "internal_error" : "request_error",
      message: statusCode >= 500 ? "Internal Server Error" : error.message,
    });
  });

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
    // Flush PostHog queue before exit
    await shutdownPostHog();
  });

  // CORS: explicit allowlist replaces origin:true (CRIT-01 fix — prevents CSRF from any origin)
  await app.register(cors, {
    origin: corsOriginValidator,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-PCC-API-Key", "X-PCC-Session", "X-Request-ID"],
    maxAge: 86400, // Cache preflight for 24h
  });

  // Security response headers (X-Frame-Options, CSP, HSTS, etc.)
  await securityHeaders(app);

  // Rate limiter — token bucket per API key with weighted endpoint costs
  await app.register(rateLimiter);
  // HMAC-sign session cookies to detect tampering (red team #52)
  // COOKIE_SECRET must be set in production; falls back to a randomized value in dev.
  const cookieSecret =
    process.env.COOKIE_SECRET ||
    (process.env.NODE_ENV === "production"
      ? (() => {
          app.log.error("[security] COOKIE_SECRET env var is not set in production. Cookies will not be signed.");
          return "insecure-default-do-not-use";
        })()
      : require("node:crypto").randomBytes(32).toString("hex"));
  await app.register(cookie, { secret: cookieSecret });
  await app.register(websocket);

  // OpenAPI 3.x spec generator — MUST register BEFORE any route plugins so the
  // onRoute hook captures their schema declarations. Spec exposed at
  // GET /openapi.json (raw JSON) and GET /docs (Swagger UI). Required for
  // APIs.guru / Smithery / mcp.so submission per docs/AGENT_NETWORK_RUNBOOK.md.
  const gatewayUrlForOpenApi =
    process.env.PCC_GATEWAY_URL ?? "https://capability.network";
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Physical Capability Cloud Gateway",
        version: process.env.npm_package_version ?? "0.1.0",
        description:
          "Agent-native API for discovering and invoking physical capabilities. " +
          "See https://capability.network/agent-package.json for the 218-tool agent package.",
      },
      servers: [{ url: gatewayUrlForOpenApi }],
      components: {
        securitySchemes: {
          bearer: {
            type: "http",
            scheme: "bearer",
            description:
              "PCC API key (pcc_live_...). Provision at POST /api/auth/provision.",
          },
        },
      },
    },
  });
  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  // Expose the raw OpenAPI JSON document. PUBLIC — referenced by directory
  // submissions and external tooling (APIs.guru, Smithery, mcp.so).
  app.get("/openapi.json", async (_req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Cache-Control", "public, max-age=300");
    return app.swagger();
  });

  // Decorate request with userId (set by requireAuth / optionalAuth hooks)
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);

  // Automatic write-operation audit hook — logs all POST/PUT/DELETE requests
  // to the audit log so every state-changing call is captured without
  // per-route boilerplate. Individual routes may also log richer events.
  app.addHook("onResponse", async (request, reply) => {
    const method = request.method;
    if (method !== "POST" && method !== "PUT" && method !== "DELETE" && method !== "PATCH") return;

    const actor = (request as any).operatorId ?? (request as any).apiKeyId ?? (
      request.headers.authorization ? "authenticated" : "anonymous"
    );

    try {
      const { auditService: audit } = await import("./services/audit-service.js");
      audit.log({
        eventType: "http.write",
        actor,
        resourceType: "http",
        action: method.toLowerCase(),
        metadata: {
          method,
          url: request.url,
          statusCode: reply.statusCode,
          duration_ms: Math.round(reply.elapsedTime ?? 0),
        },
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
    } catch {
      // Audit failures must never affect request handling
    }
  });

  // SIWE auth routes (nonce, verify, me, logout, sessions)
  await app.register(siweAuthPlugin);

  // Session middleware
  app.decorateRequest("pccSession", null);
  app.addHook("onRequest", async (req) => {
    const sessionId = req.headers["x-pcc-session"] as string | undefined;
    (req as unknown as { pccSession: unknown }).pccSession = getOrCreateSession(sessionId);
  });

  // A2A v1.0 §8.4 — load the agent-card signing key at boot. No-op if
  // PCC_AGENT_CARD_SIGNING_KEY is unset (gateway falls back to unsigned).
  await initSigningKey();

  // ERC-8004 domain verification + A2A agent card (public, before auth)
  await app.register(wellKnownRoutes);
  // A2A v1.0 JWKS endpoint (public, before auth, serves the verification
  // key for the agent card's JWS signature)
  await app.register(jwksRoutes);
  // Agent context pack (public, before auth — this is the primary product)
  await app.register(contextPackRoutes);
  // Bug reports / feedback (public, before auth)
  await app.register(feedbackRoutes);
  await app.register(identifyDeviceRoutes);

  // Health check
  app.get("/api/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  }));

  // Security monitor — attack detection, honeypots, rate tracking, fingerprinting
  // Must be registered early so the onRequest hook fires before route handlers
  await app.register(securityMonitorPlugin);

  // NOTE: statusRoutes and analyticsRoutes are registered AFTER apiGate below
  // (they expose DB data + audit logs + security events — must be authenticated)

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

  // Tenant context — attaches req.tenantId from API key operatorId or SIWE
  // session. T1.9 — mounted after apiGate so the auth fields it relies on
  // are already populated. Wave 4 RLS migration will use this to scope
  // findAll() queries.
  await app.register(tenantContext);

  // Wave 4.3 — wire SQLite-backed orchestrator-sdk session store. Replaces
  // the SDK's default in-memory Map so onboarding sessions resume across
  // gateway restarts. Must run before any onboarding routes register so
  // the SDK is ready by the time requests arrive.
  setSessionStore(new OrchestratorSessionStore(getRepos().orchestratorSessions));
  app.log.info("orchestrator-sdk session store: SQLite-backed");

  // Wave 4.4 — bridge orchestrator-sdk's eventBus into PCC's existing OTel
  // pipeline (otel.ts). Every emit() becomes a one-shot span. Bridge runs
  // for the lifetime of the process; no explicit unsubscribe needed since
  // the SDK is GC'd at shutdown.
  startEventBusOtelBridge();
  app.log.info("orchestrator-sdk event-bus → OTel bridge: active");

  // Wave 5 — internal demand-intel hourly/daily snapshot cron.
  // Persists DemandSnapshots into materializedViews. Auth-gated read via
  // /api/admin/demand/*. NOT a public oracle.
  startDemandSnapshotCron({
    info: (msg) => app.log.info(msg),
    warn: (msg) => app.log.warn(msg),
  });

  // BigTool-style retrieval substrate — pre-warm the tool index at boot so
  // the first /api/tools/search call doesn't pay the load+parse cost. Safe
  // to call if agent-package.json is missing (index just stays empty).
  prewarmToolIndex({
    info: (msg) => app.log.info(msg),
    warn: (msg) => app.log.warn(msg),
  });

  // Scope-based RBAC — enforces required scopes per endpoint (after apiGate sets key)
  await app.register(scopeChecker);

  // DLP redaction — role-aware field-level response filtering (onSend hook)
  await app.register(dlpRedactor);

  // Analytics service — subscribes to event bus, persists events + updates views
  getAnalyticsService();

  // x402 payment gate (before REST routes — gates protected endpoints)
  await app.register(x402Gate);

  // Service status + analytics — AFTER apiGate (they expose DB data, audit logs, security events)
  await app.register(statusRoutes);
  await app.register(analyticsRoutes);

  // Audit log routes
  await app.register(auditRoutes);

  // REST routes
  await app.register(capabilityRoutes);
  await app.register(buildRoutes);
  await app.register(jobRoutes);
  await app.register(kernelRoutes);
  await app.register(escrowRoutes);
  await app.register(pccProtocolRoutes);
  await app.register(agentRoutes);
  await app.register(onboardRoutes);
  await app.register(marketplaceRoutes);
  await app.register(spaceRoutes);
  await app.register(operatorRoutes);
  await app.register(operatorsPublicRoutes);
  await app.register(captureRoutes);
  await app.register(operatorRelayRoutes);
  await app.register(diagnosticLogRoutes);
  await app.register(supportMessageRoutes);
  await app.register(negotiationRoutes);
  // A2A v1.0 JSON-RPC adapter — POST /a2a/tasks/send
  await app.register(a2aTasksRoutes);
  await app.register(kernelAgentPackageRoutes);
  await app.register(sdkRoutes);

  await app.register(sensorRoutes);
  await app.register(batchRoutes);
  await app.register(evidenceEncryptedRoutes);
  // await app.register(evidenceSearchRoutes); // TODO: Agent B — file not created yet
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
  await app.register(contributorRoutes);
  await app.register(docRoutes);
  await app.register(photoVerificationRoutes);
  await app.register(humanVerificationRoutes);
  await app.register(anomalyRoutes);
  await app.register(requestRoutes);
  await app.register(adminDemandRoutes);
  await app.register(toolSearchRoutes);
  await app.register(intentIngestRoutes);
  await app.register(swfRoutes);
  await app.register(subnetRoutes);
  await app.register(gaslessRoutes);
  await app.register(nearRoutes);

  // Lit Protocol key provisioning
  await app.register(litProvisionRoutes);

  // OT-2 remote agent relay (chat + camera + tool-call relay + execution scopes)
  await app.register(ot2ChatRoutes);
  await app.register(ot2CameraRoutes);
  await app.register(ot2RelayRoutes);
  await app.register(ot2ScopeRoutes);

  // Generic device relay -- works for any device type, namespaced by kernelId
  await app.register(deviceRelayRoutes);

  // Wizard sessions + compliance
  await app.register(wizardRoutes);
  await app.register(complianceRoutes);

  // ERP patterns foundation — templates, NL query, compliance templates
  await app.register(templateRoutes);
  await app.register(nlQueryRoutes);
  await app.register(complianceTemplateRoutes);

  // Touchstone statistical enforcement + ephemeral session keys
  await app.register(touchstoneRoutes);
  await app.register(identitySessionRoutes);

  // Universal Tool Aggregator (Phase 1) — ingest + search + invoke + receipts
  await app.register(aggregatorRoutes);

  // Third-party digital kernel marketplace
  await app.register(kernelMarketplaceRoutes);

  // ── Tier-0 orchestrator routes ────────────────────────────────────────────
  // Repair-tier0-routes wired the eight backend routes the orchestrator chat
  // console at apps/dashboard/src/routes/orchestrator/[slug]/chat/index.tsx
  // calls. The two global routes (templates list + match) plus two mounts of
  // the generic templateSessionRoutes plugin (one per template).
  //
  // Mount order is intentional: mount the public template-directory routes
  // first so they're discoverable even if a template-session mount errors.
  await app.register(orchestratorTemplatesRoutes);
  // physical-operator session driver (real OnboarderAgent backing).
  await app.register(templateSessionRoutes, {
    routePrefix: "/api/onboard",
    template: "physical-operator",
    agentFactory: physicalOperatorAgent,
  });
  // data-product session driver (stub — full flow lands in Wave 2.5).
  await app.register(templateSessionRoutes, {
    routePrefix: "/api/orchestrator/data-product",
    template: "data-product",
    agentFactory: dataProductStubAgent,
  });

  // Paid job flow — end-to-end: discovery -> negotiation -> escrow -> execution -> settlement
  await app.register(paidJobFlowRoutes);

  // A2A relay — WebSocket + REST relay for networked agent-to-agent messaging
  await app.register(a2aRelayRoutes);

  // DHT — distributed capability discovery (WebSocket gossip + REST fallback)
  await app.register(dhtWebSocketRoutes);

  // SSE endpoints
  await app.register(notificationSSE);
  await app.register(topicSSE);

  // Mock SSE producers: ON by default in dev, OFF by default in production.
  // Override with ENABLE_MOCK_STREAMING=true|false in either environment.
  const enableMockStreaming =
    process.env.NODE_ENV !== "production"
      ? process.env.ENABLE_MOCK_STREAMING !== "false"
      : process.env.ENABLE_MOCK_STREAMING === "true";
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
      decorateReply: true,
      wildcard: false,
    });

    // SPA fallback — serve index.html for all non-API/SSE routes
    // Only if the requested path isn't a real file in dist/
    const { readFileSync, existsSync, createReadStream, statSync } = await import("node:fs");
    const { join, extname } = await import("node:path");
    const indexHtml = readFileSync(join(dashboardPath, "index.html"), "utf-8");

    // Minimal extension → MIME type map for static file serving
    const MIME_TYPES: Record<string, string> = {
      ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
      ".css": "text/css", ".json": "application/json", ".png": "image/png",
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
      ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff",
      ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json",
      ".txt": "text/plain", ".webp": "image/webp", ".avif": "image/avif",
    };

    const { resolve: resolvePath } = await import("node:path");
    const resolvedDashboardRoot = resolvePath(dashboardPath);

    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/sse/")) {
        return reply.status(404).send({ error: "not_found" });
      }
      // Check if a real static file exists (strip query string)
      const cleanPath = req.url.split("?")[0];
      const filePath = resolvePath(join(dashboardPath, cleanPath));

      // Path traversal guard — resolved path must stay within dashboard root
      if (!filePath.startsWith(resolvedDashboardRoot)) {
        return reply.status(400).send({ error: "invalid_path" });
      }

      if (existsSync(filePath) && !filePath.endsWith("/") && statSync(filePath).isFile()) {
        const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
        return reply.type(mime).send(createReadStream(filePath));
      }
      // Check for index.html in subdirectories (e.g. /docs/ → /docs/index.html)
      const indexPath = resolvePath(join(dashboardPath, cleanPath, "index.html"));
      if (indexPath.startsWith(resolvedDashboardRoot) && existsSync(indexPath)) {
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

