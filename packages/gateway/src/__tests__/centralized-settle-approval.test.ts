/**
 * Tests for the Week 6 A2 wiring: centralized-settle now optionally fires
 * an approval-request and blocks until the user POSTs an approve/reject
 * (or the timeout fires). Covers:
 *
 *   - happy path: requiresApproval=true → fires SSE event → approve →
 *     settles normally
 *   - reject path: same setup, reject → 403 settle_rejected, no ledger move
 *   - timeout path: same setup, no decision → 408 approval_timeout
 *   - skip path: requiresApproval omitted/false → settles immediately,
 *     no SSE event fired
 *   - no-subscriber path: requiresApproval=true but no SSE listener →
 *     503 no_subscriber, no SSE event published, no ledger move
 *   - approve idempotency: a second POST /approve after the first returns
 *     404 (gate already resolved)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// Auth mocks — same pattern as approval-sse.test.ts. We don't want to
// hit the real DB-backed key/session repos; the gate logic itself is
// what we're testing.
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
  getLedgerSnapshotForTests,
  type SettleableSession,
} from "../routes/centralized-settle.js";
import {
  approvalRequestRoutes,
  _resetApprovalRequestStoreForTests,
  _getApprovalGateIdForTests,
} from "../routes/approval-request.js";
import { streamHub, type StreamEvent } from "../sse/stream-hub.js";
import { resolveApiKey } from "../auth/api-key-auth.js";

const mockApiKey = resolveApiKey as ReturnType<typeof vi.fn>;

const baseSession: SettleableSession = {
  id: "sess-w6-a2-001",
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
  await app.ready();
  return app;
}

/**
 * Subscribe to the approval topic for a session and capture events. The
 * gate publishes through streamHub the same way the W5 publish endpoint
 * does, so test-side subscription is enough to drive subscriberCount > 0.
 */
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

/**
 * Poll for the approval-request event to land. Fastify's inject() is
 * async-deep — `setImmediate` once isn't always enough on Windows runners
 * because of the async wrapping in the routing layer. Up to 50ms of
 * polling before we give up.
 */
