import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { verifyReceipt, verifyProof } from "@pcc/transparency-log";
import {
  centralizedSettleRoutes,
  resetCentralizedSettleStateForTests,
  seedSettleableSessionForTests,
  getLedgerSnapshotForTests,
  type SettleableSession,
} from "../routes/centralized-settle.js";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const baseSession: SettleableSession = {
  id: "sess-week2-test-001",
  state: "committed",
  user: { id: "user-alice", kind: "user" },
  operator: { id: "operator-bob", kind: "operator" },
  amountCents: 12500,
  capability: "fdm-3d-printing",
  actorsHashed: { user: "11".repeat(32), operator: "22".repeat(32) },
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(centralizedSettleRoutes);
  await app.ready();
  return app;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("Centralized substrate routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetCentralizedSettleStateForTests();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Happy path ─────────────────────────────────────────────────

  it("POST /api/sessions/:id/settle settles a committed session and signs a verifiable receipt", async () => {
    const session = { ...baseSession };
    seedSettleableSessionForTests(session);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {
        evidenceHash: "ab".repeat(32),
        evidenceTimestamp: "2026-04-27T12:00:00Z",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.signedReceipt).toBeDefined();
    expect(body.merklePath).toBeDefined();
    expect(body.serverPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.leafIndex).toBe(0);

    // Receipt verifies under the embedded server key.
    const sigOk = verifyReceipt(body.signedReceipt, body.serverPublicKey);
    expect(sigOk).toBe(true);

    // Merkle proof verifies under the announced root using the leaf
    // bytes the gateway returned. (verifyProof recomputes the leaf hash
    // with the 0x00 domain separator — passing a hash directly would
    // double-hash and fail.)
    const proofOk = verifyProof(
      body.leafJson,
      body.merklePath,
      body.merklePath.root,
    );
    expect(proofOk).toBe(true);

    // Ledger moved the funds: escrow drained, operator credited.
    const snap = getLedgerSnapshotForTests();
    expect(snap[`acct:escrow:${session.id}`]).toBe(0);
    expect(snap[`acct:operator:${session.operator.id}`]).toBe(session.amountCents);

    // Receipt payload reflects what we requested.
    expect(body.signedReceipt.payload.milestoneId).toBe(session.id);
    expect(body.signedReceipt.payload.capability).toBe("fdm-3d-printing");
    expect(body.signedReceipt.payload.amountCents).toBe(12500);
    expect(body.signedReceipt.payload.settlementMode).toBe("centralized");
    expect(body.signedReceipt.payload.evidenceHash).toBe("ab".repeat(32));
  });

  // ── Auth-failure surrogate (apiGate is bypassed in this test app) ──
  //
  // The repo-wide auth gate (`apiGate`) lives in middleware and is wired
  // into the full server startup. Here we exercise the *route's* own
  // contract: with no body, the route still works under the centralized
  // substrate (the auth check is upstream). What we verify instead is
  // that an unknown session is rejected — that's the route's own
  // pre-condition check.

  it("POST /api/sessions/:id/settle returns 404 when session is unknown", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-does-not-exist/settle",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("session_not_found");
  });

  // ── Double-settle ─────────────────────────────────────────────

  it("POST /api/sessions/:id/settle returns 409 when the session is already settled", async () => {
    const session = { ...baseSession };
    seedSettleableSessionForTests(session);

    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    // Second attempt: state is now "settled", so the route must reject.
    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error).toBe("invalid_state");
    expect(body.state).toBe("settled");
  });

  // ── Receipt lookup ────────────────────────────────────────────

  it("GET /api/receipts/:id returns the receipt + a verifiable proof under the current root", async () => {
    const session = { ...baseSession, id: "sess-receipt-lookup" };
    seedSettleableSessionForTests(session);

    const settleRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: { evidenceHash: "cd".repeat(32) },
    });
    expect(settleRes.statusCode).toBe(200);

    const lookup = await app.inject({
      method: "GET",
      url: `/api/receipts/${session.id}`,
    });
    expect(lookup.statusCode).toBe(200);
    const body = lookup.json();
    expect(body.signedReceipt.payload.milestoneId).toBe(session.id);
    expect(body.merklePath.leafHash).toBeDefined();
    expect(body.leafIndex).toBe(0);
    // Proof verifies under the current root using the canonical leaf bytes.
    expect(
      verifyProof(body.leafJson, body.merklePath, body.merklePath.root),
    ).toBe(true);
  });

  it("GET /api/receipts/:id returns 404 for unknown receipt id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/receipts/sess-never-settled",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("receipt_not_found");
  });

  // ── Anchor read ───────────────────────────────────────────────

  it("GET /api/anchor/latest returns null root when no entries, and a real root after a settle", async () => {
    const empty = await app.inject({ method: "GET", url: "/api/anchor/latest" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().root).toBeNull();
    expect(empty.json().treeSize).toBe(0);

    const session = { ...baseSession, id: "sess-anchor-test" };
    seedSettleableSessionForTests(session);
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/settle`,
      payload: {},
    });

    const after = await app.inject({ method: "GET", url: "/api/anchor/latest" });
    expect(after.statusCode).toBe(200);
    const body = after.json();
    expect(body.root).toMatch(/^[0-9a-f]{64}$/);
    expect(body.treeSize).toBe(1);
    expect(body.serverPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.latestSettledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
