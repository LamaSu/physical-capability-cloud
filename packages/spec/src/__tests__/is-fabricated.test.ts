/**
 * Tests for the canonical fabricated-evidence predicate (coord #312/#316).
 *
 * The predicate is the ONE contract shared by every detector site, so it must
 * agree exactly with the adapter lane's dual tag:
 *   fabricated iff source.simulated === true || payload.mock === true.
 */

import { describe, it, expect } from "vitest";
import { isFabricated, bundleHasFabricatedEvents } from "../evidence/is-fabricated.js";
import type { EvidenceEvent } from "../types/evidence.js";

function ev(overrides: Partial<EvidenceEvent> = {}): EvidenceEvent {
  return {
    id: "ev-1",
    type: "execution_completed",
    timestamp: new Date().toISOString(),
    source: { deviceId: "dev-1", deviceType: "controller", kernelId: "k-1" },
    payload: {},
    hash: "a".repeat(64) as EvidenceEvent["hash"],
    ...overrides,
  };
}

describe("isFabricated", () => {
  it("is false for an honest event (no tags)", () => {
    expect(isFabricated(ev())).toBe(false);
  });

  it("is true when source.simulated === true (per-device suspenders)", () => {
    expect(
      isFabricated(ev({ source: { deviceId: "d", deviceType: "controller", kernelId: "k", simulated: true } })),
    ).toBe(true);
  });

  it("is true when payload.mock === true (per-event belt)", () => {
    expect(isFabricated(ev({ payload: { mock: true } }))).toBe(true);
  });

  it("is true when both tags are present", () => {
    expect(
      isFabricated(
        ev({
          source: { deviceId: "d", deviceType: "controller", kernelId: "k", simulated: true },
          payload: { mock: true },
        }),
      ),
    ).toBe(true);
  });

  it("is false when tags are explicitly false (only === true counts)", () => {
    expect(
      isFabricated(
        ev({
          source: { deviceId: "d", deviceType: "controller", kernelId: "k", simulated: false },
          payload: { mock: false },
        }),
      ),
    ).toBe(false);
  });

  it("does not treat a truthy-but-not-true value as fabricated", () => {
    // Strict === true guards against accidental coercion (e.g. a string "true").
    expect(isFabricated(ev({ payload: { mock: "true" as unknown as boolean } }))).toBe(false);
  });
});

describe("bundleHasFabricatedEvents", () => {
  it("is false when every event is honest", () => {
    expect(bundleHasFabricatedEvents({ events: [ev(), ev()] })).toBe(false);
  });

  it("is true when ANY event carries source.simulated", () => {
    expect(
      bundleHasFabricatedEvents({
        events: [
          ev(),
          ev({ source: { deviceId: "d", deviceType: "controller", kernelId: "k", simulated: true } }),
        ],
      }),
    ).toBe(true);
  });

  it("is true when ANY event carries payload.mock", () => {
    expect(bundleHasFabricatedEvents({ events: [ev(), ev({ payload: { mock: true } })] })).toBe(true);
  });

  it("is false for an empty/absent events array (classifies only what it can see)", () => {
    expect(bundleHasFabricatedEvents({ events: [] })).toBe(false);
    expect(bundleHasFabricatedEvents({})).toBe(false);
  });
});
