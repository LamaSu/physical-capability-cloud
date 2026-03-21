import { describe, it, expect } from "vitest";
import { CsdInvariantEvaluator } from "../csd-invariant-evaluator.js";

const evaluator = new CsdInvariantEvaluator();

// ── Simple comparisons ─────────────────────────────────────────────

describe("CsdInvariantEvaluator - comparisons", () => {
  it("== matches equal string values", () => {
    expect(evaluator.evaluate("status == 'active'", { status: "active" })).toBe(true);
    expect(evaluator.evaluate("status == 'active'", { status: "inactive" })).toBe(false);
  });

  it("!= matches unequal values", () => {
    expect(evaluator.evaluate("mediaSize != 'custom'", { mediaSize: "letter" })).toBe(true);
    expect(evaluator.evaluate("mediaSize != 'custom'", { mediaSize: "custom" })).toBe(false);
  });

  it("< compares numbers", () => {
    expect(evaluator.evaluate("infill < 80", { infill: 79 })).toBe(true);
    expect(evaluator.evaluate("infill < 80", { infill: 80 })).toBe(false);
    expect(evaluator.evaluate("infill < 80", { infill: 81 })).toBe(false);
  });

  it("> compares numbers", () => {
    expect(evaluator.evaluate("infill > 80", { infill: 81 })).toBe(true);
    expect(evaluator.evaluate("infill > 80", { infill: 80 })).toBe(false);
  });

  it("<= compares numbers (inclusive)", () => {
    expect(evaluator.evaluate("copies <= 5", { copies: 5 })).toBe(true);
    expect(evaluator.evaluate("copies <= 5", { copies: 4 })).toBe(true);
    expect(evaluator.evaluate("copies <= 5", { copies: 6 })).toBe(false);
  });

  it(">= compares numbers (inclusive)", () => {
    expect(evaluator.evaluate("copies >= 10", { copies: 10 })).toBe(true);
    expect(evaluator.evaluate("copies >= 10", { copies: 11 })).toBe(true);
    expect(evaluator.evaluate("copies >= 10", { copies: 9 })).toBe(false);
  });

  it("== compares numbers", () => {
    expect(evaluator.evaluate("copies == 1", { copies: 1 })).toBe(true);
    expect(evaluator.evaluate("copies == 1", { copies: 2 })).toBe(false);
  });

  it("!= compares numbers", () => {
    expect(evaluator.evaluate("copies != 0", { copies: 1 })).toBe(true);
    expect(evaluator.evaluate("copies != 0", { copies: 0 })).toBe(false);
  });
});

// ── Logical operators ──────────────────────────────────────────────

describe("CsdInvariantEvaluator - logical operators", () => {
  it("or: true if either side is true", () => {
    expect(evaluator.evaluate("a == 1 or b == 2", { a: 1, b: 9 })).toBe(true);
    expect(evaluator.evaluate("a == 1 or b == 2", { a: 9, b: 2 })).toBe(true);
    expect(evaluator.evaluate("a == 1 or b == 2", { a: 9, b: 9 })).toBe(false);
    expect(evaluator.evaluate("a == 1 or b == 2", { a: 1, b: 2 })).toBe(true);
  });

  it("and: true only if both sides are true", () => {
    expect(evaluator.evaluate("a == 1 and b == 2", { a: 1, b: 2 })).toBe(true);
    expect(evaluator.evaluate("a == 1 and b == 2", { a: 1, b: 9 })).toBe(false);
    expect(evaluator.evaluate("a == 1 and b == 2", { a: 9, b: 2 })).toBe(false);
  });

  it("not: negates the expression", () => {
    expect(evaluator.evaluate("not a == 1", { a: 2 })).toBe(true);
    expect(evaluator.evaluate("not a == 1", { a: 1 })).toBe(false);
  });

  it("operator precedence: and binds tighter than or", () => {
    // "a or b and c" = "a or (b and c)"
    expect(evaluator.evaluate("a == 1 or b == 2 and c == 3", { a: 0, b: 2, c: 3 })).toBe(true);
    expect(evaluator.evaluate("a == 1 or b == 2 and c == 3", { a: 0, b: 2, c: 0 })).toBe(false);
    expect(evaluator.evaluate("a == 1 or b == 2 and c == 3", { a: 1, b: 0, c: 0 })).toBe(true);
  });
});

// ── Property access ────────────────────────────────────────────────

