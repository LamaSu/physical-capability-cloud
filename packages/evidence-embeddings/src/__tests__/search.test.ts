import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "../search.js";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical unit vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("returns -1.0 for opposite unit vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("returns 0.0 for orthogonal unit vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("handles non-unit vectors correctly", () => {
    const a = new Float32Array([3, 4]);
    const b = new Float32Array([4, 3]);
    // cos(angle) = (3*4 + 4*3) / (5 * 5) = 24/25 = 0.96
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.96, 5);
  });

  it("returns 0 for zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("throws on mismatched dimensions", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(() => cosineSimilarity(a, b)).toThrow("Vector length mismatch");
  });

  it("throws on empty vectors", () => {
    const a = new Float32Array([]);
    const b = new Float32Array([]);
    expect(() => cosineSimilarity(a, b)).toThrow("empty vectors");
  });

  it("works with high-dimensional vectors", () => {
    const dim = 512;
    const a = new Float32Array(dim).fill(1);
    const b = new Float32Array(dim).fill(1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});
