/**
 * Board N133 follow-up: an execution scope's expiry is read fail-closed (services/scope-expiry.ts).
 * The route-level cases are in n133-scope-minting-rules.test.ts (the operator's accept) and
 * device-relay.test.ts (admission, dispatch, the lease start and the scope read).
 */
import { describe, it, expect } from "vitest";
import { scopeExpiryMs } from "../services/scope-expiry.js";

describe("scopeExpiryMs: an execution scope's expiry, read fail-closed (N133 follow-up)", () => {
  it("reads a well-formed expiry exactly as new Date() does: open before it, shut after", () => {
    const now = Date.now();
    const future = new Date(now + 60_000).toISOString();
    const past = new Date(now - 60_000).toISOString();
    expect(scopeExpiryMs(future)).toBe(now + 60_000);
    expect(scopeExpiryMs(past)).toBe(now - 60_000);
    expect(scopeExpiryMs(future) < now).toBe(false);
    expect(scopeExpiryMs(past) < now).toBe(true);
    // The expanded-year form toISOString writes for a far expiry still parses.
    const far = new Date(8.64e15).toISOString();
    expect(far.startsWith("+")).toBe(true);
    expect(scopeExpiryMs(far)).toBe(8.64e15);
  });

  it("reads an expiry that does not parse as long past, so the < and <= checks against now refuse it", () => {
    const now = Date.now();
    for (const unreadable of ["", " ", "garbage", "Invalid Date", "NaN", "1728400000000", undefined]) {
      const ms = scopeExpiryMs(unreadable as unknown as string);
      expect(ms, JSON.stringify(unreadable)).toBe(Number.NEGATIVE_INFINITY);
      expect(ms < now).toBe(true);
      expect(ms <= now).toBe(true);
      expect(ms > now).toBe(false);
    }
  });

  it("reads null as the epoch, as new Date(null) always did: long past too (the column is NOT NULL anyway)", () => {
    expect(scopeExpiryMs(null as unknown as string)).toBe(0);
  });

  it("reads a timezone-less or SQLite-style timestamp as the server's local time, as new Date() does: readable, not unreadable", () => {
    expect(scopeExpiryMs("2099-01-01T00:00:00")).toBe(new Date(2099, 0, 1).getTime());
    expect(scopeExpiryMs("2099-01-01 00:00:00")).toBe(new Date(2099, 0, 1).getTime());
  });
});
