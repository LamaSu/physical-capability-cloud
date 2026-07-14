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
        title: "Physical Capability Cloud",
        version: expect.any(String),
        description: expect.any(String),
      }),
    );
    // Registry branding on the live handshake — name+icon+description
    // reachable without a second request to server-card.json.
    expect(body.result.serverInfo.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "https://capability.network/pcc-icon.svg" }),
      ]),
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
    expect(tools.some((tool: { name: string }) => tool.name === "render_pcc_dashboard")).toBe(
      true,
    );
    // MCP Apps: the tools/list definition itself declares the ui:// link,
    // not only the tool-call result — a host can tell this tool has a UI
    // without first calling it.
    const renderDashboardTool = tools.find(
      (tool: { name: string }) => tool.name === "render_pcc_dashboard",
    );
    // Directive 4/17: a FIXED, predeclared ui:// resource (no {slug} template),
    // canonical nested _meta.ui.resourceUri.
    expect(renderDashboardTool._meta?.ui?.resourceUri).toBe("ui://pcc/dashboard/render");
    // Directive 7: declares an outputSchema requiring `manifest`.
    expect(renderDashboardTool.outputSchema?.required).toContain("manifest");
  });

  it("exposes the fixed ui://pcc/dashboard/render MCP App resource with the standard lifecycle + full CSP", async () => {
    const listed = await app.inject({
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
        id: 3,
        method: "resources/list",
        params: {},
      },
    });
    const resources = listed.json().result.resources;
    expect(listed.statusCode).toBe(200);
    // The three fixed UI resources are advertised (render/saved/gallery).
    for (const uri of [
      "ui://pcc/dashboard/render",
      "ui://pcc/dashboard/saved",
      "ui://pcc/dashboard/gallery",
    ]) {
      expect(resources.some((r: { uri: string }) => r.uri === uri), `resource ${uri}`).toBe(true);
    }

    const read = await app.inject({
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
        id: 4,
        method: "resources/read",
        params: { uri: "ui://pcc/dashboard/render" },
      },
    });
    const contents = read.json().result.contents;
    expect(read.statusCode).toBe(200);
    expect(contents).toHaveLength(1);
    expect(contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(contents[0].text).toContain('<meta name="color-scheme"');
    // Directive 3: the sandbox CSP a compliant host enforces comes from
    // resource-content _meta.ui.csp — full shape (connectDomains + resourceDomains
    // + prefersBorder), NOT the HTML <meta>.
    expect(contents[0]._meta?.ui?.csp?.connectDomains).toContain("https://capability.network");
    expect(contents[0]._meta?.ui?.csp?.resourceDomains).toEqual([]);
    expect(contents[0]._meta?.ui?.prefersBorder).toBe(true);
    // Directive 1: the boot script speaks the STANDARD lifecycle (ui/initialize
    // -> initialized -> tool-result); the guessed-envelope + custom iframe-ready
    // + credential-in-message paths are gone.
    expect(contents[0].text).toContain("ui/initialize");
    expect(contents[0].text).toContain("ui/notifications/initialized");
    expect(contents[0].text).toContain("ui/notifications/tool-result");
    expect(contents[0].text).not.toContain("ui-lifecycle-iframe-ready");
    expect(contents[0].text).not.toContain("data.toolOutput");
    // Directive 2: the TRANSPORT never accepts a credential from a message. (The
    // inlined pcc-ui kit legitimately uses sessionStorage for the USER's own
    // typed key — a separate concern from the host handoff — so we can't string-
    // match "sessionStorage" here; the "token ignored, no sessionStorage write"
    // guarantee is proven behaviorally in mcp-app-view-lifecycle.test.ts.)
  });

  it("render_pcc_dashboard renders a valid manifest and rejects one containing an API key", async () => {
    const goodManifest = {
      csd: "pcc://artifacts/dashboard/v1",
      title: "Watch my print job",
      sections: [{ windows: [{ kind: "note", text: "Your print is in progress." }] }],
    };

    const good = await app.inject({
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
        id: 5,
        method: "tools/call",
        params: { name: "render_pcc_dashboard", arguments: goodManifest },
      },
    });
    const goodResult = good.json().result;
    expect(good.statusCode).toBe(200);
    expect(goodResult.isError).not.toBe(true);
    // Fixed render URI on the result too (matches the descriptor — no {slug}).
    expect(goodResult._meta.ui.resourceUri).toBe("ui://pcc/dashboard/render");
    // structuredContent carries the manifest (what the fixed render view renders).
    expect(goodResult.structuredContent.manifest.title).toBe("Watch my print job");

    const keyedManifest = {
      ...goodManifest,
      sections: [
        { windows: [{ kind: "note", text: "leaked key pcc_live_abc123 in text" }] },
      ],
    };
    const rejected = await app.inject({
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
        id: 6,
        method: "tools/call",
        params: { name: "render_pcc_dashboard", arguments: keyedManifest },
      },
    });
    const rejectedResult = rejected.json().result;
    expect(rejected.statusCode).toBe(200);
    expect(rejectedResult.isError).toBe(true);
  });

  it("tools/call with an unknown tool name returns a structured JSON-RPC error", async () => {
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
        id: 7,
        method: "tools/call",
        params: { name: "definitely_not_a_real_pcc_tool", arguments: {} },
      },
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe("number");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});
