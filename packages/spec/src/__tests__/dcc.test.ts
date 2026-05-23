import { describe, it, expect } from "vitest";
import {
  DigitalCaptureClass,
  DCC_MULTIPLIERS,
  DCC_TIER,
  TIER_TO_DCC,
  applyDccDowngrade,
  DigitalCaptureClassSchema,
} from "../types/dcc.js";

describe("DCC enum + multipliers", () => {
  it("exposes six classes DCC0..DCC5 as string-valued enum members", () => {
    expect(DigitalCaptureClass.DCC0).toBe("DCC0");
    expect(DigitalCaptureClass.DCC5).toBe("DCC5");
    expect(Object.values(DigitalCaptureClass)).toEqual([
      "DCC0",
      "DCC1",
      "DCC2",
      "DCC3",
      "DCC4",
      "DCC5",
    ]);
  });

  it("matches CC0..CC5 multipliers numerically", () => {
    // Same accounting as physical CVP per spec §3.1.
    expect(DCC_MULTIPLIERS[DigitalCaptureClass.DCC0]).toBe(0.70);
    expect(DCC_MULTIPLIERS[DigitalCaptureClass.DCC1]).toBe(0.92);
    expect(DCC_MULTIPLIERS[DigitalCaptureClass.DCC2]).toBe(0.96);
    expect(DCC_MULTIPLIERS[DigitalCaptureClass.DCC3]).toBe(1.00);
    expect(DCC_MULTIPLIERS[DigitalCaptureClass.DCC4]).toBe(1.00);
    expect(DCC_MULTIPLIERS[DigitalCaptureClass.DCC5]).toBe(1.00);
  });

  it("provides 0..5 numeric tier mapping in monotone order", () => {
    expect(DCC_TIER[DigitalCaptureClass.DCC0]).toBe(0);
    expect(DCC_TIER[DigitalCaptureClass.DCC3]).toBe(3);
    expect(DCC_TIER[DigitalCaptureClass.DCC5]).toBe(5);
  });

  it("round-trips DCC <-> tier", () => {
    for (const dcc of Object.values(DigitalCaptureClass)) {
      const tier = DCC_TIER[dcc];
      expect(TIER_TO_DCC[tier]).toBe(dcc);
    }
  });
});

describe("applyDccDowngrade — min-of-three rule", () => {
  it("does not downgrade when requested <= all ceilings", () => {
    const r = applyDccDowngrade(
      DigitalCaptureClass.DCC1,
      DigitalCaptureClass.DCC3,
      DigitalCaptureClass.DCC4,
    );
    expect(r.effective).toBe(DigitalCaptureClass.DCC1);
    expect(r.downgraded).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it("downgrades to trust-tier ceiling when that is the tightest cap", () => {
    const r = applyDccDowngrade(
      DigitalCaptureClass.DCC5,
      DigitalCaptureClass.DCC2,
      DigitalCaptureClass.DCC4,
    );
    expect(r.effective).toBe(DigitalCaptureClass.DCC2);
    expect(r.downgraded).toBe(true);
    expect(r.reason).toContain("trustTierCeiling");
  });

  it("downgrades to tool-assurance ceiling when that is the tightest cap", () => {
    const r = applyDccDowngrade(
      DigitalCaptureClass.DCC5,
      DigitalCaptureClass.DCC4,
      DigitalCaptureClass.DCC1,
    );
    expect(r.effective).toBe(DigitalCaptureClass.DCC1);
    expect(r.downgraded).toBe(true);
    expect(r.reason).toContain("toolAssuranceCeiling");
  });

  it("collapses to DCC0 when all caps are DCC0", () => {
    const r = applyDccDowngrade(
      DigitalCaptureClass.DCC5,
      DigitalCaptureClass.DCC0,
      DigitalCaptureClass.DCC0,
    );
    expect(r.effective).toBe(DigitalCaptureClass.DCC0);
    expect(r.downgraded).toBe(true);
  });

  it("when tool and tier ceilings tie, reports tool-assurance cap (worst-case-named)", () => {
    // Tie-break choice: t < a is false when t == a -> reports toolAssuranceCeiling.
    const r = applyDccDowngrade(
      DigitalCaptureClass.DCC5,
      DigitalCaptureClass.DCC2,
      DigitalCaptureClass.DCC2,
    );
    expect(r.effective).toBe(DigitalCaptureClass.DCC2);
    expect(r.downgraded).toBe(true);
    expect(r.reason).toContain("toolAssuranceCeiling");
  });
});

describe("DigitalCaptureClassSchema (zod)", () => {
  it("accepts all six DCC values", () => {
    for (const dcc of Object.values(DigitalCaptureClass)) {
      expect(() => DigitalCaptureClassSchema.parse(dcc)).not.toThrow();
    }
  });

  it("rejects unknown values", () => {
    expect(() => DigitalCaptureClassSchema.parse("DCC6")).toThrow();
    expect(() => DigitalCaptureClassSchema.parse("CC1")).toThrow();
    expect(() => DigitalCaptureClassSchema.parse(null)).toThrow();
  });
});
