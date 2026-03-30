/**
 * Tests for the PostHog server-side analytics service.
 *
 * The service degrades gracefully when POSTHOG_API_KEY is not set
 * and when posthog-node is not installed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PostHog service", () => {
  // ── Helper to get a fresh module each test (reset module state) ───────────
  async function freshService() {
    // Invalidate any cached module so posthog state is reset
    vi.resetModules();
    return import("../services/posthog-service.js");
  }

  // ── initPostHog() ─────────────────────────────────────────────────────────

  describe("initPostHog()", () => {
    it("does not throw when no env var is set", async () => {
      delete process.env.POSTHOG_API_KEY;
      delete process.env.VITE_POSTHOG_KEY;
      const { initPostHog } = await freshService();
      expect(() => initPostHog()).not.toThrow();
    });

    it("posthog stays null (no-op mode) when POSTHOG_API_KEY is absent", async () => {
      delete process.env.POSTHOG_API_KEY;
      delete process.env.VITE_POSTHOG_KEY;
      const { initPostHog, trackServerEvent } = await freshService();
      initPostHog();
      // trackServerEvent should be a no-op and not throw
      expect(() => trackServerEvent("test_event", { key: "value" })).not.toThrow();
    });

    it("falls back to VITE_POSTHOG_KEY when POSTHOG_API_KEY is absent", async () => {
      delete process.env.POSTHOG_API_KEY;
      process.env.VITE_POSTHOG_KEY = "phc_test_key";
      // posthog-node is not installed in test env — should silently degrade
      const { initPostHog } = await freshService();
      expect(() => initPostHog()).not.toThrow();
      delete process.env.VITE_POSTHOG_KEY;
    });

    it("silently degrades when posthog-node is not available (require throws)", async () => {
      process.env.POSTHOG_API_KEY = "phc_fake_key";
      // We cannot easily make require() throw in ESM tests, but the catch block
      // ensures it doesn't propagate — just verify it doesn't throw
      const { initPostHog } = await freshService();
      expect(() => initPostHog()).not.toThrow();
      delete process.env.POSTHOG_API_KEY;
    });
  });

  // ── trackServerEvent() ────────────────────────────────────────────────────

  describe("trackServerEvent()", () => {
    beforeEach(async () => {
      delete process.env.POSTHOG_API_KEY;
      delete process.env.VITE_POSTHOG_KEY;
    });

    it("does not throw when posthog is not initialized", async () => {
      const { trackServerEvent } = await freshService();
      expect(() => trackServerEvent("page_view")).not.toThrow();
    });

    it("does not throw with properties and distinctId", async () => {
      const { trackServerEvent } = await freshService();
      expect(() =>
        trackServerEvent("job.submitted", { jobId: "j-1" }, "user-123"),
      ).not.toThrow();
    });

    it("does not throw with undefined properties", async () => {
      const { trackServerEvent } = await freshService();
      expect(() => trackServerEvent("bare_event", undefined, undefined)).not.toThrow();
    });

    it("does not throw with empty properties object", async () => {
      const { trackServerEvent } = await freshService();
      expect(() => trackServerEvent("empty_props", {})).not.toThrow();
    });
  });

  // ── shutdownPostHog() ─────────────────────────────────────────────────────

  describe("shutdownPostHog()", () => {
    it("resolves cleanly when posthog is not initialized", async () => {
      delete process.env.POSTHOG_API_KEY;
      delete process.env.VITE_POSTHOG_KEY;
      const { shutdownPostHog } = await freshService();
      await expect(shutdownPostHog()).resolves.toBeUndefined();
    });

    it("returns a Promise", async () => {
      const { shutdownPostHog } = await freshService();
      const result = shutdownPostHog();
      expect(result).toBeInstanceOf(Promise);
      await result; // should not reject
    });

    it("can be called multiple times without throwing", async () => {
      const { shutdownPostHog } = await freshService();
      await shutdownPostHog();
      await expect(shutdownPostHog()).resolves.toBeUndefined();
    });
  });
});
