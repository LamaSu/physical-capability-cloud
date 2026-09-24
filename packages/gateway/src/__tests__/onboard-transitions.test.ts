/**
 * Onboarding review transitions: atomic (compare-and-swap) and audited.
 *
 * Unlike prove-endpoint.test.ts, the audit service is NOT mocked here: every
 * assertion about the audit trail reads the real audit_log table.
 *
 * Covers (WP-B B3/B4/B5):
 *   - a repeated approve from "approved" is 409 invalid_transition
 *   - approve vs reject racing from the same observed state: exactly one wins,
 *     the other gets 409 and nothing is overwritten (both orders)
 *   - every successful approve/activate/reject writes one audit record with
 *     from -> to, registrationId, evidence digest and a timestamp, and the
 *     actor is a key fingerprint, never admin-key material
 *   - a failed audit write rolls the transition back (no silent promotion)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { onboardRoutes } from "../routes/onboard.js";
import { initStore, closeStore, getRepos } from "../db.js";

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: {
    emit: vi.fn(),
    getTimeline: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
  },
}));

const OWNER = "owner@example.com";
const ADMIN_KEY = "wp-b-admin-key-0123456789abcdef";
/** sha256(ADMIN_KEY): no part of it may appear in the audit log (L3). */
const KEY_SHA256 = createHash("sha256").update(ADMIN_KEY).digest("hex");
const ENV_KEYS = ["NODE_ENV", "PCC_ADMIN_KEY"] as const;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  const app = Fastify({ logger: false });
  // Stand-in for the gateway auth middleware (api-gate sets req.operatorId).
  app.addHook("onRequest", async (req) => {
    const operatorId = req.headers["x-test-operator"];
    if (typeof operatorId === "string") (req as any).operatorId = operatorId;
  });
  await app.register(onboardRoutes);
  await app.ready();
  return app;
}

async function registerOwned(app: FastifyInstance, owner = OWNER): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/onboard/register",
    headers: { "x-test-operator": owner },
    payload: {
      name: "Test Printer",
      category: "fdm",
      manufacturer: "Test Co",
      model: "TestBot 9000",
      operator: { walletAddress: owner, displayName: "Owner", certifications: [], trainingAcknowledgments: {} },
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().registration.id;
}

/**
 * /register mints ids as `reg-${Date.now()}`, so two registrations in the same
 * millisecond collide (the second insert is dropped). Wait for the clock to
 * move on before registering again in the same test.
 */
async function nextMillisecond(): Promise<void> {
  const t = Date.now();
  while (Date.now() === t) await new Promise((r) => setTimeout(r, 1));
}

/**
 * An admin-key call. /approve must name the evidence the admin reviewed (M2);
 * unless a test passes its own expectedEvidenceDigest, approvals here say
 * "none", which matches a registration with no proof on record.
 */
function admin(app: FastifyInstance, regId: string, action: "approve" | "activate" | "reject", payload: Record<string, unknown> = {}) {
  const body = action === "approve" && !("expectedEvidenceDigest" in payload) ? { expectedEvidenceDigest: "none", ...payload } : payload;
  return app.inject({
    method: "POST",
    url: `/api/onboard/registrations/${regId}/${action}`,
    headers: { "x-admin-key": ADMIN_KEY, "x-test-operator": "reviewer@example.com" },
    payload: body,
  });
}

function auditRows(regId: string) {
  return getRepos()
    .auditLog.query({ resourceType: "registration", limit: 1000 })
    .filter((r) => r.resourceId === regId)
    .reverse(); // oldest first
}

