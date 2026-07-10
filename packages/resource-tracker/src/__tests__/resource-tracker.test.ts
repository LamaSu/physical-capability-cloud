import { describe, it, expect } from "vitest";
import { ResourceTracker } from "../resource-tracker.js";
import {
  InsufficientResourceError,
  OutOfCalibratedRangeError,
  ReservationNotFoundError,
} from "../errors.js";

const BOUNDS = {
  filamentGrams: { min: 1, max: 1000, unit: "g" },
  buildVolumeMm3: { min: 1, max: 50_000, unit: "mm3" },
};

function makeTracker(available: Partial<Record<keyof typeof BOUNDS, number>> = {}) {
  return new ResourceTracker(BOUNDS, {
    filamentGrams: available.filamentGrams ?? 500,
    buildVolumeMm3: available.buildVolumeMm3 ?? 20_000,
  });
}

describe("ResourceTracker — refuse-to-start (the R3 acceptance case)", () => {
  it("refuses an under-resourced request BEFORE any capacity is consumed", () => {
    const tracker = makeTracker({ filamentGrams: 100 });

    expect(() => tracker.reserve({ filamentGrams: 250 })).toThrow(InsufficientResourceError);

    // Refused request must not have held anything.
    expect(tracker.pendingCount()).toBe(0);
    expect(tracker.availableFor("filamentGrams")).toBe(100);
  });

  it("passes a sufficient request and returns a reservation token", () => {
    const tracker = makeTracker({ filamentGrams: 500 });

    const reservation = tracker.reserve({ filamentGrams: 120 });

    expect(reservation.id).toBeTruthy();
    expect(reservation.items.get("filamentGrams")).toBe(120);
    // Held, not yet consumed: available capacity reflects the pending hold.
    expect(tracker.availableFor("filamentGrams")).toBe(380);
    expect(tracker.totalFor("filamentGrams")).toBe(500);
  });
});

describe("ResourceTracker — calibrated bounds (independent of availability)", () => {
  it("refuses a request outside the calibrated range even if capacity is technically on hand", () => {
    const tracker = makeTracker({ filamentGrams: 1000 });
    expect(() => tracker.reserve({ filamentGrams: 5000 })).toThrow(OutOfCalibratedRangeError);
    expect(tracker.pendingCount()).toBe(0);
  });
});

describe("ResourceTracker — all-or-nothing across a multi-resource request", () => {
  it("holds nothing if any single line item in the request fails", () => {
    const tracker = makeTracker({ filamentGrams: 500, buildVolumeMm3: 10 });

    expect(() =>
      tracker.reserve({ filamentGrams: 100, buildVolumeMm3: 99_999 }),
    ).toThrow(OutOfCalibratedRangeError);

    expect(tracker.pendingCount()).toBe(0);
    expect(tracker.availableFor("filamentGrams")).toBe(500);
    expect(tracker.availableFor("buildVolumeMm3")).toBe(10);
  });
});

describe("ResourceTracker — two-phase commit", () => {
  it("commit() permanently deducts capacity and clears the pending hold", () => {
    const tracker = makeTracker({ filamentGrams: 500 });
    const reservation = tracker.reserve({ filamentGrams: 200 });

    tracker.commit(reservation.id);

    expect(tracker.totalFor("filamentGrams")).toBe(300);
    expect(tracker.availableFor("filamentGrams")).toBe(300);
    expect(tracker.pendingCount()).toBe(0);
  });

  it("rollback() releases the hold WITHOUT consuming capacity", () => {
    const tracker = makeTracker({ filamentGrams: 500 });
    const reservation = tracker.reserve({ filamentGrams: 200 });

    tracker.rollback(reservation.id);

    expect(tracker.totalFor("filamentGrams")).toBe(500);
    expect(tracker.availableFor("filamentGrams")).toBe(500);
    expect(tracker.pendingCount()).toBe(0);
  });

  it("a second reservation is limited by the first reservation's hold, before commit", () => {
    const tracker = makeTracker({ filamentGrams: 500 });
    tracker.reserve({ filamentGrams: 400 });

    // Only 100g free while the first reservation is pending.
    expect(() => tracker.reserve({ filamentGrams: 150 })).toThrow(InsufficientResourceError);
    const second = tracker.reserve({ filamentGrams: 100 });
    expect(second.id).toBeTruthy();
  });

  it("commit() on an unknown reservation id throws ReservationNotFoundError", () => {
    const tracker = makeTracker();
    expect(() => tracker.commit("does-not-exist")).toThrow(ReservationNotFoundError);
  });

  it("rollback() on an unknown reservation id throws ReservationNotFoundError", () => {
    const tracker = makeTracker();
    expect(() => tracker.rollback("does-not-exist")).toThrow(ReservationNotFoundError);
  });

  it("double-commit is refused (reservation is consumed on first commit)", () => {
    const tracker = makeTracker({ filamentGrams: 500 });
    const reservation = tracker.reserve({ filamentGrams: 100 });
    tracker.commit(reservation.id);
    expect(() => tracker.commit(reservation.id)).toThrow(ReservationNotFoundError);
  });
});
