import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpMcpRoutes } from "../mcp/http-mcp-server.js";

describe("Streamable HTTP MCP server", () => {
  const app = Fastify({ logger: false });
  let sessionId: string;
  let protocolVersion: string;

  beforeAll(async () => {
    await app.register(httpMcpRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns server information from the initialize handshake", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "gateway-test", version: "1.0.0" },
        },
      },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(body.result.serverInfo).toEqual(
      expect.objectContaining({
        name: "Physical Capability Cloud",
        version: expect.any(String),
      }),
    );
    expect(body.result.instructions).toContain("Discover PCC capabilities");
    sessionId = String(response.headers["mcp-session-id"]);
    protocolVersion = body.result.protocolVersion;
    expect(sessionId).not.toBe("undefined");
  });

  it("lists the generated agent-package tools with MCP schemas and annotations", async () => {
    const initialized = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
    });
    expect(initialized.statusCode).toBe(202);

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    });
    const tools = response.json().result.tools;

    expect(response.statusCode).toBe(200);
    expect(tools.length).toBeGreaterThanOrEqual(50);
    for (const tool of tools) {
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(tool.inputSchema).toEqual(
        expect.objectContaining({ type: "object" }),
      );
    }
    expect(
      tools.some(
        (tool: { annotations?: { readOnlyHint?: boolean } }) =>
          tool.annotations?.readOnlyHint === true,
      ),
    ).toBe(true);
  });
});
