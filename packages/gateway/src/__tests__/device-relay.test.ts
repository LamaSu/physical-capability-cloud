import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { initStore, closeStore, getStore } from "../db.js";
import { deviceRelayRoutes, RELAY_ROUTE_ACCESS } from "../routes/device-relay.js";
import { getSafetyGateway } from "@pcc/kernel";
import { schema, sql, eq } from "@pcc/store";

const { shopKernels, kernelDevices, toolCallRelay, executionScopes, ot2CameraFrames, ot2ChatMessages } = schema;

let app: FastifyInstance;

// ── Principals ──────────────────────────────────────────────────────────────
// apiGate resolves the caller before any route runs: an API key sets both
// req.operatorId and req.userId, a SIWE session sets req.userId only. The test
// app stands in for it with two headers. No header = no principal.
const OPERATOR = "operator-1"; // operator of kernel-test-1
const OPERATOR_2 = "operator-2"; // operator of kernel-test-2
const SIWE_OPERATOR = "0xabc0000000000000000000000000000000000001"; // operator of kernel-siwe
const asKey = (id: string) => ({ "x-test-key": id });
const asSiwe = (address: string) => ({ "x-test-siwe": address });
const op = asKey(OPERATOR);

function seedKernel(id: string, operatorAddress: string) {
  getStore().db.insert(shopKernels).values({
    id,
    name: `Kernel ${id}`,
    operatorAddress,
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
}

beforeAll(async () => {
  // In-memory DB for tests
  process.env.DATABASE_URL = ":memory:";
  initStore({ seed: false });

  app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.addHook("onRequest", async (req) => {
    const key = req.headers["x-test-key"];
    const siwe = req.headers["x-test-siwe"];
    if (typeof key === "string") {
      req.operatorId = key;
      req.userId = key as `0x${string}`;
    } else if (typeof siwe === "string") {
      req.userId = siwe as `0x${string}`;
    }
  });

  await app.register(deviceRelayRoutes);
  await app.ready();

  // Seed the kernels + an OT-2 device
  seedKernel("kernel-test-1", OPERATOR);
  seedKernel("kernel-test-2", OPERATOR_2);
  seedKernel("kernel-siwe", SIWE_OPERATOR);
  seedKernel("kernel-unowned", "0x0000000000000000000000000000000000000000");

  getStore().db.insert(kernelDevices).values({
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

/** The operator of kernel-test-1 mints a scope held by `holder`. */
async function mintScope(holder: string, allowedTools: string[] = ["run_create"], kernelId = "kernel-test-1") {
  const headers = kernelId === "kernel-test-2" ? asKey(OPERATOR_2) : op;
  const res = await app.inject({
    method: "POST",
    url: `/api/relay/${kernelId}/scope`,
    headers,
    payload: { createdBy: holder, allowedTools },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** The operator posts a safe tool call and its executor claims it. */
async function createAndClaim(toolName = "health"): Promise<string> {
  const createRes = await app.inject({
    method: "POST",
    url: "/api/relay/kernel-test-1/tool-call",
    headers: op,
    payload: { toolName },
  });
  const callId = createRes.json().id;
  await app.inject({
    method: "GET",
    url: "/api/relay/kernel-test-1/tool-call/pending",
    headers: op,
  });
  return callId;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL MANIFEST
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/relay/:kernelId/manifest", () => {
  it("returns the manifest for a known kernel", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/manifest",
      headers: op,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kernelId).toBe("kernel-test-1");
    expect(body.deviceType).toBe("opentrons");
    expect(body.manifest).toBeDefined();
    expect(body.manifest.deviceType).toBe("opentrons");
    expect(body.manifest.safeTools).toContain("health");
  });

  it("returns the generic manifest for a kernel without a known device", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-2/manifest",
      headers: asKey(OPERATOR_2),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deviceType).toBe("generic");
  });

  it("is refused for a kernel nobody operates", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-unknown/manifest",
      headers: op,
    });
    expect(res.statusCode).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL CALL RELAY
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/relay/:kernelId/tool-call", () => {
  it("accepts a safe tool without scope from the kernel operator", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: op,
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
      headers: op,
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
      headers: op,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a scoped write tool from the scope's holder", async () => {
    const scopeId = await mintScope("agent-1", ["protocol_upload", "run_create"]);

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: asKey("agent-1"),
      payload: {
        scopeId,
        toolName: "protocol_upload",
        args: { filename: "test.py", content: "print('hello')" },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().toolName).toBe("protocol_upload");
  });

  it("rejects a tool not in scope's allowedTools", async () => {
    const scopeId = await mintScope("agent-1", ["run_create"]);

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: asKey("agent-1"),
      payload: {
        scopeId,
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
      headers: op,
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
      headers: op,
      payload: { toolName: "health" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-call/pending",
      headers: op,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.calls[0].toolName).toBe("health");

    // Second poll should return empty (already claimed)
    const res2 = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-call/pending",
      headers: op,
    });
    expect(res2.json().count).toBe(0);
  });
});

describe("POST /api/relay/:kernelId/tool-result", () => {
  it("completes a tool call with result", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: op,
      payload: { toolName: "health" },
    });
    const callId = createRes.json().id;

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: op,
      payload: { callId, result: { status: "ok" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");
  });

  it("marks a tool call as failed with error", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: op,
      payload: { toolName: "health" },
    });
    const callId = createRes.json().id;

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: op,
      payload: { callId, error: "device_unreachable" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("failed");
  });

  it("requires callId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: op,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL RESULT — SAFETY (breaker idempotency + caller ownership, finding F2)
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/relay/:kernelId/tool-result — breaker idempotency (F2)", () => {
  it("records a re-POSTed (dropped-200 retry) result only once to the breaker", async () => {
    getSafetyGateway().resetCircuit("kernel-test-1");
    const callId = await createAndClaim();

    const failSpy = vi
      .spyOn(getSafetyGateway(), "recordDeviceFailure")
      .mockImplementation(() => {});

    // First terminal transition (claimed -> failed): records once.
    const res1 = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: op,
      payload: { callId, error: "device_unreachable" },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().status).toBe("failed");

    // Re-POST the identical result — executor retrying after a lost 200.
    const res2 = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: op,
      payload: { callId, error: "device_unreachable" },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().idempotent).toBe(true);
    expect(res2.json().status).toBe("failed");

    // The breaker saw the failure exactly once, not twice.
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(failSpy).toHaveBeenCalledWith("kernel-test-1");

    failSpy.mockRestore();
  });

  it("does not re-record (nor spuriously reset) a completed call on replay", async () => {
    getSafetyGateway().resetCircuit("kernel-test-1");
    const callId = await createAndClaim();

    const okSpy = vi
      .spyOn(getSafetyGateway(), "recordDeviceSuccess")
      .mockImplementation(() => {});
    const failSpy = vi
      .spyOn(getSafetyGateway(), "recordDeviceFailure")
      .mockImplementation(() => {});

    // First success recorded once.
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: op,
      payload: { callId, result: { ok: true } },
    });
    // Replay a *failure* against the already-completed call — must be a no-op
    // ack (cannot flip a recorded success into a failure on the breaker).
    const replay = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: op,
      payload: { callId, error: "late_failure" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().idempotent).toBe(true);
    expect(replay.json().status).toBe("completed");

    expect(okSpy).toHaveBeenCalledTimes(1);
    expect(failSpy).not.toHaveBeenCalled();

    okSpy.mockRestore();
    failSpy.mockRestore();
  });
});

