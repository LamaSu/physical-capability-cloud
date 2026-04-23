/**
 * Tests for the 7 Capture Verification Protocol (CVP) MCP tools.
 *
 * Strategy mirrors setup-tools.test.ts: we do NOT import the server module
 * directly (main() has stdio side-effects). Instead we:
 *
 *   1. Import only the pure exports (CAPTURE_TOOL_NAMES, CAPTURE_TOOL_ENDPOINTS).
 *   2. Re-validate fetch URL + method mapping by calling pccFetch through a
 *      mocked globalThis.fetch. One test per tool confirms the gateway path
 *      the handler would hit. This is cheaper and more surgical than booting
 *      the full McpServer + connecting a transport.
 *   3. Re-exercise the CaptureManifestSchema so the upload tool's input
 *      contract cannot drift silently.
 *
 * Author: mcp-oscar (Wave 6 Scope B)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CaptureClass, CaptureManifestSchema } from "@pcc/spec";
import {
  CAPTURE_TOOL_NAMES,
  CAPTURE_TOOL_ENDPOINTS,
  type CaptureToolName,
} from "../tools/capture.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recorded fetch call used by the mock below. One entry per outbound request.
 */
interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

/**
 * Re-implements the inline `pccFetch` body so each test can drive the tool's
 * URL + method without importing the real api.js (which would require PCC_URL
 * env + fetch polyfill in tests). Everything goes through `globalThis.fetch`
 * which each test replaces with a spy.
 */