async function waitForApprovalEvent(
  events: StreamEvent[],
  timeoutMs = 200,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (events.find((e) => e.type === "approval-request")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Centralized settle — A2 approval gate (Week 6)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetCentralizedSettleStateForTests();
    _resetApprovalRequestStoreForTests();
    delete process.env.APPROVAL_TIMEOUT_MS;
    delete process.env.APPROVAL_THRESHOLD_USD;
    // Auth: every approve/reject call uses Bearer pcc_live_test which the
    // mocked resolveApiKey accepts.
    mockApiKey.mockReturnValue({ id: "key-1", operatorId: "op-1" });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  // ── Happy path: approve resolves the gate, settle proceeds ───────────

  it("requiresApproval=true + approve → settles normally and pays operator", async () => {
    const session: SettleableSession = { ...baseSession, id: "sess-happy" };
    seedSettleableSessionForTests(session);
    const { events, unsubscribe } = subscribeApproval(session.id);

    // Fire the settle in the background; it will park on awaitApprovalDecision.
    const settlePromise = app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: { evidenceHash: "ab".repeat(32) },
    });

    // Wait a tick for the gate to register + the SSE event to publish.
    // Wait long enough for fastify routing + the handler's await to land.
    await waitForApprovalEvent(events);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("approval-request");
    const approvalId = approvalIdOf(events);
    expect(_getApprovalGateIdForTests(session.id)).toBe(approvalId);

    // User approves.
    const approveRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approval/${approvalId}/approve`,
      headers: { authorization: "Bearer pcc_live_test" },
      payload: { signature: "sig-bytes" },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().ok).toBe(true);

    // The settle should now have proceeded.
    const settleRes = await settlePromise;
    expect(settleRes.statusCode).toBe(200);
    const body = settleRes.json();
    expect(body.signedReceipt).toBeDefined();
    expect(body.merklePath).toBeDefined();

    // Ledger moved.
    const snap = getLedgerSnapshotForTests();
    expect(snap[`acct:escrow:${session.id}`]).toBe(0);
    expect(snap[`acct:operator:${session.operator.id}`]).toBe(
      session.amountCents,
    );

    // Gate cleaned up.
    expect(_getApprovalGateIdForTests(session.id)).toBeNull();

    unsubscribe();
  });

  // ── Reject path: 403 + no ledger move ────────────────────────────────

  it("requiresApproval=true + reject → 403 and no ledger movement", async () => {
    const session: SettleableSession = { ...baseSession, id: "sess-reject" };
    seedSettleableSessionForTests(session);
    const { events, unsubscribe } = subscribeApproval(session.id);

    const settlePromise = app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });
    // Wait long enough for fastify routing + the handler's await to land.
    await waitForApprovalEvent(events);
    const approvalId = approvalIdOf(events);

    const rejectRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approval/${approvalId}/reject`,
      headers: { authorization: "Bearer pcc_live_test" },
      payload: { reason: "user changed mind" },
    });
    expect(rejectRes.statusCode).toBe(200);

    const settleRes = await settlePromise;
    expect(settleRes.statusCode).toBe(403);
    expect(settleRes.json().error).toBe("settle_rejected");
    expect(settleRes.json().reason).toBe("user changed mind");

    // Escrow still locked, operator unpaid.
    const snap = getLedgerSnapshotForTests();
    expect(snap[`acct:escrow:${session.id}`]).toBe(session.amountCents);
    expect(
      snap[`acct:operator:${session.operator.id}`] ?? 0,
    ).toBe(0);

    unsubscribe();
  });

  // ── Timeout path: 408 with no user action ────────────────────────────

  it("requiresApproval=true + no decision before timeout → 408 approval_timeout", async () => {
    process.env.APPROVAL_TIMEOUT_MS = "20"; // 20ms — fast
    const session: SettleableSession = { ...baseSession, id: "sess-timeout" };
    seedSettleableSessionForTests(session);
    const { unsubscribe } = subscribeApproval(session.id);

    const settleRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });
    expect(settleRes.statusCode).toBe(408);
    expect(settleRes.json().error).toBe("approval_timeout");

    // Ledger unchanged.
    const snap = getLedgerSnapshotForTests();
    expect(snap[`acct:escrow:${session.id}`]).toBe(session.amountCents);
    expect(_getApprovalGateIdForTests(session.id)).toBeNull();

    unsubscribe();
  });

  // ── Skip path: no requiresApproval → settles synchronously ───────────

  it("requiresApproval omitted → settles synchronously without firing SSE", async () => {
    const session: SettleableSession = {
      ...baseSession,
      id: "sess-no-approval",
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
    expect(res.json().signedReceipt).toBeDefined();

    // No approval-request event fired.
    expect(events.find((e) => e.type === "approval-request")).toBeUndefined();

    unsubscribe();
  });

  // ── No-subscriber path: 503 ──────────────────────────────────────────

  it("requiresApproval=true + 0 SSE subscribers → 503 no_subscriber", async () => {
    const session: SettleableSession = {
      ...baseSession,
      id: "sess-no-listener",
    };
    seedSettleableSessionForTests(session);
    // intentionally NOT subscribing

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("no_subscriber");

    // Gate not registered, ledger unchanged.
    expect(_getApprovalGateIdForTests(session.id)).toBeNull();
    const snap = getLedgerSnapshotForTests();
    expect(snap[`acct:escrow:${session.id}`]).toBe(session.amountCents);
  });

  // ── Idempotency: double-approve returns 404 second time ──────────────

  it("approving twice with the same id returns 404 second time (gate already resolved)", async () => {
    const session: SettleableSession = { ...baseSession, id: "sess-double" };
    seedSettleableSessionForTests(session);
    const { events, unsubscribe } = subscribeApproval(session.id);

    const settlePromise = app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });
    // Wait long enough for fastify routing + the handler's await to land.
    await waitForApprovalEvent(events);
    const approvalId = approvalIdOf(events);

    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approval/${approvalId}/approve`,
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    await settlePromise; // drain settle

    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approval/${approvalId}/approve`,
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error).toBe("approval_not_found");

    unsubscribe();
  });

  // ── Wrong approvalId returns 409 ─────────────────────────────────────

  it("approve with wrong approvalId returns 409 approval_id_mismatch", async () => {
    const session: SettleableSession = { ...baseSession, id: "sess-wrongid" };
    seedSettleableSessionForTests(session);
    const { events, unsubscribe } = subscribeApproval(session.id);

    const settlePromise = app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });
    // Wait long enough for fastify routing + the handler's await to land.
    await waitForApprovalEvent(events);
    approvalIdOf(events); // register an event

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approval/appr_BOGUS/approve`,
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("approval_id_mismatch");

    // Settle is still parked. Resolve it with the right id so test cleans up.
    const realId = approvalIdOf(events);
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approval/${realId}/reject`,
      headers: { authorization: "Bearer pcc_live_test" },
      payload: {},
    });
    await settlePromise;
    unsubscribe();
  });

  // ── Env auto-threshold flips on the gate ─────────────────────────────

  it("APPROVAL_THRESHOLD_USD env auto-flips low-amount sessions to require approval", async () => {
    process.env.APPROVAL_THRESHOLD_USD = "100"; // $100 → 10000 cents
    process.env.APPROVAL_TIMEOUT_MS = "20"; // ensure we don't hang
    const session: SettleableSession = {
      ...baseSession,
      id: "sess-env-thresh",
      amountCents: 12500, // $125 — over threshold
      requiresApproval: false, // not flagged on the session
    };
    seedSettleableSessionForTests(session);
    const { unsubscribe } = subscribeApproval(session.id);

    // Gate fires due to env threshold; we don't approve, so we expect 408.
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });
    expect(res.statusCode).toBe(408);
    unsubscribe();
  });

  // ── Per-call body override flips on the gate ─────────────────────────

  it("body.requireApproval=true overrides session.requiresApproval=false", async () => {
    process.env.APPROVAL_TIMEOUT_MS = "20";
    const session: SettleableSession = {
      ...baseSession,
      id: "sess-body-override",
      requiresApproval: false,
    };
    seedSettleableSessionForTests(session);
    const { unsubscribe } = subscribeApproval(session.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: { requireApproval: true },
    });
    expect(res.statusCode).toBe(408); // gate fired, timeout
    unsubscribe();
  });
});
