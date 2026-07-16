import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appsHttpMcpRoutes,
  dispatchToolCall,
  httpMcpRoutes,
  type AgentPackageTool,
} from "../mcp/http-mcp-server.js";

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
  const OLD: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    PCC_MCP_APP_DOMAIN: process.env.PCC_MCP_APP_DOMAIN,
    PCC_API_BASE_URL: process.env.PCC_API_BASE_URL,
    PCC_DEPLOYMENT_ENV: process.env.PCC_DEPLOYMENT_ENV,
  };

  // The proxy base gate runs BEFORE the domain gate; give it a valid, isolated
  // base so these tests exercise the DOMAIN gate specifically (not the base gate).
  beforeEach(() => {
    process.env.PCC_DEPLOYMENT_ENV = "staging";
    process.env.PCC_API_BASE_URL = "https://pcc-gateway-staging.up.railway.app";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(OLD)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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

// ── MCP proxy environment isolation (the data-plane base gate) ────────────────
describe("MCP proxy environment isolation (base gate)", () => {
  const KEYS = [
    "NODE_ENV", "PCC_API_BASE_URL", "PCC_DEPLOYMENT_ENV", "PCC_MCP_APP_DOMAIN", "RAILWAY_ENVIRONMENT_NAME",
  ] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const getTool = (name: string, path: string): AgentPackageTool =>
    ({ name, description: "", input_schema: {}, endpoint: { method: "GET", path } }) as AgentPackageTool;

  it("missing deployed base DISABLES both /mcp and /mcp/apps tools/list (fail closed, no prod fallback)", async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_DEPLOYMENT_ENV = "staging";
    // PCC_API_BASE_URL intentionally unset → deployed + no base → proxy disabled.

    const app = Fastify({ logger: false });
    await app.register(httpMcpRoutes);
    await app.register(appsHttpMcpRoutes);
    await app.ready();
    try {
      for (const path of ["/mcp", "/mcp/apps"]) {
        const session = await initSession(app, path); // initialize is not gated
        const list = await rpc(app, path, session, { id: 2, method: "tools/list", params: {} });
        expect(list.body.result, `${path} tools/list should be disabled`).toBeUndefined();
        // The BASE gate fires first (before the app-surface domain gate).
        expect(list.body.error.message).toMatch(/PCC_API_BASE_URL is not set|MCP proxy is disabled/i);
      }
    } finally {
      await app.close();
    }
  });

  it("forwards the bearer ONLY to the configured origin; full + read-only surfaces use the SAME base", async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_DEPLOYMENT_ENV = "staging";
    process.env.PCC_API_BASE_URL = "https://pcc-gateway-staging.up.railway.app";

    const tools = new Map([["list_kernels", getTool("list_kernels", "/api/kernels")]]);
    const seen: { origin: string; auth: string | null; readonly: string | null }[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push({
        origin: new URL(String(input)).origin,
        auth: headers.get("authorization"),
        readonly: headers.get("x-pcc-mcp-readonly"),
      });
      return new Response(JSON.stringify({ kernels: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const ctrl = new AbortController();
      await dispatchToolCall(tools, "list_kernels", {}, "test-bearer", ctrl.signal, false); // full surface
      await dispatchToolCall(tools, "list_kernels", {}, "test-bearer", ctrl.signal, true); //  read-only surface
    } finally {
      fetchSpy.mockRestore();
    }

    expect(seen.length).toBe(2);
    for (const s of seen) {
      expect(s.origin).toBe("https://pcc-gateway-staging.up.railway.app"); // same env-local base
      expect(s.auth).toBe("Bearer test-bearer"); // bearer forwarded
    }
    expect(seen.some((s) => s.origin === "https://capability.network")).toBe(false); // never prod
    expect(seen[1].readonly).toBe("1"); // read-only surface marks the call passive
  });

  it("an endpoint path cannot escape the configured origin (never reaches the network)", async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_DEPLOYMENT_ENV = "staging";
    process.env.PCC_API_BASE_URL = "https://pcc-gateway-staging.up.railway.app";

    // Protocol-relative path resolves to a FOREIGN origin against the base.
    const evil = new Map([["escaper", getTool("escaper", "//evil.example/api/kernels")]]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    try {
      const ctrl = new AbortController();
      const res = (await dispatchToolCall(evil, "escaper", {}, "t", ctrl.signal, false)) as {
        isError?: boolean; content: { text: string }[];
      };
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/escaped the configured API origin/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
