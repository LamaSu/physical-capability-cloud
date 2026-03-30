import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { initStore, closeStore, getStore } from "../db.js";
import { deviceRelayRoutes } from "../routes/device-relay.js";
import { schema, sql, eq } from "@pcc/store";

const { shopKernels, kernelDevices, toolCallRelay, executionScopes, ot2CameraFrames, ot2ChatMessages } = schema;

let app: FastifyInstance;

beforeAll(async () => {
  // In-memory DB for tests
  process.env.DATABASE_URL = ":memory:";
  initStore({ seed: false });

  app = Fastify({ logger: false });

  // Mock auth: decorate request with operatorId
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);

  await app.register(deviceRelayRoutes);
  await app.ready();

  // Seed a test kernel + device
  const { db } = getStore();
  db.insert(shopKernels).values({
    id: "kernel-test-1",
    name: "Test Kernel",
    operatorAddress: "operator-1",
    location: { lat: 37.7, lng: -122.4 },
    physicalAddress: "123 Test St",
    maxAssuranceTier: 2,
    publicKey: "pk_test",
    reputation: 100,
    totalJobsCompleted: 5,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "1.0.0",
  }).run();

  db.insert(kernelDevices).values({
    id: "device-ot2",
    kernelId: "kernel-test-1",
    type: "machine",
    model: "OT-2",
    firmware: "1.0",
    status: "idle",
    contributesToCapabilities: ["cap-1"],
    lastUpdated: new Date().toISOString(),
    adapterType: "opentrons",
  }).run();
});

afterAll(async () => {
  await app.close();
  closeStore();
});

beforeEach(() => {
  // Clean relay tables before each test
  const { db } = getStore();
  db.run(sql`DELETE FROM tool_call_relay`);
  db.run(sql`DELETE FROM execution_scopes`);
  db.run(sql`DELETE FROM ot2_camera_frames`);
  db.run(sql`DELETE FROM ot2_chat_messages`);
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL MANIFEST
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/relay/:kernelId/manifest", () => {
  it("returns the manifest for a known kernel", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/manifest",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kernelId).toBe("kernel-test-1");
    expect(body.deviceType).toBe("opentrons");
    expect(body.manifest).toBeDefined();
    expect(body.manifest.deviceType).toBe("opentrons");
    expect(body.manifest.safeTools).toContain("health");
  });

  it("returns generic manifest for unknown kernel", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-unknown/manifest",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deviceType).toBe("generic");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL CALL RELAY
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/relay/:kernelId/tool-call", () => {
  it("accepts a safe tool without scope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: { toolName: "health" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.toolName).toBe("health");
    expect(body.status).toBe("pending");
    expect(body.kernelId).toBe("kernel-test-1");
    expect(body.id).toMatch(/^tc_/);
  });

  it("rejects a non-safe tool without scope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: { toolName: "protocol_upload" },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("scope_required");
  });

  it("requires toolName", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a scoped write tool with valid scope", async () => {
    // Create a scope first
    const scopeRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      payload: {
        createdBy: "agent-1",
        allowedTools: ["protocol_upload", "run_create"],
      },
    });
    const scope = scopeRes.json();

    // Use the scope for a write tool
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: {
        scopeId: scope.id,
        toolName: "protocol_upload",
        args: { filename: "test.py", content: "print('hello')" },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().toolName).toBe("protocol_upload");
  });

  it("rejects a tool not in scope's allowedTools", async () => {
    const scopeRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      payload: {
        createdBy: "agent-1",
        allowedTools: ["run_create"],
      },
    });
    const scope = scopeRes.json();

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: {
        scopeId: scope.id,
        toolName: "shell",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("tool_not_allowed");
  });

  it("rejects when scope not found", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: {
        scopeId: "scope_nonexistent",
        toolName: "protocol_upload",
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/relay/:kernelId/tool-call/pending", () => {
  it("returns pending calls and marks them as claimed", async () => {
    // Insert a pending tool call
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: { toolName: "health" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-call/pending",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.calls[0].toolName).toBe("health");

    // Second poll should return empty (already claimed)
    const res2 = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-call/pending",
    });
    expect(res2.json().count).toBe(0);
  });
});

