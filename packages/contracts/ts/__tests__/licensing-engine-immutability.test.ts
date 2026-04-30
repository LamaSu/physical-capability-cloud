/**
 * Tests for LicensingEngine.setRateSchedule's immutability guard and the
 * companion unsafeReplaceRateSchedule escape hatch.
 *
 * Regression coverage for the 2026-04-29 fix that closed a "silent
 * off-chain/on-chain drift" gap: previously setRateSchedule allowed
 * re-registering a different schedule for the same ipId, which would have
 * masked bugs where downstream code thought it was reading the on-chain
 * canonical schedule but actually got a stale or rewritten cache.
 */

import { describe, expect, it } from "vitest";
import { computeScheduleHash, type RateSchedule } from "@pcc/spec";
import { LicensingEngine } from "../licensing-engine.js";

const IP_A = "0xA000000000000000000000000000000000000001";
const IP_B = "0xA000000000000000000000000000000000000002";

function makeSchedule(
  bps: number,
  publishedAt: string,
  version = 1,
): RateSchedule {
  const segments = [
    {
      kind: "constant" as const,
      startTime: 0,
      endTime: null,
      bps,
    },
  ];
  const scheduleHash = computeScheduleHash({
    version,
    segments,
    publishedAt,
  });
  return {
    version,
    segments,
    publishedAt,
    scheduleHash,
  };
}

describe("LicensingEngine.setRateSchedule immutability guard", () => {
  it("accepts the first schedule for an ipId", () => {
    const engine = new LicensingEngine();
    const s = makeSchedule(150, "2026-01-01T00:00:00Z");
    expect(() => engine.setRateSchedule(IP_A, s)).not.toThrow();
    expect(engine.getRateSchedule(IP_A)?.scheduleHash).toBe(s.scheduleHash);
  });

  it("is idempotent when re-registering the same schedule (same hash)", () => {
    const engine = new LicensingEngine();
    const s = makeSchedule(150, "2026-01-01T00:00:00Z");
    engine.setRateSchedule(IP_A, s);
    expect(() => engine.setRateSchedule(IP_A, s)).not.toThrow();
  });

  it("REJECTS re-registering a different schedule for the same ipId", () => {
    const engine = new LicensingEngine();
    const s1 = makeSchedule(150, "2026-01-01T00:00:00Z");
    const s2 = makeSchedule(200, "2026-06-01T00:00:00Z", 2);
    engine.setRateSchedule(IP_A, s1);
    expect(() => engine.setRateSchedule(IP_A, s2)).toThrow(
      /already has schedule/,
    );
    // Cache should still hold the original.
    expect(engine.getRateSchedule(IP_A)?.scheduleHash).toBe(s1.scheduleHash);
  });

  it("allows different ipIds to register different schedules independently", () => {
    const engine = new LicensingEngine();
    const sA = makeSchedule(150, "2026-01-01T00:00:00Z");
    const sB = makeSchedule(50, "2026-01-01T00:00:00Z");
    expect(() => engine.setRateSchedule(IP_A, sA)).not.toThrow();
    expect(() => engine.setRateSchedule(IP_B, sB)).not.toThrow();
  });

  it("throws on hash mismatch (canonical hash != provided hash)", () => {
    const engine = new LicensingEngine();
    const s = makeSchedule(150, "2026-01-01T00:00:00Z");
    const tampered: RateSchedule = {
      ...s,
      scheduleHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
    expect(() => engine.setRateSchedule(IP_A, tampered)).toThrow(
      /scheduleHash mismatch/,
    );
  });

  it("throws on missing ipId", () => {
    const engine = new LicensingEngine();
    const s = makeSchedule(150, "2026-01-01T00:00:00Z");
    expect(() => engine.setRateSchedule("", s)).toThrow(/ipId is required/);
  });
});

describe("LicensingEngine.unsafeReplaceRateSchedule escape hatch", () => {
  it("replaces the cached schedule with a different-hash schedule", () => {
    const engine = new LicensingEngine();
    const s1 = makeSchedule(150, "2026-01-01T00:00:00Z");
    const s2 = makeSchedule(200, "2026-06-01T00:00:00Z", 2);
    engine.setRateSchedule(IP_A, s1);
    expect(engine.getRateSchedule(IP_A)?.scheduleHash).toBe(s1.scheduleHash);

    engine.unsafeReplaceRateSchedule(IP_A, s2);
    expect(engine.getRateSchedule(IP_A)?.scheduleHash).toBe(s2.scheduleHash);
  });

  it("still validates the canonical hash even on replace", () => {
    const engine = new LicensingEngine();
    const s = makeSchedule(150, "2026-01-01T00:00:00Z");
    const tampered: RateSchedule = {
      ...s,
      scheduleHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
    expect(() => engine.unsafeReplaceRateSchedule(IP_A, tampered)).toThrow(
      /scheduleHash mismatch/,
    );
  });

  it("works on an ipId that has no prior schedule (no-op replace)", () => {
    const engine = new LicensingEngine();
    const s = makeSchedule(75, "2026-01-01T00:00:00Z");
    expect(() => engine.unsafeReplaceRateSchedule(IP_A, s)).not.toThrow();
    expect(engine.getRateSchedule(IP_A)?.scheduleHash).toBe(s.scheduleHash);
  });
});
