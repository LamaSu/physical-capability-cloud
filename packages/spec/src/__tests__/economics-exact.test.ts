/**
 * The one rounding rule: largest remainder, in exact integers (docs/ECONOMIC_AGREEMENTS.md §4.3/§4.5).
 */

import { describe, expect, it } from "vitest";
import { floorMulDiv, largestRemainder, sumBigints } from "../economics/exact.js";
import { prng, randBigint } from "./economics-helpers.js";

describe("largestRemainder", () => {
  it("conserves the total exactly and keeps every share within one base unit of exact (10k random cases)", () => {
    const rand = prng(20260924);
    for (let t = 0; t < 10_000; t++) {
      const n = 1 + Math.floor(rand() * 12);
      const weights = Array.from({ length: n }, () => BigInt(Math.floor(rand() * 20_000)));
      if (sumBigints(weights) === 0n) weights[0] = 1n;
      const total = randBigint(rand, t % 7 === 0 ? (1n << 128n) - 1n : 10_000_000n);
      const shares = largestRemainder(total, weights, weights.map((_, i) => i));
      expect(sumBigints(shares)).toBe(total);
      const W = sumBigints(weights);
      shares.forEach((s, i) => {
        const floor = (total * weights[i]!) / W;
        expect(s === floor || s === floor + 1n).toBe(true);
        if (weights[i] === 0n) expect(s).toBe(0n);
      });
    }
  });

  it("gives the leftover to the largest remainders, and a tie to the lower tie rank", () => {
    // 101 split 50/50: exact 50.5 each, one base unit left; tie → rank 0.
    expect(largestRemainder(101n, [5000n, 5000n], [0, 1])).toEqual([51n, 50n]);
    expect(largestRemainder(101n, [5000n, 5000n], [1, 0])).toEqual([50n, 51n]);
    // 10 over 1/1/1: 3.33 each, one left → rank order.
    expect(largestRemainder(10n, [1n, 1n, 1n], [2, 0, 1])).toEqual([3n, 4n, 3n]);
    // Remainder beats rank: 7 over 2/5 (W=7): exact 2 and 5, nothing left.
    expect(largestRemainder(7n, [2n, 5n], [0, 1])).toEqual([2n, 5n]);
    // 11 over 3/5/2 (W=10): 3.3, 5.5, 2.2 → floors 3,5,2 → one left → largest remainder is 5.5.
    expect(largestRemainder(11n, [3n, 5n, 2n], [0, 1, 2])).toEqual([3n, 6n, 2n]);
  });

  it("refuses nonsense inputs instead of guessing", () => {
    expect(() => largestRemainder(-1n, [1n], [0])).toThrow();
    expect(() => largestRemainder(1n, [0n, 0n], [0, 1])).toThrow();
    expect(() => largestRemainder(1n, [1n, -1n], [0, 1])).toThrow();
    expect(() => largestRemainder(1n, [1n, 1n], [0, 0])).toThrow();
    expect(() => largestRemainder(1n, [1n], [0, 1])).toThrow();
  });

  it("never passes through floating point: values far above 2^53 stay exact", () => {
    const total = (1n << 128n) - 1n;
    const shares = largestRemainder(total, [1n, 2n], [0, 1]);
    expect(sumBigints(shares)).toBe(total);
    expect(shares).toEqual([113427455640312821154458202477256070485n, 226854911280625642308916404954512140970n]);
  });
});

describe("floorMulDiv", () => {
  it("is floor(x*n/d) and matches the escrow's fee rule", () => {
    expect(floorMulDiv(1000000003n, 235n, 10000n)).toBe(23500000n); // the escrow golden vector's f
    expect(floorMulDiv(7n, 0n, 10000n)).toBe(0n);
    expect(() => floorMulDiv(1n, 1n, 0n)).toThrow();
    expect(() => floorMulDiv(-1n, 1n, 1n)).toThrow();
  });
});
