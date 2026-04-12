import { describe, it, expect } from "vitest";
import { verifyExactMatch } from "../verifier-exact.js";
import { verifySchemaMatch, type SchemaValidator } from "../verifier-schema.js";
import { emitTouchstoneFeedback } from "../reputation-hook.js";
import type { TouchstoneResult } from "../types.js";

// ---------------------------------------------------------------------------
// Exact match verifier
// ---------------------------------------------------------------------------

describe("verifyExactMatch", () => {
  it("passes when values are identical primitives", () => {
    const result = verifyExactMatch("t-001", 42, 42);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.taskId).toBe("t-001");
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("fails when values differ", () => {
    const result = verifyExactMatch("t-002", 42, 43);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.0);
    expect(result.verificationDetails).toContain("Mismatch");
  });

  it("passes on identical objects regardless of key order", () => {
    const expected = { b: 2, a: 1 };
    const actual = { a: 1, b: 2 };
    const result = verifyExactMatch("t-003", expected, actual);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it("passes on identical nested objects", () => {
    const expected = {
      balances: { cash: 3500, ap: -3000 },
      balanced: true,
    };
    const actual = {
      balanced: true,
      balances: { ap: -3000, cash: 3500 },
    };
    const result = verifyExactMatch("t-004", expected, actual);
    expect(result.passed).toBe(true);
  });

  it("fails when nested values differ", () => {
    const expected = { total: 100, items: [1, 2, 3] };
    const actual = { total: 100, items: [1, 2, 4] };
    const result = verifyExactMatch("t-005", expected, actual);
    expect(result.passed).toBe(false);
  });

  it("passes on identical arrays", () => {
    const result = verifyExactMatch("t-006", [1, 2, 3], [1, 2, 3]);
    expect(result.passed).toBe(true);
  });

  it("handles null and undefined", () => {
    expect(verifyExactMatch("t-007a", null, null).passed).toBe(true);
    expect(verifyExactMatch("t-007b", undefined, undefined).passed).toBe(true);
    expect(verifyExactMatch("t-007c", null, undefined).passed).toBe(false);
  });

  it("handles string comparisons", () => {
    expect(verifyExactMatch("t-008a", "hello", "hello").passed).toBe(true);
    expect(verifyExactMatch("t-008b", "hello", "world").passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema validation verifier
// ---------------------------------------------------------------------------

describe("verifySchemaMatch", () => {
  const validExpenseSchema: SchemaValidator = (value) => {
    if (typeof value !== "object" || value === null) {
      return { success: false, errors: ["Expected an object"] };
    }
    const obj = value as Record<string, unknown>;
    const errors: string[] = [];

    if (typeof obj.category !== "string") {
      errors.push("category must be a string");
    }
    if (typeof obj.confidence !== "number" || (obj.confidence as number) < 0 || (obj.confidence as number) > 1) {
      errors.push("confidence must be a number between 0 and 1");
    }
    if (typeof obj.reasoning !== "string") {
      errors.push("reasoning must be a string");
    }

    return errors.length > 0 ? { success: false, errors } : { success: true };
  };

  it("passes when output matches the schema", () => {
    const actual = {
      category: "office_supplies",
      confidence: 0.95,
      reasoning: "Items are office supplies",
    };
    const result = verifySchemaMatch("t-s01", validExpenseSchema, actual);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.verificationDetails).toContain("passed");
  });

  it("fails when output is missing required fields", () => {
    const actual = { category: "office_supplies" };
    const result = verifySchemaMatch("t-s02", validExpenseSchema, actual);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.0);
    expect(result.verificationDetails).toContain("confidence");
  });

  it("fails when output has wrong types", () => {
    const actual = {
      category: 123,
      confidence: "high",
      reasoning: "wrong types",
    };
    const result = verifySchemaMatch("t-s03", validExpenseSchema, actual);
    expect(result.passed).toBe(false);
    expect(result.verificationDetails).toContain("category");
  });

  it("fails when output is null", () => {
    const result = verifySchemaMatch("t-s04", validExpenseSchema, null);
    expect(result.passed).toBe(false);
    expect(result.verificationDetails).toContain("object");
  });
});

// ---------------------------------------------------------------------------
// Reputation hook
// ---------------------------------------------------------------------------

describe("emitTouchstoneFeedback", () => {
  it("emits positive feedback on pass", () => {
    const result: TouchstoneResult = {
      taskId: "t-r01",
      passed: true,
      score: 1.0,
      verificationDetails: "Exact match",
      executionTimeMs: 5,
    };

    const feedback = emitTouchstoneFeedback(result, 42n);

    expect(feedback.agentId).toBe(42n);
    expect(feedback.value).toBe(100n);
    expect(feedback.valueDecimals).toBe(0);
    expect(feedback.tag1).toBe("touchstone");
    expect(feedback.tag2).toBe("pass");
  });

  it("emits negative feedback on fail", () => {
    const result: TouchstoneResult = {
      taskId: "t-r02",
      passed: false,
      score: 0.0,
      verificationDetails: "Mismatch",
      executionTimeMs: 3,
    };

    const feedback = emitTouchstoneFeedback(result, 99n);

    expect(feedback.agentId).toBe(99n);
    expect(feedback.value).toBe(-1000n);
    expect(feedback.valueDecimals).toBe(0);
    expect(feedback.tag1).toBe("touchstone");
    expect(feedback.tag2).toBe("fail");
  });

  it("fail penalty is 10x the pass reward", () => {
    const passResult: TouchstoneResult = {
      taskId: "t-r03p",
      passed: true,
      score: 1.0,
      verificationDetails: "",
      executionTimeMs: 0,
    };
    const failResult: TouchstoneResult = {
      taskId: "t-r03f",
      passed: false,
      score: 0.0,
      verificationDetails: "",
      executionTimeMs: 0,
    };

    const passFeedback = emitTouchstoneFeedback(passResult, 1n);
    const failFeedback = emitTouchstoneFeedback(failResult, 1n);

    // |fail| / |pass| = 10
    const ratio = Number(-failFeedback.value) / Number(passFeedback.value);
    expect(ratio).toBe(10);
  });
});
