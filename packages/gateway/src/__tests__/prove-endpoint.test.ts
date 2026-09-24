/**
 * Tests for the /api/onboard/registrations/:id/prove endpoint.
 *
 * Covers:
 *   - bundleHash format validation (valid/invalid/short)
 *   - event timestamp validation (future, stale, valid)
 *   - evidence-tier CLAIM classification (0, 1, 2) — a claim, never a tier
 *   - the proof audit record (auditService.logStrict, inside the transition)
 *   - rejected / deleted / suspended registrations cannot be proved
 *   - already-active registration returns error
 *   - /prove never approves or activates, at any tier (it records evidence
 *     and leaves the registration in "reviewing")
 *   - /approve, /activate and /reject require the admin key (X-Admin-Key
 *     matching PCC_ADMIN_KEY), so no onboarding route lets an operator make
 *     itself live, and no operator identity stands in for the key
 *
 * ALL external calls (PostHog, pipelineTelemetry, auditService) are mocked,
 * and the evidence-photo store is an in-memory map.
 *
 * /prove requires an authenticated owner (steward rule 7), so registrations
 * here are owned by OWNER and /prove calls carry OWNER's identity header.
 * Bound, fabrication and race negatives live in onboard-prove-hardening.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { onboardRoutes } from "../routes/onboard.js";
import { setEvidencePhotoStoreForTests } from "../routes/onboard-evidence.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { b64, makePng } from "./fixtures/onboard-images.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    // Review transitions write their audit record with logStrict inside the
    // transition's DB transaction (see onboard-transitions.test.ts for the
    // real, unmocked audit trail).
    logStrict: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: {
    emit: vi.fn(),
    getTimeline: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
  },
}));

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  // Stand-in for the gateway auth middleware: the x-test-operator header sets
  // the authenticated caller identity the routes read from req.operatorId.
  app.addHook("onRequest", async (req) => {
    const operatorId = req.headers["x-test-operator"];
    if (typeof operatorId === "string") (req as any).operatorId = operatorId;
  });
  await app.register(onboardRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Helper: create a registration and return its ID
// ---------------------------------------------------------------------------

/** The operator that owns registrations made by registerMachine() and submits their evidence. */
const OWNER = "owner@example.com";
const OWNER_HEADERS = { "x-test-operator": OWNER };

