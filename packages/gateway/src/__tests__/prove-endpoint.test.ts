/**
 * Tests for the /api/onboard/registrations/:id/prove endpoint.
 *
 * Covers:
 *   - bundleHash format validation (valid/invalid/short)
 *   - event timestamp validation (future, stale, valid)
 *   - assurance tier classification (0, 1, 2)
 *   - auditService.log called on prove
 *   - rejected registration cannot be proved
 *   - already-active registration returns error
 *
 * ALL external calls (PostHog, pipelineTelemetry, auditService) are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { onboardRoutes } from "../routes/onboard.js";
import { initStore, closeStore, getRepos } from "../db.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
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
  await app.register(onboardRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Helper: create a registration and return its ID
// ---------------------------------------------------------------------------

async function registerMachine(app: FastifyInstance, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/onboard/register",
    payload: {
      name: "Test Printer",
      category: "fdm",
      manufacturer: "Test Co",
      model: "TestBot 9000",
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
// Large enough base64 to exceed 1KB threshold (need >1365 chars of base64 for ~1024 bytes)
const VALID_PHOTO = "A".repeat(2000);

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
    app = await buildApp();
  });

  afterEach(async () => {
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
      expect(body.autoApproved).toBe(true);
    });

    it("rejects a bundleHash that does not start with 'sha256:'", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
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

  // ── assurance tier classification ─────────────────────────────────────────

  describe("assurance tier classification", () => {
    it("assigns tier 0 for deviceHealth only (no bundleHash, no photo)", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        payload: {
          evidence: {
            deviceHealth: VALID_DEVICE_HEALTH,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.assuranceTier).toBe(0);
      // Should have a tier warning
      expect(body.warning).toContain("Self-attested only");
    });

    it("assigns tier 1 for bundleHash + events with execution_completed", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
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
      expect(body.assuranceTier).toBe(1);
    });

    it("assigns tier 1 for bundleHash + events with camera_snapshot", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
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
      expect(body.assuranceTier).toBe(1);
    });

    it("assigns tier 2 for photo + deviceHealth + events", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
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
      expect(body.assuranceTier).toBe(2);
    });

    it("prefers tier 2 over tier 1 when all evidence is present", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
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
      expect(body.assuranceTier).toBe(2);
    });
  });

  // ── audit logging ─────────────────────────────────────────────────────────

  describe("audit logging", () => {
    it("calls auditService.log on successful prove", async () => {
      const { auditService } = await import("../services/audit-service.js");
      const regId = await registerMachine(app);

      await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        payload: {
          evidence: {
            deviceHealth: VALID_DEVICE_HEALTH,
          },
        },
      });

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "operator.proved",
          action: "prove",
          resourceType: "registration",
          resourceId: regId,
        }),
      );
    });

    it("includes assuranceTier in audit metadata", async () => {
      const { auditService } = await import("../services/audit-service.js");
      const regId = await registerMachine(app);

      await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        payload: {
          evidence: {
            bundleHash: VALID_BUNDLE_HASH,
            events: [
              { type: "execution_completed", timestamp: makeRecentTimestamp(), payload: {} },
            ],
          },
        },
      });

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            assuranceTier: expect.any(Number),
            autoApproved: true,
          }),
        }),
      );
    });
  });

  // ── status guards ─────────────────────────────────────────────────────────

  describe("status guards", () => {
    it("returns 400 for a registration in 'rejected' status", async () => {
      const regId = await registerMachine(app);

      // Force the registration into 'rejected' status. The /reject route
      // requires admin auth (requireAdmin middleware), which this isolated
      // test deliberately does not configure — we go straight through the
      // repo so the test stays decoupled from the admin key wiring.
      getRepos().registrations.updateStatus(regId, "rejected", {
        description: "REJECTED: Policy violation",
      });

      // Now try to prove it
      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
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

      // Prove it first to make it active
      await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        payload: {
          evidence: { deviceHealth: VALID_DEVICE_HEALTH },
        },
      });

      // Try to prove again
      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
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
        payload: {
          evidence: { deviceHealth: VALID_DEVICE_HEALTH },
        },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── insufficient evidence ─────────────────────────────────────────────────

  describe("evidence requirements", () => {
    it("returns 400 when no evidence body is provided", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
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

    it("activates the registration on successful prove", async () => {
      const regId = await registerMachine(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        payload: {
          evidence: {
            deviceHealth: VALID_DEVICE_HEALTH,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.registration.status).toBe("active");
      expect(body.activated).toBe(true);
      expect(body.autoApproved).toBe(true);
    });
  });
});