describe("onboarding review transitions are atomic and audited", () => {
  let app: FastifyInstance;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.NODE_ENV = "production";
    process.env.PCC_ADMIN_KEY = ADMIN_KEY;
    app = await buildApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    closeStore();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("a repeated approve from 'approved' is 409 invalid_transition and changes nothing", async () => {
    const regId = await registerOwned(app);
    expect((await admin(app, regId, "approve")).statusCode).toBe(200);
    const approvedAt = getRepos().registrations.findById(regId)!.approvedAt;

    const again = await admin(app, regId, "approve");
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "invalid_transition", currentStatus: "approved" });
    expect(getRepos().registrations.findById(regId)!.approvedAt).toBe(approvedAt);
    expect(auditRows(regId).filter((r) => r.eventType === "operator.approved")).toHaveLength(1);
  });

  it("activate before approval is 409 invalid_transition", async () => {
    const regId = await registerOwned(app);
    const res = await admin(app, regId, "activate");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "invalid_transition", currentStatus: "submitted" });
    expect(getRepos().registrations.findById(regId)!.status).toBe("submitted");
  });

  // Simulates a second admin's transition committing between this handler's
  // read of the registration and its write: the first findById the handler
  // makes returns the row as it was (the stale observation), after the
  // competing transition has already been applied through the same CAS.
  function interposeBeforeWrite(regId: string, competing: () => void) {
    const repo = getRepos().registrations;
    const realFindById = repo.findById.bind(repo);
    vi.spyOn(repo, "findById").mockImplementationOnce((id: string) => {
      const observed = realFindById(id);
      competing();
      return observed;
    });
  }

  it("approve vs reject: a reject that commits first makes the approve 409 (no overwrite)", async () => {
    const regId = await registerOwned(app);
    getRepos().registrations.updateStatus(regId, "reviewing");
    interposeBeforeWrite(regId, () => {
      expect(getRepos().registrations.transitionStatus(regId, ["reviewing"], "rejected", { description: "REJECTED: other admin" })).not.toBeNull();
    });

    const res = await admin(app, regId, "approve");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "invalid_transition", currentStatus: "rejected" });
    const stored = getRepos().registrations.findById(regId)!;
    expect(stored.status).toBe("rejected");
    expect(stored.approvedAt ?? null).toBeNull();
    expect(auditRows(regId).filter((r) => r.eventType === "operator.approved")).toHaveLength(0);
  });

  it("approve vs reject: an approve that commits first makes the reject 409 (no overwrite)", async () => {
    const regId = await registerOwned(app);
    getRepos().registrations.updateStatus(regId, "reviewing");
    const approvedAt = new Date().toISOString();
    interposeBeforeWrite(regId, () => {
      expect(getRepos().registrations.transitionStatus(regId, ["reviewing"], "approved", { approvedAt })).not.toBeNull();
    });

    const res = await admin(app, regId, "reject", { reason: "stale view" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "invalid_transition", currentStatus: "approved" });
    const stored = getRepos().registrations.findById(regId)!;
    expect(stored.status).toBe("approved");
    expect(stored.approvedAt).toBe(approvedAt);
    expect(stored.description ?? "").not.toMatch(/^REJECTED/);
    expect(auditRows(regId).filter((r) => r.eventType === "operator.rejected")).toHaveLength(0);
  });

  it("an approved registration can still be rejected deliberately (revocation kept)", async () => {
    const regId = await registerOwned(app);
    expect((await admin(app, regId, "approve")).statusCode).toBe(200);
    const res = await admin(app, regId, "reject", { reason: "revoked before activation" });
    expect(res.statusCode).toBe(200);
    expect(getRepos().registrations.findById(regId)!.status).toBe("rejected");
  });

  it("reject never overwrites a soft-deleted registration", async () => {
    const regId = await registerOwned(app);
    getRepos().registrations.updateStatus(regId, "deleted", { description: "DELETED at x by y — original: z" });
    const res = await admin(app, regId, "reject", { reason: "late" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "invalid_transition", currentStatus: "deleted" });
    const stored = getRepos().registrations.findById(regId)!;
    expect(stored.status).toBe("deleted");
    expect(stored.description).toMatch(/^DELETED at /);
  });

  it("a repeated reject is 409 invalid_transition", async () => {
    const regId = await registerOwned(app);
    expect((await admin(app, regId, "reject", { reason: "first" })).statusCode).toBe(200);
    const again = await admin(app, regId, "reject", { reason: "second" });
    expect(again.statusCode).toBe(409);
    expect(getRepos().registrations.findById(regId)!.description).toBe("REJECTED: first");
  });

  it("rejects an unbounded or non-string reason", async () => {
    const regId = await registerOwned(app);
    expect((await admin(app, regId, "reject", { reason: "r".repeat(2001) })).statusCode).toBe(400);
    expect((await admin(app, regId, "reject", { reason: { nested: true } })).statusCode).toBe(400);
    expect(getRepos().registrations.findById(regId)!.status).toBe("submitted");
  });

  it("every successful approve / activate / reject has an audit record with no admin-key material", async () => {
    const approvedId = await registerOwned(app);
    expect((await admin(app, approvedId, "approve")).statusCode).toBe(200);
    expect((await admin(app, approvedId, "activate")).statusCode).toBe(200);
    await nextMillisecond();
    const rejectedId = await registerOwned(app);
    expect(rejectedId).not.toBe(approvedId);
    expect((await admin(app, rejectedId, "reject", { reason: "not a real machine" })).statusCode).toBe(200);

    const expected = [
      { id: approvedId, eventType: "operator.approved", action: "approve", from: "submitted", to: "approved" },
      { id: approvedId, eventType: "operator.activated", action: "activate", from: "approved", to: "active" },
      { id: rejectedId, eventType: "operator.rejected", action: "reject", from: "submitted", to: "rejected" },
    ];
    for (const e of expected) {
      const rows = auditRows(e.id).filter((r) => r.eventType === e.eventType);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.action).toBe(e.action);
      // L3: the actor carries no bits derived from the key.
      expect(row.actor).toBe("admin-key");
      expect(Date.parse(row.timestamp)).not.toBeNaN();
      expect(row.metadata).toMatchObject({ registrationId: e.id, from: e.from, to: e.to, adminAuth: "admin-key", caller: "reviewer@example.com" });
      expect(row.metadata).toHaveProperty("evidenceDigest");
      expect(Date.parse((row.metadata as { at: string }).at)).not.toBeNaN();
    }

    // No admin-key material anywhere in the audit trail, and nothing derived
    // from the key (a hash prefix is an offline oracle for a weak key).
    const everything = JSON.stringify(getRepos().auditLog.query({ limit: 1000 }));
    expect(everything).not.toContain(ADMIN_KEY);
    expect(everything).not.toContain(ADMIN_KEY.slice(0, 12));
    expect(everything).not.toContain(KEY_SHA256.slice(0, 8));
  });

  // M1: the evidence digest an approval records comes from the latest
  // operator.proof_submitted audit row, never from the description column,
  // which an operator (or an alternate writer) can fill with a forged record.
  const FORGED_DIGEST = "sha256:" + "f".repeat(64);
  const forgedRecord = `PROOF SUBMITTED: ${JSON.stringify({ evidenceTierClaim: 2, evidenceDigest: FORGED_DIGEST })}`;

  function proveAsOwner(regId: string) {
    return app.inject({
      method: "POST",
      url: `/api/onboard/registrations/${regId}/prove`,
      headers: { "x-test-operator": OWNER },
      payload: { evidence: { deviceHealth: { status: "idle", model: "TestBot 9000" } } },
    });
  }

  it("the approval audit records the latest screened proof's digest, not a record planted in the description", async () => {
    const regId = await registerOwned(app);
    const proved = await proveAsOwner(regId);
    expect(proved.statusCode).toBe(200);
    const digest: string = proved.json().evidenceDigest;
    const proofRow = auditRows(regId).find((r) => r.eventType === "operator.proof_submitted")!;
    // A different writer overwrites the review record with a forged one.
    getRepos().registrations.updateStatus(regId, "reviewing", { description: forgedRecord });

    expect((await admin(app, regId, "approve", { expectedEvidenceDigest: digest })).statusCode).toBe(200);
    const row = auditRows(regId).find((r) => r.eventType === "operator.approved")!;
    expect(row.metadata).toMatchObject({ from: "reviewing", to: "approved", evidenceDigest: digest, evidenceVerified: true, proofAuditId: proofRow.id });
    expect(JSON.stringify(row.metadata)).not.toContain(FORGED_DIGEST);
  });

  it("with no proof on record, a planted record gives evidenceDigest null and evidenceVerified false", async () => {
    const regId = await registerOwned(app);
    getRepos().registrations.updateStatus(regId, "reviewing", { description: forgedRecord });

    expect((await admin(app, regId, "approve", { expectedEvidenceDigest: "none" })).statusCode).toBe(200);
    const row = auditRows(regId).find((r) => r.eventType === "operator.approved")!;
    expect(row.metadata).toMatchObject({ evidenceDigest: null, evidenceVerified: false, proofAuditId: null });
    expect(JSON.stringify(auditRows(regId))).not.toContain(FORGED_DIGEST);
  });

  // ── M2: an approval is bound to the evidence the admin reviewed ─────────

  /** What an admin UI reads before approving: the evidenceDigest of the review record GET serves. */
  async function reviewedDigest(regId: string): Promise<string> {
    const res = await app.inject({ method: "GET", url: `/api/onboard/registrations/${regId}`, headers: { "x-test-operator": "reviewer@example.com" } });
    const description: string = res.json().registration.description;
    return JSON.parse(description.replace(/^PROOF SUBMITTED: /, "")).evidenceDigest;
  }

  it("an owner who re-proves between the admin's review and the approve gets nothing approved (409 evidence_changed)", async () => {
    const regId = await registerOwned(app);
    expect((await proveAsOwner(regId)).statusCode).toBe(200);
    const reviewed = await reviewedDigest(regId); // the admin reviews evidence A

    // The owner swaps in evidence B before the admin approves.
    const swapped = await app.inject({
      method: "POST",
      url: `/api/onboard/registrations/${regId}/prove`,
      headers: { "x-test-operator": OWNER },
      payload: { evidence: { deviceHealth: { status: "broken", model: "Something Else" } } },
    });
    expect(swapped.statusCode).toBe(200);
    const current: string = swapped.json().evidenceDigest;
    expect(current).not.toBe(reviewed);

    const res = await admin(app, regId, "approve", { expectedEvidenceDigest: reviewed });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "evidence_changed", currentEvidenceDigest: current });
    const stored = getRepos().registrations.findById(regId)!;
    expect(stored.status).toBe("reviewing");
    expect(stored.approvedAt ?? null).toBeNull();
    expect(auditRows(regId).filter((r) => r.eventType === "operator.approved")).toHaveLength(0);

    // Approving what is actually on record works, and the audit says what was approved.
    expect((await admin(app, regId, "approve", { expectedEvidenceDigest: current })).statusCode).toBe(200);
    const row = auditRows(regId).find((r) => r.eventType === "operator.approved")!;
    expect(row.metadata).toMatchObject({ evidenceDigest: current, expectedEvidenceDigest: current, evidenceVerified: true });
  });

  it("the evidence check runs inside the approval's transaction (a proof landing after the handler's read is caught)", async () => {
    const regId = await registerOwned(app);
    const reviewed: string = (await proveAsOwner(regId)).json().evidenceDigest;
    const later = "sha256:" + "b".repeat(64);
    // A re-prove's audit row commits between the approve handler's read and its transaction.
    interposeBeforeWrite(regId, () => {
      getRepos().auditLog.insert({
        timestamp: new Date().toISOString(),
        eventType: "operator.proof_submitted",
        actor: OWNER,
        resourceType: "registration",
        resourceId: regId,
        action: "prove",
        metadata: { evidenceDigest: later },
      });
    });

    const res = await admin(app, regId, "approve", { expectedEvidenceDigest: reviewed });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "evidence_changed", currentEvidenceDigest: later });
    expect(getRepos().registrations.findById(regId)!.status).toBe("reviewing");
  });

  it('"none" does not approve a registration that has evidence on record', async () => {
    const regId = await registerOwned(app);
    const proved = await proveAsOwner(regId);
    const res = await admin(app, regId, "approve", { expectedEvidenceDigest: "none" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "evidence_changed", currentEvidenceDigest: proved.json().evidenceDigest });
    expect(getRepos().registrations.findById(regId)!.status).toBe("reviewing");
  });

  it.each([
    ["missing", {}],
    ["null", { expectedEvidenceDigest: null }],
    ["a number", { expectedEvidenceDigest: 123 }],
    ["an object", { expectedEvidenceDigest: { digest: "none" } }],
  ])("an approve whose expectedEvidenceDigest is %s is 400 and approves nothing", async (_label, payload) => {
    const regId = await registerOwned(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/onboard/registrations/${regId}/approve`,
      headers: { "x-admin-key": ADMIN_KEY, "x-test-operator": "reviewer@example.com" },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("expected_evidence_digest_required");
    expect(getRepos().registrations.findById(regId)!.status).toBe("submitted");
    expect(auditRows(regId).filter((r) => r.eventType === "operator.approved")).toHaveLength(0);
  });

  it.each(["approve", "activate", "reject"] as const)(
    "a failed audit write rolls the %s back instead of leaving an unaudited promotion",
    async (action) => {
      const regId = await registerOwned(app);
      const before = action === "activate" ? "approved" : "reviewing";
      getRepos().registrations.updateStatus(regId, before, before === "approved" ? { approvedAt: "2026-01-01T00:00:00.000Z" } : {});
      const snapshot = getRepos().registrations.findById(regId)!;
      vi.spyOn(getRepos().auditLog, "insert").mockImplementation(() => {
        throw new Error("audit store unavailable");
      });

      const res = await admin(app, regId, action, action === "reject" ? { reason: "x" } : {});
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("audit_write_failed");
      const stored = getRepos().registrations.findById(regId)!;
      expect(stored.status).toBe(snapshot.status);
      expect(stored.approvedAt ?? null).toBe(snapshot.approvedAt ?? null);
      expect(stored.description ?? null).toBe(snapshot.description ?? null);
    },
  );
});
