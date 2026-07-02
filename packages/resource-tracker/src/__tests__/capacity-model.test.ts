import { describe, it, expect } from "vitest";
import { CapacityModel } from "../capacity-model.js";
import { OutOfCalibratedRangeError, UnknownResourceError } from "../errors.js";

describe("CapacityModel", () => {
  it("accepts an amount within [min, max]", () => {
    const model = new CapacityModel({ filamentGrams: { min: 1, max: 1000, unit: "g" } });
    expect(() => model.assertInRange("filamentGrams", 500)).not.toThrow();
    expect(() => model.assertInRange("filamentGrams", 1)).not.toThrow();
    expect(() => model.assertInRange("filamentGrams", 1000)).not.toThrow();
  });

  it("refuses an amount above max", () => {
    const model = new CapacityModel({ filamentGrams: { min: 1, max: 1000, unit: "g" } });
    expect(() => model.assertInRange("filamentGrams", 1001)).toThrow(OutOfCalibratedRangeError);
  });

  it("refuses an amount below min", () => {
    const model = new CapacityModel({ filamentGrams: { min: 5, max: 1000, unit: "g" } });
    expect(() => model.assertInRange("filamentGrams", 4.9)).toThrow(OutOfCalibratedRangeError);
  });

  it("refuses NaN/Infinity as out of range", () => {
    const model = new CapacityModel({ filamentGrams: { min: 0, max: 1000 } });
    expect(() => model.assertInRange("filamentGrams", Number.NaN)).toThrow(OutOfCalibratedRangeError);
    expect(() => model.assertInRange("filamentGrams", Number.POSITIVE_INFINITY)).toThrow(OutOfCalibratedRangeError);
  });

  it("throws a typed error with structured details, not just a message", () => {
    const model = new CapacityModel({ filamentGrams: { min: 1, max: 1000, unit: "g" } });
    try {
      model.assertInRange("filamentGrams", 5000);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OutOfCalibratedRangeError);
      const e = err as OutOfCalibratedRangeError;
      expect(e.code).toBe("out_of_calibrated_range");
      expect(e.details).toMatchObject({ resource: "filamentGrams", requested: 5000, min: 1, max: 1000 });
    }
  });

  it("throws UnknownResourceError for an uncalibrated resource", () => {
    const model = new CapacityModel({ filamentGrams: { min: 0, max: 1000 } });
    expect(() => model.assertInRange("buildVolumeMm3", 100)).toThrow(UnknownResourceError);
  });

  it("rejects malformed bounds at construction time (max < min)", () => {
    expect(() => new CapacityModel({ bad: { min: 10, max: 5 } })).toThrow();
  });

  it("rejects negative min at construction time", () => {
    expect(() => new CapacityModel({ bad: { min: -1, max: 5 } })).toThrow();
  });

  it("resources() lists every calibrated resource name", () => {
    const model = new CapacityModel({
      filamentGrams: { min: 0, max: 1000 },
      buildVolumeMm3: { min: 0, max: 50_000 },
    });
    expect(model.resources().sort()).toEqual(["buildVolumeMm3", "filamentGrams"]);
  });
});