describe("POST /api/relay/:kernelId/tool-result — caller ownership (F2)", () => {
  it("rejects a result from a non-owner authenticated caller and records nothing", async () => {
    getSafetyGateway().resetCircuit("kernel-test-1");
    const callId = await createAndClaim();

    const failSpy = vi
      .spyOn(getSafetyGateway(), "recordDeviceFailure")
      .mockImplementation(() => {});
    const okSpy = vi
      .spyOn(getSafetyGateway(), "recordDeviceSuccess")
      .mockImplementation(() => {});

    // "mallory" is neither the kernel operator nor the scope owner.
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: asKey("mallory"),
      payload: { callId, error: "spoofed_failure" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("relay_access_denied");
    // No breaker mutation — cannot force-trip or force-reset the kernel.
    expect(failSpy).not.toHaveBeenCalled();
    expect(okSpy).not.toHaveBeenCalled();

    // The call is untouched (still claimable/in-flight), not marked terminal.
    const check = await app.inject({
      method: "GET",
      url: `/api/relay/kernel-test-1/tool-result/${callId}`,
      headers: op,
    });
    expect(check.json().status).toBe("claimed");

    failSpy.mockRestore();
    okSpy.mockRestore();
  });

  it("still records the first result from the kernel operator (legit path works)", async () => {
    getSafetyGateway().resetCircuit("kernel-test-1");
    const callId = await createAndClaim();

    const okSpy = vi
      .spyOn(getSafetyGateway(), "recordDeviceSuccess")
      .mockImplementation(() => {});

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: op,
      payload: { callId, result: { ok: true } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");
    expect(okSpy).toHaveBeenCalledTimes(1);
    expect(okSpy).toHaveBeenCalledWith("kernel-test-1");

    okSpy.mockRestore();
  });

  it("refuses an unauthenticated report (no anonymous relay mode) and records nothing", async () => {
    getSafetyGateway().resetCircuit("kernel-test-1");
    const callId = await createAndClaim();

    const okSpy = vi
      .spyOn(getSafetyGateway(), "recordDeviceSuccess")
      .mockImplementation(() => {});

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      payload: { callId, result: { ok: true } },
    });
    expect(res.statusCode).toBe(401);
    expect(okSpy).not.toHaveBeenCalled();

    okSpy.mockRestore();
  });
});

