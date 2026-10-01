/**
 * Capability Populator — transforms raw Capability models into CapabilityDTOs.
 *
 * Handles enrichment: reputation, queue depth, availability, kernel status.
 * Accepts PopulationContext to batch-load shared data and avoid N+1.
 *
 * Assurance ceiling (WP-C): a capability row's `assuranceTiers` is the
 * operator's CLAIM. The DTO serves the claim clamped to the OWNING kernel's
 * SERVED ceiling, effectiveMaxAssuranceTier = min(the kernel's claimed tier, its
 * authorized ceiling) (services/assurance-ceiling.ts), legacy rows included.
 * That is the bound contracting holds a job to, so discovery never offers a
 * tier a job cannot be contracted at (astra pack 90 F1). A capability whose
 * kernel is unknown has a ceiling of 0.
 */

import type { AssuranceTier, Capability, ShopKernel } from "@pcc/spec";
import type { CapabilityDTO, PopulationContext } from "../types.js";
import { isKernelStale } from "./staleness.js";
import {
  clampAssuranceTiers,
  effectiveMaxAssuranceTier,
  type AssuranceClaimKernel,
} from "../../services/assurance-ceiling.js";

/**
 * The tiers a capability may be SERVED at: its claimed tiers clamped to the
 * owning kernel's served ceiling, effectiveMaxAssuranceTier(kernel) (a missing
 * kernel is 0). Exported so selection paths that work on raw rows apply the
 * exact same clamp as the DTO.
 */
export function servedAssuranceTiers(
  claimedTiers: unknown,
  kernel: AssuranceClaimKernel | null | undefined,
): AssuranceTier[] {
  return clampAssuranceTiers(claimedTiers, effectiveMaxAssuranceTier(kernel));
}

/**
 * Populate a single Capability model into a CapabilityDTO.
 */
export function populateCapabilityDTO(
  model: Capability,
  kernel: ShopKernel | undefined,
  ctx: PopulationContext,
  /**
   * Pre-computed served ceiling of `kernel`, effectiveMaxAssuranceTier (batch
   * callers memoize it per kernel). When omitted it is computed from `kernel`.
   * It must be derived from the same kernel row; never pass a caller-chosen
   * value.
   */
  kernelCeiling?: AssuranceTier,
): CapabilityDTO {
  // The capability being populated is itself an active listing, so its kernel
  // qualifies for the keepalive grace: a listed kernel stays available past the
  // bare 5-minute heartbeat threshold without an operator daemon. The grace is
  // finite, so a long-dead listed kernel still goes stale (→ unavailable).
  const isStale = isKernelStale(kernel?.status, kernel?.lastHeartbeat, /* hasActiveListing */ true);
  const kernelStatus = isStale ? "stale" as const : (kernel?.status as any);
  const available = kernelStatus === "online" && model.queueDepth < 10;

  const reputation = ctx.includeReputation
    ? ctx.reputationCache?.get(model.kernelId) ?? kernel?.reputation
    : undefined;

  return {
    id: model.id,
    kernelId: model.kernelId,
    type: model.type,
    name: model.name,
    description: model.description,
    materials: model.materials,
    tolerances: model.tolerances,
    envelope: model.envelope,
    // Claim clamped to the owning kernel's served ceiling (WP-C; pack 90 F1).
    assuranceTiers: clampAssuranceTiers(
      model.assuranceTiers,
      kernelCeiling ??
        effectiveMaxAssuranceTier(kernel as unknown as AssuranceClaimKernel | undefined),
    ),
    pricing: model.pricing,
    location: model.location,
    tags: model.tags,
    // Enrichment
    reputation,
    queueDepth: model.queueDepth,
    available,
    estimatedWaitMinutes: model.queueDepth * 15, // rough estimate
    kernelName: kernel?.name,
    kernelStatus,
  };
}

/**
 * Batch-populate capabilities with pre-loaded kernel data.
 * Prevents N+1 by accepting a kernel map.
 */
export function populateCapabilityList(
  models: Capability[],
  kernelMap: Map<string, ShopKernel>,
  ctx: PopulationContext,
): CapabilityDTO[] {
  // One ceiling evaluation per kernel, not per capability.
  const ceilings = new Map<string, AssuranceTier>();
  return models.map((model) => {
    const kernel = kernelMap.get(model.kernelId);
    let ceiling = ceilings.get(model.kernelId);
    if (ceiling === undefined) {
      ceiling = effectiveMaxAssuranceTier(kernel as unknown as AssuranceClaimKernel | undefined);
      ceilings.set(model.kernelId, ceiling);
    }
    return populateCapabilityDTO(model, kernel, ctx, ceiling);
  });
}
