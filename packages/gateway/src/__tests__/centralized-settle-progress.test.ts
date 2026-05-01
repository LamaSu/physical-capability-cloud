/**
 * Tests for Week 9 Track A — settle-progress SSE events.
 *
 * The centralized-settle path now emits `settle-progress` events on the
 * existing `approval` topic at four phase boundaries:
 *
 *   release    → 0.25  (after ledger.release)
 *   sign       → 0.50  (after signed receipt composed)
 *   log_append → 0.75  (after log.append returns)
 *   done       → 1.0   (just before reply.send returns)
 *
 * These events ONLY fire for gated settles (those that fired the
 * approval gate). Un-gated settles return synchronously so the events
 * would just race the HTTP response.
 *
 * Coverage:
 *   - Happy gated path: 4 events fire in order with correct phases + progress
 *   - Skip path: un-gated settle fires NO settle-progress events
 *   - Reject path: rejected gate emits NO progress events (the settle short-circuits)
 *   - Channel-id dual publish: when a subscription exists, events fan out to both
 *     session-id AND channel-id topics
 *   - Event payload shape: id, phase, progress all present
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
  centralizedSettleRoutes,
  resetCentralizedSettleStateForTests,
  seedSettleableSessionForTests,
  type SettleableSession,
  type SettleProgressPayload,
} from "../routes/centralized-settle.js";
import {
  approvalRequestRoutes,
  _resetApprovalRequestStoreForTests,
} from "../routes/approval-request.js";
import {
  subscriptionRoutes,
  _resetSubscriptionStoreForTests,
} from "../routes/subscription.js";
import { streamHub, type StreamEvent } from "../sse/stream-hub.js";
import { resolveApiKey } from "../auth/api-key-auth.js";

const mockApiKey = resolveApiKey as ReturnType<typeof vi.fn>;

const baseSession: SettleableSession = {
  id: "sess-w9-prog-base",
  state: "committed",
  user: { id: "user-alice", kind: "user" },
  operator: { id: "operator-bob", kind: "operator" },
  amountCents: 12500,
  capability: "fdm-3d-printing",
  actorsHashed: { user: "11".repeat(32), operator: "22".repeat(32) },
  operatorName: "Bob's 3D Workshop",
  requiresApproval: true,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(centralizedSettleRoutes);
  await app.register(approvalRequestRoutes);
  await app.register(subscriptionRoutes);
  await app.ready();
  return app;
}

/** Subscribe to the approval topic for a session and capture events. */
function subscribeApproval(sessionId: string): {
  events: StreamEvent[];
  unsubscribe: () => void;
} {
  const events: StreamEvent[] = [];
  const unsubscribe = streamHub.subscribe(
    [{ type: "approval", id: sessionId }],
    (e) => events.push(e),
  );
  return { events, unsubscribe };
}

/** Pull the approvalId from the most recent approval-request event. */
function approvalIdOf(events: StreamEvent[]): string {
  const evt = events.find((e) => e.type === "approval-request");
  if (!evt) throw new Error("no approval-request event captured");
  const payload = evt.payload as { approvalId?: string };
  if (!payload.approvalId) throw new Error("approvalId missing from event");
  return payload.approvalId;
}

