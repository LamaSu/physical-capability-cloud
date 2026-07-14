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
 * Registered ops under test: capability.request_quote (approval none) and
 * job.cancel (approval standard). NO financial op is registered (asserted).
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
  it("registers exactly capability.request_quote + job.cancel", () => {
    expect(registeredOperationIds().sort()).toEqual(["capability.request_quote", "job.cancel"]);
  });

  it("does NOT register escrow, job.retry, or any financial operation", () => {
    for (const id of ["escrow.release_milestone", "escrow.open_dispute", "job.retry"]) {
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

  it("job.cancel cancels an OWNED, cancellable job (real owner check, principal from token)", async () => {
    const res = await call(JOB_CANCEL, { jobId: s.aliceJob1 }, s.aliceToken);
    expect(res.isError).not.toBe(true);
    expect(getRepos().jobs.findById(s.aliceJob1)?.status).toBe("cancelled");
  });

  it("job.cancel rejects missing jobId (fail closed)", async () => {
    const res = await call(JOB_CANCEL, {}, s.aliceToken);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Invalid arguments");
  });

  it("job.cancel enforces a state guard: a terminal (completed) job cannot be cancelled", async () => {
    const res = await call(JOB_CANCEL, { jobId: s.doneJob }, s.aliceToken);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Cannot cancel");
    expect(getRepos().jobs.findById(s.doneJob)?.status).toBe("completed");
  });

  it("job.cancel returns 404-style isError for an unknown job", async () => {
    const res = await call(JOB_CANCEL, { jobId: "job-nope" }, s.aliceToken);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Job not found");
  });

  it("an unregistered pcc.op.* tool is default-DENIED (unknown operation)", async () => {
    const res = await call("pcc.op.escrow.release_milestone", { address: "0x1", milestoneIndex: 0 }, s.aliceToken);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Unknown operation");
  });
});

// ── Adversarial caveat 3: a tool argument cannot override the principal ───────

describe("[adversarial] a tool argument cannot override the derived principal", () => {
  let s: Seeded;
  beforeEach(() => { s = seed(); });
  afterEach(() => { closeStore(); vi.clearAllMocks(); });

  it("body-supplied operator/tenant/owner ids are stripped — authz uses the TOKEN's operator", async () => {
    // Bob's token, but the args LIE that the caller is Alice and even name the
    // job's real owner. The stripping projection drops every id; the principal
    // stays Bob → Bob may not cancel Alice's job → 403.
    const res = await call(
      JOB_CANCEL,
      { jobId: s.aliceJob1, operatorId: ALICE, operator: ALICE, tenantId: "alpha", owner: ALICE },
      s.bobToken,
    );
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("your own jobs");
    expect(getRepos().jobs.findById(s.aliceJob1)?.status).toBe("queued"); // untouched
  });

  it("job.cancel ignores a manifest-supplied status — it is fixed to 'cancelled'", async () => {
    // A hostile arg tries to drive an arbitrary transition; only jobId survives.
    const res = await call(JOB_CANCEL, { jobId: s.aliceJob1, status: "completed" }, s.aliceToken);
    expect(res.isError).not.toBe(true);
    expect(getRepos().jobs.findById(s.aliceJob1)?.status).toBe("cancelled");
  });

  it("a non-owner token is denied even when the args claim ownership of the kernel", async () => {
    const res = await call(JOB_CANCEL, { jobId: s.bobJob, operatorId: BOB }, s.aliceToken);
    expect(res.isError).toBe(true);
    expect(getRepos().jobs.findById(s.bobJob)?.status).toBe("queued");
  });
});

// ── Adversarial caveat 4 + 5: missing / invalid / revoked / expired → fail closed ─

describe("[adversarial] missing/invalid/revoked/expired credentials fail closed", () => {
  let s: Seeded;
  beforeEach(() => { s = seed(); });
  afterEach(() => { closeStore(); vi.clearAllMocks(); });

  it("anonymous (no token) cannot invoke a typed op", async () => {
    const res = await call(JOB_CANCEL, { jobId: s.aliceJob1 }, undefined);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Authentication required");
    // The silent-skip bug (route's `if (operatorId)`) is NOT reproduced: the job
    // stays queued because an anonymous caller is refused, not allowed through.
    expect(getRepos().jobs.findById(s.aliceJob1)?.status).toBe("queued");
  });

  it("anonymous cannot even price (request_quote requires an authenticated principal)", async () => {
    const res = await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, undefined);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Authentication required");
  });

  it("a malformed (non-pcc_) token fails closed", async () => {
    const res = await call(JOB_CANCEL, { jobId: s.aliceJob1 }, "not-a-pcc-key");
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Authentication required");
  });

  it("a well-formed but unknown token (never provisioned) fails closed", async () => {
    const { rawKey } = generateApiKey(); // valid shape, never inserted
    const res = await call(JOB_CANCEL, { jobId: s.aliceJob1 }, rawKey);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Authentication required");
  });

  it("a REVOKED key fails closed (revocation respected)", async () => {
    const { rawKey, record } = provisionApiKey({ operatorId: ALICE, name: "to-revoke" });
    // sanity: works before revocation
    const before = await call(REQUEST_QUOTE, { type: "fdm", selections: {} }, rawKey);
    expect(before.isError).not.toBe(true);
    getRepos().apiKeys.revoke(record!.id);
    const after = await call(JOB_CANCEL, { jobId: s.aliceJob1 }, rawKey);
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
    await call(JOB_CANCEL, { jobId: s.aliceJob1 }, s.aliceToken);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no error or result text ever contains the raw credential", async () => {
    const results = await Promise.all([
      call(JOB_CANCEL, { jobId: s.bobJob }, s.aliceToken), // 403
      call(JOB_CANCEL, { jobId: "nope" }, s.aliceToken), // 404
      call(JOB_CANCEL, { jobId: s.aliceJob1 }, "bad-token"), // auth-required
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
    await call(JOB_CANCEL, { jobId: s.aliceJob1 }, s.aliceToken);
    await call(JOB_CANCEL, { jobId: s.aliceJob1 }, "bad-token");
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
    expect(names).toContain("pcc.op.job.cancel");
    expect(names).toContain("render_pcc_dashboard"); // raw surface intact
  });

  it("the forwarded Authorization header reaches the handler → an authed op succeeds", async () => {
    const session = await initSession();
    const res = await callTool(session, JOB_CANCEL, { jobId: s.aliceJob1 }, s.aliceToken);
    expect(res.isError).not.toBe(true);
    expect(getRepos().jobs.findById(s.aliceJob1)?.status).toBe("cancelled");
  });

  it("with NO Authorization header the same op fails closed (anonymous cannot invoke)", async () => {
    const session = await initSession();
    const res = await callTool(session, JOB_CANCEL, { jobId: s.aliceJob1 }, undefined);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("Authentication required");
    expect(getRepos().jobs.findById(s.aliceJob1)?.status).toBe("queued");
  });

  it("TWO concurrent sessions with different credentials do not cross-contaminate principal state", async () => {
    const sessionA = await initSession();
    const sessionB = await initSession();
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

    // Session A carries Alice's key → may cancel Alice's job.
    const a = await callTool(sessionA, JOB_CANCEL, { jobId: s.aliceJob1 }, s.aliceToken);
    expect(a.isError).not.toBe(true);

    // Session B carries Bob's key → must be DENIED Alice's other job. If any
    // principal state leaked from session A, this would wrongly succeed.
    const b = await callTool(sessionB, JOB_CANCEL, { jobId: s.aliceJob2 }, s.bobToken);
    expect(b.isError).toBe(true);
    expect(b.content?.[0]?.text).toContain("your own jobs");
    expect(getRepos().jobs.findById(s.aliceJob2)?.status).toBe("queued");
  });

  it("the principal is per-REQUEST, not bound to the session: same session, different tokens", async () => {
    const session = await initSession();
    // Same transport session, first request as Bob → cancels Bob's job.
    const asBob = await callTool(session, JOB_CANCEL, { jobId: s.bobJob }, s.bobToken);
    expect(asBob.isError).not.toBe(true);
    // Same session, next request as Alice → cancels Alice's job (a stored
    // session principal would have mis-authorized one of these).
    const asAlice = await callTool(session, JOB_CANCEL, { jobId: s.aliceJob1 }, s.aliceToken);
    expect(asAlice.isError).not.toBe(true);
    // And a cross request in the same session is still denied.
    const crossed = await callTool(session, JOB_CANCEL, { jobId: s.aliceJob2 }, s.bobToken);
    expect(crossed.isError).toBe(true);
  });
});
