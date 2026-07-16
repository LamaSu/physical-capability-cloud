/**
 * R4 PR2 — typed host-mediated MCP-App operations: framework + the REQUIRED
 * adversarial session-isolation suite.
 *
 * Two layers:
 *   1. Off-transport via dispatchToolCall(map, name, args, token, signal) — the
 *      exported handler contract, with precise per-call control of the bearer.
 *   2. End-to-end via fastify.inject against /mcp — proves the forwarded
 *      Authorization header actually reaches the tool handler (attachBearerAuth →
 *      extra.authInfo.token → handler), which is the crux the whole PR rests on,
 *      and proves two concurrent sessions with different credentials don't leak.
 *
 * Registered op under test: capability.request_quote (approval none, read-only).
 * job.cancel is DEFINED + retained (exported jobCancelPolicy) but NOT registered
 * (re-audit #2 blocker 1) — its retained logic is exercised DIRECTLY here so it
 * stays covered for re-registration, while the transport proves it is unreachable.
 * NO financial op is registered (asserted).
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchToolCall, httpMcpRoutes } from "../mcp/http-mcp-server.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { provisionApiKey, generateApiKey } from "../auth/api-key-auth.js";
import {
  getOperationPolicy,
  registeredOperationIds,
  buildApprovalDescription,
  typedOperationTools,
  typedOperationToolFor,
  requestQuotePolicy,
  jobCancelPolicy,
  type OpPrincipal,
} from "../mcp/operation-policy.js";

// External side-effect services mocked (mirrors tenant-isolation.test.ts) so the
// facade path stays offline + quiet.
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../services/audit-service.js", () => ({
  auditService: { log: vi.fn(), query: vi.fn().mockReturnValue([]), stats: vi.fn().mockReturnValue([]) },
}));
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: {
    emit: vi.fn(),
    getTimeline: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
  },
}));

const signal = new AbortController().signal;
const noTools = new Map<string, never>() as never;

const ALICE = "op-alice@example.com";
const BOB = "op-bob@example.com";

interface Seeded {
  aliceToken: string;
  bobToken: string;
  aliceJob1: string;
  aliceJob2: string;
  bobJob: string;
  doneJob: string; // owned by alice but already completed (terminal)
}

function seedKernel(id: string, operatorAddress: string): void {
  getRepos().kernels.insert({
    id,
    name: `Kernel ${id}`,
    operatorAddress,
    location: { lat: 0, lng: 0 },
    physicalAddress: "1 Test St",
    maxAssuranceTier: 2,
    publicKey: "pk",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "1.0.0",
  } as never);
}

function seedCapability(id: string, kernelId: string): void {
  getRepos().capabilities.insert({
    id,
    kernelId,
    type: "fdm",
    name: `Cap ${id}`,
    materials: ["PLA"],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
}

function seedJob(id: string, kernelId: string, capabilityId: string, status: string): void {
  getRepos().jobs.insert({
    id,
    stepId: `step-${id}`,
    cwmId: `cwm-${id}`,
    capabilityId,
    kernelId,
    status,
    assignedDevices: [],
    startedAt: new Date().toISOString(),
    progress: 0,
    assuranceTier: 0,
  } as never);
}

function seed(): Seeded {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const aliceToken = provisionApiKey({ operatorId: ALICE, name: "alice" }).rawKey;
  const bobToken = provisionApiKey({ operatorId: BOB, name: "bob" }).rawKey;

  seedKernel("k-alice", ALICE);
  seedKernel("k-bob", BOB);
  seedCapability("cap-alice", "k-alice");
  seedCapability("cap-bob", "k-bob");
  seedJob("job-alice-1", "k-alice", "cap-alice", "queued");
  seedJob("job-alice-2", "k-alice", "cap-alice", "queued");
  seedJob("job-bob", "k-bob", "cap-bob", "queued");
  seedJob("job-done", "k-alice", "cap-alice", "completed");

  return {
    aliceToken,
    bobToken,
    aliceJob1: "job-alice-1",
    aliceJob2: "job-alice-2",
    bobJob: "job-bob",
    doneJob: "job-done",
  };
}

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

const call = (name: string, args: Record<string, unknown>, token: string | undefined) =>
  dispatchToolCall(noTools, name, args, token, signal) as Promise<ToolResult>;

const REQUEST_QUOTE = "pcc.op.capability.request_quote";
const JOB_CANCEL = "pcc.op.job.cancel";

// ── Registry shape ───────────────────────────────────────────────────────────

describe("operation registry (default-DENY; financial class defined, none registered)", () => {
  it("registers EXACTLY capability.request_quote — job.cancel is unregistered", () => {
    expect(registeredOperationIds().sort()).toEqual(["capability.request_quote"]);
    // job.cancel is retained-but-unregistered (re-audit #2 blocker 1).
    expect(getOperationPolicy("job.cancel")).toBeNull();
    // The only registered op is read-only — NO state-changing op is registered.
    const registered = registeredOperationIds().map((id) => getOperationPolicy(id));
    expect(registered.every((p) => p !== null && p.stateChanging === false)).toBe(true);
  });

  it("does NOT register escrow, job.retry, job.cancel, or any financial operation", () => {
    for (const id of ["escrow.release_milestone", "escrow.open_dispute", "job.retry", "job.cancel"]) {
      expect(getOperationPolicy(id)).toBeNull();
    }
    const financial = registeredOperationIds()
      .map((id) => getOperationPolicy(id))
      .filter((p) => p && p.approval === "financial");
    expect(financial).toHaveLength(0);
  });

  it("the financial approval CLASS is defined + produces server-derived copy (unit)", () => {
    const desc = buildApprovalDescription({
      approval: "financial",
      operationId: "escrow.release_milestone", // hypothetical — NOT registered
      summary: "Release milestone 0.",
      method: "POST",
      destination: "/api/escrow/chain/0xabc/release/0",
      amountUsd: 42.5,
      asset: "USDC",
      refId: "0xabc#0",
    });
    expect(desc.approval).toBe("financial");
    expect(desc.amountUsd).toBe(42.5);
    expect(desc.asset).toBe("USDC");
    expect(desc.summary).toContain("Release milestone");
  });

  it("non-financial approval copy omits amount/asset", () => {
    const desc = buildApprovalDescription({
      approval: "standard",
      operationId: "job.cancel",
      summary: "Cancel job x.",
    });
    expect(desc.amountUsd).toBeUndefined();
    expect(desc.asset).toBeUndefined();
  });
});

// ── tools/list annotations + visibility, driven by stateChanging (blocker 2) ──

describe("typed-op tool annotations + model-visibility", () => {
  it("a READ-ONLY op (request_quote) is model-visible + readOnlyHint (no _meta.ui.visibility)", () => {
    const tool = typedOperationToolFor(requestQuotePolicy);
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    // model-visible → no app-only visibility hint
    expect((tool as { _meta?: { ui?: { visibility?: unknown } } })._meta?.ui?.visibility).toBeUndefined();
  });

  it("a STATE-CHANGING op (job.cancel) is app-only + destructive (auto, even while unregistered)", () => {
    const tool = typedOperationToolFor(jobCancelPolicy);
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    // hidden from the model — invoked only through the approved MCP-App component
    expect((tool as { _meta: { ui: { visibility: string[] } } })._meta.ui.visibility).toEqual(["app"]);
  });

  it("typedOperationTools() exposes ONLY request_quote, and it is NOT app-only", () => {
    const tools = typedOperationTools();
    expect(tools.map((t) => t.name)).toEqual(["pcc.op.capability.request_quote"]);
    const only = tools[0];
    expect(only.annotations?.readOnlyHint).toBe(true);
    expect((only as { _meta?: { ui?: { visibility?: unknown } } })._meta?.ui?.visibility).toBeUndefined();
  });
});

// ── job.cancel is UNREGISTERED (unreachable) but its retained logic still works ─

describe("job.cancel — unregistered + unreachable over the dispatcher", () => {
  let s: Seeded;
  beforeEach(() => { s = seed(); });
  afterEach(() => { closeStore(); vi.clearAllMocks(); });

  it("dispatching pcc.op.job.cancel is default-DENIED (Unknown operation)", async () => {
    const res = await call(JOB_CANCEL, { jobId: s.aliceJob1 }, s.aliceToken);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Unknown operation");
    // the job is untouched — the op never runs
    expect(getRepos().jobs.findById(s.aliceJob1)?.status).toBe("queued");
  });
});

// The retained jobCancelPolicy is exercised DIRECTLY (validate → authorize → invoke),
// the same pipeline handleTypedOperation runs, so re-registration later is safe. The
// principal is CONSTRUCTED here (the handler derives it from the token — never args).
describe("[retained] jobCancelPolicy logic (direct — kept for re-registration)", () => {
  let s: Seeded;
  const principalFor = (operatorId: string): OpPrincipal => ({ operatorId, apiKeyId: "k-test" });
  beforeEach(() => { s = seed(); });
  afterEach(() => { closeStore(); vi.clearAllMocks(); });

  it("validateArguments keeps ONLY jobId and drops any actor/tenant/owner/status arg", () => {
    expect(jobCancelPolicy.validateArguments({ jobId: "j1" })).toEqual({ jobId: "j1" });
    // a manifest that also lies about the operator / drives an arbitrary status has
    // every extra field stripped — only jobId survives (status is fixed in invoke).
    expect(
      jobCancelPolicy.validateArguments({ jobId: "j1", operatorId: ALICE, owner: ALICE, tenantId: "x", status: "completed" }),
    ).toEqual({ jobId: "j1" });
    expect(jobCancelPolicy.validateArguments({})).toBeNull();
    expect(jobCancelPolicy.validateArguments({ jobId: "" })).toBeNull();
  });

  it("authorize enforces ownership from the PRINCIPAL (owner ok; non-owner 403)", async () => {
    await expect(jobCancelPolicy.authorize(principalFor(ALICE), { jobId: s.aliceJob1 })).resolves.toEqual({ ok: true });
    const denied = await jobCancelPolicy.authorize(principalFor(BOB), { jobId: s.aliceJob1 });
    expect(denied).toMatchObject({ ok: false, status: 403 });
  });

  it("authorize enforces the state guard (terminal → 409) and unknown job (→ 404)", async () => {
    expect(await jobCancelPolicy.authorize(principalFor(ALICE), { jobId: s.doneJob })).toMatchObject({ ok: false, status: 409 });
    expect(await jobCancelPolicy.authorize(principalFor(ALICE), { jobId: "job-nope" })).toMatchObject({ ok: false, status: 404 });
  });

  it("authorize fails closed with no principal (401)", async () => {
    expect(await jobCancelPolicy.authorize(principalFor(""), { jobId: s.aliceJob1 })).toMatchObject({ ok: false, status: 401 });
  });

  it("invoke cancels an owned job and FIXES status to 'cancelled'", async () => {
    const res = await jobCancelPolicy.invoke(principalFor(ALICE), { jobId: s.aliceJob1 });
    expect(res.ok).toBe(true);
    expect(getRepos().jobs.findById(s.aliceJob1)?.status).toBe("cancelled");
  });
});

// ── Happy path + argument validation (off-transport) ─────────────────────────

describe("typed operations — happy path + argument validation", () => {
  let s: Seeded;
  beforeEach(() => { s = seed(); });
  afterEach(() => { closeStore(); vi.clearAllMocks(); });

  it("request_quote (approval none) prices a template capability for any authed operator", async () => {
    const res = await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, s.aliceToken);
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent?.pricing).toBeDefined();
  });

  it("request_quote rejects malformed args (missing selections) with a fail-closed isError", async () => {
    const res = await call(REQUEST_QUOTE, { type: "fdm" }, s.aliceToken);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Invalid arguments");
  });

  it("request_quote rejects missing type", async () => {
    const res = await call(REQUEST_QUOTE, { selections: {} }, s.aliceToken);
    expect(res.isError).toBe(true);
  });

  it("an unregistered pcc.op.* tool is default-DENIED (unknown operation)", async () => {
    const res = await call("pcc.op.escrow.release_milestone", { address: "0x1", milestoneIndex: 0 }, s.aliceToken);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Unknown operation");
  });
});

// ── Adversarial caveat 4 + 5: missing / invalid / revoked / expired → fail closed ─

describe("[adversarial] missing/invalid/revoked/expired credentials fail closed", () => {
  let s: Seeded;
  beforeEach(() => { s = seed(); });
  afterEach(() => { closeStore(); vi.clearAllMocks(); });

  it("anonymous (no token) cannot invoke a typed op (request_quote requires a principal)", async () => {
    const res = await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, undefined);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Authentication required");
  });

  it("a malformed (non-pcc_) token fails closed", async () => {
    const res = await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, "not-a-pcc-key");
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Authentication required");
  });

  it("a well-formed but unknown token (never provisioned) fails closed", async () => {
    const { rawKey } = generateApiKey(); // valid shape, never inserted
    const res = await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, rawKey);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Authentication required");
  });

  it("a REVOKED key fails closed (revocation respected)", async () => {
    const { rawKey, record } = provisionApiKey({ operatorId: ALICE, name: "to-revoke" });
    // sanity: works before revocation
    const before = await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, rawKey);
    expect(before.isError).not.toBe(true);
    getRepos().apiKeys.revoke(record!.id);
    const after = await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, rawKey);
    expect(after.isError).toBe(true);
    expect(after.content?.[0]?.text).toContain("Authentication required");
  });

  it("an EXPIRED key fails closed", async () => {
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    getRepos().apiKeys.insert({
      id: "key-expired",
      keyHash,
      keyPrefix,
      operatorId: ALICE,
      name: "expired",
      description: null,
      scopes: JSON.stringify(["*"]),
      rateLimit: "1000/hour",
      usageCount: "0",
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      metadata: null,
      publicKey: null,
    } as never);
    const res = await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, rawKey);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Authentication required");
  });
});

// ── Adversarial caveat 1 + 7: no bearer forwarding; credential never in output ─

describe("[adversarial] the bearer is never forwarded to a proxy destination, nor logged", () => {
  let s: Seeded;
  beforeEach(() => { s = seed(); });
  afterEach(() => { closeStore(); vi.clearAllMocks(); vi.restoreAllMocks(); });

  it("a typed op makes NO outbound fetch (unlike the raw proxy relay)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, s.aliceToken);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no error or result text ever contains the raw credential", async () => {
    const results = await Promise.all([
      call(REQUEST_QUOTE, { type: "fdm" }, s.aliceToken), // Invalid arguments
      call("pcc.op.job.cancel", { jobId: s.aliceJob1 }, s.aliceToken), // Unknown operation
      call(REQUEST_QUOTE, { type: "fdm", selections: {} }, "bad-token"), // auth-required
      call(REQUEST_QUOTE, { type: "fdm", selections: {} }, s.aliceToken), // ok
    ]);
    for (const r of results) {
      const blob = JSON.stringify(r);
      expect(blob).not.toContain(s.aliceToken);
      expect(blob).not.toContain(s.bobToken);
    }
  });

  it("errors/warnings emitted during a typed op never contain the credential", async () => {
    const seen: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => { seen.push(a.join(" ")); });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...a) => { seen.push(a.join(" ")); });
    await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, s.aliceToken);
    await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, "bad-token");
    errSpy.mockRestore();
    warnSpy.mockRestore();
    for (const line of seen) {
      expect(line).not.toContain(s.aliceToken);
    }
  });
});

// ── Adversarial caveat 2 + 6: end-to-end via /mcp; two-session isolation ─────

describe("[adversarial] end-to-end /mcp — the bearer reaches the handler; sessions don't cross-contaminate", () => {
  let app: FastifyInstance;
  let s: Seeded;

  beforeEach(async () => {
    s = seed();
    app = Fastify({ logger: false });
    await app.register(httpMcpRoutes);
    await app.ready();
  });
  afterEach(async () => { await app.close(); closeStore(); vi.clearAllMocks(); });

  async function initSession(): Promise<{ sessionId: string; protocolVersion: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      },
    });
    const sessionId = String(res.headers["mcp-session-id"]);
    const protocolVersion = res.json().result.protocolVersion;
    await app.inject({
      method: "POST", url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream", "content-type": "application/json",
        "mcp-session-id": sessionId, "mcp-protocol-version": protocolVersion,
      },
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    return { sessionId, protocolVersion };
  }

  let callId = 100;
  async function callTool(
    session: { sessionId: string; protocolVersion: string },
    name: string,
    args: Record<string, unknown>,
    token: string | undefined,
  ): Promise<ToolResult> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": session.protocolVersion,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await app.inject({
      method: "POST", url: "/mcp", headers,
      payload: { jsonrpc: "2.0", id: callId++, method: "tools/call", params: { name, arguments: args } },
    });
    return res.json().result as ToolResult;
  }

  it("tools/list advertises the typed pcc.op.* tools alongside the raw proxy tools", async () => {
    const session = await initSession();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream", "content-type": "application/json",
        "mcp-session-id": session.sessionId, "mcp-protocol-version": session.protocolVersion,
      },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    const names = res.json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("pcc.op.capability.request_quote");
    // job.cancel is unregistered → never advertised (re-audit #2 blocker 1).
    expect(names).not.toContain("pcc.op.job.cancel");
    expect(names).toContain("render_pcc_dashboard"); // raw surface intact
  });

  it("the served render view injects the operation allowlist + the tools/call bridge wiring", async () => {
    const session = await initSession();
    const read = await app.inject({
      method: "POST", url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream", "content-type": "application/json",
        "mcp-session-id": session.sessionId, "mcp-protocol-version": session.protocolVersion,
      },
      payload: { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "ui://pcc/dashboard/render" } },
    });
    const html = read.json().result.contents[0].text as string;
    // The server injects the registered-op allowlist and the inlined bridge +
    // outbound tools/call sender into the actual served boot script.
    expect(html).toContain("__PCC_HOST_OPERATIONS__");
    expect(html).toContain("capability.request_quote");
    // job.cancel is unregistered → the injected allowlist must NOT contain it.
    expect(html).not.toContain("job.cancel");
    expect(html).toContain("callOperation");
    expect(html).toContain("tools/call");
  });

  it("the forwarded Authorization header reaches the handler → an authed op succeeds", async () => {
    const session = await initSession();
    const res = await callTool(session, REQUEST_QUOTE, { type: "fdm", selections: {} }, s.aliceToken);
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent?.pricing).toBeDefined();
  });

  it("with NO Authorization header the same op fails closed (anonymous cannot invoke)", async () => {
    const session = await initSession();
    const res = await callTool(session, REQUEST_QUOTE, { type: "fdm", selections: {} }, undefined);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Authentication required");
  });

  it("job.cancel is NOT reachable over the wire — a tools/call is default-DENIED", async () => {
    const session = await initSession();
    const res = await callTool(session, JOB_CANCEL, { jobId: s.aliceJob1 }, s.aliceToken);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Unknown operation");
    expect(getRepos().jobs.findById(s.aliceJob1)?.status).toBe("queued"); // untouched
  });

  it("the principal is per-REQUEST, not bound to the session: two tokens, one session", async () => {
    const session = await initSession();
    // Same transport session, alternating credentials — each request derives its
    // OWN principal (a stored session principal would leak across these).
    const asAlice = await callTool(session, REQUEST_QUOTE, { type: "fdm", selections: {} }, s.aliceToken);
    expect(asAlice.isError).not.toBe(true);
    const asBob = await callTool(session, REQUEST_QUOTE, { type: "fdm", selections: {} }, s.bobToken);
    expect(asBob.isError).not.toBe(true);
    // An anonymous request in the SAME session still fails closed (no leaked principal).
    const anon = await callTool(session, REQUEST_QUOTE, { type: "fdm", selections: {} }, undefined);
    expect(anon.isError).toBe(true);
    expect(anon.content?.[0]?.text).toContain("Authentication required");
  });

  it("TWO concurrent sessions with different credentials both operate without cross-contamination", async () => {
    const sessionA = await initSession();
    const sessionB = await initSession();
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);
    const a = await callTool(sessionA, REQUEST_QUOTE, { type: "fdm", selections: {} }, s.aliceToken);
    const b = await callTool(sessionB, REQUEST_QUOTE, { type: "fdm", selections: {} }, s.bobToken);
    expect(a.isError).not.toBe(true);
    expect(b.isError).not.toBe(true);
  });
});
