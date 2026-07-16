import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { appsHttpMcpRoutes, httpMcpRoutes } from "../mcp/http-mcp-server.js";

// The server-enforced READ-ONLY /mcp/apps surface (the read-only gen-UI launch
// piece). These tests assert the read-only guarantee at BOTH tools/list AND the
// CallTool dispatch, the prod domain gate, and that the full /mcp is unchanged.

const JSON_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

interface McpSession {
  sessionId: string;
  protocolVersion: string;
}

/** Run the MCP initialize handshake for a mount path and return its session. */
async function initSession(app: FastifyInstance, mountPath: string): Promise<McpSession> {
  const res = await app.inject({
    method: "POST",
    url: mountPath,
    headers: JSON_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "readonly-surface-test", version: "1.0.0" },
      },
    },
  });
  const sessionId = String(res.headers["mcp-session-id"]);
  const protocolVersion = res.json().result.protocolVersion as string;
  await app.inject({
    method: "POST",
    url: mountPath,
    headers: { ...JSON_HEADERS, "mcp-session-id": sessionId, "mcp-protocol-version": protocolVersion },
    payload: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  return { sessionId, protocolVersion };
}

/** Send one JSON-RPC request over an initialized session; return the parsed body. */
async function rpc(
  app: FastifyInstance,
  mountPath: string,
  session: McpSession,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: any }> {
  const res = await app.inject({
    method: "POST",
    url: mountPath,
    headers: {
      ...JSON_HEADERS,
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": session.protocolVersion,
    },
    payload: { jsonrpc: "2.0", ...payload },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

async function listTools(app: FastifyInstance, mountPath: string, session: McpSession): Promise<any[]> {
  const { body } = await rpc(app, mountPath, session, { id: 2, method: "tools/list", params: {} });
  return body.result.tools as any[];
}

const toolNames = (tools: any[]): string[] => tools.map((t) => t.name);

describe("read-only /mcp/apps surface (non-prod: surface active)", () => {
  // Register BOTH surfaces on one app — exactly as server.ts does — proving they
  // coexist (the fixed HTTP-mirror route registers only once, no collision).
  const app = Fastify({ logger: false });

  beforeAll(async () => {
    await app.register(httpMcpRoutes);
    await app.register(appsHttpMcpRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("advertises ONLY the read-only set on /mcp/apps tools/list", async () => {
    const session = await initSession(app, "/mcp/apps");
    const tools = await listTools(app, "/mcp/apps", session);
    const names = toolNames(tools);

    // The read-only tools that MUST be present.
    expect(names).toContain("render_pcc_dashboard");
    expect(names).toContain("get_dashboard"); // GET /api/artifacts/{idOrSlug}
    expect(names).toContain("search_dashboards"); // GET /api/artifacts
    expect(names).toContain("pcc.op.capability.request_quote"); // read-only typed op
    // At least one plain GET discovery/recall proxy tool.
    expect(names).toContain("list_kernels");

    // Mutating dashboard tools MUST be absent (POST/POST/PUT).
    expect(names).not.toContain("save_dashboard");
    expect(names).not.toContain("fork_dashboard");
    expect(names).not.toContain("update_dashboard");
    // job.cancel / its typed op MUST be absent (not registered anyway).
    expect(names).not.toContain("job.cancel");
    expect(names).not.toContain("pcc.op.job.cancel");

    // GET alone no longer admits — a GET proxy tool NOT in the reviewed
    // allowlist is EXCLUDED (on-chain reads, polls/leases, IPFS fetches deny).
    expect(names).not.toContain("get_escrow_events"); // GET, on-chain RPC read
    expect(names).not.toContain("operator_poll_jobs"); // GET, poll/lease effect
    expect(names).not.toContain("retrieve_ipfs"); // GET, external IPFS fetch

    // EXACT reviewed surface = the effect-classified READONLY_APP_PROXY_TOOLS +
    // render + the read-only typed op. A snapshot: a newly-added GET proxy tool
    // can NOT enter the app surface automatically — it must be individually
    // reviewed into READONLY_APP_PROXY_TOOLS, which changes this expected set.
    const EXPECTED_APP_SURFACE = [
      "get_dashboard",
      "get_job",
      "get_kernel",
      "get_kernel_devices",
      "get_kernel_jobs",
      "list_capability_types",
      "list_jobs",
      "list_kernels",
      "pcc.op.capability.request_quote",
      "render_pcc_dashboard",
      "search_capabilities",
      "search_dashboards",
    ];
    expect([...names].sort()).toEqual(EXPECTED_APP_SURFACE);

    // Comprehensive invariant: EVERY advertised tool is read-only, none destructive.
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).not.toBe(true);
    }
  });

  it("dispatch REFUSES a non-allowlisted (mutating) tool — server-enforced, not just list-hidden", async () => {
    const session = await initSession(app, "/mcp/apps");
    // save_dashboard is a POST proxy tool (POST /api/artifacts). Even though it is
    // NOT advertised, calling its name by hand must error and NEVER proxy.
    const { statusCode, body } = await rpc(app, "/mcp/apps", session, {
      id: 3,
      method: "tools/call",
      params: { name: "save_dashboard", arguments: { manifest: {} } },
    });
    expect(statusCode).toBe(200);
    expect(body.error).toBeUndefined(); // tool-level isError, not a protocol error
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("read-only PCC app surface");
  });

  it("dispatch REFUSES the unregistered job.cancel typed op on the app surface", async () => {
    const session = await initSession(app, "/mcp/apps");
    const { body } = await rpc(app, "/mcp/apps", session, {
      id: 4,
      method: "tools/call",
      params: { name: "pcc.op.job.cancel", arguments: { jobId: "job-1" } },
    });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("read-only PCC app surface");
  });

  it("ALLOWS a read-only tool (render_pcc_dashboard) on the app surface", async () => {
    const session = await initSession(app, "/mcp/apps");
    const manifest = {
      csd: "pcc://artifacts/dashboard/v1",
      title: "Read-only view",
      sections: [{ windows: [{ kind: "note", text: "Live status." }] }],
    };
    const { body } = await rpc(app, "/mcp/apps", session, {
      id: 5,
      method: "tools/call",
      params: { name: "render_pcc_dashboard", arguments: manifest },
    });
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent.manifest.title).toBe("Read-only view");
  });

  it("REGRESSION: the full /mcp surface still advertises the full set incl. mutating tools", async () => {
    const session = await initSession(app, "/mcp");
    const tools = await listTools(app, "/mcp", session);
    const names = toolNames(tools);

    // Full surface is unchanged — the whole ~254-tool proxy catalog + render.
    expect(tools.length).toBeGreaterThanOrEqual(250);
    expect(names).toContain("render_pcc_dashboard");
    expect(names).toContain("list_kernels");
    // The writes the app surface hides ARE present on the full surface.
    expect(names).toContain("save_dashboard");
    expect(names).toContain("update_dashboard");
    // And the full surface genuinely carries non-read-only (mutating) tools.
    expect(tools.some((t) => t.annotations?.readOnlyHint === false)).toBe(true);

    // The read-only set is a strict subset of the full set.
    const appsSession = await initSession(app, "/mcp/apps");
    const appsTools = await listTools(app, "/mcp/apps", appsSession);
    expect(appsTools.length).toBeLessThan(tools.length);
  });
});

describe("read-only /mcp/apps prod domain gate (gates 5/6)", () => {
  const OLD_ENV = process.env.NODE_ENV;
  const OLD_DOMAIN = process.env.PCC_MCP_APP_DOMAIN;

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = OLD_ENV;
    if (OLD_DOMAIN === undefined) delete process.env.PCC_MCP_APP_DOMAIN;
    else process.env.PCC_MCP_APP_DOMAIN = OLD_DOMAIN;
  });

  it("prod + placeholder domain → tools/list AND ui:// reads return a clear error", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.PCC_MCP_APP_DOMAIN; // resolveMcpAppDomain → .invalid placeholder

    const app = Fastify({ logger: false });
    await app.register(appsHttpMcpRoutes); // gateway still BOOTS (#262 stands)
    await app.ready();
    try {
      const session = await initSession(app, "/mcp/apps"); // init is not gated
      const list = await rpc(app, "/mcp/apps", session, { id: 2, method: "tools/list", params: {} });
      expect(list.body.result).toBeUndefined();
      expect(list.body.error.message).toContain("MCP App surface unavailable");

      const read = await rpc(app, "/mcp/apps", session, {
        id: 3,
        method: "resources/read",
        params: { uri: "ui://pcc/dashboard/render" },
      });
      expect(read.body.result).toBeUndefined();
      expect(read.body.error.message).toContain("MCP App surface unavailable");
    } finally {
      await app.close();
    }
  });

  it("prod + a real configured domain → the app surface WORKS", async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_MCP_APP_DOMAIN = "https://pcc-apps.example";

    const app = Fastify({ logger: false });
    await app.register(appsHttpMcpRoutes);
    await app.ready();
    try {
      const session = await initSession(app, "/mcp/apps");
      const tools = await listTools(app, "/mcp/apps", session);
      expect(toolNames(tools)).toContain("render_pcc_dashboard");
      // Still read-only even in prod.
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
});
