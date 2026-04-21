/**
 * Tests for AlertRingBuffer.
 *
 * Author: implementer-alpha
 */

import { describe, it, expect } from "vitest";
import { AlertRingBuffer } from "../ring-buffer.js";
import type { Alert } from "../types.js";

function mk(n: number): Alert {
  return {
    ts: new Date(n * 1000).toISOString(),
    source: "manual",
    severity: "info",
    title: `alert-${n}`,
    body: "",
  };
}

describe("AlertRingBuffer", () => {
  it("rejects invalid capacity", () => {
    expect(() => new AlertRingBuffer(0)).toThrow();
    expect(() => new AlertRingBuffer(-1)).toThrow();
    expect(() => new AlertRingBuffer(1.5)).toThrow();
  });

  it("returns items newest-first", () => {
    const b = new AlertRingBuffer(5);
    b.push(mk(1));
    b.push(mk(2));
    b.push(mk(3));
    const recent = b.recent(10);
    expect(recent.map((a) => a.title)).toEqual(["alert-3", "alert-2", "alert-1"]);
  });

  it("wraps when capacity exceeded", () => {
    const b = new AlertRingBuffer(3);
    b.push(mk(1));
    b.push(mk(2));
    b.push(mk(3));
    b.push(mk(4));
    b.push(mk(5));
    expect(b.size()).toBe(3);
    expect(b.recent(10).map((a) => a.title)).toEqual(["alert-5", "alert-4", "alert-3"]);
  });

  it("respects limit smaller than size", () => {
    const b = new AlertRingBuffer(5);
    for (let i = 1; i <= 5; i++) b.push(mk(i));
    expect(b.recent(2).map((a) => a.title)).toEqual(["alert-5", "alert-4"]);
  });
});