describe("POST /api/relay/:kernelId/tool-result", () => {
  it("completes a tool call with result", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: { toolName: "health" },
    });
    const callId = createRes.json().id;

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      payload: { callId, result: { status: "ok" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");
  });

  it("marks a tool call as failed with error", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: { toolName: "health" },
    });
    const callId = createRes.json().id;

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      payload: { callId, error: "device_unreachable" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("failed");
  });

  it("requires callId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/relay/:kernelId/tool-result/:id", () => {
  it("returns a completed tool call with parsed result", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: { toolName: "health" },
    });
    const callId = createRes.json().id;

    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      payload: { callId, result: { healthy: true } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/relay/kernel-test-1/tool-result/${callId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ healthy: true });
  });

  it("returns 404 for unknown call", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-result/tc_nonexistent",
    });
    expect(res.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTION SCOPES
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/relay/:kernelId/scope", () => {
  it("creates an execution scope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      payload: {
        createdBy: "agent-1",
        allowedTools: ["run_create", "run_action"],
        maxCommands: 50,
        expiresInMinutes: 15,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.kernelId).toBe("kernel-test-1");
    expect(body.createdBy).toBe("agent-1");
    expect(body.allowedTools).toEqual(["run_create", "run_action"]);
    expect(body.maxCommands).toBe(50);
    expect(body.status).toBe("active");
    expect(body.id).toMatch(/^scope_/);
  });

  it("requires createdBy and allowedTools", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires non-empty allowedTools array", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      payload: { createdBy: "agent-1", allowedTools: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/relay/:kernelId/scope/:scopeId", () => {
  it("returns scope details with remaining counts", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      payload: {
        createdBy: "agent-1",
        allowedTools: ["run_create"],
        maxCommands: 10,
      },
    });
    const scopeId = createRes.json().id;

    const res = await app.inject({
      method: "GET",
      url: `/api/relay/kernel-test-1/scope/${scopeId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.remainingCommands).toBe(10);
    expect(body.remainingRetries).toBe(3);
  });

  it("returns 404 for unknown scope", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/scope/scope_nonexistent",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/relay/:kernelId/scope/:scopeId/revoke", () => {
  it("revokes a scope and rejects pending calls", async () => {
    // Create scope
    const scopeRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      payload: {
        createdBy: "agent-1",
        allowedTools: ["run_create"],
      },
    });
    const scopeId = scopeRes.json().id;

    // Create a pending tool call under this scope
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: {
        scopeId,
        toolName: "run_create",
        args: { protocolId: "p1" },
      },
    });

    // Revoke
    const res = await app.inject({
      method: "POST",
      url: `/api/relay/kernel-test-1/scope/${scopeId}/revoke`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("revoked");
    expect(res.json().rejectedPendingCalls).toBe(1);
  });

  it("returns 409 for already revoked scope", async () => {
    const scopeRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      payload: {
        createdBy: "agent-1",
        allowedTools: ["run_create"],
      },
    });
    const scopeId = scopeRes.json().id;

    // Revoke twice
    await app.inject({
      method: "POST",
      url: `/api/relay/kernel-test-1/scope/${scopeId}/revoke`,
    });
    const res2 = await app.inject({
      method: "POST",
      url: `/api/relay/kernel-test-1/scope/${scopeId}/revoke`,
    });
    expect(res2.statusCode).toBe(409);
  });
});

describe("GET /api/relay/:kernelId/scope/:scopeId/audit", () => {
  it("returns tool call audit trail for a scope", async () => {
    // Create scope
    const scopeRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      payload: {
        createdBy: "agent-1",
        allowedTools: ["run_create"],
      },
    });
    const scopeId = scopeRes.json().id;

    // Make a tool call
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      payload: {
        scopeId,
        toolName: "run_create",
        args: { protocolId: "p1" },
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/relay/kernel-test-1/scope/${scopeId}/audit`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCalls).toBe(1);
    expect(body.calls[0].toolName).toBe("run_create");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CAMERA RELAY
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/relay/:kernelId/camera/frame", () => {
  it("accepts a camera frame", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/camera/frame",
      payload: {
        frame: Buffer.from("fake-jpeg-data").toString("base64"),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.kernelId).toBe("kernel-test-1");
    expect(body.id).toMatch(/^frame_/);
  });

  it("requires frame data", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/camera/frame",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps only 5 frames per kernel", async () => {
    for (let i = 0; i < 7; i++) {
      await app.inject({
        method: "POST",
        url: "/api/relay/kernel-test-1/camera/frame",
        payload: {
          frame: Buffer.from(`frame-${i}`).toString("base64"),
        },
      });
    }

    const { db } = getStore();
    const count = db
      .select()
      .from(ot2CameraFrames)
      .where(eq(ot2CameraFrames.kernelId, "kernel-test-1"))
      .all();
    expect(count.length).toBe(5);
  });
});

describe("GET /api/relay/:kernelId/camera/latest", () => {
  it("denies access to anonymous users", async () => {
    // Push a frame first
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/camera/frame",
      payload: {
        frame: Buffer.from("test-data").toString("base64"),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/camera/latest",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("camera_access_denied");
  });

  it("returns 404 when no frames exist", async () => {
    // Use a custom header to set operatorId via a hook (simulate auth)
    const customApp = Fastify({ logger: false });
    customApp.decorateRequest("operatorId", null);
    customApp.decorateRequest("userId", null);
    customApp.decorateRequest("apiKeyId", null);
    customApp.addHook("onRequest", async (req) => {
      (req as any).operatorId = "operator-1";
    });
    await customApp.register(deviceRelayRoutes);
    await customApp.ready();

    const res = await customApp.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/camera/latest",
    });
    expect(res.statusCode).toBe(404);
    await customApp.close();
  });
});

