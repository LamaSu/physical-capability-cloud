/**
 * Server integration tests: /health, /heartbeat/:worker, /alerts/recent.
 *
 * Author: implementer-alpha
 */

import { describe, it, expect } from "vitest";
import { buildServer } from "../server.js";
import { alertsConfigSchema } from "../config.js";

describe("alerts server", () => {
  it("GET /health is open and reports counts", async () => {
    const cfg = alertsConfigSchema.parse({});
    const built = buildServer({ config: cfg });
    const res = await built.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBeDefined();
    expect(body.chainWatchers).toBe(0);
    expect(body.rpcProbes).toBe(0);
    expect(body.heartbeats).toBe(0);
    await built.shutdown();
  });

  it("POST /heartbeat/:worker records and is reflected in /health snapshot", async () => {
    const cfg = alertsConfigSchema.parse({
      heartbeats: [{ worker: "oracle-1" }],
    });
    const built = buildServer({ config: cfg });
    const post = await built.app.inject({
      method: "POST",
      url: "/heartbeat/oracle-1",
    });
    expect(post.statusCode).toBe(200);
    const health = await built.app.inject({ method: "GET", url: "/health" });
    const body = health.json();
    expect(body.workers).toHaveLength(1);
    expect(body.workers[0].worker).toBe("oracle-1");
    expect(body.workers[0].lastSeen).not.toBeNull();
    await built.shutdown();
  });

  it("POST /heartbeat/:worker requires Bearer when heartbeatToken set", async () => {
    const cfg = alertsConfigSchema.parse({
      heartbeatToken: "secret123",
      heartbeats: [{ worker: "oracle-1" }],
    });
    const built = buildServer({ config: cfg });
    const no = await built.app.inject({ method: "POST", url: "/heartbeat/oracle-1" });
    expect(no.statusCode).toBe(401);
    const bad = await built.app.inject({
      method: "POST",
      url: "/heartbeat/oracle-1",
      headers: { authorization: "Bearer wrong" },
    });
    expect(bad.statusCode).toBe(401);
    const good = await built.app.inject({
      method: "POST",
      url: "/heartbeat/oracle-1",
      headers: { authorization: "Bearer secret123" },
    });
    expect(good.statusCode).toBe(200);
    await built.shutdown();
  });

  it("GET /alerts/recent returns alerts in ring buffer", async () => {
    const cfg = alertsConfigSchema.parse({ ringBufferSize: 5 });
    const built = buildServer({ config: cfg });
    // Directly push alerts (simulating sources).
    built.buffer.push({
      ts: "2026-04-21T00:00:00Z",
      source: "manual",
      severity: "info",
      title: "one",
      body: "",
    });
    built.buffer.push({
      ts: "2026-04-21T00:00:01Z",
      source: "manual",
      severity: "warning",
      title: "two",
      body: "",
    });
    const res = await built.app.inject({ method: "GET", url: "/alerts/recent?limit=10" });
    expect(res.statusCode).toBe(200);
    const { alerts } = res.json() as { alerts: Array<{ title: string }> };
    expect(alerts).toHaveLength(2);
    expect(alerts[0]!.title).toBe("two"); // newest first
    await built.shutdown();
  });

  it("rejects invalid limit on /alerts/recent", async () => {
    const cfg = alertsConfigSchema.parse({});
    const built = buildServer({ config: cfg });
    const res = await built.app.inject({
      method: "GET",
      url: "/alerts/recent?limit=0",
    });
    expect(res.statusCode).toBe(400);
    await built.shutdown();
  });

  it("accepts heartbeat with 202 note when no heartbeats configured", async () => {
    const cfg = alertsConfigSchema.parse({});
    const built = buildServer({ config: cfg });
    const res = await built.app.inject({ method: "POST", url: "/heartbeat/x" });
    expect(res.statusCode).toBe(202);
    expect(res.json().note).toContain("no heartbeats");
    await built.shutdown();
  });
});
