import { describe, it, expect } from "vitest";
import {
  computeBackoffMs,
  isNonRetryable,
  shouldRetry,
  applyRetryPolicyDefaults,
  DEFAULT_RETRY_POLICY,
} from "../../src/activity/retry.js";

describe("computeBackoffMs", () => {
  const zeroJitterPolicy = {
    initialIntervalMs: 1000,
    backoffCoefficient: 2,
    maxIntervalMs: 100_000,
    maximumAttempts: 5,
    nonRetryableErrorPatterns: [] as readonly string[],
    jitterFactor: 0,
  };

  it("attempt=1 returns 0 (first try has no wait)", () => {
    expect(computeBackoffMs(zeroJitterPolicy, 1)).toBe(0);
  });

  it("attempt=2 returns initialIntervalMs when jitter=0", () => {
    expect(computeBackoffMs(zeroJitterPolicy, 2)).toBe(1000);
  });

  it("attempt=3 doubles attempt=2 (backoffCoefficient=2)", () => {
    expect(computeBackoffMs(zeroJitterPolicy, 3)).toBe(2000);
  });

  it("attempt=4 quadruples attempt=2", () => {
    expect(computeBackoffMs(zeroJitterPolicy, 4)).toBe(4000);
  });

  it("clamps at maxIntervalMs", () => {
    const clamped = {
      ...zeroJitterPolicy,
      initialIntervalMs: 1000,
      backoffCoefficient: 10,
      maxIntervalMs: 5000,
    };
    // Attempt 5: raw = 1000 * 10^3 = 1,000,000 → clamped to 5000.
    expect(computeBackoffMs(clamped, 5)).toBe(5000);
  });

  it("applies jitter within ±(clamped * jitterFactor)", () => {
    const policy = {
      ...zeroJitterPolicy,
      jitterFactor: 0.2,
    };
    // At attempt=2, clamped = 1000, jitter range = 200.
    //   rand() = 0   → jitter = -200 → 800 (rounded)
    //   rand() = 1   → jitter = +200 → 1200
    //   rand() = 0.5 → jitter = 0    → 1000
    expect(computeBackoffMs(policy, 2, () => 0)).toBe(800);
    expect(computeBackoffMs(policy, 2, () => 1)).toBe(1200);
    expect(computeBackoffMs(policy, 2, () => 0.5)).toBe(1000);
  });

  it("never returns a negative value", () => {
    // Adversarial: very large negative jitter still floors to 0.
    const policy = {
      ...zeroJitterPolicy,
      initialIntervalMs: 10,
      jitterFactor: 10, // absurd: ±100ms on a 10ms base
    };
    const neg = computeBackoffMs(policy, 2, () => 0);
    expect(neg).toBeGreaterThanOrEqual(0);
  });
});

describe("isNonRetryable", () => {
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    nonRetryableErrorPatterns: ["InvalidInputError", "EscrowAlreadyFundedError"],
  };

  it("returns true when error.name matches a pattern", () => {
    const e = new Error("whatever");
    e.name = "InvalidInputError";
    expect(isNonRetryable(policy, e)).toBe(true);
  });

  it("returns true when error.message matches a pattern", () => {
    const e = new Error("EscrowAlreadyFundedError at 0xabc");
    expect(isNonRetryable(policy, e)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isNonRetryable(policy, new Error("NetworkTimeoutError"))).toBe(false);
  });

  it("returns false when passed a non-Error", () => {
    expect(isNonRetryable(policy, "a string")).toBe(false);
    expect(isNonRetryable(policy, null)).toBe(false);
    expect(isNonRetryable(policy, undefined)).toBe(false);
  });

  it("regex semantics — patterns are interpreted as RegExp", () => {
    // The implementation builds the haystack as `${error.name}: ${error.message}`,
    // so patterns must account for the "Error: " prefix when unanchored names are used.
    // Test a pattern that matches inside the message portion.
    const p = {
      ...DEFAULT_RETRY_POLICY,
      nonRetryableErrorPatterns: ["HTTP4\\d{2}"], // class without leading anchor
    };
    expect(isNonRetryable(p, new Error("HTTP404 not found"))).toBe(true);
    expect(isNonRetryable(p, new Error("HTTP500 boom"))).toBe(false);
  });
});

describe("shouldRetry", () => {
  it("false when maximum attempts already reached", () => {
    const p = { ...DEFAULT_RETRY_POLICY, maximumAttempts: 3 };
    expect(shouldRetry(p, 3, new Error("x"))).toBe(false);
    expect(shouldRetry(p, 4, new Error("x"))).toBe(false);
  });

  it("true while attempts remain", () => {
    const p = { ...DEFAULT_RETRY_POLICY, maximumAttempts: 5 };
    expect(shouldRetry(p, 1, new Error("x"))).toBe(true);
    expect(shouldRetry(p, 4, new Error("x"))).toBe(true);
  });

  it("maximumAttempts=0 means infinite retries", () => {
    const p = { ...DEFAULT_RETRY_POLICY, maximumAttempts: 0 };
    expect(shouldRetry(p, 999, new Error("x"))).toBe(true);
  });

  it("non-retryable patterns override attempt budget", () => {
    const p = {
      ...DEFAULT_RETRY_POLICY,
      maximumAttempts: 10,
      nonRetryableErrorPatterns: ["BadInput"],
    };
    const e = new Error("BadInput here");
    expect(shouldRetry(p, 1, e)).toBe(false);
  });
});

describe("applyRetryPolicyDefaults", () => {
  it("applies all defaults when given undefined", () => {
    const p = applyRetryPolicyDefaults(undefined);
    expect(p).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("merges user overrides on top of defaults", () => {
    const p = applyRetryPolicyDefaults({ maximumAttempts: 7, jitterFactor: 0.5 });
    expect(p.maximumAttempts).toBe(7);
    expect(p.jitterFactor).toBe(0.5);
    expect(p.backoffCoefficient).toBe(DEFAULT_RETRY_POLICY.backoffCoefficient);
  });

  it("derives maxIntervalMs = 100 × initialIntervalMs when only initialIntervalMs is set", () => {
    const p = applyRetryPolicyDefaults({ initialIntervalMs: 500 });
    expect(p.maxIntervalMs).toBe(50_000);
  });

  it("respects explicit maxIntervalMs over the 100× rule", () => {
    const p = applyRetryPolicyDefaults({ initialIntervalMs: 500, maxIntervalMs: 10_000 });
    expect(p.maxIntervalMs).toBe(10_000);
  });
});
