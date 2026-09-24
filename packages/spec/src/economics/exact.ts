/**
 * Exact integer money primitives for the economics compiler (docs/ECONOMIC_AGREEMENTS.md §4.3, §4.5).
 *
 * Everything here is `bigint`. Nothing converts through `number`, so no amount above 2^53 can be
 * silently rounded, and there is exactly one rounding rule in the whole compiler: largest remainder.
 */

export const BPS_DENOMINATOR = 10_000n;

/** floor(x * num / den) for non-negative operands. `bigint` division truncates, which is floor here. */
export function floorMulDiv(x: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError("floorMulDiv: denominator must be positive");
  if (x < 0n || num < 0n) throw new RangeError("floorMulDiv: operands must be non-negative");
  return (x * num) / den;
}

/**
 * Largest-remainder apportionment of `total` over `weights`.
 *
 * Every claimant i first gets floor(total * w_i / W), where W = Σ weights. The leftover
 * L = total − Σ floors (always less than the number of claimants with a nonzero remainder) is then
 * handed out one base unit at a time to the claimants with the largest (total * w_i) mod W. Ties go
 * to the lower `tieRank`. The result always sums to exactly `total`.
 *
 * @param total    the amount to divide, >= 0
 * @param weights  non-negative weights; their sum must be > 0
 * @param tieRank  one rank per claimant; lower wins a tie. Ranks must be distinct.
 */
export function largestRemainder(
  total: bigint,
  weights: readonly bigint[],
  tieRank: readonly number[],
): bigint[] {
  if (total < 0n) throw new RangeError("largestRemainder: total must be non-negative");
  if (weights.length !== tieRank.length) {
    throw new RangeError("largestRemainder: weights and tieRank must have the same length");
  }
  if (new Set(tieRank).size !== tieRank.length) {
    throw new RangeError("largestRemainder: tie ranks must be distinct");
  }
  let sumWeights = 0n;
  for (const w of weights) {
    if (w < 0n) throw new RangeError("largestRemainder: weights must be non-negative");
    sumWeights += w;
  }
  if (sumWeights <= 0n) throw new RangeError("largestRemainder: weights must sum to more than zero");

  const shares = weights.map((w) => (total * w) / sumWeights);
  const remainders = weights.map((w) => (total * w) % sumWeights);
  let leftover = total;
  for (const s of shares) leftover -= s;

  const order = weights.map((_, i) => i);
  order.sort((a, b) => {
    const ra = remainders[a]!;
    const rb = remainders[b]!;
    if (ra !== rb) return ra > rb ? -1 : 1;
    return tieRank[a]! - tieRank[b]!;
  });
  for (let k = 0; leftover > 0n; k++) {
    const i = order[k]!;
    shares[i] = shares[i]! + 1n;
    leftover -= 1n;
  }

  let check = 0n;
  for (const s of shares) check += s;
  if (check !== total) {
    // Unreachable by construction; an assertion, not a code path.
    throw new Error("largestRemainder: conservation violated");
  }
  return shares;
}

export function sumBigints(values: Iterable<bigint>): bigint {
  let s = 0n;
  for (const v of values) s += v;
  return s;
}

export function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
