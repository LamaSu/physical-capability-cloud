/**
 * VerifierSelector — deterministic, stake-weighted verifier selection.
 *
 * Selects N verifiers from the active pool for a human verification request.
 * Selection is reproducible given the same seed (block hash or request hash),
 * weighted by each node's stake * (reputation / 10000).
 */

import { createHash } from "node:crypto";
import type { VerifierNodeInfo, HumanVerificationRequest } from "./types.js";

export class VerifierSelector {
  /**
   * Select N verifiers for a verification request.
   *
   * Algorithm:
   *   1. Filter out excluded addresses and inactive nodes.
   *   2. Compute weight = stake * (reputation / 10000) for each node.
   *   3. Use sha256(seed + index) as a seeded PRNG to pick nodes via
   *      weighted random selection without replacement.
   *   4. Return exactly `count` nodes (or all available if fewer).
   *
   * @param request           The human verification request (used for context, not selection math).
   * @param availableNodes    The full pool of verifier nodes.
   * @param count             How many verifiers to select.
   * @param seed              Deterministic seed — block hash or request hash.
   * @param excludeAddresses  Addresses to exclude (conflict of interest).
   */
  selectVerifiers(
    request: HumanVerificationRequest,
    availableNodes: VerifierNodeInfo[],
    count: number,
    seed: string,
    excludeAddresses?: string[],
  ): VerifierNodeInfo[] {
    const excludeSet = new Set((excludeAddresses ?? []).map((a) => a.toLowerCase()));

    // Step 1: Filter to eligible nodes
    const eligible = availableNodes.filter(
      (node) =>
        node.status === "online" &&
        !excludeSet.has(node.id.toLowerCase()),
    );

    if (eligible.length === 0) return [];
    if (eligible.length <= count) {
      // Not enough nodes — return all eligible in a deterministic order
      return this._deterministicSort(eligible, seed);
    }

    // Step 2: Compute weights (stake * reputation/10000)
    // reputation is 0-100 in VerifierNodeInfo (legacy) but 0-10000 in registry.
    // We normalise by dividing by max possible reputation to keep things sane.
    const weights = eligible.map((node) => {
      const reputationFraction = node.reputation / 10000;
      return Math.max(0, node.stake * reputationFraction);
    });

    // Step 3 & 4: Weighted random selection without replacement
    const selected: VerifierNodeInfo[] = [];
    const pool = eligible.slice(); // shallow copy so we can splice
    const poolWeights = weights.slice();
    let prngIndex = 0;

    while (selected.length < count && pool.length > 0) {
      const totalWeight = poolWeights.reduce((sum, w) => sum + w, 0);

      // Generate a deterministic float in [0, 1) from sha256(seed + prngIndex)
      const randFloat = this._seededRandom(seed, prngIndex++);

      // Walk the cumulative weight distribution to pick a node
      let cumulative = 0;
      const target = randFloat * totalWeight;
      let pickedIndex = pool.length - 1; // fallback to last

      for (let i = 0; i < pool.length; i++) {
        cumulative += poolWeights[i];
        if (target <= cumulative) {
          pickedIndex = i;
          break;
        }
      }

      selected.push(pool[pickedIndex]);
      pool.splice(pickedIndex, 1);
      poolWeights.splice(pickedIndex, 1);
    }

    return selected;
  }

  /**
   * Generate a deterministic float in [0, 1) from sha256(seed + index).
   * Uses the first 8 bytes of the hash as a 64-bit unsigned integer.
   */
  private _seededRandom(seed: string, index: number): number {
    const hash = createHash("sha256").update(`${seed}:${index}`).digest();
    // Read first 6 bytes as a big-endian integer to avoid precision issues
    // with 64-bit floats (2^48 < 2^53)
    const high = hash.readUInt32BE(0);
    const low = hash.readUInt16BE(4);
    const value = high * 0x10000 + low; // up to 2^48 - 1
    return value / 0x1000000000000; // divide by 2^48
  }

  /**
   * Sort nodes deterministically using their id hashed against the seed.
   * Used when the pool is smaller than the requested count.
   */
  private _deterministicSort(nodes: VerifierNodeInfo[], seed: string): VerifierNodeInfo[] {
    return nodes.slice().sort((a, b) => {
      const hashA = createHash("sha256").update(`${seed}:${a.id}`).digest("hex");
      const hashB = createHash("sha256").update(`${seed}:${b.id}`).digest("hex");
      return hashA.localeCompare(hashB);
    });
  }
}
