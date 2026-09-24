/**
 * N4b-gw item 1: the legacy OT-2 relay (/api/ot2/{tool-call,tool-result,
 * scope,chat,camera}) is unmounted. Every /api/ot2/* request answers 410 Gone
 * and names the /api/relay/:kernelId/... route that replaces it, and apiGate
 * still runs in front of it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initStore, closeStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { ot2LegacyGoneRoutes, relayReplacementFor } from "../routes/ot2-legacy-gone.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..");

// Every route the four retired plugins served.
const LEGACY_ROUTES: Array<{ method: "GET" | "POST"; path: string; suffix: string }> = [
  { method: "POST", path: "/api/ot2/tool-call", suffix: "/tool-call" },
  { method: "GET", path: "/api/ot2/tool-call/pending", suffix: "/tool-call/pending" },
  { method: "POST", path: "/api/ot2/tool-result", suffix: "/tool-result" },
  { method: "GET", path: "/api/ot2/tool-result/tc_1", suffix: "/tool-result/tc_1" },
  { method: "POST", path: "/api/ot2/scope", suffix: "/scope" },
  { method: "GET", path: "/api/ot2/scope/scope_1", suffix: "/scope/scope_1" },
  { method: "POST", path: "/api/ot2/scope/scope_1/revoke", suffix: "/scope/scope_1/revoke" },
  { method: "GET", path: "/api/ot2/scope/scope_1/audit", suffix: "/scope/scope_1/audit" },
  { method: "POST", path: "/api/ot2/camera/frame", suffix: "/camera/frame" },
  { method: "GET", path: "/api/ot2/camera/latest", suffix: "/camera/latest" },
  { method: "GET", path: "/api/ot2/camera/stream", suffix: "/camera/stream" },
  { method: "GET", path: "/api/ot2/camera/snapshot", suffix: "/camera/snapshot" },
  { method: "POST", path: "/api/ot2/chat", suffix: "/chat" },
  { method: "GET", path: "/api/ot2/chat/messages", suffix: "/chat/messages" },
  { method: "GET", path: "/api/ot2/chat/pending", suffix: "/chat/pending" },
  { method: "POST", path: "/api/ot2/chat/respond", suffix: "/chat/respond" },
];

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(ot2LegacyGoneRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("N4b-gw item 1: the legacy /api/ot2 relay answers 410 Gone", () => {
  it.each(LEGACY_ROUTES)("$method $path is gone and points at /api/relay/:kernelId$suffix", async ({ method, path, suffix }) => {
    const res = await app.inject({
      method,
      url: path,
      payload: method === "POST" ? { createdBy: "anyone", allowedTools: ["shell"], toolName: "shell" } : undefined,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("gone");
    expect(res.json().replacement).toBe(`/api/relay/:kernelId${suffix}`);
  });

  it("fills in the kernel id the legacy request carried, from the query or the body", async () => {
    const q = await app.inject({ method: "GET", url: "/api/ot2/tool-call/pending?kernelId=kernel-nanoclaw" });
    expect(q.json().replacement).toBe("/api/relay/kernel-nanoclaw/tool-call/pending");

    const b = await app.inject({
      method: "POST",
      url: "/api/ot2/camera/frame",
      payload: { kernelId: "kernel_mqse6f60_wshx", frame: "AAAA" },
    });
    expect(b.json().replacement).toBe("/api/relay/kernel_mqse6f60_wshx/camera/frame");
  });

  it("does not echo a kernel id that is not a plain identifier", async () => {
    const res = await app.inject({ method: "GET", url: "/api/ot2/camera/latest?kernelId=%3Cscript%3E" });
    expect(res.statusCode).toBe(410);
    expect(res.json().replacement).toBe("/api/relay/:kernelId/camera/latest");
  });

  it("names no replacement for a legacy path the relay never had", async () => {
    const res = await app.inject({ method: "GET", url: "/api/ot2/agent-code" });
    expect(res.statusCode).toBe(410);
    expect(res.json().replacement).toBeNull();
    expect(relayReplacementFor("/api/ot2/scope/a/b/c")).toBeNull();
    expect(relayReplacementFor("/api/relay/k/scope")).toBeNull();
  });

  it("still sits behind apiGate: an unauthenticated caller gets 401, not the 410", async () => {
    process.env.DATABASE_URL = ":memory:";
    initStore({ seed: false });
    const gated = Fastify({ logger: false });
    gated.decorateRequest("operatorId", null);
    gated.decorateRequest("userId", null);
    gated.decorateRequest("apiKeyId", null);
    await gated.register(apiGate);
    await gated.register(ot2LegacyGoneRoutes);
    await gated.ready();

    const res = await gated.inject({ method: "POST", url: "/api/ot2/scope", payload: { allowedTools: ["shell"] } });
    expect(res.statusCode).toBe(401);

    await gated.close();
    closeStore();
  });
});

describe("N4b-gw item 1: the legacy plugins are unmounted from the gateway", () => {
  const server = readFileSync(resolve(srcDir, "server.ts"), "utf8");

  it("server.ts registers the 410 responder and the device relay, and none of the legacy plugins", () => {
    expect(server).toMatch(/await app\.register\(ot2LegacyGoneRoutes\);/);
    expect(server).toMatch(/await app\.register\(deviceRelayRoutes\);/);
    for (const legacy of ["ot2RelayRoutes", "ot2ScopeRoutes", "ot2ChatRoutes", "ot2CameraRoutes"]) {
      expect(server).not.toContain(legacy);
    }
  });

  it("the legacy route modules no longer exist", () => {
    for (const file of ["ot2-relay.ts", "ot2-scope.ts", "ot2-chat.ts", "ot2-camera.ts"]) {
      expect(existsSync(resolve(srcDir, "routes", file)), file).toBe(false);
    }
  });
});