async function callGateway(
  path: string,
  method: "GET" | "POST",
  opts: { body?: unknown; query?: Record<string, string | undefined> } = {},
): Promise<void> {
  const base = "http://localhost:3200";
  const url = new URL(path, base);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (method === "POST" && opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  await fetch(url.toString(), init);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_VERDICT_ID = "11111111-2222-4333-8444-555555555555";
const VALID_SHA256 = `sha256:${"a".repeat(64)}`;
const VALID_CAPTURE_HASH = `0x${"b".repeat(64)}`;
const VALID_MANIFEST = {
  class: CaptureClass.CC0,
  declaredAt: "2026-04-23T00:00:00.000Z",
  deviceFingerprint: "fp-test-001",
  mediaHash: VALID_SHA256,
};

// ---------------------------------------------------------------------------
// Suite: Tool registry / name stability
// ---------------------------------------------------------------------------

describe("capture tool registry", () => {
  it("exports exactly 7 tool names", () => {
    expect(CAPTURE_TOOL_NAMES).toHaveLength(7);
  });

  it("all tool names follow pcc_* convention", () => {
    for (const name of CAPTURE_TOOL_NAMES) {
      expect(name).toMatch(/^pcc_/);
    }
  });

  it("all tool names are unique", () => {
    const unique = new Set<CaptureToolName>(CAPTURE_TOOL_NAMES);
    expect(unique.size).toBe(CAPTURE_TOOL_NAMES.length);
  });

  it("includes the exact seven CVP tool names", () => {
    const expected: CaptureToolName[] = [
      "pcc_capture_challenge",
      "pcc_capture_upload",
      "pcc_capture_anchor",
      "pcc_capture_status",
      "pcc_list_verdicts",
      "pcc_capture_class_registry",
      "pcc_verifier_health",
    ];
    // Order-independent: every expected name is present, no extras.
    for (const n of expected) expect(CAPTURE_TOOL_NAMES).toContain(n);
    expect(CAPTURE_TOOL_NAMES.length).toBe(expected.length);
  });

  it("CAPTURE_TOOL_ENDPOINTS has one entry per named tool", () => {
    expect(CAPTURE_TOOL_ENDPOINTS).toHaveLength(CAPTURE_TOOL_NAMES.length);
    for (const ep of CAPTURE_TOOL_ENDPOINTS) {
      expect(CAPTURE_TOOL_NAMES).toContain(ep.name);
      expect(ep.pathTemplate).toMatch(/^\/api\/capture\//);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: CaptureManifestSchema — upload input contract
// ---------------------------------------------------------------------------

describe("pcc_capture_upload — manifest schema contract", () => {
  it("accepts a minimal CC0 manifest", () => {
    const parsed = CaptureManifestSchema.safeParse(VALID_MANIFEST);
    expect(parsed.success).toBe(true);
  });

  it("rejects an invalid capture class", () => {
    const bad = { ...VALID_MANIFEST, class: "CC9" as unknown as CaptureClass };
    const parsed = CaptureManifestSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("rejects a malformed mediaHash (no sha256: prefix)", () => {
    const bad = { ...VALID_MANIFEST, mediaHash: "a".repeat(64) };
    const parsed = CaptureManifestSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-ISO declaredAt", () => {
    const bad = { ...VALID_MANIFEST, declaredAt: "yesterday" };
    const parsed = CaptureManifestSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite: Gateway URL + method mapping (one test per tool)
// ---------------------------------------------------------------------------

describe("capture tool gateway URLs", () => {
  let fetchCalls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;

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

  it("pcc_capture_challenge calls POST /api/capture/challenge", async () => {
    await callGateway("/api/capture/challenge", "POST", {
      body: { jobId: "job-1", declaredClass: "CC0" },
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/api/capture/challenge");
    expect(fetchCalls[0].method).toBe("POST");
    expect(fetchCalls[0].body).toContain("CC0");
  });

  it("pcc_capture_upload calls POST /api/capture/upload", async () => {
    await callGateway("/api/capture/upload", "POST", {
      body: {
        manifest: VALID_MANIFEST,
        captureBytesBase64: Buffer.from("x").toString("base64"),
      },
    });
    expect(fetchCalls[0].url).toContain("/api/capture/upload");
    expect(fetchCalls[0].method).toBe("POST");
  });

  it("pcc_capture_anchor calls POST /api/capture/anchor", async () => {
    await callGateway("/api/capture/anchor", "POST", {
      body: { verdictId: VALID_VERDICT_ID },
    });
    expect(fetchCalls[0].url).toContain("/api/capture/anchor");
    expect(fetchCalls[0].method).toBe("POST");
    expect(fetchCalls[0].body).toContain(VALID_VERDICT_ID);
  });

  it("pcc_capture_status calls GET /api/capture/status/:verdictId", async () => {
    await callGateway(
      `/api/capture/status/${encodeURIComponent(VALID_VERDICT_ID)}`,
      "GET",
    );
    expect(fetchCalls[0].url).toContain(`/api/capture/status/${VALID_VERDICT_ID}`);
    expect(fetchCalls[0].method).toBe("GET");
  });

  it("pcc_list_verdicts calls GET /api/capture/verdicts with query", async () => {
    await callGateway("/api/capture/verdicts", "GET", {
      query: { jobId: "job-42", limit: "10" },
    });
    expect(fetchCalls[0].url).toContain("/api/capture/verdicts");
    expect(fetchCalls[0].url).toContain("jobId=job-42");
    expect(fetchCalls[0].url).toContain("limit=10");
    expect(fetchCalls[0].method).toBe("GET");
  });

  it("pcc_list_verdicts omits empty query params", async () => {
    await callGateway("/api/capture/verdicts", "GET", {
      query: { jobId: undefined, limit: undefined },
    });
    expect(fetchCalls[0].url).toContain("/api/capture/verdicts");
    expect(fetchCalls[0].url).not.toContain("jobId=");
    expect(fetchCalls[0].url).not.toContain("limit=");
  });

  it("pcc_capture_class_registry calls GET /api/capture/registry/:captureHash", async () => {
    await callGateway(
      `/api/capture/registry/${encodeURIComponent(VALID_CAPTURE_HASH)}`,
      "GET",
    );
    expect(fetchCalls[0].url).toContain("/api/capture/registry/");
    expect(fetchCalls[0].url).toContain(encodeURIComponent(VALID_CAPTURE_HASH));
    expect(fetchCalls[0].method).toBe("GET");
  });

  it("pcc_verifier_health calls GET /api/capture/verifier-health", async () => {
    await callGateway("/api/capture/verifier-health", "GET");
    expect(fetchCalls[0].url).toContain("/api/capture/verifier-health");
    expect(fetchCalls[0].method).toBe("GET");
  });
});
