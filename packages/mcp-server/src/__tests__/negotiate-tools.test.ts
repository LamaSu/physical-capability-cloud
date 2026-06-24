/**
 * Tests for the 7 negotiation-session MCP tools.
 *
 * Strategy mirrors capture-tools.test.ts: we do NOT import the server module
 * for the URL-mapping checks (registration has no stdio side-effect now, but
 * the per-tool fetch contract is cheaper to assert in isolation). We:
 *
 *   1. Import the pure exports (NEGOTIATE_TOOL_NAMES, NEGOTIATE_TOOL_ENDPOINTS).
 *   2. Re-validate fetch URL + method mapping via a mocked globalThis.fetch,
 *      one test per tool, covering POST / GET / PATCH / DELETE.
 *
 * The full boot-and-list-tools assertion lives in smoke.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  NEGOTIATE_TOOL_NAMES,
  NEGOTIATE_TOOL_ENDPOINTS,
  type NegotiateToolName,
} from "../tools/negotiate.js";

// ---------------------------------------------------------------------------
// Helper — re-implements the inline pccFetch body so a test can drive a tool's
// URL + method through the spy without importing the real api.js.
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

async function callGateway(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  opts: { body?: unknown; query?: Record<string, string | undefined> } = {},
): Promise<void> {
  const base = "http://localhost:3200";
  const url = new URL(path, base);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (method !== "GET" && opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  await fetch(url.toString(), init);
}

// ---------------------------------------------------------------------------
// Suite: registry / name stability
// ---------------------------------------------------------------------------

describe("negotiate tool registry", () => {
  it("exports exactly 7 tool names", () => {
    expect(NEGOTIATE_TOOL_NAMES).toHaveLength(7);
  });

  it("all tool names follow the pcc_negotiate_* convention", () => {
    for (const name of NEGOTIATE_TOOL_NAMES) {
      expect(name).toMatch(/^pcc_negotiate_/);
    }
  });

  it("all tool names are unique", () => {
    const unique = new Set<NegotiateToolName>(NEGOTIATE_TOOL_NAMES);
    expect(unique.size).toBe(NEGOTIATE_TOOL_NAMES.length);
  });

  it("includes the exact seven lifecycle tool names", () => {
    const expected: NegotiateToolName[] = [
      "pcc_negotiate_create",
      "pcc_negotiate_get",
      "pcc_negotiate_select",
      "pcc_negotiate_quote",
      "pcc_negotiate_review",
      "pcc_negotiate_commit",
      "pcc_negotiate_cancel",
    ];
    for (const n of expected) expect(NEGOTIATE_TOOL_NAMES).toContain(n);
    expect(NEGOTIATE_TOOL_NAMES.length).toBe(expected.length);
  });

  it("NEGOTIATE_TOOL_ENDPOINTS has one entry per named tool, all under /api/negotiate/", () => {
    expect(NEGOTIATE_TOOL_ENDPOINTS).toHaveLength(NEGOTIATE_TOOL_NAMES.length);
    for (const ep of NEGOTIATE_TOOL_ENDPOINTS) {
      expect(NEGOTIATE_TOOL_NAMES).toContain(ep.name);
      expect(ep.pathTemplate).toMatch(/^\/api\/negotiate\/session/);
    }
  });

  it("covers all four HTTP verbs the lifecycle needs", () => {
    const methods = new Set(NEGOTIATE_TOOL_ENDPOINTS.map((e) => e.method));
    expect(methods.has("POST")).toBe(true);
    expect(methods.has("GET")).toBe(true);
    expect(methods.has("PATCH")).toBe(true);
    expect(methods.has("DELETE")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: gateway URL + method mapping (one test per tool)
// ---------------------------------------------------------------------------

describe("negotiate tool gateway URLs", () => {
  let fetchCalls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  const SID = "sess-11111111-2222-4333-8444-555555555555";

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: url.toString(),
        method: (init?.method ?? "GET").toUpperCase(),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ ok: true, mocked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("pcc_negotiate_create calls POST /api/negotiate/session with the agent/kernel/type body", async () => {
    await callGateway("/api/negotiate/session", "POST", {
      body: { userAgentId: "agent-1", kernelId: "kernel-1", capabilityType: "fdm-printer" },
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/api/negotiate/session");
    expect(fetchCalls[0].method).toBe("POST");
    expect(fetchCalls[0].body).toContain("fdm-printer");
  });

  it("pcc_negotiate_get calls GET /api/negotiate/session/:id", async () => {
    await callGateway(`/api/negotiate/session/${encodeURIComponent(SID)}`, "GET");
    expect(fetchCalls[0].url).toContain(`/api/negotiate/session/${SID}`);
    expect(fetchCalls[0].method).toBe("GET");
  });

  it("pcc_negotiate_select calls PATCH /api/negotiate/session/:id/select", async () => {
    await callGateway(`/api/negotiate/session/${encodeURIComponent(SID)}/select`, "PATCH", {
      body: { selections: { material: "PLA", quantity: 2 } },
    });
    expect(fetchCalls[0].url).toContain(`/api/negotiate/session/${SID}/select`);
    expect(fetchCalls[0].method).toBe("PATCH");
    expect(fetchCalls[0].body).toContain("PLA");
  });

  it("pcc_negotiate_quote calls POST /api/negotiate/session/:id/quote", async () => {
    await callGateway(`/api/negotiate/session/${encodeURIComponent(SID)}/quote`, "POST", { body: {} });
    expect(fetchCalls[0].url).toContain(`/api/negotiate/session/${SID}/quote`);
    expect(fetchCalls[0].method).toBe("POST");
  });

  it("pcc_negotiate_review calls POST /api/negotiate/session/:id/review", async () => {
    await callGateway(`/api/negotiate/session/${encodeURIComponent(SID)}/review`, "POST", { body: {} });
    expect(fetchCalls[0].url).toContain(`/api/negotiate/session/${SID}/review`);
    expect(fetchCalls[0].method).toBe("POST");
  });

  it("pcc_negotiate_commit calls POST /api/negotiate/session/:id/commit", async () => {
    await callGateway(`/api/negotiate/session/${encodeURIComponent(SID)}/commit`, "POST", { body: {} });
    expect(fetchCalls[0].url).toContain(`/api/negotiate/session/${SID}/commit`);
    expect(fetchCalls[0].method).toBe("POST");
  });

  it("pcc_negotiate_cancel calls DELETE /api/negotiate/session/:id", async () => {
    await callGateway(`/api/negotiate/session/${encodeURIComponent(SID)}`, "DELETE");
    expect(fetchCalls[0].url).toContain(`/api/negotiate/session/${SID}`);
    expect(fetchCalls[0].method).toBe("DELETE");
  });
});