/** Wait for a specific event type to arrive in the captured buffer. */
async function waitForEvent(
  events: StreamEvent[],
  type: string,
  timeoutMs = 200,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (events.find((e) => e.type === type)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Centralized settle — settle-progress events (Week 9 A)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetCentralizedSettleStateForTests();
    _resetApprovalRequestStoreForTests();
    _resetSubscriptionStoreForTests();
    delete process.env.APPROVAL_TIMEOUT_MS;
    delete process.env.APPROVAL_THRESHOLD_USD;
    mockApiKey.mockReturnValue({ id: "key-1", operatorId: "op-1" });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  // ── Gated happy path: all 4 events fire in order ─────────────────────

  it("gated settle fires 4 settle-progress events in order: release, sign, log_append, done", async () => {
    const session: SettleableSession = { ...baseSession, id: "sess-prog-happy" };
    seedSettleableSessionForTests(session);
    const { events, unsubscribe } = subscribeApproval(session.id);

    const settlePromise = app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: { evidenceHash: "ab".repeat(32) },
    });

    await waitForEvent(events, "approval-request");
    const approvalId = approvalIdOf(events);

    // Approve to release the gate; the settle pipeline runs.
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approval/${approvalId}/approve`,
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });

    const settleRes = await settlePromise;
    expect(settleRes.statusCode).toBe(200);

    // Filter to just the settle-progress events.
    const progressEvents = events.filter((e) => e.type === "settle-progress");
    expect(progressEvents.length).toBe(4);

    const phases = progressEvents.map(
      (e) => (e.payload as SettleProgressPayload).phase,
    );
    expect(phases).toEqual(["release", "sign", "log_append", "done"]);

    const progresses = progressEvents.map(
      (e) => (e.payload as SettleProgressPayload).progress,
    );
    expect(progresses).toEqual([0.25, 0.5, 0.75, 1.0]);

    // Each event's payload carries the session id.
    for (const e of progressEvents) {
      expect((e.payload as SettleProgressPayload).id).toBe(session.id);
    }

    unsubscribe();
  });

  // ── Skip path: un-gated settle fires NO progress events ──────────────

  it("un-gated settle (requiresApproval=false) does NOT fire settle-progress events", async () => {
    const session: SettleableSession = {
      ...baseSession,
      id: "sess-prog-ungated",
      requiresApproval: false,
    };
    seedSettleableSessionForTests(session);
    const { events, unsubscribe } = subscribeApproval(session.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const progressEvents = events.filter((e) => e.type === "settle-progress");
    expect(progressEvents.length).toBe(0);

    unsubscribe();
  });

  // ── Reject path: gate rejection short-circuits before any progress event

  it("rejected gate emits NO settle-progress events (settle short-circuits before release)", async () => {
    const session: SettleableSession = { ...baseSession, id: "sess-prog-reject" };
    seedSettleableSessionForTests(session);
    const { events, unsubscribe } = subscribeApproval(session.id);

    const settlePromise = app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });

    await waitForEvent(events, "approval-request");
    const approvalId = approvalIdOf(events);

    // Reject the gate.
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approval/${approvalId}/reject`,
      headers: { authorization: "Bearer pcc_live_test" },
      payload: { reason: "user changed mind" },
    });

    const settleRes = await settlePromise;
    expect(settleRes.statusCode).toBe(403);

    // No progress events — settle short-circuited before release.
    const progressEvents = events.filter((e) => e.type === "settle-progress");
    expect(progressEvents.length).toBe(0);

    unsubscribe();
  });

  // ── Payload shape ────────────────────────────────────────────────────

  it("each settle-progress event payload carries id, phase, progress", async () => {
    const session: SettleableSession = { ...baseSession, id: "sess-prog-shape" };
    seedSettleableSessionForTests(session);
    const { events, unsubscribe } = subscribeApproval(session.id);

    const settlePromise = app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });
    await waitForEvent(events, "approval-request");
    const approvalId = approvalIdOf(events);
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approval/${approvalId}/approve`,
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    await settlePromise;

    const progressEvents = events.filter((e) => e.type === "settle-progress");
    expect(progressEvents.length).toBe(4);
    for (const e of progressEvents) {
      const p = e.payload as SettleProgressPayload;
      expect(typeof p.id).toBe("string");
      expect(p.id).toBe(session.id);
      expect(typeof p.phase).toBe("string");
      expect(typeof p.progress).toBe("number");
      expect(p.progress).toBeGreaterThanOrEqual(0);
      expect(p.progress).toBeLessThanOrEqual(1);
    }
    unsubscribe();
  });

  // ── Channel-id dual publish ──────────────────────────────────────────
  //
  // When a mobile has POSTed to /api/sessions/:id/subscribe and minted a
  // channelId, the publishSettleProgress dual-publishes to BOTH the
  // session-id AND channel-id topics — same pattern as W6 A3
  // publishApprovalRequest.

  it("dual-publishes settle-progress to both session-id and channel-id topics when subscription exists", async () => {
    const session: SettleableSession = { ...baseSession, id: "sess-prog-dual" };
    seedSettleableSessionForTests(session);

    // Mint a channel-id by calling subscribe.
    const subscribeRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/subscribe`,
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    expect(subscribeRes.statusCode).toBe(201);
    const channelId = subscribeRes.json().channelId as string;
    expect(typeof channelId).toBe("string");
    expect(channelId.length).toBeGreaterThan(0);

    // Subscribe to BOTH topics.
    const sessionEvents = subscribeApproval(session.id);
    const channelEvents = subscribeApproval(channelId);

    // Drive a gated settle through to completion.
    const settlePromise = app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });
    await waitForEvent(sessionEvents.events, "approval-request");
    const approvalId = approvalIdOf(sessionEvents.events);
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approval/${approvalId}/approve`,
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    await settlePromise;

    const sessionProgress = sessionEvents.events.filter(
      (e) => e.type === "settle-progress",
    );
    const channelProgress = channelEvents.events.filter(
      (e) => e.type === "settle-progress",
    );

    // Both surfaces see all 4 events.
    expect(sessionProgress.length).toBe(4);
    expect(channelProgress.length).toBe(4);

    // Same phase ladder on both surfaces.
    const sessionPhases = sessionProgress.map(
      (e) => (e.payload as SettleProgressPayload).phase,
    );
    const channelPhases = channelProgress.map(
      (e) => (e.payload as SettleProgressPayload).phase,
    );
    expect(sessionPhases).toEqual(["release", "sign", "log_append", "done"]);
    expect(channelPhases).toEqual(["release", "sign", "log_append", "done"]);

    sessionEvents.unsubscribe();
    channelEvents.unsubscribe();
  });
});
