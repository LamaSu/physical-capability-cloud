import { describe, it, expect } from "vitest";
import {
  isKernelStale,
  STALE_HEARTBEAT_MS,
  ACTIVE_LISTING_GRACE_MS,
} from "../../facades/populators/staleness.js";

// Fixed "now" so the rule is deterministic regardless of wall-clock.
const NOW = new Date("2026-06-17T12:00:00.000Z").getTime();
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();

describe("isKernelStale()", () => {
  it("is never stale when status is not 'online'", () => {
    // offline/maintenance/suspended carry their own status — staleness N/A.
    expect(isKernelStale("offline", agoMs(60 * 60 * 1000), false, NOW)).toBe(false);
    expect(isKernelStale("maintenance", agoMs(ACTIVE_LISTING_GRACE_MS * 2), true, NOW)).toBe(false);
    expect(isKernelStale("suspended", agoMs(ACTIVE_LISTING_GRACE_MS * 2), false, NOW)).toBe(false);
    expect(isKernelStale(undefined, agoMs(ACTIVE_LISTING_GRACE_MS * 2), false, NOW)).toBe(false);
  });

  describe("no active listing → bare 5-minute threshold", () => {
    it("not stale just under the threshold", () => {
      expect(isKernelStale("online", agoMs(STALE_HEARTBEAT_MS - 1000), false, NOW)).toBe(false);
    });
    it("stale just over the threshold", () => {
      expect(isKernelStale("online", agoMs(STALE_HEARTBEAT_MS + 1000), false, NOW)).toBe(true);
    });
  });

  describe("active listing → 24h keepalive grace (the bug fix)", () => {
    it("stays NOT stale well past the bare 5-minute threshold", () => {
      // A listed operator that last heartbeat an hour ago must remain available.
      expect(isKernelStale("online", agoMs(60 * 60 * 1000), true, NOW)).toBe(false);
    });
    it("not stale just under the grace ceiling", () => {
      expect(isKernelStale("online", agoMs(ACTIVE_LISTING_GRACE_MS - 1000), true, NOW)).toBe(false);
    });
    it("stale once past the grace ceiling (genuinely dead kernel)", () => {
      expect(isKernelStale("online", agoMs(ACTIVE_LISTING_GRACE_MS + 1000), true, NOW)).toBe(true);
    });
  });

  it("treats a missing heartbeat as infinitely old", () => {
    expect(isKernelStale("online", null, true, NOW)).toBe(true);
    expect(isKernelStale("online", undefined, false, NOW)).toBe(true);
  });

  it("grace window is wider than the bare threshold", () => {
    expect(ACTIVE_LISTING_GRACE_MS).toBeGreaterThan(STALE_HEARTBEAT_MS);
  });
});
