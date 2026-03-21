import { describe, it, expect } from "vitest";
import { CsdConstraintEvaluator } from "../csd-evaluator.js";
import type { CsdConstraint } from "@pcc/spec";

const evaluator = new CsdConstraintEvaluator();

// ── Helpers ────────────────────────────────────────────────────────

function makeConstraint(
  overrides: Partial<CsdConstraint> & Pick<CsdConstraint, "when" | "then">,
): CsdConstraint {
  return {
    key: "test",
    human: "Test constraint",
    severity: "error",
    ...overrides,
  };
}

// ── Single condition tests ─────────────────────────────────────────

describe("CsdConstraintEvaluator - single conditions", () => {
  it("equals: fires when param matches", () => {
    const c = makeConstraint({
      when: [{ param: "material", operator: "equals", value: "pla" }],
      then: [{ action: "reject", message: "PLA rejected" }],
    });
    const result = evaluator.evaluate([c], { material: "pla" });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe("PLA rejected");
    expect(result.valid).toBe(false);
  });

  it("equals: does NOT fire when param does not match", () => {
    const c = makeConstraint({
      when: [{ param: "material", operator: "equals", value: "pla" }],
      then: [{ action: "reject", message: "PLA rejected" }],
    });
    const result = evaluator.evaluate([c], { material: "petg" });
    expect(result.errors).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it("notEquals: fires when value differs", () => {
    const c = makeConstraint({
      when: [{ param: "duplex", operator: "notEquals", value: "one-sided" }],
      then: [{ action: "reject", message: "Must be one-sided" }],
    });
    const result = evaluator.evaluate([c], { duplex: "two-sided-long-edge" });
    expect(result.errors).toHaveLength(1);
  });

  it("notEquals: does NOT fire when value matches", () => {
    const c = makeConstraint({
      when: [{ param: "duplex", operator: "notEquals", value: "one-sided" }],
      then: [{ action: "reject", message: "Must be one-sided" }],
    });
    const result = evaluator.evaluate([c], { duplex: "one-sided" });
    expect(result.errors).toHaveLength(0);
  });

  it("in: fires when value is in list", () => {
    const c = makeConstraint({
      when: [{ param: "mediaType", operator: "in", value: ["envelope", "cardstock"] }],
      then: [{ action: "reject", message: "Unsupported type" }],
    });
    const result = evaluator.evaluate([c], { mediaType: "envelope" });
    expect(result.errors).toHaveLength(1);
  });

  it("notIn: fires when value is NOT in list", () => {
    const c = makeConstraint({
      when: [
        {
          param: "mediaType",
          operator: "notIn",
          value: ["photographic-high-gloss", "photographic-matte"],
        },
      ],
      then: [{ action: "reject", message: "Requires photo paper" }],
    });
    const result = evaluator.evaluate([c], { mediaType: "stationery" });
    expect(result.errors).toHaveLength(1);
  });

  it("notIn: does NOT fire when value IS in the list", () => {
    const c = makeConstraint({
      when: [
        {
          param: "mediaType",
          operator: "notIn",
          value: ["photographic-high-gloss", "photographic-matte"],
        },
      ],
      then: [{ action: "reject", message: "Requires photo paper" }],
    });
    const result = evaluator.evaluate([c], { mediaType: "photographic-high-gloss" });
    expect(result.errors).toHaveLength(0);
  });

  it("gt: fires when numeric value exceeds threshold", () => {
    const c = makeConstraint({
      when: [{ param: "infill", operator: "gt", value: 80 }],
      then: [{ action: "warn", message: "High infill" }],
    });
    const result = evaluator.evaluate([c], { infill: 81 });
    expect(result.warnings).toHaveLength(1);
  });

  it("gt: does NOT fire at exact boundary", () => {
    const c = makeConstraint({
      when: [{ param: "infill", operator: "gt", value: 80 }],
      then: [{ action: "warn", message: "High infill" }],
    });
    const result = evaluator.evaluate([c], { infill: 80 });
    expect(result.warnings).toHaveLength(0);
  });

  it("lt: fires when numeric value is below threshold", () => {
    const c = makeConstraint({
      when: [{ param: "copies", operator: "lt", value: 1 }],
      then: [{ action: "reject", message: "Need at least 1 copy" }],
    });
    // copies: 0 (edge case — someone passed 0)
    const result = evaluator.evaluate([c], { copies: 0 });
    expect(result.errors).toHaveLength(1);
  });

  it("gte: fires when value >= threshold", () => {
    const c = makeConstraint({
      when: [{ param: "copies", operator: "gte", value: 100 }],
      then: [{ action: "warn", message: "Bulk order" }],
    });
    const resultAt100 = evaluator.evaluate([c], { copies: 100 });
    const resultAt99 = evaluator.evaluate([c], { copies: 99 });
    expect(resultAt100.warnings).toHaveLength(1);
    expect(resultAt99.warnings).toHaveLength(0);
  });

  it("lte: fires when value <= threshold", () => {
    const c = makeConstraint({
      when: [{ param: "copies", operator: "lte", value: 5 }],
      then: [{ action: "warn", message: "Small order" }],
    });
    const resultAt5 = evaluator.evaluate([c], { copies: 5 });
    const resultAt6 = evaluator.evaluate([c], { copies: 6 });
    expect(resultAt5.warnings).toHaveLength(1);
    expect(resultAt6.warnings).toHaveLength(0);
  });

  it("does not fire when param is undefined", () => {
    const c = makeConstraint({
      when: [{ param: "material", operator: "equals", value: "pla" }],
      then: [{ action: "reject", message: "rejected" }],
    });
    const result = evaluator.evaluate([c], {});
    expect(result.errors).toHaveLength(0);
  });
});

// ── Compound condition tests (AND of all when[]) ───────────────────

describe("CsdConstraintEvaluator - compound conditions", () => {
  it("fires only when ALL conditions match (AND semantics)", () => {
    const c = makeConstraint({
      when: [
        { param: "borderless", operator: "equals", value: true },
        { param: "mediaType", operator: "notIn", value: ["photographic-high-gloss", "photographic-matte"] },
      ],
      then: [{ action: "reject", message: "Borderless requires photo paper" }],
    });

    // Both conditions true → fires
    const r1 = evaluator.evaluate([c], { borderless: true, mediaType: "stationery" });
    expect(r1.errors).toHaveLength(1);

    // First false → does NOT fire
    const r2 = evaluator.evaluate([c], { borderless: false, mediaType: "stationery" });
    expect(r2.errors).toHaveLength(0);

    // Second false → does NOT fire
    const r3 = evaluator.evaluate([c], { borderless: true, mediaType: "photographic-high-gloss" });
    expect(r3.errors).toHaveLength(0);
  });

  it("envelope + duplex compound constraint", () => {
    const c = makeConstraint({
      key: "2d-print-2",
      human: "Envelopes cannot be printed double-sided",
      severity: "error",
      when: [
        { param: "mediaType", operator: "in", value: ["envelope"] },
        { param: "duplex", operator: "notEquals", value: "one-sided" },
      ],
      then: [{ action: "restrictTo", param: "duplex", values: ["one-sided"] }],
    });

    // Envelope + duplex → fires, restriction applied
    const r1 = evaluator.evaluate([c], { mediaType: "envelope", duplex: "two-sided-long-edge" });
    expect(r1.paramRestrictions.has("duplex")).toBe(true);
    expect(r1.paramRestrictions.get("duplex")?.restrictTo).toEqual(["one-sided"]);

    // Envelope + one-sided → does NOT fire
    const r2 = evaluator.evaluate([c], { mediaType: "envelope", duplex: "one-sided" });
    expect(r2.paramRestrictions.has("duplex")).toBe(false);

    // Non-envelope + duplex → does NOT fire
    const r3 = evaluator.evaluate([c], { mediaType: "stationery", duplex: "two-sided-long-edge" });
    expect(r3.paramRestrictions.has("duplex")).toBe(false);
  });
});

// ── Action tests ───────────────────────────────────────────────────

describe("CsdConstraintEvaluator - actions", () => {
  it("reject produces an error", () => {
    const c = makeConstraint({
      severity: "error",
      when: [{ param: "borderless", operator: "equals", value: true }],
      then: [{ action: "reject", message: "Cannot use borderless" }],
    });
    const result = evaluator.evaluate([c], { borderless: true });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].severity).toBe("error");
    expect(result.errors[0].message).toBe("Cannot use borderless");
  });

  it("warn produces a warning, not an error", () => {
    const c = makeConstraint({
      severity: "warning",
      when: [{ param: "resolution", operator: "in", value: ["2400", "4800"] }],
      then: [{ action: "warn", message: "High DPI on plain paper" }],
    });
    const result = evaluator.evaluate([c], { resolution: "2400" });
    expect(result.valid).toBe(true); // warnings don't invalidate
    expect(result.warnings).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("restrictTo accumulates (intersection when multiple constraints fire)", () => {
    const c1 = makeConstraint({
      key: "c1",
      when: [{ param: "a", operator: "equals", value: 1 }],
      then: [{ action: "restrictTo", param: "target", values: ["x", "y", "z"] }],
    });
    const c2 = makeConstraint({
      key: "c2",
      when: [{ param: "b", operator: "equals", value: 2 }],
      then: [{ action: "restrictTo", param: "target", values: ["y", "z", "w"] }],
    });
    const result = evaluator.evaluate([c1, c2], { a: 1, b: 2 });
    // Intersection of ["x", "y", "z"] and ["y", "z", "w"] = ["y", "z"]
    expect(result.paramRestrictions.get("target")?.restrictTo).toEqual(["y", "z"]);
  });

  it("exclude accumulates (union across multiple constraints)", () => {
    const c1 = makeConstraint({
      key: "c1",
      when: [{ param: "a", operator: "equals", value: 1 }],
      then: [{ action: "exclude", param: "target", values: ["x"] }],
    });
    const c2 = makeConstraint({
      key: "c2",
      when: [{ param: "b", operator: "equals", value: 2 }],
      then: [{ action: "exclude", param: "target", values: ["y"] }],
    });
    const result = evaluator.evaluate([c1, c2], { a: 1, b: 2 });
    expect(result.paramRestrictions.get("target")?.exclude).toEqual(["x", "y"]);
  });

  it("setMin takes the highest (most restrictive lower bound)", () => {
    const c1 = makeConstraint({
      key: "c1",
      when: [{ param: "a", operator: "equals", value: 1 }],
      then: [{ action: "setMin", param: "qty", value: 5 }],
    });
    const c2 = makeConstraint({
      key: "c2",
      when: [{ param: "b", operator: "equals", value: 2 }],
      then: [{ action: "setMin", param: "qty", value: 10 }],
    });
    const result = evaluator.evaluate([c1, c2], { a: 1, b: 2 });
    expect(result.paramRestrictions.get("qty")?.setMin).toBe(10);
  });

  it("setMax takes the lowest (most restrictive upper bound)", () => {
    const c1 = makeConstraint({
      key: "c1",
      when: [{ param: "a", operator: "equals", value: 1 }],
      then: [{ action: "setMax", param: "qty", value: 100 }],
    });
    const c2 = makeConstraint({
      key: "c2",
      when: [{ param: "b", operator: "equals", value: 2 }],
      then: [{ action: "setMax", param: "qty", value: 50 }],
    });
    const result = evaluator.evaluate([c1, c2], { a: 1, b: 2 });
    expect(result.paramRestrictions.get("qty")?.setMax).toBe(50);
  });
});

// ── 2D print constraints ───────────────────────────────────────────

describe("CsdConstraintEvaluator - 2D print CSD constraints", () => {
  // 2d-print-1: borderless + non-photo paper → reject
  it("borderless on plain paper → reject", () => {
    const c: CsdConstraint = {
      key: "2d-print-1",
      human: "Borderless printing only available on photo paper",
      severity: "error",
      when: [
        { param: "borderless", operator: "equals", value: true },
        { param: "mediaType", operator: "notIn", value: ["photographic-high-gloss", "photographic-matte"] },
      ],
      then: [{ action: "reject", message: "Borderless printing requires photo paper" }],
    };
    const result = evaluator.evaluate([c], { borderless: true, mediaType: "stationery" });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toBe("Borderless printing requires photo paper");
  });

  it("borderless on photo paper → no error", () => {
    const c: CsdConstraint = {
      key: "2d-print-1",
      human: "Borderless printing only available on photo paper",
      severity: "error",
      when: [
        { param: "borderless", operator: "equals", value: true },
        { param: "mediaType", operator: "notIn", value: ["photographic-high-gloss", "photographic-matte"] },
      ],
      then: [{ action: "reject", message: "Borderless printing requires photo paper" }],
    };
    const result = evaluator.evaluate([c], { borderless: true, mediaType: "photographic-high-gloss" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // 2d-print-2: envelope + duplex → restrictTo one-sided
  it("envelope + duplex → restrictTo one-sided", () => {
    const c: CsdConstraint = {
      key: "2d-print-2",
      human: "Envelopes cannot be printed double-sided",
      severity: "error",
      when: [
        { param: "mediaType", operator: "in", value: ["envelope"] },
        { param: "duplex", operator: "notEquals", value: "one-sided" },
      ],
      then: [{ action: "restrictTo", param: "duplex", values: ["one-sided"] }],
    };
    const result = evaluator.evaluate([c], { mediaType: "envelope", duplex: "two-sided-long-edge" });
    expect(result.paramRestrictions.get("duplex")?.restrictTo).toEqual(["one-sided"]);
  });
});

// ── FDM constraints ────────────────────────────────────────────────

describe("CsdConstraintEvaluator - FDM CSD constraints", () => {
  const fdmConstraints: CsdConstraint[] = [
    {
      key: "fdm-1",
      human: "PLA cannot be vapor smoothed",
      severity: "error",
      when: [
        { param: "material", operator: "equals", value: "pla" },
        { param: "postProcessing", operator: "in", value: ["vapor-smoothing"] },
      ],
      then: [{ action: "exclude", param: "postProcessing", values: ["vapor-smoothing"] }],
    },
    {
      key: "fdm-3",
      human: "TPU is restricted to normal support type only",
      severity: "error",
      when: [{ param: "material", operator: "equals", value: "tpu" }],
      then: [{ action: "restrictTo", param: "supportType", values: ["normal"] }],
    },
  ];

  it("PLA + vapor-smoothing → exclude vapor-smoothing", () => {
    const result = evaluator.evaluate(fdmConstraints, {
      material: "pla",
      postProcessing: "vapor-smoothing",
    });
    expect(result.paramRestrictions.get("postProcessing")?.exclude).toContain("vapor-smoothing");
  });

  it("PLA + sanding → no restrictions on postProcessing", () => {
    const result = evaluator.evaluate(fdmConstraints, {
      material: "pla",
      postProcessing: "sanding",
    });
    // fdm-1 requires postProcessing 'in' ["vapor-smoothing"] — so it does NOT fire for sanding
    expect(result.paramRestrictions.has("postProcessing")).toBe(false);
  });

  it("TPU → restricts supportType to normal only", () => {
    const result = evaluator.evaluate(fdmConstraints, { material: "tpu" });
    expect(result.paramRestrictions.get("supportType")?.restrictTo).toEqual(["normal"]);
  });

  it("PETG → no support restrictions", () => {
    const result = evaluator.evaluate(fdmConstraints, { material: "petg" });
    expect(result.paramRestrictions.has("supportType")).toBe(false);
  });
});
