/**
 * Tests for the wizard session management API:
 *   POST   /api/wizard/sessions              — Create wizard session
 *   GET    /api/wizard/sessions/:id          — Get session state
 *   PUT    /api/wizard/sessions/:id/steps/:step — Save step data
 *   POST   /api/wizard/sessions/:id/complete — Complete wizard
 *   DELETE /api/wizard/sessions/:id          — Abandon session
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  wizardRoutes,
  _clearSessionsForTesting,
  _getSessionCountForTesting,
  _setCompletionOverrideForTesting,
} from "../routes/wizard.js";

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(wizardRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Helper: create a session and return the id
// ---------------------------------------------------------------------------

async function createSession(
  app: FastifyInstance,
  track: string = "platform-setup",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/wizard/sessions",
    payload: { track },
  });
  return res.json().session.id;
}

// ---------------------------------------------------------------------------
// Helper: complete all steps in a session
// ---------------------------------------------------------------------------

async function completeAllSteps(
  app: FastifyInstance,
  sessionId: string,
  totalSteps: number,
): Promise<void> {
  for (let i = 0; i < totalSteps; i++) {
    await app.inject({
      method: "PUT",
      url: `/api/wizard/sessions/${sessionId}/steps/${i}`,
      payload: { data: { [`field_${i}`]: `value_${i}` } },
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Wizard API", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    _clearSessionsForTesting();
  });

  // ── POST /api/wizard/sessions ─────────────────────────────────────────────

  describe("POST /api/wizard/sessions", () => {
    it("creates a platform-setup session with 5 steps", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/wizard/sessions",
        payload: { track: "platform-setup" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.session).toBeDefined();
      expect(body.session.track).toBe("platform-setup");
      expect(body.session.totalSteps).toBe(5);
      expect(body.session.status).toBe("in_progress");
      expect(body.session.currentStep).toBe(0);
      expect(body.session.steps.length).toBe(5);
      expect(typeof body.session.id).toBe("string");
      expect(typeof body.session.createdAt).toBe("string");
      expect(typeof body.session.expiresAt).toBe("string");
    });

    it("creates a machine-onboarding session with 7 steps", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/wizard/sessions",
        payload: { track: "machine-onboarding" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.session.track).toBe("machine-onboarding");
      expect(body.session.totalSteps).toBe(7);
      expect(body.session.steps[0].stepName).toBe("machine-info");
      expect(body.session.steps[6].stepName).toBe("review-and-submit");
    });

    it("creates a device-builder session with 5 steps", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/wizard/sessions",
        payload: { track: "device-builder" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.session.track).toBe("device-builder");
      expect(body.session.totalSteps).toBe(5);
    });

    it("returns 400 for invalid track", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/wizard/sessions",
        payload: { track: "nonexistent-wizard" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_track");
    });

    it("returns 400 when track is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/wizard/sessions",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_track");
    });

    it("each session gets a unique id", async () => {
      const res1 = await app.inject({
        method: "POST",
        url: "/api/wizard/sessions",
        payload: { track: "platform-setup" },
      });
      const res2 = await app.inject({
        method: "POST",
        url: "/api/wizard/sessions",
        payload: { track: "platform-setup" },
      });
      expect(res1.json().session.id).not.toBe(res2.json().session.id);
    });
  });

  // ── GET /api/wizard/sessions/:id ──────────────────────────────────────────

  describe("GET /api/wizard/sessions/:id", () => {
    it("retrieves an existing session", async () => {
      const sessionId = await createSession(app);
      const res = await app.inject({
        method: "GET",
        url: `/api/wizard/sessions/${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.id).toBe(sessionId);
      expect(body.session.track).toBe("platform-setup");
    });

    it("returns 404 for nonexistent session", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/wizard/sessions/nonexistent-id",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("session_not_found");
    });
  });

  // ── PUT /api/wizard/sessions/:id/steps/:step ─────────────────────────────

  describe("PUT /api/wizard/sessions/:id/steps/:step", () => {
    it("saves data for a step and marks it completed", async () => {
      const sessionId = await createSession(app);
      const res = await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/0`,
        payload: { data: { network: "base-sepolia", privateKey: "set" } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.steps[0].completed).toBe(true);
      expect(body.session.steps[0].data.network).toBe("base-sepolia");
      expect(body.session.currentStep).toBe(1);
    });

    it("merges data on subsequent saves to the same step", async () => {
      const sessionId = await createSession(app);
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/0`,
        payload: { data: { field1: "value1" } },
      });
      const res = await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/0`,
        payload: { data: { field2: "value2" } },
      });
      const body = res.json();
      expect(body.session.steps[0].data.field1).toBe("value1");
      expect(body.session.steps[0].data.field2).toBe("value2");
    });

    it("advances currentStep to next incomplete step", async () => {
      const sessionId = await createSession(app);
      // Complete steps 0 and 1
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/0`,
        payload: { data: { done: true } },
      });
      const res = await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/1`,
        payload: { data: { done: true } },
      });
      expect(res.json().session.currentStep).toBe(2);
    });

    it("returns 400 for invalid step index", async () => {
      const sessionId = await createSession(app);
      const res = await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/99`,
        payload: { data: { x: 1 } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_step_index");
    });

    it("returns 400 for non-numeric step index", async () => {
      const sessionId = await createSession(app);
      const res = await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/abc`,
        payload: { data: { x: 1 } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_step_index");
    });

    it("returns 400 when data is missing", async () => {
      const sessionId = await createSession(app);
      const res = await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/0`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("data_required");
    });

    it("returns 404 for nonexistent session", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/wizard/sessions/ghost/steps/0",
        payload: { data: { x: 1 } },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 when session is completed", async () => {
      const sessionId = await createSession(app);
      await completeAllSteps(app, sessionId, 5);
      await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      const res = await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/0`,
        payload: { data: { x: 1 } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("session_not_in_progress");
    });
  });

  // ── POST /api/wizard/sessions/:id/complete ────────────────────────────────

  describe("POST /api/wizard/sessions/:id/complete", () => {
    it("completes a platform-setup session with all steps done", async () => {
      const sessionId = await createSession(app, "platform-setup");
      await completeAllSteps(app, sessionId, 5);

      const res = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.status).toBe("completed");
      expect(body.result).toBeDefined();
      expect(body.result.success).toBe(true);
      expect(Array.isArray(body.result.executedSteps)).toBe(true);
      expect(body.result.executedSteps.length).toBeGreaterThan(0);
    });

    it("completes a device-builder session and returns kernel config", async () => {
      const sessionId = await createSession(app, "device-builder");
      // Save meaningful data to steps
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/0`,
        payload: { data: { deviceName: "My Printer", deviceType: "machine" } },
      });
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/1`,
        payload: { data: { adapterType: "mock" } },
      });
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/2`,
        payload: { data: { capabilities: ["fdm"] } },
      });
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/3`,
        payload: { data: { connectionTested: true } },
      });
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/4`,
        payload: { data: { kernelId: "kernel_test_builder" } },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result.success).toBe(true);
      expect(body.result.kernelConfig).toBeDefined();
      expect(body.result.registeredDevices).toBeDefined();
    });

    it("returns 400 when steps are incomplete", async () => {
      const sessionId = await createSession(app);
      // Only complete step 0 out of 5
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/0`,
        payload: { data: { done: true } },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("incomplete_steps");
      expect(res.json().incompleteSteps.length).toBe(4);
    });

    it("returns 400 when already completed", async () => {
      const sessionId = await createSession(app);
      await completeAllSteps(app, sessionId, 5);
      await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("already_completed");
    });

    it("returns 404 for nonexistent session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/wizard/sessions/no-such-id/complete",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 when session is abandoned", async () => {
      const sessionId = await createSession(app);
      await app.inject({
        method: "DELETE",
        url: `/api/wizard/sessions/${sessionId}`,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("session_abandoned");
    });
  });

  // ── Z3 — no fabricated backend effects (storeless process) ────────────────
  //
  // This file runs without initStore(), so completion cannot perform real
  // registrations. The honest contract: steps report "skipped" and carry NO
  // invented ids. (The store-backed positive path lives in
  // wizard-completion-store.test.ts — separate file, separate db singleton.)

  describe("Z3 — completion never fabricates backend effects (storeless)", () => {
    it("machine-onboarding reports build-registration skipped, with no registrationId", async () => {
      const sessionId = await createSession(app, "machine-onboarding");
      await completeAllSteps(app, sessionId, 7);

      const res = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result.success).toBe(true);

      const step = body.result.executedSteps.find(
        (s: { name: string }) => s.name === "build-registration",
      );
      expect(step).toBeDefined();
      expect(step.status).toBe("skipped");
      expect(step.data.registrationSubmitted).toBe(false);
      expect(step.data.registrationId).toBeUndefined();
      expect(step.message).toContain("NOT submitted");
    });

    it("device-builder reports register-devices skipped, with no fabricated device ids", async () => {
      const sessionId = await createSession(app, "device-builder");
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/0`,
        payload: { data: { deviceName: "My Printer", deviceType: "machine" } },
      });
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/1`,
        payload: { data: { adapterType: "mock" } },
      });
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/2`,
        payload: { data: { capabilities: ["fdm"] } },
      });
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/3`,
        payload: { data: { connectionTested: true } },
      });
      await app.inject({
        method: "PUT",
        url: `/api/wizard/sessions/${sessionId}/steps/4`,
        payload: { data: { kernelId: "kernel_test_builder" } },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result.success).toBe(true);

      const step = body.result.executedSteps.find(
        (s: { name: string }) => s.name === "register-devices",
      );
      expect(step).toBeDefined();
      expect(step.status).toBe("skipped");
      expect(step.data.deviceIds).toEqual([]);
      expect(body.result.registeredDevices).toEqual([]);
      expect(step.message).toContain("NOT registered");
    });
  });

  // ── Z1 — completion failure + concurrency guards ──────────────────────────

  describe("POST /complete — Z1 failure and concurrency guards", () => {
    afterEach(() => {
      _setCompletionOverrideForTesting(null);
    });

    it("does NOT mark the session completed when orchestration fails, and allows retry", async () => {
      const sessionId = await createSession(app);
      await completeAllSteps(app, sessionId, 5);

      _setCompletionOverrideForTesting(async () => ({
        success: false,
        executedSteps: [{ name: "boom", status: "failed", message: "simulated failure" }],
        error: "orchestration_failed",
      }));

      const res = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("completion_failed");

      // Session must remain retryable — not completed
      const get = await app.inject({
        method: "GET",
        url: `/api/wizard/sessions/${sessionId}`,
      });
      expect(get.json().session.status).toBe("in_progress");
      // The failed outcome is recorded for observability
      expect(get.json().session.completionResult.success).toBe(false);

      // Retry once the failure cause is gone → succeeds
      _setCompletionOverrideForTesting(null);
      const retry = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().session.status).toBe("completed");
    });

    it("orchestration throw is surfaced as completion_failed, not completed", async () => {
      const sessionId = await createSession(app);
      await completeAllSteps(app, sessionId, 5);

      _setCompletionOverrideForTesting(async () => {
        throw new Error("kaboom");
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("completion_failed");
      // Internal error detail must not leak; generic code only
      expect(res.json().message).toBe("orchestration_failed");

      const get = await app.inject({
        method: "GET",
        url: `/api/wizard/sessions/${sessionId}`,
      });
      expect(get.json().session.status).toBe("in_progress");
    });

    it("second concurrent /complete gets 409 while the first is in flight", async () => {
      const sessionId = await createSession(app);
      await completeAllSteps(app, sessionId, 5);

      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      _setCompletionOverrideForTesting(async () => {
        await gate;
        return { success: true, executedSteps: [] };
      });

      const first = app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      // Give the first request a tick to claim the session
      await new Promise((r) => setTimeout(r, 20));

      const second = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("completion_in_progress");

      release();
      const firstRes = await first;
      expect(firstRes.statusCode).toBe(200);
      expect(firstRes.json().session.status).toBe("completed");
    });

    it("in-flight claim is released after a failure so retry is not blocked", async () => {
      const sessionId = await createSession(app);
      await completeAllSteps(app, sessionId, 5);

      _setCompletionOverrideForTesting(async () => ({
        success: false,
        executedSteps: [],
        error: "orchestration_failed",
      }));
      await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });

      // Immediately retryable — no lingering 409 from the failed attempt
      _setCompletionOverrideForTesting(null);
      const retry = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(retry.statusCode).toBe(200);
    });
  });

  // ── DELETE /api/wizard/sessions/:id ───────────────────────────────────────

  describe("DELETE /api/wizard/sessions/:id", () => {
    it("abandons an in-progress session", async () => {
      const sessionId = await createSession(app);
      const res = await app.inject({
        method: "DELETE",
        url: `/api/wizard/sessions/${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.status).toBe("abandoned");
      expect(body.abandoned).toBe(true);
    });

    it("returns 404 for nonexistent session", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/wizard/sessions/ghost-id",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 when trying to abandon a completed session", async () => {
      const sessionId = await createSession(app);
      await completeAllSteps(app, sessionId, 5);
      await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/wizard/sessions/${sessionId}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("cannot_abandon_completed");
    });
  });

  // ── Session store ─────────────────────────────────────────────────────────

  describe("Session store", () => {
    it("tracks session count correctly", async () => {
      expect(_getSessionCountForTesting()).toBe(0);
      await createSession(app);
      expect(_getSessionCountForTesting()).toBe(1);
      await createSession(app);
      expect(_getSessionCountForTesting()).toBe(2);
    });

    it("clearSessions removes all sessions", async () => {
      await createSession(app);
      await createSession(app);
      expect(_getSessionCountForTesting()).toBe(2);
      _clearSessionsForTesting();
      expect(_getSessionCountForTesting()).toBe(0);
    });
  });

  // ── Machine onboarding track ──────────────────────────────────────────────

  describe("Machine onboarding track completion", () => {
    it("completes successfully with all 7 steps", async () => {
      const sessionId = await createSession(app, "machine-onboarding");
      await completeAllSteps(app, sessionId, 7);

      const res = await app.inject({
        method: "POST",
        url: `/api/wizard/sessions/${sessionId}/complete`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result.success).toBe(true);
      expect(body.result.executedSteps.some(
        (s: { name: string }) => s.name === "validate-machine-info",
      )).toBe(true);
      expect(body.result.executedSteps.some(
        (s: { name: string }) => s.name === "build-registration",
      )).toBe(true);
    });
  });
});