describe("camera auth: operator access", () => {
  it("allows kernel operator to view camera", async () => {
    // Push a frame
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/camera/frame",
      payload: {
        frame: Buffer.from("jpeg-data").toString("base64"),
      },
    });

    // Create app with operator auth
    const operatorApp = Fastify({ logger: false });
    operatorApp.decorateRequest("operatorId", null);
    operatorApp.decorateRequest("userId", null);
    operatorApp.decorateRequest("apiKeyId", null);
    operatorApp.addHook("onRequest", async (req) => {
      (req as any).operatorId = "operator-1";
    });
    await operatorApp.register(deviceRelayRoutes);
    await operatorApp.ready();

    const res = await operatorApp.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/camera/latest",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    await operatorApp.close();
  });
});

describe("camera auth: scope-holder access", () => {
  it("allows user with active scope to view camera", async () => {
    // Push a frame
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/camera/frame",
      payload: {
        frame: Buffer.from("jpeg-data").toString("base64"),
      },
    });

    // Create scope for agent-viewer
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      payload: {
        createdBy: "agent-viewer",
        allowedTools: ["run_create"],
      },
    });

    // Create app with agent-viewer auth
    const viewerApp = Fastify({ logger: false });
    viewerApp.decorateRequest("operatorId", null);
    viewerApp.decorateRequest("userId", null);
    viewerApp.decorateRequest("apiKeyId", null);
    viewerApp.addHook("onRequest", async (req) => {
      (req as any).operatorId = "agent-viewer";
    });
    await viewerApp.register(deviceRelayRoutes);
    await viewerApp.ready();

    const res = await viewerApp.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/camera/latest",
    });
    expect(res.statusCode).toBe(200);
    await viewerApp.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CHAT RELAY
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/relay/:kernelId/chat", () => {
  it("sends a chat message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat",
      payload: { message: "Hello, robot!" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.role).toBe("user");
    expect(body.content).toBe("Hello, robot!");
    expect(body.kernelId).toBe("kernel-test-1");
    expect(body.id).toMatch(/^msg_/);
  });

  it("requires message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects messages over 10k chars", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat",
      payload: { message: "x".repeat(10_001) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/relay/:kernelId/chat/messages", () => {
  it("returns conversation history", async () => {
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat",
      payload: { message: "msg 1" },
    });
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat",
      payload: { message: "msg 2" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/chat/messages",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(2);
  });
});

describe("GET /api/relay/:kernelId/chat/pending", () => {
  it("returns pending messages and marks them as processing", async () => {
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat",
      payload: { message: "pending msg" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/chat/pending",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(1);

    // Second poll returns empty
    const res2 = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/chat/pending",
    });
    expect(res2.json().count).toBe(0);
  });
});

describe("POST /api/relay/:kernelId/chat/respond", () => {
  it("posts an agent response", async () => {
    const msgRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat",
      payload: { message: "Hello?" },
    });
    const messageId = msgRes.json().id;

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat/respond",
      payload: {
        messageId,
        response: "Hello! I am the OT-2 agent.",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.role).toBe("assistant");
    expect(body.content).toBe("Hello! I am the OT-2 agent.");
  });

  it("requires response", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat/respond",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL MANIFEST SERVICE
// ═══════════════════════════════════════════════════════════════════════════

describe("tool-manifest-service", () => {
  it("isToolSafe returns true for safe opentrons tools", async () => {
    const { isToolSafe } = await import("../services/tool-manifest-service.js");
    expect(isToolSafe("opentrons", "health")).toBe(true);
    expect(isToolSafe("opentrons", "home")).toBe(true);
    expect(isToolSafe("opentrons", "lights")).toBe(true);
  });

  it("isToolSafe returns false for scoped/privileged tools", async () => {
    const { isToolSafe } = await import("../services/tool-manifest-service.js");
    expect(isToolSafe("opentrons", "protocol_upload")).toBe(false);
    expect(isToolSafe("opentrons", "shell")).toBe(false);
  });

  it("getSafeTools returns safe tools for known types", async () => {
    const { getSafeTools } = await import("../services/tool-manifest-service.js");
    const safe = getSafeTools("opentrons");
    expect(safe).toContain("health");
    expect(safe).toContain("evidence_snapshot");
    expect(safe).not.toContain("shell");
  });

  it("falls back to generic for unknown device type", async () => {
    const { getManifest } = await import("../services/tool-manifest-service.js");
    const manifest = await getManifest("unknown_device");
    expect(manifest).toBeDefined();
    expect(manifest!.deviceType).toBe("generic");
  });
});
