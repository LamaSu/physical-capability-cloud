/**
 * Per-capability `settlementMode` field tests (Week 2 centralized
 * substrate).
 *
 * Two invariants:
 *  1. New capabilities can omit the field and are interpreted as
 *     "centralized" via `resolveSettlementMode()`.
 *  2. Existing on-chain capabilities that explicitly set "onchain" are
 *     preserved — `resolveSettlementMode()` must NOT silently rewrite
 *     them to the new default.
 */

import { describe, it, expect } from "vitest";
import {
  CapabilitySchema,
  SettlementModeSchema,
  DEFAULT_SETTLEMENT_MODE,
  resolveSettlementMode,
} from "../schemas/index.js";

const baseCapability = {
  id: "cap-1",
  kernelId: "kernel-test",
  type: "fdm" as const,
  name: "Test FDM",
  materials: ["pla"],
  assuranceTiers: [0 as const, 1 as const],
  pricing: {
    currency: "USDC" as const,
    baseCost: "5",
    minimum: "5",
  },
  availability: {
    timezone: "UTC",
    windows: { mon: [{ start: "2026-04-27T09:00:00Z", end: "2026-04-27T17:00:00Z" }] },
  },
  location: { lat: 0, lng: 0 },
  queueDepth: 0,
};

describe("CapabilitySchema settlementMode field", () => {
  it("new capabilities default to 'centralized' via resolveSettlementMode (field omitted)", () => {
    const parsed = CapabilitySchema.parse(baseCapability);
    // Field is optional → not present on the parsed object.
    expect(parsed.settlementMode).toBeUndefined();
    // The resolver applies the documented default.
    expect(resolveSettlementMode(parsed)).toBe("centralized");
    expect(DEFAULT_SETTLEMENT_MODE).toBe("centralized");
  });

  it("existing on-chain capabilities preserve 'onchain' (no silent rewrite)", () => {
    const onchain = { ...baseCapability, id: "cap-onchain", settlementMode: "onchain" as const };
    const parsed = CapabilitySchema.parse(onchain);
    expect(parsed.settlementMode).toBe("onchain");
    expect(resolveSettlementMode(parsed)).toBe("onchain");
  });

  it("SettlementModeSchema rejects unknown modes", () => {
    expect(SettlementModeSchema.safeParse("centralized").success).toBe(true);
    expect(SettlementModeSchema.safeParse("onchain").success).toBe(true);
    expect(SettlementModeSchema.safeParse("hybrid").success).toBe(false);
    expect(SettlementModeSchema.safeParse(null).success).toBe(false);
  });

  it("resolveSettlementMode handles null/undefined capability gracefully", () => {
    expect(resolveSettlementMode(null)).toBe("centralized");
    expect(resolveSettlementMode(undefined)).toBe("centralized");
    expect(resolveSettlementMode({})).toBe("centralized");
  });
});
