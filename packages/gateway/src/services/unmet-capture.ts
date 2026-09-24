/**
 * Server-side unmet-demand capture (ledger R44, D2; steward ruling #2634).
 *
 * Adds two server-owned facts to first-party intent capture, behind
 * PCC_UNMET_CAPTURE_ENABLED (default OFF):
 *   1. the authenticated principal, recorded as actorType
 *      "authenticated_operator". It is taken ONLY from the server-side auth
 *      context: apiGate's `req.operatorId` on /api routes, or the API key the
 *      A2A route resolved itself. Never from a request body.
 *   2. which requested capability types no live supply could serve:
 *      `fulfillmentPath` plus `unmet`, with known types recorded as CSD URIs.
 *
 * The consumer is `UnmetDemandLens` in @pcc/demand-intel. Invariants:
 *   - flag OFF: the emitted events are byte-identical to the previous behaviour;
 *   - it never throws into an order path: a supply-read failure records nothing;
 *   - `price_exceeds_budget` and `region_unavailable` are not computed yet
 *     (there is no reliable price or service-area supply data to compare).
 */

import type { FastifyRequest } from "fastify";
import type { AnalyticsEvent, DemandEnvelope, UnmetCapability } from "@pcc/spec";
import type { CapabilityDTO } from "../facades/types.js";
import { getCapabilityFacade } from "../facades/index.js";
import { getCsdRegistry } from "../routes/csd.js";

/** actorType for a principal the server authenticated (read by UnmetDemandLens). */
export const VERIFIED_ACTOR_TYPE = "authenticated_operator" satisfies AnalyticsEvent["actorType"];

export function isUnmetCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PCC_UNMET_CAPTURE_ENABLED === "true";
}

/**
 * The authenticated principal behind an API key record the server resolved.
 * This module is the only place intent capture reads identity. Both entry
 * points below use this one rule.
 * TODO(R28/N2): switch both to gateway's WP-A identity binding when it lands;
 * do not add a second extractor elsewhere.
 */
export function principalFromApiKey(apiKey: { operatorId?: unknown } | null | undefined): string | null {
  const id = apiKey?.operatorId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * The principal from apiGate's server-side context on /api routes
 * (`middleware/api-gate.ts` sets `req.operatorId` from the API key).
 */
export function authenticatedPrincipal(req: FastifyRequest): string | null {
  return principalFromApiKey(req as unknown as { operatorId?: unknown });
}

export interface IntentActor {
  actorId: string;
  actorType: AnalyticsEvent["actorType"];
}

/**
 * The actor to record on an intent event: the authenticated principal when
 * capture is enabled and one exists, otherwise the route's legacy actor.
 */
export function intentActor(
  principal: string | null,
  legacy: IntentActor,
  env: NodeJS.ProcessEnv = process.env,
): IntentActor {
  if (isUnmetCaptureEnabled(env) && principal !== null) {
    return { actorId: principal, actorType: VERIFIED_ACTOR_TYPE };
  }
  return legacy;
}

/** The supply fields the matcher reads. */
export type SupplyCapability = Pick<CapabilityDTO, "available" | "kernelStatus" | "assuranceTiers">;

/** Injected supply reads, so the matcher stays pure and testable. */
export interface SupplyReads {
  findUrlByType(type: string): string | undefined;
  listByType(type: string): Promise<SupplyCapability[]>;
}

/** Production reads: the CSD registry plus CapabilityFacade.listByType (TTL-filtered). */
export function defaultSupplyReads(): SupplyReads {
  return {
    findUrlByType: (type) => getCsdRegistry().findUrlByType(type),
    listByType: async (type) => {
      const res = await getCapabilityFacade().listByType(type);
      if (!res.success) throw new Error(`listByType(${type}) failed`);
      return res.data;
    },
  };
}

/** Kebab-case slug for a type with no CSD, so the lens can key it as proposed:<slug>. */
function slugify(type: string): string {
  return type
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Which requested types no live supply can serve. Returns `[]` when every type
 * is served, and `null` when supply could not be read (so nothing is recorded).
 * Never throws.
 */
export async function computeUnmet(
  types: readonly string[],
  opts: { reads: SupplyReads; assuranceTier?: number },
): Promise<UnmetCapability[] | null> {
  try {
    const out: UnmetCapability[] = [];
    const seen = new Set<string>();
    for (const raw of types) {
      const type = raw.trim();
      const dedupeKey = type.toLowerCase();
      if (type === "" || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Live supply decides served vs unmet. The CSD registry only decides how
      // an unmet type is keyed (its URI when a CSD exists, else its slug) and
      // whether "nothing at all" means no_capability_type or no_kernel_offering.
      // A type with live instances is served even if no CSD is registered.
      const caps = await opts.reads.listByType(type);
      const url = opts.reads.findUrlByType(type);
      const key = url ?? slugify(type);
      if (key === "") continue;
      if (caps.length === 0) {
        out.push({ capabilityType: key, reason: url ? "no_kernel_offering" : "no_capability_type", supplyCount: 0 });
        continue;
      }
      const live = caps.filter((c) => c.available && (c.kernelStatus === undefined || c.kernelStatus === "online"));
      if (live.length === 0) {
        out.push({ capabilityType: key, reason: "no_capacity", supplyCount: caps.length });
        continue;
      }
      const tier = opts.assuranceTier;
      if (tier !== undefined && !live.some((c) => (c.assuranceTiers as number[]).includes(tier))) {
        out.push({ capabilityType: key, reason: "tier_too_high", supplyCount: live.length });
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Stamp the capture-time supply verdict on an envelope: "unfulfilled" with the
 * unmet list, "auto" when every type is served, unchanged when unknown.
 */
export function withUnmet(envelope: DemandEnvelope, unmet: UnmetCapability[] | null): DemandEnvelope {
  if (unmet === null) return envelope;
  if (unmet.length === 0) return { ...envelope, fulfillmentPath: "auto" };
  return { ...envelope, fulfillmentPath: "unfulfilled", unmet };
}
