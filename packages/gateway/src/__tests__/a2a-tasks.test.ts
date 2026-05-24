/**
 * Tests for the A2A v1.0 JSON-RPC adapter at POST /a2a/tasks/send.
 *
 * Coverage:
 *   - Malformed JSON-RPC envelope → -32600 (with id=null)
 *   - Missing auth (when enabled) → -32600
 *   - Unknown method → -32601
 *   - Unknown skill → -32602
 *   - tasks/send pcc-discover → COMPLETED with capability_list artifact
 *   - tasks/send pcc-quote → INPUT_REQUIRED with quote artifact + session linkage
 *   - tasks/send pcc-submit → COMPLETED end-to-end
 *   - tasks/get for unknown task id → -32001
 *   - tasks/get reflects live session state
 *   - tasks/cancel transitions task to CANCELED
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema } from "@pcc/store";

const { shopKernels, capabilities } = schema;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_A2A_AUTH_DISABLED = "true"; // Default: auth-off so most tests can run
  initStore({ seed: true });

  // Always have at least one online kernel for pcc-quote
  const { db } = getStore();
  const now = new Date().toISOString();
  try {
    db.insert(shopKernels).values({
      id: "kernel-a2a-test",
      name: "A2A Test Kernel",
      operatorAddress: "0xa2a",
      location: { lat: 0, lng: 0 },
      physicalAddress: "test",
      maxAssuranceTier: 2,
      publicKey: "a2a-key",
      reputation: 0,
      totalJobsCompleted: 0,
      status: "online",
      registeredAt: now,
      lastHeartbeat: now,
      version: "1.0.0",
    } as any).run();
    db.insert(capabilities).values({
      id: "cap-a2a-test",
      kernelId: "kernel-a2a-test",
      type: "fdm",
      name: "Test FDM",
      description: "A2A test FDM",
      materials: ["PLA"],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
      location: { lat: 0, lng: 0 },
      queueDepth: 0,
      availability: { timezone: "UTC", windows: {} },
    } as any).run();
  } catch {
    // Seeded already
  }

  const app = Fastify({ logger: false });
  await app.register(a2aTasksRoutes);
  await app.ready();
  return app;
}

function rpcRequest(id: string | number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

describe("POST /a2a/tasks/send (A2A v1.0 JSON-RPC adapter)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    delete process.env.PCC_A2A_AUTH_DISABLED;
  });

  beforeEach(() => {
    __resetA2ATasksForTest();
  });

  // ── Wire envelope errors ────────────────────────────────────────────────

  it("returns -32600 for malformed envelope (not a JSON-RPC 2.0 request)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({ foo: "bar" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error.code).toBe(-32600);
    expect(body.id).toBeNull();
  });

  it("returns -32601 for unknown method", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: rpcRequest("rpc-1", "tasks/bogus", {}),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error.code).toBe(-32601);
    expect(body.id).toBe("rpc-1");
  });

  it("returns -32602 for tasks/send with unknown skill", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: rpcRequest("rpc-2", "tasks/send", { skill: "pcc-unknown" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error.code).toBe(-32602);
  });

  it("returns -32602 for tasks/send without a skill param", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: rpcRequest("rpc-3", "tasks/send", {}),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error.code).toBe(-32602);
  });

  // ── pcc-discover ───────────────────────────────────────────────────────

  it("tasks/send pcc-discover → COMPLETED with capability_list artifact", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: rpcRequest("rpc-4", "tasks/send", {
        skill: "pcc-discover",
        params: { capabilityType: "fdm" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBeDefined();
    expect(body.result.state).toBe("COMPLETED");
    expect(body.result.artifacts[0].type).toBe("pcc.capability_list");
  });

  // ── pcc-quote ──────────────────────────────────────────────────────────

  it("tasks/send pcc-quote → INPUT_REQUIRED with quote artifact + session id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: rpcRequest("rpc-5", "tasks/send", {
        skill: "pcc-quote",
        params: {
          userAgentId: "test-agent",
          kernelId: "kernel-a2a-test",
          capabilityType: "fdm",
          selections: { quantity: 1, evidenceTier: "basic" },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBeDefined();
    expect(body.result.state).toBe("INPUT_REQUIRED");
    expect(body.result.artifacts[0].type).toBe("pcc.quote");
    expect(body.result.pccSessionId).toBeDefined();
    expect(body.result.pccSessionId).toMatch(/^sess-/);
  });

  // ── pcc-submit ─────────────────────────────────────────────────────────

  it("tasks/send pcc-submit → COMPLETED with commit artifact", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: rpcRequest("rpc-6", "tasks/send", {
        skill: "pcc-submit",
        params: {
          userAgentId: "test-agent",
          kernelId: "kernel-a2a-test",
          capabilityType: "fdm",
          selections: { quantity: 1, evidenceTier: "basic" },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBeDefined();
    expect(body.result.state).toBe("COMPLETED");
    const commit = body.result.artifacts.find((a: any) => a.type === "pcc.commit");
    expect(commit).toBeDefined();
    expect(commit.data.jobId).toMatch(/^job-/);
  });

  // ── tasks/get ──────────────────────────────────────────────────────────

  it("tasks/get for unknown task id returns -32001", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: rpcRequest("rpc-7", "tasks/get", { id: "a2a-task-nonexistent" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error.code).toBe(-32001);
  });

  it("tasks/get returns the same task after a tasks/send", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: rpcRequest("rpc-8a", "tasks/send", {
        skill: "pcc-discover",
        params: { capabilityType: "fdm" },
      }),
      headers: { "content-type": "application/json" },
    });
    const taskId = createRes.json().result.id;

    const getRes = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: rpcRequest("rpc-8b", "tasks/get", { id: taskId }),
      headers: { "content-type": "application/json" },
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.result.id).toBe(taskId);
    expect(body.result.state).toBe("COMPLETED");
  });

  // ── tasks/cancel ───────────────────────────────────────────────────────

  it("tasks/cancel transitions a pcc-quote task to CANCELED", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: rpcRequest("rpc-9a", "tasks/send", {
        skill: "pcc-quote",
        params: {
          userAgentId: "test-agent",
          kernelId: "kernel-a2a-test",
          capabilityType: "fdm",
          selections: { quantity: 1 },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    const taskId = createRes.json().result.id;

    const cancelRes = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: rpcRequest("rpc-9b", "tasks/cancel", { id: taskId }),
      headers: { "content-type": "application/json" },
    });
    expect(cancelRes.statusCode).toBe(200);
    const body = cancelRes.json();
    expect(body.result.state).toBe("CANCELED");
  });

  // ── Auth (re-enable) ───────────────────────────────────────────────────

  it("with auth enabled, missing Authorization header returns -32600", async () => {
    delete process.env.PCC_A2A_AUTH_DISABLED;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/a2a/tasks/send",
        payload: rpcRequest("rpc-10", "tasks/send", { skill: "pcc-discover", params: {} }),
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toMatch(/authentication required/i);
    } finally {
      process.env.PCC_A2A_AUTH_DISABLED = "true";
    }
  });
});