describe("CsdInvariantEvaluator - property access", () => {
  it("accesses nested properties via dot notation", () => {
    const context = {
      device: {
        name: "Canon PIXMA",
        resolution: 4800,
      },
    };
    expect(evaluator.evaluate("device.resolution >= 4800", context)).toBe(true);
    expect(evaluator.evaluate("device.resolution >= 5000", context)).toBe(false);
  });

  it("returns undefined (falsy) for missing properties", () => {
    expect(evaluator.evaluate("device.missingProp == 'value'", { device: {} })).toBe(false);
  });

  it("accesses top-level properties", () => {
    expect(evaluator.evaluate("mediaSize == 'custom'", { mediaSize: "custom" })).toBe(true);
  });
});

// ── includes() for array membership ───────────────────────────────

describe("CsdInvariantEvaluator - includes()", () => {
  it("includes() on an array returns true if the element is present", () => {
    const context = {
      device: {
        capabilities: ["iso_a3_297x420mm", "na_letter_8.5x11in", "iso_a4_210x297mm"],
      },
    };
    expect(
      evaluator.evaluate("device.capabilities.includes('iso_a3_297x420mm')", context),
    ).toBe(true);
    expect(
      evaluator.evaluate("device.capabilities.includes('custom_giant_size')", context),
    ).toBe(false);
  });

  it("includes() on a missing array returns false", () => {
    const context = { device: {} };
    expect(
      evaluator.evaluate("device.capabilities.includes('iso_a3_297x420mm')", context),
    ).toBe(false);
  });

  it("includes() on a string tests substring presence", () => {
    const context = { model: "Canon PIXMA TR8620" };
    expect(evaluator.evaluate("model.includes('PIXMA')", context)).toBe(true);
    expect(evaluator.evaluate("model.includes('Epson')", context)).toBe(false);
  });
});

// ── Parentheses ────────────────────────────────────────────────────

describe("CsdInvariantEvaluator - parentheses", () => {
  it("parentheses change evaluation order", () => {
    // Without parens: "false or (true and false)" = false
    // With parens:    "(false or true) and false" = false
    expect(evaluator.evaluate("(a == 1 or b == 2) and c == 3", { a: 0, b: 2, c: 3 })).toBe(true);
    expect(evaluator.evaluate("(a == 1 or b == 2) and c == 3", { a: 0, b: 2, c: 0 })).toBe(false);
  });

  it("nested parentheses work correctly", () => {
    expect(
      evaluator.evaluate("(a == 1 and (b == 2 or c == 3))", { a: 1, b: 9, c: 3 }),
    ).toBe(true);
    expect(
      evaluator.evaluate("(a == 1 and (b == 2 or c == 3))", { a: 1, b: 9, c: 9 }),
    ).toBe(false);
  });
});

// ── 2D print invariant ─────────────────────────────────────────────

describe("CsdInvariantEvaluator - 2D print invariant", () => {
  const expression = "mediaSize != 'custom' or device.capabilities.includes('iso_a3_297x420mm')";

  it("invariant holds when mediaSize is not custom", () => {
    const context = { mediaSize: "na_letter_8.5x11in", device: { capabilities: [] } };
    expect(evaluator.evaluate(expression, context)).toBe(true);
  });

  it("invariant holds when mediaSize is custom AND device supports A3", () => {
    const context = {
      mediaSize: "custom",
      device: { capabilities: ["iso_a3_297x420mm", "na_letter_8.5x11in"] },
    };
    expect(evaluator.evaluate(expression, context)).toBe(true);
  });

  it("invariant FAILS when mediaSize is custom AND device does NOT support A3", () => {
    const context = {
      mediaSize: "custom",
      device: { capabilities: ["na_letter_8.5x11in", "iso_a4_210x297mm"] },
    };
    expect(evaluator.evaluate(expression, context)).toBe(false);
  });

  it("invariant holds when no device context is provided (mediaSize not custom)", () => {
    const context = { mediaSize: "iso_a4_210x297mm" };
    expect(evaluator.evaluate(expression, context)).toBe(true);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────

describe("CsdInvariantEvaluator - edge cases", () => {
  it("returns true for empty expression (graceful fail-open)", () => {
    expect(evaluator.evaluate("", {})).toBe(true);
  });

  it("handles boolean literals", () => {
    expect(evaluator.evaluate("enabled == true", { enabled: true })).toBe(true);
    expect(evaluator.evaluate("enabled == true", { enabled: false })).toBe(false);
  });
});
