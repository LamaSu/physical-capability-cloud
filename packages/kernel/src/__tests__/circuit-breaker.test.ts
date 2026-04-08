import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CircuitBreaker } from "../safety/circuit-breaker.js";

// ── Tests ─────────────────────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  describe("constructor", () => {
    it("uses DEFAULT_CONFIG when none provided (failureThreshold=3, cooldownMs=60000, successThreshold=2)", () => {
      const cb = new CircuitBreaker();
      // Verify defaults by driving state transitions:
      // 3 failures should trip to open (not 2, not 4)
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("closed");
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");
    });

    it("merges partial config with defaults", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open"); // threshold=1 → trips immediately
    });
  });

  describe("canExecute() — closed state", () => {
    it("returns true for unknown device (auto-initializes to closed)", () => {
      const cb = new CircuitBreaker();
      expect(cb.canExecute("brand-new-device")).toBe(true);
    });

    it("returns true for known closed device", () => {
      const cb = new CircuitBreaker();
      cb.recordSuccess("dev");
      expect(cb.canExecute("dev")).toBe(true);
    });

    it("getDeviceState() returns 'closed' for new device", () => {
      const cb = new CircuitBreaker();
      expect(cb.getDeviceState("new-dev")).toBe("closed");
    });
  });

  describe("canExecute() — open state", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns false when circuit is open and cooldown not elapsed", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");
      // advance only 5s (not enough)
      vi.advanceTimersByTime(5_000);
      expect(cb.canExecute("dev")).toBe(false);
    });

    it("transitions from open to half_open after cooldown elapses", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");
      vi.advanceTimersByTime(10_001);
      // canExecute triggers the transition
      const result = cb.canExecute("dev");
      expect(result).toBe(true);
      expect(cb.getDeviceState("dev")).toBe("half_open");
    });

    it("returns true immediately after transition to half_open (allows one test command)", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
      cb.recordFailure("dev");
      vi.advanceTimersByTime(1_001);
      expect(cb.canExecute("dev")).toBe(true);
    });
  });

  describe("canExecute() — half_open state", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns true in half_open state", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
      cb.recordFailure("dev");
      vi.advanceTimersByTime(1_001);
      cb.canExecute("dev"); // triggers transition to half_open
      expect(cb.canExecute("dev")).toBe(true);
    });
  });

  describe("recordFailure() — state transitions", () => {
    it("increments consecutiveFailures on each failure", () => {
      const cb = new CircuitBreaker({ failureThreshold: 5 });
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      const status = cb.getStatus();
      expect(status.get("dev")?.failures).toBe(2);
    });

    it("trips circuit to open after failureThreshold consecutive failures", () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("closed");
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");
    });

    it("records trippedAt timestamp when tripping", () => {
      vi.useFakeTimers();
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      cb.recordFailure("dev");
      // We can't directly read trippedAt, but we verify that cooldown works from now
      vi.advanceTimersByTime(60_000);
      expect(cb.canExecute("dev")).toBe(true); // cooldown elapsed → half_open
      vi.useRealTimers();
    });

    it("ANY failure in half_open immediately re-trips to open", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
      cb.recordFailure("dev");
      vi.advanceTimersByTime(1_001);
      cb.canExecute("dev"); // → half_open
      expect(cb.getDeviceState("dev")).toBe("half_open");
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");
      vi.useRealTimers();
    });

    it("re-trip sets a new trippedAt timestamp", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5_000 });
      cb.recordFailure("dev");
      vi.advanceTimersByTime(5_001);
      cb.canExecute("dev"); // → half_open
      // Record failure in half_open → new trip
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");
      // Should need another 5s cooldown
      expect(cb.canExecute("dev")).toBe(false);
      vi.advanceTimersByTime(5_001);
      expect(cb.canExecute("dev")).toBe(true);
      vi.useRealTimers();
    });

    it("resets consecutiveSuccesses to 0 on any failure", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({
        failureThreshold: 5,
        cooldownMs: 1_000,
        successThreshold: 3,
      });
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      cb.recordFailure("dev"); // open
      vi.advanceTimersByTime(1_001);
      cb.canExecute("dev"); // → half_open
      cb.recordSuccess("dev");
      cb.recordSuccess("dev");
      // Before reaching threshold, a failure should re-trip
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");
      vi.useRealTimers();
    });
  });

  describe("recordSuccess() — state transitions", () => {
    it("resets consecutiveFailures to 0", () => {
      const cb = new CircuitBreaker({ failureThreshold: 5 });
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      cb.recordSuccess("dev");
      const status = cb.getStatus();
      expect(status.get("dev")?.failures).toBe(0);
    });

    it("in half_open: increments consecutiveSuccesses", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1_000,
        successThreshold: 3,
      });
      cb.recordFailure("dev");
      vi.advanceTimersByTime(1_001);
      cb.canExecute("dev"); // → half_open
      cb.recordSuccess("dev");
      // Still half_open (need 2 more)
      expect(cb.getDeviceState("dev")).toBe("half_open");
      vi.useRealTimers();
    });

    it("in half_open: closes circuit when successThreshold met", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1_000,
        successThreshold: 2,
      });
      cb.recordFailure("dev");
      vi.advanceTimersByTime(1_001);
      cb.canExecute("dev"); // → half_open
      cb.recordSuccess("dev");
      cb.recordSuccess("dev");
      expect(cb.getDeviceState("dev")).toBe("closed");
      vi.useRealTimers();
    });

    it("in half_open: sets trippedAt to null when closed", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1_000,
        successThreshold: 1,
      });
      cb.recordFailure("dev");
      vi.advanceTimersByTime(1_001);
      cb.canExecute("dev"); // → half_open
      cb.recordSuccess("dev"); // → closed, trippedAt=null
      // Verify closed by checking canExecute still returns true without needing cooldown
      expect(cb.getDeviceState("dev")).toBe("closed");
      expect(cb.canExecute("dev")).toBe(true);
      vi.useRealTimers();
    });

    it("in closed: does not change state", () => {
      const cb = new CircuitBreaker();
      expect(cb.getDeviceState("dev")).toBe("closed");
      cb.recordSuccess("dev");
      cb.recordSuccess("dev");
      expect(cb.getDeviceState("dev")).toBe("closed");
    });

    it("requires exactly successThreshold successes to close from half_open", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1_000,
        successThreshold: 3,
      });
      cb.recordFailure("dev");
      vi.advanceTimersByTime(1_001);
      cb.canExecute("dev"); // → half_open
      cb.recordSuccess("dev");
      expect(cb.getDeviceState("dev")).toBe("half_open");
      cb.recordSuccess("dev");
      expect(cb.getDeviceState("dev")).toBe("half_open");
      cb.recordSuccess("dev");
      expect(cb.getDeviceState("dev")).toBe("closed");
      vi.useRealTimers();
    });
  });

  describe("reset()", () => {
    it("resets an open circuit to closed", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");
      cb.reset("dev");
      expect(cb.getDeviceState("dev")).toBe("closed");
    });

    it("resets failure count to 0", () => {
      const cb = new CircuitBreaker({ failureThreshold: 5 });
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      cb.reset("dev");
      const status = cb.getStatus();
      expect(status.get("dev")?.failures).toBe(0);
    });

    it("resets trippedAt to null", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
      cb.recordFailure("dev");
      cb.reset("dev");
      // If trippedAt were still set, canExecute would need cooldown
      // After reset, it should be immediately available
      expect(cb.canExecute("dev")).toBe(true);
      vi.useRealTimers();
    });

    it("works on a device that was never tracked", () => {
      const cb = new CircuitBreaker();
      expect(() => cb.reset("never-tracked")).not.toThrow();
      expect(cb.getDeviceState("never-tracked")).toBe("closed");
    });
  });

  describe("getStatus()", () => {
    it("returns empty map when no devices tracked", () => {
      const cb = new CircuitBreaker();
      expect(cb.getStatus().size).toBe(0);
    });

    it("returns state and failures for all tracked devices", () => {
      const cb = new CircuitBreaker({ failureThreshold: 5 });
      cb.recordFailure("dev-a");
      cb.recordFailure("dev-a");
      cb.recordFailure("dev-b");
      const status = cb.getStatus();
      expect(status.get("dev-a")?.state).toBe("closed");
      expect(status.get("dev-a")?.failures).toBe(2);
      expect(status.get("dev-b")?.failures).toBe(1);
    });

    it("failures reflects consecutiveFailures (not total)", () => {
      const cb = new CircuitBreaker({ failureThreshold: 5 });
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      cb.recordSuccess("dev"); // resets consecutive count
      const status = cb.getStatus();
      expect(status.get("dev")?.failures).toBe(0);
    });
  });

  describe("getDeviceState()", () => {
    it("returns 'closed' for untracked device (initializes it)", () => {
      const cb = new CircuitBreaker();
      expect(cb.getDeviceState("untracked")).toBe("closed");
    });

    it("returns 'open' for tripped device", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");
    });

    it("returns 'half_open' after cooldown", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
      cb.recordFailure("dev");
      vi.advanceTimersByTime(1_001);
      cb.canExecute("dev"); // triggers transition
      expect(cb.getDeviceState("dev")).toBe("half_open");
      vi.useRealTimers();
    });
  });

  describe("full state machine: closed → open → half_open → closed", () => {
    it("complete cycle with fake timers", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 10_000,
        successThreshold: 2,
      });

      // 1. Start closed
      expect(cb.getDeviceState("dev")).toBe("closed");
      expect(cb.canExecute("dev")).toBe(true);

      // 2. Fail 3 times → open
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");
      expect(cb.canExecute("dev")).toBe(false);

      // 3. Advance timer past cooldownMs → half_open on canExecute()
      vi.advanceTimersByTime(10_001);
      expect(cb.canExecute("dev")).toBe(true);
      expect(cb.getDeviceState("dev")).toBe("half_open");

      // 4. Succeed successThreshold times → closed
      cb.recordSuccess("dev");
      cb.recordSuccess("dev");
      expect(cb.getDeviceState("dev")).toBe("closed");
      expect(cb.canExecute("dev")).toBe(true);

      vi.useRealTimers();
    });

    it("re-trip cycle: closed → open → half_open → failure → open again", () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 5_000,
        successThreshold: 2,
      });

      // Trip
      cb.recordFailure("dev");
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");

      // Cooldown → half_open
      vi.advanceTimersByTime(5_001);
      cb.canExecute("dev");
      expect(cb.getDeviceState("dev")).toBe("half_open");

      // One success, then a failure → re-trip
      cb.recordSuccess("dev");
      cb.recordFailure("dev");
      expect(cb.getDeviceState("dev")).toBe("open");

      // Still open, can't execute without another cooldown
      expect(cb.canExecute("dev")).toBe(false);

      vi.useRealTimers();
    });
  });
});
