import Fastify from "fastify";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { httpMcpRoutes } from "../mcp/http-mcp-server.js";

/**
 * The public agent package is what external agents load, and the gateway's
 * Streamable-HTTP /mcp advertises exactly its tools (http-mcp-server.ts builds
 * tools/list from pack.tools). So every tool must call a route on the gateway
 * itself. An absolute endpoint (above all a localhost one) sends every external
 * agent, and /mcp, to its own machine.
 *
 * Regression: through 2.19.1 the package listed pcc_generate_ui ->
 * http://localhost:3200/api/generate. That is pcc-node's LOCAL UI server
 * (packages/pcc-node/pcc_node/ui_server.py), not a gateway route; genui ruled it
 * node-local, to be removed from the public package rather than repointed
 * (bus #2313). A relative /api/generate would 404 on the gateway.
 */
const PKG = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "apps", "dashboard", "public", "agent-package.json",
);

type Tool = { name: string; endpoint?: { method?: string; path?: string } };
const pkg = JSON.parse(readFileSync(PKG, "utf8")) as { tools: Tool[] };

function isRelativeGatewayPath(path: unknown): boolean {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.startsWith("//") && // protocol-relative URL = another host
    !path.includes("://")
  );
}

describe("agent-package.json: every tool calls the gateway itself", () => {
  it("has tools to check", () => {
    expect(pkg.tools.length).toBeGreaterThan(0);
  });

  it("every tool endpoint is a relative gateway path (no scheme, no host)", () => {
    const offenders = pkg.tools
      .filter((t) => !isRelativeGatewayPath(t.endpoint?.path))
      .map((t) => `${t.name} -> ${JSON.stringify(t.endpoint)}`);
    expect(offenders, `tools that do not call the gateway:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("does not list pcc_generate_ui, a pcc-node local tool (bus #2313)", () => {
    expect(pkg.tools.map((t) => t.name)).not.toContain("pcc_generate_ui");
  });
});

// The seam: the real Streamable-HTTP /mcp surface, driven through its handshake.
// PCC_AGENT_PACKAGE_PATH, when set, points the loader at another pack.
describe("/mcp tools/list: built from the package, without pcc_generate_ui", () => {
  const app = Fastify({ logger: false });
  const base = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  let listed: string[] = [];

  beforeAll(async () => {
    await app.register(httpMcpRoutes);
    await app.ready();
    const init = await app.inject({
      method: "POST", url: "/mcp", headers: base,
      payload: {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aeo-endpoint-test", version: "1.0.0" } },
      },
    });
    const session = {
      ...base,
      "mcp-session-id": String(init.headers["mcp-session-id"]),
      "mcp-protocol-version": init.json().result.protocolVersion,
    };
    await app.inject({ method: "POST", url: "/mcp", headers: session, payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
    const res = await app.inject({
      method: "POST", url: "/mcp", headers: session,
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    listed = res.json().result.tools.map((t: { name: string }) => t.name);
  });

  afterAll(async () => {
    await app.close();
  });

  it("does not advertise pcc_generate_ui", () => {
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).not.toContain("pcc_generate_ui");
  });

  it("advertises every tool in the package", () => {
    const missing = pkg.tools.map((t) => t.name).filter((name) => !listed.includes(name));
    expect(missing).toEqual([]);
  });
});

describe("isRelativeGatewayPath (the predicate itself)", () => {
  it("accepts gateway paths, including templated ones", () => {
    expect(isRelativeGatewayPath("/api/feedback")).toBe(true);
    expect(isRelativeGatewayPath("/api/kernels/{kernelId}/heartbeat")).toBe(true);
  });

  it("rejects absolute, loopback, protocol-relative and missing endpoints", () => {
    expect(isRelativeGatewayPath("http://localhost:3200/api/generate")).toBe(false);
    expect(isRelativeGatewayPath("https://capability.network/api/feedback")).toBe(false);
    expect(isRelativeGatewayPath("//evil.example/api")).toBe(false);
    expect(isRelativeGatewayPath("localhost:3200/api/generate")).toBe(false);
    expect(isRelativeGatewayPath(undefined)).toBe(false);
  });
});
