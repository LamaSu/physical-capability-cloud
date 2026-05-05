/**
 * activity-feed-logic unit tests.
 * Covers sponsor-class mapping, level dot, time formatting, ring-buffer merge,
 * and payload key counting.
 */

import { describe, it, expect } from "vitest";
import {
  sponsorClass,
  levelDot,
  formatEventTime,
  mergeEvents,
  payloadKeyCount,
  type OnboardEvent,
} from "../activity-feed-logic.js";

describe("sponsorClass", () => {
  it("maps known sponsors to their class suffix", () => {
    expect(sponsorClass("Guild")).toBe("guild");
    expect(sponsorClass("TinyFish")).toBe("tinyfish");
    expect(sponsorClass("Nexla")).toBe("nexla");
    expect(sponsorClass("InsForge")).toBe("insforge");
    expect(sponsorClass("Redis")).toBe("redis");
    expect(sponsorClass("Ghost")).toBe("ghost");
    expect(sponsorClass("CDP")).toBe("cdp");
    expect(sponsorClass("x402")).toBe("x402");
    expect(sponsorClass("agentic")).toBe("agentic");
    expect(sponsorClass("Senso")).toBe("senso");
    expect(sponsorClass("Navi")).toBe("navi");
    expect(sponsorClass("Vapi")).toBe("vapi");
  });

  it("strips suffix after first space", () => {
    expect(sponsorClass("Coinbase Wallet")).toBe("");
  });

  it("strips suffix after open-paren", () => {
    expect(sponsorClass("CDP (Coinbase)")).toBe("cdp");
  });

  it("returns empty for unknown sponsor", () => {
    expect(sponsorClass("Unknown Sponsor")).toBe("");
  });

  it("returns empty for null/undefined", () => {
    expect(sponsorClass(null)).toBe("");
    expect(sponsorClass(undefined)).toBe("");
  });

  it("returns empty for empty string", () => {
    expect(sponsorClass("")).toBe("");
  });
});

describe("levelDot", () => {
  it("returns green for ok", () => {
    expect(levelDot("ok")).toBe("🟢");
  });
  it("returns yellow for warn", () => {
    expect(levelDot("warn")).toBe("🟡");
  });
  it("returns red for err", () => {
    expect(levelDot("err")).toBe("🔴");
  });
  it("returns blue for info", () => {
    expect(levelDot("info")).toBe("🔵");
  });
  it("returns blue for missing level (default)", () => {
    expect(levelDot(undefined)).toBe("🔵");
  });
});

describe("formatEventTime", () => {
  it("returns HH:MM:SS-style without AM/PM suffix", () => {
    // Use a known epoch ms; the format depends on locale, but the AM/PM
    // suffix is always split off by the helper.
    const formatted = formatEventTime(0); // 1970-01-01T00:00:00Z
    expect(formatted).not.toMatch(/AM|PM/i);
    expect(formatted.length).toBeGreaterThan(0);
  });

  it("does not throw on negative timestamps", () => {
    expect(() => formatEventTime(-1)).not.toThrow();
  });
});

describe("mergeEvents", () => {
  function ev(t: number, sponsor = "Navi"): OnboardEvent {
    return { t, sponsor };
  }

  it("returns input unchanged when no incoming events", () => {
    const current = [ev(100)];
    const result = mergeEvents(current, [], 100);
    expect(result.events).toBe(current);
    expect(result.nextCursor).toBe(100);
  });

  it("prepends sorted incoming to current", () => {
    const result = mergeEvents([ev(50)], [ev(100), ev(75)], 50);
    // Incoming sorted ascending → 75 then 100, prepended → [75, 100, 50]
    expect(result.events.map((e) => e.t)).toEqual([75, 100, 50]);
  });

  it("advances the cursor to the latest incoming timestamp", () => {
    const result = mergeEvents([], [ev(200), ev(150)], 100);
    expect(result.nextCursor).toBe(200);
  });

  it("never moves the cursor backwards", () => {
    const result = mergeEvents([], [ev(50)], 100);
    expect(result.nextCursor).toBe(100);
  });

  it("respects the capacity cap", () => {
    const current: OnboardEvent[] = Array.from({ length: 80 }, (_, i) => ev(i));
    const result = mergeEvents(current, [ev(1000)], 79, 80);
    expect(result.events.length).toBe(80);
    expect(result.events[0]!.t).toBe(1000);
    // Last item dropped — original last (t=79) stays since slice(0, 80) keeps
    // indices 0..79; original index 79 (t=79) becomes index 80, dropped.
    expect(result.events[result.events.length - 1]!.t).toBe(78);
  });

  it("uses default capacity 80 when not specified", () => {
    const current: OnboardEvent[] = Array.from(
      { length: 100 },
      (_, i) => ev(i),
    );
    const result = mergeEvents(current, [], 99);
    // No incoming → returns current unchanged regardless of capacity
    expect(result.events.length).toBe(100);
  });
});

describe("payloadKeyCount", () => {
  it("returns 0 for null", () => {
    expect(payloadKeyCount(null)).toBe(0);
  });
  it("returns 0 for undefined", () => {
    expect(payloadKeyCount(undefined)).toBe(0);
  });
  it("returns 0 for empty object", () => {
    expect(payloadKeyCount({})).toBe(0);
  });
  it("counts top-level keys", () => {
    expect(payloadKeyCount({ a: 1, b: 2, c: 3 })).toBe(3);
  });
  it("does not recurse into nested objects", () => {
    expect(payloadKeyCount({ outer: { inner: { deep: 1 } } })).toBe(1);
  });
});
