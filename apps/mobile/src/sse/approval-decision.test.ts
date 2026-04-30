/**
 * Tests for `postApprovalDecision` — the W7 A4 mobile-side decision POST.
 *
 * Coverage:
 *   - URL composition (baseUrl + sessionId + approvalId + decision)
 *   - Authorization header carries the session token as Bearer
 *   - Content-Type is application/json + body is empty {} by default
 *   - Approve happy path → 200 → success: true
 *   - Reject happy path → 200 → success: true
 *   - Custom body (e.g. signature/reason) is forwarded
 *   - Idempotent 404 → success: true (gate already resolved)
 *   - Stale 409 → success: true (approvalId mismatch)
 *   - 401 → success: false + authError: true
 *   - 5xx → success: false + status echoed
 *   - Network error → success: false + status: 0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  postApprovalDecision,
  _setFetchForTests,
} from "./approval-decision.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function mkFetch(
  responder: (call: CapturedCall) => Response | Promise<Response>,
): { fetchFn: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchFn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return responder({ url, init: init ?? {} });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  _setFetchForTests(null);
});

afterEach(() => {
  _setFetchForTests(null);
});

describe("postApprovalDecision — URL + auth", () => {
  it("POSTs to /api/sessions/:sid/approval/:aid/approve with Bearer auth + JSON body", async () => {
    const { fetchFn, calls } = mkFetch(() =>
      jsonResponse(200, { ok: true, sessionId: "sess-1", approvalId: "appr_1" }),
    );
    _setFetchForTests(fetchFn);

    const res = await postApprovalDecision({
      baseUrl: "https://capability.network",
      sessionId: "sess-1",
      approvalId: "appr_1",
      sessionToken: "token-xyz",
      decision: "approve",
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      "https://capability.network/api/sessions/sess-1/approval/appr_1/approve",
    );
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-xyz");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0].init.body).toBe("{}");
  });

  it("POSTs to /reject path when decision is reject", async () => {
    const { fetchFn, calls } = mkFetch(() => jsonResponse(200, { ok: true }));
    _setFetchForTests(fetchFn);

    await postApprovalDecision({
      baseUrl: "https://capability.network",
      sessionId: "sess-2",
      approvalId: "appr_2",
      sessionToken: "tok-2",
      decision: "reject",
    });

    expect(calls[0].url).toBe(
      "https://capability.network/api/sessions/sess-2/approval/appr_2/reject",
    );
  });

  it("trims trailing slashes from baseUrl", async () => {
    const { fetchFn, calls } = mkFetch(() => jsonResponse(200, {}));
    _setFetchForTests(fetchFn);

    await postApprovalDecision({
      baseUrl: "https://capability.network///",
      sessionId: "sess-3",
      approvalId: "appr_3",
      sessionToken: "tok",
      decision: "approve",
    });

    expect(calls[0].url).toBe(
      "https://capability.network/api/sessions/sess-3/approval/appr_3/approve",
    );
  });

  it("URL-encodes sessionId and approvalId for safety", async () => {
    const { fetchFn, calls } = mkFetch(() => jsonResponse(200, {}));
    _setFetchForTests(fetchFn);

    await postApprovalDecision({
      baseUrl: "https://capability.network",
      sessionId: "sess id with space",
      approvalId: "appr/with/slashes",
      sessionToken: "tok",
      decision: "approve",
    });

    expect(calls[0].url).toBe(
      "https://capability.network/api/sessions/sess%20id%20with%20space/approval/appr%2Fwith%2Fslashes/approve",
    );
  });

  it("forwards a custom body when provided (signature on approve)", async () => {
    const { fetchFn, calls } = mkFetch(() => jsonResponse(200, {}));
    _setFetchForTests(fetchFn);

    await postApprovalDecision({
      baseUrl: "https://capability.network",
      sessionId: "sess-sig",
      approvalId: "appr_sig",
      sessionToken: "tok",
      decision: "approve",
      body: { signature: "0xdeadbeef" },
    });

    expect(calls[0].init.body).toBe(JSON.stringify({ signature: "0xdeadbeef" }));
  });
});

describe("postApprovalDecision — status mapping", () => {
  it("treats 404 as success (gate already resolved or never registered)", async () => {
    const { fetchFn } = mkFetch(() =>
      jsonResponse(404, { error: "approval_not_found", message: "..." }),
    );
    _setFetchForTests(fetchFn);

    const res = await postApprovalDecision({
      baseUrl: "https://gw",
      sessionId: "s",
      approvalId: "a",
      sessionToken: "t",
      decision: "approve",
    });

    // Idempotent — UI dismisses anyway.
    expect(res.success).toBe(true);
    expect(res.status).toBe(404);
    expect(res.errorCode).toBe("approval_not_found");
  });

  it("treats 409 as success (stale approvalId / replay)", async () => {
    const { fetchFn } = mkFetch(() =>
      jsonResponse(409, { error: "approval_id_mismatch" }),
    );
    _setFetchForTests(fetchFn);

    const res = await postApprovalDecision({
      baseUrl: "https://gw",
      sessionId: "s",
      approvalId: "a",
      sessionToken: "t",
      decision: "approve",
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe(409);
    expect(res.errorCode).toBe("approval_id_mismatch");
  });

  it("returns authError on 401 so the caller can re-enroll", async () => {
    const { fetchFn } = mkFetch(() =>
      jsonResponse(401, { error: "unauthorized" }),
    );
    _setFetchForTests(fetchFn);

    const res = await postApprovalDecision({
      baseUrl: "https://gw",
      sessionId: "s",
      approvalId: "a",
      sessionToken: "stale-token",
      decision: "approve",
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe(401);
    expect(res.authError).toBe(true);
    expect(res.errorCode).toBe("unauthorized");
  });

  it("surfaces 5xx as failure with the status echoed", async () => {
    const { fetchFn } = mkFetch(() =>
      jsonResponse(503, { error: "internal" }),
    );
    _setFetchForTests(fetchFn);

    const res = await postApprovalDecision({
      baseUrl: "https://gw",
      sessionId: "s",
      approvalId: "a",
      sessionToken: "t",
      decision: "approve",
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe(503);
    expect(res.errorCode).toBe("internal");
  });

  it("returns success: false + status: 0 on a network error", async () => {
    const fetchFn: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    _setFetchForTests(fetchFn);

    const res = await postApprovalDecision({
      baseUrl: "https://gw",
      sessionId: "s",
      approvalId: "a",
      sessionToken: "t",
      decision: "approve",
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toMatch(/network error.*ECONNREFUSED/);
  });

  it("double-POST first/second is idempotent at the call site (200 then 404)", async () => {
    let callCount = 0;
    const { fetchFn } = mkFetch(() => {
      callCount += 1;
      return callCount === 1
        ? jsonResponse(200, { ok: true })
        : jsonResponse(404, { error: "approval_not_found" });
    });
    _setFetchForTests(fetchFn);

    const args = {
      baseUrl: "https://gw",
      sessionId: "s",
      approvalId: "a",
      sessionToken: "t",
      decision: "approve" as const,
    };
    const first = await postApprovalDecision(args);
    const second = await postApprovalDecision(args);
    expect(first.success).toBe(true);
    expect(first.status).toBe(200);
    // Second call sees a 404 from the now-resolved gate; we still report
    // success so the UI's optimistic dismissal stays correct.
    expect(second.success).toBe(true);
    expect(second.status).toBe(404);
  });
});

describe("postApprovalDecision — DI seam", () => {
  it("falls back to globalThis.fetch when no override is set", async () => {
    const calls: CapturedCall[] = [];
    const original = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init: init ?? {} });
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;

    try {
      _setFetchForTests(null); // ensure no override
      const res = await postApprovalDecision({
        baseUrl: "https://gw",
        sessionId: "s",
        approvalId: "a",
        sessionToken: "t",
        decision: "approve",
      });
      expect(res.success).toBe(true);
      expect(calls.length).toBe(1);
    } finally {
      if (original) {
        (globalThis as { fetch?: typeof fetch }).fetch = original;
      } else {
        delete (globalThis as { fetch?: typeof fetch }).fetch;
      }
    }
  });

  it("returns success: false when no fetch is available at all", async () => {
    const original = (globalThis as { fetch?: typeof fetch }).fetch;
    delete (globalThis as { fetch?: typeof fetch }).fetch;
    _setFetchForTests(null);

    try {
      const res = await postApprovalDecision({
        baseUrl: "https://gw",
        sessionId: "s",
        approvalId: "a",
        sessionToken: "t",
        decision: "approve",
      });
      expect(res.success).toBe(false);
      expect(res.status).toBe(0);
      expect(res.error).toMatch(/fetch is not available/);
    } finally {
      if (original) {
        (globalThis as { fetch?: typeof fetch }).fetch = original;
      }
      vi.restoreAllMocks();
    }
  });
});
