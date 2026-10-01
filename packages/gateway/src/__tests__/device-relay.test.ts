import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { deviceRelayRoutes, RELAY_ROUTE_ACCESS } from "../routes/device-relay.js";
import { operatorRoutes } from "../routes/operator.js";
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
  // The real stop and resume routes, for the N4b-gw r6 tests below. The relay
  // guard is encapsulated in deviceRelayRoutes, so it does not run on these.
  await app.register(operatorRoutes);
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

// At-most-once delivery (N4b-gw r6, F2). A claim the executor never reported
// used to go back to `pending` after 120 s and be handed out again, so one
// physical command could reach the device twice while the first executor was
// still running it. The claim now times out into a terminal failure: it is
// closed as `failed` with the error `claim_timeout`, and it is never delivered
// again. The caller resubmits if it still wants the work.
describe("GET /api/relay/:kernelId/tool-call/pending — claim timeout (at-most-once)", () => {
  it("closes a claim that was never reported as failed/claim_timeout, and never redelivers it", async () => {
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

    // Third poll must NOT hand the same command out again: the first executor
    // may still be running it.
    const poll3 = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-call/pending",
      headers: op,
    });
    expect(poll3.statusCode).toBe(200);
    expect(poll3.json().count).toBe(0);
    expect(poll3.json().calls).toEqual([]);

    // The call is closed: terminal, with the reason, and its claim kept for the audit.
    const row = db.select().from(toolCallRelay).where(eq(toolCallRelay.id, callId)).get()!;
    expect(row).toMatchObject({ status: "failed", error: "claim_timeout", claimedAt: staleTime, result: null });
    expect(row.completedAt).toEqual(expect.any(String));

    // The brain sees the failure and can resubmit.
    const seen = await app.inject({
      method: "GET",
      url: `/api/relay/kernel-test-1/tool-result/${callId}`,
      headers: op,
    });
    expect(seen.json()).toMatchObject({ id: callId, status: "failed", error: "claim_timeout" });

    // And no later poll brings it back.
    const poll4 = await app.inject({
      method: "GET",
      url: "/api/relay/kernel-test-1/tool-call/pending",
      headers: op,
    });
    expect(poll4.json().calls).toEqual([]);
    expect(db.select().from(toolCallRelay).where(eq(toolCallRelay.id, callId)).get()!.status).toBe("failed");
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

// ═══════════════════════════════════════════════════════════════════════════
// astra r1 on #400, item 3: rows the retired /api/ot2 writer left behind can link
// a call on one kernel to a scope held on another. Such a link grants nothing.
// ═══════════════════════════════════════════════════════════════════════════

describe("N4b-gw: a call linked to another kernel's scope stays on its own kernel", () => {
  async function crossLinkedCall(status: string) {
    const foreignScope = await mintScope("holder-2", ["run_create"], "kernel-test-2");
    const id = `legacy-${status}-${Date.now().toString(36)}`;
    getStore().db.insert(toolCallRelay).values({
      id,
      scopeId: foreignScope,
      kernelId: "kernel-test-1",
      toolName: "run_create",
      toolArgs: {},
      status,
      result: JSON.stringify({ secret: "kernel-test-1 data" }),
      createdAt: new Date().toISOString(),
    }).run();
    return { id, foreignScope };
  }

  it("the other kernel's scope holder can't read the call's result; the operator can", async () => {
    const { id } = await crossLinkedCall("completed");
    const holder = await app.inject({ method: "GET", url: `/api/relay/kernel-test-1/tool-result/${id}`, headers: asKey("holder-2") });
    expect(holder.statusCode).toBe(403);
    const operator = await app.inject({ method: "GET", url: `/api/relay/kernel-test-1/tool-result/${id}`, headers: op });
    expect(operator.statusCode).toBe(200);
  });

  it("the scope's audit on its own kernel does not list the other kernel's call", async () => {
    const { id, foreignScope } = await crossLinkedCall("completed");
    const res = await app.inject({ method: "GET", url: `/api/relay/kernel-test-2/scope/${foreignScope}/audit`, headers: asKey("holder-2") });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(id);
    expect(JSON.stringify(res.json())).not.toContain("kernel-test-1 data");
  });

  it("revoking the scope leaves the other kernel's pending call alone", async () => {
    const { id, foreignScope } = await crossLinkedCall("pending");
    const res = await app.inject({ method: "POST", url: `/api/relay/kernel-test-2/scope/${foreignScope}/revoke`, headers: asKey(OPERATOR_2) });
    expect(res.statusCode).toBe(200);
    expect(res.json().rejectedPendingCalls).toBe(0);
    const row = getStore().db.select().from(toolCallRelay).where(eq(toolCallRelay.id, id)).get();
    expect(row!.status).toBe("pending");
  });

  it("a failed result on one kernel does not spend another kernel's scope retries", async () => {
    const { id, foreignScope } = await crossLinkedCall("claimed");
    const res = await app.inject({
      method: "POST",
      url: "/api/relay/kernel-test-1/tool-result",
      headers: op,
      payload: { callId: id, error: "boom" },
    });
    expect(res.statusCode).toBe(200);
    const scope = getStore().db.select().from(executionScopes).where(eq(executionScopes.id, foreignScope)).get();
    expect(scope!.retryCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// N4b-gw round 3 (astra r2 on 68c20e9f, finding 2): dispatch re-checks every
// queued call. GET /tool-call/pending is where a call leaves the gateway for
// the device, so a row without execution authority is refused there, whoever
// wrote it and however long it waited.
// ═══════════════════════════════════════════════════════════════════════════

describe("N4b-gw: dispatch re-checks each queued call's authority", () => {
  const poll = async () =>
    (await app.inject({ method: "GET", url: "/api/relay/kernel-test-1/tool-call/pending", headers: op })).json();
  const row = (id: string) => getStore().db.select().from(toolCallRelay).where(eq(toolCallRelay.id, id)).get()!;
  const setScope = (id: string, fields: Partial<typeof executionScopes.$inferInsert>) =>
    getStore().db.update(executionScopes).set(fields).where(eq(executionScopes.id, id)).run();

  /** A queued row as any writer may have left it: the admission route, or an older one. */
  function queue(id: string, toolName: string, scopeId: string | null, createdAt = new Date().toISOString()) {
    getStore().db.insert(toolCallRelay).values({
      id, scopeId, kernelId: "kernel-test-1", toolName, toolArgs: {}, status: "pending", createdAt,
    }).run();
  }

  /** Queue a write through the admission route, as the scope's holder. */
  async function admit(holder: string, scopeId: string, toolName = "run_create") {
    const res = await app.inject({
      method: "POST", url: "/api/relay/kernel-test-1/tool-call", headers: asKey(holder), payload: { scopeId, toolName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it("never hands out a call that names another kernel's scope, and the refusal is final", async () => {
    const foreign = await mintScope("holder-2", ["run_create"], "kernel-test-2");
    queue("tc-cross", "run_create", foreign);
    expect((await poll()).count).toBe(0);
    expect(row("tc-cross")).toMatchObject({ status: "rejected", error: "scope_kernel_mismatch" });
    expect((await poll()).count).toBe(0);
  });

  it("refuses the other kernel's scope for a safe tool too", async () => {
    const foreign = await mintScope("holder-2", ["run_create"], "kernel-test-2");
    queue("tc-cross-safe", "health", foreign);
    expect((await poll()).count).toBe(0);
    expect(row("tc-cross-safe")).toMatchObject({ status: "rejected", error: "scope_kernel_mismatch" });
  });

  it("never hands out a call whose scope does not exist", async () => {
    queue("tc-ghost", "run_create", "scope_gone");
    expect((await poll()).count).toBe(0);
    expect(row("tc-ghost")).toMatchObject({ status: "rejected", error: "scope_not_found" });
  });

  it("never hands out a write whose scope expired while it waited", async () => {
    const scope = await mintScope("agent-q", ["run_create"]);
    const id = await admit("agent-q", scope);
    setScope(scope, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect((await poll()).count).toBe(0);
    expect(row(id)).toMatchObject({ status: "rejected", error: "scope_expired" });
  });

  it("never hands out a write whose scope is no longer active", async () => {
    const scope = await mintScope("agent-q", ["run_create"]);
    const id = await admit("agent-q", scope);
    setScope(scope, { status: "expired" }); // what a read of an expired scope records
    expect((await poll()).count).toBe(0);
    expect(row(id)).toMatchObject({ status: "rejected", error: "scope_not_active" });
  });

  it("never hands out a write its scope does not allow", async () => {
    const scope = await mintScope("agent-q", ["run_create"]);
    queue("tc-shell", "shell", scope);
    expect((await poll()).count).toBe(0);
    expect(row("tc-shell")).toMatchObject({ status: "rejected", error: "tool_not_allowed" });
  });

  it("never hands out a write with no scope", async () => {
    queue("tc-noscope", "run_create", null);
    expect((await poll()).count).toBe(0);
    expect(row("tc-noscope")).toMatchObject({ status: "rejected", error: "scope_required" });
  });

  it("still hands out the operator's scope-free safe call and a live scope's allowed write", async () => {
    queue("tc-safe", "health", null, new Date(Date.now() - 10).toISOString());
    const scope = await mintScope("agent-q", ["run_create"]);
    const write = await admit("agent-q", scope);
    const body = await poll();
    expect(body.calls.map((c: { id: string }) => c.id)).toEqual(["tc-safe", write]);
    expect(row("tc-safe").status).toBe("claimed");
    expect(row(write).status).toBe("claimed");
  });

  it("refused calls at the head of the queue do not hold back a valid one", async () => {
    const foreign = await mintScope("holder-2", ["run_create"], "kernel-test-2");
    const t0 = Date.now() - 1_000;
    for (let i = 0; i < 6; i++) queue(`tc-bad-${i}`, "run_create", foreign, new Date(t0 + i).toISOString());
    queue("tc-good", "health", null, new Date(t0 + 10).toISOString());
    const body = await poll();
    expect(body.calls.map((c: { id: string }) => c.id)).toEqual(["tc-good"]);
    for (let i = 0; i < 6; i++) expect(row(`tc-bad-${i}`).status).toBe("rejected");
  });

  it("closes a timed-out claim as claim_timeout, never handing it out again, whatever its scope became (at-most-once)", async () => {
    const scope = await mintScope("agent-q", ["run_create"]);
    const id = await admit("agent-q", scope);
    expect((await poll()).count).toBe(1);
    getStore().db.update(toolCallRelay)
      .set({ claimedAt: new Date(Date.now() - 300_000).toISOString() })
      .where(eq(toolCallRelay.id, id))
      .run();
    setScope(scope, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect((await poll()).count).toBe(0);
    // The call was dispatched once, so it failed for want of a report; it was
    // not "rejected", which would say it never reached the device.
    expect(row(id)).toMatchObject({ status: "failed", error: "claim_timeout" });
  });

  describe("escrow parity at dispatch", () => {
    /** A job on kernel-test-1 whose negotiated escrow is funded. */
    function seedFundedJob(jobId: string) {
      const { db } = getStore();
      const now = new Date().toISOString();
      getRepos().capabilities.insert({
        id: `cap-${jobId}`, kernelId: "kernel-test-1", type: "liquid-handling", name: jobId, description: "",
        location: { lat: 0, lng: 0 }, pricing: { currency: "USDC", baseCost: "1", minimum: "1" },
        materials: [], assuranceTiers: [0], availability: {},
      } as never);
      db.insert(schema.jobs).values({
        id: jobId, stepId: "step-1", cwmId: `cwm-${jobId}`, capabilityId: `cap-${jobId}`, kernelId: "kernel-test-1",
        status: "queued", assignedDevices: [], progress: 0,
      } as never).run();
      db.insert(schema.negotiationSessions).values({
        id: `ns-${jobId}`, status: "committed", userAgentId: "buyer", kernelId: "kernel-test-1",
        capabilityType: "liquid-handling", operatorConstraints: {}, jobId, cwmId: `cwm-${jobId}`,
        createdAt: now, expiresAt: now,
      } as never).run();
      getRepos().escrows.insert({
        id: `esc-${jobId}`, cwmId: `cwm-${jobId}`, contractAddress: "0x5555555555555555555555555555555555555555",
        payer: "0x3333333333333333333333333333333333333333", totalAmount: "10.00", currency: "USDC",
        status: "funded", createdAt: now, deadline: new Date(Date.now() + 86_400_000).toISOString(),
      } as never);
    }

    async function jobScope(holder: string, jobId: string) {
      const res = await app.inject({
        method: "POST", url: "/api/relay/kernel-test-1/scope", headers: op,
        payload: { createdBy: holder, allowedTools: ["run_create"], jobId },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    }

    it("never hands out a write whose job's escrow stopped being funded after admission", async () => {
      seedFundedJob("job-refunded");
      const scope = await jobScope("agent-e", "job-refunded");
      const id = await admit("agent-e", scope);
      getRepos().escrows.updateStatus("esc-job-refunded", "refunded");
      expect((await poll()).count).toBe(0);
      expect(row(id)).toMatchObject({ status: "rejected", error: "escrow_not_funded" });
    });

    it("an escrow lookup failure leaves the write queued, neither handed out nor refused", async () => {
      seedFundedJob("job-lookup");
      const scope = await jobScope("agent-e", "job-lookup");
      const id = await admit("agent-e", scope);
      const spy = vi.spyOn(getRepos().escrows, "findByCwm").mockImplementation(() => {
        throw new Error("store unavailable");
      });
      try {
        expect((await poll()).count).toBe(0);
        expect(row(id).status).toBe("pending");
      } finally {
        spy.mockRestore();
      }
      expect((await poll()).calls.map((c: { id: string }) => c.id)).toEqual([id]);
    });
  });
});

// Astra r2 finding 3 noted that object-owner routes do not require an ACTIVE
// scope. That is the policy: a scope's creator keeps its own records (its
// calls' results, the scope and its audit) and may still revoke it after the
// scope ends. Nothing that commands or observes the device stays open to it.
describe("N4b-gw: a scope's creator keeps its own records after the scope ends", () => {
  it("reads its call's result, the scope and its audit, and may revoke; it can't queue, watch or chat", async () => {
    const scope = await mintScope("agent-past", ["run_create"]);
    const who = asKey("agent-past");
    const call = await app.inject({
      method: "POST", url: "/api/relay/kernel-test-1/tool-call", headers: who, payload: { scopeId: scope, toolName: "run_create" },
    });
    expect(call.statusCode).toBe(201);
    getStore().db.update(executionScopes)
      .set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(executionScopes.id, scope))
      .run();

    const get = (url: string) => app.inject({ method: "GET", url, headers: who });
    expect((await get(`/api/relay/kernel-test-1/tool-result/${call.json().id}`)).statusCode).toBe(200);
    expect((await get(`/api/relay/kernel-test-1/scope/${scope}`)).statusCode).toBe(200);
    expect((await get(`/api/relay/kernel-test-1/scope/${scope}/audit`)).statusCode).toBe(200);

    const queued = await app.inject({
      method: "POST", url: "/api/relay/kernel-test-1/tool-call", headers: who, payload: { scopeId: scope, toolName: "health" },
    });
    expect(queued.statusCode).toBe(403);
    expect((await get("/api/relay/kernel-test-1/camera/snapshot")).statusCode).toBe(403);
    expect((await get("/api/relay/kernel-test-1/chat/messages")).statusCode).toBe(403);

    const revoke = await app.inject({ method: "POST", url: `/api/relay/kernel-test-1/scope/${scope}/revoke`, headers: who });
    expect(revoke.statusCode).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// N4b-gw round 4 (gpt-5.6-sol r3 on 620f888d): the dispatch site is a true
// USE-TIME safety boundary. It re-checks live scope authority for scoped safe
// calls (F2), a row-derived command budget (F3), and the physical-safety
// governor/breaker and emergency stop (F1) before any queued call is claimed.
// ═══════════════════════════════════════════════════════════════════════════
describe("N4b-gw r4: dispatch re-checks safety, e-stop, live scope and budget", () => {
  const poll = async () =>
    (await app.inject({ method: "GET", url: "/api/relay/kernel-test-1/tool-call/pending", headers: op })).json();
  const rowOf = (id: string) =>
    getStore().db.select().from(toolCallRelay).where(eq(toolCallRelay.id, id)).get()!;
  function seedCall(id: string, toolName: string, scopeId: string | null, status = "pending") {
    getStore().db.insert(toolCallRelay).values({
      id, scopeId, kernelId: "kernel-test-1", toolName, toolArgs: {}, status,
      createdAt: new Date().toISOString(),
    }).run();
  }
  const setScope = (id: string, fields: Partial<typeof executionScopes.$inferInsert>) =>
    getStore().db.update(executionScopes).set(fields).where(eq(executionScopes.id, id)).run();

  afterEach(() => {
    getSafetyGateway().resetCircuit("kernel-test-1");
    getStore().db.run(sql`DELETE FROM operator_policies`);
  });

  it("F2: a scoped SAFE call does not dispatch after its scope expires", async () => {
    const scope = await mintScope("agent-q", ["run_create"]);
    seedCall("tc-safe-scoped", "home", scope); // home is safe, but submitted under a scope
    setScope(scope, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await poll()).count).toBe(0);
    expect(rowOf("tc-safe-scoped")).toMatchObject({ status: "rejected", error: "scope_expired" });
  });

  it("F2 control: the operator's scope-free safe call still dispatches", async () => {
    seedCall("tc-safe-free", "home", null);
    const body = await poll();
    expect(body.calls.map((c: { id: string }) => c.id)).toContain("tc-safe-free");
    expect(rowOf("tc-safe-free").status).toBe("claimed");
  });

  it("F3: a legacy row cannot exceed maxCommands (budget re-derived from rows)", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/relay/kernel-test-1/scope", headers: op,
      payload: { createdBy: "agent-q", allowedTools: ["run_create"], maxCommands: 1 },
    });
    const scope = res.json().id as string;
    seedCall("tc-counted", "run_create", scope, "claimed"); // one non-safe call already dispatched
    seedCall("tc-legacy", "run_create", scope, "pending");  // an uncounted legacy row
    expect((await poll()).count).toBe(0);
    expect(rowOf("tc-legacy")).toMatchObject({ status: "rejected", error: "max_commands_reached" });
  });

  it("F1: an open circuit breaker blocks dispatch of an admitted call", async () => {
    const scope = await mintScope("agent-q", ["run_create"]);
    seedCall("tc-breaker", "run_create", scope);
    const gw = getSafetyGateway();
    gw.resetCircuit("kernel-test-1");
    gw.recordDeviceFailure("kernel-test-1");
    gw.recordDeviceFailure("kernel-test-1");
    gw.recordDeviceFailure("kernel-test-1"); // threshold 3 -> OPEN
    expect((await poll()).count).toBe(0);
    expect(rowOf("tc-breaker").status).toBe("rejected");
  });

  it("F1: an engaged emergency stop blocks dispatch", async () => {
    const scope = await mintScope("agent-q", ["run_create"]);
    seedCall("tc-estop", "run_create", scope);
    getStore().db.insert(schema.operatorPolicies).values({
      kernelId: "kernel-test-1",
      policy: { emergencyStop: true } as never,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    }).run();
    expect((await poll()).count).toBe(0);
    expect(rowOf("tc-estop")).toMatchObject({ status: "rejected", error: "emergency_stopped" });
  });

  it("F2: two concurrent polls never both claim the same row (atomic compare-and-set)", async () => {
    const scope = await mintScope("agent-q", ["run_create"]);
    seedCall("tc-race", "run_create", scope);
    // Delay validateOnly so both polls clear safety and race to claim.
    const spy = vi.spyOn(getSafetyGateway(), "validateOnly").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { allowed: true, executed: false } as never;
    });
    try {
      const [a, b] = await Promise.all([poll(), poll()]);
      const returned = [...a.calls, ...b.calls]
        .map((c: { id: string }) => c.id)
        .filter((id) => id === "tc-race");
      expect(returned).toEqual(["tc-race"]); // exactly one poll got it, not both
      expect(rowOf("tc-race").status).toBe("claimed");
    } finally {
      spy.mockRestore();
    }
  });

  it("F3: an open breaker stores the stable reason circuit_open", async () => {
    const scope = await mintScope("agent-q", ["run_create"]);
    seedCall("tc-reason", "run_create", scope);
    const gw = getSafetyGateway();
    gw.resetCircuit("kernel-test-1");
    gw.recordDeviceFailure("kernel-test-1");
    gw.recordDeviceFailure("kernel-test-1");
    gw.recordDeviceFailure("kernel-test-1");
    expect((await poll()).count).toBe(0);
    expect(rowOf("tc-reason").error).toBe("circuit_open");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// N4b-gw round 6 (P0, physical safety): the kernel's emergency stop reaches the
// relay. Until now only the pending poll looked at the stop, row by row and
// fail-open (`=== true`: a thrown read became a 500, and a policy that was not
// an object read as "not stopped"), so a call submitted, or a scope minted,
// around a stop kept working for up to an hour. The stop is now read fail-closed
// as stopped / clear / unavailable on submit, on the pending poll and on scope
// mint, and the stop route itself rejects the calls still queued so that a
// resume cannot restart them (a reset must not restart motion, ISO 13850).
// ═══════════════════════════════════════════════════════════════════════════
describe("N4b-gw r6: the emergency stop reaches the relay", () => {
  const KERNEL = "kernel-test-1";
  const OTHER_KERNEL = "kernel-test-2";
  const HOLDER = "agent-r6";

  const submit = (payload: Record<string, unknown>, headers: Record<string, string> = op) =>
    app.inject({ method: "POST", url: `/api/relay/${KERNEL}/tool-call`, headers, payload });
  const poll = () =>
    app.inject({ method: "GET", url: `/api/relay/${KERNEL}/tool-call/pending`, headers: op });
  const mint = (payload: Record<string, unknown> = { createdBy: HOLDER, allowedTools: ["run_create"] }) =>
    app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope`, headers: op, payload });
  const stopRoute = (path: "emergency-stop" | "emergency-resume") =>
    app.inject({ method: "POST", url: `/api/operator/${path}`, payload: { kernelId: KERNEL, reason: "r6 test" } });

  const relayRows = () => getStore().db.select().from(toolCallRelay).all();
  const scopeRows = () => getStore().db.select().from(executionScopes).all();
  const rowOf = (id: string) =>
    getStore().db.select().from(toolCallRelay).where(eq(toolCallRelay.id, id)).get()!;
  const idsOf = (res: { json: () => { calls: Array<{ id: string }> } }) => res.json().calls.map((c) => c.id);

  let seq = 0;
  /** Insert a relay row directly. createdAt ascends, so the poll order is fixed. */
  function seedCall(
    id: string,
    opts: {
      status?: string;
      kernelId?: string;
      claimedAt?: string | null;
      toolName?: string;
      scopeId?: string | null;
    } = {},
  ) {
    getStore().db.insert(toolCallRelay).values({
      id,
      scopeId: opts.scopeId ?? null,
      kernelId: opts.kernelId ?? KERNEL,
      toolName: opts.toolName ?? "home",
      toolArgs: {},
      status: opts.status ?? "pending",
      claimedAt: opts.claimedAt ?? null,
      createdAt: new Date(Date.now() - 60_000 + seq++ * 1000).toISOString(),
    }).run();
  }

  /**
   * Write the kernel's policy row as raw TEXT, bypassing drizzle's JSON mapping,
   * so a test can store what a hand edit, a bad migration or an old writer could
   * leave behind: text that is not JSON, or JSON that is not an object.
   */
  function setPolicyText(text: string, kernelId = KERNEL) {
    getStore().db.run(sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
      VALUES (${kernelId}, ${text}, ${new Date().toISOString()}, ${"test"})`);
  }
  const setPolicy = (policy: unknown, kernelId = KERNEL) => setPolicyText(JSON.stringify(policy), kernelId);
  const engageStop = () => setPolicy({ version: 1, emergencyStop: true });

  /**
   * A slow safety governor: `during(n)` runs on its nth consultation, while the
   * request under test is awaiting it, which is where a concurrent stop lands.
   */
  function governorThatRuns(during: (n: number) => void) {
    let n = 0;
    return vi.spyOn(getSafetyGateway(), "validateOnly").mockImplementation(async () => {
      during(++n);
      return { allowed: true, executed: false } as never;
    });
  }

  beforeEach(() => {
    seq = 0;
  });

  afterEach(() => {
    getSafetyGateway().resetCircuit(KERNEL);
    getStore().db.run(sql`DELETE FROM operator_policies`);
  });

  // ── submit ────────────────────────────────────────────────────────────────
  describe("submit: POST /tool-call", () => {
    it("while stopped answers 409 kernel_emergency_stopped and queues nothing", async () => {
      engageStop();
      const res = await submit({ toolName: "health" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "kernel_emergency_stopped" });
      expect(relayRows()).toHaveLength(0);
    });

    it("while stopped refuses a scoped write before it spends the scope's budget", async () => {
      const scopeId = await mintScope(HOLDER, ["run_create"]);
      engageStop();
      const res = await submit({ scopeId, toolName: "run_create", args: {} }, asKey(HOLDER));
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("kernel_emergency_stopped");
      expect(relayRows()).toHaveLength(0);
      expect(scopeRows()[0].commandCount).toBe(0);
    });

    it("answers 401, 403 and 400 ahead of the stop: authentication, authorization and validation come first", async () => {
      await mintScope(HOLDER, ["run_create"]);
      engageStop();
      const unauthenticated = await app.inject({
        method: "POST",
        url: `/api/relay/${KERNEL}/tool-call`,
        payload: { toolName: "health" },
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect((await submit({ toolName: "health" }, asKey("mallory"))).statusCode).toBe(403);
      expect((await submit({})).statusCode).toBe(400);
      // A holder that names no scope is refused for that, not told about the stop.
      const noScope = await submit({ toolName: "run_create" }, asKey(HOLDER));
      expect(noScope.statusCode).toBe(403);
      expect(noScope.json().error).toBe("scope_required");
      expect(relayRows()).toHaveLength(0);
    });

    it("a stop that lands while the safety governor is consulted still refuses the call (the read and the insert are one synchronous section)", async () => {
      const spy = governorThatRuns(() => engageStop());
      try {
        const res = await submit({ toolName: "health" });
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("kernel_emergency_stopped");
        expect(relayRows()).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it("a policy that turns unreadable while the safety governor is consulted refuses the call 503", async () => {
      const spy = governorThatRuns(() => setPolicyText("{not json"));
      try {
        const res = await submit({ toolName: "health" });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: "policy_unavailable" });
        expect(relayRows()).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it("control: with no policy row for the kernel, submit queues the call and pending dispatches it", async () => {
      const queued = await submit({ toolName: "health" });
      expect(queued.statusCode).toBe(201);
      expect(rowOf(queued.json().id).status).toBe("pending");

      const res = await poll();
      expect(res.statusCode).toBe(200);
      expect(idsOf(res)).toEqual([queued.json().id]);
      expect(res.json().emergencyStop).toBeUndefined();
    });

    it.each([
      ["false", false],
      ["0", 0],
      ["null", null],
      ['""', ""],
    ])("control: emergencyStop %s is not a stop", async (_label, value) => {
      setPolicy({ version: 1, emergencyStop: value });
      expect((await submit({ toolName: "health" })).statusCode).toBe(201);
    });

    it("control: a policy without an emergencyStop key is not a stop", async () => {
      setPolicy({ version: 1 });
      expect((await submit({ toolName: "health" })).statusCode).toBe(201);
    });
  });

  // ── pending ───────────────────────────────────────────────────────────────
  describe("pending: GET /tool-call/pending", () => {
    it("while stopped withholds: 200 with calls [] and emergencyStop true, and the calls queued before the stop end rejected", async () => {
      const safe = (await submit({ toolName: "health" })).json().id as string;
      const scopeId = await mintScope(HOLDER, ["run_create"]);
      const scoped = (await submit({ scopeId, toolName: "run_create", args: {} }, asKey(HOLDER))).json().id as string;
      engageStop();

      const res = await poll();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ calls: [], count: 0, emergencyStop: true });
      for (const id of [safe, scoped]) {
        expect(rowOf(id)).toMatchObject({ status: "rejected", error: "emergency_stopped", claimedAt: null });
        expect(rowOf(id).completedAt).toEqual(expect.any(String));
      }
    });

    it("while stopped rejects only this kernel's pending rows: a claimed row and another kernel's row are untouched", async () => {
      seedCall("tc-pending");
      seedCall("tc-claimed", { status: "claimed", claimedAt: new Date().toISOString() });
      seedCall("tc-elsewhere", { kernelId: OTHER_KERNEL });
      engageStop();

      expect((await poll()).json().emergencyStop).toBe(true);
      expect(rowOf("tc-pending").status).toBe("rejected");
      expect(rowOf("tc-claimed").status).toBe("claimed");
      expect(rowOf("tc-elsewhere").status).toBe("pending");
    });

    it("a stop that lands while the poll awaits the safety governor rejects the row being checked instead of claiming it", async () => {
      seedCall("tc-a");
      const spy = governorThatRuns(() => engageStop());
      try {
        const res = await poll();
        expect(res.statusCode).toBe(200);
        expect(res.json().calls).toEqual([]);
        expect(rowOf("tc-a")).toMatchObject({ status: "rejected", error: "emergency_stopped" });
      } finally {
        spy.mockRestore();
      }
    });

    it("a stop that lands mid-poll rejects that row and every row behind it; a row claimed before the stop is returned", async () => {
      seedCall("tc-1");
      seedCall("tc-2");
      seedCall("tc-3");
      const spy = governorThatRuns((n) => {
        if (n === 2) engageStop();
      });
      try {
        const res = await poll();
        expect(res.statusCode).toBe(200);
        expect(idsOf(res)).toEqual(["tc-1"]);
        expect(rowOf("tc-1").status).toBe("claimed");
        expect(rowOf("tc-2")).toMatchObject({ status: "rejected", error: "emergency_stopped" });
        expect(rowOf("tc-3")).toMatchObject({ status: "rejected", error: "emergency_stopped" });
      } finally {
        spy.mockRestore();
      }
    });

    it("a policy that turns unreadable mid-poll leaves that row and every later row queued, even if it reads again; a row claimed before it is returned", async () => {
      seedCall("tc-1");
      seedCall("tc-2");
      seedCall("tc-3");
      const spy = governorThatRuns((n) => {
        if (n === 2) setPolicyText("{not json");
        // Were the poll to go on past tc-2, the policy reads clear again here.
        if (n === 3) getStore().db.run(sql`DELETE FROM operator_policies`);
      });
      try {
        const res = await poll();
        expect(res.statusCode).toBe(200);
        expect(idsOf(res)).toEqual(["tc-1"]);
        expect(rowOf("tc-1").status).toBe("claimed");
        for (const id of ["tc-2", "tc-3"]) {
          expect(rowOf(id)).toMatchObject({ status: "pending", error: null, claimedAt: null, completedAt: null });
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── F1: the use-time checks share one synchronous section with the claim ──
  describe("pending: what changes while the governor is held is re-checked before the claim (F1)", () => {
    const setScope = (id: string, fields: Partial<typeof executionScopes.$inferInsert>) =>
      getStore().db.update(executionScopes).set(fields).where(eq(executionScopes.id, id)).run();
    // An async wrapper starts the request at once; a bare app.inject() chain does not.
    const startPoll = async () =>
      await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/tool-call/pending`, headers: op });

    /**
     * Start a poll and hold it at the safety governor, run `change`, then release
     * an ALLOWED verdict. This is the window between the governor's answer and
     * the claim: whatever `change` altered must be re-read before the row is
     * claimed, or a command the world no longer allows is handed to the device.
     */
    async function pollWhileGovernorIsHeld(change: () => void | Promise<unknown>) {
      let reached!: () => void;
      const consulted = new Promise<void>((resolve) => (reached = resolve));
      let release!: (verdict: unknown) => void;
      const verdict = new Promise<unknown>((resolve) => (release = resolve));
      const spy = vi.spyOn(getSafetyGateway(), "validateOnly").mockImplementation(async () => {
        reached();
        return (await verdict) as never;
      });
      try {
        const polling = startPoll();
        await Promise.race([
          consulted,
          new Promise((_, reject) => setTimeout(() => reject(new Error("the poll never reached the governor")), 2000)),
        ]);
        await change();
        release({ allowed: true, executed: false });
        return await polling;
      } finally {
        spy.mockRestore();
      }
    }

    it("control: with nothing changed while the governor is held, the call is claimed and returned", async () => {
      seedCall("tc-a");
      const res = await pollWhileGovernorIsHeld(() => {});
      expect(idsOf(res)).toEqual(["tc-a"]);
      expect(rowOf("tc-a").status).toBe("claimed");
    });

    it("an emergency stop that lands while the governor is held is seen before the claim", async () => {
      seedCall("tc-a");
      const res = await pollWhileGovernorIsHeld(engageStop);
      expect(res.statusCode).toBe(200);
      expect(res.json().calls).toEqual([]);
      expect(rowOf("tc-a")).toMatchObject({ status: "rejected", error: "emergency_stopped", claimedAt: null });
    });

    it("a scope that expires while the governor is held does not dispatch its call", async () => {
      const scopeId = await mintScope(HOLDER, ["run_create"]);
      seedCall("tc-a", { toolName: "run_create", scopeId });
      const res = await pollWhileGovernorIsHeld(() =>
        setScope(scopeId, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
      );
      expect(res.json().calls).toEqual([]);
      expect(rowOf("tc-a")).toMatchObject({ status: "rejected", error: "scope_expired", claimedAt: null });
    });

    it("a scope whose status is revoked while the governor is held does not dispatch its call", async () => {
      const scopeId = await mintScope(HOLDER, ["run_create"]);
      seedCall("tc-a", { toolName: "run_create", scopeId });
      const res = await pollWhileGovernorIsHeld(() => setScope(scopeId, { status: "revoked" }));
      expect(res.json().calls).toEqual([]);
      expect(rowOf("tc-a")).toMatchObject({ status: "rejected", error: "scope_not_active", claimedAt: null });
    });

    it("control: a scope revoked through the route while the governor is held keeps the route's own rejection", async () => {
      const scopeId = await mintScope(HOLDER, ["run_create"]);
      seedCall("tc-a", { toolName: "run_create", scopeId });
      const res = await pollWhileGovernorIsHeld(async () => {
        const revoke = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope/${scopeId}/revoke`, headers: op });
        expect(revoke.statusCode).toBe(200);
      });
      expect(res.json().calls).toEqual([]);
      expect(rowOf("tc-a")).toMatchObject({ status: "rejected", error: "scope_revoked", claimedAt: null });
    });

    it("a circuit breaker that opens while the governor is held does not dispatch its call", async () => {
      seedCall("tc-a");
      const gateway = getSafetyGateway();
      gateway.resetCircuit(KERNEL);
      const res = await pollWhileGovernorIsHeld(() => {
        for (let failure = 0; failure < 3; failure++) gateway.recordDeviceFailure(KERNEL); // threshold 3 -> open
      });
      expect(res.json().calls).toEqual([]);
      expect(rowOf("tc-a")).toMatchObject({ status: "rejected", error: "circuit_open", claimedAt: null });
    });

    it("a command budget used up while the governor is held rejects the call", async () => {
      const scope = await mint({ createdBy: HOLDER, allowedTools: ["run_create"], maxCommands: 1 });
      const scopeId = scope.json().id as string;
      seedCall("tc-a", { toolName: "run_create", scopeId });
      const res = await pollWhileGovernorIsHeld(() =>
        // Another poll claimed this scope's only command while ours was held.
        seedCall("tc-taken", { toolName: "run_create", scopeId, status: "claimed", claimedAt: new Date().toISOString() }),
      );
      expect(res.json().calls).toEqual([]);
      expect(rowOf("tc-a")).toMatchObject({ status: "rejected", error: "max_commands_reached", claimedAt: null });
    });

    it("control: a breaker whose cooldown elapsed lets its test command through (half-open is not open)", async () => {
      seedCall("tc-a");
      const gateway = getSafetyGateway();
      gateway.resetCircuit(KERNEL);
      for (let failure = 0; failure < 3; failure++) gateway.recordDeviceFailure(KERNEL);
      // The cooldown is 60 s. Only the breaker's clock reads Date.now() here.
      const realNow = Date.now.bind(Date);
      const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 61_000);
      try {
        const res = await poll();
        expect(idsOf(res)).toEqual(["tc-a"]);
        expect(rowOf("tc-a").status).toBe("claimed");
      } finally {
        clock.mockRestore();
      }
    });
  });

  // ── F2: at-most-once, a claim nobody reported fails and is never redelivered ─
  describe("claim timeout: a claim nobody reported is closed, never redelivered (F2)", () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const report = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `/api/relay/${KERNEL}/tool-result`, headers: op, payload });

    it("control: a claim still inside the timeout is left alone", async () => {
      seedCall("tc-fresh", { status: "claimed", claimedAt: ago(60_000) });
      const res = await poll();
      expect(res.json().calls).toEqual([]);
      expect(rowOf("tc-fresh")).toMatchObject({ status: "claimed", error: null, completedAt: null });
    });

    it("serves the queue behind a timed-out claim without handing the timed-out call out again", async () => {
      seedCall("tc-stale", { status: "claimed", claimedAt: ago(130_000) });
      seedCall("tc-next");
      const res = await poll();
      expect(idsOf(res)).toEqual(["tc-next"]);
      expect(rowOf("tc-stale")).toMatchObject({ status: "failed", error: "claim_timeout" });
      expect(rowOf("tc-next").status).toBe("claimed");
    });

    it("a timed-out call keeps counting against the scope's command budget", async () => {
      const scope = await mint({ createdBy: HOLDER, allowedTools: ["run_create"], maxCommands: 1 });
      const scopeId = scope.json().id as string;
      seedCall("tc-ran", { toolName: "run_create", scopeId, status: "claimed", claimedAt: ago(130_000) });
      seedCall("tc-again", { toolName: "run_create", scopeId });

      const res = await poll();
      expect(res.json().calls).toEqual([]);
      expect(rowOf("tc-ran")).toMatchObject({ status: "failed", error: "claim_timeout" });
      expect(rowOf("tc-again")).toMatchObject({ status: "rejected", error: "max_commands_reached" });
    });

    it("a claim that timed out during an emergency stop is not redelivered after the resume", async () => {
      seedCall("tc-stale", { status: "claimed", claimedAt: ago(130_000) });
      engageStop();
      expect((await poll()).json().emergencyStop).toBe(true);

      getStore().db.run(sql`DELETE FROM operator_policies`); // the resume
      const res = await poll();
      expect(res.json().calls).toEqual([]);
      expect(rowOf("tc-stale")).toMatchObject({ status: "failed", error: "claim_timeout" });
    });

    describe("a late report for a timed-out call", () => {
      it("records the outcome once and never returns the call to the queue", async () => {
        seedCall("tc-late", { status: "claimed", claimedAt: ago(130_000) });
        await poll(); // closes the claim
        expect(rowOf("tc-late")).toMatchObject({ status: "failed", error: "claim_timeout" });

        const success = vi.spyOn(getSafetyGateway(), "recordDeviceSuccess");
        try {
          const res = await report({ callId: "tc-late", result: { ok: true } });
          expect(res.statusCode).toBe(200);
          expect(res.json()).toMatchObject({ callId: "tc-late", status: "completed" });
          expect(rowOf("tc-late")).toMatchObject({
            status: "completed",
            error: null,
            result: JSON.stringify({ ok: true }),
          });
          expect(success).toHaveBeenCalledTimes(1);
          expect(success).toHaveBeenCalledWith(KERNEL);

          // A replay is an idempotent ack: the breaker hears nothing more.
          const replay = await report({ callId: "tc-late", result: { ok: true } });
          expect(replay.json()).toMatchObject({ status: "completed", idempotent: true });
          expect(success).toHaveBeenCalledTimes(1);

          // The call never went back to the queue.
          expect((await poll()).json().calls).toEqual([]);
          expect(rowOf("tc-late").status).toBe("completed");
        } finally {
          success.mockRestore();
        }
      });

      it("records a late failure once: the breaker hears it and the scope's retry budget is charged", async () => {
        const scopeId = await mintScope(HOLDER, ["run_create"]);
        seedCall("tc-late", { toolName: "run_create", scopeId, status: "claimed", claimedAt: ago(130_000) });
        await poll(); // closes the claim
        expect(rowOf("tc-late")).toMatchObject({ status: "failed", error: "claim_timeout" });

        const failure = vi.spyOn(getSafetyGateway(), "recordDeviceFailure");
        try {
          const res = await report({ callId: "tc-late", error: "device_unreachable" });
          expect(res.json()).toMatchObject({ callId: "tc-late", status: "failed" });
          expect(rowOf("tc-late")).toMatchObject({ status: "failed", error: "device_unreachable" });
          expect(failure).toHaveBeenCalledTimes(1);
          const scope = getStore().db.select().from(executionScopes).where(eq(executionScopes.id, scopeId)).get()!;
          expect(scope.retryCount).toBe(1);

          const replay = await report({ callId: "tc-late", error: "device_unreachable" });
          expect(replay.json().idempotent).toBe(true);
          expect(failure).toHaveBeenCalledTimes(1);
          expect(rowOf("tc-late").status).toBe("failed");
        } finally {
          failure.mockRestore();
        }
      });

      it("a report that only echoes the timeout says nothing new and changes nothing", async () => {
        seedCall("tc-late", { status: "claimed", claimedAt: ago(130_000) });
        await poll(); // closes the claim

        const failure = vi.spyOn(getSafetyGateway(), "recordDeviceFailure");
        try {
          const res = await report({ callId: "tc-late", error: "claim_timeout" });
          expect(res.statusCode).toBe(200);
          expect(res.json()).toMatchObject({ status: "failed", idempotent: true });
          expect(rowOf("tc-late")).toMatchObject({ status: "failed", error: "claim_timeout" });
          expect(failure).not.toHaveBeenCalled();
        } finally {
          failure.mockRestore();
        }
      });
    });
  });

  // ── scope mint ────────────────────────────────────────────────────────────
  describe("scope mint: POST /scope", () => {
    it("while stopped answers 409 kernel_emergency_stopped and writes no scope row", async () => {
      engageStop();
      const res = await mint();
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "kernel_emergency_stopped" });
      expect(scopeRows()).toHaveLength(0);
    });

    it("answers a bad body 400 ahead of the stop state", async () => {
      engageStop();
      expect((await mint({})).statusCode).toBe(400);
      expect((await mint({ createdBy: HOLDER, allowedTools: [] })).statusCode).toBe(400);
      expect(scopeRows()).toHaveLength(0);
    });

    it("control: with no policy row for the kernel, a scope is minted", async () => {
      const res = await mint();
      expect(res.statusCode).toBe(201);
      expect(scopeRows()).toHaveLength(1);
    });

    it("does not block the safety and reporting routes: revoke, scope reads, audit, tool results and the camera still answer", async () => {
      const scopeId = await mintScope(HOLDER, ["run_create"]);
      seedCall("tc-inflight", { status: "claimed", claimedAt: new Date().toISOString() });
      engageStop();

      const revoke = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope/${scopeId}/revoke`, headers: op });
      expect(revoke.statusCode).toBe(200);
      expect(revoke.json().status).toBe("revoked");

      const read = await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/scope/${scopeId}`, headers: op });
      expect(read.statusCode).toBe(200);
      const audit = await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/scope/${scopeId}/audit`, headers: op });
      expect(audit.statusCode).toBe(200);

      // The device still reports what an in-flight call did.
      const result = await app.inject({
        method: "POST",
        url: `/api/relay/${KERNEL}/tool-result`,
        headers: op,
        payload: { callId: "tc-inflight", result: { ok: true } },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().status).toBe("completed");

      // No frame was ever pushed, so the camera answers 404: not 409 or 503.
      const camera = await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/camera/snapshot`, headers: op });
      expect(camera.statusCode).toBe(404);
    });
  });

  // ── fail closed: a truthy stop that is not the boolean true ───────────────
  describe.each([
    ["1", 1],
    ['"yes"', "yes"],
    ['"false" (a non-empty string)', "false"],
    ["{}", {}],
    ["[1]", [1]],
  ])("emergencyStop is %s: truthy, so the stop is engaged", (_label, value) => {
    beforeEach(() => setPolicy({ version: 1, emergencyStop: value }));

    it("submit answers 409", async () => {
      const res = await submit({ toolName: "health" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("kernel_emergency_stopped");
      expect(relayRows()).toHaveLength(0);
    });

    it("pending withholds and rejects the queued call", async () => {
      seedCall("tc-q");
      const res = await poll();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ calls: [], count: 0, emergencyStop: true });
      expect(rowOf("tc-q")).toMatchObject({ status: "rejected", error: "emergency_stopped" });
    });

    it("scope mint answers 409", async () => {
      expect((await mint()).statusCode).toBe(409);
      expect(scopeRows()).toHaveLength(0);
    });
  });

  // ── fail closed: a policy row that cannot be read as an object ────────────
  describe.each([
    ["a JSON array", "[]"],
    ["an array that mentions a stop", '[{"emergencyStop":true}]'],
    ["a JSON string", '"emergency"'],
    ["a JSON number", "1"],
    ["a JSON boolean", "true"],
    ["JSON null", "null"],
    ["text that is not JSON", "{not json"],
    ["truncated JSON", '{"emergencyStop":tr'],
    ["an empty string", ""],
  ])("a policy row that is %s is unavailable, so the relay fails closed", (_label, text) => {
    beforeEach(() => setPolicyText(text));

    it("submit answers 503 policy_unavailable and queues nothing", async () => {
      const res = await submit({ toolName: "health" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "policy_unavailable" });
      expect(relayRows()).toHaveLength(0);
    });

    it("pending answers 503 policy_unavailable, claims nothing and leaves every row as it was", async () => {
      seedCall("tc-q1");
      seedCall("tc-q2", { toolName: "health" });
      // A claim well past the 120 s timeout: reclaiming it would be a write.
      const stale = new Date(Date.now() - 10 * 60_000).toISOString();
      seedCall("tc-stale", { status: "claimed", claimedAt: stale });

      const res = await poll();
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "policy_unavailable" });
      for (const id of ["tc-q1", "tc-q2"]) {
        expect(rowOf(id)).toMatchObject({ status: "pending", error: null, claimedAt: null, completedAt: null });
      }
      expect(rowOf("tc-stale")).toMatchObject({ status: "claimed", claimedAt: stale });
    });

    it("scope mint answers 503 policy_unavailable and writes no scope row", async () => {
      const res = await mint();
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "policy_unavailable" });
      expect(scopeRows()).toHaveLength(0);
    });
  });

  // ── the stop route, and a resume ──────────────────────────────────────────
  describe("the stop route and a resume", () => {
    it("rejects the calls still queued, so a resume cannot restart them even though the node never polled during the stop", async () => {
      const queuedSafe = (await submit({ toolName: "health" })).json().id as string;
      const scopeId = await mintScope(HOLDER, ["run_create"]);
      const queuedScoped = (await submit({ scopeId, toolName: "run_create", args: {} }, asKey(HOLDER))).json().id as string;
      seedCall("tc-inflight", { status: "claimed", claimedAt: new Date().toISOString() });
      seedCall("tc-elsewhere", { kernelId: OTHER_KERNEL });

      const stop = await stopRoute("emergency-stop");
      expect(stop.statusCode).toBe(200);
      expect(stop.json()).toMatchObject({ stopped: true, kernelId: KERNEL });

      // Rejected by the stop itself, before any poll.
      for (const id of [queuedSafe, queuedScoped]) {
        expect(rowOf(id)).toMatchObject({ status: "rejected", error: "emergency_stopped", claimedAt: null });
        expect(rowOf(id).completedAt).toEqual(expect.any(String));
      }
      // The node already holds the claimed call, and another kernel's queue is not this stop's.
      expect(rowOf("tc-inflight").status).toBe("claimed");
      expect(rowOf("tc-elsewhere").status).toBe("pending");

      expect((await stopRoute("emergency-resume")).statusCode).toBe(200);

      // The node's first poll comes after the resume: nothing queued before the stop is dispatched.
      const afterResume = await poll();
      expect(afterResume.statusCode).toBe(200);
      expect(afterResume.json().calls).toEqual([]);
      expect(afterResume.json().emergencyStop).toBeUndefined();
      for (const id of [queuedSafe, queuedScoped]) {
        expect(rowOf(id)).toMatchObject({ status: "rejected", error: "emergency_stopped", claimedAt: null });
      }
    });

    it("refuses submit and mint while stopped, and after the resume a new call and the scope minted before the stop work again", async () => {
      const scopeId = await mintScope(HOLDER, ["run_create"]);
      expect((await stopRoute("emergency-stop")).statusCode).toBe(200);
      expect((await submit({ scopeId, toolName: "run_create", args: {} }, asKey(HOLDER))).statusCode).toBe(409);
      expect((await mint()).statusCode).toBe(409);
      expect(relayRows()).toHaveLength(0);

      expect((await stopRoute("emergency-resume")).statusCode).toBe(200);

      const scoped = await submit({ scopeId, toolName: "run_create", args: {} }, asKey(HOLDER));
      expect(scoped.statusCode).toBe(201);
      expect((await mint()).statusCode).toBe(201);
      expect(idsOf(await poll())).toEqual([scoped.json().id]);
    });
  });
});
