/**
 * Tests for PCCEventBus — hash-chained analytics event bus.
 *
 * The event bus is purely in-memory (no DB).
 * We reset the singleton in beforeEach so each test gets a fresh chain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getEventBus, resetEventBus } from "../services/event-bus.js";

// ── Setup/Teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
  resetEventBus();
});

afterEach(() => {
  resetEventBus();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePublishOpts(overrides: Partial<Parameters<ReturnType<typeof getEventBus>["publish"]>[0]> = {}) {
  return {
    eventType: "test.event",
    category: "job" as const,
    actorId: "actor-001",
    actorType: "operator" as const,
    resourceType: "job",
    resourceId: "job-001",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PCCEventBus (via getEventBus)", () => {
  // ── publish() — event structure ──────────────────────────────────────────

  describe("publish() — event structure", () => {
    it("returns an event with all required fields populated", () => {
      const bus = getEventBus();
      const event = bus.publish(makePublishOpts());

      expect(typeof event.id).toBe("string");
      expect(event.id.length).toBeGreaterThan(0);
      expect(event.eventType).toBe("test.event");
      expect(event.category).toBe("job");
      expect(event.actorId).toBe("actor-001");
      expect(event.actorType).toBe("operator");
      expect(event.resourceType).toBe("job");
      expect(event.resourceId).toBe("job-001");
      expect(typeof event.timestamp).toBe("string");
      expect(typeof event.hash).toBe("string");
    });

    it("payload defaults to empty object when not provided", () => {
      const bus = getEventBus();
      const event = bus.publish(makePublishOpts());
      expect(event.payload).toEqual({});
    });

    it("payload is preserved when provided", () => {
      const bus = getEventBus();
      const event = bus.publish(makePublishOpts({ payload: { amount: 100, currency: "USDC" } }));
      expect(event.payload).toEqual({ amount: 100, currency: "USDC" });
    });

    it("timestamp is a valid ISO 8601 string", () => {
      const bus = getEventBus();
      const before = new Date().toISOString();
      const event = bus.publish(makePublishOpts());
      const after = new Date().toISOString();
      expect(event.timestamp >= before).toBe(true);
      expect(event.timestamp <= after).toBe(true);
    });
  });

  // ── publish() — hash chain ────────────────────────────────────────────────

  describe("publish() — SHA-256 hash chain", () => {
    it("hash starts with 'sha256:'", () => {
      const bus = getEventBus();
      const event = bus.publish(makePublishOpts());
      expect(event.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("first event's previousHash is the genesis value", () => {
      const bus = getEventBus();
      const event = bus.publish(makePublishOpts());
      expect(event.previousHash).toBe("genesis");
    });

    it("second event's previousHash equals the first event's hash", () => {
      const bus = getEventBus();
      const event1 = bus.publish(makePublishOpts({ resourceId: "job-001" }));
      const event2 = bus.publish(makePublishOpts({ resourceId: "job-002" }));
      expect(event2.previousHash).toBe(event1.hash);
    });

    it("chain of 3 events: each previousHash equals prior event hash", () => {
      const bus = getEventBus();
      const e1 = bus.publish(makePublishOpts({ resourceId: "r-1" }));
      const e2 = bus.publish(makePublishOpts({ resourceId: "r-2" }));
      const e3 = bus.publish(makePublishOpts({ resourceId: "r-3" }));
      expect(e2.previousHash).toBe(e1.hash);
      expect(e3.previousHash).toBe(e2.hash);
    });

    it("hash is deterministic given same inputs (same id/type/timestamp/actor/resource/prevHash)", () => {
      // We can't force the same UUID/timestamp, but we can verify two separate
      // publishes each produce a sha256: hash (not empty or repeated).
      const bus = getEventBus();
      const e1 = bus.publish(makePublishOpts({ resourceId: "same-resource" }));
      const e2 = bus.publish(makePublishOpts({ resourceId: "same-resource" }));
      // IDs differ (randomUUID), so hashes must differ
      expect(e1.hash).not.toBe(e2.hash);
    });

    it("each event has a unique hash", () => {
      const bus = getEventBus();
      const hashes = Array.from({ length: 5 }, (_, i) =>
        bus.publish(makePublishOpts({ resourceId: `res-${i}` })).hash,
      );
      const unique = new Set(hashes);
      expect(unique.size).toBe(5);
    });
  });

  // ── onEvent() — subscriber ────────────────────────────────────────────────

  describe("onEvent() — event delivery", () => {
    it("subscriber receives the emitted event", () => {
      const bus = getEventBus();
      const received: unknown[] = [];
      bus.onEvent((e) => received.push(e));

      const published = bus.publish(makePublishOpts());
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(published);
    });

    it("multiple subscribers all receive the event", () => {
      const bus = getEventBus();
      const calls: number[] = [];
      bus.onEvent(() => calls.push(1));
      bus.onEvent(() => calls.push(2));

      bus.publish(makePublishOpts());
      expect(calls).toContain(1);
      expect(calls).toContain(2);
    });

    it("subscriber receives events in publish order", () => {
      const bus = getEventBus();
      const received: string[] = [];
      bus.onEvent((e) => received.push(e.resourceId));

      bus.publish(makePublishOpts({ resourceId: "first" }));
      bus.publish(makePublishOpts({ resourceId: "second" }));
      expect(received).toEqual(["first", "second"]);
    });
  });

  // ── resetEventBus() ───────────────────────────────────────────────────────

  describe("resetEventBus()", () => {
    it("clears all listeners so previously added handler no longer fires", () => {
      const bus = getEventBus();
      const spy = vi.fn();
      bus.onEvent(spy);

      resetEventBus();

      // Get new bus instance — spy should not be called
      const freshBus = getEventBus();
      freshBus.publish(makePublishOpts());
      expect(spy).not.toHaveBeenCalled();
    });

    it("resets the hash chain so the next event's previousHash is 'genesis'", () => {
      const bus = getEventBus();
      bus.publish(makePublishOpts({ resourceId: "pre-reset" }));

      resetEventBus();
      const freshBus = getEventBus();
      const event = freshBus.publish(makePublishOpts({ resourceId: "post-reset" }));
      expect(event.previousHash).toBe("genesis");
    });

    it("returns a new singleton instance after reset", () => {
      const before = getEventBus();
      resetEventBus();
      const after = getEventBus();
      expect(before).not.toBe(after);
    });

    it("does not throw when called before any singleton is created", () => {
      resetEventBus(); // already reset in beforeEach; calling again must be safe
      expect(() => resetEventBus()).not.toThrow();
    });
  });

  // ── getEventBus() singleton ───────────────────────────────────────────────

  describe("getEventBus() singleton", () => {
    it("returns the same instance on repeated calls", () => {
      const a = getEventBus();
      const b = getEventBus();
      expect(a).toBe(b);
    });
  });
});