async function registerMachine(app: FastifyInstance, overrides: Record<string, unknown> = {}): Promise<string> {
  // The owner is the authenticated caller (M3): register as the operator the body names.
  const operator = overrides.operator as { walletAddress?: string } | undefined;
  const res = await app.inject({
    method: "POST",
    url: "/api/onboard/register",
    headers: { "x-test-operator": operator?.walletAddress ?? OWNER },
    payload: {
      name: "Test Printer",
      category: "fdm",
      manufacturer: "Test Co",
      model: "TestBot 9000",
      operator: { walletAddress: OWNER, displayName: "Owner", certifications: [], trainingAcknowledgments: {} },
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().registration.id;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_BUNDLE_HASH = "sha256:abc123def456abc123def456abc123def456abc123";
const VALID_DEVICE_HEALTH = { status: "idle", model: "TestBot 9000", firmware: "1.0" };
// A real 64x48 PNG: a photo counts only if it passes every bound and header
// check. (The old fixture, "A".repeat(2000), decodes to zero bytes that are
// not an image; the old code counted anything over 1 KB.)
const VALID_PHOTO = b64(makePng(64, 48));

function makeRecentTimestamp(): string {
  return new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
}

function makeFutureTimestamp(): string {
  return new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes in future
}

function makeStaleTimestamp(): string {
  return new Date(Date.now() - 90 * 60 * 1000).toISOString(); // 90 minutes ago
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Prove Endpoint", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    const blobs = new Map<string, Uint8Array>();
    setEvidencePhotoStoreForTests({
      put: async (bytes) => {
        const cid = `test-cid-${blobs.size}`;
        blobs.set(cid, bytes);
        return { cid };
      },
    });
    app = await buildApp();
  });

  afterEach(async () => {
    setEvidencePhotoStoreForTests(null);
    await app.close();
    closeStore();
  });

  // ── bundleHash validation ─────────────────────────────────────────────────

  describe("bundleHash validation", () => {
    it("accepts a valid bundleHash (starts with sha256: and 40+ chars)", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: VALID_BUNDLE_HASH,
            events: [
              { type: "execution_completed", timestamp: makeRecentTimestamp(), payload: { jobType: "test" } },
            ],
            deviceHealth: VALID_DEVICE_HEALTH,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.autoApproved).toBe(false);
      expect(body.pendingReview).toBe(true);
    });

    it("rejects a bundleHash that does not start with 'sha256:'", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: "md5:abc123def456abc123def456abc123def456abc123",
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("invalid_bundle_hash");
    });

    it("rejects a bundleHash that is too short (< 40 chars)", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: "sha256:short",
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("invalid_bundle_hash");
    });

    it("rejects an obviously fake/short bundleHash", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: "fake",
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("invalid_bundle_hash");
    });
  });

  // ── event timestamp validation ─────────────────────────────────────────────

  describe("event timestamp validation", () => {
    it("rejects events with timestamps in the future", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: VALID_BUNDLE_HASH,
            events: [
              { type: "execution_completed", timestamp: makeFutureTimestamp(), payload: {} },
            ],
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("future_event_timestamp");
    });

    it("rejects events with timestamps older than 1 hour", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: VALID_BUNDLE_HASH,
            events: [
              { type: "execution_completed", timestamp: makeStaleTimestamp(), payload: {} },
            ],
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("stale_event_timestamp");
    });

    it("accepts events with recent valid timestamps", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: VALID_BUNDLE_HASH,
            events: [
              { type: "execution_completed", timestamp: makeRecentTimestamp(), payload: {} },
            ],
            deviceHealth: VALID_DEVICE_HEALTH,
          },
        },
      });

      // Should not fail on timestamps
      expect(res.statusCode).not.toBe(400);
    });

    it("rejects events with invalid ISO timestamp strings", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: VALID_BUNDLE_HASH,
            events: [
              { type: "execution_completed", timestamp: "not-a-timestamp", payload: {} },
            ],
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("invalid_event_timestamp");
    });
  });

  // ── evidence-tier claim classification (a claim, never a tier) ─────────────

  describe("evidence-tier claim classification", () => {
    it("assigns tier 0 for deviceHealth only (no bundleHash, no photo)", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            deviceHealth: VALID_DEVICE_HEALTH,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evidenceTierClaim).toBe(0);
      // Should have a tier warning
      expect(body.warning).toContain("Self-attested only");
    });

    it("assigns tier 1 for bundleHash + events with execution_completed", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: VALID_BUNDLE_HASH,
            events: [
              { type: "execution_completed", timestamp: makeRecentTimestamp(), payload: { jobType: "test" } },
            ],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evidenceTierClaim).toBe(1);
    });

    it("assigns tier 1 for bundleHash + events with camera_snapshot", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: VALID_BUNDLE_HASH,
            events: [
              { type: "camera_snapshot", timestamp: makeRecentTimestamp(), payload: { description: "test" } },
            ],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evidenceTierClaim).toBe(1);
    });

    it("assigns tier 2 for photo + deviceHealth + events", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            photoBase64: VALID_PHOTO,
            deviceHealth: VALID_DEVICE_HEALTH,
            events: [
              { type: "execution_completed", timestamp: makeRecentTimestamp(), payload: {} },
            ],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evidenceTierClaim).toBe(2);
    });

    it("prefers tier 2 over tier 1 when all evidence is present", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            photoBase64: VALID_PHOTO,
            deviceHealth: VALID_DEVICE_HEALTH,
            bundleHash: VALID_BUNDLE_HASH,
            events: [
              { type: "execution_completed", timestamp: makeRecentTimestamp(), payload: {} },
            ],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evidenceTierClaim).toBe(2);
    });
  });

  // ── audit logging ─────────────────────────────────────────────────────────

  describe("audit logging", () => {
    it("writes the proof audit record (logStrict) on successful prove", async () => {
      const { auditService } = await import("../services/audit-service.js");
      const regId = await registerMachine(app);

      await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            deviceHealth: VALID_DEVICE_HEALTH,
          },
        },
      });

      expect(auditService.logStrict).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "operator.proof_submitted",
          action: "prove",
          resourceType: "registration",
          resourceId: regId,
        }),
      );
    });

    it("includes the evidence-tier claim and evidence digest in audit metadata", async () => {
      const { auditService } = await import("../services/audit-service.js");
      const regId = await registerMachine(app);

      await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: VALID_BUNDLE_HASH,
            events: [
              { type: "execution_completed", timestamp: makeRecentTimestamp(), payload: {} },
            ],
          },
        },
      });

      expect(auditService.logStrict).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            evidenceTierClaim: expect.any(Number),
            evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            autoApproved: false,
          }),
        }),
      );
    });
  });

  // ── status guards ─────────────────────────────────────────────────────────

  describe("status guards", () => {
    it("returns 400 for a registration in 'rejected' status", async () => {
      const regId = await registerMachine(app);

      // Force the registration into 'rejected' status straight through the
      // repo so this test stays decoupled from the admin gate on /reject
      // (covered in "review routes are admin-only" below).
      getRepos().registrations.updateStatus(regId, "rejected", {
        description: "REJECTED: Policy violation",
      });

      // Now try to prove it
      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: { deviceHealth: VALID_DEVICE_HEALTH },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("rejected");
    });

    it("returns 400 for an already 'active' registration", async () => {
      const regId = await registerMachine(app);

      // /prove no longer activates, so set 'active' through the repo.
      getRepos().registrations.updateStatus(regId, "active");

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: { deviceHealth: VALID_DEVICE_HEALTH },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("already_active");
    });

    it("returns 404 for an unknown registration ID", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/onboard/registrations/nonexistent-reg-id/prove",
        headers: OWNER_HEADERS,
        payload: {
          evidence: { deviceHealth: VALID_DEVICE_HEALTH },
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 410 for a soft-deleted registration", async () => {
      const regId = await registerMachine(app);
      getRepos().registrations.updateStatus(regId, "deleted");

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: { evidence: { deviceHealth: VALID_DEVICE_HEALTH } },
      });

      expect(res.statusCode).toBe(410);
      expect(getRepos().registrations.findById(regId)!.status).toBe("deleted");
    });

    it("does not let a suspended registration reinstate itself", async () => {
      const regId = await registerMachine(app);
      getRepos().registrations.updateStatus(regId, "suspended");

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: { evidence: { deviceHealth: VALID_DEVICE_HEALTH } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_status");
      expect(getRepos().registrations.findById(regId)!.status).toBe("suspended");
    });

    it("refuses new evidence once a registration is approved", async () => {
      const regId = await registerMachine(app);
      const reviewed = 'PROOF SUBMITTED: {"reviewed":true}';
      getRepos().registrations.updateStatus(regId, "approved", {
        approvedAt: new Date().toISOString(),
        description: reviewed,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: { evidence: { deviceHealth: VALID_DEVICE_HEALTH } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("already_approved");
      const stored = getRepos().registrations.findById(regId)!;
      expect(stored.status).toBe("approved");
      expect(stored.description).toBe(reviewed);
    });
  });

  // ── insufficient evidence ─────────────────────────────────────────────────

  describe("evidence requirements", () => {
    it("returns 400 when no evidence body is provided", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("evidence_required");
    });

    it("returns 422 when evidence doesn't meet minimum requirements", async () => {
      const regId = await registerMachine(app);

      // bundleHash without events and no deviceHealth/photo → insufficient
      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: {
          evidence: {
            bundleHash: VALID_BUNDLE_HASH,
            // no events, no deviceHealth, no photo
          },
        },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.error).toBe("insufficient_evidence");
    });

    it.each([
      { tier: 0, evidence: () => ({ deviceHealth: VALID_DEVICE_HEALTH }) },
      {
        tier: 1,
        evidence: () => ({
          bundleHash: VALID_BUNDLE_HASH,
          events: [{ type: "execution_completed", timestamp: makeRecentTimestamp(), payload: {} }],
        }),
      },
      {
        tier: 2,
        evidence: () => ({
          photoBase64: VALID_PHOTO,
          deviceHealth: VALID_DEVICE_HEALTH,
          events: [{ type: "execution_completed", timestamp: makeRecentTimestamp(), payload: {} }],
        }),
      },
    ])("records tier-$tier evidence without approving or activating", async ({ tier, evidence }) => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: OWNER_HEADERS,
        payload: { evidence: evidence() },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evidenceTierClaim).toBe(tier);
      expect(body.registration.status).toBe("reviewing");
      expect(body.activated).toBe(false);
      expect(body.autoApproved).toBe(false);
      expect(body.pendingReview).toBe(true);

      const stored = getRepos().registrations.findById(regId)!;
      expect(stored.status).toBe("reviewing");
      expect(stored.approvedAt ?? null).toBeNull();
      expect(stored.description).toMatch(/^PROOF SUBMITTED: /);
    });
  });

  // ── review routes are admin-only ──────────────────────────────────────────

  describe("review routes require the admin key", () => {
    const ENV_KEYS = ["NODE_ENV", "PCC_ADMIN_KEY"] as const;
    const OPERATOR = "operator@example.com";
    const ADMIN_KEY = "test-admin-key-0123456789";
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
      process.env.NODE_ENV = "production";
      delete process.env.PCC_ADMIN_KEY;
    });

    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    function registerOwned(): Promise<string> {
      return registerMachine(app, {
        operator: { walletAddress: OPERATOR, displayName: "Operator", certifications: [], trainingAcknowledgments: {} },
      });
    }

    function post(url: string, opts: { operatorId?: string; adminKey?: string; payload?: Record<string, unknown> } = {}) {
      const headers: Record<string, string> = { "x-test-operator": opts.operatorId ?? OPERATOR };
      if (opts.adminKey !== undefined) headers["x-admin-key"] = opts.adminKey;
      return app.inject({ method: "POST", url, headers, payload: opts.payload ?? {} });
    }

    it("an operator cannot make its own registration live through any onboarding route", async () => {
      process.env.PCC_ADMIN_KEY = ADMIN_KEY;
      const regId = await registerOwned();

      const prove = await post(`/api/onboard/registrations/${regId}/prove`, {
        payload: {
          evidence: {
            photoBase64: VALID_PHOTO,
            deviceHealth: VALID_DEVICE_HEALTH,
            events: [{ type: "execution_completed", timestamp: makeRecentTimestamp(), payload: {} }],
          },
        },
      });
      expect(prove.statusCode).toBe(200);
      expect(prove.json().evidenceTierClaim).toBe(2);
      expect(prove.json().activated).toBe(false);

      expect((await post(`/api/onboard/registrations/${regId}/approve`)).statusCode).toBe(403);
      expect((await post(`/api/onboard/registrations/${regId}/activate`)).statusCode).toBe(403);
      expect(getRepos().registrations.findById(regId)!.status).toBe("reviewing");
    });

    it("an admin-key holder can approve and then activate", async () => {
      process.env.PCC_ADMIN_KEY = ADMIN_KEY;
      const regId = await registerOwned();
      await post(`/api/onboard/registrations/${regId}/prove`, {
        payload: { evidence: { deviceHealth: VALID_DEVICE_HEALTH } },
      });

      // /approve names the evidence it approves (M2), matched against the
      // latest operator.proof_submitted audit row. auditService is mocked in
      // this file, so no proof row exists and the matching value is "none";
      // onboard-transitions.test.ts covers approval against a real proof row.
      const approve = await post(`/api/onboard/registrations/${regId}/approve`, {
        adminKey: ADMIN_KEY,
        payload: { expectedEvidenceDigest: "none" },
      });
      expect(approve.statusCode).toBe(200);
      expect((await post(`/api/onboard/registrations/${regId}/activate`, { adminKey: ADMIN_KEY })).statusCode).toBe(200);
      expect(getRepos().registrations.findById(regId)!.status).toBe("active");
    });

    it("an operator identity is not an admin credential", async () => {
      process.env.PCC_ADMIN_KEY = ADMIN_KEY;
      const regId = await registerOwned();

      // Keys can be provisioned for any email or wallet, so no identity may stand in for the key.
      for (const operatorId of ["admin@example.com", "0x0000000000000000000000000000000000000000", OPERATOR]) {
        expect((await post(`/api/onboard/registrations/${regId}/approve`, { operatorId })).statusCode).toBe(403);
      }
      expect(getRepos().registrations.findById(regId)!.status).toBe("submitted");
    });

    it("rejects a wrong or wrong-length admin key", async () => {
      process.env.PCC_ADMIN_KEY = ADMIN_KEY;
      const regId = await registerOwned();

      for (const adminKey of ["", "x", ADMIN_KEY.slice(0, -1) + "X", ADMIN_KEY + "-extra"]) {
        expect((await post(`/api/onboard/registrations/${regId}/approve`, { adminKey })).statusCode).toBe(403);
      }
      expect(getRepos().registrations.findById(regId)!.status).toBe("submitted");
    });

    it("cannot activate an approved registration without the right key", async () => {
      process.env.PCC_ADMIN_KEY = ADMIN_KEY;
      const regId = await registerOwned();
      getRepos().registrations.updateStatus(regId, "approved", { approvedAt: new Date().toISOString() });

      for (const adminKey of [undefined, "wrong-key", ADMIN_KEY + "x"]) {
        expect((await post(`/api/onboard/registrations/${regId}/activate`, { adminKey })).statusCode).toBe(403);
      }
      expect(getRepos().registrations.findById(regId)!.status).toBe("approved");

      // With the key unset in production, even an approved registration stays put.
      delete process.env.PCC_ADMIN_KEY;
      expect((await post(`/api/onboard/registrations/${regId}/activate`, { adminKey: ADMIN_KEY })).statusCode).toBe(403);
      expect(getRepos().registrations.findById(regId)!.status).toBe("approved");
    });

    it("an admin-key holder can reject", async () => {
      process.env.PCC_ADMIN_KEY = ADMIN_KEY;
      const regId = await registerOwned();

      const res = await post(`/api/onboard/registrations/${regId}/reject`, {
        adminKey: ADMIN_KEY,
        payload: { reason: "test" },
      });
      expect(res.statusCode).toBe(200);
      expect(getRepos().registrations.findById(regId)!.status).toBe("rejected");
    });

    it("an operator without the key cannot reject a registration", async () => {
      process.env.PCC_ADMIN_KEY = ADMIN_KEY;
      const regId = await registerOwned();

      const res = await post(`/api/onboard/registrations/${regId}/reject`, {
        operatorId: "someone-else@example.com",
        payload: { reason: "test" },
      });
      expect(res.statusCode).toBe(403);
      expect(getRepos().registrations.findById(regId)!.status).toBe("submitted");
    });

    it("fails closed in production when PCC_ADMIN_KEY is unset", async () => {
      const regId = await registerOwned();

      for (const action of ["approve", "activate", "reject"]) {
        const res = await post(`/api/onboard/registrations/${regId}/${action}`, { adminKey: "anything" });
        expect(res.statusCode).toBe(403);
      }
      expect(getRepos().registrations.findById(regId)!.status).toBe("submitted");
    });

    it("answers 403, not 404, for an unknown id without the key", async () => {
      process.env.PCC_ADMIN_KEY = ADMIN_KEY;

      const res = await post("/api/onboard/registrations/nonexistent-reg-id/approve");
      expect(res.statusCode).toBe(403);
    });

    it.each([undefined, "staging", "prod", ""])(
      "fails closed when PCC_ADMIN_KEY is unset and NODE_ENV is %s",
      async (nodeEnv) => {
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
        const regId = await registerOwned();

        expect((await post(`/api/onboard/registrations/${regId}/approve`)).statusCode).toBe(403);
        expect(getRepos().registrations.findById(regId)!.status).toBe("submitted");
      },
    );

    it.each(["test", "development"])(
      "stays open when PCC_ADMIN_KEY is unset and NODE_ENV is %s",
      async (nodeEnv) => {
        process.env.NODE_ENV = nodeEnv;
        const regId = await registerOwned();

        const res = await post(`/api/onboard/registrations/${regId}/approve`, { payload: { expectedEvidenceDigest: "none" } });
        expect(res.statusCode).toBe(200);
      },
    );
  });
});
