/**
 * Tests for resolveSSEAuth — SSE authentication helper.
 *
 * resolveSession and resolveApiKey are mocked so no DB / viem is needed.
 * The SSE_AUTH_REQUIRED env variable is toggled per test group.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the module under test so that
// vi.mock() hoisting applies them at module load time.
// ---------------------------------------------------------------------------

vi.mock("../auth/siwe-auth.js", () => ({
  resolveSession: vi.fn(),
}));

vi.mock("../auth/api-key-auth.js", () => ({
  resolveApiKey: vi.fn(),
}));

import { resolveSSEAuth } from "../sse/sse-auth.js";
import { resolveSession } from "../auth/siwe-auth.js";
import { resolveApiKey } from "../auth/api-key-auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal FastifyRequest-like object */
function makeReq(opts: {
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}): {
  cookies?: Record<string, string>;
  headers: Record<string, string>;
  query: Record<string, string>;
  userId: null;
  apiKeyId: null;
  operatorId: null;
} {
  return {
    cookies: opts.cookies,
    headers: opts.headers ?? {},
    query: opts.query ?? {},
    userId: null,
    apiKeyId: null,
    operatorId: null,
  };
}

const mockSession = resolveSession as ReturnType<typeof vi.fn>;
const mockApiKey = resolveApiKey as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("resolveSSEAuth — SSE_AUTH_REQUIRED=false (default)", () => {
  beforeEach(() => {
    delete process.env.SSE_AUTH_REQUIRED;
    mockSession.mockReturnValue(null);
    mockApiKey.mockReturnValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.SSE_AUTH_REQUIRED;
  });

  it("returns authenticated:true with no credentials when auth is not required", async () => {
    const req = makeReq({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveSSEAuth(req as any);
    expect(result.authenticated).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("still sets userId from a valid session cookie even when auth is not required", async () => {
    const req = makeReq({ cookies: { pcc_session: "tok123" } });
    mockSession.mockReturnValue({ address: "0xABCDEF", token: "tok123" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveSSEAuth(req as any);
    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("0xABCDEF");
  });
});

describe("resolveSSEAuth — SSE_AUTH_REQUIRED=true", () => {
  beforeEach(() => {
    process.env.SSE_AUTH_REQUIRED = "true";
    mockSession.mockReturnValue(null);
    mockApiKey.mockReturnValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.SSE_AUTH_REQUIRED;
  });

  it("returns authenticated:false with reason when no credentials provided", async () => {
    const req = makeReq({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveSSEAuth(req as any);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toMatch(/SSE authentication required/i);
  });

  it("authenticates via pcc_session cookie (SIWE session)", async () => {
    const req = makeReq({ cookies: { pcc_session: "valid-session-token" } });
    mockSession.mockReturnValue({ address: "0x1234567890abcdef", token: "valid-session-token" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveSSEAuth(req as any);
    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("0x1234567890abcdef");
  });

  it("authenticates via Authorization: Bearer <api-key>", async () => {
    const req = makeReq({ headers: { authorization: "Bearer pcc_live_abc123" } });
    mockApiKey.mockReturnValue({ id: "key-1", operatorId: "op-1" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveSSEAuth(req as any);
    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("op-1");
  });

  it("rejects ?token= query param containing a long-lived API key (logged leak risk)", async () => {
    // R3-04 security: pcc_live_* / pcc_test_* API keys are refused in the
    // query string because proxies/CDNs/access logs can record query strings.
    // Callers must use Authorization: Bearer header instead.
    const req = makeReq({ query: { token: "pcc_live_querytoken" } });
    mockApiKey.mockReturnValue({ id: "key-2", operatorId: "op-2" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveSSEAuth(req as any);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toMatch(/API keys must be passed via Authorization/i);
    // Sanity: the API-key resolver must not even be consulted because the
    // prefix check short-circuits before the synthetic Bearer is built.
    expect(mockApiKey).not.toHaveBeenCalled();
  });

  it("authenticates via ?token= query param as SIWE session token", async () => {
    const req = makeReq({ query: { token: "session-tok-abc" } });
    // API key lookup returns null; session lookup returns a valid address
    mockApiKey.mockReturnValue(null);
    mockSession.mockReturnValue({ address: "0xdeadbeef", token: "session-tok-abc" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveSSEAuth(req as any);
    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("0xdeadbeef");
  });

  it("sets req.apiKeyId, req.operatorId, req.userId on successful API key auth", async () => {
    const req = makeReq({ headers: { authorization: "Bearer pcc_live_mutationtest" } });
    mockApiKey.mockReturnValue({ id: "key-3", operatorId: "operator-wallet-address" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resolveSSEAuth(req as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((req as any).apiKeyId).toBe("key-3");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((req as any).operatorId).toBe("operator-wallet-address");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((req as any).userId).toBe("operator-wallet-address");
  });

  it("sets req.userId on successful SIWE session auth", async () => {
    const req = makeReq({ cookies: { pcc_session: "session-xyz" } });
    mockSession.mockReturnValue({ address: "0xcafebabe", token: "session-xyz" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resolveSSEAuth(req as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((req as any).userId).toBe("0xcafebabe");
  });

  it("returns authenticated:false when expired/invalid API key provided in header", async () => {
    const req = makeReq({ headers: { authorization: "Bearer pcc_live_expired" } });
    // Both resolvers return null = invalid/expired key
    mockApiKey.mockReturnValue(null);
    mockSession.mockReturnValue(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveSSEAuth(req as any);
    expect(result.authenticated).toBe(false);
  });

  it("returns authenticated:false when ?token= resolves nothing", async () => {
    const req = makeReq({ query: { token: "bad-token" } });
    mockApiKey.mockReturnValue(null);
    mockSession.mockReturnValue(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveSSEAuth(req as any);
    expect(result.authenticated).toBe(false);
  });
});

describe("resolveSSEAuth — SSE_AUTH_REQUIRED truthy variants", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.SSE_AUTH_REQUIRED;
  });

  it.each(["1", "yes"])('treats SSE_AUTH_REQUIRED="%s" as enabled', async (val) => {
    process.env.SSE_AUTH_REQUIRED = val;
    mockSession.mockReturnValue(null);
    mockApiKey.mockReturnValue(null);

    const req = makeReq({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveSSEAuth(req as any);
    expect(result.authenticated).toBe(false);
  });

  it.each(["false", "0", ""])('treats SSE_AUTH_REQUIRED="%s" as disabled', async (val) => {
    process.env.SSE_AUTH_REQUIRED = val;
    mockSession.mockReturnValue(null);
    mockApiKey.mockReturnValue(null);

    const req = makeReq({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveSSEAuth(req as any);
    expect(result.authenticated).toBe(true);
  });
});
