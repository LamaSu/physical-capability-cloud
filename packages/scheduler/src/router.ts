/**
 * Capability Router — matches CWM steps to available shop kernels.
 *
 * Routing factors:
 * - Capability type match
 * - Material availability
 * - Assurance tier support
 * - Geographic proximity (for courier efficiency)
 * - Queue depth (prefer less busy kernels)
 * - Reputation score
 * - Price
 */

import type { CWMStep, Capability, AssuranceTier } from "@pcc/spec";

/** Capabilities advertised by a kernel */
export interface KernelCapabilities {
  kernelId: string;
  capabilities: Capability[];
  reputation: number;
}

/** Result of a routing match */
export interface RouteMatch {
  kernelId: string;
  capability: Capability;
  quotedPrice: string;
  score: number; // higher is better
}

export class CapabilityRouter {
  private kernels: KernelCapabilities[] = [];

  /** Register a kernel's capabilities */
  registerKernel(kernel: KernelCapabilities): void {
    this.kernels.push(kernel);
  }

  /** Remove a kernel */
  removeKernel(kernelId: string): void {
    this.kernels = this.kernels.filter((k) => k.kernelId !== kernelId);
  }

  /** Find the best kernel+capability match for a step */
  async findBestMatch(step: CWMStep): Promise<RouteMatch | null> {
    const candidates: RouteMatch[] = [];

    for (const kernel of this.kernels) {
      for (const cap of kernel.capabilities) {
        // 1. Capability type must match
        if (cap.type !== step.capability) continue;

        // 2. Must support the required assurance tier
        if (!cap.assuranceTiers.includes(step.assuranceTier)) continue;

        // 3. Material must be available (if specified)
        const material = step.params.material as string | undefined;
        if (material && !cap.materials.includes(material)) continue;

        // 4. Calculate price
        const estimatedMinutes = step.estimatedDuration ?? 60;
        const baseCost = parseFloat(cap.pricing.baseCost);
        const perMin = parseFloat(cap.pricing.perMinute ?? "0");
        const price = Math.max(
          parseFloat(cap.pricing.minimum),
          baseCost + perMin * estimatedMinutes,
        );

        // 5. Check max price constraint
        if (step.maxPrice && price > parseFloat(step.maxPrice)) continue;

        // 6. Score: lower price + lower queue + higher reputation = better
        const priceScore = 1 / (1 + price);
        const queueScore = 1 / (1 + cap.queueDepth);
        const repScore = kernel.reputation / 1000;

        // Preferred kernel gets a bonus
        const preferBonus = step.preferredKernel === kernel.kernelId ? 0.5 : 0;

        const score = priceScore * 0.3 + queueScore * 0.3 + repScore * 0.3 + preferBonus + 0.1;

        candidates.push({
          kernelId: kernel.kernelId,
          capability: cap,
          quotedPrice: price.toFixed(2),
          score,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Return highest-scoring candidate
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  /** Find all matches for a step (for user to choose) */
  async findAllMatches(step: CWMStep): Promise<RouteMatch[]> {
    const matches: RouteMatch[] = [];
    // Reuse findBestMatch logic but return all
    for (const kernel of this.kernels) {
      for (const cap of kernel.capabilities) {
        if (cap.type !== step.capability) continue;
        if (!cap.assuranceTiers.includes(step.assuranceTier)) continue;
        const material = step.params.material as string | undefined;
        if (material && !cap.materials.includes(material)) continue;

        const estimatedMinutes = step.estimatedDuration ?? 60;
        const baseCost = parseFloat(cap.pricing.baseCost);
        const perMin = parseFloat(cap.pricing.perMinute ?? "0");
        const price = Math.max(parseFloat(cap.pricing.minimum), baseCost + perMin * estimatedMinutes);

        matches.push({
          kernelId: kernel.kernelId,
          capability: cap,
          quotedPrice: price.toFixed(2),
          score: 0,
        });
      }
    }
    return matches;
  }

  /** Get all registered kernels */
  getKernels(): KernelCapabilities[] {
    return [...this.kernels];
  }
}
