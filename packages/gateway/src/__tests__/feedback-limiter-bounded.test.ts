/**
 * WP-A round 6 (wpa-326-admingates-astra: "bound limiter state ... routes/feedback.ts:37"):
 * the anonymous feedback route's per-IP limiter keeps a bounded number of IPs. It used to
 * keep every IP it ever saw, so a spray of source addresses grew it without limit.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_TRACKED_IPS,
  __feedbackRateLimitSize,
  __feedbackRateLimited,
  __resetFeedbackRateLimit,
} from "../routes/feedback.js";

beforeEach(() => __resetFeedbackRateLimit());

describe("feedback rate-limit state is bounded", () => {
  it("[neg] one more distinct IP than the bound never grows the map past it", () => {
    for (let i = 0; i <= MAX_TRACKED_IPS; i++) __feedbackRateLimited(`198.18.${(i >> 8) & 255}.${i & 255}#${i}`);
    expect(__feedbackRateLimitSize()).toBe(MAX_TRACKED_IPS);
  });

  it("control: the limit still bites for one IP", () => {
    const results = Array.from({ length: 61 }, () => __feedbackRateLimited("203.0.113.9"));
    expect(results.slice(0, 60).every((limited) => !limited)).toBe(true);
    expect(results[60]).toBe(true);
  });
});
