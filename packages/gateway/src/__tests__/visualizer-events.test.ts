/**
 * Unit tests for the visualizer SSE proxy.
 *
 * Covers:
 *   – The snapshot JSON endpoint returns events in the expected shape.
 *   – The endpoint respects ?since= for filtering.
 *   – The endpoint respects ?limit= for capping.
 *   – The CORS header is permissive (public surface).
 *   – Payload sanitization strips disallowed keys.
 *   – Unknown event types are filtered out of the snapshot.
 *
 * Does NOT cover the live SSE stream itself — that exercises Fastify's
 * raw socket handling which is integration-level and requires a separate
 * harness. The snapshot endpoint uses the same sanitize() path so
 * correctness there is sufficient for unit-test coverage.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { streamHub, type StreamEvent } from "../sse/stream-hub.js";
import { visualizerEvents } from "../routes/visualizer-events.js";

function pushEvent(type: string, payload: Record<string, unknown>): StreamEvent {
  const ev: StreamEvent = {
    id: Math.random().toString(36).slice(2),
    type,
    timestamp: new Date().toISOString(),
    topic: { type: "global", id: "*" },
    payload,
  };
  streamHub.publish([{ type: "global", id: "*" }], ev);
  return ev;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(visualizerEvents);
  return app;
}

describe("visualizer-events: snapshot endpoint", () => {
  beforeEach(() => {
    // Drain the global replay buffer between tests.
    const hub = streamHub as unknown as { replayBuffers: Map<string, StreamEvent[]> };
    hub.replayBuffers.delete("global:*");
  });

  it("returns events array + count + capturedAt", async () => {
    const app = await buildApp();
    pushEvent("kernel_registered", { kernelId: "k1" });
    pushEvent("escrow_funded",     { kernelId: "k1", jobId: "j1", amount: "10.00", currency: "USDC" });

    const res = await app.inject({ method: "GET", url: "/api/visualizer/events.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: unknown[]; count: number; capturedAt: string };
    expect(body.count).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.events)).toBe(true);
    expect(typeof body.capturedAt).toBe("string");
    await app.close();
  });

  it("sets a public CORS header (no credentials)", async () => {
    const app = await buildApp();
    pushEvent("kernel_registered", { kernelId: "k1" });
    const res = await app.inject({ method: "GET", url: "/api/visualizer/events.json" });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    await app.close();
  });

  it("filters out unknown event types", async () => {
    const app = await buildApp();
    pushEvent("kernel_registered",    { kernelId: "k1" });
    pushEvent("some_internal_event",  { kernelId: "k1", secret: "leak-this" });
    pushEvent("escrow_funded",        { kernelId: "k1", amount: "1.00" });

    const res = await app.inject({ method: "GET", url: "/api/visualizer/events.json" });
    const body = res.json() as { events: Array<{ type: string }> };
    const types = body.events.map((e) => e.type);
    expect(types).toContain("kernel_registered");
    expect(types).toContain("escrow_funded");
    expect(types).not.toContain("some_internal_event");
    await app.close();
  });

  it("strips payload keys outside the allowlist", async () => {
    const app = await buildApp();
    pushEvent("escrow_funded", {
      kernelId: "k1",
      jobId: "j1",
      amount: "12.40",
      currency: "USDC",
      // Disallowed:
      operatorEmail: "alice@example.com",
      walletAddress: "0xDEADBEEF",
      apiKey: "pcc_live_secret",
    });

    const res = await app.inject({ method: "GET", url: "/api/visualizer/events.json" });
    const body = res.json() as { events: Array<{ type: string; payload: Record<string, unknown> }> };
    const escrow = body.events.find((e) => e.type === "escrow_funded");
    expect(escrow).toBeDefined();
    expect(escrow!.payload.kernelId).toBe("k1");
    expect(escrow!.payload.jobId).toBe("j1");
    expect(escrow!.payload.amount).toBe("12.40");
    expect(escrow!.payload.currency).toBe("USDC");
    // Sensitive fields are NOT surfaced.
    expect(escrow!.payload.operatorEmail).toBeUndefined();
    expect(escrow!.payload.walletAddress).toBeUndefined();
    expect(escrow!.payload.apiKey).toBeUndefined();
    await app.close();
  });

  it("respects ?limit=", async () => {
    const app = await buildApp();
    for (let i = 0; i < 30; i++) {
      pushEvent("job_progress", { kernelId: "k1", jobId: `j${i}`, progress: i });
    }
    const res = await app.inject({ method: "GET", url: "/api/visualizer/events.json?limit=10" });
    const body = res.json() as { events: unknown[]; count: number };
    expect(body.count).toBeLessThanOrEqual(10);
    await app.close();
  });

  it("respects ?since= to filter old events", async () => {
    const app = await buildApp();
    const tOld = new Date(Date.now() - 60_000).toISOString();
    // Push events with explicit old timestamps via direct hub push.
    const hub = streamHub as unknown as { replayBuffers: Map<string, StreamEvent[]> };
    const buf = hub.replayBuffers.get("global:*") ?? [];
    buf.push({ id: "a", type: "kernel_registered", timestamp: tOld, topic: { type: "global", id: "*" }, payload: { kernelId: "k-old" } });
    hub.replayBuffers.set("global:*", buf);
    pushEvent("kernel_registered", { kernelId: "k-new" });

    const sinceNow = new Date(Date.now() - 10_000).toISOString();
    const res = await app.inject({ method: "GET", url: `/api/visualizer/events.json?since=${encodeURIComponent(sinceNow)}` });
    const body = res.json() as { events: Array<{ payload: { kernelId?: string } }> };
    const ids = body.events.map((e) => e.payload.kernelId);
    expect(ids).toContain("k-new");
    expect(ids).not.toContain("k-old");
    await app.close();
  });
});
