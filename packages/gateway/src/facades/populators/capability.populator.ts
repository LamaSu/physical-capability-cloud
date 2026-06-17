/**
 * Capability Populator — transforms raw Capability models into CapabilityDTOs.
 *
 * Handles enrichment: reputation, queue depth, availability, kernel status.
 * Accepts PopulationContext to batch-load shared data and avoid N+1.
 */

import type { Capability, ShopKernel } from "@pcc/spec";
import type { CapabilityDTO, PopulationContext } from "../types.js";
import { isKernelStale } from "./staleness.js";

/**
 * Populate a single Capability model into a CapabilityDTO.
 */
export function populateCapabilityDTO(
  model: Capability,
  kernel: ShopKernel | undefined,
  ctx: PopulationContext,
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
    assuranceTiers: model.assuranceTiers,
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
  return models.map((model) =>
    populateCapabilityDTO(model, kernelMap.get(model.kernelId), ctx),
  );
}
