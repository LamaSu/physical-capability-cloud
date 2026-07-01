/**
 * Smoke test — boots the REAL PCC MCP server in-process over an in-memory
 * transport, connects a real MCP Client, and exercises the protocol the way a
 * client (Claude Desktop, Cursor, ChatGPT, Goose) would:
 *
 *   1. tools/list returns the full catalog.
 *   2. The four core agent-facing groups the distribution lever depends on are
 *      all present: capability discovery, build/quote, negotiate, escrow status.
 *   3. Every tool has a usable description + object input schema (so clients
 *      can render and call them).
 *   4. tools/call actually dispatches a tool's handler to the gateway (mocked),
 *      proving the wiring end-to-end — not just registration.
 *
 * This is the install-readiness gate: if this passes, the package is a working
 * MCP server, not just a bag of functions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "../index.js";

// The core agent-facing surface the task pins as the distribution lever.
const CORE_TOOLS: Record<string, string[]> = {
  "capability discovery": ["pcc_list_capabilities", "pcc_search_capabilities"],
  "build / quote": ["pcc_build_options", "pcc_calculate_price", "pcc_build_contract"],
  negotiate: [
    "pcc_negotiate_create",
    "pcc_negotiate_get",
    "pcc_negotiate_select",
    "pcc_negotiate_quote",
    "pcc_negotiate_review",
    "pcc_negotiate_commit",
    "pcc_negotiate_cancel",
  ],
  "escrow status": ["pcc_list_escrows", "pcc_get_escrow", "pcc_get_escrow_events"],
};

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "pcc-smoke", version: "0.0.0" });
  // Connect the server first so it can answer the client's initialize handshake.
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

describe("PCC MCP server — boot + catalog", () => {
  it("boots and answers tools/list with a non-trivial catalog", async () => {
    const { tools } = await client.listTools();
    // The server registers ~70 tools; assert a healthy floor, not an exact count
    // (so adding tools later doesn't break the smoke gate).
    expect(tools.length).toBeGreaterThanOrEqual(40);
  });

  it("exposes every CORE agent-facing tool group", async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    const missing: string[] = [];
    for (const [, toolNames] of Object.entries(CORE_TOOLS)) {
      for (const n of toolNames) if (!names.has(n)) missing.push(n);
    }
    expect(missing, `missing core tools: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every tool a usable description and object input schema", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect((t.description ?? "").length).toBeGreaterThan(10);
      expect(t.inputSchema).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("emits no duplicate tool names", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("PCC MCP server — tool dispatch (mocked gateway)", () => {
  let calls: Array<{ url: string; method: string; body?: string }> = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: (init?.method ?? "GET").toUpperCase(),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ types: ["fdm-printer", "cnc-3axis"], ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("tools/call pcc_list_capabilities → GET /api/capabilities/types, content returned", async () => {
    const res = await client.callTool({ name: "pcc_list_capabilities", arguments: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/capabilities/types");
    expect(calls[0].method).toBe("GET");
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("fdm-printer");
  });

  it("tools/call pcc_negotiate_create → POST /api/negotiate/session with body", async () => {
    await client.callTool({
      name: "pcc_negotiate_create",
      arguments: { userAgentId: "agent-1", kernelId: "kernel-1", capabilityType: "fdm-printer" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/negotiate/session");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toContain("kernel-1");
  });

  it("tools/call pcc_get_escrow → GET /api/escrow/:id (settlement status)", async () => {
    await client.callTool({ name: "pcc_get_escrow", arguments: { escrowId: "escrow-abc" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/escrow/escrow-abc");
    expect(calls[0].method).toBe("GET");
  });
});
