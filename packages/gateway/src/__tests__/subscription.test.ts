/**
 * Tests for the Week 6 A3 channel-id subscription endpoint.
 *
 * Coverage:
 *   - POST /api/sessions/:sessionId/subscribe
 *     - 401 without auth
 *     - 201 with auth, returns opaque channelId
 *     - re-subscribe replaces prior channelId
 *     - channelId is unguessable / high-entropy (length sanity)
 *     - ttlSeconds validation
 *
 *   - publishApprovalRequest fan-out
 *     - subscriber on channel-id receives event
 *     - subscriber on session-id ALSO receives event (W5 backward compat)
 *     - both subscribers don't double-fire when one client is on both
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../auth/siwe-auth.js", () => ({
  resolveSession: vi.fn(),
}));
vi.mock("../auth/api-key-auth.js", () => ({
  resolveApiKey: vi.fn(),
}));

import {
  subscriptionRoutes,
  _resetSubscriptionStoreForTests,
  _peekSubscriptionsForTests,
  getChannelIdForSession,
  getSessionIdForChannel,
} from "../routes/subscription.js";
import {
  approvalRequestRoutes,
  publishApprovalRequest,
  _resetApprovalRequestStoreForTests,
  type ApprovalRequestPayload,
} from "../routes/approval-request.js";
import { streamHub, type StreamEvent } from "../sse/stream-hub.js";
import { resolveApiKey } from "../auth/api-key-auth.js";

const mockApiKey = resolveApiKey as ReturnType<typeof vi.fn>;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(subscriptionRoutes);
  await app.register(approvalRequestRoutes);
  await app.ready();
  return app;
}

function buildPayload(id: string): ApprovalRequestPayload {
  return {
    id,
    capability: "haircut",
    amountUsd: 32,
    operatorName: "Andre",
    evidenceHash: "abc123",
    requestedAt: new Date().toISOString(),
  };
}

describe("POST /api/sessions/:sessionId/subscribe", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetSubscriptionStoreForTests();
    _resetApprovalRequestStoreForTests();
    mockApiKey.mockReturnValue(null);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/subscribe",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("mints a fresh channelId on auth success", async () => {
    mockApiKey.mockReturnValue({ id: "key-1", operatorId: "op-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-mint-001/subscribe",
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.channelId).toBe("string");
    expect(body.sessionId).toBe("sess-mint-001");
    // 32 bytes base64url ≈ 43 chars (no padding).
    expect(body.channelId.length).toBeGreaterThanOrEqual(40);
    // Reverse lookup works.
    expect(getSessionIdForChannel(body.channelId)).toBe("sess-mint-001");
    expect(getChannelIdForSession("sess-mint-001")).toBe(body.channelId);
  });

  it("replaces the prior channelId on re-subscribe", async () => {
    mockApiKey.mockReturnValue({ id: "key-1", operatorId: "op-1" });
    const first = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-rs/subscribe",
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    const firstId = first.json().channelId as string;

    const second = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-rs/subscribe",
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    const secondId = second.json().channelId as string;
    expect(secondId).not.toBe(firstId);
    expect(getChannelIdForSession("sess-rs")).toBe(secondId);
    // Old channelId is no longer registered.
    expect(getSessionIdForChannel(firstId)).toBeNull();

    // Subscription map only holds 1 entry per session.
    const peek = _peekSubscriptionsForTests();
    expect(peek.bySession).toBe(1);
    expect(peek.byChannel).toBe(1);
  });

  it("channelId entropy: 100 mints all unique", async () => {
    mockApiKey.mockReturnValue({ id: "key-1", operatorId: "op-1" });
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/sess-entropy-${i}/subscribe`,
        headers: { authorization: "Bearer pcc_live_test" },
        payload: {},
      });
      seen.add(res.json().channelId);
    }
    expect(seen.size).toBe(100);
  });

  it("rejects negative ttl with 400", async () => {
    mockApiKey.mockReturnValue({ id: "key-1", operatorId: "op-1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-bad-ttl/subscribe",
      headers: { authorization: "Bearer pcc_live_test" },
      payload: { ttlSeconds: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_ttl");
  });

  it("expired subscriptions return null from getChannelIdForSession", async () => {
    mockApiKey.mockReturnValue({ id: "key-1", operatorId: "op-1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-ttl/subscribe",
      headers: { authorization: "Bearer pcc_live_test" },
      payload: { ttlSeconds: 0.001 }, // 1ms — already expired
    });
    expect(res.statusCode).toBe(201);
    // Wait past the TTL.
    await new Promise((r) => setTimeout(r, 5));
    expect(getChannelIdForSession("sess-ttl")).toBeNull();
  });
});

describe("publishApprovalRequest fan-out (W6 A3)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetSubscriptionStoreForTests();
    _resetApprovalRequestStoreForTests();
    mockApiKey.mockReturnValue({ id: "key-1", operatorId: "op-1" });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("a session-id subscriber gets the event when no channel-id subscription exists (W5 backward compat)", () => {
    const seen: StreamEvent[] = [];
    const unsub = streamHub.subscribe(
      [{ type: "approval", id: "sess-fb-001" }],
      (e) => seen.push(e),
    );
    publishApprovalRequest(buildPayload("sess-fb-001"), {
      apiKeyId: null,
      operatorId: null,
    });
    expect(seen.length).toBe(1);
    unsub();
  });

  it("a channel-id subscriber gets the event after subscribe + publish", async () => {
    const subRes = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-ch-001/subscribe",
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    const channelId = subRes.json().channelId as string;

    const seen: StreamEvent[] = [];
    const unsub = streamHub.subscribe(
      [{ type: "approval", id: channelId }],
      (e) => seen.push(e),
    );
    publishApprovalRequest(buildPayload("sess-ch-001"), {
      apiKeyId: null,
      operatorId: null,
    });
    expect(seen.length).toBe(1);
    expect(
      (seen[0].payload as ApprovalRequestPayload).id,
    ).toBe("sess-ch-001");
    unsub();
  });

  it("BOTH session-id and channel-id subscribers receive the event (dual publish)", async () => {
    const subRes = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-dual/subscribe",
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    const channelId = subRes.json().channelId as string;

    const sessionSeen: StreamEvent[] = [];
    const channelSeen: StreamEvent[] = [];
    const unsubA = streamHub.subscribe(
      [{ type: "approval", id: "sess-dual" }],
      (e) => sessionSeen.push(e),
    );
    const unsubB = streamHub.subscribe(
      [{ type: "approval", id: channelId }],
      (e) => channelSeen.push(e),
    );
    publishApprovalRequest(buildPayload("sess-dual"), {
      apiKeyId: null,
      operatorId: null,
    });
    expect(sessionSeen.length).toBe(1);
    expect(channelSeen.length).toBe(1);
    unsubA();
    unsubB();
  });

  it("a single client subscribed to BOTH topics still gets one event (deduplicated)", async () => {
    const subRes = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-dedup/subscribe",
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    const channelId = subRes.json().channelId as string;

    const seen: StreamEvent[] = [];
    const cb = (e: StreamEvent) => seen.push(e);
    // One callback subscribing to both topics — streamHub dedups via
    // `notified` set inside publish().
    const unsub = streamHub.subscribe(
      [
        { type: "approval", id: "sess-dedup" },
        { type: "approval", id: channelId },
      ],
      cb,
    );
    publishApprovalRequest(buildPayload("sess-dedup"), {
      apiKeyId: null,
      operatorId: null,
    });
    expect(seen.length).toBe(1);
    unsub();
  });
});