describe("GET /api/relay/:kernelId/tool-result/:id", () => {
  it("returns a completed tool call with parsed result", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: op,
      payload: { toolName: "health" },
    });
    const callId = createRes.json().id;

    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: op,
      payload: { callId, result: { healthy: true } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/relay/kernel-test-1/tool-result/${callId}`,
      headers: op,
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
      headers: op,
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
      headers: op,
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

  it("requires allowedTools", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      headers: op,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires non-empty allowedTools array", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      headers: op,
      payload: { createdBy: "agent-1", allowedTools: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("is held by the operator itself when no createdBy is named", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      headers: op,
      payload: { allowedTools: ["run_create"] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().createdBy).toBe(OPERATOR);
  });

  it("refuses a jobId that names no job on this kernel", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      headers: op,
      payload: { createdBy: OPERATOR, allowedTools: ["run_create"], jobId: "job-does-not-exist" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("job_not_on_kernel");
  });
});

describe("GET /api/relay/:kernelId/scope/:scopeId", () => {
  it("returns scope details with remaining counts", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      headers: op,
      payload: {
        createdBy: "agent-1",
        allowedTools: ["run_create"],
        maxCommands: 10,
      },
    });
    const scopeId = createRes.json().id;

    // The holder reads its own scope.
    const res = await app.inject({
      method: "GET",
      url: `/api/relay/kernel-test-1/scope/${scopeId}`,
      headers: asKey("agent-1"),
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
      headers: op,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/relay/:kernelId/scope/:scopeId/revoke", () => {
  it("revokes a scope and rejects pending calls", async () => {
    const scopeId = await mintScope("agent-1", ["run_create"]);

    // Create a pending tool call under this scope
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: asKey("agent-1"),
      payload: {
        scopeId,
        toolName: "run_create",
        args: { protocolId: "p1" },
      },
    });

    // Revoke (the operator's emergency stop)
    const res = await app.inject({
      method: "POST",
      url: `/api/relay/kernel-test-1/scope/${scopeId}/revoke`,
      headers: op,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("revoked");
    expect(res.json().rejectedPendingCalls).toBe(1);
  });

  it("returns 409 for already revoked scope", async () => {
    const scopeId = await mintScope("agent-1", ["run_create"]);

    // Revoke twice (the holder may give up its own scope)
    await app.inject({
      method: "POST",
      url: `/api/relay/kernel-test-1/scope/${scopeId}/revoke`,
      headers: asKey("agent-1"),
    });
    const res2 = await app.inject({
      method: "POST",
      url: `/api/relay/kernel-test-1/scope/${scopeId}/revoke`,
      headers: asKey("agent-1"),
    });
    expect(res2.statusCode).toBe(409);
  });
});

describe("GET /api/relay/:kernelId/scope/:scopeId/audit", () => {
  it("returns tool call audit trail for a scope", async () => {
    const scopeId = await mintScope("agent-1", ["run_create"]);

    // Make a tool call
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: asKey("agent-1"),
      payload: {
        scopeId,
        toolName: "run_create",
        args: { protocolId: "p1" },
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/relay/kernel-test-1/scope/${scopeId}/audit`,
      headers: op,
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

async function pushFrame(data = "jpeg-data") {
  const res = await app.inject({
    method: "POST",
    url: "/api/relay/kernel-test-1/camera/frame",
    headers: op,
    payload: { frame: Buffer.from(data).toString("base64") },
  });
  expect(res.statusCode).toBe(201);
  return res;
}

describe("POST /api/relay/:kernelId/camera/frame", () => {
  it("accepts a camera frame", async () => {
    const res = await pushFrame("fake-jpeg-data");
    const body = res.json();
    expect(body.kernelId).toBe("kernel-test-1");
    expect(body.id).toMatch(/^frame_/);
  });

  it("requires frame data", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/camera/frame",
      headers: op,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps only 5 frames per kernel", async () => {
    for (let i = 0; i < 7; i++) {
      await pushFrame(`frame-${i}`);
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
    await pushFrame("test-data");

    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/camera/latest",
    });
    expect(res.statusCode).toBe(401);
  });

  it("denies access to an authenticated stranger", async () => {
    await pushFrame("test-data");

    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/camera/latest",
      headers: asKey("mallory"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("relay_access_denied");
  });

  it("returns 404 when no frames exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/camera/latest",
      headers: op,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("camera auth: operator access", () => {
  it("allows kernel operator to view camera", async () => {
    await pushFrame();

    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/camera/latest",
      headers: op,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
  });
});

describe("camera auth: scope-holder access", () => {
  it("allows user with active scope to view camera", async () => {
    await pushFrame();
    await mintScope("agent-viewer", ["run_create"]);

    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/camera/latest",
      headers: asKey("agent-viewer"),
    });
    expect(res.statusCode).toBe(200);
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
      headers: op,
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
      headers: op,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects messages over 10k chars", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat",
      headers: op,
      payload: { message: "x".repeat(10_001) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/relay/:kernelId/chat/messages", () => {
  it("returns conversation history", async () => {
    await mintScope("agent-1");
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat",
      headers: asKey("agent-1"),
      payload: { message: "msg 1" },
    });
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat",
      headers: asKey("agent-1"),
      payload: { message: "msg 2" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/chat/messages",
      headers: asKey("agent-1"),
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
      headers: op,
      payload: { message: "pending msg" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/chat/pending",
      headers: op,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(1);

    // Second poll returns empty
    const res2 = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/chat/pending",
      headers: op,
    });
    expect(res2.json().count).toBe(0);
  });
});

describe("POST /api/relay/:kernelId/chat/respond", () => {
  it("posts an agent response", async () => {
    const msgRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat",
      headers: op,
      payload: { message: "Hello?" },
    });
    const messageId = msgRes.json().id;

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat/respond",
      headers: op,
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
      headers: op,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/relay/:kernelId/tool-call/pending — claim timeout", () => {
  it("reclaims stale claimed calls after timeout", async () => {
    // Create a tool call
    const createRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: op,
      payload: { toolName: "health" },
    });
    const callId = createRes.json().id;

    // First poll claims it
    const poll1 = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-call/pending",
      headers: op,
    });
    expect(poll1.json().count).toBe(1);

    // Second poll returns empty (claimed)
    const poll2 = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-call/pending",
      headers: op,
    });
    expect(poll2.json().count).toBe(0);

    // Manually backdate the claimedAt to simulate timeout (>120s ago)
    const { db } = getStore();
    const staleTime = new Date(Date.now() - 130_000).toISOString();
    db.update(toolCallRelay)
      .set({ claimedAt: staleTime })
      .where(eq(toolCallRelay.id, callId))
      .run();

    // Third poll should reclaim the stale call
    const poll3 = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-call/pending",
      headers: op,
    });
    expect(poll3.json().count).toBe(1);
    expect(poll3.json().calls[0].id).toBe(callId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// N4b-gw ITEM 4 — /api/relay/** IS DEFAULT-DENY, PER KERNEL OPERATOR
// ═══════════════════════════════════════════════════════════════════════════

/** Concrete URL for a route pattern, with real ids where the test has them. */
function urlFor(pattern: string, ids: { callId?: string; scopeId?: string } = {}) {
  return pattern
    .replace(":kernelId", "kernel-test-1")
    .replace(":id", ids.callId ?? "tc_none")
    .replace(":scopeId", ids.scopeId ?? "scope_none");
}

/** A body that passes each route's own validation, so only access decides. */
function bodyFor(method: string, pattern: string, ids: { callId?: string } = {}) {
  if (method !== "POST") return undefined;
  if (pattern.endsWith("/tool-call")) return { toolName: "health" };
  if (pattern.endsWith("/tool-result")) return { callId: ids.callId ?? "tc_none", result: { ok: true } };
  if (pattern.endsWith("/scope")) return { createdBy: "mallory", allowedTools: ["shell"] };
  if (pattern.endsWith("/camera/frame")) return { frame: Buffer.from("x").toString("base64") };
  if (pattern.endsWith("/chat")) return { message: "hi" };
  if (pattern.endsWith("/chat/respond")) return { response: "hi" };
  return {};
}

const ROUTES = Object.entries(RELAY_ROUTE_ACCESS).map(([key, access]) => {
  const [method, pattern] = key.split(" ");
  return { key, method: method as "GET" | "POST", pattern, access };
});

describe("N4b-gw: the access table covers the plugin exactly", () => {
  it("lists every route deviceRelayRoutes registers, and nothing else", async () => {
    const probe = Fastify({ logger: false });
    const registered: string[] = [];
    probe.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const m of methods) if (m !== "HEAD") registered.push(`${m} ${route.url}`);
    });
    await probe.register(deviceRelayRoutes);
    await probe.ready();
    await probe.close();

    expect(registered.sort()).toEqual(Object.keys(RELAY_ROUTE_ACCESS).sort());
    expect(registered).toHaveLength(17);
  });

  it("refuses a registered route that has no table entry (default-deny), even for the operator", async () => {
    // Fastify auto-registers HEAD for every GET; none is in the table.
    const res = await app.inject({
      method: "HEAD",
      url: "/api/relay/kernel-test-1/manifest",
      headers: op,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("N4b-gw: no principal, no relay", () => {
  it.each(ROUTES)("$key answers 401 without a principal", async ({ method, pattern }) => {
    const res = await app.inject({ method, url: urlFor(pattern), payload: bodyFor(method, pattern) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("authentication_required");
  });
});

describe("N4b-gw: an authenticated stranger is refused on every route", () => {
  it.each(ROUTES)("$key answers 403 to a key that is neither operator nor grant holder", async ({ method, pattern }) => {
    // Real objects on kernel-test-1, so object-addressed routes reach their owner check.
    const scopeId = await mintScope("agent-1", ["run_create"]);
    const callRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: asKey("agent-1"),
      payload: { scopeId, toolName: "run_create", args: {} },
    });
    const callId = callRes.json().id as string;

    const res = await app.inject({
      method,
      url: urlFor(pattern, { callId, scopeId }),
      headers: asKey("mallory"),
      payload: bodyFor(method, pattern, { callId }),
    });
    expect(res.statusCode).toBe(403);

    // Nothing moved: the scope is active, the call is still pending, no frame, no chat.
    const { db } = getStore();
    expect(db.select().from(executionScopes).where(eq(executionScopes.id, scopeId)).get()!.status).toBe("active");
    expect(db.select().from(toolCallRelay).where(eq(toolCallRelay.id, callId)).get()!.status).toBe("pending");
    expect(db.select().from(executionScopes).where(eq(executionScopes.createdBy, "mallory")).all()).toHaveLength(0);
    expect(db.select().from(ot2CameraFrames).all()).toHaveLength(0);
    expect(db.select().from(ot2ChatMessages).all()).toHaveLength(0);
  });

  it("treats a SIWE session as a principal, not as anonymous", async () => {
    getSafetyGateway().resetCircuit("kernel-test-1");
    const callId = await createAndClaim();
    const okSpy = vi.spyOn(getSafetyGateway(), "recordDeviceSuccess").mockImplementation(() => {});

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: asSiwe("0xdef0000000000000000000000000000000000002"),
      payload: { callId, result: { forged: true } },
    });
    expect(res.statusCode).toBe(403);
    expect(okSpy).not.toHaveBeenCalled();
    okSpy.mockRestore();
  });

  it("lets a SIWE session that operates the kernel act as its operator", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-siwe/tool-call/pending",
      headers: asSiwe(SIWE_OPERATOR),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("N4b-gw: the device side is the kernel operator's alone", () => {
  const DEVICE_SIDE = ROUTES.filter((r) => r.access === "kernel_operator" && !r.pattern.endsWith("/scope"));

  it.each(DEVICE_SIDE)("$key refuses a grant holder (scope holders command, never act as the device)", async ({ method, pattern }) => {
    const scopeId = await mintScope("agent-1", ["run_create"]);
    const callRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: asKey("agent-1"),
      payload: { scopeId, toolName: "run_create", args: {} },
    });
    const callId = callRes.json().id as string;

    const res = await app.inject({
      method,
      url: urlFor(pattern, { callId }),
      headers: asKey("agent-1"),
      payload: bodyFor(method, pattern, { callId }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().required).toBe("kernel_operator");
  });

  it("refuses a cross-kernel claim: operator-2 cannot claim kernel-test-1's calls", async () => {
    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: op,
      payload: { toolName: "health" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-call/pending",
      headers: asKey(OPERATOR_2),
    });
    expect(res.statusCode).toBe(403);

    // The call is still there for its own operator.
    const own = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-call/pending",
      headers: op,
    });
    expect(own.json().count).toBe(1);
  });

  it("refuses a cross-kernel result: operator-2 cannot report kernel-test-1's call through its own kernel's path", async () => {
    getSafetyGateway().resetCircuit("kernel-test-1");
    const callId = await createAndClaim();
    const failSpy = vi.spyOn(getSafetyGateway(), "recordDeviceFailure").mockImplementation(() => {});

    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-2/tool-result",
      headers: asKey(OPERATOR_2),
      payload: { callId, error: "forged_failure" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("tool_result_not_yours");
    expect(failSpy).not.toHaveBeenCalled();

    const check = await app.inject({
      method: "GET",
      url: `/api/relay/kernel-test-1/tool-result/${callId}`,
      headers: op,
    });
    expect(check.json().status).toBe("claimed");
    failSpy.mockRestore();
  });

  it("refuses a cross-kernel camera post: operator-2 cannot push frames to kernel-test-1", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/camera/frame",
      headers: asKey(OPERATOR_2),
      payload: { frame: Buffer.from("forged").toString("base64") },
    });
    expect(res.statusCode).toBe(403);
    expect(getStore().db.select().from(ot2CameraFrames).all()).toHaveLength(0);
  });

  it("gives a kernel whose operatorAddress is the zero placeholder no operator at all", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-unowned/tool-call/pending",
      headers: asSiwe("0x0000000000000000000000000000000000000000"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("answers chat only for this kernel's messages", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-2/chat",
      headers: asKey(OPERATOR_2),
      payload: { message: "for kernel 2" },
    });
    const otherId = other.json().id as string;

    await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/chat/respond",
      headers: op,
      payload: { messageId: otherId, response: "not yours" },
    });
    const row = getStore().db.select().from(ot2ChatMessages).where(eq(ot2ChatMessages.id, otherId)).get();
    expect(row!.status).toBe("pending");
  });
});

