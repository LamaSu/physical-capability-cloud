import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpMcpRoutes } from "../mcp/http-mcp-server.js";
// Plain-Node deploy script (no types): the deploy jobs run it without installing the workspace.
import { checkMcpToolsList, parseJsonRpcBody } from "../../scripts/smoke-mcp-tools-list.mjs";

/**
 * N88: prod's hosted MCP answered `initialize` but failed every `tools/list`
 * (PCC_API_BASE_URL unset), and the deploy's /api/health smoke stayed green.
 * The post-deploy MCP smoke must fail that deployment and pass a configured one.
 * These tests run it against a real listening gateway /mcp, not a mock.
 */
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/smoke-mcp-tools-list.mjs");
const run = promisify(execFile);
const KEYS = ["NODE_ENV", "PCC_API_BASE_URL", "PCC_DEPLOYMENT_ENV", "RAILWAY_ENVIRONMENT_NAME", "PCC_MCP_APP_DOMAIN"] as const;

async function serveMcp(): Promise<{ app: FastifyInstance; base: string }> {
  const app = Fastify({ logger: false });
  await app.register(httpMcpRoutes);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { app, base: `http://127.0.0.1:${address.port}` };
}

/** Run the CLI the way a deploy job does. The server keeps serving while it waits. */
async function runCli(base: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, base, "--attempts", "1"], { timeout: 30000 });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("post-deploy MCP smoke check (N88)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("fails a production gateway whose PCC_API_BASE_URL is unset, at tools/list (prod on 2026-09-29)", async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_DEPLOYMENT_ENV = "production";
    const { app, base } = await serveMcp();
    try {
      const result = await checkMcpToolsList(base);
      expect(result).toMatchObject({ ok: false, stage: "tools/list" });
      expect(result.reason).toMatch(/PCC_API_BASE_URL is not set/);

      const cli = await runCli(base);
      expect(cli.code).toBe(1);
      expect(cli.out).toMatch(/MCP smoke FAILED at tools\/list: .*PCC_API_BASE_URL is not set/);
    } finally {
      await app.close();
    }
  });

  it("passes once PCC_API_BASE_URL is set, and counts the tools", async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_DEPLOYMENT_ENV = "production";
    process.env.PCC_API_BASE_URL = "https://capability.network";
    const { app, base } = await serveMcp();
    try {
      const result = await checkMcpToolsList(base);
      expect(result.ok).toBe(true);
      expect(result.count).toBeGreaterThan(0);

      const cli = await runCli(base);
      expect(cli.code).toBe(0);
      expect(cli.out).toContain(`lists ${result.count} tools`);
    } finally {
      await app.close();
    }
  });

  it("fails a staging gateway pointed at the production origin (the isolation gate)", async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_DEPLOYMENT_ENV = "staging";
    process.env.PCC_API_BASE_URL = "https://capability.network";
    const { app, base } = await serveMcp();
    try {
      const result = await checkMcpToolsList(base);
      expect(result).toMatchObject({ ok: false, stage: "tools/list" });
    } finally {
      await app.close();
    }
  });

  it("fails a server whose tools/list succeeds with an empty list", async () => {
    const stub = Fastify({ logger: false });
    stub.post("/mcp", async (req) => {
      const msg = req.body as { id?: number; method: string };
      if (msg.method === "initialize") {
        return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "0" } } };
      }
      if (msg.method === "tools/list") return { jsonrpc: "2.0", id: msg.id, result: { tools: [] } };
      return {};
    });
    await stub.listen({ port: 0, host: "127.0.0.1" });
    const address = stub.server.address();
    try {
      if (!address || typeof address === "string") throw new Error("no port");
      const result = await checkMcpToolsList(`http://127.0.0.1:${address.port}`);
      expect(result).toEqual({ ok: false, stage: "tools/list", reason: "tools/list returned no tools" });
    } finally {
      await stub.close();
    }
  });

  it("reports an unreachable gateway as a network failure instead of throwing", async () => {
    const { app, base } = await serveMcp();
    await app.close();
    const result = await checkMcpToolsList(base, { timeoutMs: 3000 });
    expect(result).toMatchObject({ ok: false, stage: "network" });
  });

  it("parses a JSON reply and an event-stream reply", () => {
    const message = { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "a" }] } };
    expect(parseJsonRpcBody(JSON.stringify(message), 2)).toEqual(message);
    const stream = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "note" })}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
    expect(parseJsonRpcBody(stream, 2)).toEqual(message);
  });
});
