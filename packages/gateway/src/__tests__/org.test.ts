/**
 * Tests for the org coordination routes — the HTTP mount of
 * @pcc/coordination's three integration contracts (routes/org.ts).
 *
 * Strategy:
 *   - COORDINATION_DB_PATH points at a fresh temp SQLite file for this test
 *     file, so a HumanQueueStore created directly in a test (via
 *     _getQueueForTesting()) and the route module's own lazy singleton read/
 *     write the exact same durable table.
 *   - GET/POST /org/approvals are ordinary request/response -> app.inject().
 *   - GET /org/watch is an SSE stream that never completes, so app.inject()
 *     would hang forever waiting for the response to end (the same reason
 *     __tests__/commentary.test.ts only route-existence-checks its own SSE
 *     endpoint via printRoutes()). Here we go one step further and actually
 *     listen on a real socket + read real bytes with fetch()/AbortController,
 *     because @pcc/a2a's createBackendFromEnv() returns a brand-new
 *     InMemoryBackend on every call -- a second `new OrgBus()` in this test
 *     would be a disconnected bus that never sees a publish(). Reaching the
 *     exact bus instance /org/watch subscribed through requires
 *     _getBusForTesting() (mirrors the _resetAnthropicCache()-style test
 *     hook already used by services/commentary-narrator.ts).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { ORG_SUBJECTS, type HumanQueueStore } from "@pcc/coordination";
import {
  orgRoutes,
  _getQueueForTesting,
  _getBusForTesting,
  _resetOrgSingletonsForTesting,
} from "../routes/org.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pcc-org-routes-test-"));
process.env.COORDINATION_DB_PATH = join(tmpDir, "coordination-brain.sqlite");

afterAll(async () => {
  await _resetOrgSingletonsForTesting();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Each test gets its own fresh sqlite file (not just a reset singleton) so
// tests are order-independent — a shared file would let one test's enqueued
// items leak into the next test's counts.
let testDbCounter = 0;
beforeEach(async () => {
  await _resetOrgSingletonsForTesting();
  testDbCounter += 1;
  process.env.COORDINATION_DB_PATH = join(tmpDir, `coordination-brain-${testDbCounter}.sqlite`);
});

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(orgRoutes);
  await app.ready();
  return app;
}

describe("GET /org/approvals", () => {
  it("returns an empty list against a fresh queue", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/org/approvals" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ approvals: [], count: 0 });
    await app.close();
  });

  it("lists an enqueued item mapped through the OrgApprovalItem contract", async () => {
    const app = await buildApp();
    const queue: HumanQueueStore = _getQueueForTesting();
    const enqueued = queue.enqueue({
      severity: "high",
      category: "stale_kernel",
      title: "Kernel k-1 heartbeat stale",
      details: "No heartbeat for 12 minutes.",
      action: { workflowName: "restart-kernel", args: { kernelId: "k-1" } },
    });

    const res = await app.inject({ method: "GET", url: "/org/approvals" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.approvals[0]).toMatchObject({
      id: enqueued.id,
      status: "pending",
      authorityClass: "mutate",
      trustLevel: "write",
      category: "stale_kernel",
      intent: { action: "restart-kernel", args: { kernelId: "k-1" } },
    });
    await app.close();
  });

  it("rejects an invalid ?status", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/org/approvals?status=bogus" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an invalid ?persona", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/org/approvals?persona=bogus" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("filters by status", async () => {
    const app = await buildApp();
    const queue = _getQueueForTesting();
    queue.enqueue({ severity: "low", category: "info_only", title: "t1", details: "d1" });

    const res = await app.inject({ method: "GET", url: "/org/approvals?status=approved" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ approvals: [], count: 0 });

    const pendingRes = await app.inject({ method: "GET", url: "/org/approvals?status=pending" });
    expect(pendingRes.json().count).toBe(1);
    await app.close();
  });
});

describe("POST /org/approvals/:id/resolve", () => {
  it("approves a pending item", async () => {
    const app = await buildApp();
    const queue = _getQueueForTesting();
    const item = queue.enqueue({ severity: "medium", category: "test", title: "t", details: "d" });

    const res = await app.inject({
      method: "POST",
      url: `/org/approvals/${item.id}/resolve`,
      payload: { approved: true, resolvedBy: "operator@example.com" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.approval.status).toBe("approved");
    expect(body.approval.verdict).toMatchObject({ approved: true });

    const list = await app.inject({ method: "GET", url: "/org/approvals?status=approved" });
    expect(list.json().count).toBe(1);
    await app.close();
  });

  it("rejects a pending item", async () => {
    const app = await buildApp();
    const queue = _getQueueForTesting();
    const item = queue.enqueue({ severity: "medium", category: "test", title: "t", details: "d" });

    const res = await app.inject({
      method: "POST",
      url: `/org/approvals/${item.id}/resolve`,
      payload: { approved: false, resolvedBy: "operator@example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().approval.status).toBe("rejected");
    await app.close();
  });

  it("honors editedArgs on approve", async () => {
    const app = await buildApp();
    const queue = _getQueueForTesting();
    const item = queue.enqueue({
      severity: "medium",
      category: "test",
      title: "t",
      details: "d",
      action: { workflowName: "restart-kernel", args: { kernelId: "k-1" } },
    });

    const res = await app.inject({
      method: "POST",
      url: `/org/approvals/${item.id}/resolve`,
      payload: { approved: true, resolvedBy: "operator@example.com", editedArgs: { kernelId: "k-2" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().approval.intent.args).toEqual({ kernelId: "k-2" });
    await app.close();
  });

  it("404s for an unknown id", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/org/approvals/does-not-exist/resolve",
      payload: { approved: true, resolvedBy: "operator@example.com" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400s when approved is missing", async () => {
    const app = await buildApp();
    const queue = _getQueueForTesting();
    const item = queue.enqueue({ severity: "medium", category: "test", title: "t", details: "d" });
    const res = await app.inject({
      method: "POST",
      url: `/org/approvals/${item.id}/resolve`,
      payload: { resolvedBy: "operator@example.com" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400s when resolvedBy is missing", async () => {
    const app = await buildApp();
    const queue = _getQueueForTesting();
    const item = queue.enqueue({ severity: "medium", category: "test", title: "t", details: "d" });
    const res = await app.inject({
      method: "POST",
      url: `/org/approvals/${item.id}/resolve`,
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /org/watch (SSE)", () => {
  it("streams a connected frame, then a real org.* event, over a live socket", async () => {
    const app = await buildApp();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    const controller = new AbortController();
    try {
      const res = await fetch(`${address}/org/watch`, { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = "";

      // First chunk(s): the hello comment + "connected" frame the route
      // writes synchronously on connect.
      const deadlineConnect = Date.now() + 5000;
      while (!buffered.includes("event: connected") && Date.now() < deadlineConnect) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
      }
      expect(buffered).toContain("event: connected");

      // Publish a real org.* event onto the exact bus /org/watch subscribed
      // to, then read until the resulting CUSTOM frame shows up.
      const bus = _getBusForTesting();
      await bus.publish(ORG_SUBJECTS.QUEUE_ITEM_ENQUEUED, { id: "test-item-1" });

      const deadlineEvent = Date.now() + 5000;
      while (
        !buffered.includes(`"name":"${ORG_SUBJECTS.QUEUE_ITEM_ENQUEUED}"`) &&
        Date.now() < deadlineEvent
      ) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
      }

      expect(buffered).toContain("event: CUSTOM");
      expect(buffered).toContain(`"name":"${ORG_SUBJECTS.QUEUE_ITEM_ENQUEUED}"`);
      expect(buffered).toContain('"id":"test-item-1"');

      await reader.cancel().catch(() => {});
    } finally {
      controller.abort();
      await app.close();
    }
  }, 15_000);
});
