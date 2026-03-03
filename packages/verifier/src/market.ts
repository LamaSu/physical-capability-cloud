/**
 * Verifier Market — selects verifiers for evidence bundles.
 *
 * Tier 0/1: Open market. Any staked verifier can participate.
 *           Selection weighted by stake * reputation.
 * Tier 2/3: Curated guild. Only domain-expert verifiers in allowlist.
 *           Higher quorum requirements.
 */

import type {
  Verifier,
  VerificationRequest,
  AssuranceTier,
  VerifierSelectionCriteria,
} from "@pcc/spec";
import { DEFAULT_VERIFIER_CRITERIA, ids } from "@pcc/spec";

export class VerifierMarket {
  private verifiers: Map<string, Verifier> = new Map();
  private criteria: Record<number, VerifierSelectionCriteria> = DEFAULT_VERIFIER_CRITERIA;

  registerVerifier(verifier: Verifier): void {
    this.verifiers.set(verifier.id, verifier);
  }

  removeVerifier(id: string): void {
    this.verifiers.delete(id);
  }

  /**
   * Select verifiers for an evidence bundle at a given tier.
   * Returns the selected verifier IDs.
   */
  selectVerifiers(tier: AssuranceTier): string[] {
    const tierCriteria = this.criteria[tier];
    if (!tierCriteria) throw new Error(`No criteria for tier ${tier}`);

    // Filter eligible verifiers
    const eligible = [...this.verifiers.values()].filter((v) => {
      if (v.status !== "active") return false;
      if (v.maxTier < tier) return false;
      if (v.reputation < tierCriteria.minReputation) return false;
      if (parseFloat(v.stakedAmount) < parseFloat(tierCriteria.minStake)) return false;
      if (tierCriteria.requireGuild && !v.guildMember) return false;
      if (tierCriteria.guildId && v.guildId !== tierCriteria.guildId) return false;
      return true;
    });

    if (eligible.length < tierCriteria.quorum) {
      throw new Error(
        `Not enough eligible verifiers for tier ${tier}: need ${tierCriteria.quorum}, have ${eligible.length}`,
      );
    }

    // Weighted random selection by stake * reputation
    const weighted = eligible.map((v) => ({
      verifier: v,
      weight: parseFloat(v.stakedAmount) * (v.reputation / 1000),
    }));

    const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
    const selected: string[] = [];
    const used = new Set<string>();

    while (selected.length < tierCriteria.quorum) {
      let random = Math.random() * totalWeight;
      for (const w of weighted) {
        if (used.has(w.verifier.id)) continue;
        random -= w.weight;
        if (random <= 0) {
          selected.push(w.verifier.id);
          used.add(w.verifier.id);
          break;
        }
      }
    }

    return selected;
  }

  /**
   * Create a verification request.
   */
  createRequest(
    jobId: string,
    stepId: string,
    evidenceBundleHash: string,
    tier: AssuranceTier,
    fee: string,
  ): VerificationRequest {
    const assignedVerifiers = this.selectVerifiers(tier);

    return {
      id: ids.verification(),
      jobId,
      stepId,
      evidenceBundleHash: evidenceBundleHash as any,
      assuranceTier: tier,
      fee,
      deadline: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours
      status: "assigned",
      assignedVerifiers,
      createdAt: new Date().toISOString(),
    };
  }

  getVerifier(id: string): Verifier | undefined {
    return this.verifiers.get(id);
  }

  getVerifierCount(): number {
    return this.verifiers.size;
  }
}