describe("N4b-gw: scopes are the operator's to grant", () => {
  it("refuses a free key that self-mints a shell scope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      headers: asKey("free-key"),
      payload: { createdBy: "free-key", allowedTools: ["shell"], maxCommands: 1000 },
    });
    expect(res.statusCode).toBe(403);
    expect(getStore().db.select().from(executionScopes).all()).toHaveLength(0);
  });

  it("refuses a grant holder that tries to mint more scopes", async () => {
    await mintScope("agent-1", ["run_create"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/scope",
      headers: asKey("agent-1"),
      payload: { allowedTools: ["shell"] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("keeps grant holders inside their own scope", async () => {
    const scope1 = await mintScope("agent-1", ["run_create"]);
    await mintScope("agent-2", ["run_create"]);

    const callRes = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: asKey("agent-1"),
      payload: { scopeId: scope1, toolName: "run_create", args: {} },
    });
    const callId = callRes.json().id as string;

    const cases = [
      { method: "POST" as const, url: "/api/relay/kernel-test-1/tool-call", payload: { scopeId: scope1, toolName: "run_create" } },
      { method: "GET" as const, url: `/api/relay/kernel-test-1/tool-result/${callId}` },
      { method: "GET" as const, url: `/api/relay/kernel-test-1/scope/${scope1}` },
      { method: "GET" as const, url: `/api/relay/kernel-test-1/scope/${scope1}/audit` },
      { method: "POST" as const, url: `/api/relay/kernel-test-1/scope/${scope1}/revoke` },
    ];
    for (const c of cases) {
      const res = await app.inject({ ...c, headers: asKey("agent-2") });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
    }
    const row = getStore().db.select().from(executionScopes).where(eq(executionScopes.id, scope1)).get();
    expect(row!.status).toBe("active");
  });

  it("does not find another kernel's scope or call through this kernel's path", async () => {
    const scope1 = await mintScope("agent-1", ["run_create"]);
    const callId = await createAndClaim();
    for (const url of [
      `/api/relay/kernel-test-2/scope/${scope1}`,
      `/api/relay/kernel-test-2/scope/${scope1}/audit`,
      `/api/relay/kernel-test-2/tool-result/${callId}`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: asKey(OPERATOR_2) });
      expect(res.statusCode, url).toBe(404);
    }
    const revoke = await app.inject({
      method: "POST",
      url: `/api/relay/kernel-test-2/scope/${scope1}/revoke`,
      headers: asKey(OPERATOR_2),
    });
    expect(revoke.statusCode).toBe(404);
  });

  it("makes a grant holder name its scope, even for a safe tool", async () => {
    await mintScope("agent-1", ["run_create"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-call",
      headers: asKey("agent-1"),
      payload: { toolName: "health" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("scope_required");
  });

  it("grants nothing once the scope has expired or been revoked", async () => {
    await pushFrame();
    const scopeId = await mintScope("agent-1", ["run_create"]);
    const { db } = getStore();

    db.update(executionScopes)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(executionScopes.id, scopeId))
      .run();
    for (const url of ["/api/relay/kernel-test-1/camera/latest", "/api/relay/kernel-test-1/manifest"]) {
      const res = await app.inject({ method: "GET", url, headers: asKey("agent-1") });
      expect(res.statusCode, url).toBe(403);
    }

    const scope2 = await mintScope("agent-1", ["run_create"]);
    await app.inject({ method: "POST", url: `/api/relay/kernel-test-1/scope/${scope2}/revoke`, headers: op });
    const res = await app.inject({ method: "GET", url: "/api/relay/kernel-test-1/camera/latest", headers: asKey("agent-1") });
    expect(res.statusCode).toBe(403);
  });
});
