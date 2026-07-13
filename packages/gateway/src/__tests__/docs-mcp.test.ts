import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docsHttpMcpRoutes } from "../mcp/docs-mcp-server.js";

describe("Streamable HTTP docs MCP server", () => {
  const app = Fastify({ logger: false });
  let sessionId: string;
  let protocolVersion: string;

  beforeAll(async () => {
    // docs://pcc/api reads app.swagger() — register the plugin so that
    // resource resolves the same way GET /openapi.json does in server.ts.
    await app.register(fastifySwagger, {
      openapi: { info: { title: "PCC Gateway (test)", version: "0.0.0" } },
    });
    await app.register(docsHttpMcpRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns server information from the initialize handshake", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp/docs",
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
        name: "Physical Capability Cloud Docs",
        title: "PCC Documentation",
        version: expect.any(String),
      }),
    );
    sessionId = String(response.headers["mcp-session-id"]);
    protocolVersion = body.result.protocolVersion;
    expect(sessionId).not.toBe("undefined");

    const initialized = await app.inject({
      method: "POST",
      url: "/mcp/docs",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(initialized.statusCode).toBe(202);
  });

  it("lists the three documentation resources", async () => {
    const listed = await app.inject({
      method: "POST",
      url: "/mcp/docs",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
    });
    const resources = listed.json().result.resources;

    expect(listed.statusCode).toBe(200);
    expect(resources.length).toBeGreaterThanOrEqual(3);
    const uris = resources.map((r: { uri: string }) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining(["docs://pcc/agent-guide", "docs://pcc/api", "docs://pcc/quickstart"]),
    );
  });

  it("reads the agent-guide resource as real markdown from the repo", async () => {
    const read = await app.inject({
      method: "POST",
      url: "/mcp/docs",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "docs://pcc/agent-guide" },
      },
    });
    const contents = read.json().result.contents;

    expect(read.statusCode).toBe(200);
    expect(contents).toHaveLength(1);
    expect(contents[0].mimeType).toBe("text/markdown");
    expect(contents[0].text).toContain("PCC Agent Integration Guide");
    expect(contents[0].text).toContain("Complete API Reference");
  });

  it("reads the quickstart resource as real markdown from the repo", async () => {
    const read = await app.inject({
      method: "POST",
      url: "/mcp/docs",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: {
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: { uri: "docs://pcc/quickstart" },
      },
    });
    const contents = read.json().result.contents;

    expect(read.statusCode).toBe(200);
    expect(contents[0].text).toContain("PCC Quickstarts");
  });

  it("reads the api resource as the gateway's live OpenAPI document", async () => {
    const read = await app.inject({
      method: "POST",
      url: "/mcp/docs",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: {
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: "docs://pcc/api" },
      },
    });
    const contents = read.json().result.contents;

    expect(read.statusCode).toBe(200);
    expect(contents[0].mimeType).toBe("application/json");
    const openapi = JSON.parse(contents[0].text);
    expect(openapi.openapi).toEqual(expect.any(String));
    expect(openapi.info.title).toBe("PCC Gateway (test)");
  });

  it("lists search_docs and finds a real hit", async () => {
    const tools = await app.inject({
      method: "POST",
      url: "/mcp/docs",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} },
    });
    expect(
      tools.json().result.tools.some((tool: { name: string }) => tool.name === "search_docs"),
    ).toBe(true);

    const call = await app.inject({
      method: "POST",
      url: "/mcp/docs",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "search_docs", arguments: { query: "escrow" } },
      },
    });
    const result = call.json().result;

    expect(call.statusCode).toBe(200);
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("docs://pcc/agent-guide");
  });

  it("tools/call with an unknown tool name returns an isError tool result", async () => {
    // Note: this differs from the low-level product /mcp server's behavior
    // (see http-mcp.test.ts's equivalent case, which asserts a top-level
    // JSON-RPC `error`). docs-mcp-server.ts uses the SDK's high-level
    // McpServer.registerTool() API, whose internal CallToolRequestSchema
    // handler wraps tool dispatch in try/catch and converts a "not found"
    // McpError into createToolError() — {result: {isError: true, content}}
    // — rather than letting it propagate as a protocol-level error
    // (verified directly against @modelcontextprotocol/sdk's compiled
    // server/mcp.js for this repo's installed 1.29.0).
    const response = await app.inject({
      method: "POST",
      url: "/mcp/docs",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      payload: {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "definitely_not_a_real_docs_tool", arguments: {} },
      },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("not found");
  });
});
